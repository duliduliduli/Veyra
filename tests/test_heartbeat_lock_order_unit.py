"""Heartbeat source contracts with transactional doubles, never a live runtime."""

import copy
import json
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from veyra_scheduler.worker import Claim, Worker

STAMP = datetime(2026, 1, 1, tzinfo=UTC)
JOB_LOCK = "SELECT state, fence_token, cancel_requested FROM jobs WHERE id = %s FOR UPDATE"


@pytest.fixture(autouse=True)
def no_external_boundaries(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("heartbeat unit test crossed an external boundary")

    for target in (
        "psycopg.connect", "psycopg_pool.ConnectionPool.__init__",
        "veyra_api.db.Database.__init__", "veyra_api.db.Database.tx", "veyra_api.db.migrate",
        "socket.socket.connect", "socket.socket.connect_ex", "socket.create_connection",
        "threading.Thread.start", "subprocess.Popen", "os.system", "os.fork",
        "veyra_sim.engine.run", "veyra_sim.sandbox.StrategyProcess",
        "veyra_scheduler.worker.StrategyProcess", "veyra_sdk.host._load_strategy",
        "veyra_api.ledger.post", "veyra_api.ledger.reserve", "veyra_api.ledger.settle",
        "veyra_api.ledger.credit_topup", "veyra_api.ledger.ensure_org_accounts",
        "veyra_api.ledger.ensure_platform_accounts", "veyra_scheduler.worker.record_compute_usage",
        "veyra_scheduler.worker.settle_job", "veyra_scheduler.worker.Worker.execute",
        "veyra_scheduler.worker.Worker._finish", "veyra_scheduler.worker.Worker._write_report",
    ):
        monkeypatch.setattr(target, blocked)


class HeartbeatDatabase:
    def __init__(self):
        self.job = {"id": uuid4(), "fence_token": 3, "state": "running",
                    "cancel_requested": False, "progress": {"bars_done": 1}}
        self.attempt = {"id": uuid4(), "job_id": self.job["id"], "fence_token": 3,
                        "ended_at": None, "heartbeat_at": STAMP,
                        "lease_expires_at": STAMP - timedelta(seconds=1)}
        self.statements = []
        self.commits = self.rollbacks = 0
        self.fail_at = None
        self.locked = False

    @contextmanager
    def tx(self):
        before = copy.deepcopy((self.job, self.attempt))
        try:
            yield self
        except BaseException:
            self.job, self.attempt = before
            self.rollbacks += 1
            raise
        else:
            self.commits += 1
        finally:
            self.locked = False

    def execute(self, sql, params):
        self.statements.append((sql, params))
        if sql.startswith(self.fail_at or "<no failure>"):
            raise RuntimeError("mock database failure")
        row = None
        if sql == JOB_LOCK:
            assert not self.locked
            assert len(params) == 1
            if self.job and self.job["id"] == params[0]:
                self.locked = True
                row = copy.deepcopy(self.job)
        elif sql.startswith("UPDATE job_attempts "):
            assert self.locked, "attempt lock must follow authoritative job lock"
            assert sql == (
                "UPDATE job_attempts SET heartbeat_at = statement_timestamp(), "
                "lease_expires_at = statement_timestamp() + make_interval(secs => %s) "
                "WHERE id = %s AND job_id = %s AND fence_token = %s AND ended_at IS NULL "
                "RETURNING id")
            seconds, attempt_id, job_id, fence = params
            if (self.attempt and self.attempt["id"] == attempt_id
                    and self.attempt["job_id"] == job_id
                    and self.attempt["fence_token"] == fence
                    and self.attempt["ended_at"] is None):
                self.attempt.update(heartbeat_at=STAMP,
                                    lease_expires_at=STAMP + timedelta(seconds=seconds))
                row = {"id": attempt_id}
        elif sql == "UPDATE jobs SET progress = %s WHERE id = %s AND fence_token = %s":
            assert self.locked
            progress, job_id, fence = params
            assert (job_id, fence) == (self.job["id"], self.job["fence_token"])
            self.job["progress"] = json.loads(progress)
        else:
            raise AssertionError(f"unexpected SQL: {sql}")
        return SimpleNamespace(fetchone=lambda: row)


@pytest.fixture
def case():
    database = HeartbeatDatabase()
    worker = Worker.__new__(Worker)
    worker.db = database
    worker.settings = SimpleNamespace(job_lease_seconds=9)
    claim = Claim(copy.deepcopy(database.job), database.attempt["id"], 3,
                  progress={"bars_done": 8, "bars_total": 20})
    return SimpleNamespace(db=database, worker=worker, claim=claim)


@pytest.mark.parametrize("cancel", [False, True])
def test_job_then_live_attempt_then_progress_with_current_cancel(case, cancel):
    case.db.job["cancel_requested"] = cancel
    case.claim.job.update(cancel_requested=not cancel, state="stale-cache", fence_token=-1)
    case.worker._heartbeat(case.claim)
    assert [sql.split()[0:2] for sql, _ in case.db.statements] == [
        ["SELECT", "state,"], ["UPDATE", "job_attempts"], ["UPDATE", "jobs"]]
    assert case.db.statements[0] == (JOB_LOCK, (case.claim.job["id"],))
    assert case.db.statements[1][1] == (9, case.claim.attempt_id, case.claim.job["id"], 3)
    assert case.claim.cancel_requested is cancel and not case.claim.lost
    assert case.db.job["progress"] == case.claim.progress
    assert case.db.attempt["lease_expires_at"] - case.db.attempt["heartbeat_at"] == timedelta(
        seconds=9)
    assert case.db.commits == 1 and case.db.rollbacks == 0


@pytest.mark.parametrize("state", ["queued", "finalizing", "stopping", "settled"])
def test_non_running_current_job_loses_without_attempt_or_progress_update(case, state):
    case.db.job["state"] = state
    before = copy.deepcopy((case.db.job, case.db.attempt))
    case.worker._heartbeat(case.claim)
    assert case.claim.lost
    assert len(case.db.statements) == 1
    assert (case.db.job, case.db.attempt) == before


@pytest.mark.parametrize("missing", [False, True])
def test_missing_or_fenced_current_job_loses_before_attempt_update(case, missing):
    if missing:
        case.db.job = None
    else:
        case.db.job["fence_token"] += 1
    before = copy.deepcopy((case.db.job, case.db.attempt))
    case.worker._heartbeat(case.claim)
    assert case.claim.lost
    assert len(case.db.statements) == 1
    assert (case.db.job, case.db.attempt) == before


@pytest.mark.parametrize("invalid", ["missing", "id", "job_id", "fence_token", "ended_at"])
def test_only_matching_live_attempt_can_renew_or_publish_progress(case, invalid):
    if invalid == "missing":
        case.db.attempt = None
    else:
        case.db.attempt[invalid] = {"id": uuid4(), "job_id": uuid4(),
                                    "fence_token": 2, "ended_at": STAMP}[invalid]
    case.db.job["cancel_requested"] = True
    before = copy.deepcopy((case.db.job, case.db.attempt))
    case.worker._heartbeat(case.claim)
    assert case.claim.lost and not case.claim.cancel_requested
    assert len(case.db.statements) == 2
    assert (case.db.job, case.db.attempt) == before


@pytest.mark.parametrize("expires_in", [-30, 0, 30])
def test_expired_but_unreaped_live_attempt_keeps_renewal_semantics(case, expires_in):
    case.db.attempt["lease_expires_at"] = STAMP + timedelta(seconds=expires_in)
    case.worker._heartbeat(case.claim)
    assert not case.claim.lost
    sql = case.db.statements[1][0]
    assert "lease_expires_at" not in sql.split("WHERE", 1)[1]
    assert case.db.attempt["lease_expires_at"] == STAMP + timedelta(seconds=9)


@pytest.mark.parametrize("failure", ["SELECT state", "UPDATE job_attempts", "UPDATE jobs"])
def test_database_error_propagates_and_rolls_back_pending_heartbeat_writes(case, failure):
    case.db.fail_at = failure
    before = copy.deepcopy((case.db.job, case.db.attempt))
    with pytest.raises(RuntimeError, match="mock database failure"):
        case.worker._heartbeat(case.claim)
    assert (case.db.job, case.db.attempt) == before
    assert case.db.commits == 0 and case.db.rollbacks == 1
    assert not case.claim.lost


@pytest.mark.parametrize("seconds, interval", [(9, 3), (0.3, 0.2)])
def test_heartbeat_loop_keeps_existing_interval_and_stop_contract(case, seconds, interval):
    case.worker.settings.job_lease_seconds = seconds
    stop = SimpleNamespace(wait=Mock(side_effect=[False, True]))
    case.worker._heartbeat_loop(case.claim, stop)
    assert stop.wait.call_args_list == [((interval,),), ((interval,),)]
    assert case.db.commits == 1


def test_heartbeat_loop_stops_when_current_job_is_lost(case):
    case.db.job["fence_token"] += 1
    stop = SimpleNamespace(wait=Mock(return_value=False))
    case.worker._heartbeat_loop(case.claim, stop)
    stop.wait.assert_called_once_with(3)
    assert case.claim.lost and len(case.db.statements) == 1


def test_heartbeat_loop_logs_transient_error_and_can_renew_next_interval(case, caplog):
    case.db.fail_at = "UPDATE job_attempts"

    def wait(interval):
        assert interval == 3
        if case.db.rollbacks:
            case.db.fail_at = None
        return bool(case.db.commits)

    case.worker._heartbeat_loop(case.claim, SimpleNamespace(wait=wait))
    assert case.db.rollbacks == case.db.commits == 1
    assert not case.claim.lost
    assert "heartbeat failed for job" in caplog.text
