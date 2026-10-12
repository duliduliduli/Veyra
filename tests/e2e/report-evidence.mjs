// Pure synthetic report projection tests; no execution, network, server or browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import evidence from "../../apps/web/report-evidence.js";
const hash = (letter) => `sha256:${letter.repeat(64)}`;
const job = { id: "fixture-run", report_id: "fixture-report", project_version_id: "fixture-version",
  config: { input_hash: hash("b"), dataset_id: "fixture-synthetic-data" } };
const fixture = () => ({ run_id: job.id, schema_version: 1, complete: true, result_digest: hash("d"),
  evidence_grade: "platform-reproduced backtest", metrics: { version: "metrics-v2", percent_profitable: 0 },
  equity_curve: [["2024-01-01T00:00:00Z", "10000.0001"]], bars: { processed: 1, total: 1 },
  provenance: { code: { project_version_id: "fixture-version", version_no: 7, content_hash: hash("a"), entrypoint: "strategy.py" },
    run_inputs_hash: hash("b"), dataset: { dataset_id: "fixture-synthetic-data", provider: "veyra-synthetic",
      manifest_hash: hash("c"), start: "2024-01-01", end: "2024-01-02", bars: 1,
      license: "synthetic; not market data" }, engine: "veyra-sim==0.1.1", rate_version: "fixture-rate",
    params: { fast: 10, slow: 30 }, starting_cash: "10000", resource_class: "small", quote_id: "fixture-quote" },
  execution_model: { fidelity: "daily-bar", fill_timing: "next bar open", order_types: ["market"],
    position_model: "spot long-only, no leverage", taker_fee_bps: "10", slippage_bps: "5", not_modeled: ["market impact", "latency"] },
  quality_findings: [{ ts: "2024-01-01T00:00:00Z", check: "impossible_ohlc" }],
});
const read = (report = fixture(), currentJob = job, runId = job.id) => evidence.read(report, currentJob, runId);

test("projects exact recorded values without mutating or deriving provenance", () => {
  const report = fixture(), before = JSON.stringify(report), model = read(report);
  const source = Object.fromEntries(model.source), data = Object.fromEntries(model.data);
  assert.equal(source["Recorded source hash"], hash("a"));
  assert.equal(source["Recorded input hash"], hash("b"));
  assert.equal(source["Recorded data hash"], hash("c"));
  assert.equal(source["Recorded result digest"], hash("d"));
  assert.equal(source["Strategy version"], "v7");
  assert.equal(source["Metric version"], "metrics-v2");
  assert.equal(source["Parameters"], JSON.stringify(report.provenance.params, null, 2));
  assert.equal(data["Start (UTC, inclusive)"], "2024-01-01");
  assert.equal(data["End (UTC, exclusive)"], "2024-01-02");
  assert.equal(Object.fromEntries(model.execution)["Taker fee"], "10 bps");
  assert.deepEqual(model.limitations, ["market impact", "latency"]);
  assert.match(model.quality[0], /Impossible OHLC.*2024-01-01/);
  assert.match(model.note, /Synthetic development data.*Not market history.*not evidence of real-world performance/);
  assert.equal(JSON.stringify(report), before);
});

test("missing or mismatched report and job identity fail closed", () => {
  for (const run_id of [undefined, null, "", "other-run", 0]) assert.throws(() => read({ ...fixture(), run_id }), /identity/);
  assert.throws(() => read(fixture(), { ...job, id: "other" }), /identity/);
  assert.throws(() => read(fixture(), { ...job, report_id: null }), /identity/);
  assert.throws(() => read(fixture(), job, "other-view"), /identity/);
  assert.throws(() => read(null), /identity/);
});

test("conflicting recorded version, inputs or dataset fail closed", () => {
  for (const modify of [r => { r.provenance.code.project_version_id = "different"; },
    r => { r.provenance.run_inputs_hash = hash("e"); }, r => { r.provenance.dataset.dataset_id = "different"; }]) {
    const report = fixture(); modify(report); assert.throws(() => read(report), /inputs do not match/);
  }
});

test("legacy omissions stay unknown and never borrow today's catalog or job configuration", () => {
  const report = { run_id: job.id, metrics: {}, equity_curve: [] };
  const model = read(report), source = Object.fromEntries(model.source);
  assert.equal(source["Recorded input hash"], "Not recorded in this report");
  assert.equal(source["Strategy version ID"], "Not recorded in this report");
  assert.equal(source["Parameters"], "Not recorded in this report");
  assert.equal(Object.fromEntries(model.data)["Dataset ID"], "Not recorded in this report");
  assert.match(model.note, /Completion status was not recorded/);
  assert.match(model.qualitySummary, /data quality is unknown/);
  assert.match(model.limitations[0], /not recorded/);
  assert.equal(Object.fromEntries(model.execution)["Taker fee"], "Not recorded in this report");
  assert.deepEqual(model.equityRows, []);
});

test("zero values and explicitly empty collections are distinct from missing fields", () => {
  const report = fixture(); report.provenance.params = {}; report.provenance.starting_cash = 0;
  report.execution_model.taker_fee_bps = "0"; report.execution_model.slippage_bps = 0;
  report.execution_model.not_modeled = []; report.quality_findings = [];
  const model = read(report);
  assert.equal(Object.fromEntries(model.execution)["Taker fee"], "0 bps");
  assert.equal(Object.fromEntries(model.execution)["Slippage"], "0 bps");
  assert.equal(Object.fromEntries(model.source)["Starting cash (quote units)"], "0");
  assert.match(Object.fromEntries(model.source)["Parameters"], /empty recorded/);
  assert.match(model.qualitySummary, /No quality findings recorded.*not a comprehensive/);
  assert.match(model.limitations[0], /does not mean every execution effect was modeled/);
});

test("incomplete and missing-bar reports never acquire a completed label", () => {
  const report = fixture(); report.complete = false; report.bars = { processed: 0, total: 20 };
  assert.match(read(report).note, /Incomplete run: 0 of 20 bars.*Not a finished/);
  delete report.bars;
  assert.match(read(report).note, /Incomplete run: Not recorded/);
});

test("unreadable metrics and invalid, nonfinite or unordered chart data fail closed", () => {
  for (const metrics of [null, [], "wrong"]) assert.throws(() => read({ ...fixture(), metrics }), /metrics/);
  for (const equity_curve of [undefined, null, [["bad-date", "1"]], [["2024-01-01", "NaN"]], [["2024-01-01", null]],
    [["2024-01-01", ""]], [["2024-01-01", "Infinity"]], [["2024-01-01", "1"], ["2024-01-01", "2"]],
    [["2024-01-02", "1"], ["2024-01-01", "2"]]]) assert.throws(() => read({ ...fixture(), equity_curve }), /equity curve/);
});

test("quality preview is bounded, counts the whole list and preserves unknown findings", () => {
  const report = fixture(); report.quality_findings = Array.from({ length: 55 }, () => ({ ts: "2024-01-01", check: "source_gap", detail: "fixture-only" }));
  const model = read(report);
  assert.equal(model.quality.length, 50);
  assert.match(model.qualitySummary, /55 recorded.*first 50.*Report JSON contains the full list/);
  assert.match(model.quality[0], /source_gap.*fixture-only/);
});

test("unexpected optional shapes are unavailable, not stringified as valid assumptions", () => {
  const report = fixture(); report.execution_model = { taker_fee_bps: {}, slippage_bps: "-1", not_modeled: {}, order_types: [null] };
  report.provenance.params = []; report.quality_findings = {};
  const model = read(report);
  assert.equal(Object.fromEntries(model.execution)["Taker fee"], "Not recorded in this report");
  assert.equal(Object.fromEntries(model.execution)["Slippage"], "Not recorded in this report");
  assert.equal(Object.fromEntries(model.source)["Parameters"], "Not recorded in this report");
  assert.match(model.qualitySummary, /unknown/);
});

test("chart and metric values accept canonical decimal exponents but reject coercion formats", () => {
  const report = fixture(); report.equity_curve[0][1] = "1.00000000E+4"; report.metrics.net_return = "-1.25e-2";
  assert.equal(read(report).equity[0].value, 10000);
  for (const value of ["0x10", "0b10", " 10 ", "+10", "1_000", {}, true, []]) {
    assert.throws(() => read({ ...fixture(), equity_curve: [["2024-01-01", value]] }), /equity curve/);
    assert.throws(() => read({ ...fixture(), metrics: { net_return: value } }), /metrics/);
  }
});

test("impossible calendar dates and ambiguous local timestamps cannot become chart points", () => {
  for (const ts of ["2024-02-30", "2023-02-29T00:00:00Z", "2024-01-01T24:00:00Z", "2024-01-01T00:00:00", "01/01/2024"]) {
    assert.throws(() => read({ ...fixture(), equity_curve: [[ts, "10000"]] }), /equity curve/);
  }
  assert.equal(read({ ...fixture(), equity_curve: [["2024-02-29T01:00:00+01:00", "10000"]] }).equity[0].time, Date.parse("2024-02-29T00:00:00Z") / 1000);
});

test("malformed present identity pins fail rather than silently disabling matching", () => {
  for (const value of [{}, 42, [], ""]) {
    const report = fixture(); report.provenance.code.project_version_id = value;
    assert.throws(() => read(report), /inputs do not match/);
  }
});

test("a recorded note containing a partial synthetic disclaimer cannot suppress the complete warning", () => {
  const report = fixture(); report.evidence_note = "Not market history is the name of this fixture.";
  assert.match(read(report).note, /Synthetic development data\. Not market history and not evidence of real-world performance\./);
});

test("profitability bounds and counts cannot imply impossible closed-trade results", () => {
  for (const metrics of [{ percent_profitable: -1 }, { percent_profitable: 101 }, { closed_trade_count: -1 },
    { winning_trade_count: 0.5 }, { fill_count: Number.MAX_SAFE_INTEGER + 1 }, { trade_count: -1 },
    { max_drawdown_days: -1 }, { closed_trade_count: 0, percent_profitable: 0 }, { closed_trade_count: 1, winning_trade_count: 2 }]) {
    assert.throws(() => read({ ...fixture(), metrics }), /invalid|inconsistent/);
  }
  assert.doesNotThrow(() => read({ ...fixture(), metrics: { closed_trade_count: 1, winning_trade_count: 0, percent_profitable: "0E-8" } }));
});

test("completion flags, recorded outcomes and processed counts cannot contradict the fetched job", () => {
  for (const [extras, currentJob] of [[{ complete: true }, { ...job, outcome: "incomplete" }],
    [{ complete: true, outcome: "failed" }, job], [{ complete: false }, { ...job, outcome: "completed" }],
    [{ outcome: "failed" }, { ...job, outcome: "incomplete" }], [{ complete: 1 }, job],
    [{ bars: { processed: 2, total: 1 } }, job], [{ bars: { processed: 0, total: 1 } }, job],
    [{ bars: { processed: -1, total: 1 } }, job]]) {
    assert.throws(() => read({ ...fixture(), ...extras }, currentJob), /completion|bar counts/);
  }
  assert.doesNotThrow(() => read({ ...fixture(), complete: false, outcome: "incomplete", bars: { processed: 0, total: 10 } }, { ...job, outcome: "incomplete" }));
  assert.match(read({ run_id: job.id, metrics: {}, equity_curve: [] }, { ...job, outcome: "completed" }).note, /Completion status was not recorded/);
});

test("quality check names never resolve inherited object properties", () => {
  const report = fixture(); report.quality_findings = [{ check: "constructor", ts: "2024-01-01" }, { check: "__proto__", ts: "2024-01-01" }];
  assert.deepEqual(read(report).quality, ["constructor · 2024-01-01", "__proto__ · 2024-01-01"]);
});

test("exact equity rows retain recorded numeric strings and timestamps without changing chart values", () => {
  const values = ["10000.000100", "1.00000000E+4", "-0.0000", "-1.234567890123456789", "1e-999", "9007199254740993.0001", 0, -42.5, 1e4, -0, "-0"];
  const report = fixture();
  report.equity_curve = values.map((value, index) => [`2024-01-${String(index + 1).padStart(2, "0")}T02:03:04.10+01:00`, value]);
  const before = JSON.stringify(report), model = read(report);
  assert.deepEqual(model.equityRows, report.equity_curve.map(([timestamp, value]) => ({ timestamp, value: String(value) })));
  assert.deepEqual(model.equity, report.equity_curve.map(([timestamp, value]) => ({ time: Math.floor(Date.parse(timestamp) / 1000), value: Number(value) })));
  assert.ok(Object.is(model.equity[2].value, -0));
  assert.equal(JSON.stringify(report), before);
});

test("exact rows do not relax second-level ordering or timestamp and numeric validation", () => {
  for (const equity_curve of [
    [["2024-01-01T00:00:00.001Z", "1"], ["2024-01-01T00:00:00.002Z", "2"]],
    [["2024-01-01T00:00:00.0001Z", "1"]],
    [["2024-01-01", "1"], ["2024-01-02", "1e999"]],
    [["2024-01-01", "1"], ["2024-01-02", "<b>2</b>"]],
  ]) assert.throws(() => read({ ...fixture(), equity_curve }), /equity curve/);
});
