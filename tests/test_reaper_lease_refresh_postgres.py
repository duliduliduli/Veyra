"""Staged, unrun disposable-PostgreSQL gate for snapshot-to-job-lock renewal.

Source-only verification must not execute this module. Synthetic credits only;
call the real heartbeat directly, never a strategy, engine or worker process.
"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
from threading import Event
from time import monotonic, sleep
from uuid import uuid4

import pytest
from test_heartbeat_lock_order_postgres import assert_heartbeat_only
from test_heartbeat_lock_order_postgres import heartbeat_worker as heartbeat_worker
from test_held_record_resilience_postgres import (
    ScopedDatabase,
    assert_settled_once,
    record_id,
    snapshot,
    start,
)
from test_held_record_resilience_postgres import records as records
from veyra_scheduler import reaper


def plan_nodes(plan):
    yield plan
    for child in plan.get("Plans", []):
        yield from plan_nodes(child)


def assert_gate_below_lock_rows(plan):
    nodes = list(plan_nodes(plan))
    locking = [node for node in nodes if node["Node Type"] == "LockRows"]
    scans = [node for node in nodes
             if node["Node Type"] == "CTE Scan" and node.get("CTE Name") == "snapshot_gate"]
    definitions = [node for node in nodes if node.get("Subplan Name") == "CTE snapshot_gate"]
    assert len(locking) == len(scans) == len(definitions) == 1, plan
    assert any(node is scans[0] for node in plan_nodes(locking[0])), plan
    assert "pg_advisory_xact_lock" in " ".join(definitions[0].get("Output", [])), plan


class GatedCursor:
    def __init__(self, cursor, database):
        self.cursor = cursor
        self.database = database

    def fetchone(self):
        row = self.cursor.fetchone()
        self.database.first_candidate = row
        return row


class GatedConnection:
    def __init__(self, connection, database):
        self.connection = connection
        self.database = database

    def execute(self, query, params=None):
        database = self.database
        if query == "SELECT * FROM authorizations WHERE id = %s FOR UPDATE":
            database.authorization_locks.append(params[0])
        if "FROM jobs j JOIN job_attempts" in query and not database.gated:
            database.gated = True
            assert query.count("WHERE ") == 1
            assert query.endswith("FOR UPDATE OF j SKIP LOCKED")
            assert self.connection.execute("SHOW transaction_isolation").fetchone()[
                "transaction_isolation"] == "read committed"
            # Scoping already ran; prepend the gate SQL and its parameter together.
            query = ("WITH snapshot_gate AS MATERIALIZED "
                     "(SELECT pg_advisory_xact_lock(%s::bigint)) "
                     + query.replace("WHERE ", "CROSS JOIN snapshot_gate WHERE ", 1))
            params = (database.key, *params)
            plan = self.connection.execute("EXPLAIN (FORMAT JSON, VERBOSE) " + query,
                                           params).fetchone()["QUERY PLAN"][0]["Plan"]
            assert_gate_below_lock_rows(plan)
            database.backend_pid = self.connection.info.backend_pid
            database.ready.set()
            return GatedCursor(self.connection.execute(query, params), database)
        return self.connection.execute(query, params)

    def __getattr__(self, name):
        return getattr(self.connection, name)


class GatedDatabase(ScopedDatabase):
    def __init__(self, database, records):
        super().__init__(database, records)
        self.key = uuid4().int & ((1 << 63) - 1)
        self.gated = False
        self.ready = Event()
        self.backend_pid = None
        self.first_candidate = None
        self.authorization_locks = []

    @contextmanager
    def tx(self):
        with super().tx() as scoped:
            # Intercept only after ScopedConnection has added its fixture predicates.
            scoped.connection = GatedConnection(scoped.connection, self)
            yield scoped


def advisory_waiting(conn, waiter, blocker):
    return conn.execute(
        "SELECT EXISTS (SELECT 1 FROM pg_locks waiting JOIN pg_locks held "
        "USING (locktype, database, classid, objid, objsubid) "
        "WHERE waiting.locktype = 'advisory' AND waiting.pid = %s "
        "AND NOT waiting.granted AND held.pid = %s AND held.granted "
        "AND %s = ANY(pg_blocking_pids(%s))) AS waiting",
        (waiter, blocker, blocker, waiter)).fetchone()["waiting"]


def wait_for_advisory_gate(conn, database, future):
    deadline = monotonic() + 5
    while monotonic() < deadline:
        if future.done():
            future.result()
            raise AssertionError("reaper finished before its advisory snapshot gate")
        if (database.ready.is_set()
                and advisory_waiting(conn, database.backend_pid, conn.info.backend_pid)):
            return
        sleep(0.01)
    raise AssertionError("reaper did not reach its verified advisory snapshot gate")


@pytest.mark.parametrize("later_expired", [False, True], ids=["alone", "later-expired"])
def test_heartbeat_committed_after_discovery_snapshot_is_not_reaped(
        app, heartbeat_worker, records, monkeypatch, later_expired):
    worker, renewed_record = heartbeat_worker, records()
    claim = start(app, worker, renewed_record)
    claim.progress = {"bars_done": 6, "bars_total": 20}
    batch = [renewed_record]
    if later_expired:
        batch.append(records())
        start(app, worker, batch[-1])
    before = snapshot(app, renewed_record)
    assert before["attempts"][0]["ended_at"] is None
    database = GatedDatabase(app.state.db, batch)
    cursor = reaper.ReapCursor()
    monkeypatch.setattr(worker, "db", ScopedDatabase(app.state.db, [renewed_record]))

    with ThreadPoolExecutor(max_workers=2) as pool:
        with ExitStack() as gate:
            coordinator = gate.enter_context(app.state.db.tx())
            coordinator.execute("SET LOCAL statement_timeout = '15s'")
            assert before["attempts"][0]["lease_expires_at"] < coordinator.execute(
                "SELECT clock_timestamp() AS stamp").fetchone()["stamp"]
            coordinator.execute("SELECT pg_advisory_xact_lock(%s::bigint)", (database.key,))
            future = pool.submit(reaper.reap_expired, database,
                                 batch_size=len(batch), cursor=cursor)
            try:
                # A Python callback is insufficient: SQL must be waiting after its snapshot.
                wait_for_advisory_gate(coordinator, database, future)
                heartbeat = pool.submit(worker._heartbeat, claim)
                assert heartbeat.result(timeout=5) is None
                assert not future.done()
                assert advisory_waiting(coordinator, database.backend_pid,
                                        coordinator.info.backend_pid)
                renewed = snapshot(app, renewed_record)
                assert_heartbeat_only(before, renewed, claim, worker.settings.job_lease_seconds)
                assert renewed["jobs"][0]["state"] == "running"
                assert renewed["jobs"][0]["fence_token"] == claim.fence
                assert (renewed["attempts"][0]["heartbeat_at"]
                        > before["attempts"][0]["heartbeat_at"])
                assert coordinator.execute(
                    "SELECT lease_expires_at > clock_timestamp() AS live "
                    "FROM job_attempts WHERE id = %s", (claim.attempt_id,)).fetchone()["live"]
            finally:
                # Transaction-scoped lock always releases before waiting for the executor.
                gate.close()
        assert future.result(timeout=20) == ([record_id(batch[-1])] if later_expired else [])

    candidate = database.first_candidate
    assert candidate is not None
    assert str(candidate["id"]) == record_id(renewed_record)
    assert candidate["attempt_id"] == claim.attempt_id
    # Healthy recovery locks its authorization before billing and again in settlement.
    assert database.authorization_locks == (
        [batch[-1]["auth"]["id"]] * 2 if later_expired else [])
    assert snapshot(app, renewed_record) == renewed
    settled = assert_settled_once(app, batch[-1]) if later_expired else None
    last_job = settled["jobs"][0] if later_expired else renewed["jobs"][0]
    assert cursor.after == (last_job["created_at"], last_job["id"])
    assert reaper.reap_expired(database, batch_size=len(batch), cursor=cursor) == []
    assert cursor.after is None
    assert snapshot(app, renewed_record) == renewed
    if later_expired:
        assert snapshot(app, batch[-1]) == settled
