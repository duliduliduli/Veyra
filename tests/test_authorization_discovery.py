"""Offline personal approval recovery; every database/financial boundary is a double."""

import base64
import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.testclient import TestClient
from veyra_api import api_jobs, reservations
from veyra_api.app import create_app
from veyra_api.auth import CAN_RESEARCH, Principal, authenticate
from veyra_api.config import Settings

STAMP = datetime(2026, 1, 1, 0, 0, 0, 123456, tzinfo=UTC)
FIELDS = {"id", "quote_id", "project_id", "project_name", "project_version_id", "version_no",
          "content_hash", "input_hash", "request", "reserved_nano", "created_at",
          "claim_expires_at", "status", "job", "recovery_state"}
REQUEST_FIELDS = set(api_jobs.QuoteIn.model_fields)


def encode_cursor(value):
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode()


INVALID_CURSORS = [
    "", " ", "bad!!!", "é", "////", "a" * 511,
    *[encode_cursor(value) for value in (
        None, 123, {}, [], [STAMP.isoformat()], [1, str(uuid4())],
        [STAMP.isoformat(), 1], [STAMP.isoformat(), None], [[], str(uuid4())],
        ["2026-01-01", str(uuid4())], ["2026-01-01T00:00:00", str(uuid4())],
        ["not-a-date", str(uuid4())], [STAMP.isoformat(), "not-a-uuid"],
        ["10000-01-01T00:00:00Z", str(uuid4())],
        ["0001-01-01T00:00:00+23:59", str(uuid4())],
        ["9999-12-31T23:59:59-23:59", str(uuid4())],
        [STAMP.isoformat(), str(uuid4()), "extra"],
    )],
]
INVALID_QUERIES = [{"limit": value} for value in (0, -1, 101, "1.5", "no", "", "true")] + [
    {"cursor": "a" * 513}, {"project_id": "invalid"},
]


def result(*, row=None, rows=()):
    return SimpleNamespace(fetchone=lambda: row, fetchall=lambda: deepcopy(list(rows)))


def authorization_row(index=1, **overrides):
    version = uuid4()
    request = {"project_version_id": str(version), "dataset_id": "synth-btcusd-1d-v1",
               "start": "2021-01-01", "end": "2023-01-01", "starting_cash": "12345.6700",
               "params": {"fast": 10, "slow": 40, "label": "é"}, "resource_class": "small",
               "max_runtime_seconds": 60, "taker_fee_bps": "1.2500", "slippage_bps": "0.5"}
    return {"id": UUID(int=index), "quote_id": uuid4(), "project_id": uuid4(),
            "project_name": "Current project name", "project_version_id": version,
            "version_no": 2, "content_hash": "sha256:saved-files", "input_hash": "input-digest",
            "quote_input_hash": "input-digest",
            "request": request, "reserved_nano": 123456789, "created_at": STAMP,
            "status": "reserved", "job_id": None, "job_state": None} | overrides


@pytest.fixture
def offline_discovery(monkeypatch):
    app = FastAPI()
    app.include_router(api_jobs.router)
    app.state.db = MagicMock()
    app.state.settings = SimpleNamespace(dev_auth_enabled=False)
    principal = Principal(uuid4(), "offline@example.test")
    app.dependency_overrides[authenticate] = lambda: principal
    conn = app.state.db.tx.return_value.__enter__.return_value
    conn.execute.side_effect = AssertionError("unexpected database query")

    def no_writes(*args, **kwargs):
        raise AssertionError("discovery cannot mutate or fetch objects")

    for name in ("reserve", "settle"):
        monkeypatch.setattr(api_jobs.ledger, name, no_writes)
    for module, name in ((api_jobs, "release_expired_unused"), (api_jobs, "settle_job"),
                         (api_jobs, "audit"), (reservations, "release_expired_unused")):
        monkeypatch.setattr(module, name, no_writes)
    app.state.store = SimpleNamespace(get=no_writes, put=no_writes)
    return TestClient(app), conn, uuid4(), principal


def queue_page(conn, rows=(), *, role="owner", as_of=STAMP):
    conn.execute.side_effect = [result(row={"role": role}),
                                result(rows=[row | {"as_of": as_of} for row in rows]),
                                result(row={"as_of": as_of})]


@pytest.mark.parametrize("role", sorted(CAN_RESEARCH))
def test_personal_default_page_shape_identity_and_select_only(offline_discovery, role):
    client, conn, org, principal = offline_discovery
    rows = [authorization_row(index) for index in range(51, 0, -1)]
    rows[0]["request"]["provider_credentials"] = "not-an-approved-input"
    queue_page(conn, rows, role=role)
    response = client.get(f"/v1/orgs/{org}/authorizations")
    assert response.status_code == 200, response.text
    page = response.json()
    assert set(page) == {"authorizations", "next_cursor", "has_more", "as_of"}
    assert len(page["authorizations"]) == 50 and page["has_more"] is True
    assert page["as_of"] == STAMP.isoformat()
    assert len(page["next_cursor"]) <= 512
    assert api_jobs._decode_authorization_cursor(page["next_cursor"]) == (STAMP, rows[49]["id"])
    for actual, saved in zip(page["authorizations"], rows, strict=False):
        assert set(actual) == FIELDS
        assert actual["request"] == {k: v for k, v in saved["request"].items()
                                     if k in REQUEST_FIELDS}
        for key in ("id", "quote_id", "project_version_id", "content_hash", "input_hash",
                    "reserved_nano", "created_at", "version_no", "project_id", "project_name"):
            assert actual[key] == jsonable_encoder(saved[key])
        assert actual["recovery_state"] == "claimable"
        assert actual["claim_expires_at"] == (STAMP + timedelta(minutes=15)).isoformat()
        assert actual["job"] is None
    role_sql, role_params = conn.execute.call_args_list[0].args
    assert "memberships WHERE org_id = %s AND user_id = %s" in role_sql
    assert role_params == (org, principal.user_id)
    sql, params = conn.execute.call_args_list[1].args
    assert "WHERE a.org_id = %s AND a.approved_by = %s ORDER BY a.created_at DESC, a.id DESC" in sql
    assert "q.org_id = a.org_id" in sql and "v.org_id = a.org_id" in sql
    assert "p.org_id = a.org_id" in sql and "j.org_id = a.org_id" in sql
    assert params == [org, principal.user_id, 51]
    projection = sql.split(" FROM ")[0]
    for forbidden in ("approved_by", "created_by", "org_id", "object_key", "description",
                      "folder", "code", "files", "estimate", "config", "receipt", "*"):
        assert forbidden not in projection
    assert all(call.args[0].startswith("SELECT ") and "FOR UPDATE" not in call.args[0]
               for call in conn.execute.call_args_list)
    assert conn.execute.call_count == 2


@pytest.mark.parametrize("status,age,job_state,expected", [
    ("reserved", timedelta(minutes=14, seconds=59), None, "claimable"),
    ("reserved", timedelta(minutes=15), None, "expired_pending_release"),
    ("reserved", timedelta(days=1), None, "expired_pending_release"),
    ("settled", timedelta(), None, "released"),
    ("settled", timedelta(days=1), None, "released"),
    *[(status, timedelta(days=100), state, "used")
      for status in ("reserved", "settled")
      for state in ("queued", "running", "finalizing", "stopping", "settled")],
])
def test_recovery_states_use_server_clock_and_any_job_wins(
        offline_discovery, status, age, job_state, expected):
    client, conn, org, _ = offline_discovery
    job_id = uuid4() if job_state else None
    queue_page(conn, [authorization_row(status=status, job_id=job_id, job_state=job_state)],
               as_of=STAMP + age)
    response = client.get(f"/v1/orgs/{org}/authorizations")
    assert response.status_code == 200, response.text
    row = response.json()["authorizations"][0]
    assert row["status"] == status and row["recovery_state"] == expected
    assert row["job"] == ({"id": str(job_id), "state": job_state} if job_state else None)
    assert response.json()["as_of"] == (STAMP + age).isoformat()
    assert all(call.args[0].startswith("SELECT ") for call in conn.execute.call_args_list)


@pytest.mark.parametrize("limit,count", [(1, 0), (1, 1), (100, 100)])
def test_terminal_pages_and_maximum_limit(offline_discovery, limit, count):
    client, conn, org, principal = offline_discovery
    queue_page(conn, [authorization_row(index) for index in range(count, 0, -1)])
    response = client.get(f"/v1/orgs/{org}/authorizations", params={"limit": limit})
    assert response.status_code == 200, response.text
    assert len(response.json()["authorizations"]) == count
    assert response.json()["next_cursor"] is None and response.json()["has_more"] is False
    assert conn.execute.call_args_list[1].args[1] == [org, principal.user_id, limit + 1]


def test_cursor_and_project_filter_stay_personal_and_tenant_scoped(offline_discovery):
    client, conn, org, principal = offline_discovery
    project, boundary_id = uuid4(), uuid4()
    cursor = encode_cursor(["2026-01-01T04:00:00.123456+04:00", str(boundary_id)])
    queue_page(conn)
    response = client.get(f"/v1/orgs/{org}/authorizations",
                          params={"project_id": str(project), "cursor": cursor, "limit": 17})
    assert response.status_code == 200
    assert response.json()["authorizations"] == []
    sql, params = conn.execute.call_args_list[1].args
    assert "a.org_id = %s AND a.approved_by = %s AND v.project_id = %s " in sql
    assert "AND (a.created_at, a.id) < (%s, %s)" in sql
    assert sql.endswith("ORDER BY a.created_at DESC, a.id DESC LIMIT %s")
    assert params == [org, principal.user_id, project, STAMP, boundary_id, 18]


@pytest.mark.parametrize("role,status", [(None, 404), ("viewer", 403), ("billing_admin", 403),
                                         ("unsupported", 403)])
def test_role_and_membership_rechecked_before_listing_or_cursor(offline_discovery, role, status):
    client, conn, org, _ = offline_discovery
    queue_page(conn, [authorization_row(2), authorization_row(1)])
    first = client.get(f"/v1/orgs/{org}/authorizations", params={"limit": 1})
    assert first.status_code == 200
    for cursor in (first.json()["next_cursor"], "bad!!!"):
        conn.execute.reset_mock()
        conn.execute.side_effect = [result(row={"role": role} if role else None)]
        response = client.get(f"/v1/orgs/{org}/authorizations", params={"cursor": cursor})
        assert response.status_code == status
        assert conn.execute.call_count == 1


@pytest.mark.parametrize("cursor", INVALID_CURSORS)
def test_invalid_cursor_never_queries_authorizations(offline_discovery, cursor):
    client, conn, org, _ = offline_discovery
    conn.execute.side_effect = [result(row={"role": "owner"})]
    response = client.get(f"/v1/orgs/{org}/authorizations", params={"cursor": cursor})
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid authorization cursor"}
    assert conn.execute.call_count == 1


@pytest.mark.parametrize("params", INVALID_QUERIES)
def test_query_bounds_rejected_before_discovery(offline_discovery, params):
    client, conn, org, _ = offline_discovery
    assert client.get(f"/v1/orgs/{org}/authorizations", params=params).status_code == 422
    conn.execute.assert_not_called()


@pytest.mark.parametrize("saved_request", [
    None, [], {}, {"params": {"large": "x" * 8193}},
    authorization_row()["request"] | {"dataset_id": "x" * 16385},
    authorization_row()["request"] | {"params": {"x": "y" * 8193}},
])
def test_unavailable_or_oversized_saved_inputs_fail_without_partial_disclosure(saved_request):
    with pytest.raises(HTTPException) as error:
        api_jobs._authorization_request(saved_request, uuid4())
    assert error.value.status_code == 503
    assert error.value.detail == "authorization inputs unavailable"


def test_authentication_required_on_every_page(offline_discovery):
    client, conn, org, _ = offline_discovery
    client.app.dependency_overrides.clear()
    for params in ({}, {"cursor": encode_cursor([STAMP.isoformat(), str(uuid4())])}):
        assert client.get(f"/v1/orgs/{org}/authorizations", params=params).status_code == 401
    conn.execute.assert_not_called()
    client.app.state.db.tx.assert_not_called()


def test_existing_middleware_keeps_success_and_errors_no_store(tmp_path):
    settings = Settings("production", "unused-test-only", tmp_path, "unused-test-only",
                        15, 900, 1800, "1.00")
    app = create_app(settings)
    app.state.db = MagicMock()
    conn = app.state.db.tx.return_value.__enter__.return_value
    client = TestClient(app)  # No lifespan/database constructor.
    path = f"/v1/orgs/{uuid4()}/authorizations"
    assert client.get(path).status_code == 401
    dev_header = {"x-veyra-dev-user": "not-prod-auth@example.test"}
    assert client.get(path, headers=dev_header).status_code == 401
    app.state.db.tx.assert_not_called()
    app.dependency_overrides[authenticate] = lambda: Principal(uuid4(), "offline@example.test")
    queue_page(conn)
    response = client.get(path)
    assert response.status_code == 200
    for reply in (response, client.get(path, params={"limit": 101})):
        assert reply.headers["cache-control"] == "no-store"
        assert "etag" not in reply.headers and "last-modified" not in reply.headers


@pytest.mark.parametrize("corruption", ["quote_hash", "request_version", "oversized", "invalid"])
def test_corrupt_consent_fails_with_sanitized_503_and_no_writes(offline_discovery, corruption):
    client, conn, org, _ = offline_discovery
    row = authorization_row()
    if corruption == "quote_hash":
        row["quote_input_hash"] = "mismatched-private-hash"
    elif corruption == "request_version":
        row["request"]["project_version_id"] = str(uuid4())
    elif corruption == "oversized":
        row["request"]["params"] = {"private-param": "x" * 8193}
    else:
        row["request"] = {"private-param": "malformed-private-inputs"}
    queue_page(conn, [row])
    response = client.get(f"/v1/orgs/{org}/authorizations")
    assert response.status_code == 503
    assert response.json() == {"detail": "authorization inputs unavailable"}
    assert all(call.args[0].startswith("SELECT ") for call in conn.execute.call_args_list)


def test_response_clock_and_recovery_share_the_row_statement(offline_discovery):
    client, conn, org, _ = offline_discovery
    row = authorization_row()
    clock = STAMP + timedelta(minutes=15)
    queue_page(conn, [row], as_of=clock)
    response = client.get(f"/v1/orgs/{org}/authorizations")
    assert response.status_code == 200
    assert response.json()["as_of"] == clock.isoformat()
    assert response.json()["authorizations"][0]["recovery_state"] == "expired_pending_release"
    assert conn.execute.call_count == 2
    assert conn.execute.call_args.args[0].startswith("SELECT statement_timestamp() AS as_of, ")


def test_offline_keyset_discovers_all_own_rows_after_concurrent_newer_insert(offline_discovery):
    client, conn, org, principal = offline_discovery
    records = [(org, principal.user_id, authorization_row(index)) for index in range(1, 136)]
    records += [(uuid4(), principal.user_id, authorization_row(200)),
                (org, uuid4(), authorization_row(201))]

    def read(query, params=None):
        assert query.startswith("SELECT ")
        if "FROM memberships" in query:
            assert params == (org, principal.user_id)
            return result(row={"role": "owner"})
        assert "FROM authorizations" in query
        assert "a.org_id = %s AND a.approved_by = %s" in query
        selected = [row for row_org, user, row in records
                    if (row_org, user) == tuple(params[:2])]
        if len(params) == 5:
            stamp, boundary_id = params[2:4]
            selected = [row for row in selected if (row["created_at"], row["id"]) <
                        (stamp, boundary_id)]
        selected.sort(key=lambda row: (row["created_at"], row["id"]), reverse=True)
        return result(rows=[row | {"as_of": STAMP} for row in selected[:params[-1]]])

    conn.execute.side_effect = read
    path = f"/v1/orgs/{org}/authorizations"
    page = client.get(path).json()
    assert len(page["authorizations"]) == 50
    seen = page["authorizations"][:]
    newer = authorization_row(300, created_at=STAMP + timedelta(days=1))
    records.append((org, principal.user_id, newer))
    while page["has_more"]:
        response = client.get(path, params={"cursor": page["next_cursor"], "limit": 17})
        assert response.status_code == 200
        page = response.json()
        seen.extend(page["authorizations"])
    assert [row["id"] for row in seen] == [str(UUID(int=i)) for i in range(135, 0, -1)]
    assert page["next_cursor"] is None
    assert client.get(path).json()["authorizations"][0]["id"] == str(newer["id"])


def test_missing_saved_default_is_not_silently_replaced(offline_discovery):
    client, conn, org, _ = offline_discovery
    row = authorization_row()
    del row["request"]["starting_cash"]
    queue_page(conn, [row])
    response = client.get(f"/v1/orgs/{org}/authorizations")
    assert response.status_code == 503
    assert response.json() == {"detail": "authorization inputs unavailable"}


@pytest.mark.parametrize("depth", [210, 1100])
def test_deep_saved_params_fail_safely_before_response_serialization(offline_discovery, depth):
    client, conn, org, _ = offline_discovery
    row = authorization_row()
    nested = "private-value"
    for _ in range(depth):
        nested = {"x": nested}
    row["request"]["params"] = nested
    # Avoid the test double's own deepcopy recursion; the production input is parsed JSON.
    conn.execute.side_effect = [result(row={"role": "owner"}),
                               SimpleNamespace(fetchall=lambda: [row | {"as_of": STAMP}])]
    response = client.get(f"/v1/orgs/{org}/authorizations")
    assert response.status_code == 503
    assert response.json() == {"detail": "authorization inputs unavailable"}


@pytest.mark.parametrize("field,value", [("max_runtime_seconds", "60"),
                                         ("max_runtime_seconds", True), ("params", [])])
def test_corrupt_saved_types_are_not_coerced_into_consent(offline_discovery, field, value):
    client, conn, org, _ = offline_discovery
    row = authorization_row()
    row["request"][field] = value
    queue_page(conn, [row])
    response = client.get(f"/v1/orgs/{org}/authorizations")
    assert response.status_code == 503
    assert response.json() == {"detail": "authorization inputs unavailable"}


@pytest.mark.parametrize("params", [
    {"private": float("inf")}, {"private": float("nan")}, {"private": 9007199254740993},
    {"private": "\ud800"}, {"\udfff": "private"}, {"private": "\x00"},
    {1: "private"}, {"private": (1, 2)},
])
def test_invalid_saved_params_have_no_mutation_or_partial_page(offline_discovery, params):
    client, conn, org, _ = offline_discovery
    row = authorization_row()
    row["request"]["params"] = params
    original = repr(row)
    queue_page(conn, [authorization_row(2), row])
    response = client.get(f"/v1/orgs/{org}/authorizations")
    assert response.status_code == 503
    assert response.json() == {"detail": "authorization inputs unavailable"}
    assert repr(row) == original
    assert all(call.args[0].startswith("SELECT ") for call in conn.execute.call_args_list)
