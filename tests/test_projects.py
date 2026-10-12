"""Private strategy settings, complete copies, and immutable saved revisions."""

from concurrent.futures import ThreadPoolExecutor
from importlib import resources
from uuid import uuid4

import pytest
from conftest import Api
from fastapi import HTTPException
from psycopg import sql
from pydantic import ValidationError
from veyra_api.api_projects import (
    MAX_FILES,
    MAX_TOTAL_BYTES,
    DuplicateIn,
    FilesIn,
    ProjectIn,
    ProjectPatch,
    _validate_files,
)

FILES = {"main.py": "from helpers import value\n", "helpers.py": "value = 1\n",
         "package/__init__.py": "", "package/extra.py": "extra = 2\n"}


def create(api, who, org, **fields):
    return api.ok(api.c.post(f"/v1/orgs/{org}/projects", headers=who, json={
        "name": "Strategy", "files": FILES, "entrypoint": "main.py", **fields}))


def test_metadata_defaults_and_normalization_validation():
    body = ProjectIn(name="  Trend  ", folder="  Mean   reversion ", description=" Notes\n ")
    assert (body.name, body.folder, body.description) == ("Trend", "Mean reversion", "Notes")
    assert body.visibility == "private"
    assert ProjectIn(name="Trend").description == ""
    assert ProjectIn(name="Trend").folder is None
    assert ProjectPatch().model_dump(exclude_unset=True) == {}
    assert ProjectPatch(folder="  ").model_dump(exclude_unset=True) == {"folder": None}
    assert DuplicateIn(name="  Copy  ").name == "Copy"


@pytest.mark.parametrize("fields", [
    {"name": ""}, {"name": "   "}, {"name": "a" * 121}, {"name": "line\nbreak"},
    {"name": None}, {"description": None}, {"description": "a" * 4001},
    {"description": "null\x00byte"}, {"folder": "a" * 81}, {"folder": "a/b"},
    {"folder": "a\\b"}, {"folder": ".."}, {"folder": "."}, {"folder": "a\tb"},
    {"visibility": "public"}, {"visibility": None}, {"org_id": str(uuid4())},
    {"created_by": str(uuid4())},
])
def test_invalid_metadata_validation(fields):
    with pytest.raises(ValidationError):
        ProjectIn(**{"name": "Strategy", **fields})
    with pytest.raises(ValidationError):
        ProjectPatch(**fields)


@pytest.mark.parametrize("value", [0, -1, 2147483648, True, 1.5, "1"])
def test_expected_revision_validation(value):
    with pytest.raises(ValidationError):
        FilesIn(files=FILES, entrypoint="main.py", expected_version_no=value)


@pytest.mark.parametrize("files,entrypoint", [
    ({}, "strategy.py"),
    ({f"f{i}.py": "" for i in range(MAX_FILES + 1)}, "f0.py"),
    ({"../strategy.py": ""}, "../strategy.py"),
    ({"/strategy.py": ""}, "/strategy.py"),
    ({"strategy.py\n": ""}, "strategy.py\n"),
    ({"strategy.txt": ""}, "strategy.txt"),
    ({"strategy.py": "a" * (MAX_TOTAL_BYTES + 1)}, "strategy.py"),
    ({"strategy.py": "é" * (MAX_TOTAL_BYTES // 2 + 1)}, "strategy.py"),
    ({"strategy.py": ""}, "missing.py"),
    ({"strategy.py": "\ud800"}, "strategy.py"),
])
def test_file_validation(files, entrypoint):
    with pytest.raises(HTTPException) as error:
        _validate_files(files, entrypoint)
    assert error.value.status_code == 422


def test_multifile_validation():
    _validate_files(FILES, "main.py")


def test_project_metadata_is_private_and_backwards_compatible(api: Api):
    who = api.user()
    org = api.org(who)
    project = api.project(who, org)
    assert project["visibility"] == "private"
    assert project["description"] == ""
    assert project["folder"] is None
    assert project["updated_at"] >= project["created_at"]
    assert project["latest_version"]["version_no"] == 1
    detail = api.ok(api.c.get(f"/v1/projects/{project['id']}", headers=who))
    listed = api.ok(api.c.get(f"/v1/orgs/{org}/projects", headers=who))["projects"]
    for field in ("name", "description", "folder", "visibility", "updated_at"):
        assert project[field] == detail[field] == listed[0][field]
    assert listed[0]["latest_version_id"] == project["latest_version"]["id"]


def test_settings_preserve_immutable_versions_and_sort_by_updated(api: Api):
    who = api.user()
    org = api.org(who)
    first = create(api, who, org)
    second = create(api, who, org, name="Other strategy")
    url = f"/v1/projects/{first['id']}"
    original = api.ok(api.c.get(url + "/versions/1", headers=who))

    def listed():
        return api.ok(api.c.get(f"/v1/orgs/{org}/projects", headers=who))["projects"]

    assert [p["id"] for p in listed()] == [second["id"], first["id"]]
    updated = api.ok(api.c.patch(url, headers=who, json={
        "name": "  Renamed  ", "description": " A strategy\nwith helpers ",
        "folder": "  Research   ideas  ", "visibility": "private"}))
    assert updated["name"] == "Renamed"
    assert updated["description"] == "A strategy\nwith helpers"
    assert updated["folder"] == "Research ideas"
    assert updated["created_at"] == first["created_at"]
    assert updated["updated_at"] > first["updated_at"]
    assert [p["id"] for p in listed()] == [first["id"], second["id"]]
    assert api.ok(api.c.get(url + "/versions/1", headers=who)) == original
    assert len(api.ok(api.c.get(url, headers=who))["versions"]) == 1

    cleared = api.ok(api.c.patch(url, headers=who, json={"folder": None, "description": ""}))
    assert cleared["folder"] is None and cleared["description"] == ""
    unchanged = api.ok(api.c.patch(url, headers=who, json={}))
    assert unchanged == cleared
    api.ok(api.c.post(f"/v1/projects/{second['id']}/versions", headers=who,
                      json={"files": FILES, "entrypoint": "main.py"}))
    assert [p["id"] for p in listed()] == [second["id"], first["id"]]
    assert listed()[0]["latest_version_no"] == 2


def test_duplicate_copies_latest_complete_snapshot_and_metadata(api: Api):
    who = api.user()
    org = api.org(who)
    source = create(api, who, org, description="Description", folder="Research")
    url = f"/v1/projects/{source['id']}"
    old = api.ok(api.c.get(url + "/versions/1", headers=who))
    latest_files = FILES | {"helpers.py": "value = 3\n", "second.py": "answer = 42\n"}
    latest = api.ok(api.c.post(url + "/versions", headers=who,
                              json={"files": latest_files, "entrypoint": "second.py"}))
    source_before = api.ok(api.c.get(url, headers=who))
    copied = api.ok(api.c.post(url + "/duplicate", headers=who))
    assert copied["id"] != source["id"]
    assert copied["org_id"] == source["org_id"]
    assert copied["name"] == "Strategy copy"
    assert (copied["description"], copied["folder"], copied["visibility"]) == (
        "Description", "Research", "private")
    assert copied["latest_version"]["version_no"] == 1
    assert copied["latest_version"]["id"] != latest["id"]
    assert copied["latest_version"]["content_hash"] == latest["content_hash"]
    copy_url = f"/v1/projects/{copied['id']}"
    copy_version = api.ok(api.c.get(copy_url + "/versions/1", headers=who))
    assert copy_version["files"] == latest_files
    assert copy_version["entrypoint"] == "second.py"
    assert "object_key" not in copy_version
    assert len(api.ok(api.c.get(copy_url, headers=who))["versions"]) == 1
    api.ok(api.c.post(copy_url + "/versions", headers=who,
                      json={"files": FILES, "entrypoint": "main.py"}))
    assert api.ok(api.c.get(url, headers=who)) == source_before
    assert api.ok(api.c.get(url + "/versions/1", headers=who)) == old
    assert api.ok(api.c.get(url + "/versions/2", headers=who))["files"] == latest_files


def test_name_collisions_and_long_duplicate_names(api: Api):
    who = api.user()
    org = api.org(who)
    project = create(api, who, org, name="a" * 120)
    other = create(api, who, org, name="Other")
    url = f"/v1/projects/{project['id']}"
    for method, path, body in [
        ("post", f"/v1/orgs/{org}/projects", {"name": " Other "}),
        ("patch", url, {"name": "Other"}),
        ("post", url + "/duplicate", {"name": "Other"}),
    ]:
        assert getattr(api.c, method)(path, headers=who, json=body).status_code == 409
    first = api.ok(api.c.post(url + "/duplicate", headers=who, json={}))
    second = api.ok(api.c.post(url + "/duplicate", headers=who, json={}))
    assert first["name"] == "a" * 115 + " copy"
    assert second["name"] == "a" * 113 + " copy 2"
    assert len(first["name"]) == len(second["name"]) == 120
    named = api.ok(api.c.post(url + "/duplicate", headers=who, json={"name": "Custom"}))
    assert named["name"] == "Custom"
    assert api.ok(api.c.get(url, headers=who))["name"] == project["name"]
    assert api.ok(api.c.get(f"/v1/projects/{other['id']}", headers=who))["name"] == "Other"
    assert len(api.ok(api.c.get(f"/v1/orgs/{org}/projects", headers=who))["projects"]) == 5


def test_concurrent_create_and_duplicate_collisions_are_safe(api: Api):
    who = api.user()
    org = api.org(who)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: api.c.post(
            f"/v1/orgs/{org}/projects", headers=who, json={"name": "Same"}), range(2)))
    assert sorted(r.status_code for r in responses) == [201, 409]
    project = next(r.json() for r in responses if r.status_code == 201)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: api.c.post(
            f"/v1/projects/{project['id']}/duplicate", headers=who), range(2)))
    assert [r.status_code for r in responses] == [201, 201]
    assert {r.json()["name"] for r in responses} == {"Same copy", "Same copy 2"}


def test_stale_and_concurrent_saves_do_not_overwrite_revisions(api: Api):
    who = api.user()
    org = api.org(who)
    project = create(api, who, org)
    url = f"/v1/projects/{project['id']}"
    original = api.ok(api.c.get(url + "/versions/1", headers=who))
    bodies = [{"files": {"main.py": f"value = {n}\n"}, "entrypoint": "main.py",
               "expected_version_no": 1} for n in (2, 3)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda body: api.c.post(
            url + "/versions", headers=who, json=body), bodies))
    assert sorted(r.status_code for r in responses) == [201, 409]
    winner = bodies[next(i for i, r in enumerate(responses) if r.status_code == 201)]
    saved = api.ok(api.c.get(url + "/versions/2", headers=who))
    assert saved["files"] == winner["files"]
    assert api.c.post(url + "/versions", headers=who, json=bodies[0]).status_code == 409
    assert api.ok(api.c.get(url + "/versions/1", headers=who)) == original
    assert api.ok(api.c.get(url + "/versions/2", headers=who)) == saved
    assert len(api.ok(api.c.get(url, headers=who))["versions"]) == 2
    # Existing clients may still omit optimistic concurrency checks.
    assert api.ok(api.c.post(url + "/versions", headers=who,
                            json={"files": FILES, "entrypoint": "main.py"}))["version_no"] == 3


def test_project_routes_hide_other_tenants_and_require_authentication(api: Api):
    owner, stranger = api.user(), api.user()
    org, other_org = api.org(owner), api.org(stranger)
    project = create(api, owner, org)
    url = f"/v1/projects/{project['id']}"
    for method, path, body in [
        ("get", url, None),
        ("get", url + "/versions/1", None),
        ("get", f"/v1/orgs/{org}/projects", None),
        ("patch", url, {"name": "Stolen"}),
        ("post", url + "/duplicate", {}),
        ("post", url + "/versions", {"files": FILES, "entrypoint": "main.py"}),
        ("post", f"/v1/orgs/{org}/projects", {"name": "Stolen"}),
    ]:
        kwargs = {"json": body} if body is not None else {}
        assert getattr(api.c, method)(path, headers=stranger, **kwargs).status_code == 404
        assert getattr(api.c, method)(path, **kwargs).status_code == 401
    assert api.ok(api.c.get(f"/v1/orgs/{other_org}/projects", headers=stranger))["projects"] == []
    assert create(api, stranger, other_org)["name"] == project["name"]
    for payload in ({"visibility": "public"}, {"org_id": other_org}):
        assert api.c.patch(url, headers=owner, json=payload).status_code == 422
    assert api.c.post(url + "/duplicate", headers=owner,
                      json={"org_id": other_org}).status_code == 422
    assert api.ok(api.c.get(url, headers=owner))["visibility"] == "private"


@pytest.mark.parametrize("role", ["viewer", "billing_admin", "researcher"])
def test_project_settings_and_duplication_roles(api: Api, role):
    owner, member = api.user(), api.user()
    org = api.org(owner)
    project = create(api, owner, org)
    api.ok(api.c.post(f"/v1/orgs/{org}/members", headers=owner,
                      json={"subject": member["x-veyra-dev-user"], "role": role}))
    url = f"/v1/projects/{project['id']}"
    assert api.c.get(url, headers=member).status_code == 200
    assert api.c.get(url + "/versions/1", headers=member).status_code == 200
    patch = api.c.patch(url, headers=member, json={"description": "Updated"})
    copied = api.c.post(url + "/duplicate", headers=member)
    assert patch.status_code == (200 if role == "researcher" else 403)
    assert copied.status_code == (201 if role == "researcher" else 403)


def test_migration_preserves_existing_project_data(app):
    migrations = resources.files("veyra_api.migrations")
    with app.state.db.tx() as conn, conn.transaction(force_rollback=True):
        schema = sql.Identifier("upgrade_test_" + uuid4().hex)
        conn.execute(sql.SQL("CREATE SCHEMA {}").format(schema))
        conn.execute(sql.SQL("SET LOCAL search_path TO {}, public").format(schema))
        conn.execute((migrations / "0001_init.sql").read_text())
        user = conn.execute("INSERT INTO users(auth_subject) VALUES ('legacy') RETURNING id")
        user_id = user.fetchone()["id"]
        org_id = conn.execute("INSERT INTO organizations(name) VALUES ('Legacy') "
                              "RETURNING id").fetchone()["id"]
        project = conn.execute(
            "INSERT INTO projects(org_id, name, created_by, created_at) "
            "VALUES (%s, ' Legacy name ', %s, '2020-01-01T00:00:00Z') RETURNING *",
            (org_id, user_id)).fetchone()
        version = conn.execute(
            "INSERT INTO project_versions(org_id, project_id, version_no, content_hash, "
            "entrypoint, object_key, created_by, created_at) "
            "VALUES (%s,%s,1,'sha256:legacy','main.py','legacy.json',%s,"
            "'2021-01-01T00:00:00Z') "
            "RETURNING *", (org_id, project["id"], user_id)).fetchone()
        conn.execute((migrations / "0002_strategy_organization.sql").read_text())
        updated = conn.execute("SELECT * FROM projects").fetchone()
        assert all(updated[key] == value for key, value in project.items())
        assert (updated["description"], updated["folder"], updated["visibility"]) == (
            "", None, "private")
        assert updated["updated_at"] == version["created_at"]
        assert conn.execute("SELECT * FROM project_versions").fetchone() == version
