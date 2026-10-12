"""Test-only synthetic SMA reports cross the real Python/JavaScript boundary.

No database, provider, browser, account, payment, or app demo data is used.
"""

import json
import subprocess
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from veyra_api import api_projects
from veyra_sim import ENGINE_NAME, ENGINE_VERSION, data, engine, metrics, report
from veyra_sim.sandbox import SandboxLimits, StrategyProcess

ROOT = Path(__file__).resolve().parents[1]

NODE_CHECK = r"""
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
globalThis.crypto ??= require('node:crypto').webcrypto;
const chart = require('./apps/web/chart-research.js');
const input = JSON.parse(readFileSync(process.argv[1], 'utf8'));
const { report, dataset, sourceBars, otherDataset } = input;
const text = JSON.stringify(report);
const context = { dataset, sourceBars };

// Use the app's real aggregation, as the existing home logic test does.
const source = readFileSync('./apps/web/app.js', 'utf8');
const start = source.indexOf('function aggregateBars(');
const end = source.indexOf('\nfunction clearTrends(');
assert.ok(start > 0 && end > start, 'Find the actual chart aggregation function');
const aggregate = runInNewContext(source.slice(start, end) + '; aggregateBars');

(async () => {
  const snapshot = await chart.validateReportJSON(text, context);
  assert.equal(snapshot.dataset_id, dataset.dataset_id);
  assert.equal(snapshot.instrument_id, dataset.instrument_id);
  assert.equal(snapshot.source_manifest_hash, dataset.manifest_hash);
  assert.equal(snapshot.subset_manifest_hash, report.provenance.dataset.manifest_hash);
  assert.equal(snapshot.run_inputs_hash, report.provenance.run_inputs_hash);
  assert.equal(snapshot.result_digest, report.result_digest);
  assert.equal(snapshot.complete, report.complete);
  assert.equal(snapshot.outcome, report.outcome);
  assert.deepEqual(snapshot.bars, report.bars);
  assert.equal(snapshot.source_data_verified, true);
  assert.equal(snapshot.provenance_verified, false);
  assert.match(snapshot.note, /Synthetic development data/);
  assert.match(snapshot.note, /unverified/);
  assert.equal(snapshot.fills.length, report.fills.length);
  for (const [index, fill] of snapshot.fills.entries()) {
    for (const key of ['ts', 'client_id', 'side', 'qty', 'price', 'fee', 'position_after']) {
      assert.equal(fill[key], report.fills[index][key]);
    }
    assert.equal(fill.index, index);
    assert.equal(fill.time, Date.parse(fill.ts) / 1000);
    assert.equal(fill.kind, fill.side === 'buy' ? 'entry' : 'exit');
  }

  for (const interval of chart.INTERVALS) {
    const candles = aggregate(sourceBars, interval);
    assert.ok(candles.length);
    const overlay = chart.buildOverlay(snapshot, { dataset, candles, interval });
    assert.equal(overlay.summary.totalFills, report.fills.length);
    assert.equal(overlay.summary.displayedFills, report.fills.length);
    assert.equal(overlay.summary.hiddenFills, 0);
    assert.equal(overlay.summary.entryFills, report.fills.filter(f => f.side === 'buy').length);
    assert.equal(overlay.summary.exitFills, report.fills.filter(f => f.side === 'sell').length);
    assert.equal(overlay.summary.source_data_verified, true);
    assert.equal(overlay.summary.provenance_verified, false);
    assert.ok(overlay.markers.length <= candles.length * 2);
    assert.deepEqual(overlay.groups.flatMap(group => group.fillIndices).sort((a, b) => a - b),
      report.fills.map((_, i) => i));
    for (const [i, group] of overlay.groups.entries()) {
      const marker = overlay.markers[i];
      assert.ok(candles.some(candle => candle.time === marker.time));
      assert.equal(marker.time, group.time);
      assert.equal(marker.shape, group.kind === 'entry' ? 'arrowUp' : 'arrowDown');
      assert.equal(marker.position, group.kind === 'entry' ? 'belowBar' : 'aboveBar');
      assert.equal(marker.text, group.count > 1 ? String(group.count) : '');
      assert.equal(group.count, group.fillIndices.length);
      for (const index of group.fillIndices) {
        assert.equal(chart.bucketTime(report.fills[index].ts, interval), marker.time);
        assert.equal(group.kind, report.fills[index].side === 'buy' ? 'entry' : 'exit');
      }
    }
    const visible = candles.slice(Math.floor(candles.length / 2));
    const times = new Set(visible.map(candle => candle.time));
    const cropped = chart.buildOverlay(snapshot, { dataset, candles: visible, interval });
    const expected = report.fills.filter(fill => times.has(chart.bucketTime(fill.ts, interval)));
    assert.equal(cropped.summary.displayedFills, expected.length);
    assert.equal(cropped.summary.hiddenFills, report.fills.length - expected.length);
  }

  await assert.rejects(() => chart.validateReportJSON(text,
    { dataset: otherDataset, sourceBars }), /selected dataset|Source coverage/);
  assert.throws(() => chart.buildOverlay(snapshot,
    { dataset: otherDataset, candles: [], interval: '1d' }), /exact synthetic dataset/);
  const alteredBars = sourceBars.map(bar => ({ ...bar }));
  alteredBars.at(-1).volume = '1.0000';
  await assert.rejects(() => chart.validateReportJSON(text,
    { dataset, sourceBars: alteredBars }), /Source data hash/);
  const alteredReport = structuredClone(report);
  alteredReport.provenance.dataset.manifest_hash = 'sha256:' + '0'.repeat(64);
  await assert.rejects(() => chart.validateReportJSON(JSON.stringify(alteredReport), context),
    /Source data hash/);
  process.stdout.write(JSON.stringify({ fills: snapshot.fills.length,
    intervals: chart.INTERVALS.length, outcome: snapshot.outcome }));
})().catch(error => { console.error(error); process.exitCode = 1; });
"""


@pytest.mark.parametrize("dataset_id", list(data.CATALOG))
@pytest.mark.parametrize("scope", ["subset", "full", "incomplete"])
def test_real_synthetic_sma_report_import_and_candle_overlays(tmp_path, dataset_id, scope):
    spec = data.CATALOG[dataset_id]
    start, end = "2021-01-01", "2021-07-01"
    if scope == "full":
        start = spec.start.isoformat()
        end = (spec.start + timedelta(days=spec.days)).isoformat()
    bars = data.load(dataset_id, start, end)
    params = {"fast": 3, "slow": 10}
    starting_cash = Decimal("10000")
    model = engine.ExecutionModel()
    files = api_projects._template("sma_cross")
    content = {"files": files, "entrypoint": "strategy.py"}
    processed = 0

    def progress(done, total):
        nonlocal processed
        processed = done

    with StrategyProcess(files, content["entrypoint"], SandboxLimits(cpu_seconds=30)) as proc:
        sim = engine.run(bars, spec.instrument, proc, starting_cash=starting_cash,
                         params=params, model=model,
                         should_stop=lambda: scope == "incomplete" and processed >= 90,
                         on_progress=progress, progress_every=1)

    assert sim.bars_total == len(bars) == (date.fromisoformat(end)
                                         - date.fromisoformat(start)).days
    assert sim.bars_processed == (90 if scope == "incomplete" else len(bars))
    assert sim.stopped_early == (scope == "incomplete")
    assert {fill["side"] for fill in sim.fills} == {"buy", "sell"}
    for fill in sim.fills:
        signal_index = int(fill["client_id"].split(":", 1)[0])
        assert fill["ts"] == bars[signal_index + 1].ts  # Actual next-bar executions.

    manifest = {
        "code": {"project_version_id": "test-only-sma-version", "version_no": 1,
                 "content_hash": report.digest(content), "entrypoint": content["entrypoint"]},
        "dataset": {"dataset_id": dataset_id, "provider": spec.provider,
                    "license": spec.license, "manifest_hash": data.manifest_hash(bars),
                    "start": start, "end": end, "bars": len(bars)},
        "engine": f"{ENGINE_NAME}=={ENGINE_VERSION}", "rate_version": "test-only-no-billing",
        "params": params, "starting_cash": str(starting_cash), "resource_class": "small",
        "quote_id": "test-only-no-quote",
    }
    manifest["run_inputs_hash"] = report.digest(manifest)
    result = report.build(
        run_id=f"test-only-synthetic-{dataset_id}-{scope}",
        outcome="incomplete" if sim.stopped_early else "completed", manifest=manifest,
        metrics=metrics.compute(sim.equity, starting_cash, sim.fills, sim.positions),
        sim=sim, model=model.describe(), quality=data.quality_findings(bars), receipt=None,
    )
    assert "Synthetic development data" in result["evidence_note"]
    assert "not evidence of real-world performance" in result["evidence_note"]
    assert result["metrics"]["fill_count"] == len(sim.fills)
    datasets = api_projects.catalog()["datasets"]
    dataset = next(item for item in datasets if item["dataset_id"] == dataset_id)
    assert (manifest["dataset"]["manifest_hash"] == dataset["manifest_hash"]) == (scope == "full")
    path = tmp_path / "test-only-synthetic-report.json"
    path.write_text(json.dumps({
        "report": result, "dataset": dataset,
        "sourceBars": api_projects.bars(dataset_id)["bars"],
        "otherDataset": next(item for item in datasets if item["dataset_id"] != dataset_id),
    }, default=str))
    checked = subprocess.run(["node", "-e", NODE_CHECK, str(path)], cwd=ROOT,
                             capture_output=True, text=True, timeout=30)
    assert checked.returncode == 0, checked.stdout + checked.stderr
    assert json.loads(checked.stdout) == {
        "fills": len(sim.fills), "intervals": 5, "outcome": result["outcome"],
    }


def test_trusted_bundled_sma_helper_layouts_match_single_file_subprocess():
    """Only the reviewed built-in SMA plus inert import adapters runs in these children."""
    source = api_projects._template("sma_cross")["strategy.py"]
    absolute = ("from veyra_fixture_package.crossover import SmaCross\n\n"
                "class EntryStrategy(SmaCross):\n    pass\n")
    relative = ("from .crossover import SmaCross\n\n"
                "class EntryStrategy(SmaCross):\n    pass\n")
    helpers = {"veyra_fixture_package/__init__.py": "",
               "veyra_fixture_package/crossover.py": source}
    layouts = [({"strategy.py": source}, "strategy.py"),
               (helpers | {"strategy.py": absolute}, "strategy.py"),
               (helpers | {"veyra_fixture_package/main.py": relative},
                "veyra_fixture_package/main.py")]
    dataset_id = next(iter(data.CATALOG))
    spec = data.CATALOG[dataset_id]
    bars = data.load(dataset_id, "2021-01-01", "2021-07-01")
    results = []
    for files, entrypoint in layouts:
        with StrategyProcess(files, entrypoint, SandboxLimits(cpu_seconds=30)) as proc:
            result = engine.run(bars, spec.instrument, proc, starting_cash=Decimal("10000"),
                                params={"fast": 3, "slow": 10}, model=engine.ExecutionModel())
        assert result.bars_processed == result.bars_total == len(bars)
        assert {fill["side"] for fill in result.fills} == {"buy", "sell"}
        results.append((result.equity, result.positions, result.fills, result.rejections))
    assert results[0] == results[1] == results[2]
