// node --test tests/e2e/chart-research.mjs
// Fixtures below are test-only synthetic reports, never app demo trades or performance claims.
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import chart from "../../apps/web/chart-research.js";

const { rsi, bucketTime, validateReportJSON, buildOverlay, LIMITS } = chart;
const H = "sha256:" + "a".repeat(64);
const seconds = (ts) => Date.parse(ts) / 1000;
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const sourceBars = Array.from({ length: 460 }, (_, i) => ({
  ts: new Date(Date.UTC(2023, 11, 20 + i)).toISOString().replace(".000", ""),
  open: "100.00", high: "105.00", low: "95.00", close: String(100 + i % 3) + ".00", volume: "1000.0000",
}));
function manifest(bars) {
  return "sha256:" + createHash("sha256").update("ts,open,high,low,close,volume\n" +
    bars.map((bar) => [bar.ts, bar.open, bar.high, bar.low, bar.close, bar.volume].join(",")).join("\n") + "\n").digest("hex");
}
const dataset = { dataset_id: "synth-btcusd-1d-v1", instrument_id: "SYNTH:BTC-USD",
  provider: "veyra-synthetic", resolution: "1d", price_basis: "synthetic last", quote_currency: "USD",
  coverage_start: sourceBars[0].ts, coverage_end: sourceBars.at(-1).ts, bars: sourceBars.length,
  license: "synthetic; unrestricted internal/dev use; not market data", manifest_hash: manifest(sourceBars) };
const context = { dataset, sourceBars };
function fill(index, side, qty, after, id = String(index)) {
  return { ts: sourceBars[index].ts, client_id: `${index}:${id}`, side, qty,
    price: "100.00", fee: "0.10000000", cash_after: "9000.00", position_after: after };
}
function fixture({ from = 0, to = sourceBars.length, processed = to - from, fills } = {}) {
  const rows = sourceBars.slice(from, to);
  const end = new Date(Date.parse(rows.at(-1).ts) + 864e5).toISOString().slice(0, 10);
  return { schema_version: 1, run_id: "test-only-run", outcome: processed === rows.length ? "completed" : "incomplete",
    evidence_grade: "platform-reproduced backtest",
    evidence_note: "Synthetic development data. Not market history and not evidence of real-world performance.",
    complete: processed === rows.length, bars: { total: rows.length, processed },
    metrics: { version: "metrics-v2", fill_count: (fills || []).length, percent_profitable: null, closed_trade_count: 0,
      winning_trade_count: 0, trade_count: 0, total_fees: "0.00000000", net_return: null,
      definitions: { percent_profitable: "Test-only fixture" }, monthly_returns: { "2024-01": "0.00000000" } },
    execution_model: { fidelity: "daily-bar", fill_timing: "next bar open", order_types: ["market"],
      taker_fee_bps: "10", slippage_bps: "5", position_model: "spot long-only, no leverage",
      not_modeled: ["partial fills", "latency", "intrabar path"] },
    quality_findings: [], equity_curve: rows.slice(0, processed).map((b) => [b.ts, "10000.00000000"]),
    fills: fills || [], rejections: [], strategy_logs: [],
    provenance: { run_inputs_hash: H, code: { project_version_id: "test-only-version", version_no: 1,
      content_hash: H, entrypoint: "main.py" }, dataset: { dataset_id: dataset.dataset_id,
      provider: dataset.provider, license: dataset.license, manifest_hash: manifest(rows),
      start: rows[0].ts.slice(0, 10), end, bars: rows.length }, engine: "veyra-sim==0.1.1",
      rate_version: "test-only", params: { strategy_parameter: 3 }, starting_cash: "10000",
      resource_class: "small", quote_id: "test-only-quote" }, receipt: null, result_digest: H };
}
const parse = (report, ctx = context) => validateReportJSON(JSON.stringify(report), ctx);
const candles = (interval, bars = sourceBars) => [...new Set(bars.map((b) => bucketTime(b.ts, interval)))].map((time) => ({ time }));

test("UMD loads as CommonJS and validates in a plain browser global without DOM, network or Python", async () => {
  const sandbox = { TextEncoder, crypto: webcrypto };
  vm.runInNewContext(readFileSync(new URL("../../apps/web/chart-research.js", import.meta.url), "utf8"), sandbox);
  assert.equal(typeof sandbox.VeyraChartResearch.validateReportJSON, "function");
  assert.equal(sandbox.VeyraChartResearch.rsi([1, 2], 1)[1], 100);
  const report = await sandbox.VeyraChartResearch.validateReportJSON(JSON.stringify(fixture()), context);
  assert.equal(report.source_data_verified, true);
  assert.ok(Object.isFrozen(chart));
});

test("Unavailable Web Crypto reports the verification blocker and never pretends success", async () => {
  const sandbox = { TextEncoder };
  vm.runInNewContext(readFileSync(new URL("../../apps/web/chart-research.js", import.meta.url), "utf8"), sandbox);
  await assert.rejects(sandbox.VeyraChartResearch.validateReportJSON(JSON.stringify(fixture()), context), /Web Crypto is required/);
});

test("RSI14 seeds from exactly 14 changes, then Wilder smoothing (hand-computable fractions)", () => {
  const closes = Array.from({ length: 15 }, (_, i) => 10 + i % 2).concat(12, 11);
  const values = rsi(closes);
  assert.equal(values.length, closes.length);
  assert.deepEqual(values.slice(0, 14), Array(14).fill(null));
  assert.equal(values[14], 50);
  closeTo(values[15], 100 * 17 / 30);
  closeTo(values[16], 100 * 221 / 418);
  assert.deepEqual(closes, Array.from({ length: 15 }, (_, i) => 10 + i % 2).concat(12, 11));
});

test("RSI period 3 exact seed and repeated recurrence", () => {
  const values = rsi([1, 2, 3, 2, 4, 3, 5], 3);
  assert.deepEqual(values.slice(0, 3), [null, null, null]);
  [200 / 3, 250 / 3, 2000 / 33, 235 / 3].forEach((value, i) => closeTo(values[i + 3], value));
});

test("RSI upward/downward/flat and retained smoothed history", () => {
  assert.deepEqual(rsi(Array.from({ length: 18 }, (_, i) => i + 1)).slice(14), [100, 100, 100, 100]);
  assert.deepEqual(rsi(Array.from({ length: 18 }, (_, i) => 20 - i)).slice(14), [0, 0, 0, 0]);
  assert.deepEqual(rsi(Array(18).fill(10)).slice(14), [50, 50, 50, 50]);
  assert.deepEqual(rsi([1, 2, 3, 4, 4, 4], 3), [null, null, null, 100, 100, 100]);
  assert.deepEqual(rsi([2, 1, 2, 2], 1), [null, 0, 100, 50]);
});

test("RSI gaps restart a complete warmup; null, strings, holes, NaN and infinities are never zeros", () => {
  for (const gap of [null, undefined, "3", NaN, Infinity, -Infinity]) {
    assert.deepEqual(rsi([1, 2, 3, gap, 5, 6, 7, 8], 2), [null, null, 100, null, null, null, 100, 100]);
  }
  const sparse = [1, 2, 3]; sparse.length = 5; sparse.push(6, 7, 8);
  assert.deepEqual(rsi(sparse, 2), [null, null, 100, null, null, null, null, 100]);
  assert.deepEqual(rsi([1, 2]), [null, null]);
  assert.deepEqual(rsi([]), []);
  assert.throws(() => rsi([], 0)); assert.throws(() => rsi([], 1.5));
  assert.throws(() => rsi(Array(LIMITS.bars + 1).fill(1)));
  assert.deepEqual(rsi([-Number.MAX_VALUE, Number.MAX_VALUE, 1, 2], 1), [null, null, null, 100]);
});

test("UTC bucket origins and exact boundaries match existing intervals", () => {
  assert.equal(bucketTime("1970-01-01T00:00:00Z", "1d"), 0);
  assert.equal(bucketTime("1969-12-31T23:59:59Z", "3d"), -3 * 86400);
  assert.equal(bucketTime("1970-01-03T23:59:59Z", "3d"), 0);
  assert.equal(bucketTime("1970-01-04T00:00:00Z", "3d"), 3 * 86400);
  assert.equal(bucketTime("1970-01-04T23:59:59Z", "1w"), -3 * 86400);
  assert.equal(bucketTime("1970-01-05T00:00:00Z", "1w"), 4 * 86400);
  assert.equal(bucketTime("1970-01-05T00:00:00Z", "30w"), 4 * 86400);
  assert.equal(bucketTime((4 + 210) * 86400 - 1, "30w"), 4 * 86400);
  assert.equal(bucketTime((4 + 210) * 86400, "30w"), (4 + 210) * 86400);
  assert.equal(bucketTime("2024-02-29T23:59:59Z", "1M"), seconds("2024-02-01T00:00:00Z"));
  assert.equal(bucketTime("2024-03-01T00:30:00+01:00", "1M"), seconds("2024-02-01T00:00:00Z"));
  assert.equal(bucketTime("2024-01-01T00:00:00Z", "1M"), seconds("2024-01-01T00:00:00Z"));
  for (const value of ["2023-02-29T00:00:00Z", "2024-02-30T00:00:00Z", "2024-01-01", "2024-01-01T24:00:00Z", "2024-01-01T00:00:60Z", "2024-01-01T00:00:00+24:00", NaN, Infinity]) {
    assert.throws(() => bucketTime(value, "1d"));
  }
  assert.throws(() => bucketTime(0, "15m"));
});

test("Buckets match the actual app aggregateBars implementation for all current intervals", () => {
  const app = readFileSync(new URL("../../apps/web/app.js", import.meta.url), "utf8");
  const code = app.slice(app.indexOf("function aggregateBars("), app.indexOf("\nfunction clearTrends("));
  assert.ok(code.startsWith("function aggregateBars("));
  const aggregate = vm.runInNewContext(`${code}\naggregateBars`);
  for (const interval of chart.INTERVALS) {
    assert.deepEqual(Array.from(aggregate(sourceBars, interval), (b) => b.time), candles(interval).map((b) => b.time));
  }
});

test("Valid report import verifies full and range-subset data hashes and retains minimal immutable fields", async () => {
  const input = fixture({ from: 10, to: 90, fills: [fill(12, "buy", "0.10", "0.10")] });
  assert.notEqual(input.provenance.dataset.manifest_hash, dataset.manifest_hash);
  const report = await parse(input);
  assert.equal(report.source_data_verified, true);
  assert.equal(report.provenance_verified, false);
  assert.match(report.note, /unverified/);
  assert.match(report.note, /not market history, live trades/);
  assert.equal(report.fills.length, 1);
  assert.equal(report.fills[0].qty, "0.10");
  assert.equal(report.source_manifest_hash, dataset.manifest_hash);
  for (const key of ["metrics", "receipt", "strategy_logs", "provenance", "params"]) assert.equal(report[key], undefined);
  assert.ok(Object.isFrozen(report) && Object.isFrozen(report.fills[0]) && Object.isFrozen(report.range));
  assert.throws(() => { report.fills[0].qty = "100"; }, TypeError);
  assert.throws(() => buildOverlay({ ...report }, { dataset, candles: [], interval: "1d" }), /validate/);
});

test("Entry/partial exit grouping uses only actual fills, with no labels beyond group counts", async () => {
  const fills = [fill(1, "buy", "0.10", "0.10", "a"), fill(1, "buy", "0.20", "0.30", "b"),
    fill(1, "sell", "0.10", "0.20", "c"), fill(2, "sell", "0.20", "0", "d"), fill(100, "buy", "1", "1")];
  const report = await parse(fixture({ fills }));
  const overlay = buildOverlay(report, { dataset, candles: candles("1d"), interval: "1d" });
  assert.deepEqual(overlay.groups.map((g) => [g.kind, g.count, g.fillIndices]),
    [["entry", 2, [0, 1]], ["exit", 1, [2]], ["exit", 1, [3]], ["entry", 1, [4]]]);
  assert.deepEqual(overlay.markers.map((m) => [m.shape, m.position, m.text]),
    [["arrowUp", "belowBar", "2"], ["arrowDown", "aboveBar", ""], ["arrowDown", "aboveBar", ""], ["arrowUp", "belowBar", ""]]);
  assert.deepEqual(overlay.markers.map((m) => m.color), ["#141414", "#ff5a1f", "#ff5a1f", "#141414"]);
  assert.equal(overlay.summary.totalFills, 5);
  assert.equal(overlay.summary.entryFills, 3);
  assert.equal(overlay.summary.exitFills, 2);
  assert.equal(overlay.summary.hiddenFills, 0);
  assert.equal(overlay.summary.markerCount, 4);
});

test("All interval/range mappings show only displayed buckets, including a clipped first full candle", async () => {
  const fills = [fill(1, "buy", "1", "1"), fill(2, "buy", "1", "2"), fill(31, "sell", "1", "1"),
    fill(70, "sell", "1", "0"), fill(250, "buy", "1", "1"), fill(459, "sell", "1", "0")];
  const report = await parse(fixture({ fills }));
  for (const interval of chart.INTERVALS) {
    const all = candles(interval);
    for (const visible of [all, all.slice(1, -1), all.slice(0, 1), []]) {
      const overlay = buildOverlay(report, { dataset, candles: visible, interval });
      const keys = new Set(visible.map((b) => b.time));
      const expected = report.fills.filter((f) => keys.has(bucketTime(f.time, interval)));
      assert.equal(overlay.summary.displayedFills, expected.length);
      assert.equal(overlay.summary.hiddenFills, fills.length - expected.length);
      assert.ok(overlay.markers.every((marker) => keys.has(marker.time)));
      assert.ok(overlay.markers.length <= visible.length * 2);
      assert.deepEqual(overlay.groups.flatMap((g) => g.fillIndices).sort((a, b) => a - b), expected.map((f) => f.index));
    }
  }
});

test("Empty/incomplete reports do not invent trades or conceal incomplete status", async () => {
  const report = await parse(fixture({ processed: 0 }));
  const result = buildOverlay(report, { dataset, candles: candles("1w"), interval: "1w" });
  assert.deepEqual(result.markers, []); assert.deepEqual(result.groups, []);
  assert.equal(result.summary.totalFills, 0); assert.equal(result.summary.complete, false);
  assert.equal(result.summary.outcome, "incomplete");
});

test("Actual ancillary schema shapes are accepted then discarded, including billed receipt details", async () => {
  const input = fixture();
  input.rejections = [{ client_id: "1:test", ts: sourceBars[1].ts, reason: "insufficient_cash" },
    { client_id: "459:last", reason: "expired_at_end" }];
  input.quality_findings = [{ ts: sourceBars[0].ts, check: "test_only" }];
  input.strategy_logs = [{ ts: sourceBars[0].ts, message: "" },
    { ts: sourceBars[0].ts, message: "😀".repeat(500) }];
  input.receipt = { currency: "USD", rate_version: "test-only", rate_source: "test fixture",
    platform_fee_bps: 2000, authorized_max_nano: 10000, supplier_cost_nano: 1000,
    platform_fee_nano: 200, customer_charge_nano: 1200, absorbed_by_platform_nano: 0,
    released_nano: 8800, tax_nano: null, charge_usd: "0.0000012",
    lines: [{ supplier: "test-only", meter: "compute", units: "10", unit: "task-second",
      supplier_cost_nano: 1000, detail: { resource_class: "small", vcpus: "1", memory_gb: "1" } }] };
  const report = await parse(input);
  for (const key of ["receipt", "quality_findings", "strategy_logs", "rejections"]) assert.equal(report[key], undefined);
});

test("Report size, count, depth, strings and unsafe keys are bounded before interpretation", async () => {
  await assert.rejects(validateReportJSON("{"), /valid JSON/);
  await assert.rejects(validateReportJSON(" ".repeat(LIMITS.reportBytes + 1)), /4 MiB/);
  await assert.rejects(validateReportJSON('"' + "é".repeat(LIMITS.reportBytes / 2) + '"'), /4 MiB/);
  let input = fixture(); input.fills = Array(LIMITS.fills + 1).fill({});
  await assert.rejects(parse(input), /limit/);
  input = fixture(); input.strategy_logs = [{ ts: sourceBars[0].ts, message: "x".repeat(1001) }];
  await assert.rejects(parse(input), /bounded string/);
  input = fixture(); input.provenance.params.deep = "x".repeat(LIMITS.stringLength + 1);
  await assert.rejects(parse(input), /overlong/);
  await assert.rejects(validateReportJSON('{"constructor":{}}'), /unsafe/);
  await assert.rejects(validateReportJSON('{"__proto__":{}}'), /unsafe/);
  await assert.rejects(validateReportJSON('['.repeat(20) + "0" + ']'.repeat(20)), /safe limits/);
  await assert.rejects(validateReportJSON('{"x":1e999}'), /non-finite/);
});

test("Unknown fields and versions fail closed at every consumed structural boundary", async () => {
  for (const mutate of [
    (r) => { r.unknown = 1; }, (r) => { r.schema_version = 2; },
    (r) => { r.provenance.dataset.symbol = "BTC"; }, (r) => { r.provenance.live = true; },
    (r) => { r.provenance.code.script = "print('secret')"; },
    (r) => { r.execution_model.signals = []; }, (r) => { r.bars.approximate = true; },
    (r) => { r.metrics.unrecognized_performance = "1000"; }, (r) => { r.metrics.version = "future"; },
    (r) => { r.fills[0].signal = "made up"; }, (r) => { delete r.fills[0].price; },
  ]) {
    const input = fixture({ fills: [fill(1, "buy", "1", "1")] }); mutate(input);
    await assert.rejects(parse(input));
  }
});

test("Dataset identity, source content, instrument, provider, range and subset hashes cannot be substituted", async () => {
  for (const mutate of [
    (r) => { r.provenance.dataset.dataset_id = "synth-ethusd-1d-v1"; },
    (r) => { r.provenance.dataset.provider = "live"; }, (r) => { r.provenance.dataset.license = "market data"; },
    (r) => { r.provenance.dataset.manifest_hash = H; }, (r) => { r.provenance.dataset.start = "2024-02-30"; },
    (r) => { r.provenance.dataset.end = r.provenance.dataset.start; },
    (r) => { r.provenance.dataset.bars--; }, (r) => { r.provenance.run_inputs_hash = "missing"; },
  ]) { const input = fixture(); mutate(input); await assert.rejects(parse(input)); }
  for (const override of [{ dataset_id: "unknown" }, { instrument_id: "SYNTH:ETH-USD" },
    { provider: "some-other-synthetic" }, { resolution: "1m" }, { manifest_hash: H },
    { bars: 12 }, { coverage_end: sourceBars[3].ts }, { price_basis: "live last" }]) {
    await assert.rejects(parse(fixture(), { dataset: { ...dataset, ...override }, sourceBars }));
  }
  const modified = structuredClone(sourceBars); modified[3].close = "102.01";
  await assert.rejects(parse(fixture(), { dataset, sourceBars: modified }), /hash/);
  const report = await parse(fixture());
  for (const override of [{ dataset_id: "synth-ethusd-1d-v1", instrument_id: "SYNTH:ETH-USD" },
    { manifest_hash: H }, { provider: "live" }, { instrument_id: "BTC-USD" }]) {
    assert.throws(() => buildOverlay(report, { dataset: { ...dataset, ...override }, candles: [], interval: "1d" }));
  }
});

test("Malformed, non-finite, non-positive, out-of-range or inconsistent fills are rejected", async () => {
  for (const [key, value] of [["qty", "0"], ["qty", "-1"], ["qty", "NaN"], ["qty", 1], ["qty", "1e999"],
    ["qty", "1e-400"], ["price", "Infinity"], ["price", "0"], ["price", true], ["price", "0x64"],
    ["price", " 100 "], ["fee", "-0.1"], ["position_after", "2"], ["cash_after", "-1"],
    ["side", "short"], ["client_id", "x".repeat(161)], ["ts", "2024-02-30T00:00:00Z"],
    ["ts", "2024-01-01"], ["ts", "2024-01-01T12:00:00Z"], ["ts", "2030-01-01T00:00:00Z"]]) {
    const input = fixture({ fills: [fill(1, "buy", "1", "1")] }); input.fills[0][key] = value;
    await assert.rejects(parse(input), undefined, `${key}=${value}`);
  }
  await assert.rejects(parse(fixture({ fills: [fill(1, "sell", "1", "0")] })), /long-only/);
  await assert.rejects(parse(fixture({ fills: [fill(2, "buy", "1", "1"), fill(1, "sell", "1", "0")] })), /ordered/);
  await assert.rejects(parse(fixture({ from: 10, to: 30, fills: [fill(5, "buy", "1", "1")] })), /processed source/);
  await assert.rejects(parse(fixture({ processed: 2, fills: [fill(2, "buy", "1", "1")] })), /processed source/);
  const input = fixture({ fills: [fill(1, "buy", "1", "1")] }); input.metrics.fill_count = 10;
  await assert.rejects(parse(input), /fill count/);
});

test("Exact decimal positions handle 0.1+0.2 and scientific notation without float drift", async () => {
  const input = fixture({ fills: [fill(1, "buy", "0.1", "0.1"), fill(2, "buy", "2e-1", "0.3"),
    fill(3, "sell", "0.3000", "0")] });
  input.fills[0].client_id = "0:" + "😀".repeat(64);
  const report = await parse(input);
  assert.equal(report.fills.length, 3);
});

test("Malformed bar status, equity, execution models and ancillary metadata fail safely", async () => {
  for (const mutate of [
    (r) => { r.complete = false; }, (r) => { r.outcome = "live"; },
    (r) => { r.bars.processed--; }, (r) => { r.bars.total++; },
    (r) => { r.equity_curve.pop(); }, (r) => { r.equity_curve[0][0] = sourceBars[1].ts; },
    (r) => { r.equity_curve[0][1] = "NaN"; },
    (r) => { r.execution_model.position_model = "shorting allowed"; },
    (r) => { r.execution_model.fill_timing = "signal close"; },
    (r) => { r.execution_model.slippage_bps = "1001"; },
    (r) => { r.metrics.net_return = " "; }, (r) => { r.metrics.fill_count = -1; },
    (r) => { r.metrics.monthly_returns["2024-13"] = "0"; },
    (r) => { r.evidence_grade = "live results"; }, (r) => { r.receipt = { unknown: 1 }; },
  ]) { const input = fixture(); mutate(input); await assert.rejects(parse(input)); }
});

test("Bad displayed ranges and unsupported intervals never produce misplaced markers", async () => {
  const report = await parse(fixture());
  for (const shown of [[{ time: 0 }], [{ time: candles("1d")[0].time + 1 }],
    [candles("1d")[1], candles("1d")[0]], [candles("1d")[0], candles("1d")[0]],
    [{ time: NaN }], [{ time: "2024-01-01" }]]) {
    assert.throws(() => buildOverlay(report, { dataset, candles: shown, interval: "1d" }));
  }
  assert.throws(() => buildOverlay(report, { dataset, candles: [], interval: "15m" }));
});

test("Dense repeated fills produce at most two compact markers per bucket", async () => {
  const fills = Array.from({ length: 2000 }, (_, i) => fill(1, i % 2 ? "sell" : "buy", "1", i % 2 ? "0" : "1", String(i)));
  const report = await parse(fixture({ fills }));
  const overlay = buildOverlay(report, { dataset, candles: candles("30w"), interval: "30w" });
  assert.equal(overlay.markers.length, 2);
  assert.deepEqual(overlay.markers.map((marker) => marker.text), ["1000", "1000"]);
  assert.equal(overlay.groups.reduce((sum, group) => sum + group.fillIndices.length, 0), 2000);
});


test("Monthly returns accept finite signed Decimal exponent notation with bounded size", async () => {
  for (const value of ["0E-8", "-1.25E-2", "2e+1", "0.00000000", null]) {
    const report = fixture(); report.metrics.monthly_returns["2024-01"] = value;
    await parse(report);
  }
  for (const value of ["1e999", "1e1000", "Infinity", "NaN", "", "1".repeat(81), 0]) {
    const report = fixture(); report.metrics.monthly_returns["2024-01"] = value;
    await assert.rejects(parse(report), /Invalid monthly return/);
  }
});
