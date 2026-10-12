"""Downloaded report bytes must match their immutable stored artifact receipt."""

import hashlib
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from veyra_api.api_jobs import ARTIFACT_TYPES, router
from veyra_api.app import create_app
from veyra_api.auth import Principal, authenticate
from veyra_api.config import Settings


@pytest.fixture
def artifact_api():
    app = FastAPI()
    app.include_router(router)
    app.state.db = MagicMock()
    app.state.store = MagicMock()
    app.dependency_overrides[authenticate] = lambda: Principal(uuid4(), "reader@example.test")
    conn = app.state.db.tx.return_value.__enter__.return_value
    payload = b'fixture,exact\r\n1,"value with \\"quote"\r\n'
    receipt = {"key": "orgs/fixture/runs/fixture/report", "bytes": len(payload),
               "sha256": "sha256:" + hashlib.sha256(payload).hexdigest()}
    report = {"id": uuid4(), "org_id": uuid4(),
              "artifacts": {name: receipt.copy() for name in ARTIFACT_TYPES}}
    conn.execute.return_value.fetchone.side_effect = [report, {"role": "viewer"}]
    app.state.store.get.return_value = payload
    return TestClient(app), conn, app.state.store, report, payload


@pytest.mark.parametrize("name", ARTIFACT_TYPES)
@pytest.mark.parametrize("download", [False, True])
def test_exact_verified_report_bytes_and_existing_headers(artifact_api, name, download):
    client, conn, objects, report, payload = artifact_api
    response = client.get(f"/v1/reports/{report['id']}/artifacts/{name}",
                          params={"download": download})
    assert response.status_code == 200
    assert response.content == payload
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in response.headers["content-security-policy"]
    if download:
        assert response.headers["content-disposition"] == (
            f'attachment; filename="veyra-{report["id"]}-{name}"')
    else:
        assert "content-disposition" not in response.headers
    objects.get.assert_called_once_with(report["artifacts"][name]["key"])
    objects.put.assert_not_called()
    assert len(conn.execute.call_args_list) == 2


@pytest.mark.parametrize("case", [
    "changed_bytes", "bad_hash", "bad_length", "boolean_length", "missing_hash",
    "missing_length", "missing_key", "non_mapping", "missing_object", "unreadable_object",
    "invalid_object_key", "non_bytes",
])
@pytest.mark.parametrize("name", ARTIFACT_TYPES)
def test_corrupt_or_missing_artifact_fails_closed_without_exposing_bytes(artifact_api, name, case):
    client, conn, objects, report, payload = artifact_api
    receipt = report["artifacts"][name]
    if case == "changed_bytes":
        objects.get.return_value = b"PRIVATE changed content".ljust(len(payload), b"!")
    elif case == "bad_hash":
        receipt["sha256"] = "sha256:" + "0" * 64
    elif case == "bad_length":
        receipt["bytes"] += 1
    elif case == "boolean_length":
        objects.get.return_value = b"x"
        receipt.update(bytes=True, sha256="sha256:" + hashlib.sha256(b"x").hexdigest())
    elif case.startswith("missing_") and case != "missing_object":
        del receipt[{"missing_hash": "sha256", "missing_length": "bytes",
                     "missing_key": "key"}[case]]
    elif case == "non_mapping":
        report["artifacts"][name] = None
    elif case in ("missing_object", "unreadable_object", "invalid_object_key"):
        error = {"missing_object": FileNotFoundError, "unreadable_object": PermissionError,
                 "invalid_object_key": ValueError}[case]
        objects.get.side_effect = error("PRIVATE internal storage path")
    elif case == "non_bytes":
        objects.get.return_value = "PRIVATE invalid object"
    response = client.get(f"/v1/reports/{report['id']}/artifacts/{name}")
    assert response.status_code == 503
    assert response.json() == {"detail": "report artifact unavailable"}
    assert "PRIVATE" not in response.text
    objects.put.assert_not_called()
    assert all(call.args[0].startswith("SELECT ") for call in conn.execute.call_args_list)


@pytest.mark.parametrize("case", ["unknown_name", "unknown_report", "absent_artifact", "nonmember"])
def test_existing_not_found_and_tenant_checks_precede_object_read(artifact_api, case):
    client, conn, objects, report, _ = artifact_api
    name = "report.json"
    if case == "unknown_name":
        name = "anything.py"
    elif case == "unknown_report":
        conn.execute.return_value.fetchone.side_effect = [None]
    elif case == "absent_artifact":
        report["artifacts"] = {}
    elif case == "nonmember":
        conn.execute.return_value.fetchone.side_effect = [report, None]
    response = client.get(f"/v1/reports/{report['id']}/artifacts/{name}")
    assert response.status_code == 404
    objects.get.assert_not_called()
    objects.put.assert_not_called()


@pytest.mark.parametrize("key", [None, 7, [], {}])
def test_invalid_artifact_key_fails_before_object_read(artifact_api, key):
    client, _, objects, report, _ = artifact_api
    report["artifacts"]["report.json"]["key"] = key
    response = client.get(f"/v1/reports/{report['id']}/artifacts/report.json")
    assert response.status_code == 503
    assert response.json() == {"detail": "report artifact unavailable"}
    objects.get.assert_not_called()
    objects.put.assert_not_called()


@pytest.mark.parametrize("name", ARTIFACT_TYPES)
def test_stored_artifact_corruption_never_downloads_or_repairs(api, worker, app, name):
    who, _, _, job = api.funded_job()
    worker.run_once(job["id"])
    report_id = api.get_job(who, job["id"])["report_id"]
    with app.state.db.tx() as conn:
        row = conn.execute("SELECT artifacts FROM reports WHERE id = %s", (report_id,)).fetchone()
    key = row["artifacts"][name]["key"]
    app.state.store.put(key, b"PRIVATE corrupt artifact")
    response = api.c.get(f"/v1/reports/{report_id}/artifacts/{name}", headers=who,
                         params={"download": True})
    assert response.status_code == 503
    assert response.json() == {"detail": "report artifact unavailable"}
    assert response.headers["cache-control"] == "no-store"
    assert app.state.store.get(key) == b"PRIVATE corrupt artifact"


@pytest.mark.parametrize("case", ["good", "bad_hash", "missing", "null", "int", "list", "dict"])
def test_real_storage_with_production_middleware(tmp_path, case):
    app = create_app(Settings("production", "unused-test-only", tmp_path, "unused-test-only",
                              15, 900, 1800, "1.00"))
    app.state.db = MagicMock()
    app.dependency_overrides[authenticate] = lambda: Principal(uuid4(), "review@example.test")
    conn = app.state.db.tx.return_value.__enter__.return_value
    payload = "unicode \u20ac \U0001f600\r\n".encode()
    key = "orgs/review/runs/review/report.json"
    checksum = app.state.store.put(key, payload)
    candidate = {"missing": key + "x", "null": None, "int": 12, "list": [], "dict": {}}.get(
        case, key)
    if case == "bad_hash":
        checksum = "sha256:" + "0" * 64
    receipt = {"key": candidate, "bytes": len(payload), "sha256": checksum}
    report = {"id": uuid4(), "org_id": uuid4(), "artifacts": {"report.json": receipt}}
    conn.execute.return_value.fetchone.side_effect = [report, {"role": "viewer"}]
    client = TestClient(app)  # Do not enter context: the lifespan starts PostgreSQL.
    response = client.get(f"/v1/reports/{report['id']}/artifacts/report.json?download=true")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "etag" not in response.headers
    assert "last-modified" not in response.headers
    if case == "good":
        assert response.status_code == 200
        assert response.content == payload
        assert "sandbox" in response.headers["content-security-policy"]
        assert response.headers["content-disposition"] == (
            f'attachment; filename="veyra-{report["id"]}-report.json"')
    else:
        assert response.status_code == 503
        assert response.json() == {"detail": "report artifact unavailable"}
    assert app.state.store.get(key) == payload
    assert all(call.args[0].startswith("SELECT ") for call in conn.execute.call_args_list)
