"""Bounded, tenant-scoped strategy library paging with live updated-at ordering."""

import base64
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest
from conftest import Api
from fastapi import FastAPI, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.testclient import TestClient
from veyra_api.api_projects import _decode_project_cursor, router
from veyra_api.auth import ROLES_ALL, Principal, authenticate

PROJECT_FIELDS = {"id", "name", "description", "folder", "visibility", "created_at",
                  "updated_at", "latest_version_id", "latest_version_no"}
STAMP = datetime(2026, 1, 1, 0, 0, 0, 123456, tzinfo=UTC)


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
    {"cursor": "a" * 513},
]


def result(*, row=None, rows=()):
    return SimpleNamespace(fetchone=lambda: row, fetchall=lambda: list(rows))


def project_row(index):
    return {"id": UUID(int=index), "name": f"Project {index}", "description": "Notes",
            "folder": "Research", "visibility": "private", "created_at": STAMP,
            "updated_at": STAMP, "latest_version_id": uuid4(), "latest_version_no": 2}


@pytest.fixture
def offline_library():
    # No lifespan or database constructor: all SQL is intercepted by this mock.
    app = FastAPI()
    app.include_router(router)
    app.state.db = MagicMock()
    app.state.settings = SimpleNamespace(dev_auth_enabled=False)
    principal = Principal(uuid4(), "offline@example.test")
    app.dependency_overrides[authenticate] = lambda: principal
    conn = app.state.db.tx.return_value.__enter__.return_value
    conn.execute.side_effect = AssertionError("unexpected database query")
    return TestClient(app), conn, uuid4(), principal


@pytest.mark.parametrize("cursor", INVALID_CURSORS)
def test_offline_library_rejects_malformed_cursors_before_listing(offline_library, cursor):
    client, conn, org, _ = offline_library
    conn.execute.side_effect = [result(row={"role": "owner"})]
    response = client.get(f"/v1/orgs/{org}/projects", params={"cursor": cursor})
    assert response.status_code == 422, response.text
    assert response.json() == {"detail": "invalid project cursor"}
    assert conn.execute.call_count == 1
    assert "memberships" in conn.execute.call_args.args[0]
    with pytest.raises(HTTPException) as error:
        _decode_project_cursor(cursor)
    assert error.value.status_code == 422


@pytest.mark.parametrize("params", INVALID_QUERIES)
def test_offline_library_rejects_out_of_bounds_queries(offline_library, params):
    client, conn, org, _ = offline_library
    assert client.get(f"/v1/orgs/{org}/projects", params=params).status_code == 422
    conn.execute.assert_not_called()


def test_offline_library_cursor_normalizes_timezone_and_preserves_microseconds():
    project_id = uuid4()
    assert _decode_project_cursor(encode_cursor([
        "2026-01-01T04:00:00.123456+04:00", str(project_id),
    ])) == (STAMP, project_id)


@pytest.mark.parametrize("role", sorted(ROLES_ALL))
def test_offline_library_default_page_preserves_metadata_and_all_read_roles(offline_library, role):
    client, conn, org, principal = offline_library
    rows = [project_row(index) for index in range(101, 0, -1)]
    conn.execute.side_effect = [result(row={"role": role}), result(rows=rows)]
    response = client.get(f"/v1/orgs/{org}/projects")
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["projects"] == jsonable_encoder(rows[:100])
    assert all(set(row) == PROJECT_FIELDS for row in page["projects"])
    assert page["has_more"] is True and len(page["next_cursor"]) <= 512
    assert _decode_project_cursor(page["next_cursor"]) == (STAMP, rows[99]["id"])
    assert conn.execute.call_count == 2
    role_sql, role_params = conn.execute.call_args_list[0].args
    assert "memberships WHERE org_id = %s AND user_id = %s" in role_sql
    assert role_params == (org, principal.user_id)
    statement, params = conn.execute.call_args_list[1].args
    assert "WHERE p.org_id = %s ORDER BY p.updated_at DESC, p.id DESC LIMIT %s" in statement
    assert "WHERE project_id = p.id ORDER BY version_no DESC LIMIT 1" in statement
    assert params == [org, 101]
    assert all(call.args[0].startswith("SELECT ") for call in conn.execute.call_args_list)
    assert "object_key" not in statement and "files" not in statement


@pytest.mark.parametrize("limit,count", [(1, 0), (1, 1), (100, 100)])
def test_offline_library_terminal_pages_have_no_cursor(offline_library, limit, count):
    client, conn, org, _ = offline_library
    rows = [project_row(index) for index in range(count, 0, -1)]
    conn.execute.side_effect = [result(row={"role": "owner"}), result(rows=rows)]
    response = client.get(f"/v1/orgs/{org}/projects", params={"limit": limit})
    assert response.status_code == 200, response.text
    assert response.json() == {"projects": jsonable_encoder(rows), "has_more": False,
                               "next_cursor": None}
    assert conn.execute.call_args.args[1] == [org, limit + 1]


def test_offline_library_cursor_is_strict_boundary_in_requested_tenant(offline_library):
    client, conn, org, _ = offline_library
    boundary_id = uuid4()
    cursor = encode_cursor(["2026-01-01T04:00:00.123456+04:00", str(boundary_id)])
    conn.execute.side_effect = [result(row={"role": "viewer"}), result()]
    response = client.get(f"/v1/orgs/{org}/projects", params={"cursor": cursor, "limit": 17})
    assert response.status_code == 200, response.text
    assert response.json() == {"projects": [], "has_more": False, "next_cursor": None}
    statement, params = conn.execute.call_args.args
    assert "WHERE p.org_id = %s AND (p.updated_at, p.id) < (%s, %s)" in statement
    assert statement.endswith("ORDER BY p.updated_at DESC, p.id DESC LIMIT %s")
    assert params == [org, STAMP, boundary_id, 18]


@pytest.mark.parametrize("role,status", [(None, 404), ("unsupported", 403)])
def test_offline_library_rechecks_membership_for_every_page(offline_library, role, status):
    client, conn, org, _ = offline_library
    rows = [project_row(2), project_row(1)]
    conn.execute.side_effect = [result(row={"role": "owner"}), result(rows=rows)]
    first = client.get(f"/v1/orgs/{org}/projects", params={"limit": 1})
    assert first.status_code == 200, first.text
    conn.execute.reset_mock()
    conn.execute.side_effect = [result(row={"role": role} if role else None)]
    response = client.get(f"/v1/orgs/{org}/projects",
                          params={"cursor": first.json()["next_cursor"]})
    assert response.status_code == status, response.text
    assert conn.execute.call_count == 1
    assert "memberships" in conn.execute.call_args.args[0]


def test_offline_library_requires_authentication_on_every_page(offline_library):
    client, conn, org, _ = offline_library
    client.app.dependency_overrides.clear()
    for params in ({}, {"cursor": encode_cursor([STAMP.isoformat(), str(uuid4())])}):
        assert client.get(f"/v1/orgs/{org}/projects", params=params).status_code == 401
    conn.execute.assert_not_called()
    client.app.state.db.tx.assert_not_called()


def test_database_library_pages_beyond_100_with_ties_and_new_insert(api: Api, app, monkeypatch):
    who = api.user()
    org = api.org(who)
    projects = [api.project(who, org, "# Saved source, never executed.\n") for _ in range(135)]
    latest = api.ok(api.c.post(f"/v1/projects/{projects[0]['id']}/versions", headers=who,
                               json={"files": {"strategy.py": "# Second saved version.\n"}}))
    with app.state.db.tx() as conn:
        conn.execute("UPDATE projects SET updated_at = %s WHERE org_id = %s", (STAMP, org))
    expected_ids = sorted((row["id"] for row in projects), reverse=True)

    def no_source_reads(*args):
        raise AssertionError("library listing must not fetch source objects")

    monkeypatch.setattr(app.state.store, "get", no_source_reads)
    path = f"/v1/orgs/{org}/projects"
    page = api.ok(api.c.get(path, headers=who))
    assert len(page["projects"]) == 100 and page["has_more"] is True
    assert len(page["next_cursor"]) <= 512
    assert _decode_project_cursor(page["next_cursor"]) == (STAMP, UUID(expected_ids[99]))
    newest = api.project(who, org, "# Inserted between page reads.\n")
    seen = page["projects"][:]
    while page["has_more"]:
        page = api.ok(api.c.get(path, headers=who,
                               params={"limit": 17, "cursor": page["next_cursor"]}))
        assert len(page["projects"]) <= 17
        seen.extend(page["projects"])
    assert page["next_cursor"] is None
    assert [row["id"] for row in seen] == expected_ids
    assert len({row["id"] for row in seen}) == 135
    assert all(set(row) == PROJECT_FIELDS and row["visibility"] == "private" for row in seen)
    assert newest["id"] not in expected_ids
    changed = next(row for row in seen if row["id"] == projects[0]["id"])
    assert (changed["latest_version_id"], changed["latest_version_no"]) == (latest["id"], 2)
    fresh = api.ok(api.c.get(path, headers=who))
    assert fresh["projects"][0]["id"] == newest["id"]
    assert fresh["has_more"] is True


def test_database_library_live_updates_move_ahead_of_cursor_until_refresh(api: Api, app):
    who = api.user()
    org = api.org(who)
    projects = [api.project(who, org, "# Saved source, never executed.\n") for _ in range(6)]
    with app.state.db.tx() as conn:
        conn.execute("UPDATE projects SET updated_at = %s WHERE org_id = %s", (STAMP, org))
    original_ids = sorted((row["id"] for row in projects), reverse=True)
    path = f"/v1/orgs/{org}/projects"
    first = api.ok(api.c.get(path, headers=who, params={"limit": 2}))
    assert [row["id"] for row in first["projects"]] == original_ids[:2]
    api.ok(api.c.patch(f"/v1/projects/{original_ids[0]}", headers=who,
                       json={"description": "Updated after first page"}))
    saved = api.ok(api.c.post(f"/v1/projects/{original_ids[3]}/versions", headers=who,
                              json={"files": {"strategy.py": "# A newer saved version.\n"}}))
    tail = api.ok(api.c.get(path, headers=who, params={"cursor": first["next_cursor"]}))
    assert [row["id"] for row in tail["projects"]] == original_ids[2:3] + original_ids[4:]
    assert not tail["has_more"] and tail["next_cursor"] is None
    # Updated unseen rows move above the boundary; an existing cursor is not a snapshot.
    refreshed = api.ok(api.c.get(path, headers=who))
    assert len(refreshed["projects"]) == 6 and not refreshed["has_more"]
    assert [row["id"] for row in refreshed["projects"][:2]] == [original_ids[3], original_ids[0]]
    assert refreshed["projects"][0]["latest_version_id"] == saved["id"]
    assert refreshed["projects"][0]["latest_version_no"] == 2


@pytest.mark.parametrize("role", sorted(ROLES_ALL))
def test_database_library_tenant_cursor_isolation_and_revoked_membership(api: Api, app, role):
    owner, member, stranger = api.user(), api.user(), api.user()
    org, other_org = api.org(owner), api.org(stranger)
    projects = [api.project(owner, org, "# Private saved source.\n") for _ in range(3)]
    foreign = api.project(stranger, other_org, "# Other tenant's source.\n")
    with app.state.db.tx() as conn:
        conn.execute("UPDATE projects SET updated_at = %s WHERE org_id = %s", (STAMP, org))
        conn.execute("UPDATE projects SET updated_at = %s WHERE org_id = %s",
                     (STAMP - timedelta(days=1), other_org))
    membership = api.ok(api.c.post(f"/v1/orgs/{org}/members", headers=owner,
                                   json={"subject": member["x-veyra-dev-user"], "role": role}))
    path = f"/v1/orgs/{org}/projects"
    first = api.ok(api.c.get(path, headers=member, params={"limit": 1}))
    params = {"cursor": first["next_cursor"]}
    tail = api.ok(api.c.get(path, headers=member, params=params))
    assert [row["id"] for row in first["projects"] + tail["projects"]] == sorted(
        (row["id"] for row in projects), reverse=True)
    for query in ({}, params, {"cursor": "bad!!!"}):
        assert api.c.get(path, headers=stranger, params=query).status_code == 404
        assert api.c.get(path, params=query).status_code == 401
    own_page = api.ok(api.c.get(f"/v1/orgs/{other_org}/projects", headers=stranger, params=params))
    assert [row["id"] for row in own_page["projects"]] == [foreign["id"]]
    assert not own_page["has_more"] and own_page["next_cursor"] is None
    with app.state.db.tx() as conn:
        conn.execute("DELETE FROM memberships WHERE org_id = %s AND user_id = %s",
                     (org, membership["user_id"]))
    assert api.c.get(path, headers=member, params=params).status_code == 404


@pytest.mark.parametrize("params", INVALID_QUERIES + [{"cursor": c} for c in INVALID_CURSORS])
def test_database_library_rejects_invalid_pagination(api: Api, params):
    who = api.user()
    org = api.org(who)
    assert api.c.get(f"/v1/orgs/{org}/projects", headers=who, params=params).status_code == 422
