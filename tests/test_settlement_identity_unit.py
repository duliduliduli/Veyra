"""Source-only settlement checks: every SQL/ledger boundary is intercepted."""

import copy
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock
from uuid import uuid4

import pytest
from veyra_api import api_jobs, reservations, settlement
from veyra_billing import RATE_CARD_V1
from veyra_scheduler.reaper import reap_expired, reap_unused_authorizations
from veyra_scheduler.worker import Claim, Worker


@pytest.fixture
def case(monkeypatch):
    org, version, project, quote, auth, job = [uuid4() for _ in range(6)]
    request = {"project_version_id": str(version), "resource_class": "small",
               "params": {}, "starting_cash": "10000", "max_runtime_seconds": 60,
               "taker_fee_bps": "10", "slippage_bps": "5"}
    cfg = copy.deepcopy(request) | {"quote_id": str(quote), "input_hash": "approved",
                                    "rate_version": RATE_CARD_V1.version, "engine": "fixture"}
    state = SimpleNamespace(
        job={"id": job, "org_id": org, "project_version_id": version,
             "authorization_id": auth, "config": cfg, "state": "running", "version": 1,
             "fence_token": 1, "created_at": datetime(2026, 1, 1, tzinfo=UTC)},
        auth={"id": auth, "org_id": org, "quote_id": quote, "input_hash": "approved",
              "reserved_nano": 5000000, "status": "reserved",
              "created_at": datetime(2026, 1, 1, tzinfo=UTC)},
        quote={"id": quote, "org_id": org, "project_version_id": version,
               "input_hash": "approved", "request": request,
               "rate_version": RATE_CARD_V1.version, "customer_max_nano": 5000000},
        version={"id": version, "org_id": org, "project_id": project},
        project={"id": project, "org_id": org}, usage=[], statements=[])

    def query(sql, params=()):
        state.statements.append((sql, params))
        row, rows = None, []
        if "SELECT q.* FROM quotes q JOIN project_versions v" in sql:
            assert "ON v.id = q.project_version_id AND v.org_id = q.org_id" in sql
            assert "JOIN projects p ON p.id = v.project_id AND p.org_id = q.org_id" in sql
            if (state.quote and state.version and state.project
                    and state.quote["project_version_id"] == state.version["id"]
                    and state.quote["org_id"] == state.version["org_id"]
                    and state.version["project_id"] == state.project["id"]
                    and state.quote["org_id"] == state.project["org_id"]):
                row = state.quote
        elif sql.startswith("SELECT * FROM authorizations"):
            row = state.auth
        elif sql.startswith("SELECT a.* FROM authorizations a WHERE"):
            row = state.auth if state.auth["id"] not in params[1] else None
        elif sql.startswith("SELECT 1 FROM jobs WHERE authorization_id"):
            row = None
        elif sql.startswith("SELECT clock_timestamp() >="):
            row = {"expired": True}
        elif sql.startswith(("SELECT * FROM jobs", "SELECT state, fence_token FROM jobs")):
            row = state.job
        elif sql.startswith("SELECT * FROM usage_events"):
            rows = state.usage
        elif sql.startswith("SELECT j.*"):
            now = datetime(2026, 1, 1, tzinfo=UTC)
            row = (state.job | {"attempt_id": uuid4(), "started_at": now,
                                "heartbeat_at": now + timedelta(seconds=2)}
                   if job not in params[0] else None)
        elif sql.startswith("SELECT id, started_at, heartbeat_at FROM job_attempts"):
            now = datetime(2026, 1, 1, tzinfo=UTC)
            row = {"id": params[0], "started_at": now,
                   "heartbeat_at": now + timedelta(seconds=2)}
        elif sql.startswith("INSERT INTO usage_events"):
            state.usage.append({"org_id": params[0], "job_id": params[1],
                                "supplier": params[3], "meter": "compute", "units": params[4],
                                "unit": "task-second", "supplier_cost_nano": params[5],
                                "rate_version": params[6], "detail": json.loads(params[7])})
        elif not sql.startswith(("UPDATE ", "INSERT INTO outbox")):
            raise AssertionError(f"Unexpected SQL: {sql}")
        return SimpleNamespace(fetchone=lambda: row, fetchall=lambda: rows)

    state.conn = Mock()
    state.conn.execute.side_effect = query
    state.db = MagicMock()
    state.db.tx.return_value.__enter__.return_value = state.conn
    state.db.tx.return_value.__exit__.return_value = False
    state.ledger = Mock()
    monkeypatch.setattr(settlement.ledger, "settle", state.ledger)
    state.worker = Worker.__new__(Worker)
    state.worker.db, state.worker.worker_id = state.db, "mock-worker"
    state.worker._write_report = Mock(side_effect=AssertionError("no object writes"))
    state.claim = Claim(copy.deepcopy(state.job), uuid4(), 1)
    return state


@pytest.mark.parametrize("target,key,value", [
    ("job", "org_id", uuid4()), ("auth", "org_id", uuid4()),
    ("quote", "org_id", uuid4()), ("version", "org_id", uuid4()),
    ("project", "org_id", uuid4()), ("version", "project_id", uuid4()),
    ("job", "authorization_id", uuid4()), ("auth", "quote_id", uuid4()),
    ("job", "project_version_id", uuid4()), ("quote", "project_version_id", uuid4()),
    ("auth", "reserved_nano", 5000001), ("auth", "reserved_nano", 4999999),
    ("auth", "reserved_nano", 0), ("auth", "reserved_nano", True),
    ("auth", "reserved_nano", "5000000"), ("quote", "customer_max_nano", 5000001),
    ("quote", "customer_max_nano", 5000000.0), ("auth", "status", "settled"),
    ("auth", "input_hash", "changed"), ("quote", "input_hash", "changed"),
    ("auth", "input_hash", None), ("quote", "rate_version", "unknown"),
])
def test_financial_identity_drift_fails_before_usage_read_or_mutation(
        case, monkeypatch, target, key, value):
    getattr(case, target)[key] = value
    amounts = Mock(side_effect=AssertionError("must not calculate settlement"))
    monkeypatch.setattr(settlement, "settle_amounts", amounts)
    with pytest.raises(settlement.SettlementIntegrityError, match="operator review"):
        settlement.settle_job(case.conn, case.job["id"], "failed")
    amounts.assert_not_called()
    case.ledger.assert_not_called()
    assert all(sql.startswith("SELECT ") for sql, _ in case.statements)
    assert not any("FROM usage_events" in sql for sql, _ in case.statements)


@pytest.mark.parametrize("key,value", [
    ("quote_id", str(uuid4())), ("project_version_id", str(uuid4())),
    ("input_hash", "changed"), ("rate_version", "unknown"),
    ("resource_class", "large"), ("resource_class", "unknown"),
    ("resource_class", []),
])
def test_job_billing_config_drift_requires_operator_review(case, key, value):
    case.job["config"][key] = value
    with pytest.raises(settlement.SettlementIntegrityError):
        settlement.settle_job(case.conn, case.job["id"], "failed")
    case.ledger.assert_not_called()


@pytest.mark.parametrize("target", ["auth", "quote", "version", "project"])
def test_missing_approval_chain_row_fails_closed(case, target):
    setattr(case, target, None)
    with pytest.raises(settlement.SettlementIntegrityError):
        settlement.settle_job(case.conn, case.job["id"], "failed")
    case.ledger.assert_not_called()


@pytest.mark.parametrize("value", [None, [], {}, "broken"])
def test_malformed_billing_config_is_a_controlled_failure(case, value):
    case.job["config"] = value
    with pytest.raises(settlement.SettlementIntegrityError):
        settlement.settle_job(case.conn, case.job["id"], "failed")
    case.ledger.assert_not_called()


def test_replacement_authorization_cannot_release_another_valid_reservation(case):
    case.auth.update(id=uuid4(), quote_id=uuid4())
    case.job["authorization_id"] = case.auth["id"]
    case.quote["id"] = case.auth["quote_id"]
    with pytest.raises(settlement.SettlementIntegrityError):
        settlement.settle_job(case.conn, case.job["id"], "failed")
    case.ledger.assert_not_called()


def test_known_substitute_rate_is_not_a_fallback(case, monkeypatch):
    monkeypatch.setitem(settlement.RATE_CARDS, "other-version", RATE_CARD_V1)
    case.job["config"]["rate_version"] = "other-version"
    with pytest.raises(settlement.SettlementIntegrityError):
        settlement.settle_job(case.conn, case.job["id"], "failed")
    case.ledger.assert_not_called()


@pytest.mark.parametrize("field", ["rate_version", "resource_class"])
def test_matching_unknown_billing_metadata_still_fails_closed(case, field):
    case.job["config"][field] = "unknown"
    (case.quote if field == "rate_version" else case.quote["request"])[field] = "unknown"
    with pytest.raises(settlement.SettlementIntegrityError):
        settlement.settle_job(case.conn, case.job["id"], "failed")
    case.ledger.assert_not_called()


@pytest.mark.parametrize("key,value", [
    ("params", {"corrupt": True}), ("starting_cash", None), ("taker_fee_bps", {}),
    ("slippage_bps", []), ("max_runtime_seconds", "broken"), ("engine", "old"),
])
def test_runtime_only_failure_can_zero_settle_intact_reservation(case, key, value):
    case.job["config"][key] = value
    case.claim.job["config"][key] = value
    case.worker._finish(case.claim, "failed", "preflight rejected inputs", 0, None, {}, [])
    case.ledger.assert_called_once_with(case.conn, case.job["org_id"], case.auth["id"],
                                       charge=0, supplier=0, fee=0, overrun=0, release=5000000)
    case.db.tx.return_value.__exit__.assert_called_once_with(None, None, None)
    assert len(case.usage) == 1 and case.usage[0]["supplier_cost_nano"] == 0


@pytest.mark.parametrize("outcome", ["completed", "incomplete", "cancelled", "failed"])
@pytest.mark.parametrize("cost", [0, 1000, 6000000])
def test_valid_settlement_keeps_receipt_and_capped_billing(case, outcome, cost):
    case.usage = [{"org_id": case.job["org_id"], "rate_version": RATE_CARD_V1.version,
                   "supplier_cost_nano": cost, "supplier": "fixture", "meter": "compute",
                   "units": 1, "unit": "task-second", "detail": {}}]
    receipt = settlement.settle_job(case.conn, case.job["id"], outcome)
    assert receipt["supplier_cost_nano"] == cost
    assert receipt["authorized_max_nano"] == 5000000
    assert receipt["customer_charge_nano"] + receipt["released_nano"] == 5000000
    case.ledger.assert_called_once()
    locked = [sql for sql, _ in case.statements if "FOR UPDATE" in sql]
    assert locked == ["SELECT * FROM jobs WHERE id = %s FOR UPDATE",
                      "SELECT * FROM authorizations WHERE id = %s FOR UPDATE"]


def test_already_settled_job_returns_before_corrupt_authorization_read(case):
    case.job.update(state="settled", config=None, authorization_id=None)
    assert settlement.settle_job(case.conn, case.job["id"], "failed") is None
    assert len(case.statements) == 1
    case.ledger.assert_not_called()


@pytest.mark.parametrize("field,value", [("org_id", uuid4()), ("rate_version", "other")])
def test_usage_identity_drift_fails_before_financial_mutation(case, field, value):
    case.usage = [{"org_id": case.job["org_id"], "rate_version": RATE_CARD_V1.version,
                   "supplier_cost_nano": 100} | {field: value}]
    with pytest.raises(settlement.SettlementIntegrityError, match="usage identity"):
        settlement.settle_job(case.conn, case.job["id"], "completed")
    case.ledger.assert_not_called()
    assert all(sql.startswith("SELECT ") for sql, _ in case.statements)


@pytest.mark.parametrize("caller", ["worker", "cancel"])
def test_all_callers_propagate_integrity_failure_out_of_the_transaction(case, monkeypatch, caller):
    case.auth["reserved_nano"] += 1
    with pytest.raises(settlement.SettlementIntegrityError):
        if caller == "worker":
            case.worker._finish(case.claim, "failed", "preflight rejected", 0, None, {}, [])
        else:
            case.job["state"] = "queued"
            monkeypatch.setattr(api_jobs, "_load_job", Mock(return_value=case.job))
            api_jobs.cancel_job(case.job["id"], p=Mock(), database=case.db)
    case.ledger.assert_not_called()
    assert case.db.tx.return_value.__exit__.call_args.args[0] is settlement.SettlementIntegrityError
    assert not any(sql.startswith(("UPDATE authorizations", "UPDATE jobs SET state",
                                   "INSERT INTO outbox")) for sql, _ in case.statements)
    assert case.usage == []


@pytest.mark.parametrize("target,key,value", [
    ("auth", "org_id", uuid4()), ("quote", "org_id", uuid4()),
    ("version", "org_id", uuid4()), ("project", "org_id", uuid4()),
    ("auth", "quote_id", uuid4()), ("quote", "project_version_id", uuid4()),
    ("auth", "reserved_nano", 5000001), ("auth", "reserved_nano", 4999999),
    ("quote", "customer_max_nano", 5000001), ("auth", "input_hash", "changed"),
    ("quote", "input_hash", "changed"),
])
def test_unused_release_rejects_inconsistent_original_approval(case, target, key, value):
    getattr(case, target)[key] = value
    with pytest.raises(settlement.SettlementIntegrityError, match="operator review"):
        reservations.release_expired_unused(case.conn, case.auth)
    case.ledger.assert_not_called()
    assert all(sql.startswith("SELECT ") for sql, _ in case.statements)
    assert case.statements[0][0] == "SELECT 1 FROM jobs WHERE authorization_id = %s"
    assert case.statements[1][0].startswith("SELECT clock_timestamp() >=")


def test_unused_refund_does_not_require_an_available_rate_card_or_resource_class(case):
    case.quote["rate_version"] = "retired"
    case.quote["request"]["resource_class"] = "retired"
    assert reservations.release_expired_unused(case.conn, case.auth)
    case.ledger.assert_called_once_with(case.conn, case.auth["org_id"], case.auth["id"],
                                       charge=0, supplier=0, fee=0, overrun=0, release=5000000)
    assert not any("FOR UPDATE" in sql for sql, _ in case.statements)


@pytest.mark.parametrize("reap", [reap_expired, reap_unused_authorizations])
def test_reapers_catch_integrity_only_after_rollback_without_closing_approval(case, reap):
    case.auth["reserved_nano"] += 1
    assert reap(case.db, batch_size=1) == []
    assert case.db.tx.return_value.__exit__.call_args.args[0] is settlement.SettlementIntegrityError
    case.ledger.assert_not_called()
    assert all(sql.startswith("SELECT ") for sql, _ in case.statements)

