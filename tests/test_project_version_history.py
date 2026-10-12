"""Metadata-only saved history, stable paging, and existing source compatibility."""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from conftest import Api
from fastapi import FastAPI
from fastapi.testclient import TestClient
from veyra_api.api_projects import router
from veyra_api.auth import ROLES_ALL, Principal, authenticate

METADATA_FIELDS = {"id", "version_no", "content_hash", "entrypoint", "created_at"}
INVALID_PAGINATION = [
    {"limit": value} for value in (0, -1, 101, "1.5", "no", "", "true")
] + [
    {"before_version": value} for value in (0, -1, 2147483648, "1.5", "no", "", "true")
]


def result(*, row=None, rows=()):
    return SimpleNamespace(fetchone=lambda: row, fetchall=lambda: list(rows))


def history_results(project, rows, total_count, role="owner"):
    counted_rows = [row | {"total_count": total_count} for row in rows]
    return [result(row=project), result(row={"role": role}),
            result(rows=counted_rows or [{"id": None, "total_count": total_count}])]


@pytest.fixture
def offline_history():
    # No lifespan or database constructor: all SQL is intercepted by this mock.
    app = FastAPI()
    app.include_router(router)
    app.state.db = MagicMock()
    app.state.settings = SimpleNamespace(dev_auth_enabled=False)
    app.dependency_overrides[authenticate] = lambda: Principal(uuid4(), "offline@example.test")
    conn = app.state.db.tx.return_value.__enter__.return_value
    conn.execute.side_effect = AssertionError("unexpected database query")
    project = {"id": uuid4(), "org_id": uuid4()}
    return TestClient(app), conn, project


@pytest.mark.parametrize("role", sorted(ROLES_ALL))
def test_offline_history_metadata_and_read_roles(offline_history, role):
    client, conn, project = offline_history
    rows = [{"id": str(uuid4()), "version_no": n, "content_hash": f"hash-{n}",
             "entrypoint": "strategy.py", "created_at": "2026-01-01T00:00:00Z"}
            for n in (55, 54, 53)]
    conn.execute.side_effect = history_results(project, rows, 105, role)
    response = client.get(f"/v1/projects/{project['id']}/versions",
                          params={"limit": 2, "before_version": 56})
    assert response.status_code == 200, response.text
    assert response.json() == {"versions": rows[:2], "total_count": 105, "has_more": True,
                               "next_before_version": 54}
    assert all(set(row) == METADATA_FIELDS for row in response.json()["versions"])
    calls = conn.execute.call_args_list
    assert len(calls) == 3
    assert all(call.args[0].startswith("SELECT ") for call in calls)
    page_sql, page_params = calls[2].args
    count_sql = page_sql.split("LEFT JOIN")[0]
    assert "count(*)" in count_sql and "version_no <" not in count_sql
    assert "project_id = %s AND org_id = %s" in count_sql
    assert "project_id = %s AND org_id = %s AND version_no < %s" in page_sql
    assert "ORDER BY version_no DESC LIMIT %s" in page_sql
    assert page_sql.endswith("ORDER BY v.version_no DESC")
    assert page_params == [project["id"], project["org_id"],
                           project["id"], project["org_id"], 56, 3]
    assert "object_key" not in page_sql and "files" not in page_sql


@pytest.mark.parametrize("params,expected_limit", [({}, 50), ({"limit": 1}, 1),
                                                      ({"limit": 100}, 100)])
def test_offline_history_limit_bounds_and_terminal_pages(offline_history, params, expected_limit):
    client, conn, project = offline_history
    rows = [{"id": str(uuid4()), "version_no": n} for n in range(expected_limit, 0, -1)]
    conn.execute.side_effect = history_results(project, rows, expected_limit)
    response = client.get(f"/v1/projects/{project['id']}/versions", params=params)
    assert response.status_code == 200, response.text
    assert response.json() == {"versions": rows, "total_count": expected_limit,
                               "has_more": False, "next_before_version": None}
    page_sql, page_params = conn.execute.call_args_list[-1].args
    assert "version_no <" not in page_sql
    assert page_params == [project["id"], project["org_id"],
                           project["id"], project["org_id"], expected_limit + 1]


@pytest.mark.parametrize("total_count,before_version", [(0, 2147483647), (105, 1)])
def test_offline_empty_history_keeps_total_count(offline_history, total_count, before_version):
    client, conn, project = offline_history
    conn.execute.side_effect = history_results(project, [], total_count)
    response = client.get(f"/v1/projects/{project['id']}/versions",
                          params={"before_version": before_version})
    assert response.status_code == 200, response.text
    assert response.json() == {"versions": [], "total_count": total_count,
                               "has_more": False, "next_before_version": None}


@pytest.mark.parametrize("params", INVALID_PAGINATION)
def test_offline_invalid_pagination_never_queries_history(offline_history, params):
    client, conn, project = offline_history
    response = client.get(f"/v1/projects/{project['id']}/versions", params=params)
    assert response.status_code == 422, response.text
    conn.execute.assert_not_called()


@pytest.mark.parametrize("missing_project", [False, True])
def test_offline_history_hides_strangers_and_missing_projects(offline_history, missing_project):
    client, conn, project = offline_history
    conn.execute.side_effect = [result(row=None if missing_project else project), result()]
    response = client.get(f"/v1/projects/{project['id']}/versions")
    assert response.status_code == 404
    assert response.json() == {"detail": "not found"}
    assert conn.execute.call_count == (1 if missing_project else 2)


def test_offline_history_requires_authentication(offline_history):
    client, conn, project = offline_history
    client.app.dependency_overrides.clear()
    response = client.get(f"/v1/projects/{project['id']}/versions")
    assert response.status_code == 401
    conn.execute.assert_not_called()
    client.app.state.db.tx.assert_not_called()


def test_database_history_pages_beyond_50_stably_and_preserves_sources(api: Api, app, monkeypatch):
    who = api.user()
    org = api.org(who)
    original_source = "# Original saved text, never executed.\nvalue = 1\n"
    project = api.project(who, org, original_source)
    api.project(who, org, "# Another project must not affect this count.\n")
    path = f"/v1/projects/{project['id']}"
    # Repeated saves may share content. Seed metadata without running any strategy.
    with app.state.db.tx() as conn:
        conn.execute(
            "INSERT INTO project_versions(org_id, project_id, version_no, content_hash, "
            "entrypoint, object_key, created_by, created_at) "
            "SELECT org_id, project_id, n, content_hash, entrypoint, object_key, created_by, "
            "created_at FROM project_versions CROSS JOIN generate_series(2, 105) AS n "
            "WHERE project_id = %s AND version_no = 1", (project["id"],))

    def no_source_reads(*args):
        raise AssertionError("version history must not fetch source objects")

    with monkeypatch.context() as patch:
        patch.setattr(app.state.store, "get", no_source_reads)
        first = api.ok(api.c.get(path + "/versions", headers=who))
        assert len(first["versions"]) == 50 and first["total_count"] == 105
        assert first["has_more"] and first["next_before_version"] == 56
        assert [row["version_no"] for row in first["versions"]] == list(range(105, 55, -1))
        assert all(set(row) == METADATA_FIELDS for row in first["versions"])

        latest = api.ok(api.c.post(path + "/versions", headers=who, json={
            "files": {"strategy.py": "# New saved text.\nvalue = 106\n"},
            "expected_version_no": 105}))
        assert latest["version_no"] == 106
        seen, page = first["versions"][:], first
        while page["has_more"]:
            page = api.ok(api.c.get(path + "/versions", headers=who,
                                   params={"before_version": page["next_before_version"]}))
            assert page["total_count"] == 106  # Counts all revisions, not only the remaining page.
            seen.extend(page["versions"])
        assert page["next_before_version"] is None
        assert [row["version_no"] for row in seen] == list(range(105, 0, -1))
        assert len({row["id"] for row in seen}) == 105
        empty = api.ok(api.c.get(path + "/versions", headers=who, params={"before_version": 1}))
        assert empty == {"versions": [], "total_count": 106, "has_more": False,
                         "next_before_version": None}
        refreshed = api.ok(api.c.get(path + "/versions", headers=who, params={"limit": 100}))
        assert len(refreshed["versions"]) == 100 and refreshed["total_count"] == 106
        assert refreshed["versions"][0]["id"] == latest["id"]
        assert refreshed["has_more"] and refreshed["next_before_version"] == 7

    legacy = api.ok(api.c.get(path, headers=who))
    assert len(legacy["versions"]) == 50 and legacy["versions"][0]["version_no"] == 106
    assert api.ok(api.c.get(path + "/versions/1", headers=who))["files"] == {
        "strategy.py": original_source}
    assert api.ok(api.c.get(path + "/versions/106", headers=who))["files"] == {
        "strategy.py": "# New saved text.\nvalue = 106\n"}


def test_database_history_count_and_page_share_snapshot_during_save(api: Api, app, monkeypatch):
    who = api.user()
    project = api.project(who, api.org(who), "# Saved source, never executed.\n")
    original_tx = app.state.db.tx
    inserted = False

    @contextmanager
    def concurrent_tx():
        with original_tx() as conn:
            def execute(query, params=()):
                nonlocal inserted
                cursor = conn.execute(query, params)
                if "count(*) AS total_count FROM project_versions" in query and not inserted:
                    inserted = True
                    # Commit another save after the count snapshot, before its result is consumed.
                    with original_tx() as writer:
                        writer.execute(
                            "INSERT INTO project_versions(org_id, project_id, version_no, "
                            "content_hash, entrypoint, object_key, created_by) "
                            "SELECT org_id, project_id, 2, content_hash, entrypoint, object_key, "
                            "created_by FROM project_versions "
                            "WHERE project_id = %s AND version_no = 1", (project["id"],))
                return cursor

            yield SimpleNamespace(execute=execute)

    path = f"/v1/projects/{project['id']}/versions"
    with monkeypatch.context() as patch:
        patch.setattr(app.state.db, "tx", concurrent_tx)
        page = api.ok(api.c.get(path, headers=who))
    assert inserted
    assert page["total_count"] == len(page["versions"]) == 1
    assert page["versions"][0]["id"] == project["latest_version"]["id"]
    assert not page["has_more"] and page["next_before_version"] is None
    refreshed = api.ok(api.c.get(path, headers=who))
    assert refreshed["total_count"] == 2
    assert [row["version_no"] for row in refreshed["versions"]] == [2, 1]


@pytest.mark.parametrize("role", sorted(ROLES_ALL))
def test_database_history_all_member_read_roles(api: Api, role):
    owner, member = api.user(), api.user()
    org = api.org(owner)
    project = api.project(owner, org, "# Saved source.\n")
    api.ok(api.c.post(f"/v1/orgs/{org}/members", headers=owner,
                      json={"subject": member["x-veyra-dev-user"], "role": role}))
    page = api.ok(api.c.get(f"/v1/projects/{project['id']}/versions", headers=member))
    assert page["total_count"] == 1 and not page["has_more"]
    assert page["next_before_version"] is None
    assert page["versions"][0]["id"] == project["latest_version"]["id"]


def test_database_history_rejects_other_tenants_and_unauthenticated_users(api: Api):
    owner, stranger = api.user(), api.user()
    org, other_org = api.org(owner), api.org(stranger)
    project = api.project(owner, org, "# Owner's saved source.\n")
    other = api.project(stranger, other_org, "# Stranger's own source.\n")
    path = f"/v1/projects/{project['id']}/versions"
    for params in ({}, {"limit": 1, "before_version": 2}):
        assert api.c.get(path, headers=stranger, params=params).status_code == 404
        assert api.c.get(path, params=params).status_code == 401
    own = api.ok(api.c.get(f"/v1/projects/{other['id']}/versions", headers=stranger))
    assert own["total_count"] == 1
    assert own["versions"][0]["id"] == other["latest_version"]["id"]


@pytest.mark.parametrize("params", INVALID_PAGINATION)
def test_database_history_rejects_invalid_pagination(api: Api, params):
    who = api.user()
    project = api.project(who, api.org(who), "# Saved source.\n")
    assert api.c.get(f"/v1/projects/{project['id']}/versions", headers=who,
                     params=params).status_code == 422
