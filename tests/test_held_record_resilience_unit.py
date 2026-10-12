"""Offline held-record progression: transactions and every ledger boundary are doubles."""

import copy
import json
import logging
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import pytest
from veyra_api import settlement
from veyra_billing import RATE_CARD_V1
from veyra_scheduler import reaper
from veyra_scheduler import worker as worker_module
from veyra_scheduler.worker import Claim, LeaseLost, Worker

STAMP = datetime(2026, 1, 1, tzinfo=UTC)


def record(number, *, used=True):
    job_id, org, version, auth_id, quote_id, attempt = [
        UUID(int=number * 10 + index) for index in range(1, 7)]
    request = {"project_version_id": str(version), "resource_class": "small"}
    return {
        "job": {"id": job_id, "org_id": org, "authorization_id": auth_id,
                "project_version_id": version, "state": "running", "fence_token": 1,
                "version": 1, "created_at": STAMP + timedelta(seconds=number),
                "config": request | {"quote_id": str(quote_id), "input_hash": "approved",
                                     "rate_version": RATE_CARD_V1.version}},
        "auth": {"id": auth_id, "quote_id": quote_id, "org_id": org,
                 "status": "reserved", "input_hash": "approved", "reserved_nano": 5000000,
                 "created_at": STAMP + timedelta(seconds=number)},
        "quote": {"id": quote_id, "org_id": org, "project_version_id": version,
                  "request": request, "input_hash": "approved", "customer_max_nano": 5000000,
                  "rate_version": RATE_CARD_V1.version},
        "attempt": {"id": attempt, "job_id": job_id, "fence_token": 1,
                    "lease_expires_at": STAMP - timedelta(seconds=1), "started_at": STAMP,
                    "heartbeat_at": STAMP + timedelta(seconds=2.2),
                    "ended_at": None, "billed_seconds": None},
        "usage": [], "outbox": [], "postings": [], "used": used,
    }


class MemoryDatabase:
    """Small transactional SQL double; this is not PostgreSQL rollback/race proof."""

    def __init__(self, rows):
        self.rows = copy.deepcopy(rows)
        self.pending = None
        self.events = []
        self.statements = []
        self.selected = []
        self.current = None

    @contextmanager
    def tx(self):
        assert self.pending is None
        self.pending = copy.deepcopy(self.rows)
        self.current = None
        try:
            yield self
        except BaseException as exc:
            self.events.append(("rollback", self.current, type(exc)))
            raise
        else:
            self.rows = self.pending
            self.events.append(("commit", self.current, None))
        finally:
            self.pending = None

    def find(self, field, value):
        return next(row for row in self.pending if row[field]["id"] == value)

    def execute(self, sql, params=()):
        assert self.pending is not None
        self.statements.append((sql, copy.deepcopy(params)))
        one, many = None, []
        if sql.startswith(("SELECT j.*", "SELECT a.*")):
            active = sql.startswith("SELECT j.*")
            field = "job" if active else "auth"
            visited = params[0 if active else 1]
            after = params[1 if active else 2:]
            if after:
                assert f"({field[0] if active else 'a'}.created_at, " in sql
            candidates = [r for r in self.pending if r[field]["id"] not in visited
                          and (not after or (r[field]["created_at"], r[field]["id"]) > after)
                          and ((r["used"] and r["job"]["state"] == "running"
                                and r["attempt"]["ended_at"] is None) if active else
                               (not r["used"] and r["auth"]["status"] == "reserved"))]
            if candidates:
                r = min(candidates, key=lambda r: (r[field]["created_at"], r[field]["id"]))
                one = r[field]
                if active:
                    one = one | {"attempt_id": r["attempt"]["id"],
                                 "started_at": r["attempt"]["started_at"],
                                 "heartbeat_at": r["attempt"]["heartbeat_at"]}
                self.current = one["id"]
                self.selected.append(self.current)
        elif sql.startswith("SELECT id, started_at, heartbeat_at FROM job_attempts"):
            assert sql == (
                "SELECT id, started_at, heartbeat_at FROM job_attempts "
                "WHERE id = %s AND job_id = %s AND fence_token = %s "
                "AND ended_at IS NULL AND lease_expires_at < now()")
            attempt_id, job_id, fence = params
            one = next((row["attempt"] for row in self.pending if row["attempt"]
                        and row["attempt"]["id"] == attempt_id
                        and row["attempt"]["job_id"] == job_id
                        and row["attempt"]["fence_token"] == fence
                        and row["attempt"]["ended_at"] is None
                        and row["attempt"]["lease_expires_at"] < STAMP), None)
        elif sql.startswith("SELECT * FROM jobs"):
            one = self.find("job", params[0])["job"]
            self.current = one["id"]
        elif sql.startswith("SELECT * FROM authorizations"):
            one = self.find("auth", params[0])["auth"]
        elif sql.startswith("SELECT q.* FROM quotes"):
            one = self.find("quote", params[0])["quote"]
        elif sql.startswith("SELECT 1 FROM jobs"):
            one = {} if self.find("auth", params[0])["used"] else None
        elif sql.startswith("SELECT clock_timestamp() >="):
            one = {"expired": True}
        elif sql.startswith("SELECT * FROM usage_events"):
            many = self.find("job", params[0])["usage"]
        elif sql.startswith("UPDATE jobs SET fence_token"):
            self.find("job", params[0])["job"]["fence_token"] += 1
        elif sql.startswith("UPDATE job_attempts"):
            row = self.find("attempt", params[-1])["attempt"]
            row["ended_at"] = STAMP
            row["billed_seconds"] = params[-2]
        elif sql.startswith("INSERT INTO usage_events"):
            self.find("job", params[1])["usage"].append({
                "org_id": params[0], "job_id": params[1], "supplier": params[3],
                "meter": "compute", "units": params[4], "unit": "task-second",
                "supplier_cost_nano": params[5], "rate_version": params[6],
                "detail": json.loads(params[7])})
        elif sql.startswith("UPDATE authorizations SET status"):
            self.find("auth", params[0])["auth"]["status"] = "settled"
        elif sql.startswith("UPDATE jobs SET state"):
            self.find("job", params[-1])["job"]["state"] = "settled"
        elif sql.startswith("INSERT INTO outbox"):
            self.find("job", params[1])["outbox"].append(params)
        else:
            raise AssertionError(f"unexpected SQL: {sql}")
        return SimpleNamespace(fetchone=lambda: one, fetchall=lambda: many)


@pytest.fixture
def ledger(monkeypatch):
    def post(conn, org, auth_id, **amounts):
        conn.find("auth", auth_id)["postings"].append(amounts)
    spy = Mock(side_effect=post)
    monkeypatch.setattr(settlement.ledger, "settle", spy)
    return spy


def hold(row, kind):
    if kind == "usage":
        row["usage"].append({"org_id": row["job"]["org_id"], "rate_version": "secret-rate",
                             "supplier_cost_nano": 1})
    elif kind == "ceiling":
        row["auth"]["reserved_nano"] += 1
    else:
        row["job"]["config"][kind] = "secret-unknown-value"


@pytest.mark.parametrize("path", ["active", "unused"])
def test_interleaved_held_records_rollback_individually_and_healthy_commit(ledger, path, caplog):
    rows = [record(i, used=path == "active") for i in range(1, 6)]
    for index in (0, 2, 4):
        hold(rows[index], "usage" if path == "active" else "ceiling")
    db = MemoryDatabase(rows)
    reap = reaper.reap_expired if path == "active" else reaper.reap_unused_authorizations
    field = "job" if path == "active" else "auth"
    with caplog.at_level(logging.ERROR):
        result = reap(db)
    assert result == [str(rows[index][field]["id"]) for index in (1, 3)]
    assert db.selected == [row[field]["id"] for row in rows]
    for index in (0, 2, 4):
        assert db.rows[index] == rows[index]
    assert ledger.call_count == 2
    for index in (1, 3):
        assert db.rows[index]["auth"]["status"] == "settled"
        assert len(db.rows[index]["postings"]) == 1
    assert [event[0] for event in db.events] == [
        "rollback", "commit", "rollback", "commit", "rollback", "commit"]
    assert all(event[2] is settlement.SettlementIntegrityError for event in db.events
               if event[0] == "rollback")
    assert len(caplog.records) == 3
    for entry in caplog.records:
        assert entry.exc_info is entry.stack_info is None
        assert entry.getMessage().endswith("(SettlementIntegrityError); operator review required")
    assert "secret" not in caplog.text
    assert reap(db) == []
    assert ledger.call_count == 2


@pytest.mark.parametrize("path", ["active", "unused"])
def test_cursor_advances_past_more_than_a_full_held_batch_and_wraps(ledger, path):
    rows = [record(i, used=path == "active") for i in range(1, 103)]
    for row in rows[:-1]:
        hold(row, "ceiling")
    db, cursor = MemoryDatabase(rows), reaper.ReapCursor()
    reap = reaper.reap_expired if path == "active" else reaper.reap_unused_authorizations
    field = "job" if path == "active" else "auth"
    assert reap(db, cursor=cursor) == []
    assert len(db.selected) == 100
    assert cursor.after == (rows[99][field]["created_at"], rows[99][field]["id"])
    assert reap(db, cursor=cursor) == [str(rows[-1][field]["id"])]
    assert cursor.after is None
    assert ledger.call_count == 1
    assert db.rows[:-1] == rows[:-1]
    assert reap(db, batch_size=1, cursor=cursor) == []
    assert db.selected[-1] == rows[0][field]["id"]
    assert ledger.call_count == 1


@pytest.mark.parametrize("reap,used", [(reaper.reap_expired, True),
                                       (reaper.reap_unused_authorizations, False)])
def test_all_held_batch_terminates_and_new_cursor_restarts_without_mutation(ledger, reap, used):
    rows = [record(i, used=used) for i in range(1, 4)]
    for row in rows:
        hold(row, "ceiling")
    db = MemoryDatabase(rows)
    for _ in range(2):
        cursor = reaper.ReapCursor()
        assert reap(db, cursor=cursor) == []
        assert cursor.after is None
    assert len(db.selected) == 6
    assert len(db.events) == 8
    assert db.rows == rows
    ledger.assert_not_called()


@pytest.mark.parametrize("field", ["rate_version", "resource_class"])
@pytest.mark.parametrize("matching_quote", [False, True])
def test_unknown_billing_metadata_is_held_before_any_write(ledger, field, matching_quote):
    row = record(1)
    hold(row, field)
    if matching_quote:
        target = row["quote"] if field == "rate_version" else row["quote"]["request"]
        target[field] = row["job"]["config"][field]
    db = MemoryDatabase([row])
    assert reaper.reap_expired(db) == []
    assert db.rows == [row]
    assert all(sql.startswith("SELECT ") for sql, _ in db.statements)
    ledger.assert_not_called()


@pytest.mark.parametrize("path", ["active", "unused"])
@pytest.mark.parametrize("error", [KeyError, ValueError, RuntimeError,
                                   KeyboardInterrupt, SystemExit, GeneratorExit])
def test_unexpected_faults_surface_and_do_not_advance_cursor(ledger, monkeypatch, path, error):
    rows = [record(i, used=path == "active") for i in range(1, 4)]
    db, cursor = MemoryDatabase(rows), reaper.ReapCursor()
    target = "_approved_rates" if path == "active" else "release_expired_unused"
    original = getattr(reaper, target)
    calls = 0

    def fail_second(*args):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise error("private error text")
        return original(*args)

    monkeypatch.setattr(reaper, target, fail_second)
    reap = reaper.reap_expired if path == "active" else reaper.reap_unused_authorizations
    with pytest.raises(error):
        reap(db, cursor=cursor)
    field = "job" if path == "active" else "auth"
    assert cursor.after == (rows[0][field]["created_at"], rows[0][field]["id"])
    assert db.rows[1:] == rows[1:]
    assert db.rows[0]["auth"]["status"] == "settled"
    assert db.events[-1][0] == "rollback"
    assert ledger.call_count == 1
    monkeypatch.setattr(reaper, target, original)
    assert reap(db, cursor=cursor) == [str(row[field]["id"]) for row in rows[1:]]
    assert ledger.call_count == 3


@pytest.mark.parametrize("reap", [reaper.reap_expired, reaper.reap_unused_authorizations])
@pytest.mark.parametrize("batch_size", [0, -1, 101, True, False, 1.0, "2", None])
def test_invalid_batch_rejected_before_any_transaction(reap, batch_size):
    db = Mock()
    with pytest.raises(ValueError, match="between 1 and 100"):
        reap(db, batch_size=batch_size)
    db.tx.assert_not_called()


class StopLoop(BaseException):
    pass


def finishing_worker(db):
    worker = Worker.__new__(Worker)
    worker.db, worker.worker_id = db, "fixture-worker"
    worker._write_report = Mock(side_effect=AssertionError("no report writes"))
    worker.execute = Mock(side_effect=lambda claim: worker._finish(
        claim, "failed", "mocked execution", 0, None, {}, []))
    return worker


@pytest.mark.parametrize("kind", ["ceiling", "usage", "rate_version", "resource_class"])
def test_worker_continues_to_next_claim_after_held_finish_rolls_back(
        ledger, monkeypatch, caplog, kind):
    rows = [record(1), record(2)]
    hold(rows[0], kind)
    db, claims = MemoryDatabase(rows), [
        Claim(copy.deepcopy(row["job"]), row["attempt"]["id"], 1) for row in rows]
    worker = finishing_worker(db)
    worker.claim = Mock(side_effect=[*claims, None])
    monkeypatch.setattr(worker_module.time, "sleep", Mock(side_effect=StopLoop))
    with caplog.at_level(logging.ERROR), pytest.raises(StopLoop):
        worker.run_forever()
    assert db.rows[0] == rows[0]
    assert db.rows[1]["job"]["state"] == "settled"
    assert worker.claim.call_count == 3
    assert worker.execute.call_count == 2
    assert [event[0] for event in db.events] == ["rollback", "commit"]
    ledger.assert_called_once()
    entry, = caplog.records
    assert entry.getMessage() == (
        f"worker finish held job {rows[0]['job']['id']} "
        "(SettlementIntegrityError); operator review required")
    assert entry.exc_info is entry.stack_info is None
    assert "secret" not in caplog.text


@pytest.mark.parametrize("error", [KeyError, ValueError, RuntimeError,
                                   KeyboardInterrupt, SystemExit, GeneratorExit])
def test_worker_unexpected_finish_failures_still_surface(ledger, monkeypatch, error):
    row, db = record(1), MemoryDatabase([record(1)])
    worker = finishing_worker(db)
    worker.claim = Mock(return_value=Claim(row["job"], row["attempt"]["id"], 1))
    monkeypatch.setattr(worker_module, "record_compute_usage", Mock(side_effect=error))
    with pytest.raises(error):
        worker.run_once()
    assert db.rows == [row]
    assert db.events[-1] == ("rollback", row["job"]["id"], error)
    ledger.assert_not_called()


def test_fencing_still_precedes_auth_lock_or_guard(ledger, monkeypatch):
    row = record(1)
    db = MemoryDatabase([row])
    worker = finishing_worker(db)
    guarded = Mock(side_effect=AssertionError("fenced claim must not read auth"))
    monkeypatch.setattr(worker_module, "_approved_rates", guarded)
    with pytest.raises(LeaseLost):
        worker._finish(Claim(row["job"], row["attempt"]["id"], 0),
                       "failed", None, 0, None, {}, [])
    assert len(db.statements) == 1
    guarded.assert_not_called()
    ledger.assert_not_called()


def test_healthy_reaper_retains_heartbeat_billing_and_job_auth_attempt_lock_order(ledger):
    row = record(1)
    db = MemoryDatabase([row])
    assert reaper.reap_expired(db, batch_size=1) == [str(row["job"]["id"])]
    sql = [query for query, _ in db.statements]
    assert "FOR UPDATE OF j SKIP LOCKED" in sql[0]
    assert "a.ended_at IS NULL AND a.lease_expires_at < now()" in sql[0]
    assert "a.fence_token = j.fence_token" in sql[0]
    assert sql[1].startswith("SELECT id, started_at, heartbeat_at FROM job_attempts")
    assert "FOR UPDATE" not in sql[1]
    assert db.statements[1][1] == (row["attempt"]["id"], row["job"]["id"], 1)
    assert sql[2] == "SELECT * FROM authorizations WHERE id = %s FOR UPDATE"
    assert sql[3].startswith("SELECT q.*") and "FOR UPDATE" not in sql[3]
    assert sql[4].startswith("UPDATE jobs SET fence_token")
    assert sql[5].startswith("UPDATE job_attempts")
    assert db.rows[0]["job"]["fence_token"] == 2
    assert db.rows[0]["attempt"]["billed_seconds"] == (
        3 + RATE_CARD_V1.startup_overhead_seconds)
    assert len(db.rows[0]["usage"]) == len(db.rows[0]["outbox"]) == 1
    ledger.assert_called_once()


@pytest.mark.parametrize("config", [None, [], {}, "private-malformed", {"rate_version": []}])
@pytest.mark.parametrize("path", ["worker", "reaper"])
def test_malformed_persisted_billing_config_is_held_without_ledger_or_writes(ledger, config, path):
    row = record(1)
    row["job"]["config"] = config
    db = MemoryDatabase([row])
    if path == "worker":
        worker = finishing_worker(db)
        worker.claim = Mock(return_value=Claim(row["job"], row["attempt"]["id"], 1))
        assert worker.run_once()
    else:
        assert reaper.reap_expired(db) == []
    assert db.rows == [row]
    assert all(sql.startswith("SELECT ") for sql, _ in db.statements)
    ledger.assert_not_called()


@pytest.mark.parametrize("path", ["worker", "active", "unused"])
def test_integrity_log_is_emitted_only_after_transaction_has_exited(ledger, monkeypatch, path):
    row = record(1, used=path != "unused")
    hold(row, "ceiling")
    db = MemoryDatabase([row])
    observed = []

    def log_after_rollback(*args):
        assert db.pending is None
        assert db.events[-1][0] == "rollback"
        observed.append(args)

    target = worker_module if path == "worker" else reaper
    monkeypatch.setattr(target.log, "error", log_after_rollback)
    if path == "worker":
        worker = finishing_worker(db)
        worker.claim = Mock(return_value=Claim(row["job"], row["attempt"]["id"], 1))
        assert worker.run_once()
    else:
        reap = reaper.reap_expired if path == "active" else reaper.reap_unused_authorizations
        assert reap(db, batch_size=1) == []
    assert len(observed) == 1
    ledger.assert_not_called()


@pytest.mark.parametrize("reap", [reaper.reap_expired, reaper.reap_unused_authorizations])
def test_integrity_error_without_selected_record_is_not_hidden(monkeypatch, reap):
    db = Mock()
    db.tx.side_effect = settlement.SettlementIntegrityError("not a selected record")
    logger = Mock()
    monkeypatch.setattr(reaper.log, "error", logger)
    with pytest.raises(settlement.SettlementIntegrityError):
        reap(db)
    logger.assert_not_called()
