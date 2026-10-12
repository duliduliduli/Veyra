"""Safe request rejection through the real app, without startup or persisted state."""

import json
from typing import Annotated
from unittest.mock import MagicMock, Mock
from uuid import UUID

import pytest
from fastapi import Cookie, Header, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from pydantic import BaseModel, field_validator
from veyra_api import api_jobs, config
from veyra_api import app as app_module
from veyra_api.api_publications import NoStoreRoute
from veyra_api.auth import Principal, authenticate
from veyra_api.storage import ObjectStore

IDENTIFIER = str(UUID(int=1))
QUOTE = {"project_version_id": IDENTIFIER, "dataset_id": "synth-btcusd-1d-v1",
         "start": "2021-01-01", "end": "2021-02-01"}
MESSAGE = "Invalid request; check the request schema"


@pytest.fixture
def offline_client(monkeypatch, tmp_path):
    guards = []
    for target, name in ((config, "load"), (app_module, "migrate"), (app_module, "Database"),
                         (api_jobs.data, "load")):
        guard = Mock(side_effect=AssertionError("runtime configuration or execution forbidden"))
        monkeypatch.setattr(target, name, guard)
        guards.append(guard)
    objects = MagicMock(spec=ObjectStore)
    for method in (objects.get, objects.put, objects.exists):
        method.side_effect = AssertionError("object access forbidden")
    monkeypatch.setattr(app_module, "ObjectStore", Mock(return_value=objects))
    settings = config.Settings("production", "unused-test-only", tmp_path, "unused-test-only",
                               15, 900, 1800, "1.00")
    app = app_module.create_app(settings)
    database = app.state.db = MagicMock()
    database.tx.side_effect = AssertionError("database access forbidden")
    app.dependency_overrides[authenticate] = lambda: Principal(UUID(int=2), "test@example.test")
    # No context manager: starting the application lifespan would migrate a real database.
    yield TestClient(app)
    for guard in guards:
        guard.assert_not_called()
    assert database.mock_calls == []
    assert objects.mock_calls == []
    assert list(tmp_path.iterdir()) == []


def assert_headers(response):
    assert response.headers["cache-control"] == "no-store"
    assert "etag" not in response.headers and "last-modified" not in response.headers
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


def assert_rejected(response, *sources):
    assert response.status_code == 422, response.text
    assert response.json() == {"detail": [
        {"loc": [source], "msg": MESSAGE, "type": "value_error"} for source in sources
    ]}
    assert len(response.content) <= 512
    assert response.headers["content-type"] == "application/json"
    assert_headers(response)


def post_raw(client, path, body):
    # httpx's json= rejects NaN/Infinity itself; exercise the server's real parsing boundary.
    return client.post(path, content=json.dumps(body), headers={"content-type": "application/json"})


@pytest.mark.parametrize("field", (
    "starting_cash", "max_runtime_seconds", "taker_fee_bps", "slippage_bps",
    "project_version_id", "start", "end",
))
@pytest.mark.parametrize("value", (float("inf"), float("-inf"), float("nan"), "\ud800", "\udfff"))
def test_quote_rejected_values_cannot_break_error_serialization(offline_client, field, value):
    assert_rejected(post_raw(offline_client, "/v1/quotes", QUOTE | {field: value}), "body")


@pytest.mark.parametrize("field", ("name", "description", "folder"))
@pytest.mark.parametrize("value", ("\ud800", "\udfff", "private\x00value", float("nan")))
def test_project_rejected_metadata_is_not_echoed(offline_client, field, value):
    assert_rejected(post_raw(offline_client, f"/v1/orgs/{IDENTIFIER}/projects",
                             {"name": "Fixture", field: value}), "body")


@pytest.mark.parametrize("body", (
    b'{"name":"private value","description":}', b'{"name":"\\ud800",]',
    b'{"name":"private\x00value"}', b'{"name":NaN,', b'',
))
def test_malformed_or_missing_json_is_a_safe_422(offline_client, body):
    response = offline_client.post(f"/v1/orgs/{IDENTIFIER}/projects", content=body,
                                   headers={"content-type": "application/json"})
    assert_rejected(response, "body")


@pytest.mark.parametrize("body", (float("nan"), float("inf"), [], "private-\ud800", None))
def test_rejected_top_level_body_values_are_not_echoed(offline_client, body):
    assert_rejected(post_raw(offline_client, f"/v1/orgs/{IDENTIFIER}/projects", body), "body")


def test_invalid_utf8_body_keeps_existing_parser_http_error(offline_client):
    response = offline_client.post(f"/v1/orgs/{IDENTIFIER}/projects", content=b"\xff",
                                   headers={"content-type": "application/json"})
    assert response.status_code == 400
    assert response.json() == {"detail": "There was an error parsing the body"}
    assert_headers(response)


def test_existing_path_query_and_header_validation(offline_client):
    assert_rejected(offline_client.get("/v1/projects/private-invalid-uuid"), "path")
    assert_rejected(offline_client.get("/v1/projects/猫"), "path")
    assert_rejected(offline_client.get(f"/v1/orgs/{IDENTIFIER}/projects?limit=private"), "query")
    assert_rejected(offline_client.get(f"/v1/orgs/{IDENTIFIER}/projects?limit=∞"), "query")
    response = offline_client.post("/v1/jobs", json={"authorization_id": IDENTIFIER},
                                   headers={"idempotency-key": "short"})
    assert_rejected(response, "header")


@pytest.mark.parametrize("field,value", (
    ("title", "\ud800"), ("description", "\udfff"), ("project_version_id", "\ud800"),
    ("project_version_id", float("nan")), ("confirm_public", float("inf")),
    ("private-\ud800", "private-value"),
))
def test_publication_wrapper_uses_the_same_safe_handler(offline_client, field, value):
    body = {"project_version_id": IDENTIFIER, "title": "Fixture", "description": "Fixture",
            "confirm_public": True, field: value}
    response = offline_client.post(f"/v1/projects/{IDENTIFIER}/publications",
                                   content=json.dumps(body),
                                   headers={"idempotency-key": "fixture-key",
                                            "content-type": "application/json"})
    assert_rejected(response, "body")


def test_publication_malformed_json_path_query_and_header(offline_client):
    response = offline_client.post(f"/v1/projects/{IDENTIFIER}/publications",
                                   content='{"title":"private",',
                                   headers={"content-type": "application/json"})
    assert_rejected(response, "body")
    assert_rejected(offline_client.get("/v1/public/strategies/private-invalid-uuid"), "path")
    assert_rejected(offline_client.get("/v1/public/strategies?limit=private"), "query")
    response = offline_client.post(f"/v1/projects/{IDENTIFIER}/publications",
                                   json={"project_version_id": IDENTIFIER, "title": "Fixture",
                                         "description": "Fixture", "confirm_public": True},
                                   headers={"idempotency-key": "private invalid key"})
    assert_rejected(response, "header")


class Numbers(BaseModel):
    numbers: list[int]


def test_multiple_sources_have_fixed_order_and_bounded_details(offline_client):
    reached = Mock()

    def endpoint(item_id: int, body: Numbers, q: int = Query(), x: int = Header(),
                 c: int = Cookie()):
        reached()

    offline_client.app.router.routes.insert(0, APIRoute("/v1/probe/{item_id}", endpoint,
                                                      methods=["POST"]))
    response = offline_client.post("/v1/probe/private-path?q=private-query",
                                   headers={"x": "private-header", "cookie": "c=private-cookie"},
                                   json={"numbers": ["private-body"] * 1000})
    assert_rejected(response, "path", "query", "header", "cookie", "body")
    reached.assert_not_called()


def test_many_unicode_extra_keys_cannot_leak_through_error_locations(offline_client):
    body = {f"private-\ud800-\x00-\u202e-{index}-" + "é" * 1000: float("nan")
            for index in range(100)}
    assert_rejected(post_raw(offline_client, f"/v1/orgs/{IDENTIFIER}/projects", body), "body")


class QueryFields(BaseModel):
    model_config = {"extra": "forbid"}
    limit: int = 1


@pytest.mark.parametrize("key", ("private-query-field", "私密-field-\x00-\u202e"))
def test_extra_query_keys_are_not_exposed_as_field_locations(offline_client, key):
    def endpoint(query: Annotated[QueryFields, Query()]):
        pytest.fail("invalid request reached endpoint")

    offline_client.app.router.routes.insert(0, APIRoute("/v1/probe", endpoint))
    assert_rejected(offline_client.get("/v1/probe", params={key: "private-input"}), "query")


class RejectPrivateMessage(BaseModel):
    value: str

    @field_validator("value")
    @classmethod
    def reject(cls, value):
        raise ValueError(f"private validator context: {value!r}")


@pytest.mark.parametrize("value", ("\ud800", "private-token", "é\u202e\x00猫"))
def test_custom_validator_messages_and_exception_contexts_stay_private(offline_client, value):
    def endpoint(body: RejectPrivateMessage):
        pytest.fail("invalid request reached endpoint")

    offline_client.app.router.routes.insert(0, APIRoute("/v1/probe", endpoint, methods=["POST"]))
    assert_rejected(post_raw(offline_client, "/v1/probe", {"value": value}), "body")


def test_validation_error_fallback_does_not_serialize_or_mutate_exception_data(offline_client):
    opaque = Mock()
    errors = [{"loc": (), "msg": "private-\ud800", "type": "private-\udfff",
               "input": float("inf"), "ctx": {"error": opaque}}]

    def endpoint():
        raise RequestValidationError(errors, body={"private": "\ud800"})

    offline_client.app.router.routes.insert(0, APIRoute("/v1/probe", endpoint))
    assert_rejected(offline_client.get("/v1/probe"), "request")
    assert errors[0]["msg"] == "private-\ud800" and errors[0]["input"] == float("inf")
    assert errors[0]["ctx"]["error"] is opaque
    assert opaque.mock_calls == []


@pytest.mark.parametrize("route_class", (APIRoute, NoStoreRoute))
@pytest.mark.parametrize("status", (400, 401, 403, 404, 409, 410, 422, 429, 500, 503))
def test_domain_http_exceptions_preserve_status_details_and_headers(
        offline_client, status, route_class):
    detail = {"reason": "domain error", "info": ["é", 1]}

    def endpoint():
        raise HTTPException(status, detail, headers={"Retry-After": "7", "ETag": "private",
                                                    "Last-Modified": "private"})

    offline_client.app.router.routes.insert(0, route_class("/v1/probe", endpoint))
    response = offline_client.get("/v1/probe")
    assert response.status_code == status
    assert response.json() == {"detail": detail}
    assert response.headers["retry-after"] == "7"
    assert_headers(response)


@pytest.mark.parametrize("route_class", (APIRoute, NoStoreRoute))
@pytest.mark.parametrize("exception", (RuntimeError, ValueError))
def test_unexpected_errors_remain_generic_500s(offline_client, exception, route_class):
    def endpoint():
        raise exception("private unexpected failure")

    offline_client.app.router.routes.insert(0, route_class("/v1/probe", endpoint))
    response = offline_client.get("/v1/probe")
    assert response.status_code == 500
    assert response.json() == {"detail": "Internal Server Error"}
    assert_headers(response)


@pytest.mark.parametrize("response_validation", (False, True))
def test_internal_model_validation_is_not_reclassified_as_request_failure(
        offline_client, response_validation):
    def endpoint():
        if not response_validation:
            Numbers.model_validate({"numbers": ["private-internal-value"]})
        return "private-response-value"

    offline_client.app.router.routes.insert(0, APIRoute("/v1/probe", endpoint, response_model=int))
    response = offline_client.get("/v1/probe")
    assert response.status_code == 500
    assert response.json() == {"detail": "Internal Server Error"}
    assert_headers(response)


def test_real_domain_validation_and_production_identity_stay_unchanged(offline_client):
    response = post_raw(offline_client, "/v1/quotes", QUOTE | {"end": "2020-01-01"})
    assert response.status_code == 422
    assert response.json() == {"detail": "start must be before end"}
    assert_headers(response)
    offline_client.app.dependency_overrides.clear()
    response = offline_client.get("/v1/me", headers={"x-veyra-dev-user": "ignored@example.test"})
    assert response.status_code == 401
    assert response.json() == {"detail": "authentication required"}
    assert_headers(response)


def test_success_values_and_documented_validation_array_stay_compatible(offline_client):
    def endpoint(body: dict):
        return body

    offline_client.app.router.routes.insert(0, APIRoute("/v1/probe", endpoint, methods=["POST"]))
    body = {"label": " café 猫 🐈 \n", "values": [2**60, 1.25, None, True]}
    response = offline_client.post("/v1/probe", json=body)
    assert response.status_code == 200
    assert response.json() == body
    assert_headers(response)
    schema = offline_client.app.openapi()
    error_ref = schema["paths"]["/v1/quotes"]["post"]["responses"]["422"]["content"]
    assert error_ref["application/json"]["schema"] == {
        "$ref": "#/components/schemas/HTTPValidationError"}
    detail_schema = schema["components"]["schemas"]["HTTPValidationError"]["properties"]["detail"]
    assert detail_schema["type"] == "array"
    assert detail_schema["items"] == {"$ref": "#/components/schemas/ValidationError"}
    assert schema["components"]["schemas"]["ValidationError"]["required"] == ["loc", "msg", "type"]
