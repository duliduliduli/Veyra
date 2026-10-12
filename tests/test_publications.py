"""Explicit public snapshots, soft revocation, and tenant-safe publication controls."""

import base64
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from importlib import resources
from threading import Barrier, Event
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import psycopg
import pytest
from conftest import wait_for
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from psycopg import sql
from pydantic import ValidationError
from veyra_api import api_publications
from veyra_api.api_projects import MAX_FILES, MAX_TOTAL_BYTES
from veyra_api.api_publications import PublicationIn, _content, _decode_cursor, router
from veyra_api.auth import Principal, authenticate
from veyra_api.storage import ObjectStore
from veyra_sim.report import digest

FILES = {"main.py": "from helpers import value\n", "helpers.py": "value = 1\n"}
CONTENT = {"files": FILES, "entrypoint": "main.py"}
PUBLIC_FIELDS = {"id", "title", "description", "entrypoint", "content_hash", "published_at",
                 "public_path"}


def body(version_id=None, **fields):
    return {"project_version_id": str(version_id or uuid4()), "title": "Shared example",
            "description": "Deliberately public notes", "confirm_public": True, **fields}


def assert_no_store(response, status):
    assert response.status_code == status, response.text
    assert response.headers["cache-control"] == "no-store"
    assert "etag" not in response.headers and "last-modified" not in response.headers
    return response.json()


def test_publication_input_requires_explicit_fields_and_true_boolean():
    valid = body(title="  Public title  ", description="  Chosen notes\n  ")
    normalized = PublicationIn(**valid)
    assert normalized.title == "Public title" and normalized.description == "Chosen notes"
    for field in valid:
        with pytest.raises(ValidationError):
            PublicationIn(**{key: value for key, value in valid.items() if key != field})
    for value in (False, None, 0, 1, "true", "false", "1"):
        with pytest.raises(ValidationError):
            PublicationIn(**body(confirm_public=value))


@pytest.mark.parametrize("invalid", [
    {"title": ""}, {"title": "  "}, {"title": "a" * 121}, {"title": "bad\nname"},
    {"title": "\ud800"}, {"description": None}, {"description": "a" * 4001},
    {"description": "bad\x00text"}, {"project_version_id": "latest"},
    {"folder": "Private research"}, {"org_id": str(uuid4())}, {"visibility": "public"},
    {"files": FILES}, {"published_by": str(uuid4())},
])
def test_publication_input_rejects_private_fields_and_invalid_metadata(invalid):
    with pytest.raises(ValidationError):
        PublicationIn(**body(**invalid))


def encode_cursor(value):
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode()


@pytest.mark.parametrize("cursor", [
    "", " ", "not-base64!", "é", "a" * 511,
    *[encode_cursor(value) for value in (
        None, {}, [], ["2026-01-01T00:00:00Z"], [1, str(uuid4())],
        ["2026-01-01T00:00:00Z", 1], ["2026-01-01", str(uuid4())],
        ["2026-01-01T00:00:00", str(uuid4())], ["not-a-date", str(uuid4())],
        ["2026-01-01T00:00:00Z", "not-a-uuid"],
        ["0001-01-01T00:00:00+23:59", str(uuid4())],
        ["2026-01-01T00:00:00Z", str(uuid4()), "extra"],
    )],
])
def test_publication_cursor_rejects_malformed_values(cursor):
    with pytest.raises(HTTPException) as error:
        _decode_cursor(cursor)
    assert error.value.status_code == 422


def test_publication_cursor_normalizes_timezone_without_losing_precision():
    publication_id = uuid4()
    assert _decode_cursor(encode_cursor([
        "2026-01-01T04:00:00.123456+04:00", str(publication_id),
    ])) == (datetime(2026, 1, 1, 0, 0, 0, 123456, tzinfo=UTC), publication_id)


@pytest.fixture
def mock_publications(tmp_path):
    app = FastAPI()
    app.include_router(router)
    app.state.db = MagicMock()
    app.state.store = ObjectStore(tmp_path)
    app.dependency_overrides[authenticate] = lambda: Principal(uuid4(), "owner@example.test")
    conn = app.state.db.tx.return_value.__enter__.return_value
    with TestClient(app) as client:
        yield client, conn, app


def stored_row(objects, **changes):
    key = "orgs/local/projects/local/versions/1.json"
    objects.put(key, json.dumps(CONTENT).encode())
    return {"id": uuid4(), "title": "Chosen title", "description": "Chosen description",
            "content_hash": digest(CONTENT), "entrypoint": "main.py",
            "published_at": "2026-01-01T00:00:00Z", "object_key": key,
            "org_id": uuid4(), "project_version_id": uuid4(), "folder": "SECRET FOLDER",
            "email": "PRIVATE@example.test", "name": "SECRET NAME", **changes}


def test_mock_public_read_is_allowlisted_and_every_response_is_no_store(mock_publications):
    client, conn, app = mock_publications
    row = stored_row(app.state.store)
    conn.execute.return_value.fetchone.return_value = row
    path = f"/v1/public/strategies/{row['id']}"
    result = assert_no_store(client.get(path), 200)
    assert set(result) == PUBLIC_FIELDS | {"files"}
    assert result["files"] == FILES
    assert "SECRET" not in json.dumps(result) and "PRIVATE" not in json.dumps(result)
    statement = conn.execute.call_args.args[0]
    assert "s.revoked_at IS NULL" in statement and "FOR SHARE OF s" in statement
    assert app.state.db.tx.return_value.__exit__.called
    conn.execute.return_value.fetchone.return_value = None
    assert_no_store(client.get(path), 404)
    assert_no_store(client.get("/v1/public/strategies/not-a-uuid"), 422)
    assert_no_store(client.get("/v1/public/strategies?limit=101"), 422)
    assert_no_store(client.get("/v1/public/strategies?offset=-1"), 422)
    assert_no_store(client.get("/v1/public/strategies", params={"q": "bad\x00query"}), 422)
    assert_no_store(client.patch(path, json={"title": "Changed"}), 405)




def test_mock_owner_pagination_bounds_and_scoping(mock_publications, monkeypatch):
    client, conn, app = mock_publications
    project_id, org_id = uuid4(), uuid4()
    monkeypatch.setattr(api_publications, "_load_project", lambda *_: {"org_id": org_id})
    path = f"/v1/projects/{project_id}/publications"
    for params in ({"limit": 0}, {"limit": 101}, {"cursor": "a" * 513}, {"cursor": "bad"}):
        assert_no_store(client.get(path, params=params), 422)
    conn.execute.assert_not_called()
    stamp = datetime(2026, 1, 1, tzinfo=UTC)
    rows = [stored_row(app.state.store, published_at=stamp, version_no=1, revoked_at=None)
            for _ in range(21)]
    conn.execute.return_value.fetchall.return_value = rows
    first = assert_no_store(client.get(path), 200)
    assert len(first["publications"]) == 20 and first["has_more"] is True
    assert _decode_cursor(first["next_cursor"]) == (stamp, rows[19]["id"])
    statement, values = conn.execute.call_args.args
    assert "v.project_id = %s AND s.org_id = %s" in statement
    assert values == [project_id, org_id, 21]
    conn.execute.return_value.fetchall.return_value = []
    last = assert_no_store(client.get(path, params={"limit": 100,
                                                   "cursor": first["next_cursor"]}), 200)
    assert last == {"publications": [], "next_cursor": None, "has_more": False}
    statement, values = conn.execute.call_args.args
    assert "v.project_id = %s AND s.org_id = %s" in statement
    assert "(s.published_at, s.id) < (%s, %s)" in statement
    assert "revoked_at IS NULL" not in statement
    assert values == [project_id, org_id, stamp, rows[19]["id"], 101]

def test_mock_unexpected_failure_is_generic_and_no_store(mock_publications):
    client, conn, _ = mock_publications
    conn.execute.side_effect = RuntimeError("PRIVATE DATABASE DETAIL")
    response = assert_no_store(client.get("/v1/public/strategies"), 500)
    assert response == {"detail": "Internal Server Error"}

def test_mock_discovery_search_is_limited_to_chosen_metadata(mock_publications):
    client, conn, app = mock_publications
    row = stored_row(app.state.store)
    conn.execute.return_value.fetchall.return_value = [row]
    response = assert_no_store(client.get("/v1/public/strategies", params={"q": "%_"}), 200)
    assert set(response["strategies"][0]) == PUBLIC_FIELDS
    statement, values = conn.execute.call_args.args
    assert "revoked_at IS NULL" in statement
    assert "title ILIKE" in statement and "description ILIKE" in statement
    assert "files" not in statement and "projects" not in statement and "users" not in statement
    assert values == ("%\\%\\_%", "%\\%\\_%", 20, 0)


def test_mock_publish_validation_and_auth_errors_are_no_store(mock_publications):
    client, conn, app = mock_publications
    path = f"/v1/projects/{uuid4()}/publications"
    headers = {"Idempotency-Key": uuid4().hex}
    for payload in (body(confirm_public=False), body(confirm_public=1), body(folder="private")):
        assert_no_store(client.post(path, headers=headers, json=payload), 422)
    assert_no_store(client.post(path, json=body()), 422)
    assert_no_store(client.post(path, headers={"Idempotency-Key": "short"}, json=body()), 422)
    conn.execute.assert_not_called()

    def unauthenticated():
        raise HTTPException(401, "authentication required")

    app.dependency_overrides[authenticate] = unauthenticated
    assert_no_store(client.post(path, headers=headers, json=body()), 401)
    assert_no_store(client.get(path), 401)
    assert_no_store(client.delete(f"/v1/publications/{uuid4()}"), 401)


def test_mock_existing_production_auth_stays_fail_closed(mock_publications):
    client, conn, app = mock_publications
    del app.dependency_overrides[authenticate]
    app.state.settings = SimpleNamespace(dev_auth_enabled=False)
    headers = {"x-veyra-dev-user": "owner@example.test", "Idempotency-Key": uuid4().hex}
    assert_no_store(client.post(f"/v1/projects/{uuid4()}/publications", headers=headers,
                               json=body()), 401)
    assert_no_store(client.get(f"/v1/projects/{uuid4()}/publications", headers=headers), 401)
    assert_no_store(client.delete(f"/v1/publications/{uuid4()}", headers=headers), 401)
    conn.execute.assert_not_called()


@pytest.mark.parametrize("corrupt", [
    b"not json", json.dumps({"files": {}, "entrypoint": "main.py"}).encode(),
    json.dumps({"files": {"../escape.py": ""}, "entrypoint": "../escape.py"}).encode(),
    json.dumps({"files": {"main.py": "CHANGED"}, "entrypoint": "main.py"}).encode(),
    json.dumps(CONTENT | {"private_metadata": "never expose"}).encode(),
    json.dumps({"files": {"main.py": 123}, "entrypoint": "main.py"}).encode(),
])
def test_mock_corrupted_source_fails_closed(mock_publications, corrupt):
    client, conn, app = mock_publications
    row = stored_row(app.state.store)
    conn.execute.return_value.fetchone.return_value = row
    app.state.store.put(row["object_key"], corrupt)
    response = assert_no_store(client.get(f"/v1/public/strategies/{row['id']}"), 503)
    assert response == {"detail": "snapshot unavailable"}


@pytest.mark.parametrize("content", [
    {"files": {}, "entrypoint": "main.py"},
    {"files": {f"f{i}.py": "" for i in range(MAX_FILES + 1)}, "entrypoint": "f0.py"},
    {"files": {"main.py": "é" * (MAX_TOTAL_BYTES // 2 + 1)}, "entrypoint": "main.py"},
    {"files": FILES, "entrypoint": "missing.py"},
])
def test_snapshot_limits_are_rechecked_even_with_matching_hash(tmp_path, content):
    objects = ObjectStore(tmp_path)
    objects.put("snapshot.json", json.dumps(content).encode())
    with pytest.raises(HTTPException) as error:
        _content(objects, {"object_key": "snapshot.json", "content_hash": digest(content),
                           "entrypoint": content["entrypoint"]})
    assert error.value.status_code == 503


@pytest.fixture
def publication_api(api):
    return api


def create(api, owner, org):
    return api.ok(api.c.post(f"/v1/orgs/{org}/projects", headers=owner, json={
        "name": "PRIVATE PROJECT " + uuid4().hex, "description": "PRIVATE DESCRIPTION",
        "folder": "PRIVATE FOLDER", "files": FILES, "entrypoint": "main.py"}))


def publish(api, owner, project, key=None, **fields):
    return api.c.post(f"/v1/projects/{project['id']}/publications",
                      headers=owner | {"Idempotency-Key": key or uuid4().hex},
                      json=body(project["latest_version"]["id"], **fields))


def test_exact_archived_version_and_public_metadata_remain_immutable(publication_api, app):
    api = publication_api
    owner = api.user()
    org = api.org(owner)
    project = create(api, owner, org)
    path = f"/v1/projects/{project['id']}"
    api.ok(api.c.post(path + "/versions", headers=owner, json={
        "files": {"main.py": "PRIVATE NEWER CODE"}, "entrypoint": "main.py"}))
    object_paths = set(app.state.store.root.rglob("*.json"))
    receipt = assert_no_store(publish(api, owner, project), 201)
    assert set(app.state.store.root.rglob("*.json")) == object_paths
    assert receipt["version_no"] == 1 and receipt["status"] == "published"
    before = assert_no_store(api.c.get(receipt["public_path"]), 200)
    assert set(before) == PUBLIC_FIELDS | {"files"}
    assert before["files"] == FILES
    assert before["content_hash"] == project["latest_version"]["content_hash"]
    assert "PRIVATE" not in json.dumps(before)
    assert owner["x-veyra-dev-user"] not in json.dumps(before)
    api.ok(api.c.patch(path, headers=owner, json={"name": "Renamed private", "folder": "Hidden"}))
    api.ok(api.c.post(path + "/versions", headers=owner, json={
        "files": {"main.py": "PRIVATE NEWEST CODE"}, "entrypoint": "main.py"}))
    assert assert_no_store(api.c.get(receipt["public_path"]), 200) == before
    source = api.ok(api.c.get(path, headers=owner))
    assert source["visibility"] == "private" and len(source["versions"]) == 3
    assert api.ok(api.c.get(path + "/versions/1", headers=owner))["files"] == FILES
    listed = assert_no_store(api.c.get(path + "/publications", headers=owner), 200)
    assert listed == {"publications": [receipt], "has_more": False, "next_cursor": None}
    assert api.c.patch(f"/v1/publications/{receipt['id']}", headers=owner,
                       json={"title": "Attempt mutation"}).status_code == 405


def test_revoke_hides_direct_discovery_and_search_and_replay_never_republishes(publication_api):
    api = publication_api
    owner = api.user()
    org = api.org(owner)
    project = create(api, owner, org)
    title = "Unique " + uuid4().hex
    key = uuid4().hex
    receipt = assert_no_store(publish(api, owner, project, key, title=title), 201)
    assert assert_no_store(publish(api, owner, project, key, title=title), 200) == receipt
    discovery = "/v1/public/strategies"
    results = assert_no_store(api.c.get(discovery, params={"q": title}), 200)["strategies"]
    assert [row["id"] for row in results] == [receipt["id"]]
    assert set(results[0]) == PUBLIC_FIELDS
    assert_no_store(publish(api, owner, project, key, title="Different"), 409)
    assert_no_store(publish(api, owner, project, key, description="Different"), 409)
    revoked = assert_no_store(api.c.delete(f"/v1/publications/{receipt['id']}", headers=owner), 200)
    assert revoked["status"] == "revoked" and revoked["revoked_at"] is not None
    assert assert_no_store(api.c.delete(f"/v1/publications/{receipt['id']}", headers=owner), 200) \
        == revoked
    assert assert_no_store(publish(api, owner, project, key, title=title), 200) == revoked
    assert_no_store(api.c.get(receipt["public_path"]), 404)
    assert_no_store(api.c.get(receipt["public_path"], headers=owner), 404)
    assert assert_no_store(api.c.get(discovery, params={"q": title}), 200) == {"strategies": []}
    assert receipt["id"] not in {row["id"] for row in api.ok(
        api.c.get(discovery, params={"limit": 100}))["strategies"]}
    replacement = assert_no_store(publish(api, owner, project, title=title), 201)
    assert replacement["id"] != receipt["id"]
    assert replacement["content_hash"] == receipt["content_hash"]
    assert_no_store(api.c.get(receipt["public_path"]), 404)
    assert_no_store(api.c.get(replacement["public_path"]), 200)


def test_never_published_projects_are_absent_and_private_fields_are_not_searchable(publication_api):
    api = publication_api
    owner = api.user()
    org = api.org(owner)
    project = create(api, owner, org)
    for needle in (project["name"], project["description"], project["folder"],
                   owner["x-veyra-dev-user"]):
        assert api.ok(api.c.get("/v1/public/strategies", params={"q": needle}))["strategies"] == []
    receipt = assert_no_store(publish(api, owner, project), 201)
    for needle in (project["name"], project["description"], project["folder"],
                   owner["x-veyra-dev-user"], FILES["helpers.py"]):
        assert api.ok(api.c.get("/v1/public/strategies", params={"q": needle}))["strategies"] == []
    assert_no_store(api.c.get(f"/v1/public/strategies/{project['id']}"), 404)
    assert_no_store(api.c.get(f"/v1/public/strategies/{project['latest_version']['id']}"), 404)
    assert_no_store(api.c.get(receipt["public_path"]), 200)


@pytest.mark.parametrize("role", ["viewer", "researcher", "billing_admin"])
def test_only_workspace_owners_can_publish_list_or_unpublish(publication_api, role):
    api = publication_api
    owner, member = api.user(), api.user()
    org = api.org(owner)
    project = create(api, owner, org)
    api.ok(api.c.post(f"/v1/orgs/{org}/members", headers=owner,
                      json={"subject": member["x-veyra-dev-user"], "role": role}))
    receipt = assert_no_store(publish(api, owner, project), 201)
    assert_no_store(publish(api, member, project), 403)
    assert_no_store(api.c.get(f"/v1/projects/{project['id']}/publications", headers=member), 403)
    assert_no_store(api.c.delete(f"/v1/publications/{receipt['id']}", headers=member), 403)
    assert_no_store(api.c.get(receipt["public_path"]), 200)


def test_nonmembers_cannot_enumerate_or_change_publications_or_mix_tenant_versions(publication_api):
    api = publication_api
    owner, stranger = api.user(), api.user()
    org, other_org = api.org(owner), api.org(stranger)
    project, other = create(api, owner, org), create(api, stranger, other_org)
    receipt = assert_no_store(publish(api, owner, project), 201)
    assert_no_store(publish(api, stranger, project), 404)
    assert_no_store(api.c.get(f"/v1/projects/{project['id']}/publications", headers=stranger), 404)
    assert_no_store(api.c.delete(f"/v1/publications/{receipt['id']}", headers=stranger), 404)
    assert_no_store(publish(api, owner, project,
                            project_version_id=other["latest_version"]["id"]), 404)
    assert_no_store(publish(api, stranger, other,
                            project_version_id=project["latest_version"]["id"]), 404)
    same_org_other = create(api, owner, org)
    assert_no_store(publish(api, owner, project,
                            project_version_id=same_org_other["latest_version"]["id"]), 404)
    for method, path, payload in (
        ("post", f"/v1/projects/{project['id']}/publications",
         body(project["latest_version"]["id"])),
        ("get", f"/v1/projects/{project['id']}/publications", None),
        ("delete", f"/v1/publications/{receipt['id']}", None),
    ):
        kwargs = {"json": payload} if payload else {}
        assert_no_store(getattr(api.c, method)(path, headers={"Idempotency-Key": uuid4().hex},
                                               **kwargs), 401)
    assert_no_store(api.c.get(receipt["public_path"]), 200)


def test_other_owner_in_same_workspace_can_revoke(publication_api):
    api = publication_api
    owner, second = api.user(), api.user()
    org = api.org(owner)
    project = create(api, owner, org)
    api.ok(api.c.post(f"/v1/orgs/{org}/members", headers=owner,
                      json={"subject": second["x-veyra-dev-user"], "role": "owner"}))
    receipt = assert_no_store(publish(api, owner, project), 201)
    assert_no_store(api.c.delete(f"/v1/publications/{receipt['id']}", headers=second), 200)
    assert_no_store(api.c.get(receipt["public_path"]), 404)


def test_concurrent_retry_creates_one_publication_and_conflicting_reuse_is_safe(
        publication_api, monkeypatch):
    barrier = Barrier(2)
    original = api_publications._existing

    def synchronized_lookup(conn, org_id, key):
        row = original(conn, org_id, key)
        if row is None:
            barrier.wait(timeout=10)
        return row

    monkeypatch.setattr(api_publications, "_existing", synchronized_lookup)
    api = publication_api
    owner = api.user()
    org = api.org(owner)
    project = create(api, owner, org)
    key = uuid4().hex
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: publish(api, owner, project, key), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 201]
    assert responses[0].json() == responses[1].json()
    key = uuid4().hex
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda title: publish(api, owner, project, key, title=title),
                                  ["First title", "Second title"]))
    assert sorted(response.status_code for response in responses) == [201, 409]
    monkeypatch.setattr(api_publications, "_existing", original)
    version = api.ok(api.c.post(f"/v1/projects/{project['id']}/versions", headers=owner,
                                json={"files": FILES, "entrypoint": "main.py"}))
    assert_no_store(publish(api, owner, project, key, project_version_id=version["id"]), 409)



def test_idempotency_keys_are_scoped_to_workspace_and_permissions_are_rechecked(publication_api):
    api = publication_api
    owner, other_owner = api.user(), api.user()
    org, other_org = api.org(owner), api.org(other_owner)
    project, other = create(api, owner, org), create(api, other_owner, other_org)
    key = uuid4().hex
    first = assert_no_store(publish(api, owner, project, key), 201)
    second = assert_no_store(publish(api, other_owner, other, key), 201)
    assert first["id"] != second["id"]
    api.ok(api.c.post(f"/v1/orgs/{org}/members", headers=owner,
                      json={"subject": other_owner["x-veyra-dev-user"], "role": "owner"}))
    api.ok(api.c.post(f"/v1/orgs/{org}/members", headers=other_owner,
                      json={"subject": owner["x-veyra-dev-user"], "role": "viewer"}))
    assert_no_store(publish(api, owner, project, key), 403)
    assert_no_store(api.c.delete(f"/v1/publications/{first['id']}", headers=owner), 403)
    assert_no_store(api.c.get(f"/v1/projects/{project['id']}/publications", headers=owner), 403)
    assert_no_store(api.c.delete(f"/v1/publications/{first['id']}", headers=other_owner), 200)
    assert_no_store(api.c.get(first["public_path"]), 404)


def test_owner_pagination_reaches_old_active_links_amid_revocations_and_new_insertions(
        publication_api, app):
    api = publication_api
    owner = api.user()
    org = api.org(owner)
    project = create(api, owner, org)
    path = f"/v1/projects/{project['id']}/publications"
    base = datetime.now(UTC) - timedelta(days=2)
    seeded = []
    active_ids = set()
    with app.state.db.tx() as conn:
        for index in range(135):
            stamp = base + timedelta(seconds=index // 5)
            revoked = stamp + timedelta(seconds=1) if index >= 35 else None
            row = conn.execute(
                "INSERT INTO strategy_publications(org_id, project_version_id, content_hash, "
                "entrypoint, title, description, idempotency_key, published_by, published_at, "
                "revoked_at) VALUES (%s,%s,%s,'main.py','Paging fixture','',%s,%s,%s,%s) "
                "RETURNING id, published_at",
                (org, project["latest_version"]["id"], project["latest_version"]["content_hash"],
                 uuid4().hex, project["created_by"], stamp, revoked)).fetchone()
            seeded.append(row)
            if revoked is None:
                active_ids.add(str(row["id"]))
    expected = [str(row["id"]) for row in sorted(
        seeded, key=lambda row: (row["published_at"], row["id"]), reverse=True)]
    page = assert_no_store(api.c.get(path, headers=owner), 200)
    assert len(page["publications"]) == 20
    assert page["has_more"] is True and len(page["next_cursor"]) <= 512
    assert all(row["status"] == "revoked" for row in page["publications"])
    inserted = assert_no_store(publish(api, owner, project), 201)
    seen, revoked_ids = [], set()
    while True:
        for row in page["publications"]:
            seen.append(row["id"])
            if row["status"] == "published":
                revoked = assert_no_store(api.c.delete(f"/v1/publications/{row['id']}",
                                                       headers=owner), 200)
                assert revoked["status"] == "revoked"
                revoked_ids.add(row["id"])
                assert_no_store(api.c.get(row["public_path"]), 404)
        if not page["has_more"]:
            assert page["next_cursor"] is None
            break
        page = assert_no_store(api.c.get(path, headers=owner,
                                         params={"limit": 17, "cursor": page["next_cursor"]}), 200)
    assert seen == expected and len(seen) == len(set(seen)) == 135
    assert revoked_ids == active_ids and inserted["id"] not in seen
    fresh = assert_no_store(api.c.get(path, headers=owner, params={"limit": 100}), 200)
    assert len(fresh["publications"]) == 100 and fresh["has_more"] is True
    assert fresh["publications"][0]["id"] == inserted["id"]


def test_cross_project_cursors_remain_tenant_scoped_and_recheck_owner(publication_api):
    api = publication_api
    owner, outsider = api.user(), api.user()
    org, other_org = api.org(owner), api.org(outsider)
    target, source, foreign = create(api, owner, org), create(api, owner, org), \
        create(api, outsider, other_org)
    target_rows = [assert_no_store(publish(api, owner, target), 201) for _ in range(2)]
    source_rows = [assert_no_store(publish(api, owner, source), 201) for _ in range(2)]
    foreign_row = assert_no_store(publish(api, outsider, foreign), 201)
    page = assert_no_store(api.c.get(f"/v1/projects/{source['id']}/publications", headers=owner,
                                     params={"limit": 1}), 200)
    cursor = page["next_cursor"]
    result = assert_no_store(api.c.get(f"/v1/projects/{target['id']}/publications", headers=owner,
                                       params={"cursor": cursor}), 200)
    assert {row["id"] for row in result["publications"]} == {row["id"] for row in target_rows}
    assert not {row["id"] for row in source_rows} & {row["id"] for row in result["publications"]}
    assert foreign_row["id"] not in {row["id"] for row in result["publications"]}
    assert_no_store(api.c.get(f"/v1/projects/{foreign['id']}/publications", headers=owner,
                              params={"cursor": cursor}), 404)
    assert_no_store(api.c.get(f"/v1/projects/{target['id']}/publications", headers=outsider,
                              params={"cursor": cursor}), 404)
    api.ok(api.c.post(f"/v1/orgs/{org}/members", headers=owner,
                      json={"subject": outsider["x-veyra-dev-user"], "role": "owner"}))
    api.ok(api.c.post(f"/v1/orgs/{org}/members", headers=outsider,
                      json={"subject": owner["x-veyra-dev-user"], "role": "viewer"}))
    assert_no_store(api.c.get(f"/v1/projects/{source['id']}/publications", headers=owner,
                              params={"cursor": cursor}), 403)


def test_read_and_revoke_serialize_then_direct_and_discovery_hide_snapshot(
        publication_api, app, monkeypatch):
    api = publication_api
    owner = api.user()
    org = api.org(owner)
    project = create(api, owner, org)
    title = "Race fixture " + uuid4().hex
    receipt = assert_no_store(publish(api, owner, project, title=title), 201)
    reading, release = Event(), Event()
    original = app.state.store.get

    def blocked_get(key):
        reading.set()
        assert release.wait(timeout=10), "public read was not released"
        return original(key)

    def revoke_is_waiting():
        with app.state.db.tx() as conn:
            return conn.execute(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() "
                "AND wait_event_type = 'Lock' AND query LIKE %s) AS waiting",
                ("%strategy_publications%FOR UPDATE OF s%",)).fetchone()["waiting"]

    monkeypatch.setattr(app.state.store, "get", blocked_get)
    with ThreadPoolExecutor(max_workers=2) as pool:
        reading_future = pool.submit(api.c.get, receipt["public_path"])
        try:
            assert reading.wait(timeout=5), "public read never reached the object-store barrier"
            revoke_future = pool.submit(api.c.delete, f"/v1/publications/{receipt['id']}",
                                        headers=owner)
            wait_for(revoke_is_waiting, timeout=5, interval=0.01)
            assert not revoke_future.done()
        finally:
            release.set()
        first = assert_no_store(reading_future.result(timeout=10), 200)
        assert first["files"] == FILES
        assert assert_no_store(revoke_future.result(timeout=10), 200)["status"] == "revoked"
    assert_no_store(api.c.get(receipt["public_path"]), 404)
    assert assert_no_store(api.c.get("/v1/public/strategies", params={"q": title}), 200) \
        == {"strategies": []}
    assert receipt["id"] not in {row["id"] for row in assert_no_store(
        api.c.get("/v1/public/strategies", params={"limit": 100}), 200)["strategies"]}

def test_missing_or_corrupted_storage_never_leaks_changed_content(publication_api, app):
    api = publication_api
    owner = api.user()
    org = api.org(owner)
    project = create(api, owner, org)
    receipt = assert_no_store(publish(api, owner, project), 201)
    with app.state.db.tx() as conn:
        version = conn.execute("SELECT object_key FROM project_versions WHERE id = %s",
                               (project["latest_version"]["id"],)).fetchone()
    app.state.store.put(version["object_key"], json.dumps({
        "files": {"main.py": "SHOULD NEVER BECOME PUBLIC"}, "entrypoint": "main.py"}).encode())
    assert_no_store(api.c.get(receipt["public_path"]), 503)
    assert_no_store(publish(api, owner, project), 503)
    app.state.store._path(version["object_key"]).unlink()
    assert_no_store(api.c.get(receipt["public_path"]), 503)
    assert_no_store(api.c.delete(f"/v1/publications/{receipt['id']}", headers=owner), 200)
    assert_no_store(api.c.get(receipt["public_path"]), 404)


def test_database_prevents_payload_mutation_reactivation_and_deletion(publication_api, app):
    api = publication_api
    owner = api.user()
    org = api.org(owner)
    project = create(api, owner, org)
    receipt = assert_no_store(publish(api, owner, project), 201)
    statements = [
        "UPDATE strategy_publications SET title = 'Changed' WHERE id = %s",
        "UPDATE strategy_publications SET description = 'Changed' WHERE id = %s",
        "UPDATE strategy_publications SET content_hash = 'sha256:' || repeat('0',64) WHERE id = %s",
        "UPDATE strategy_publications SET project_version_id = gen_random_uuid() WHERE id = %s",
        "DELETE FROM strategy_publications WHERE id = %s",
    ]
    for statement in statements:
        with pytest.raises(psycopg.errors.RaiseException), app.state.db.tx() as conn:
            conn.execute(statement, (receipt["id"],))
    assert_no_store(api.c.delete(f"/v1/publications/{receipt['id']}", headers=owner), 200)
    for assignment in ("NULL", "clock_timestamp()"):
        with pytest.raises(psycopg.errors.RaiseException), app.state.db.tx() as conn:
            conn.execute(f"UPDATE strategy_publications SET revoked_at = {assignment} "
                         "WHERE id = %s",
                         (receipt["id"],))
    assert_no_store(api.c.get(receipt["public_path"]), 404)


def test_additive_migration_does_not_publish_or_change_legacy_private_projects(app):
    migrations = resources.files("veyra_api.migrations")
    with app.state.db.tx() as conn, conn.transaction(force_rollback=True):
        schema = sql.Identifier("publication_upgrade_" + uuid4().hex)
        conn.execute(sql.SQL("CREATE SCHEMA {}").format(schema))
        conn.execute(sql.SQL("SET LOCAL search_path TO {}, public").format(schema))
        for name in ("0001_init.sql", "0002_strategy_organization.sql"):
            conn.execute((migrations / name).read_text())
        user_id = conn.execute("INSERT INTO users(auth_subject) VALUES ('legacy') RETURNING id") \
            .fetchone()["id"]
        org_id = conn.execute("INSERT INTO organizations(name) VALUES ('Legacy') RETURNING id") \
            .fetchone()["id"]
        project = conn.execute(
            "INSERT INTO projects(org_id, name, description, folder, created_by) "
            "VALUES (%s,'PRIVATE NAME','PRIVATE DESCRIPTION','PRIVATE FOLDER',%s) RETURNING *",
            (org_id, user_id)).fetchone()
        version = conn.execute(
            "INSERT INTO project_versions(org_id, project_id, version_no, content_hash, "
            "entrypoint, object_key, created_by) "
            "VALUES (%s,%s,1,'sha256:legacy','main.py','private.json',%s) RETURNING *",
            (org_id, project["id"], user_id)).fetchone()
        conn.execute((migrations / "0003_strategy_publications.sql").read_text())
        assert conn.execute("SELECT * FROM projects").fetchone() == project
        assert conn.execute("SELECT * FROM project_versions").fetchone() == version
        assert conn.execute("SELECT * FROM strategy_publications").fetchall() == []
