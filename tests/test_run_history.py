"""Tenant-scoped, fully pageable history and immutable downloadable reports."""

import base64
import json
from datetime import UTC, datetime
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from conftest import Api
from fastapi import HTTPException
from veyra_api import api_jobs


def new_job(api, who, version_id):
    quote = api.quote(who, version_id, start="2021-01-01", end="2021-01-08")
    return api.job(who, api.authorize(who, quote)["id"])


def test_all_runs_page_past_100_with_stable_ties_and_project_metadata(api: Api, app):
    who, org, _, first = api.funded_job()
    project = api.ok(api.c.get(f"/v1/orgs/{org}/projects", headers=who))["projects"][0]
    original = api.ok(api.c.get(
        f"/v1/projects/{project['id']}/versions/1", headers=who))
    version2 = api.ok(api.c.post(f"/v1/projects/{project['id']}/versions", headers=who,
                                 json={"files": original["files"]}))
    other = api.project(who, org)
    jobs = [first]
    for i in range(105):
        version_id = (first["project_version_id"] if i < 80 else version2["id"] if i < 100
                      else other["latest_version"]["id"])
        jobs.append(new_job(api, who, version_id))
    with app.state.db.tx() as conn:
        conn.execute("UPDATE jobs SET created_at = %s WHERE org_id = %s",
                     (datetime(2021, 1, 1, tzinfo=UTC), org))

    path = f"/v1/orgs/{org}/jobs"
    page = api.ok(api.c.get(path, params={"limit": 40}, headers=who))
    assert len(page["jobs"]) == 40 and page["has_more"]
    for row in page["jobs"]:
        expected_count = 101 if row["project_id"] == project["id"] else 5
        assert row["project_run_count"] == expected_count
        assert row["project_name"] in (project["name"], other["name"])
        assert row["version_no"] == (2 if row["project_version_id"] == version2["id"] else 1)
        assert row["start"] == "2021-01-01"
        assert row["end"] in ("2021-01-08", "2023-01-01")
        assert row["metrics"] is None and row["report_id"] is None

    seen = page["jobs"][:]
    # A new run between page reads must not shift offsets or duplicate an older run.
    newest = new_job(api, who, first["project_version_id"])
    while page["has_more"]:
        assert page["next_cursor"]
        page = api.ok(api.c.get(path, params={"limit": 40, "cursor": page["next_cursor"]},
                               headers=who))
        seen.extend(page["jobs"])
    assert page["next_cursor"] is None
    assert [row["id"] for row in seen] == sorted([j["id"] for j in jobs], reverse=True)
    assert newest["id"] not in {row["id"] for row in seen}
    assert api.ok(api.c.get(path, headers=who))["jobs"][0]["id"] == newest["id"]

    filtered = api.ok(api.c.get(path, params={"project_id": other["id"]}, headers=who))
    assert len(filtered["jobs"]) == 5
    assert all(row["project_id"] == other["id"] for row in filtered["jobs"])
    assert not filtered["has_more"] and filtered["next_cursor"] is None


def test_history_is_tenant_scoped_including_cursors_and_project_filter(api: Api):
    alice, org, _, job = api.funded_job()
    project = api.ok(api.c.get(f"/v1/orgs/{org}/projects", headers=alice))["projects"][0]
    new_job(api, alice, job["project_version_id"])
    first_page = api.ok(api.c.get(f"/v1/orgs/{org}/jobs", params={"limit": 1}, headers=alice))
    mallory = api.user()
    own_org = api.org(mallory)
    params = {"cursor": first_page["next_cursor"], "project_id": project["id"]}
    assert api.c.get(f"/v1/orgs/{org}/jobs", headers=mallory, params=params).status_code == 404
    own_page = api.ok(api.c.get(f"/v1/orgs/{own_org}/jobs", headers=mallory, params=params))
    assert own_page == {"jobs": [], "next_cursor": None, "has_more": False}

    viewer = api.user()
    api.ok(api.c.post(f"/v1/orgs/{org}/members", headers=alice,
                      json={"subject": viewer["x-veyra-dev-user"], "role": "viewer"}))
    assert len(api.ok(api.c.get(f"/v1/orgs/{org}/jobs", headers=viewer))["jobs"]) == 2


@pytest.mark.parametrize("params", [
    {"limit": 0}, {"limit": 101}, {"limit": "no"}, {"project_id": "invalid"},
    {"cursor": "bad!!!"}, {"cursor": "x" * 513},
    {"cursor": base64.urlsafe_b64encode(b"{}").decode()},
    {"cursor": base64.urlsafe_b64encode(b'["2021-01-01", "not-a-uuid"]').decode()},
    {"cursor": base64.urlsafe_b64encode(json.dumps(
        ["2021-01-01T00:00:00", str(uuid4())]).encode()).decode()},
])
def test_history_rejects_invalid_pagination(api: Api, params):
    who = api.user()
    org = api.org(who)
    assert api.c.get(f"/v1/orgs/{org}/jobs", headers=who, params=params).status_code == 422


@pytest.mark.parametrize("cursor", [
    "☃", "////", "",
    *[base64.urlsafe_b64encode(json.dumps(payload).encode()).decode() for payload in (
        {}, 123, None, {"timestamp": "2021-01-01", "id": str(uuid4())},
        ["2021-01-01T00:00:00+00:00", 123],
        ["2021-01-01T00:00:00+00:00", None],
        [[], str(uuid4())], ["10000-01-01T00:00:00+00:00", str(uuid4())],
        ["9999-12-31T23:59:59-23:59", str(uuid4())],
        ["0001-01-01T00:00:00+23:59", str(uuid4())],
    )],
])
def test_malformed_cursor_payloads_never_query_history(monkeypatch, cursor):
    database = MagicMock()
    monkeypatch.setattr(api_jobs, "require", lambda *args: None)
    with pytest.raises(HTTPException) as error:
        api_jobs.list_jobs(uuid4(), p=None, database=database, cursor=cursor)
    assert error.value.status_code == 422
    database.tx.return_value.__enter__.return_value.execute.assert_not_called()


def test_history_reads_stored_metrics_without_fetching_artifacts(api: Api, worker, app,
                                                               monkeypatch):
    who, org, _, job = api.funded_job()
    worker.run_once(job["id"])
    report_id = api.get_job(who, job["id"])["report_id"]
    expected = api.ok(api.c.get(f"/v1/reports/{report_id}", headers=who))["metrics"]

    def no_artifact_reads(*args):
        raise AssertionError("run history must not read report objects")

    monkeypatch.setattr(app.state.store, "get", no_artifact_reads)
    row = api.ok(api.c.get(f"/v1/orgs/{org}/jobs", headers=who))["jobs"][0]
    assert row["metrics"] == expected
    assert expected["version"] == "metrics-v2"
    assert "percent_profitable" in expected
    assert row["report_id"] == report_id
    assert row["charge_nano"] is not None


def test_legacy_metrics_and_artifacts_remain_unchanged(api: Api, app):
    who, org, _, job = api.funded_job()
    old_metrics = {"version": "metrics-v1", "trade_count": 7, "net_return": "0.25"}
    payload = json.dumps({"metrics": old_metrics}).encode()
    key = f"orgs/{org}/runs/{job['id']}/report.json"
    checksum = app.state.store.put(key, payload)
    artifacts = {"report.json": {"key": key, "sha256": checksum, "bytes": len(payload)}}
    with app.state.db.tx() as conn:
        rep = conn.execute(
            "INSERT INTO reports(org_id, job_id, outcome, result_digest, metrics, artifacts) "
            "VALUES (%s,%s,'completed','historical-digest',%s,%s) RETURNING id",
            (org, job["id"], json.dumps(old_metrics), json.dumps(artifacts))).fetchone()
    row = api.ok(api.c.get(f"/v1/orgs/{org}/jobs", headers=who))["jobs"][0]
    assert row["metrics"] == old_metrics
    assert "percent_profitable" not in row["metrics"]
    metadata = api.ok(api.c.get(f"/v1/reports/{rep['id']}", headers=who))
    assert metadata["metrics"] == old_metrics
    assert metadata["result_digest"] == "historical-digest"
    assert "key" not in metadata["artifacts"]["report.json"]
    download = api.c.get(f"/v1/reports/{rep['id']}/artifacts/report.json",
                         params={"download": True}, headers=who)
    assert download.content == payload
    assert app.state.store.get(key) == payload


@pytest.mark.parametrize("name", ["report.json", "report.html", "trades.csv"])
def test_report_downloads_preserve_bytes_and_tenant_checks(api: Api, worker, name):
    who, _, _, job = api.funded_job()
    worker.run_once(job["id"])
    report_id = api.get_job(who, job["id"])["report_id"]
    path = f"/v1/reports/{report_id}/artifacts/{name}"
    inline = api.c.get(path, headers=who)
    download = api.c.get(path, params={"download": True}, headers=who)
    assert inline.status_code == download.status_code == 200
    assert inline.content == download.content
    assert "content-disposition" not in inline.headers
    assert download.headers["content-disposition"] == (
        f'attachment; filename="veyra-{report_id}-{name}"')
    assert download.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in download.headers["content-security-policy"]
    assert api.c.get(path, params={"download": True}, headers=api.user()).status_code == 404
