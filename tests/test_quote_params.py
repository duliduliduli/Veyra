"""Pure/model and in-process mocked HTTP checks; no strategy, database or network."""

import json
from copy import deepcopy
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from veyra_api import api_jobs
from veyra_api.auth import Principal, authenticate

VERSION = UUID("00000000-0000-0000-0000-000000000001")
BASE = {"project_version_id": str(VERSION), "dataset_id": "synth-btcusd-1d-v1",
        "start": "2021-01-01", "end": "2021-02-01"}
VALID = {"nested": [None, True, False, {}, [], 0, -42, 1.25, 0.00001,
                    9007199254740991, -9007199254740991, "9007199254740993", "é😀\t\n\r\b\f\x01"],
         "__proto__": {"label": "data"}, "constructor": 3}


def nested(depth):
    value = 0
    for _ in range(depth):
        value = {"x": value}
    return value


def quote(params):
    return api_jobs.QuoteIn(**BASE, params=params)


@pytest.mark.parametrize("params", [{}, VALID, nested(16)])
def test_valid_json_values_preserved_without_mutating_input(params):
    before = deepcopy(params)
    model = quote(params)
    assert params == before
    assert model.params == before
    assert json.loads(model.model_dump_json())["params"] == before


@pytest.mark.parametrize("params,detail", [
    (None, "JSON object"), ([], "JSON object"), (1, "JSON object"),
    (True, "JSON object"), ("{}", "JSON object"),
    *[({"nested": [value]}, "finite") for value in [float("inf"), float("-inf"), float("nan")]],
    *[({"x": value}, "integers.*strings") for value in [
        9007199254740992, 9007199254740993, -9007199254740993, 1e100, 9007199254740992.0]],
    *[({"x": value}, "Unicode without NUL") for value in ["\ud800", "\udfff", "\x00"]],
    *[({value: "x"}, "Unicode without NUL") for value in ["\ud800", "\udfff", "\x00"]],
    ({1: "x"}, "names must be strings"), ({"x": (1, 2)}, "only JSON values"),
    ({"x": Decimal("1.25")}, "only JSON values"), ({"x": {1, 2}}, "only JSON values"),
    (nested(17), "16 objects or arrays"),
])
def test_invalid_params_are_rejected_with_safe_detail(params, detail):
    with pytest.raises(HTTPException, match=detail) as error:
        quote(params)
    assert error.value.status_code == 422


@pytest.mark.parametrize("char,count", [("x", 8184), ("é", 4092), ("😀", 2046),
                                         ("\x01", 1364), ('"', 4092), ("\\", 4092)])
def test_compact_utf8_size_boundary_and_discovery_preservation(char, count):
    params = {"x": char * count}
    model = quote(params)
    saved = json.loads(model.model_dump_json())
    before = deepcopy(saved)
    assert api_jobs._authorization_request(saved, VERSION) == before
    assert saved == before
    with pytest.raises(HTTPException, match="8 KiB"):
        quote({"x": char * (count + 1)})


def test_array_container_depth_is_bounded_even_when_empty():
    value = []
    for _ in range(14):
        value = [value]
    quote({"x": value})
    with pytest.raises(HTTPException, match="16 objects or arrays"):
        quote({"x": [value]})


@pytest.fixture
def offline_quote(monkeypatch):
    app = FastAPI()
    app.include_router(api_jobs.router)
    database = app.state.db = MagicMock()
    app.state.settings = SimpleNamespace(max_job_runtime_seconds=300,
                                         max_job_customer_usd=Decimal("1"), quote_ttl_seconds=300)
    principal = Principal(UUID(int=2), "offline@example.test")
    app.dependency_overrides[authenticate] = lambda: principal
    load = MagicMock(return_value=["synthetic-bar"])
    monkeypatch.setattr(api_jobs.data, "load", load)
    monkeypatch.setattr(api_jobs.data, "manifest_hash", lambda bars: "synthetic-manifest")
    monkeypatch.setattr(api_jobs, "require", MagicMock())
    conn = database.tx.return_value.__enter__.return_value
    conn.execute.side_effect = AssertionError("unexpected query")
    return TestClient(app), database, conn, load


@pytest.mark.parametrize("params_json", [
    'null', '[]', '"text"', 'true', '1',
    '{"x":1e999}', '{"x":-1e999}', '{"x":NaN}', '{"x":Infinity}',
    '{"x":9007199254740993}', '{"x":-9007199254740993}',
    '{"x":"\\ud800"}', '{"\\udfff":1}', '{"x":"\\u0000"}',
    json.dumps(nested(17)), json.dumps({"x": "é" * 4093}),
])
def test_invalid_http_input_returns_safe_422_before_reads_or_insert(offline_quote, params_json):
    client, database, conn, load = offline_quote
    payload = json.dumps(BASE)[:-1] + ', "params":' + params_json + '}'
    response = client.post("/v1/quotes", content=payload,
                           headers={"content-type": "application/json"})
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert "params" not in response.json()
    database.tx.assert_not_called()
    conn.execute.assert_not_called()
    load.assert_not_called()


def test_quote_persists_and_hashes_the_same_valid_parameter_values(offline_quote):
    client, _, conn, _ = offline_quote
    pv = {"id": VERSION, "org_id": UUID(int=3), "content_hash": "synthetic-source"}
    result = {"id": str(UUID(int=4)), "input_hash": "stored-hash", "customer_max_nano": 1}
    conn.execute.side_effect = [SimpleNamespace(fetchone=lambda: pv),
                               SimpleNamespace(fetchone=lambda: result)]
    response = client.post("/v1/quotes", json=BASE | {"params": VALID})
    assert response.status_code == 201
    inputs = response.json()["inputs"]
    sql, arguments = conn.execute.call_args_list[1].args
    assert sql.startswith("INSERT INTO quotes")
    assert json.loads(arguments[2]) == inputs["request"]
    assert inputs["request"]["params"] == VALID
    assert arguments[3] == api_jobs.digest(inputs)
    assert len(conn.execute.call_args_list) == 2


def test_normal_binary64_parsing_and_exact_decimal_strings_remain_distinct():
    params = json.loads('{"value":9007199254740990.9,"exact":"9007199254740990.9"}')
    assert quote(params).params == {"value": 9007199254740991, "exact": "9007199254740990.9"}
