"""Every saved-source reader validates the pinned snapshot before exposing/copying it."""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from conftest import Api
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from veyra_api import api_projects
from veyra_api.api_projects import MAX_FILES, MAX_TOTAL_BYTES, _load_snapshot, router
from veyra_api.api_publications import _content
from veyra_api.auth import Principal, authenticate
from veyra_sim.report import digest

FILES = {"main.py": "from helpers.entry import value\r\n", "helpers/entry.py": "value = '☀'\r\n",
         "helpers/empty.py": ""}
CONTENT = {"files": FILES, "entrypoint": "main.py"}
CASES = ["hash", "entrypoint", "malformed", "unknown", "metadata", "missing", "wrong_type",
         "missing_field", "array", "invalid_utf8", "excessive_nesting"]


def source_row(project_id):
    return {"id": uuid4(), "project_id": project_id, "version_no": 4,
            "content_hash": digest(CONTENT), "entrypoint": "main.py",
            "object_key": "orgs/fixture/projects/fixture/versions/4.json",
            "created_at": "2026-01-01T00:00:00Z"}


def corrupt(objects, row, case):
    if case == "missing":
        objects.get.side_effect = FileNotFoundError("PRIVATE internal object path")
        return
    content = CONTENT
    if case == "hash":
        content = {"files": FILES | {"main.py": "CHANGED PRIVATE SOURCE"}, "entrypoint": "main.py"}
    elif case == "entrypoint":
        row["entrypoint"] = "helpers/entry.py"
    elif case == "unknown":
        content = CONTENT | {"unexpected": "PRIVATE extra field"}
    elif case == "metadata":
        content = CONTENT | {"id": str(uuid4()), "version_no": 900, "project_id": str(uuid4()),
                             "content_hash": "sha256:forged", "created_by": "PRIVATE forged owner"}
    elif case == "wrong_type":
        content = {"files": {"main.py": 123}, "entrypoint": "main.py"}
    elif case == "missing_field":
        content = {"files": FILES}
    elif case == "array":
        content = [CONTENT]
    encoded = json.dumps(content).encode()
    if case == "malformed":
        encoded = b"not JSON: PRIVATE"
    elif case == "invalid_utf8":
        encoded = b'\xff{"files": {}, "entrypoint": "main.py"}'
    elif case == "excessive_nesting":
        encoded = b"[" * 2000 + b"]" * 2000
    objects.get.return_value = encoded


@pytest.fixture
def offline_sources():
    # No lifespan, Database, or source execution: only intercepted SQL/object reads.
    app = FastAPI()
    app.include_router(router)
    app.state.db = MagicMock()
    app.state.store = MagicMock()
    app.dependency_overrides[authenticate] = lambda: Principal(uuid4(), "owner@example.test")
    conn = app.state.db.tx.return_value.__enter__.return_value
    project = {"id": uuid4(), "org_id": uuid4(), "name": "Original", "description": "Notes",
               "folder": "Research", "visibility": "private"}
    row = source_row(project["id"])
    app.state.store.get.return_value = json.dumps(CONTENT).encode()
    conn.execute.side_effect = AssertionError("unexpected database query")
    return TestClient(app), conn, app.state.store, project, row


def query_rows(conn, *rows):
    conn.execute.side_effect = [SimpleNamespace(fetchone=lambda row=row: row) for row in rows]


def test_shared_loader_preserves_exact_crlf_multifile_and_public_import_alias():
    assert _content is _load_snapshot
    objects = MagicMock()
    objects.get.return_value = json.dumps(CONTENT).encode()
    row = source_row(uuid4())
    assert _load_snapshot(objects, row) == CONTENT
    assert row["object_key"] and row["content_hash"] == digest(CONTENT)
    objects.put.assert_not_called()


def test_private_source_success_shape_and_metadata_are_unchanged(offline_sources):
    client, conn, objects, project, row = offline_sources
    original = row.copy()
    query_rows(conn, project, {"role": "viewer"}, row)
    response = client.get(f"/v1/projects/{project['id']}/versions/4")
    assert response.status_code == 200, response.text
    expected = original | CONTENT
    expected.pop("object_key")
    assert response.json() == json.loads(json.dumps(expected, default=str))
    assert response.json()["files"] == FILES
    objects.get.assert_called_once_with(original["object_key"])
    objects.put.assert_not_called()
    assert all(call.args[0].startswith("SELECT ") for call in conn.execute.call_args_list)


@pytest.mark.parametrize("case", CASES)
@pytest.mark.parametrize("action", ["read", "duplicate"])
def test_private_source_and_duplicate_reject_corruption_before_any_mutation(
        offline_sources, monkeypatch, case, action):
    client, conn, objects, project, row = offline_sources
    corrupt(objects, row, case)
    query_rows(conn, project, {"role": "owner"}, row)
    insert = MagicMock(side_effect=AssertionError("must not create a project"))
    snapshot = MagicMock(side_effect=AssertionError("must not save unverified source"))
    audit = MagicMock(side_effect=AssertionError("must not report a successful copy"))
    monkeypatch.setattr(api_projects, "_insert_project", insert)
    monkeypatch.setattr(api_projects, "_snapshot", snapshot)
    monkeypatch.setattr(api_projects, "audit", audit)
    path = f"/v1/projects/{project['id']}"
    response = client.get(path + "/versions/4") if action == "read" else client.post(
        path + "/duplicate", json={"name": "Explicit copy"})
    assert response.status_code == 503, response.text
    assert response.json() == {"detail": "snapshot unavailable"}
    assert "PRIVATE" not in response.text and "CHANGED" not in response.text
    assert len(conn.execute.call_args_list) == 3
    assert all(call.args[0].startswith("SELECT ") for call in conn.execute.call_args_list)
    insert.assert_not_called()
    snapshot.assert_not_called()
    audit.assert_not_called()
    objects.put.assert_not_called()
    if action == "duplicate":
        statement = conn.execute.call_args.args[0]
        assert "SELECT object_key, content_hash, entrypoint" in statement
        assert "ORDER BY version_no DESC LIMIT 1" in statement


@pytest.mark.parametrize("expected", ["no-body", None, 4])
def test_duplicate_passes_exact_validated_source_to_existing_save(
        offline_sources, monkeypatch, expected):
    client, conn, objects, project, row = offline_sources
    name = "Original copy" if expected == "no-body" else "Explicit copy"
    copy = project | {"id": uuid4(), "name": name}
    created = {"id": uuid4(), "project_id": copy["id"], "version_no": 1,
               "content_hash": row["content_hash"], "entrypoint": row["entrypoint"]}
    query_rows(conn, project, {"role": "researcher"}, row, copy)
    insert = MagicMock(return_value=copy)
    snapshot = MagicMock(return_value=created)
    audit = MagicMock()
    monkeypatch.setattr(api_projects, "_insert_project", insert)
    monkeypatch.setattr(api_projects, "_snapshot", snapshot)
    monkeypatch.setattr(api_projects, "audit", audit)
    body = {"name": "Explicit copy"}
    if expected not in (None, "no-body"):
        body["expected_version_no"] = expected
    kwargs = {} if expected == "no-body" else {"json": body}
    response = client.post(f"/v1/projects/{project['id']}/duplicate", **kwargs)
    assert response.status_code == 201, response.text
    expected = json.loads(json.dumps(copy | {"latest_version": created}, default=str))
    assert response.json() == expected
    assert snapshot.call_args.args[5:] == (FILES, "main.py")
    assert insert.call_args.args[3:] == (name, project["description"], project["folder"])
    objects.get.assert_called_once_with(row["object_key"])
    objects.put.assert_not_called()  # Existing save is mocked; source storage is never repaired.
    audit.assert_called_once()


def test_duplicate_expected_version_conflict_precedes_source_read_and_mutation(offline_sources):
    client, conn, objects, project, row = offline_sources
    query_rows(conn, project, {"role": "researcher"}, row)
    response = client.post(f"/v1/projects/{project['id']}/duplicate",
                           json={"expected_version_no": row["version_no"] - 1})
    assert response.status_code == 409
    assert response.json() == {"detail": "project version changed; reload before duplicating"}
    objects.get.assert_not_called()
    objects.put.assert_not_called()
    assert len(conn.execute.call_args_list) == 3
    assert all(call.args[0].startswith("SELECT ") for call in conn.execute.call_args_list)


@pytest.mark.parametrize("expected", [0, -1, 2147483648, True, "4", 4.0])
def test_duplicate_expected_version_is_strict_bounded_integer(offline_sources, expected):
    client, conn, objects, project, _ = offline_sources
    response = client.post(f"/v1/projects/{project['id']}/duplicate",
                           json={"expected_version_no": expected})
    assert response.status_code == 422
    conn.execute.assert_not_called()
    objects.get.assert_not_called()
    objects.put.assert_not_called()


@pytest.mark.parametrize("content", [
    {"files": {}, "entrypoint": "main.py"},
    {"files": {f"f{i}.py": "" for i in range(MAX_FILES + 1)}, "entrypoint": "f0.py"},
    {"files": {"main.py": "x" * (MAX_TOTAL_BYTES + 1)}, "entrypoint": "main.py"},
    {"files": {"main.py": "é" * (MAX_TOTAL_BYTES // 2 + 1)}, "entrypoint": "main.py"},
    {"files": {"../main.py": ""}, "entrypoint": "../main.py"},
    {"files": {"main.py": ""}, "entrypoint": "absent.py"},
    {"files": {"main.py": 123}, "entrypoint": "main.py"},
    CONTENT | {"unexpected": "value"},
])
def test_shared_loader_rechecks_schema_and_limits_even_with_matching_hash(content):
    objects = MagicMock()
    objects.get.return_value = json.dumps(content).encode()
    row = source_row(uuid4()) | {"content_hash": digest(content),
                                "entrypoint": content["entrypoint"]}
    with pytest.raises(HTTPException) as error:
        _load_snapshot(objects, row)
    assert error.value.status_code == 503 and error.value.detail == "snapshot unavailable"
    objects.put.assert_not_called()


def test_shared_loader_does_not_add_backup_only_path_limit():
    path = "a" * 254 + ".py"
    content = {"files": {path: "# legacy saved text\r\n"}, "entrypoint": path}
    objects = MagicMock()
    objects.get.return_value = json.dumps(content).encode()
    row = source_row(uuid4()) | {"content_hash": digest(content), "entrypoint": path}
    assert _load_snapshot(objects, row) == content


def test_database_valid_source_and_duplicate_remain_compatible(api: Api):
    owner = api.user()
    org = api.org(owner)
    project = api.ok(api.c.post(f"/v1/orgs/{org}/projects", headers=owner, json={
        "name": "Integrity " + uuid4().hex, **CONTENT}))
    path = f"/v1/projects/{project['id']}"
    source = api.ok(api.c.get(path + "/versions/1", headers=owner))
    assert source["files"] == FILES and source["entrypoint"] == "main.py"
    copy = api.ok(api.c.post(path + "/duplicate", headers=owner))
    copied = api.ok(api.c.get(f"/v1/projects/{copy['id']}/versions/1", headers=owner))
    assert copied["files"] == FILES
    assert copied["content_hash"] == source["content_hash"]
    assert copied["project_id"] != source["project_id"]
    assert api.ok(api.c.get(path + "/versions/1", headers=owner)) == source


def test_database_duplicate_expected_version_rejects_stale_editor(api: Api):
    owner = api.user()
    org = api.org(owner)
    project = api.ok(api.c.post(f"/v1/orgs/{org}/projects", headers=owner, json={
        "name": "Duplicate version " + uuid4().hex, **CONTENT}))
    path = f"/v1/projects/{project['id']}"
    changed = {"files": FILES | {"main.py": "# Saved by another tab\r\n"},
               "entrypoint": "helpers/entry.py"}
    api.ok(api.c.post(path + "/versions", headers=owner,
                      json=changed | {"expected_version_no": 1}))
    before = api.ok(api.c.get(f"/v1/orgs/{org}/projects", headers=owner))
    stale = api.c.post(path + "/duplicate", headers=owner, json={"expected_version_no": 1})
    assert stale.status_code == 409
    assert api.ok(api.c.get(f"/v1/orgs/{org}/projects", headers=owner)) == before
    copy = api.ok(api.c.post(path + "/duplicate", headers=owner,
                            json={"expected_version_no": 2}))
    copied = api.ok(api.c.get(f"/v1/projects/{copy['id']}/versions/1", headers=owner))
    assert copied["files"] == changed["files"]
    assert copied["entrypoint"] == changed["entrypoint"]


@pytest.mark.parametrize("case", CASES)
def test_database_corrupt_source_is_neither_exposed_nor_duplicated(
        api: Api, app, monkeypatch, case):
    owner = api.user()
    org = api.org(owner)
    project = api.ok(api.c.post(f"/v1/orgs/{org}/projects", headers=owner, json={
        "name": "Corruption " + uuid4().hex, **CONTENT}))
    path = f"/v1/projects/{project['id']}"
    before = api.ok(api.c.get(f"/v1/orgs/{org}/projects", headers=owner))
    objects, row = MagicMock(), source_row(project["id"])
    objects.get.return_value = json.dumps(CONTENT).encode()
    corrupt(objects, row, case)
    if case == "entrypoint":
        # Valid object schema and a matching database entrypoint still need the pinned content hash.
        objects.get.return_value = json.dumps(CONTENT | {"entrypoint": "helpers/entry.py"}).encode()
    with monkeypatch.context() as patch:
        patch.setattr(app.state.store, "get", objects.get)
        read = api.c.get(path + "/versions/1", headers=owner)
        copied = api.c.post(path + "/duplicate", headers=owner)
    assert read.status_code == copied.status_code == 503
    assert read.json() == copied.json() == {"detail": "snapshot unavailable"}
    assert api.ok(api.c.get(f"/v1/orgs/{org}/projects", headers=owner)) == before
    assert api.ok(api.c.get(path + "/versions/1", headers=owner))["files"] == FILES
