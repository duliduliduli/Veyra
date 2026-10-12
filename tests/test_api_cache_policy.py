"""API responses are not browser/proxy caches for private or revocable data."""

from unittest.mock import MagicMock
from uuid import uuid4

from fastapi.testclient import TestClient
from veyra_api.app import create_app
from veyra_api.auth import Principal, authenticate
from veyra_api.config import Settings


def test_api_cache_policy_and_production_identity_stay_closed(tmp_path):
    settings = Settings("production", "unused-test-only", tmp_path, "unused-test-only",
                        15, 900, 1800, "1.00")
    app = create_app(settings)
    app.state.db = MagicMock()
    conn = app.state.db.tx.return_value.__enter__.return_value
    conn.execute.return_value.fetchall.return_value = []
    # No context manager: lifespan/database migration must not run for this offline middleware test.
    client = TestClient(app)
    for path, status in [
        ("/v1/catalog/datasets", 200),
        ("/v1/public/strategies", 200),
        ("/v1/public/strategies/not-a-uuid", 422),
        ("/v1/me", 401),
        ("/v1/projects/00000000-0000-4000-8000-000000000001", 401),
        ("/v1/no-such-route", 404),
    ]:
        response = client.get(path, headers={"x-veyra-dev-user": "ignored@example.test"})
        assert response.status_code == status, response.text
        assert response.headers["cache-control"] == "no-store"
        assert "etag" not in response.headers and "last-modified" not in response.headers
        assert response.headers["x-content-type-options"] == "nosniff"
    app.state.db.tx.assert_called_once()  # Only anonymous public discovery touched its mock.
    assert client.get("/healthz").json() == {"ok": True}


def test_private_unexpected_error_is_generic_and_keeps_security_headers(tmp_path):
    settings = Settings("production", "unused-test-only", tmp_path, "unused-test-only",
                        15, 900, 1800, "1.00")
    app = create_app(settings)
    app.state.db = MagicMock()
    app.state.db.tx.side_effect = RuntimeError("private internal error detail")
    app.dependency_overrides[authenticate] = lambda: Principal(uuid4(), "test@example.test")
    response = TestClient(app, raise_server_exceptions=False).get(f"/v1/projects/{uuid4()}")
    assert response.status_code == 500
    assert response.json() == {"detail": "Internal Server Error"}
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert "private internal" not in response.text
    assert "etag" not in response.headers and "last-modified" not in response.headers
