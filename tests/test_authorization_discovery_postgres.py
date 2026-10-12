"""Staged disposable-PostgreSQL gates; no_db deselects these, never reports them passed.

Fixtures use synthetic credit and saved source only; no worker or strategy executes.
Do not run against a deployed or shared database.
"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi.encoders import jsonable_encoder
from psycopg import sql

STAMP = datetime(2026, 1, 1, 0, 0, 0, 123456, tzinfo=UTC)
FIELDS = {"id", "quote_id", "project_id", "project_name", "project_version_id", "version_no",
          "content_hash", "input_hash", "request", "reserved_nano", "created_at",
          "claim_expires_at", "status", "job", "recovery_state"}


def setup_scope(api):
    who = api.user()
    org = api.org(who)
    api.topup(who, org)
    project = api.project(who, org, "# Private saved source; never executed.\n")
    return who, org, project


def approve(api, who, project, **kwargs):
    quote = api.quote(who, project["latest_version"]["id"],
                      start="2021-01-01", end="2021-01-08", **kwargs)
    return quote, api.authorize(who, quote)


def domain_snapshot(database, org):
    with database.tx() as conn:
        rows = {table: conn.execute(sql.SQL("SELECT * FROM {} WHERE org_id = %s ORDER BY id")
                                    .format(sql.Identifier(table)), (org,)).fetchall()
                for table in ("authorizations", "quotes", "jobs", "projects", "project_versions",
                              "journal_entries", "ledger_accounts", "audit_events", "outbox",
                              "usage_events", "reports")}
        rows["journal_lines"] = conn.execute(
            "SELECT l.* FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id "
            "WHERE e.org_id = %s ORDER BY l.id", (org,)).fetchall()
        return rows


@contextmanager
def guard_discovery_sql(app, monkeypatch):
    database = app.state.db
    statements = []

    @contextmanager
    def tx():
        with database.tx() as conn:
            def execute(query, params=None):
                statements.append(query)
                # Existing local/test authentication alone performs this unchanged upsert.
                assert query.startswith("SELECT ") or query.startswith(
                    "INSERT INTO users(auth_subject, email) VALUES")
                assert "FOR UPDATE" not in query
                return conn.execute(query, params)
            yield SimpleNamespace(execute=execute)

    with monkeypatch.context() as context:
        context.setattr(app.state, "db", SimpleNamespace(tx=tx))
        yield statements


def test_database_exact_saved_identity_survives_rename_version_and_quote_expiry(
        api, app, monkeypatch):
    who, org, project = setup_scope(api)
    quote, auth = approve(api, who, project, starting_cash="12345.6700",
                          taker_fee_bps="1.2500", slippage_bps="0.125", params={"slow": 40})
    api.ok(api.c.patch(f"/v1/projects/{project['id']}", headers=who,
                       json={"name": "Current renamed project", "description": "private notes",
                             "folder": "Private folder"}))
    latest = api.ok(api.c.post(f"/v1/projects/{project['id']}/versions", headers=who,
                               json={"files": {"strategy.py": "# New saved version.\n"}}))
    with app.state.db.tx() as conn:
        conn.execute("UPDATE quotes SET expires_at = %s WHERE id = %s", (STAMP, quote["id"]))
        version = conn.execute("SELECT * FROM project_versions WHERE id = %s",
                               (project["latest_version"]["id"],)).fetchone()
    before = domain_snapshot(app.state.db, org)
    monkeypatch.setattr(app.state.store, "get", lambda *args: pytest.fail("source object read"))
    with guard_discovery_sql(app, monkeypatch):
        page = api.ok(api.c.get(f"/v1/orgs/{org}/authorizations", headers=who))
    assert domain_snapshot(app.state.db, org) == before
    assert page["has_more"] is False and page["next_cursor"] is None
    row, = page["authorizations"]
    assert set(row) == FIELDS
    assert row["id"] == auth["id"] and row["quote_id"] == quote["id"]
    assert row["input_hash"] == auth["input_hash"] == quote["input_hash"]
    assert row["project_id"] == project["id"]
    assert row["project_name"] == "Current renamed project"
    assert row["project_version_id"] == str(version["id"]) != latest["id"]
    assert row["version_no"] == version["version_no"] == 1
    assert row["content_hash"] == version["content_hash"]
    assert row["request"] == quote["inputs"]["request"]
    assert row["reserved_nano"] == auth["reserved_nano"] == quote["customer_max_nano"]
    assert row["created_at"] == auth["created_at"]
    assert row["claim_expires_at"] == auth["claim_expires_at"]
    assert row["job"] is None and row["recovery_state"] == "claimable"
    assert datetime.fromisoformat(page["as_of"]) < datetime.fromisoformat(row["claim_expires_at"])


@pytest.mark.parametrize("state", ["queued", "running", "finalizing", "stopping", "settled"])
def test_database_all_recovery_states_and_get_never_releases_renews_or_creates(
        api, app, monkeypatch, state):
    who, org, project = setup_scope(api)
    fixtures = [approve(api, who, project) for _ in range(4)]
    fresh, expired, released, used = [pair[1] for pair in fixtures]
    job = api.job(who, used["id"], key=f"quote-{fixtures[3][0]['id']}")
    if state == "settled":
        api.ok(api.c.post(f"/v1/jobs/{job['id']}/cancel", headers=who))
    else:
        with app.state.db.tx() as conn:
            conn.execute("UPDATE jobs SET state = %s WHERE id = %s", (state, job["id"]))
    with app.state.db.tx() as conn:
        for auth in (expired, released, used):
            conn.execute("UPDATE authorizations SET created_at = %s WHERE id = %s",
                         (STAMP, auth["id"]))
    expired_key = {"idempotency-key": f"quote-{fixtures[2][0]['id']}"}
    assert api.c.post("/v1/jobs", headers=who | expired_key,
                      json={"authorization_id": released["id"]}).status_code == 410
    before = domain_snapshot(app.state.db, org)
    for _ in range(2):
        with guard_discovery_sql(app, monkeypatch):
            page = api.ok(api.c.get(f"/v1/orgs/{org}/authorizations", headers=who))
        rows = {row["id"]: row for row in page["authorizations"]}
        assert len(rows) == 4
        assert {key: row["recovery_state"] for key, row in rows.items()} == {
            fresh["id"]: "claimable", expired["id"]: "expired_pending_release",
            released["id"]: "released", used["id"]: "used"}
        assert rows[expired["id"]]["status"] == "reserved"
        assert rows[released["id"]]["status"] == "settled"
        assert rows[used["id"]]["job"] == {"id": job["id"], "state": state}
        assert all(set(row) == FIELDS for row in rows.values())
        assert domain_snapshot(app.state.db, org) == before


def test_database_pages_beyond_100_with_timestamp_ties_and_concurrent_insert(api, app):
    who, org, project = setup_scope(api)
    other = api.project(who, org, "# Different saved project.\n")
    auths = [approve(api, who, project if i < 130 else other)[1] for i in range(135)]
    with app.state.db.tx() as conn:
        conn.execute("UPDATE authorizations SET created_at = %s WHERE org_id = %s", (STAMP, org))
    expected_ids = sorted((auth["id"] for auth in auths), reverse=True)
    path = f"/v1/orgs/{org}/authorizations"
    page = api.ok(api.c.get(path, headers=who))
    assert len(page["authorizations"]) == 50 and page["has_more"] is True
    assert len(page["next_cursor"]) <= 512
    seen = page["authorizations"][:]
    # A different request commits a new approval between page reads.
    with ThreadPoolExecutor(max_workers=1) as executor:
        newest = executor.submit(approve, api, who, project).result(timeout=15)[1]
    while page["has_more"]:
        page = api.ok(api.c.get(path, headers=who,
                               params={"limit": 17, "cursor": page["next_cursor"]}))
        assert len(page["authorizations"]) <= 17
        seen.extend(page["authorizations"])
    assert page["next_cursor"] is None
    assert [row["id"] for row in seen] == expected_ids
    assert len({row["id"] for row in seen}) == 135
    assert newest["id"] not in {row["id"] for row in seen}
    assert api.ok(api.c.get(path, headers=who))["authorizations"][0]["id"] == newest["id"]
    filtered = api.ok(api.c.get(path, headers=who, params={"project_id": other["id"]}))
    assert {row["id"] for row in filtered["authorizations"]} == {a["id"] for a in auths[130:]}
    assert not filtered["has_more"] and filtered["next_cursor"] is None


@pytest.mark.parametrize("role", ["owner", "researcher"])
def test_database_personal_ownership_tenant_filters_cursor_and_revocation(api, app, role):
    owner, org, project = setup_scope(api)
    member = api.user()
    membership = api.ok(api.c.post(f"/v1/orgs/{org}/members", headers=owner,
                                   json={"subject": member["x-veyra-dev-user"], "role": role}))
    owner_auths = [approve(api, owner, project)[1] for _ in range(3)]
    member_auth = approve(api, member, project)[1]
    stranger, foreign_org, foreign_project = setup_scope(api)
    foreign_auth = approve(api, stranger, foreign_project)[1]
    with app.state.db.tx() as conn:
        conn.execute("UPDATE authorizations SET created_at = %s WHERE org_id = %s", (STAMP, org))
        conn.execute("UPDATE authorizations SET created_at = %s WHERE org_id = %s",
                     (STAMP - timedelta(days=1), foreign_org))
    path = f"/v1/orgs/{org}/authorizations"
    first = api.ok(api.c.get(path, headers=owner, params={"limit": 1}))
    tail = api.ok(api.c.get(path, headers=owner, params={"cursor": first["next_cursor"]}))
    assert {row["id"] for row in first["authorizations"] + tail["authorizations"]} == {
        auth["id"] for auth in owner_auths}
    personal = api.ok(api.c.get(path, headers=member))
    assert [row["id"] for row in personal["authorizations"]] == [member_auth["id"]]
    for query in ({}, {"cursor": first["next_cursor"]}, {"cursor": "bad!!!"}):
        assert api.c.get(path, headers=stranger, params=query).status_code == 404
        assert api.c.get(path, params=query).status_code == 401
    assert api.ok(api.c.get(path, headers=owner,
                            params={"project_id": foreign_project["id"]}))["authorizations"] == []
    foreign = api.ok(api.c.get(f"/v1/orgs/{foreign_org}/authorizations", headers=stranger,
                               params={"cursor": first["next_cursor"]}))
    assert [row["id"] for row in foreign["authorizations"]] == [foreign_auth["id"]]
    assert all(set(row) == FIELDS for row in personal["authorizations"])
    with app.state.db.tx() as conn:
        conn.execute("DELETE FROM memberships WHERE org_id = %s AND user_id = %s",
                     (org, membership["user_id"]))
    assert api.c.get(path, headers=member).status_code == 404


@pytest.mark.parametrize("role", ["viewer", "billing_admin"])
def test_database_read_roles_cannot_discover_any_approval(api, role):
    owner, org, project = setup_scope(api)
    approve(api, owner, project)
    member = api.user()
    api.ok(api.c.post(f"/v1/orgs/{org}/members", headers=owner,
                      json={"subject": member["x-veyra-dev-user"], "role": role}))
    path = f"/v1/orgs/{org}/authorizations"
    for params in ({}, {"cursor": "bad!!!"}, {"project_id": project["id"]}):
        assert api.c.get(path, headers=member, params=params).status_code == 403


def test_database_resume_uses_discovered_original_authorization_and_key(api, app):
    who, org, project = setup_scope(api)
    quote, auth = approve(api, who, project)
    row, = api.ok(api.c.get(f"/v1/orgs/{org}/authorizations", headers=who))["authorizations"]
    job = api.job(who, row["id"], key=f"quote-{row['quote_id']}")
    replay = api.job(who, row["id"], key=f"quote-{row['quote_id']}")
    assert job["id"] == replay["id"]
    discovered, = api.ok(api.c.get(f"/v1/orgs/{org}/authorizations", headers=who))["authorizations"]
    assert discovered["id"] == auth["id"] and discovered["quote_id"] == quote["id"]
    assert discovered["recovery_state"] == "used"
    assert discovered["job"] == {"id": job["id"], "state": "queued"}
    with app.state.db.tx() as conn:
        stored = conn.execute("SELECT * FROM authorizations WHERE id = %s",
                              (auth["id"],)).fetchone()
        entries = conn.execute("SELECT kind FROM journal_entries WHERE org_id = %s "
                               "AND kind = 'reserve'", (org,)).fetchall()
    assert len(entries) == 1
    for key in ("id", "quote_id", "input_hash", "reserved_nano", "created_at", "status"):
        assert jsonable_encoder(stored[key]) == auth[key]
