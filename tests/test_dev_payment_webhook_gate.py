"""The simulated payment webhook exists only in exact local/test environments."""

import json
import time
from unittest.mock import MagicMock, Mock
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from starlette.routing import NoMatchFound
from veyra_api import api_billing, config, deps, payments
from veyra_api import app as app_module

WEBHOOK_PATH = "/v1/webhooks/payments/dev"
DENIED_ENVIRONMENTS = ("production", "staging", "unknown", "prod", "LOCAL", "TEST",
                       "Local", "Test", "", " local", "local ", " test", "test ", "test\n")
SECRET = "synthetic-webhook-test-only"
EVENT = {"id": "evt_fixture", "type": "payment.succeeded",
         "data": {"provider_ref": "devpay_fixture", "amount_nano": 25_000_000_000}}
BODY = json.dumps(EVENT).encode()


def settings_for(app_env, tmp_path):
    return config.Settings(app_env=app_env, database_url="unused-test-only",
                           object_store_dir=tmp_path, payment_webhook_secret=SECRET,
                           job_lease_seconds=15, quote_ttl_seconds=900,
                           max_job_runtime_seconds=1800, max_job_customer_usd="1.00")


@pytest.fixture(autouse=True)
def forbid_runtime_configuration_and_database_startup(monkeypatch):
    guards = []
    for target, name in ((config, "load"), (app_module, "migrate"), (app_module, "Database")):
        guard = Mock(side_effect=AssertionError("runtime configuration/database forbidden"))
        monkeypatch.setattr(target, name, guard)
        guards.append(guard)
    yield
    for guard in guards:
        guard.assert_not_called()


def assert_security_headers(response):
    assert response.headers["cache-control"] == "no-store"
    assert "etag" not in response.headers and "last-modified" not in response.headers
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


@pytest.mark.parametrize("app_env", DENIED_ENVIRONMENTS)
def test_webhook_absent_without_dependencies_or_side_effects(monkeypatch, tmp_path, app_env):
    app = app_module.create_app(settings_for(app_env, tmp_path))
    database, db_access, settings_access = MagicMock(), Mock(), Mock()
    app.state.db = database
    app.dependency_overrides[deps.db] = lambda: db_access()
    app.dependency_overrides[deps.settings] = lambda: settings_access()
    verify, apply_event, credit = Mock(), Mock(), Mock()
    monkeypatch.setattr(payments, "verify", verify)
    monkeypatch.setattr(api_billing, "_apply_payment_event", apply_event)
    monkeypatch.setattr(api_billing.ledger, "credit_topup", credit)

    with pytest.raises(NoMatchFound):
        app.url_path_for("payment_webhook")
    paths = app.openapi()["paths"]
    assert WEBHOOK_PATH not in paths
    assert not any(path.startswith("/v1/dev/") for path in paths)
    # Other billing routes keep their existing authentication boundary and contract.
    assert "/v1/orgs/{org_id}/billing/topups" in paths
    assert "/v1/orgs/{org_id}/billing/balance" in paths
    assert "/v1/orgs/{org_id}/billing/usage" in paths

    # No context manager: TestClient must not start lifespan/database migration.
    client = TestClient(app)
    for headers in ({}, {"veyra-signature": "invalid"},
                    {"veyra-signature": payments.sign(SECRET, BODY)}):
        response = client.post(WEBHOOK_PATH, content=BODY, headers=headers)
        # Static-file fallback may answer 405 instead of 404 for an absent POST.
        assert response.status_code in (404, 405)
        assert_security_headers(response)
    for mock in (db_access, settings_access, verify, apply_event, credit):
        mock.assert_not_called()
    assert database.mock_calls == []


@pytest.mark.parametrize("app_env", ("local", "test"))
def test_signed_dev_event_keeps_url_and_credits_fake_ledger(monkeypatch, tmp_path, app_env):
    app = app_module.create_app(settings_for(app_env, tmp_path))
    database = app.state.db = MagicMock()
    conn = database.tx.return_value.__enter__.return_value
    pay = {"id": UUID("00000000-0000-4000-8000-000000000001"),
           "org_id": UUID("00000000-0000-4000-8000-000000000002"),
           "amount_nano": EVENT["data"]["amount_nano"], "status": "pending"}
    conn.execute.return_value.fetchone.side_effect = [{"event_id": EVENT["id"]}, pay]
    credit, audit = Mock(), Mock()
    verify = Mock(wraps=payments.verify)
    monkeypatch.setattr(api_billing.ledger, "credit_topup", credit)
    monkeypatch.setattr(api_billing, "audit", audit)
    monkeypatch.setattr(payments, "verify", verify)

    assert str(app.url_path_for("payment_webhook")) == WEBHOOK_PATH
    paths = app.openapi()["paths"]
    assert WEBHOOK_PATH in paths
    assert "post" in paths[WEBHOOK_PATH]
    assert "/v1/dev/payments/{payment_id}/complete" in paths
    signature = payments.sign(SECRET, BODY)
    response = TestClient(app).post(WEBHOOK_PATH, content=BODY,
                                   headers={"veyra-signature": signature})

    assert response.status_code == 200
    assert response.json() == {"status": "processed"}
    verify.assert_called_once_with(SECRET, BODY, signature)
    database.tx.assert_called_once_with()
    assert conn.execute.call_count == 3
    assert "SET status = 'succeeded'" in conn.execute.call_args.args[0]
    assert conn.execute.call_args.args[1] == (pay["id"],)
    credit.assert_called_once_with(conn, pay["org_id"], pay["amount_nano"], pay["id"])
    audit.assert_called_once_with(conn, None, pay["org_id"], "billing.payment.succeeded",
                                  f"payment:{pay['id']}")
    assert_security_headers(response)


@pytest.mark.parametrize("app_env", ("local", "test"))
@pytest.mark.parametrize("signature_kind", ("missing", "malformed", "wrong", "stale", "tampered"))
def test_local_signature_rejections_cannot_apply_events(
        monkeypatch, tmp_path, app_env, signature_kind):
    app = app_module.create_app(settings_for(app_env, tmp_path))
    database = app.state.db = MagicMock()
    apply_event, credit = Mock(), Mock()
    monkeypatch.setattr(api_billing, "_apply_payment_event", apply_event)
    monkeypatch.setattr(api_billing.ledger, "credit_topup", credit)
    signatures = {
        "missing": None,
        "malformed": "not-a-signature",
        "wrong": payments.sign("wrong-synthetic-secret", BODY),
        "stale": payments.sign(SECRET, BODY, int(time.time()) - 3600),
        "tampered": payments.sign(SECRET, BODY + b" "),
    }
    signature = signatures[signature_kind]
    headers = {} if signature is None else {"veyra-signature": signature}
    response = TestClient(app).post(WEBHOOK_PATH, content=BODY, headers=headers)

    assert response.status_code == 400
    assert response.json()["detail"] in {
        "missing signature", "malformed signature", "signature mismatch",
        "timestamp outside tolerance",
    }
    assert database.mock_calls == []
    apply_event.assert_not_called()
    credit.assert_not_called()
    assert_security_headers(response)
