"""Staged disposable-PostgreSQL gates; never run during source-only verification.

Synthetic credits only. Worker execution is replaced by _finish; no strategy,
engine or subprocess runs. Candidate scoping keeps the session-shared database's
unrelated jobs/reservations out of these gates without changing locking clauses.
"""

import json
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Barrier, Event, local
from time import monotonic, sleep
from uuid import UUID

import pytest
from veyra_api import ledger, reservations
from veyra_api.settlement import settle_job
from veyra_scheduler import reaper
from veyra_scheduler import worker as worker_module
from veyra_scheduler.worker import LeaseLost


@pytest.fixture
def records(api, app):
    created = []

    def make(*, active=True):
        who = api.user()
        org = api.org(who)
        api.topup(who, org)
        project = api.project(who, org)
        quote = api.quote(who, project["latest_version"]["id"])
        authorized = api.authorize(who, quote)
        with app.state.db.tx() as conn:
            auth = conn.execute("SELECT * FROM authorizations WHERE id = %s",
                                (authorized["id"],)).fetchone()
        record = {"org": org, "auth": auth, "job": None}
        created.append(record)
        if active:
            record["job"] = api.job(who, authorized["id"])
        with app.state.db.tx() as conn:
            # Stable order independent of wall-clock timing and unrelated session fixtures.
            conn.execute("UPDATE authorizations SET created_at = timestamptz '2000-01-01' "
                         "+ make_interval(secs => %s) WHERE id = %s", (len(created), auth["id"]))
            if active:
                conn.execute("UPDATE jobs SET created_at = timestamptz '2000-01-01' "
                             "+ make_interval(secs => %s) WHERE id = %s",
                             (len(created), record["job"]["id"]))
        return record

    try:
        yield make
    finally:
        # Repair only deliberate fixture corruption, then close each fixture reservation.
        for record in created:
            auth, job = record["auth"], record["job"]
            with app.state.db.tx() as conn:
                conn.execute("UPDATE authorizations SET reserved_nano = %s, input_hash = %s "
                             "WHERE id = %s",
                             (auth["reserved_nano"], auth["input_hash"], auth["id"]))
                if job:
                    conn.execute("UPDATE jobs SET config = %s WHERE id = %s",
                                 (json.dumps(job["config"]), job["id"]))
                    conn.execute("DELETE FROM usage_events WHERE supplier_event_key = %s",
                                 (f"fixture-hold:{job['id']}",))
                    settle_job(conn, UUID(job["id"]), "cancelled")
                    conn.execute("UPDATE job_attempts SET ended_at = COALESCE(ended_at, now()), "
                                 "end_reason = COALESCE(end_reason, 'fixture_cleanup'), "
                                 "billed_seconds = COALESCE(billed_seconds, 0) WHERE job_id = %s",
                                 (job["id"],))
                else:
                    current = conn.execute("UPDATE authorizations SET created_at = "
                                           "now() - interval '1 day' WHERE id = %s RETURNING *",
                                           (auth["id"],)).fetchone()
                    reservations.release_expired_unused(conn, current)


class ScopedConnection:
    def __init__(self, connection, database):
        self.connection = connection
        self.database = database

    def execute(self, query, params=None):
        column, ids = None, None
        if "FROM jobs j JOIN job_attempts" in query:
            column, ids = "j.id", self.database.job_ids
        elif query.startswith("SELECT a.* FROM authorizations a "):
            column, ids = "a.id", self.database.auth_ids
        elif query.startswith("SELECT id FROM jobs WHERE "):
            column, ids = "id", self.database.job_ids
        if column:
            query = query.replace("WHERE ", f"WHERE {column} = ANY(%s) AND ", 1)
            params = (ids, *(params or ()))
        if self.database.before:
            self.database.before(self.connection, query, params)
        return self.connection.execute(query, params)

    def __getattr__(self, name):
        return getattr(self.connection, name)


class ScopedDatabase:
    def __init__(self, database, records, before=None):
        self.database = database
        self.job_ids = [UUID(record["job"]["id"]) for record in records if record["job"]]
        self.auth_ids = [record["auth"]["id"] for record in records]
        self.before = before

    @contextmanager
    def tx(self):
        with self.database.tx() as conn:
            conn.execute("SET LOCAL lock_timeout = '10s'")
            conn.execute("SET LOCAL statement_timeout = '15s'")
            yield ScopedConnection(conn, self)


def snapshot(app, record):
    auth_id, org = record["auth"]["id"], record["org"]
    with app.state.db.tx() as conn:
        return {
            "auth": conn.execute("SELECT * FROM authorizations WHERE id = %s",
                                 (auth_id,)).fetchone(),
            "jobs": conn.execute("SELECT * FROM jobs WHERE authorization_id = %s ORDER BY id",
                                 (auth_id,)).fetchall(),
            "attempts": conn.execute("SELECT a.* FROM job_attempts a JOIN jobs j "
                                     "ON j.id = a.job_id WHERE j.authorization_id = %s "
                                     "ORDER BY a.id",
                                     (auth_id,)).fetchall(),
            "usage": conn.execute("SELECT u.* FROM usage_events u JOIN jobs j ON j.id = u.job_id "
                                  "WHERE j.authorization_id = %s ORDER BY u.id",
                                  (auth_id,)).fetchall(),
            "entries": conn.execute("SELECT * FROM journal_entries WHERE org_id = %s ORDER BY id",
                                    (org,)).fetchall(),
            "lines": conn.execute("SELECT l.* FROM journal_lines l JOIN journal_entries e "
                                  "ON e.id = l.entry_id WHERE e.org_id = %s "
                                  "ORDER BY l.entry_id, l.account_id", (org,)).fetchall(),
            # Platform accounts also move for healthy records; compare only this fixture's org.
            "accounts": conn.execute("SELECT * FROM ledger_accounts WHERE org_id = %s ORDER BY id",
                                     (org,)).fetchall(),
            "outbox": conn.execute("SELECT * FROM outbox WHERE org_id = %s ORDER BY id",
                                   (org,)).fetchall(),
        }


def start(app, worker, record):
    claim = worker.claim(record["job"]["id"])
    with app.state.db.tx() as conn:
        conn.execute("UPDATE job_attempts SET lease_expires_at = now() - interval '1 second' "
                     "WHERE id = %s", (claim.attempt_id,))
    return claim


def hold(app, record, kind="ceiling"):
    with app.state.db.tx() as conn:
        if kind == "ceiling":
            conn.execute("UPDATE authorizations SET reserved_nano = reserved_nano + 1 "
                         "WHERE id = %s", (record["auth"]["id"],))
        elif kind == "hash":
            conn.execute("UPDATE authorizations SET input_hash = 'held-identity' WHERE id = %s",
                         (record["auth"]["id"],))
        elif kind == "usage":
            conn.execute("INSERT INTO usage_events(org_id, job_id, supplier_event_key, supplier, "
                         "meter, units, unit, supplier_cost_nano, rate_version) "
                         "VALUES (%s, %s, %s, 'fixture', 'compute', 0, 'task-second', 0, 'wrong')",
                         (record["org"], record["job"]["id"],
                          f"fixture-hold:{record['job']['id']}"))
        else:
            config = record["job"]["config"] | {kind: "unknown-held-value"}
            conn.execute("UPDATE jobs SET config = %s WHERE id = %s",
                         (json.dumps(config), record["job"]["id"]))


def record_id(record):
    return str((record["job"] or record["auth"])["id"])


def recover(active):
    return reaper.reap_expired if active else reaper.reap_unused_authorizations


def watch_candidates(monkeypatch, active, callback):
    name = "_approved_rates" if active else "release_expired_unused"
    original = getattr(reaper, name)

    def observe(conn, candidate, *args, **kwargs):
        callback(conn, candidate)
        return original(conn, candidate, *args, **kwargs)

    monkeypatch.setattr(reaper, name, observe)


def assert_settled_once(app, record):
    state = snapshot(app, record)
    assert state["auth"]["status"] == "settled"
    entries = [entry for entry in state["entries"] if entry["kind"] == "settle"]
    assert len(entries) == 1
    assert entries[0]["idempotency_key"] == f"settle:{record['auth']['id']}"
    assert (entries[0]["reference"]["charge_nano"] + entries[0]["reference"]["release_nano"]
            == record["auth"]["reserved_nano"])
    with app.state.db.tx() as conn:
        assert ledger.balances(conn, UUID(record["org"]))["reserved_nano"] == 0
        assert ledger.reconcile(conn) == []
    if record["job"]:
        assert state["jobs"][0]["state"] == "settled"
        assert len(state["attempts"]) == len(state["usage"]) == 1
        assert state["attempts"][0]["ended_at"] is not None
        assert sum(event["event_type"] == "job.settled" for event in state["outbox"]) == 1
    return state


def test_worker_held_finish_rolls_back_and_next_claim_still_finishes(
        app, worker, records, monkeypatch):
    held, healthy = records(), records()
    hold(app, held)
    monkeypatch.setattr(worker, "db", ScopedDatabase(app.state.db, [held, healthy]))
    attempted, before = [], {}

    def finish_only(claim):
        job_id = str(claim.job["id"])
        attempted.append(job_id)
        if job_id == record_id(held):
            before.update(snapshot(app, held))
        worker._finish(claim, "failed", "synthetic finish", 0, None, {}, [])

    monkeypatch.setattr(worker, "execute", finish_only)
    assert worker.run_once() is True
    assert snapshot(app, held) == before
    assert worker.run_once() is True
    assert worker.run_once() is False
    assert attempted == [record_id(held), record_id(healthy)]
    settled = assert_settled_once(app, healthy)
    assert worker.run_once(record_id(held)) is False
    assert snapshot(app, held) == before
    assert snapshot(app, healthy) == settled


@pytest.mark.parametrize("active,kind", [
    (True, "ceiling"), (True, "rate_version"), (True, "resource_class"),
    (False, "ceiling"), (False, "hash"),
])
def test_interleaved_held_records_do_not_rollback_or_starve_healthy_records(
        app, worker, records, monkeypatch, active, kind):
    batch = [records(active=active) for _ in range(4)]
    for index, record in enumerate(batch):
        if active:
            start(app, worker, record)
        if index % 2 == 0:
            hold(app, record, kind)
    held = batch[::2]
    before = [snapshot(app, record) for record in held]
    visited = []
    watch_candidates(monkeypatch, active, lambda conn, row: visited.append(str(row["id"])))
    database = ScopedDatabase(app.state.db, batch)
    assert recover(active)(database, batch_size=4) == [record_id(r) for r in batch[1::2]]
    assert visited == [record_id(record) for record in batch]
    assert [snapshot(app, record) for record in held] == before
    settled = [assert_settled_once(app, record) for record in batch[1::2]]
    assert recover(active)(database, batch_size=4) == []
    assert visited[4:] == [record_id(record) for record in held]
    assert [snapshot(app, record) for record in held] == before
    assert [snapshot(app, record) for record in batch[1::2]] == settled


def test_usage_identity_hold_rolls_back_real_fence_attempt_and_usage_writes(
        app, worker, records, monkeypatch):
    held, healthy = records(), records()
    held_claim = start(app, worker, held)
    start(app, worker, healthy)
    hold(app, held, "usage")
    before = snapshot(app, held)
    original = reaper.settle_job
    attempted_writes = []

    def observe(conn, job_id, *args, **kwargs):
        if str(job_id) == record_id(held):
            job = conn.execute("SELECT * FROM jobs WHERE id = %s", (job_id,)).fetchone()
            attempt = conn.execute("SELECT * FROM job_attempts WHERE id = %s",
                                   (held_claim.attempt_id,)).fetchone()
            assert job["fence_token"] == held_claim.fence + 1
            assert attempt["ended_at"] is not None
            assert conn.execute("SELECT count(*) AS n FROM usage_events WHERE job_id = %s",
                                (job_id,)).fetchone()["n"] == 2
            attempted_writes.append(str(job_id))
        return original(conn, job_id, *args, **kwargs)

    monkeypatch.setattr(reaper, "settle_job", observe)
    database = ScopedDatabase(app.state.db, [held, healthy])
    assert reaper.reap_expired(database) == [record_id(healthy)]
    assert snapshot(app, held) == before
    settled = assert_settled_once(app, healthy)
    assert reaper.reap_expired(database) == []
    assert attempted_writes == [record_id(held), record_id(held)]
    assert snapshot(app, held) == before
    assert snapshot(app, healthy) == settled


@pytest.mark.parametrize("active", [True, False])
def test_all_held_pass_terminates_after_visiting_each_record_once(
        app, worker, records, monkeypatch, active):
    batch = [records(active=active) for _ in range(3)]
    for record in batch:
        if active:
            start(app, worker, record)
        hold(app, record)
    before = [snapshot(app, record) for record in batch]
    visited = []
    watch_candidates(monkeypatch, active, lambda conn, row: visited.append(str(row["id"])))
    database = ScopedDatabase(app.state.db, batch)
    for _ in range(2):
        assert recover(active)(database, batch_size=100) == []
        assert [snapshot(app, record) for record in batch] == before
    assert visited == [record_id(record) for record in batch] * 2


@pytest.mark.parametrize("active", [True, False])
def test_cursor_passes_move_beyond_a_held_prefix_larger_than_the_batch(
        app, worker, records, active):
    batch = [records(active=active) for _ in range(4)]
    for index, record in enumerate(batch):
        if active:
            start(app, worker, record)
        if index < 3:
            hold(app, record)
    before = [snapshot(app, record) for record in batch]
    database = ScopedDatabase(app.state.db, batch)
    cursor = reaper.ReapCursor()
    assert recover(active)(database, batch_size=2, cursor=cursor) == []
    assert [snapshot(app, record) for record in batch] == before
    assert recover(active)(database, batch_size=2, cursor=cursor) == [record_id(batch[-1])]
    assert [snapshot(app, record) for record in batch[:-1]] == before[:-1]
    settled = assert_settled_once(app, batch[-1])
    for _ in range(3):
        assert recover(active)(database, batch_size=2, cursor=cursor) == []
    assert [snapshot(app, record) for record in batch[:-1]] == before[:-1]
    assert snapshot(app, batch[-1]) == settled


@pytest.mark.parametrize("active", [True, False])
def test_two_reapers_skip_each_others_locks_and_settle_healthy_records_once(
        app, worker, records, monkeypatch, active):
    batch = [records(active=active) for _ in range(4)]
    for index, record in enumerate(batch):
        if active:
            start(app, worker, record)
        if index % 2 == 0:
            hold(app, record)
    before = [snapshot(app, record) for record in batch[::2]]
    barrier, thread = Barrier(2), local()
    first_locked = []

    def synchronize(conn, candidate):
        if not getattr(thread, "started", False):
            thread.started = True
            first_locked.append(str(candidate["id"]))
            # Both transactions already own a different candidate's row lock.
            barrier.wait(timeout=5)

    database = ScopedDatabase(app.state.db, batch)
    # The main-thread idempotency pass must not enter the two-worker rendezvous.
    with monkeypatch.context() as patch, ThreadPoolExecutor(max_workers=2) as pool:
        watch_candidates(patch, active, synchronize)
        futures = [pool.submit(recover(active), database, batch_size=4) for _ in range(2)]
        recovered = [value for future in futures for value in future.result(timeout=20)]
    assert len(first_locked) == len(set(first_locked)) == 2
    assert len(recovered) == len(set(recovered)) == 2
    assert set(recovered) == {record_id(record) for record in batch[1::2]}
    assert [snapshot(app, record) for record in batch[::2]] == before
    for record in batch[1::2]:
        assert_settled_once(app, record)
    assert recover(active)(database) == []
    assert [snapshot(app, record) for record in batch[::2]] == before


def wait_for_blocker(conn, waiter, blocker):
    deadline = monotonic() + 5
    while monotonic() < deadline:
        if conn.execute("SELECT %s = ANY(pg_blocking_pids(%s)) AS waiting",
                        (blocker, waiter)).fetchone()["waiting"]:
            return
        sleep(0.01)
    raise AssertionError("worker did not reach the expected reaper job-row lock wait")


@pytest.mark.parametrize("winner", ["worker", "reaper"])
def test_worker_reaper_race_preserves_fencing_and_single_settlement(
        app, worker, records, monkeypatch, winner):
    held, healthy = records(), records()
    start(app, worker, held)
    claim = start(app, worker, healthy)
    hold(app, held)
    before = snapshot(app, held)
    locked, release, worker_waiting = Event(), Event(), Event()
    locker_pids, worker_pids = [], []

    def pause_with_lock(conn, candidate):
        if str(candidate["id"]) == record_id(healthy):
            locker_pids.append(conn.info.backend_pid)
            locked.set()
            assert release.wait(timeout=15)

    def observe_worker_lock(conn, query, params):
        if query == "SELECT * FROM jobs WHERE id = %s FOR UPDATE" and not worker_waiting.is_set():
            worker_pids.append(conn.info.backend_pid)
            worker_waiting.set()

    monkeypatch.setattr(worker, "db", ScopedDatabase(app.state.db, [healthy], observe_worker_lock))
    database = ScopedDatabase(app.state.db, [held, healthy])
    if winner == "worker":
        original = worker_module.settle_job

        def pause_finish(conn, job_id, *args, **kwargs):
            pause_with_lock(conn, {"id": job_id})
            return original(conn, job_id, *args, **kwargs)

        monkeypatch.setattr(worker_module, "settle_job", pause_finish)
    else:
        watch_candidates(monkeypatch, True, pause_with_lock)

    def finish():
        return worker._finish(claim, "failed", "synthetic finish", 0, None, {}, [])

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(finish if winner == "worker" else reaper.reap_expired,
                            *(() if winner == "worker" else (database,)))
        second = None
        try:
            assert locked.wait(timeout=5)
            if winner == "worker":
                assert reaper.reap_expired(database) == []
            else:
                second = pool.submit(finish)
                assert worker_waiting.wait(timeout=5)
                with app.state.db.tx() as conn:
                    wait_for_blocker(conn, worker_pids[0], locker_pids[0])
                assert not second.done()
        finally:
            release.set()
        if winner == "worker":
            assert first.result(timeout=15) is None
        else:
            assert first.result(timeout=15) == [record_id(healthy)]
            with pytest.raises(LeaseLost):
                second.result(timeout=15)
    settled = assert_settled_once(app, healthy)
    assert settled["jobs"][0]["fence_token"] == claim.fence + (winner == "reaper")
    assert snapshot(app, held) == before
    with pytest.raises(LeaseLost):
        finish()
    assert reaper.reap_expired(database) == []
    assert snapshot(app, healthy) == settled
    assert snapshot(app, held) == before
