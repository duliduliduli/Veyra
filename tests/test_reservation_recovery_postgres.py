"""Staged PostgreSQL release gates. Do not run against a deployed/shared database.

These use the disposable database_url fixture, synthetic credits and no strategy
execution. The offline no_db plugin deselects every test in this file.
"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import timedelta
from threading import Barrier, Event
from time import monotonic, sleep
from uuid import UUID

import pytest
from fastapi import HTTPException, Response
from veyra_api import api_jobs, ledger, reservations
from veyra_api.auth import Principal
from veyra_scheduler import reaper
from veyra_scheduler.reaper import reap_unused_authorizations

TOPUP = 10 * 10**9
KEY = "reservation-race-key"


def reserved(api, app, scope=None):
    if scope is None:
        who = api.user()
        org = api.org(who)
        api.topup(who, org)
        project = api.project(who, org)
        version = project["latest_version"]["id"]
    else:
        who, org, version = scope
    quote = api.quote(who, version)
    auth = api.authorize(who, quote)
    with app.state.db.tx() as conn:
        row = conn.execute("SELECT * FROM authorizations WHERE id = %s", (auth["id"],)).fetchone()
    return who, org, quote, row


def expire(app, auth):
    with app.state.db.tx() as conn:
        conn.execute("UPDATE authorizations SET created_at = clock_timestamp() - interval '1 day' "
                     "WHERE id = %s", (auth["id"],))


def assert_accounting(app, org, auth, *, released):
    with app.state.db.tx() as conn:
        current = conn.execute("SELECT * FROM authorizations WHERE id = %s",
                               (auth["id"],)).fetchone()
        balance = ledger.balances(conn, UUID(org))
        assert balance["available_nano"] == TOPUP - (0 if released else auth["reserved_nano"])
        assert balance["reserved_nano"] == (0 if released else auth["reserved_nano"])
        assert balance["settled_usage_nano"] == 0
        assert current["status"] == ("settled" if released else "reserved")
        assert (current["settled_at"] is not None) is released
        entries = conn.execute(
            "SELECT kind, reference FROM journal_entries WHERE idempotency_key = ANY(%s)",
            ([f"reserve:{auth['id']}", f"settle:{auth['id']}"],)).fetchall()
        assert sorted(entry["kind"] for entry in entries) == (
            ["reserve", "settle"] if released else ["reserve"])
        if released:
            entry = next(entry for entry in entries if entry["kind"] == "settle")
            assert entry["reference"]["charge_nano"] == 0
            assert entry["reference"]["release_nano"] == auth["reserved_nano"]
        assert ledger.reconcile(conn) == []


def claim_direct(database, auth):
    response = Response()
    result = api_jobs.create_job(
        api_jobs.JobIn(authorization_id=auth["id"]), response,
        Principal(auth["approved_by"], "fixture@example.test"), database,
        idempotency_key=KEY)
    return response.status_code, result


class HookConnection:
    def __init__(self, connection, before):
        self.connection = connection
        self.before = before

    def execute(self, query, params=None):
        replacement = self.before(self.connection, query, params)
        if replacement is not None:
            query, params = replacement
        return self.connection.execute(query, params)

    def __getattr__(self, name):
        return getattr(self.connection, name)


class HookDatabase:
    def __init__(self, database, before):
        self.database = database
        self.before = before

    @contextmanager
    def tx(self):
        with self.database.tx() as conn:
            # Bound a broken concurrency test without leaving blocked DB sessions.
            conn.execute("SET LOCAL lock_timeout = '10s'")
            conn.execute("SET LOCAL statement_timeout = '20s'")
            yield HookConnection(conn, self.before)


def wait_for_blocker(conn, waiter_pid, blocker_pid):
    deadline = monotonic() + 5
    while monotonic() < deadline:
        if conn.execute("SELECT %s = ANY(pg_blocking_pids(%s)) AS waiting",
                        (blocker_pid, waiter_pid)).fetchone()["waiting"]:
            return
        sleep(0.01)
    raise AssertionError("the database statement did not reach the expected lock wait")


def test_late_claim_release_commits_replays_do_not_renew_or_reserve(api, app):
    who, org, quote, auth = reserved(api, app)
    expire(app, auth)
    first = api.c.post("/v1/jobs", json={"authorization_id": str(auth["id"])},
                       headers=who | {"idempotency-key": KEY})
    assert first.status_code == 410
    assert_accounting(app, org, auth, released=True)
    for key in (KEY, "different-late-key"):
        repeated = api.c.post("/v1/jobs", json={"authorization_id": str(auth["id"])},
                              headers=who | {"idempotency-key": key})
        assert repeated.status_code == 410  # closed unused authorization remains terminal
    replay = api.authorize(who, quote)
    assert replay["id"] == str(auth["id"])
    assert replay["status"] == "settled"
    with app.state.db.tx() as conn:
        current = conn.execute("SELECT * FROM authorizations WHERE id = %s",
                               (auth["id"],)).fetchone()
        assert replay["claim_expires_at"] == reservations.claim_expires_at(current).isoformat()
        assert conn.execute("SELECT count(*) AS n FROM jobs WHERE authorization_id = %s",
                            (auth["id"],)).fetchone()["n"] == 0
    assert str(auth["id"]) not in reap_unused_authorizations(app.state.db)
    assert_accounting(app, org, auth, released=True)


def test_unclaimed_authorize_replay_keeps_expired_consent_until_recovery(api, app):
    who, org, quote, auth = reserved(api, app)
    expire(app, auth)
    first = api.authorize(who, quote)
    second = api.authorize(who, quote)
    assert first == second
    assert first["status"] == "reserved"
    assert_accounting(app, org, auth, released=False)
    assert str(auth["id"]) in reap_unused_authorizations(app.state.db)
    assert str(auth["id"]) not in reap_unused_authorizations(app.state.db)
    assert_accounting(app, org, auth, released=True)


@pytest.mark.parametrize("state", ["queued", "running", "finalizing", "stopping", "settled"])
def test_every_claimed_job_survives_age_and_idempotent_retry(api, app, state):
    who, org, quote, auth = reserved(api, app)
    original = api.job(who, str(auth["id"]), key=KEY)
    if state == "settled":
        api.ok(api.c.post(f"/v1/jobs/{original['id']}/cancel", headers=who))
    else:
        with app.state.db.tx() as conn:
            conn.execute("UPDATE jobs SET state = %s WHERE id = %s", (state, original["id"]))
    expire(app, auth)
    before = api.balance(who, org)
    assert str(auth["id"]) not in reap_unused_authorizations(app.state.db)
    response = api.c.post("/v1/jobs", json={"authorization_id": str(auth["id"])},
                          headers=who | {"idempotency-key": KEY})
    assert response.status_code == 200
    assert response.json()["id"] == original["id"]
    assert response.json()["state"] == state
    assert api.authorize(who, quote)["id"] == str(auth["id"])
    assert api.balance(who, org) == before
    assert_accounting(app, org, auth, released=(state == "settled"))


def test_recovery_is_bounded_and_does_not_touch_fresh_unused_authorizations(api, app):
    fixtures = [reserved(api, app) for _ in range(4)]
    for _, _, _, auth in fixtures[:3]:
        expire(app, auth)
    first = reap_unused_authorizations(app.state.db, batch_size=2)
    assert len(first) == 2
    second = reap_unused_authorizations(app.state.db, batch_size=2)
    assert len(second) == 1
    assert set(first + second) == {str(row[3]["id"]) for row in fixtures[:3]}
    for index, (_, org, _, auth) in enumerate(fixtures):
        assert_accounting(app, org, auth, released=index < 3)


@pytest.mark.parametrize("entrypoint", ["claim", "reaper"])
def test_posting_failure_rolls_back_journal_balances_and_status(api, app, monkeypatch, entrypoint):
    _, org, _, auth = reserved(api, app)
    expire(app, auth)
    real_settle = ledger.settle

    def fail_after_post(conn, *args, **kwargs):
        real_settle(conn, *args, **kwargs)
        raise RuntimeError("failure after journal write")

    monkeypatch.setattr(ledger, "settle", fail_after_post)
    with pytest.raises(RuntimeError, match="failure after journal write"):
        if entrypoint == "claim":
            claim_direct(app.state.db, auth)
        else:
            reap_unused_authorizations(app.state.db)
    assert_accounting(app, org, auth, released=False)
    monkeypatch.setattr(ledger, "settle", real_settle)
    assert str(auth["id"]) in reap_unused_authorizations(app.state.db)
    assert_accounting(app, org, auth, released=True)


@pytest.mark.parametrize("same_org", [False, True])
def test_concurrent_reapers_release_each_orphan_once_without_lock_cycles(api, app, same_org):
    first = reserved(api, app)
    scope = (first[0], first[1], first[2]["inputs"]["request"]["project_version_id"])
    fixtures = [first] + [reserved(api, app, scope if same_org else None) for _ in range(7)]
    for _, _, _, auth in fixtures:
        expire(app, auth)
    barrier = Barrier(4)

    def recover():
        barrier.wait(timeout=10)
        return reap_unused_authorizations(HookDatabase(app.state.db, lambda *args: None))

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(recover) for _ in range(4)]
        results = [value for future in futures for value in future.result(timeout=20)]
    assert len(results) == len(set(results)) == 8
    assert set(results) == {str(row[3]["id"]) for row in fixtures}
    for _, org, _, auth in fixtures:
        assert_accounting(app, org, auth, released=True)


def test_claim_wins_lock_before_deadline_reaper_cannot_release_after_deadline(api, app):
    _, org, _, auth = reserved(api, app)
    with app.state.db.tx() as conn:
        auth = conn.execute(
            "UPDATE authorizations SET created_at = clock_timestamp() - interval '15 minutes' "
            "+ interval '5 seconds' WHERE id = %s RETURNING *", (auth["id"],)).fetchone()
    validated, finish_claim = Event(), Event()

    def pause_before_insert(conn, query, params):
        if query.startswith("INSERT INTO jobs"):
            validated.set()  # Real claim deadline check passed while holding the auth lock.
            assert finish_claim.wait(timeout=15)

    with ThreadPoolExecutor(max_workers=1) as executor:
        claimant = executor.submit(
            claim_direct, HookDatabase(app.state.db, pause_before_insert), auth)
        try:
            assert validated.wait(timeout=4)
            with app.state.db.tx() as conn:
                conn.execute("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM "
                             "(%s - clock_timestamp()))))",
                             (reservations.claim_expires_at(auth) + timedelta(milliseconds=20),))
            assert str(auth["id"]) not in reap_unused_authorizations(app.state.db)
        finally:
            finish_claim.set()
        _, job = claimant.result(timeout=10)
    assert str(auth["id"]) not in reap_unused_authorizations(app.state.db)
    assert claim_direct(app.state.db, auth)[1]["id"] == job["id"]
    assert_accounting(app, org, auth, released=False)


def test_reaper_wins_lock_claim_waits_then_cannot_create(api, app, monkeypatch):
    _, org, _, auth = reserved(api, app)
    expire(app, auth)
    releasing, finish_release, claimant_started = Event(), Event(), Event()
    recovery_pids, claimant_pids = [], []
    real_settle = ledger.settle

    def pause_release(conn, *args, **kwargs):
        if args[1] == auth["id"]:
            recovery_pids.append(conn.info.backend_pid)
            releasing.set()
            assert finish_release.wait(timeout=20)
        return real_settle(conn, *args, **kwargs)

    def before_claim(conn, query, params):
        if query == "SELECT * FROM authorizations WHERE id = %s FOR UPDATE":
            claimant_pids.append(conn.info.backend_pid)
            claimant_started.set()

    monkeypatch.setattr(ledger, "settle", pause_release)
    with ThreadPoolExecutor(max_workers=2) as executor:
        recovery = executor.submit(
            reap_unused_authorizations, HookDatabase(app.state.db, lambda *args: None))
        claimant = None
        try:
            assert releasing.wait(timeout=5)
            claimant = executor.submit(claim_direct, HookDatabase(app.state.db, before_claim), auth)
            assert claimant_started.wait(timeout=5)
            with app.state.db.tx() as observer:
                wait_for_blocker(observer, claimant_pids[0], recovery_pids[0])
            assert not claimant.done()
        finally:
            finish_release.set()
        assert str(auth["id"]) in recovery.result(timeout=10)
        with pytest.raises(HTTPException) as rejected:
            claimant.result(timeout=10)
        assert rejected.value.status_code == 410
        assert rejected.value.detail == "authorization expired; request a new quote"
    assert_accounting(app, org, auth, released=True)
    with app.state.db.tx() as conn:
        assert conn.execute("SELECT 1 FROM jobs WHERE authorization_id = %s",
                            (auth["id"],)).fetchone() is None


def test_fresh_post_lock_recheck_rejects_a_pre_lock_no_job_snapshot(api, app):
    who, org, _, auth = reserved(api, app)
    with app.state.db.tx() as recovery:
        # Capture an outdated candidate before taking its lock, as a locking statement
        # can do under READ COMMITTED. Another transaction now claims and commits.
        stale = recovery.execute("SELECT * FROM authorizations WHERE id = %s",
                                 (auth["id"],)).fetchone()
        assert recovery.execute("SELECT 1 FROM jobs WHERE authorization_id = %s",
                                (auth["id"],)).fetchone() is None
        api.job(who, str(auth["id"]), key=KEY)
        expire(app, auth)
        locked = recovery.execute("SELECT * FROM authorizations WHERE id = %s FOR UPDATE",
                                  (stale["id"],)).fetchone()
        assert not reservations.release_expired_unused(recovery, locked)
    assert_accounting(app, org, auth, released=False)


def test_reaper_rechecks_job_after_stale_candidate_statement_snapshot(api, app, monkeypatch):
    _, org, _, auth = reserved(api, app)
    with app.state.db.tx() as conn:
        auth = conn.execute(
            "UPDATE authorizations SET created_at = clock_timestamp() - interval '15 minutes' "
            "+ interval '5 seconds' WHERE id = %s RETURNING *", (auth["id"],)).fetchone()
    validated, finish_claim, candidate_started = Event(), Event(), Event()
    gate_key = auth["id"].int & ((1 << 63) - 1)
    candidate_pids, checked_candidates = [], []

    def pause_before_insert(conn, query, params):
        if query.startswith("INSERT INTO jobs"):
            validated.set()
            assert finish_claim.wait(timeout=30)

    def gate_candidate(conn, query, params):
        if query.startswith("SELECT a.* FROM authorizations a "):
            conn.execute("SET LOCAL lock_timeout = '20s'")
            conn.execute("SET LOCAL statement_timeout = '30s'")
            candidate_pids.append(conn.info.backend_pid)
            candidate_started.set()
            # The gate blocks inside the statement, after its READ COMMITTED snapshot.
            # Keep the production filters, ordering, LIMIT and row-lock clause unchanged.
            gated = (
                "WITH recovery_snapshot_gate AS MATERIALIZED "
                "(SELECT pg_advisory_xact_lock(%s)) "
                + query.replace("FROM authorizations a ",
                                "FROM authorizations a CROSS JOIN recovery_snapshot_gate ", 1))
            return gated, (gate_key, *params)

    def record_recheck(conn, candidate):
        checked_candidates.append(candidate["id"])
        return reservations.release_expired_unused(conn, candidate)

    monkeypatch.setattr(reaper, "release_expired_unused", record_recheck)
    with ThreadPoolExecutor(max_workers=2) as executor:
        claimant = executor.submit(
            claim_direct, HookDatabase(app.state.db, pause_before_insert), auth)
        try:
            assert validated.wait(timeout=4)
            with app.state.db.tx() as coordinator:
                coordinator.execute("SET LOCAL lock_timeout = '5s'")
                coordinator.execute("SET LOCAL statement_timeout = '10s'")
                coordinator.execute("SELECT pg_advisory_xact_lock(%s)", (gate_key,))
                coordinator.execute("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM "
                                    "(%s - clock_timestamp()))))",
                                    (reservations.claim_expires_at(auth)
                                     + timedelta(milliseconds=20),))
                recovery = executor.submit(
                    reap_unused_authorizations, HookDatabase(app.state.db, gate_candidate),
                    batch_size=1)
                assert candidate_started.wait(timeout=5)
                wait_for_blocker(coordinator, candidate_pids[0], coordinator.info.backend_pid)
                assert coordinator.execute(
                    "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid = %s "
                    "AND locktype = 'advisory' AND NOT granted) AS waiting",
                    (candidate_pids[0],)).fetchone()["waiting"]
                finish_claim.set()
                _, job = claimant.result(timeout=10)  # Commit before the candidate takes its lock.
            # Committing the coordinator releases its transaction-scoped advisory lock.
            assert recovery.result(timeout=10) == []
        finally:
            finish_claim.set()
    assert checked_candidates == [auth["id"]], "the stale candidate must reach the fresh recheck"
    assert claim_direct(app.state.db, auth)[1]["id"] == job["id"]
    assert_accounting(app, org, auth, released=False)


def test_claim_checks_wall_clock_after_waiting_for_authorization_lock(api, app):
    _, org, _, auth = reserved(api, app)
    claimant_started = Event()
    claimant_pids = []

    def before_claim(conn, query, params):
        if query == "SELECT * FROM authorizations WHERE id = %s FOR UPDATE":
            assert conn.execute("SELECT transaction_timestamp() < %s AS before_deadline",
                                (reservations.claim_expires_at(auth),)).fetchone()["before_deadline"]
            claimant_pids.append(conn.info.backend_pid)
            claimant_started.set()

    with ThreadPoolExecutor(max_workers=1) as executor:
        with app.state.db.tx() as conn:
            auth = conn.execute(
                "UPDATE authorizations SET created_at = clock_timestamp() "
                "- interval '15 minutes' + interval '3 seconds' WHERE id = %s RETURNING *",
                (auth["id"],)).fetchone()
            claimant = executor.submit(claim_direct, HookDatabase(app.state.db, before_claim), auth)
            assert claimant_started.wait(timeout=5)
            wait_for_blocker(conn, claimant_pids[0], conn.info.backend_pid)
            assert not claimant.done()
            conn.execute("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM "
                         "(%s - clock_timestamp()))))",
                         (reservations.claim_expires_at(auth) + timedelta(milliseconds=20),))
        status, result = claimant.result(timeout=10)
    assert status == 410
    assert result == {"detail": "authorization expired; request a new quote"}
    assert_accounting(app, org, auth, released=True)


def test_quote_price_expiry_does_not_shorten_fresh_authorization_claim_window(api, app):
    who, org, quote, auth = reserved(api, app)
    with app.state.db.tx() as conn:
        conn.execute("UPDATE quotes SET expires_at = clock_timestamp() - interval '1 day' "
                     "WHERE id = %s", (quote["id"],))
    job = api.job(who, str(auth["id"]), key=KEY)
    assert job["authorization_id"] == str(auth["id"])
    assert str(auth["id"]) not in reap_unused_authorizations(app.state.db)
    assert_accounting(app, org, auth, released=False)
