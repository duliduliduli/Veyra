"""Runtime import semantics are part of reproducible quoted inputs; no execution or DB."""

import json
import tomllib
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock
from uuid import uuid4

import pytest
from veyra_api import api_jobs
from veyra_billing import RATE_CARD_V1
from veyra_scheduler import worker as worker_module
from veyra_sim import ENGINE_NAME, ENGINE_VERSION, data
from veyra_sim.report import digest

ROOT = Path(__file__).resolve().parents[1]


def test_runtime_versions_match_workspace_lock_and_both_input_hash_producers():
    def metadata(path):
        return tomllib.loads((ROOT / path).read_text())["project"]["version"]

    locked = {p["name"]: p["version"] for p in
              tomllib.loads((ROOT / "uv.lock").read_text())["package"]}
    assert metadata("runtimes/simulator/pyproject.toml") == ENGINE_VERSION == "0.1.2"
    assert locked["veyra-sim"] == ENGINE_VERSION
    assert metadata("packages/python-sdk/pyproject.toml") == locked["veyra-sdk"] == "0.1.1"
    assert api_jobs.ENGINE_VERSION == worker_module.ENGINE_VERSION == ENGINE_VERSION


@pytest.mark.parametrize("quoted_engine", ["0.1.0", "0.1.1", "0.1.2"])
def test_prepare_requires_exact_quoted_runtime_before_any_execution(monkeypatch, quoted_engine):
    content = {"files": {"strategy.py": "# inert fixture; never executed\r\n"},
               "entrypoint": "strategy.py"}
    spec = next(iter(data.CATALOG.values()))
    org_id, version_id, auth_id, quote_id = [uuid4() for _ in range(4)]
    request = {"project_version_id": str(version_id), "dataset_id": spec.dataset_id,
               "start": "2021-01-01", "end": "2021-01-03",
               "params": {}, "starting_cash": "10000", "resource_class": "small",
               "max_runtime_seconds": 60, "taker_fee_bps": "10", "slippage_bps": "5"}
    cfg = request | {"quote_id": str(quote_id), "rate_version": RATE_CARD_V1.version,
                     "engine": f"{ENGINE_NAME}=={ENGINE_VERSION}"}
    bars = data.load(cfg["dataset_id"], cfg["start"], cfg["end"])
    inputs = {"code": digest(content), "data": data.manifest_hash(bars),
              "engine": f"{ENGINE_NAME}=={quoted_engine}", "rates": cfg["rate_version"],
              "request": request}
    cfg["input_hash"] = digest(inputs)
    version = {"id": version_id, "org_id": org_id, "version_no": 1,
               "content_hash": digest(content),
               "entrypoint": content["entrypoint"], "object_key": "fixture-source"}
    connection = Mock()
    quote = {"id": quote_id, "org_id": org_id, "project_version_id": version_id,
             "request": request, "input_hash": cfg["input_hash"],
             "rate_version": cfg["rate_version"], "customer_max_nano": 10000000}
    auth = {"id": auth_id, "org_id": org_id, "quote_id": quote_id, "status": "reserved",
            "input_hash": cfg["input_hash"], "reserved_nano": quote["customer_max_nano"]}
    connection.execute.return_value.fetchone.side_effect = [version, quote, auth]
    database = Mock()
    database.tx.return_value = nullcontext(connection)
    store = Mock()
    store.get.return_value = json.dumps(content).encode()
    process = Mock(side_effect=AssertionError("strategy execution forbidden"))
    monkeypatch.setattr(worker_module, "StrategyProcess", process)
    # Only exercise the read-only preparation method, not claim/execute or worker setup.
    worker = worker_module.Worker.__new__(worker_module.Worker)
    worker.db, worker.store = database, store
    job = {"project_version_id": version["id"], "org_id": org_id,
           "authorization_id": auth_id, "config": cfg}
    if quoted_engine == ENGINE_VERSION:
        prepared, manifest, actual_bars, actual_spec = worker._prepare(job)
        assert prepared == content and actual_bars == bars and actual_spec == spec
        assert manifest["engine"] == f"{ENGINE_NAME}=={ENGINE_VERSION}"
        assert manifest["run_inputs_hash"] == cfg["input_hash"]
    else:
        with pytest.raises(worker_module._PreconditionFailed, match="requote"):
            worker._prepare(job)
    process.assert_not_called()
    assert connection.execute.call_count == 3
    assert all(call.args[0].startswith("SELECT ") for call in connection.execute.call_args_list)
