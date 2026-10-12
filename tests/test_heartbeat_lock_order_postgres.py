"""Staged, unrun disposable-PostgreSQL release gates; source-only checks do not run these.

Synthetic credits only; call heartbeat/finish directly, never a strategy or engine.
The heartbeat-first gate proves SKIP LOCKED for an already-held job lock, not the
reaper's separate joined-snapshot expiry/revalidation race. Renewal time is checked
after a job-lock wait only, not after unrelated direct attempt-lock contention.
"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import timedelta
from threading import Event
from uuid import uuid4

import pytest
from test_held_record_resilience_postgres import (
    ScopedDatabase,
    assert_settled_once,
    record_id,
    snapshot,
    start,
    wait_for_blocker,
)
from test_held_record_resilience_postgres import records as records
from veyra_scheduler import reaper
from veyra_scheduler import worker as worker_module
from veyra_scheduler.worker import LeaseLost


@pytest.fixture
def heartbeat_worker(worker, monkeypatch):
    # Keep a renewed lease live throughout assertions despite the session's 2s lease.
    monkeypatch.setattr(worker, "settings", replace(worker.settings, job_lease_seconds=60))
    return worker


def assert_heartbeat_only(before, after, claim, lease_seconds):
    attempt = after["attempts"][0]
    assert not claim.lost
    assert claim.cancel_requested == after["jobs"][0]["cancel_requested"]
    assert attempt["heartbeat_at"] >= before["attempts"][0]["heartbeat_at"]
    assert attempt["lease_expires_at"] - attempt["heartbeat_at"] == timedelta(
        seconds=lease_seconds)
    assert after == before | {
        "jobs": [before["jobs"][0] | {"progress": claim.progress}],
        "attempts": [before["attempts"][0] | {
            "heartbeat_at": attempt["heartbeat_at"],
            "lease_expires_at": attempt["lease_expires_at"],
        }],
    }


def test_job_blocked_heartbeat_owns_no_attempt_lock_and_renews_after_unlock(
        app, heartbeat_worker, records, monkeypatch):
    worker, record = heartbeat_worker, records()
    claim = start(app, worker, record)
    claim.progress = {"bars_done": 3, "bars_total": 20}
    before = snapshot(app, record)
    entered, pids = Event(), []

    def observe(conn, query, params):
        if not entered.is_set():
            pids.append(conn.info.backend_pid)
            entered.set()

    monkeypatch.setattr(worker, "db", ScopedDatabase(app.state.db, [record], observe))
    with ThreadPoolExecutor(max_workers=1) as pool:
        # Exit the holder transaction before the executor, including on assertion failure.
        with app.state.db.tx() as holder:
            holder.execute("SELECT id FROM jobs WHERE id = %s FOR UPDATE",
                           (record_id(record),))
            holder.execute("UPDATE jobs SET cancel_requested = true WHERE id = %s",
                           (record_id(record),))
            future = pool.submit(worker._heartbeat, claim)
            assert entered.wait(timeout=5)
            wait_for_blocker(holder, pids[0], holder.info.backend_pid)
            assert not future.done()
            assert holder.execute("SELECT id FROM job_attempts WHERE id = %s FOR UPDATE NOWAIT",
                                  (claim.attempt_id,)).fetchone()["id"] == claim.attempt_id
            unlocked_after = holder.execute("SELECT clock_timestamp() AS stamp").fetchone()["stamp"]
        assert future.result(timeout=15) is None
    after = snapshot(app, record)
    assert claim.cancel_requested is True
    assert after["attempts"][0]["heartbeat_at"] >= unlocked_after
    # Cancellation was committed by the holder, and must be read after that lock wait.
    before["jobs"][0]["cancel_requested"] = True
    assert_heartbeat_only(before, after, claim, worker.settings.job_lease_seconds)


@pytest.mark.parametrize("winner", ["finish", "reaper"])
def test_finish_or_reaper_winner_fences_waiting_heartbeat_and_settles_once(
        app, heartbeat_worker, records, monkeypatch, winner):
    worker, record = heartbeat_worker, records()
    claim = start(app, worker, record)
    claim.progress = {"bars_done": 9, "bars_total": 20}
    claim.cancel_requested = True
    before = snapshot(app, record)
    locked, release, entered = Event(), Event(), Event()
    locker_pids, heartbeat_pids = [], []
    target = worker_module if winner == "finish" else reaper
    original = target._approved_rates

    def pause_winner(conn, job, auth):
        locker_pids.append(conn.info.backend_pid)
        locked.set()
        assert release.wait(timeout=15)
        return original(conn, job, auth)

    def observe_heartbeat(conn, query, params):
        if locked.is_set() and not entered.is_set():
            heartbeat_pids.append(conn.info.backend_pid)
            entered.set()

    monkeypatch.setattr(target, "_approved_rates", pause_winner)
    monkeypatch.setattr(worker, "db", ScopedDatabase(app.state.db, [record], observe_heartbeat))
    database = ScopedDatabase(app.state.db, [record])

    def finish():
        return worker._finish(claim, "failed", "synthetic finish", 0, None, {}, [])

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(finish if winner == "finish" else reaper.reap_expired,
                            *(() if winner == "finish" else (database,)))
        heartbeat = None
        try:
            assert locked.wait(timeout=5)
            heartbeat = pool.submit(worker._heartbeat, claim)
            assert entered.wait(timeout=5)
            with app.state.db.tx() as conn:
                wait_for_blocker(conn, heartbeat_pids[0], locker_pids[0])
                assert conn.execute("SELECT id FROM job_attempts WHERE id = %s FOR UPDATE NOWAIT",
                                    (claim.attempt_id,)).fetchone()["id"] == claim.attempt_id
            assert not heartbeat.done()
        finally:
            release.set()
        assert first.result(timeout=15) == (None if winner == "finish" else [record_id(record)])
        assert heartbeat.result(timeout=15) is None
    assert claim.lost is True
    assert claim.cancel_requested is True
    settled = assert_settled_once(app, record)
    assert settled["jobs"][0]["fence_token"] == claim.fence + (winner == "reaper")
    assert settled["jobs"][0]["progress"] == before["jobs"][0]["progress"]
    for field in ("heartbeat_at", "lease_expires_at"):
        assert settled["attempts"][0][field] == before["attempts"][0][field]
    assert worker._heartbeat(claim) is None
    with pytest.raises(LeaseLost):
        finish()
    assert reaper.reap_expired(database) == []
    assert snapshot(app, record) == settled


def test_heartbeat_job_lock_makes_reaper_skip_and_expired_live_attempt_renews(
        app, heartbeat_worker, records, monkeypatch):
    worker, record = heartbeat_worker, records()
    claim = start(app, worker, record)
    claim.progress = {"bars_done": 4, "bars_total": 20}
    before = snapshot(app, record)
    locked, release = Event(), Event()

    def pause_before_attempt(conn, query, params):
        if query.startswith("UPDATE job_attempts") and not locked.is_set():
            locked.set()
            assert release.wait(timeout=15)

    monkeypatch.setattr(worker, "db", ScopedDatabase(app.state.db, [record], pause_before_attempt))
    database = ScopedDatabase(app.state.db, [record])
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(worker._heartbeat, claim)
        try:
            assert locked.wait(timeout=5)
            assert reaper.reap_expired(database) == []
            assert snapshot(app, record) == before
        finally:
            release.set()
        assert future.result(timeout=15) is None
    renewed = snapshot(app, record)
    assert_heartbeat_only(before, renewed, claim, worker.settings.job_lease_seconds)
    assert reaper.reap_expired(database) == []
    assert snapshot(app, record) == renewed
    worker._finish(claim, "failed", "synthetic finish", 0, None, {}, [])
    settled = assert_settled_once(app, record)
    assert worker._heartbeat(claim) is None
    assert claim.lost is True
    assert reaper.reap_expired(database) == []
    assert snapshot(app, record) == settled


@pytest.mark.parametrize("invalid", [
    "missing_job", "job_fence", "nonrunning_job", "missing_attempt",
    "other_job_attempt", "attempt_fence", "ended_attempt",
])
def test_invalid_heartbeat_identity_is_lost_without_writes(
        app, heartbeat_worker, records, invalid):
    worker, record = heartbeat_worker, records()
    claim = start(app, worker, record)
    batch = [record]
    if invalid == "missing_job":
        claim = replace(claim, job=claim.job | {"id": uuid4()})
    elif invalid == "job_fence":
        claim = replace(claim, fence=claim.fence + 1)
    elif invalid == "missing_attempt":
        claim = replace(claim, attempt_id=uuid4())
    elif invalid == "other_job_attempt":
        other = records()
        batch.append(other)
        claim = replace(claim, attempt_id=start(app, worker, other).attempt_id)
    else:
        with app.state.db.tx() as conn:
            if invalid == "nonrunning_job":
                conn.execute("UPDATE jobs SET state = 'stopping' WHERE id = %s",
                             (record_id(record),))
            elif invalid == "attempt_fence":
                conn.execute("UPDATE job_attempts SET fence_token = fence_token + 1 WHERE id = %s",
                             (claim.attempt_id,))
            else:
                conn.execute("UPDATE job_attempts SET ended_at = now(), "
                             "end_reason = 'fixture_ended', billed_seconds = 0 WHERE id = %s",
                             (claim.attempt_id,))
    claim.cancel_requested = True
    claim.progress = {"bars_done": 7, "bars_total": 20}
    before = [snapshot(app, item) for item in batch]
    for _ in range(2):
        assert worker._heartbeat(claim) is None
        assert claim.lost is True
        assert claim.cancel_requested is True
        assert claim.progress == {"bars_done": 7, "bars_total": 20}
        assert [snapshot(app, item) for item in batch] == before
