"""Offline reservation contract checks. All database/ledger boundaries are doubles."""

from datetime import UTC, datetime, timedelta
from unittest.mock import ANY, MagicMock, Mock
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from veyra_api import api_jobs, reservations
from veyra_api.auth import Principal, authenticate
from veyra_api.settlement import SettlementIntegrityError
from veyra_scheduler import __main__ as scheduler
from veyra_scheduler.reaper import reap_unused_authorizations


@pytest.fixture
def auth():
    return {"id": uuid4(), "org_id": uuid4(), "quote_id": uuid4(), "input_hash": "fixture",
            "reserved_nano": 123456, "status": "reserved",
            "created_at": datetime(2026, 1, 1, tzinfo=UTC), "settled_at": None}


@pytest.fixture
def settle(monkeypatch):
    posting = Mock()
    monkeypatch.setattr(reservations.ledger, "settle", posting)
    return posting


def approved_quote(auth):
    version = uuid4()
    return {"id": auth["quote_id"], "org_id": auth["org_id"], "project_version_id": version,
            "input_hash": auth["input_hash"], "customer_max_nano": auth["reserved_nano"],
            "request": {"project_version_id": str(version)}}


def test_fixed_claim_deadline_is_derived_without_mutating_authorization(auth):
    before = auth.copy()
    assert reservations.claim_expires_at(auth) == datetime(2026, 1, 1, 0, 15, tzinfo=UTC)
    assert reservations.AUTHORIZATION_CLAIM_WINDOW == timedelta(minutes=15)
    assert auth == before


@pytest.mark.parametrize("state", ["queued", "running", "finalizing", "stopping", "settled"])
def test_every_existing_job_prevents_release_before_clock_or_ledger(auth, settle, state):
    conn = MagicMock()
    conn.execute.return_value.fetchone.return_value = {"state": state}
    assert not reservations.release_expired_unused(conn, auth)
    conn.execute.assert_called_once_with("SELECT 1 FROM jobs WHERE authorization_id = %s",
                                         (auth["id"],))
    settle.assert_not_called()


def test_already_closed_authorization_is_a_no_op(auth, settle):
    conn = Mock()
    assert not reservations.release_expired_unused(conn, auth | {"status": "settled"})
    conn.execute.assert_not_called()
    settle.assert_not_called()


@pytest.mark.parametrize("expired", [False, True])
def test_db_wall_clock_deadline_and_zero_charge_full_release(auth, settle, expired):
    conn = MagicMock()
    conn.execute.return_value.fetchone.side_effect = [None, {"expired": expired},
                                                     approved_quote(auth)]
    assert reservations.release_expired_unused(conn, auth) is expired
    calls = conn.execute.call_args_list
    assert calls[0].args[0] == "SELECT 1 FROM jobs WHERE authorization_id = %s"
    assert calls[1].args == ("SELECT clock_timestamp() >= %s AS expired",
                            (reservations.claim_expires_at(auth),))
    if expired:
        settle.assert_called_once_with(conn, auth["org_id"], auth["id"], charge=0,
                                       supplier=0, fee=0, overrun=0,
                                       release=auth["reserved_nano"])
        assert calls[2].args[0].startswith("SELECT q.* FROM quotes q JOIN project_versions")
        assert "FOR UPDATE" not in calls[2].args[0]
        assert calls[3].args == (
            "UPDATE authorizations SET status = 'settled', settled_at = now() WHERE id = %s",
            (auth["id"],))
    else:
        assert len(calls) == 2
        settle.assert_not_called()


def test_posting_failure_never_closes_authorization(auth, settle):
    conn = MagicMock()
    conn.execute.return_value.fetchone.side_effect = [None, {"expired": True}, approved_quote(auth)]
    settle.side_effect = RuntimeError("posting failed")
    with pytest.raises(RuntimeError, match="posting failed"):
        reservations.release_expired_unused(conn, auth)
    assert len(conn.execute.call_args_list) == 3


@pytest.fixture
def claim_api(monkeypatch):
    app = FastAPI()
    app.include_router(api_jobs.router)
    app.state.db = MagicMock()
    app.dependency_overrides[authenticate] = lambda: Principal(uuid4(), "owner@example.test")
    conn = app.state.db.tx.return_value.__enter__.return_value
    monkeypatch.setattr(api_jobs, "_job_view", lambda conn, job: job)
    return TestClient(app), app.state.db, conn


def post_job(client, auth):
    return client.post("/v1/jobs", json={"authorization_id": str(auth["id"])},
                       headers={"idempotency-key": "same-key-123"})


@pytest.mark.parametrize("state", ["queued", "running", "finalizing", "stopping", "settled"])
def test_old_idempotent_job_replay_wins_over_authorization_expiry(claim_api, auth, settle, state):
    client, database, conn = claim_api
    job = {"id": uuid4(), "authorization_id": auth["id"], "state": state}
    if state == "settled":
        auth["status"] = "settled"
    conn.execute.return_value.fetchone.side_effect = [auth, {"role": "owner"}, job]
    response = post_job(client, auth)
    assert response.status_code == 200
    assert response.json()["id"] == str(job["id"])
    calls = conn.execute.call_args_list
    assert calls[0].args[0].endswith("FOR UPDATE")
    assert len(calls) == 3
    settle.assert_not_called()
    database.tx.return_value.__exit__.assert_called_once_with(None, None, None)


def test_late_unused_claim_returns_410_and_commits_full_release(claim_api, auth, settle):
    client, database, conn = claim_api
    conn.execute.return_value.fetchone.side_effect = [
        auth, {"role": "owner"}, None, None, None, {"expired": True}, approved_quote(auth)]
    response = post_job(client, auth)
    assert response.status_code == 410
    assert response.json() == {"detail": "authorization expired; request a new quote"}
    database.tx.return_value.__exit__.assert_called_once_with(None, None, None)
    settle.assert_called_once()
    sql = [call.args[0] for call in conn.execute.call_args_list]
    assert sql[0].endswith("FOR UPDATE")
    assert sql.count("SELECT 1 FROM jobs WHERE authorization_id = %s") == 2
    assert not any("INSERT INTO jobs" in query or "INSERT INTO outbox" in query for query in sql)


def test_timely_claim_preserves_existing_job_creation(claim_api, auth, settle):
    client, _, conn = claim_api
    quote = {"id": auth["quote_id"], "input_hash": auth["input_hash"], "request": {},
             "project_version_id": uuid4(), "rate_version": "fixture",
             "expires_at": datetime(2025, 1, 1, tzinfo=UTC)}
    job = {"id": uuid4(), "org_id": auth["org_id"], "version": 1}
    conn.execute.return_value.fetchone.side_effect = [
        auth, {"role": "owner"}, None, None, None, {"expired": False}, quote, job]
    response = post_job(client, auth)
    assert response.status_code == 201
    assert response.json()["id"] == str(job["id"])
    settle.assert_not_called()
    sql = [call.args[0] for call in conn.execute.call_args_list]
    assert sum("INSERT INTO jobs" in query for query in sql) == 1
    assert sum("INSERT INTO outbox" in query for query in sql) == 1
    assert not any("UPDATE authorizations" in query for query in sql)


@pytest.mark.parametrize("case, expected", [
    ("missing", 404), ("nonmember", 404), ("viewer", 403), ("key_reuse", 409),
    ("used_with_other_key", 409), ("already_closed", 410),
])
def test_rejections_do_not_release_or_create(claim_api, auth, settle, case, expected):
    client, _, conn = claim_api
    rows = {
        "missing": [None],
        "nonmember": [auth, None],
        "viewer": [auth, {"role": "viewer"}],
        "key_reuse": [auth, {"role": "owner"}, {"authorization_id": uuid4()}],
        "used_with_other_key": [auth, {"role": "owner"}, None, {"exists": 1}],
        "already_closed": [auth | {"status": "settled"}, {"role": "owner"}, None, None],
    }
    conn.execute.return_value.fetchone.side_effect = rows[case]
    assert post_job(client, auth).status_code == expected
    settle.assert_not_called()
    assert all(call.args[0].startswith("SELECT ") for call in conn.execute.call_args_list)


@pytest.mark.parametrize("status", ["reserved", "settled"])
def test_authorize_replay_never_renews_old_consent_or_reserves_again(
        claim_api, auth, monkeypatch, status):
    client, _, conn = claim_api
    auth["status"] = status
    reserve = Mock()
    monkeypatch.setattr(api_jobs.ledger, "reserve", reserve)
    quote = {"id": auth["quote_id"], "org_id": auth["org_id"]}
    conn.execute.return_value.fetchone.side_effect = [quote, {"role": "owner"}, auth]
    response = client.post(f"/v1/quotes/{auth['quote_id']}/authorize",
                           json={"accept_max_nano": auth["reserved_nano"]})
    assert response.status_code == 201
    assert response.json()["id"] == str(auth["id"])
    assert response.json()["status"] == status
    assert datetime.fromisoformat(response.json()["claim_expires_at"]) == (
        reservations.claim_expires_at(auth))
    reserve.assert_not_called()
    assert len(conn.execute.call_args_list) == 3


@pytest.mark.parametrize("batch_size", [0, -1, 101, True, False, 1.0, "2", None])
def test_recovery_rejects_unbounded_or_invalid_batches_before_db(batch_size):
    database = Mock()
    with pytest.raises(ValueError, match="between 1 and 100"):
        reap_unused_authorizations(database, batch_size=batch_size)
    database.tx.assert_not_called()


def test_recovery_locks_rechecks_and_commits_one_authorization_per_transaction(auth, settle):
    database = MagicMock()
    conn = database.tx.return_value.__enter__.return_value
    second = auth | {"id": uuid4()}
    conn.execute.return_value.fetchone.side_effect = [
        auth, None, {"expired": True}, approved_quote(auth),
        second, None, {"expired": True}, approved_quote(second)]
    assert reap_unused_authorizations(database, batch_size=2) == [
        str(auth["id"]), str(second["id"])]
    assert database.tx.call_count == 2
    assert settle.call_count == 2
    calls = conn.execute.call_args_list
    for offset in (0, 5):
        sql = calls[offset].args[0]
        assert "ORDER BY a.created_at, a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED" in sql
        assert "NOT EXISTS" in sql
        expected = (timedelta(minutes=15), [],) if offset == 0 else (
            timedelta(minutes=15), [auth["id"]], auth["created_at"], auth["id"])
        assert calls[offset].args[1] == expected
        assert calls[offset + 1].args[0] == "SELECT 1 FROM jobs WHERE authorization_id = %s"
    assert database.tx.return_value.__exit__.call_count == 2


def test_stale_candidate_with_new_job_is_not_released(auth, settle):
    database = MagicMock()
    conn = database.tx.return_value.__enter__.return_value
    # Candidate's snapshot misses a job committed before the row lock was acquired.
    conn.execute.return_value.fetchone.side_effect = [auth, {"exists": 1}, None]
    assert reap_unused_authorizations(database, batch_size=2) == []
    assert database.tx.call_count == 2
    settle.assert_not_called()
    assert all(call.args[0].startswith("SELECT ") for call in conn.execute.call_args_list)


def test_reaper_loop_keeps_both_recovery_paths_without_running_a_worker(monkeypatch):
    dependencies = Mock()
    for name in ("migrate", "Database", "reap_expired", "reap_unused_authorizations", "Worker"):
        replacement = Mock()
        monkeypatch.setattr(scheduler, name, replacement)
        dependencies.attach_mock(replacement, name)
    monkeypatch.setattr(scheduler.config, "load", lambda: Mock(job_lease_seconds=2))
    monkeypatch.setattr("sys.argv", ["veyra-scheduler", "reaper"])
    thread = Mock()
    monkeypatch.setattr(scheduler.threading, "Thread", thread)
    scheduler.main()  # Thread is only captured, never started.
    target = thread.call_args.kwargs["target"]
    monkeypatch.setattr(scheduler.time, "sleep", Mock(side_effect=RuntimeError("end loop")))
    with pytest.raises(RuntimeError, match="end loop"):
        target()
    scheduler.reap_expired.assert_called_once_with(scheduler.Database.return_value, cursor=ANY)
    scheduler.reap_unused_authorizations.assert_called_once_with(
        scheduler.Database.return_value, cursor=ANY)
    scheduler.Worker.assert_not_called()


def test_late_claim_posting_failure_exits_transaction_with_error(claim_api, auth, settle):
    client, database, conn = claim_api
    conn.execute.return_value.fetchone.side_effect = [
        auth, {"role": "owner"}, None, None, None, {"expired": True}, approved_quote(auth)]
    settle.side_effect = RuntimeError("posting failed")
    with pytest.raises(RuntimeError, match="posting failed"):
        post_job(client, auth)
    exit_args = database.tx.return_value.__exit__.call_args.args
    assert exit_args[0] is RuntimeError
    assert str(exit_args[1]) == "posting failed"
    assert not any("UPDATE authorizations" in call.args[0]
                   for call in conn.execute.call_args_list)


def test_reaped_or_lost_response_retries_stay_terminal_without_another_posting(
        claim_api, auth, settle):
    client, _, conn = claim_api
    auth["status"] = "settled"
    for key in ("same-key-123", "same-key-123", "different-late-key"):
        conn.execute.return_value.fetchone.side_effect = [auth, {"role": "owner"}, None, None]
        response = client.post("/v1/jobs", json={"authorization_id": str(auth["id"])},
                               headers={"idempotency-key": key})
        assert response.status_code == 410
        assert response.json() == {"detail": "authorization expired; request a new quote"}
    settle.assert_not_called()
    assert all(call.args[0].startswith("SELECT ") for call in conn.execute.call_args_list)


def test_late_claim_with_corrupt_ceiling_rolls_back_without_release(claim_api, auth, settle):
    client, database, conn = claim_api
    quote = approved_quote(auth)
    auth["reserved_nano"] += 1
    conn.execute.return_value.fetchone.side_effect = [
        auth, {"role": "owner"}, None, None, None, {"expired": True}, quote]
    with pytest.raises(SettlementIntegrityError):
        post_job(client, auth)
    assert database.tx.return_value.__exit__.call_args.args[0] is SettlementIntegrityError
    settle.assert_not_called()
    assert all(call.args[0].startswith("SELECT ") for call in conn.execute.call_args_list)
