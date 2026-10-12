"""Approved-input preflight regressions, using only intercepted reads and inert source."""

import copy
import json
import subprocess
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import psycopg
import pytest
from veyra_billing import RATE_CARD_V1
from veyra_scheduler import worker as worker_module
from veyra_sim import ENGINE_NAME, ENGINE_VERSION
from veyra_sim.report import digest


@pytest.fixture(autouse=True)
def no_external_execution(monkeypatch):
    for target, name in ((worker_module, "StrategyProcess"), (subprocess, "Popen"),
                         (psycopg, "connect")):
        monkeypatch.setattr(target, name, Mock(side_effect=AssertionError("execution forbidden")))
    monkeypatch.setattr(worker_module.engine, "run",
                        Mock(side_effect=AssertionError("simulation forbidden")))


@pytest.fixture
def preflight(monkeypatch):
    org_id, version_id, auth_id, quote_id, project_id = [uuid4() for _ in range(5)]
    content = {"files": {"strategy.py": "# inert source; never executed\r\n"},
               "entrypoint": "strategy.py"}
    request = {"project_version_id": str(version_id), "dataset_id": "fixture-data",
               "start": "2021-01-01", "end": "2021-01-03", "starting_cash": "10000",
               "params": {"window": 1, "nested": {"enabled": True}}, "resource_class": "small",
               "max_runtime_seconds": 60, "taker_fee_bps": "10", "slippage_bps": "5"}
    engine = f"{ENGINE_NAME}=={ENGINE_VERSION}"
    rate = RATE_CARD_V1.version
    bars = ["inert bar fixture"]
    data_hash = "sha256:fixture-data"
    spec = SimpleNamespace(dataset_id="fixture-data", provider="fixture", license="fixture")
    monkeypatch.setattr(worker_module.data, "CATALOG", {spec.dataset_id: spec})
    monkeypatch.setattr(worker_module.data, "load", Mock(return_value=bars))
    monkeypatch.setattr(worker_module.data, "manifest_hash", Mock(return_value=data_hash))
    inputs = {"code": digest(content), "data": data_hash, "engine": engine,
              "rates": rate, "request": request}
    input_hash = digest(inputs)
    version = {"id": version_id, "org_id": org_id, "project_id": project_id, "version_no": 1,
               "content_hash": digest(content), "entrypoint": content["entrypoint"],
               "object_key": "fixture-source"}
    quote = {"id": quote_id, "org_id": org_id, "project_version_id": version_id,
             "request": copy.deepcopy(request), "input_hash": input_hash, "rate_version": rate,
             "customer_max_nano": 10000000}
    auth = {"id": auth_id, "org_id": org_id, "quote_id": quote_id, "input_hash": input_hash,
            "status": "reserved", "reserved_nano": quote["customer_max_nano"]}
    cfg = copy.deepcopy(request) | {"quote_id": str(quote_id), "input_hash": input_hash,
                                    "rate_version": rate, "engine": engine}
    job = {"id": uuid4(), "project_version_id": version_id, "authorization_id": auth_id,
           "org_id": org_id, "config": cfg}
    case = SimpleNamespace(job=job, cfg=cfg, request=request, version=version, quote=quote,
                           auth=auth, bars=bars, spec=spec, content=content, inputs=inputs)
    connection = Mock()

    def execute(sql, params):
        if "FROM project_versions" in sql:
            row = case.version
        elif "FROM quotes" in sql:
            row = case.quote
        elif "FROM authorizations" in sql:
            row = case.auth
        else:
            raise AssertionError("unexpected SQL: " + sql)
        assert sql.startswith("SELECT ")
        return SimpleNamespace(fetchone=lambda: row)

    connection.execute.side_effect = execute
    database, store = Mock(), Mock()
    database.tx.side_effect = lambda: nullcontext(connection)
    store.get.return_value = json.dumps(content).encode()
    worker = worker_module.Worker.__new__(worker_module.Worker)
    worker.db, worker.store = database, store
    case.worker, case.connection, case.store = worker, connection, store
    return case


def test_valid_preflight_preserves_exact_approved_values_without_running(preflight):
    content, manifest, bars, spec = preflight.worker._prepare(preflight.job)
    assert content == preflight.content and bars == preflight.bars and spec is preflight.spec
    assert manifest["run_inputs_hash"] == preflight.quote["input_hash"]
    assert manifest["params"] == preflight.quote["request"]["params"]
    assert manifest["starting_cash"] == preflight.quote["request"]["starting_cash"]
    assert manifest["engine"] == preflight.cfg["engine"]
    worker_module.StrategyProcess.assert_not_called()
    preflight.store.put.assert_not_called()


@pytest.mark.parametrize(("field", "changed"), [
    ("params", {"window": 999}), ("starting_cash", "999999"),
    ("taker_fee_bps", "999"), ("slippage_bps", "999"),
    ("max_runtime_seconds", 9999), ("resource_class", "large"),
])
def test_job_execution_inputs_cannot_drift_from_the_approved_quote(preflight, field, changed):
    preflight.cfg[field] = changed
    with pytest.raises(worker_module._PreconditionFailed, match="requote"):
        preflight.worker._prepare(preflight.job)
    worker_module.StrategyProcess.assert_not_called()


@pytest.mark.parametrize(("field", "changed"), [
    ("params", {"window": True, "nested": {"enabled": True}}),
    ("params", {"window": 1.0, "nested": {"enabled": True}}),
    ("params", {"window": 1, "nested": {"enabled": 1}}),
    ("params", {"window": 1, "nested": {"enabled": True}, "extra": None}),
    ("starting_cash", 10000), ("max_runtime_seconds", 60.0),
    ("dataset_id", "other-data"), ("start", "2020-01-01"), ("end", "2022-01-01"),
    ("project_version_id", str(uuid4())), ("quote_id", str(uuid4())),
    ("input_hash", "sha256:changed"), ("rate_version", "unknown-rate"),
    ("engine", "other-engine==0.1.2"), ("unexpected", "extra"),
])
def test_exact_request_and_pinned_metadata_are_type_sensitive(preflight, field, changed):
    preflight.cfg[field] = changed
    with pytest.raises(worker_module._PreconditionFailed, match="requote"):
        preflight.worker._prepare(preflight.job)
    preflight.store.get.assert_not_called()
    worker_module.data.load.assert_not_called()


@pytest.mark.parametrize("field", ["params", "max_runtime_seconds", "quote_id", "input_hash",
                                   "engine", "rate_version", "project_version_id"])
def test_incomplete_job_config_fails_closed(preflight, field):
    del preflight.cfg[field]
    with pytest.raises(worker_module._PreconditionFailed, match="requote"):
        preflight.worker._prepare(preflight.job)
    preflight.store.get.assert_not_called()


def test_key_order_does_not_change_the_approved_request(preflight):
    preflight.job["config"] = dict(reversed(list(preflight.cfg.items())))
    preflight.job["config"]["params"] = {"nested": {"enabled": True}, "window": 1}
    preflight.worker._prepare(preflight.job)


def bind_approved_hash(case):
    """Build internally consistent, originally approved fixture rows without normalization."""
    case.inputs.update(code=case.version["content_hash"], rates=case.quote["rate_version"],
                       request=case.quote["request"])
    value = digest(case.inputs)
    case.cfg["input_hash"] = case.quote["input_hash"] = case.auth["input_hash"] = value


@pytest.mark.parametrize(("field", "value"), [
    ("starting_cash", 10000), ("starting_cash", 10000.0), ("starting_cash", "10000.00"),
    ("taker_fee_bps", 10), ("slippage_bps", 5.0),
    ("params", {"threshold": 1.0, "limit": 9007199254740993, "active": True}),
])
def test_unchanged_legacy_numeric_json_is_not_reserialized_by_a_transport_model(
        preflight, field, value):
    preflight.quote["request"][field] = copy.deepcopy(value)
    preflight.cfg[field] = copy.deepcopy(value)
    bind_approved_hash(preflight)
    preflight.worker._prepare(preflight.job)
    assert type(preflight.cfg[field]) is type(value)
    assert preflight.cfg[field] == value


@pytest.mark.parametrize(("row", "field", "changed"), [
    ("job", "org_id", uuid4()), ("version", "org_id", uuid4()),
    ("quote", "org_id", uuid4()), ("auth", "org_id", uuid4()),
    ("job", "project_version_id", uuid4()), ("version", "id", uuid4()),
    ("quote", "project_version_id", uuid4()), ("quote", "id", uuid4()),
    ("job", "authorization_id", uuid4()), ("auth", "id", uuid4()),
    ("auth", "quote_id", uuid4()), ("auth", "status", "settled"),
    ("auth", "input_hash", "sha256:changed"), ("quote", "input_hash", "sha256:changed"),
    ("quote", "rate_version", "other-rate"),
    ("auth", "reserved_nano", 10000001), ("auth", "reserved_nano", 9999999),
    ("quote", "customer_max_nano", 9999999), ("quote", "customer_max_nano", 10000001),
])
def test_job_approval_quote_version_and_organization_must_agree(preflight, row, field, changed):
    getattr(preflight, row)[field] = changed
    with pytest.raises(worker_module._PreconditionFailed, match="requote"):
        preflight.worker._prepare(preflight.job)
    preflight.store.get.assert_not_called()


@pytest.mark.parametrize("row", ["version", "quote", "auth"])
def test_missing_persisted_identity_fails_closed(preflight, row):
    setattr(preflight, row, None)
    with pytest.raises(worker_module._PreconditionFailed, match="requote"):
        preflight.worker._prepare(preflight.job)
    preflight.store.get.assert_not_called()


def test_version_lookup_requires_its_project_and_organization(preflight):
    preflight.worker._prepare(preflight.job)
    statement, params = preflight.connection.execute.call_args_list[0].args
    assert "JOIN projects p" in statement
    assert "p.id = v.project_id AND p.org_id = v.org_id" in statement
    assert params == (preflight.job["project_version_id"],)


def test_quote_and_job_changes_cannot_replace_the_authorized_hash(preflight):
    preflight.cfg["starting_cash"] = preflight.quote["request"]["starting_cash"] = "12345"
    preflight.inputs["request"] = preflight.quote["request"]
    preflight.cfg["input_hash"] = preflight.quote["input_hash"] = digest(preflight.inputs)
    with pytest.raises(worker_module._PreconditionFailed, match="requote"):
        preflight.worker._prepare(preflight.job)


@pytest.mark.parametrize(("field", "changed"), [("rate_version", "unknown-rate"),
                                               ("resource_class", "unknown-resource")])
def test_unavailable_rate_metadata_is_not_replaced_with_an_invented_fallback(
        preflight, field, changed):
    preflight.cfg[field] = changed
    if field == "rate_version":
        preflight.quote[field] = changed
    else:
        preflight.quote["request"][field] = changed
    bind_approved_hash(preflight)
    with pytest.raises(worker_module._PreconditionFailed, match="requote"):
        preflight.worker._prepare(preflight.job)
    preflight.store.get.assert_not_called()


@pytest.mark.parametrize("case", ["hash", "row_entrypoint", "invalid_json", "missing",
                                  "extra_field", "wrong_type", "missing_entrypoint",
                                  "traversal", "empty_files", "too_large"])
def test_snapshot_is_structurally_and_cryptographically_verified_before_launch(preflight, case):
    content = copy.deepcopy(preflight.content)
    if case == "hash":
        content["files"]["strategy.py"] = "# changed, still never executed"
    elif case == "row_entrypoint":
        preflight.version["entrypoint"] = "other.py"
    elif case == "invalid_json":
        preflight.store.get.return_value = b"not JSON"
    elif case == "missing":
        preflight.store.get.side_effect = FileNotFoundError("fixture")
    elif case == "extra_field":
        content["extra"] = "ignored?"
    elif case == "wrong_type":
        content["files"]["strategy.py"] = 123
    elif case == "missing_entrypoint":
        del content["entrypoint"]
    elif case == "traversal":
        content = {"files": {"../strategy.py": "# inert"}, "entrypoint": "../strategy.py"}
        preflight.version["entrypoint"] = content["entrypoint"]
    elif case == "empty_files":
        content["files"] = {}
    elif case == "too_large":
        content["files"]["strategy.py"] = "x" * (256 * 1024 + 1)
    if case not in ("invalid_json", "missing"):
        preflight.store.get.return_value = json.dumps(content).encode()
    if case not in ("hash", "row_entrypoint", "invalid_json", "missing"):
        preflight.version["content_hash"] = digest(content)
        bind_approved_hash(preflight)
    with pytest.raises(worker_module._PreconditionFailed, match="snapshot integrity"):
        preflight.worker._prepare(preflight.job)
    worker_module.data.load.assert_not_called()
    worker_module.StrategyProcess.assert_not_called()


def test_worker_uses_the_shared_trusted_snapshot_loader():
    from veyra_api.api_projects import _load_snapshot
    assert worker_module._load_snapshot is _load_snapshot


def test_changed_dataset_hash_still_requires_requote(preflight):
    worker_module.data.manifest_hash.return_value = "sha256:changed-data"
    with pytest.raises(worker_module._PreconditionFailed, match="requote"):
        preflight.worker._prepare(preflight.job)


@pytest.mark.parametrize(("field", "changed"), [
    ("params", {"window": 999}), ("max_runtime_seconds", None),
    ("max_runtime_seconds", "not a runtime"), ("max_runtime_seconds", {}),
    ("taker_fee_bps", None), ("starting_cash", "not cash"),
    ("rate_version", "unknown-rate"), ("resource_class", "unknown-resource"),
])
def test_preflight_faults_do_not_launch_and_reach_finish_with_zero_billing(
        preflight, monkeypatch, field, changed):
    preflight.cfg[field] = changed
    thread = Mock()
    monkeypatch.setattr(worker_module.threading, "Thread", Mock(return_value=thread))
    preflight.worker._finish = Mock()
    claim = worker_module.Claim(preflight.job, uuid4(), 1)
    preflight.worker.execute(claim)
    args = preflight.worker._finish.call_args.args
    assert args[:4] == (claim, "failed", "approved execution inputs are inconsistent; requote", 0)
    assert args[4:] == (None, {}, [])
    worker_module.StrategyProcess.assert_not_called()
    worker_module.engine.run.assert_not_called()
    thread.join.assert_called_once_with(timeout=5)
    # _finish is intercepted: unknown persisted billing metadata still needs operator repair.


def test_valid_rate_snapshot_fault_is_not_a_customer_strategy_error(preflight, monkeypatch):
    preflight.store.get.return_value = b"invalid snapshot"
    monkeypatch.setattr(worker_module.threading, "Thread", Mock())
    preflight.worker._finish = Mock()
    preflight.worker.execute(worker_module.Claim(preflight.job, uuid4(), 1))
    args = preflight.worker._finish.call_args.args
    assert args[1:5] == ("failed", "code snapshot integrity check failed", 0, None)
    worker_module.StrategyProcess.assert_not_called()
