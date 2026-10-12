// DOM integration checks; no browser, HTTP server, real API calls, or source publication.
// NODE_PATH=/tmp/veyra-test-tools/node_modules node --test tests/e2e/chart-ui.mjs
// shortcut: chart rendering and native dialog focus are stubbed; use browser QA for layout and focus traps.
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import research from "../../apps/web/chart-research.js";

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "chart-tools.js", "workspace-store.js", "studio-assistant.js", "saved-links.js", "proposal-diff.js", "strategy-backup.js", "report-evidence.js", "app.js"].map((name) =>
  readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
const plain = (value) => JSON.parse(JSON.stringify(value));
const H = `sha256:${"a".repeat(64)}`;
const sourceBars = Array.from({ length: 460 }, (_, i) => ({
  ts: new Date(Date.UTC(2023, 11, 20 + i)).toISOString().replace(".000", ""),
  open: "100.00", high: "110.00", low: "90.00", close: `${100 + (i * 7 % 11) - 5}.00`, volume: "1000.0000",
}));
const manifest = (bars) => "sha256:" + createHash("sha256").update("ts,open,high,low,close,volume\n" +
  bars.map((bar) => [bar.ts, bar.open, bar.high, bar.low, bar.close, bar.volume].join(",")).join("\n") + "\n").digest("hex");
const dataset = { dataset_id: "synth-btcusd-1d-v1", instrument_id: "SYNTH:BTC-USD", provider: "veyra-synthetic",
  resolution: "1d", price_basis: "synthetic last", quote_currency: "USD", coverage_start: sourceBars[0].ts,
  coverage_end: sourceBars.at(-1).ts, bars: sourceBars.length, manifest_hash: manifest(sourceBars),
  license: "synthetic; unrestricted internal/dev use; not market data" };
const secondDataset = { ...dataset, dataset_id: "synth-ethusd-1d-v1", instrument_id: "SYNTH:ETH-USD" };
const fill = (index, side, qty, after, id = String(index)) => ({ ts: sourceBars[index].ts, client_id: `${index}:${id}`,
  side, qty, price: "100.00", fee: "0.10000000", cash_after: "9000.00", position_after: after });
function report({ run = "fixture-run", from = 0, to = sourceBars.length, processed = to - from, fills = [] } = {}) {
  const rows = sourceBars.slice(from, to);
  return { schema_version: 1, run_id: run, outcome: processed === rows.length ? "completed" : "incomplete",
    evidence_grade: "platform-reproduced backtest", evidence_note: "Test-only synthetic data; not real-world performance.",
    complete: processed === rows.length, bars: { total: rows.length, processed },
    metrics: { version: "metrics-v2", fill_count: fills.length, percent_profitable: null, closed_trade_count: 0,
      winning_trade_count: 0, trade_count: 0, total_fees: "0.00000000", net_return: null },
    execution_model: { fidelity: "daily-bar", fill_timing: "next bar open", order_types: ["market"],
      taker_fee_bps: "10", slippage_bps: "5", position_model: "spot long-only, no leverage",
      not_modeled: ["partial fills", "latency", "intrabar path"] },
    quality_findings: [], equity_curve: rows.slice(0, processed).map((b) => [b.ts, "10000.00000000"]),
    fills, rejections: [], strategy_logs: [],
    provenance: { run_inputs_hash: H, code: { project_version_id: "fixture-version", version_no: 1,
      content_hash: H, entrypoint: "strategy.py" }, dataset: { dataset_id: dataset.dataset_id,
      provider: dataset.provider, license: dataset.license, manifest_hash: manifest(rows), start: rows[0].ts.slice(0, 10),
      end: new Date(Date.parse(rows.at(-1).ts) + 864e5).toISOString().slice(0, 10), bars: rows.length },
      engine: "veyra-sim==0.1.1", rate_version: "test-only", params: {}, starting_cash: "10000",
      resource_class: "small", quote_id: "fixture-quote" }, receipt: null, result_digest: H };
}
const exampleFills = () => [fill(10, "buy", "0.1", "0.1"), fill(370, "buy", "0.2", "0.3", "a"),
  fill(370, "buy", "0.2", "0.5", "b"), fill(370, "sell", "0.1", "0.4", "c"),
  fill(371, "sell", "0.2", "0.2"), fill(450, "sell", "0.2", "0")];
const response = (value, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => plain(value) });
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function until(condition, label) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail(`Timed out waiting for ${label}`);
}

function chartHarness() {
  const charts = new Map();
  function createChart(element, options) {
    const rangeListeners = [], clickListeners = [], crosshairListeners = [], scales = new Map();
    const chart = { id: element.id, options, series: [], optionCalls: [],
      applyOptions(value) { this.optionCalls.push(plain(value)); },
      subscribeClick(fn) { clickListeners.push(fn); },
      subscribeCrosshairMove(fn) { crosshairListeners.push(fn); },
      click(value) { clickListeners.forEach((fn) => fn(value)); },
      crosshair(value) { crosshairListeners.forEach((fn) => fn(value)); },
      removeSeries(series) { this.series.splice(this.series.indexOf(series), 1); },
      priceScale(id) {
        if (!scales.has(id)) scales.set(id, { calls: [], applyOptions(value) { this.calls.push(plain(value)); } });
        return scales.get(id);
      }, timeScale: () => timeScale };
    const timeScale = { range: null, sets: [], fitCalls: 0,
      getVisibleLogicalRange() { return this.range; },
      width: () => 600, coordinateToLogical: (x) => x, logicalToCoordinate: (logical) => logical, applyOptions() {},
      subscribeVisibleLogicalRangeChange(fn) { rangeListeners.push(fn); },
      emit(range) { this.range = range; rangeListeners.forEach((fn) => fn(range)); },
      setVisibleLogicalRange(range) {
        this.sets.push(plain(range));
        assert.ok(this.sets.length < 1000, "Logical-range callbacks must not recurse indefinitely");
        this.emit(plain(range));
      },
      fitContent() { this.fitCalls++; this.emit({ from: 0, to: Math.max(0, ...chart.series.map((s) => s.values.length - 1)) }); },
    };
    const addSeries = (type) => (initial = {}) => {
      const series = { type, options: { ...initial }, values: [], markers: [], markerCalls: [], priceLines: [],
        setData(value) { this.values = plain(value); }, data() { return this.values; },
        setMarkers(value) { this.markers = plain(value); this.markerCalls.push(plain(value)); },
        applyOptions(value) { Object.assign(this.options, value); },
        createPriceLine(value) { this.priceLines.push(value); return value; }, removePriceLine(line) { this.priceLines.splice(this.priceLines.indexOf(line), 1); },
        attachPrimitive(value) { this.primitive = value; }, coordinateToPrice(value) { return value; } };
      chart.series.push(series); return series;
    };
    chart.addCandlestickSeries = addSeries("candles");
    chart.addLineSeries = addSeries("line");
    chart.addHistogramSeries = addSeries("histogram");
    chart.addBarSeries = addSeries("bars");
    chart.addAreaSeries = addSeries("area");
    charts.set(element.id, chart); return chart;
  }
  return { charts, createChart };
}

function realChartHarness(w) {
  const charts = new Map(), frames = new Map();
  let frameId = 0;
  w.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  w.cancelAnimationFrame = (id) => frames.delete(id);
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  // Stub only drawing/layout; the vendored data, ranges, callbacks and RAF scheduling stay real.
  w.HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({ canvas: this, measureText: (text) => ({ width: String(text).length * 7 }),
      createLinearGradient: () => ({ addColorStop() {} }) },
    { get: (target, key) => key in target ? target[key] : () => {} });
  };
  for (const [name, value] of Object.entries({ fg: "#141414", muted: "#66665f", line: "#d3d3ce",
    panel: "#f7f7f5", accent: "#ff5a1f", mono: "monospace", up: "#16a34a", down: "#dc2626" })) {
    w.document.documentElement.style.setProperty(`--${name}`, value);
  }
  w.eval(readFileSync(new URL("../../apps/web/vendor/lightweight-charts.standalone.production.js", import.meta.url), "utf8"));
  const vendor = w.LightweightCharts;
  return { charts,
    createChart(element, options) {
      const chart = vendor.createChart(element, { ...options, autoSize: false, width: 600, height: 300 });
      chart.series = [];
      for (const method of ["addCandlestickSeries", "addLineSeries", "addHistogramSeries", "addBarSeries", "addAreaSeries"]) {
        const add = chart[method].bind(chart);
        chart[method] = (opts) => { const series = add(opts); chart.series.push(series); return series; };
      }
      charts.set(element.id, chart);
      return chart;
    },
    flush() {
      let count = 0;
      while (frames.size && count++ < 100) {
        const [id, callback] = frames.entries().next().value;
        frames.delete(id); callback(w.performance.now());
      }
      assert.equal(frames.size, 0, "Real chart range callbacks must settle without queued feedback");
    },
    dispose() { for (const chart of charts.values()) chart.remove(); frames.clear(); },
  };
}

async function boot(t, { hash = "#markets", user = false, bars = sourceBars, handle, beforeDigest, realCharts = false } = {}) {
  const errors = [], calls = [], digests = [], imports = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: `https://veyra.test/${hash}`, runScripts: "outside-only", virtualConsole });
  const w = dom.window, doc = w.document;
  const harness = realCharts ? realChartHarness(w) : chartHarness();
  t.after(() => { harness.dispose?.(); dom.window.close(); assert.deepEqual(errors, [], "No uncaught DOM errors or unexpected network calls"); });
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  Object.defineProperty(w.crypto, "subtle", { value: { async digest(algorithm, bytes) {
    const index = digests.push({ algorithm, bytes: bytes.length }) - 1;
    await beforeDigest?.(index);
    return webcrypto.subtle.digest(algorithm, bytes);
  } } });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  w.LightweightCharts = harness;
  const fileInput = doc.getElementById("report-file"), addFileListener = fileInput.addEventListener.bind(fileInput);
  fileInput.addEventListener = (type, listener, options) => addFileListener(type, function (event) {
    const result = listener.call(this, event);
    if (type === "change" && result?.then) imports.push(result);
    return result;
  }, options);
  if (user) w.localStorage.setItem("veyra.user", "fixture-user");
  w.fetch = async (path, options = {}) => {
    const call = { path: String(path), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    const result = await handle?.(call);
    if (result !== undefined) return result;
    if (call.path === "/v1/catalog/datasets") return response({ datasets: [dataset, secondDataset] });
    if ([dataset, secondDataset].some((ds) => call.path === `/v1/catalog/datasets/${ds.dataset_id}/bars`)) return response({ bars });
    if (call.path === "/v1/me" && user) return response({ organizations: [{ id: "fixture-org" }] });
    if (call.path === "/v1/orgs/fixture-org/billing/balance" && user) return response({ available_nano: 0, reserved_nano: 0, settled_usage_nano: 0 });
    if (call.path === "/v1/orgs/fixture-org/projects" && user) return response({ projects: [], has_more: false, next_cursor: null });
    if (call.path === "/v1/orgs/fixture-org/jobs?limit=25" && user) return response({ jobs: [] });
    errors.push(`Unexpected API request: ${call.method} ${call.path}`);
    return response({ detail: "Unexpected fixture request" }, 500);
  };
  scripts.forEach((script, index) => w.eval(script + (index === scripts.length - 1 ? "\nwindow.chartFixtureState = state;" : "")));
  const $ = (id) => { const element = doc.getElementById(id); assert.ok(element, `Missing #${id}`); return element; };
  const change = (id, value) => { $(id).value = value; $(id).dispatchEvent(new w.Event("change", { bubbles: true })); };
  const choose = (attribute, value) => {
    const button = doc.querySelector(`[data-${attribute}="${value}"]`);
    assert.ok(button, `Missing ${attribute} ${value}`); button.click();
  };
  async function navigate(next) {
    w.location.hash = next;
    await until(() => !$(`view-${next.slice(1).split("/")[0]}`).hidden, `route ${next}`);
    await delay(5);
  }
  function selectFile(value, { read, size } = {}) {
    if (!$("report-overlay-dialog").open) $("chart-report").click();
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const file = new w.File([text], "test-only-report.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: read || (async () => text) });
    if (size !== undefined) Object.defineProperty(file, "size", { value: size });
    Object.defineProperty($("report-file"), "files", { value: [file], configurable: true });
    $("report-file").dispatchEvent(new w.Event("change", { bubbles: true }));
  }
  async function importReport(value) {
    selectFile(value);
    await until(() => $("report-import-status").textContent.includes(`Run ${value.run_id.slice(0, 12)} ·`), "validated report overlay");
  }
  await until(() => $("market-dataset").options.length === 2, "catalog boot");
  if (hash === "#markets" && !handle) await until(() => $("market-meta").textContent.startsWith("As of"), "market chart");
  await delay(5);
  const ids = [...doc.querySelectorAll("[id]")].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, "HTML IDs remain unique");
  return { w, doc, $, change, choose, navigate, selectFile, importReport, calls, digests, settleImports: () => Promise.all(imports),
    flushCharts: () => harness.flush?.(),
    charts: harness.charts, market: () => harness.charts.get("market-chart"),
    candles: () => harness.charts.get("market-chart").series[0],
    line: () => harness.charts.get("market-chart").series[1] };
}

function assertReadOnly(ui) {
  assert.ok(ui.calls.every((call) => call.method === "GET" && !call.body), "Chart research does not send code, publish, execute, or bill");
}
function queueNextDialogClose(ui, id) {
  const dialog = ui.$(id), close = dialog.close;
  // Native close events are queued; deliver this one explicitly after the dialog reopens.
  dialog.close = function () { this.open = false; this.close = close; };
  return () => dialog.dispatchEvent(new ui.w.Event("close"));
}
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("Indicators dialog controls volume/SMA/RSI and closes explicitly or when leaving markets", async (t) => {
  const ui = await boot(t);
  assert.equal(ui.$("chart-indicators").getAttribute("aria-haspopup"), "dialog");
  ui.$("chart-indicators").click();
  assert.equal(ui.$("indicator-dialog").open, true);
  for (const id of ["chart-volume", "chart-sma", "chart-rsi"]) assert.ok(ui.$("indicator-dialog").contains(ui.$(id)));
  const series = ui.market().series, volume = series.find((s) => s.options.priceScaleId === "volume"), sma = series[series.indexOf(volume) + 1];
  ui.$("chart-volume").click(); assert.equal(volume.options.visible, false);
  assert.equal(ui.$("chart-volume").getAttribute("aria-pressed"), "false");
  assert.equal(ui.market().priceScale("right").calls.at(-1).scaleMargins.bottom, 0.1);
  ui.$("chart-volume").click(); assert.equal(volume.options.visible, true);
  ui.$("chart-sma").click(); assert.equal(sma.options.visible, true);
  assert.ok(sma.values.length > 0);
  ui.$("chart-rsi").click(); assert.equal(ui.$("rsi-pane").hidden, false);
  assert.equal(ui.$("chart-rsi").getAttribute("aria-pressed"), "true");
  ui.$("close-indicators").click(); assert.equal(ui.$("indicator-dialog").open, false);
  ui.$("chart-indicators").click();
  await ui.navigate("#code"); assert.equal(ui.$("indicator-dialog").open, false);
  await ui.navigate("#markets");
  ui.$("chart-report").click(); assert.equal(ui.$("report-overlay-dialog").open, true);
  await ui.navigate("#runs"); assert.equal(ui.$("report-overlay-dialog").open, false);
  assertReadOnly(ui);
});

test("a queued old indicator close does not move focus out of the reopened dialog", async (t) => {
  const ui = await boot(t);
  ui.$("chart-indicators").click();
  const oldClose = queueNextDialogClose(ui, "indicator-dialog");
  ui.$("close-indicators").click();
  ui.$("chart-indicators").click();
  ui.$("chart-rsi").focus();
  oldClose();
  assert.equal(ui.$("indicator-dialog").open, true);
  assert.equal(ui.doc.activeElement, ui.$("chart-rsi"));
  assertReadOnly(ui);
});

test("a queued old asset-browser close does not navigate or focus away from the reopened browser", async (t) => {
  const ui = await boot(t);
  ui.$("browse-assets").click();
  const oldClose = queueNextDialogClose(ui, "asset-browser");
  ui.$("close-browse").click();
  ui.$("browse-assets").click();
  let backCalls = 0;
  ui.w.history.back = () => { backCalls++; };
  oldClose();
  assert.equal(backCalls, 0);
  assert.equal(ui.w.location.hash, "#markets/browse");
  assert.equal(ui.$("asset-browser").open, true);
  assert.equal(ui.doc.activeElement, ui.$("browse-search"));
  assertReadOnly(ui);
});

test("RSI uses complete history before 1Y/3M cropping and keeps warmup blanks with all history", async (t) => {
  const ui = await boot(t);
  ui.$("chart-rsi").click();
  const rsi = ui.charts.get("rsi-chart").series[0];
  const expected = research.rsi(sourceBars.map((bar) => Number(bar.close)));
  for (const range of [365, 90, 0]) {
    ui.choose("range", range);
    assert.equal(rsi.values.length, ui.candles().values.length);
    for (const [i, candle] of ui.candles().values.entries()) {
      const index = sourceBars.findIndex((bar) => Date.parse(bar.ts) / 1000 === candle.time);
      assert.equal(rsi.values[i].time, candle.time);
      if (expected[index] === null) assert.equal(Object.hasOwn(rsi.values[i], "value"), false);
      else closeTo(rsi.values[i].value, expected[index]);
    }
    if (range) assert.ok(Number.isFinite(rsi.values[0].value), "A cropped first candle already has RSI history");
  }
  assert.deepEqual(rsi.values.slice(0, 14), sourceBars.slice(0, 14).map((bar) => ({ time: Date.parse(bar.ts) / 1000 })));
  assert.deepEqual(rsi.priceLines.map((line) => line.price), [30, 70]);
  assert.deepEqual(plain(rsi.options.autoscaleInfoProvider()), { priceRange: { minValue: 0, maxValue: 100 } });
  ui.choose("interval", "1w");
  const grouped = new Map();
  sourceBars.forEach((bar) => grouped.set(research.bucketTime(bar.ts, "1w"), Number(bar.close)));
  const weeklyRsi = research.rsi([...grouped.values()]);
  rsi.values.forEach((point, index) => weeklyRsi[index] === null
    ? assert.equal(Object.hasOwn(point, "value"), false) : closeTo(point.value, weeklyRsi[index]));
  ui.choose("interval", "30w");
  assert.ok(rsi.values.every((point) => !Object.hasOwn(point, "value")), "Insufficient periods remain whitespace, never zero");
});

test("RSI pane synchronizes logical ranges both ways with a recursion guard and stops when hidden", async (t) => {
  const ui = await boot(t);
  ui.$("chart-rsi").click();
  const originalSeries = [...ui.charts.get("rsi-chart").series];
  const main = ui.market().timeScale(), lower = ui.charts.get("rsi-chart").timeScale();
  for (const [source, target] of [[main, lower], [lower, main]]) {
    source.sets.length = target.sets.length = 0;
    source.emit({ from: 12.5, to: 53.75 });
    assert.deepEqual(target.sets, [{ from: 12.5, to: 53.75 }]);
    assert.deepEqual(source.sets, [], "Synchronous callbacks must not bounce the range back");
    source.emit(null); assert.equal(target.sets.length, 1);
  }
  ui.$("chart-rsi").click();
  assert.equal(ui.$("rsi-pane").hidden, true);
  assert.deepEqual(ui.market().optionCalls.at(-1), { timeScale: { visible: true } });
  const old = lower.sets.length;
  main.emit({ from: 1, to: 9 }); assert.equal(lower.sets.length, old);
  ui.$("chart-rsi").click();
  assert.deepEqual(lower.range, main.range);
  assert.deepEqual(ui.market().optionCalls.at(-1), { timeScale: { visible: false } });
  const [rsi, anchor] = ui.charts.get("rsi-chart").series;
  assert.equal(ui.charts.get("rsi-chart").series.length, 2, "Toggling reuses one RSI and one hidden time anchor");
  assert.equal(rsi, originalSeries[0]); assert.equal(anchor, originalSeries[1]);
  assert.notEqual(rsi.options.visible, false);
  assert.deepEqual(anchor.options, { visible: false, priceScaleId: "time-anchor",
    lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
});

test("Real vendored chart scheduling preserves fit, reloads and bidirectional RSI panning", async (t) => {
  const ui = await boot(t, { realCharts: true });
  ui.choose("range", 0); ui.flushCharts();
  const main = ui.market().timeScale();
  const initial = plain(main.getVisibleLogicalRange());
  closeTo(initial.from, 0); closeTo(initial.to, sourceBars.length - 1);
  ui.$("chart-rsi").click(); ui.flushCharts();
  const lower = ui.charts.get("rsi-chart").timeScale();
  const aligned = () => {
    const a = main.getVisibleLogicalRange(), b = lower.getVisibleLogicalRange();
    assert.ok(a && b); closeTo(a.from, b.from); closeTo(a.to, b.to);
  };
  assert.deepEqual(plain(main.getVisibleLogicalRange()), initial, "Enabling RSI must preserve the full main range");
  aligned();
  for (const range of [90, 0, 365, 90, 0]) {
    ui.choose("range", range); ui.flushCharts(); aligned();
    const current = main.getVisibleLogicalRange();
    closeTo(current.from, 0); closeTo(current.to, ui.candles().data().length - 1);
  }
  ui.choose("interval", "30w"); ui.flushCharts(); aligned();
  assert.equal(ui.charts.get("rsi-chart").series[0].data().length, 0, "Warmup-only RSI has no invented values");
  const anchor = ui.charts.get("rsi-chart").series[1];
  for (const key of ["visible", "lastValueVisible", "priceLineVisible", "crosshairMarkerVisible"]) {
    assert.equal(anchor.options()[key], false, `The time anchor never exposes ${key}`);
  }
  assert.equal(anchor.options().priceScaleId, "time-anchor");
  assert.deepEqual(plain(anchor.data()), [{ time: ui.candles().data().at(-1).time, value: 0 }]);
  lower.setVisibleLogicalRange({ from: -2, to: 1 }); ui.flushCharts(); aligned();
  ui.choose("interval", "1d"); ui.flushCharts(); aligned();
  for (const source of [main, lower, main, lower]) {
    source.setVisibleLogicalRange({ from: 12.5, to: 53.75 }); ui.flushCharts(); aligned();
    closeTo(main.getVisibleLogicalRange().from, 12.5);
    source.setVisibleLogicalRange({ from: 31.25, to: 67.5 }); ui.flushCharts(); aligned();
    closeTo(main.getVisibleLogicalRange().to, 67.5);
  }
  for (const id of [secondDataset.dataset_id, dataset.dataset_id, secondDataset.dataset_id, dataset.dataset_id]) {
    ui.change("market-dataset", id);
    await until(() => ui.$("market-meta").textContent.startsWith("As of"), "reloaded source data");
    ui.flushCharts(); aligned();
    closeTo(main.getVisibleLogicalRange().from, 0);
    closeTo(main.getVisibleLogicalRange().to, sourceBars.length - 1);
  }
  assertReadOnly(ui);
});

test("Imported JSON verifies real source hashes, groups only recorded fills and keeps claims unverified", async (t) => {
  const ui = await boot(t);
  const rep = report({ from: 5, to: 459, fills: exampleFills() });
  rep.rejections = [{ ts: sourceBars[430].ts, client_id: "rejected-order", reason: "insufficient_cash" }];
  rep.strategy_logs = [{ ts: sourceBars[440].ts, message: "Buy signal: not an executed fill" }];
  ui.$("chart-report").click();
  await ui.importReport(rep);
  assert.equal(ui.digests.length, 2, "Both full source and report-range hashes are actually computed");
  assert.notEqual(rep.provenance.dataset.manifest_hash, dataset.manifest_hash);
  assert.match(ui.$("overlay-summary").textContent, /5\/6 fills shown.*unverified/);
  assert.match(ui.$("report-import-status").textContent, /source data hashes match.*6 recorded fills/);
  assert.match(ui.$("overlay-evidence").textContent, /unverified.*not market history, live trades/);
  assert.equal(ui.$("overlay-fill-list").children.length, 5);
  assert.deepEqual(ui.candles().markers.map(({ shape, position, text }) => [shape, position, text]),
    [["arrowUp", "belowBar", "2"], ["arrowDown", "aboveBar", ""], ["arrowDown", "aboveBar", ""], ["arrowDown", "aboveBar", ""]]);
  assert.equal(ui.line().markers.length, 0);
  assert.equal(ui.$("report-file").value, "");
  assertReadOnly(ui);
  assert.deepEqual(ui.calls.map((call) => call.path), ["/v1/catalog/datasets", `/v1/catalog/datasets/${dataset.dataset_id}/bars`]);
});

test("Imported fill details normalize offset timestamps to the marked candle's UTC date", async (t) => {
  const ui = await boot(t);
  const fills = [fill(370, "buy", "1", "1"), fill(371, "sell", "1", "0")];
  fills[0].ts = new Date(Date.parse(fills[0].ts) - 3600000).toISOString().replace(".000Z", "-01:00");
  fills[1].ts = new Date(Date.parse(fills[1].ts) + 3600000).toISOString().replace(".000Z", "+01:00");
  await ui.importReport(report({ fills }));
  for (const [i, index] of [370, 371].entries()) {
    assert.equal(ui.candles().markers[i].time, Date.parse(sourceBars[index].ts) / 1000);
    assert.ok(ui.$("overlay-fill-list").children[i].textContent.startsWith(`${sourceBars[index].ts.slice(0, 10)} UTC ·`));
  }
  assertReadOnly(ui);
});

test("Line/candle switches move existing markers, and selecting a marked candle shows only its real fills", async (t) => {
  const ui = await boot(t);
  await ui.importReport(report({ fills: exampleFills() }));
  const markers = plain(ui.candles().markers);
  ui.market().crosshair({ seriesData: new Map([[ui.candles(), ui.candles().values.at(-1)]]) });
  assert.match(ui.$("chart-readout").textContent, /^O 100 H 110 L 90 C /);
  ui.change("chart-type", "line");
  ui.market().crosshair({ seriesData: new Map([[ui.line(), ui.line().values.at(-1)]]) });
  assert.match(ui.$("chart-readout").textContent, /^Close .* · UTC$/);
  ui.market().crosshair({ seriesData: new Map() });
  assert.equal(ui.$("chart-readout").textContent, "Crosshair shows OHLC · UTC");
  assert.deepEqual(ui.line().markers, markers); assert.deepEqual(ui.candles().markers, []);
  assert.equal(ui.line().options.visible, true); assert.equal(ui.candles().options.visible, false);
  ui.market().click({ time: Date.parse(sourceBars[370].ts) / 1000, point: { x: 1, y: 1 } });
  assert.equal(ui.$("report-overlay-dialog").open, true);
  assert.equal(ui.$("overlay-fill-list").children.length, 3);
  assert.match(ui.$("overlay-fill-list").textContent, /Buy 0.2 @ 100.00 · fee 0.10000000/);
  assert.match(ui.$("overlay-fill-list").textContent, /Sell 0.1 @ 100.00/);
  ui.$("close-report-overlay").click();
  ui.market().click({ time: Date.parse(sourceBars[400].ts) / 1000, point: { x: 1, y: 1 } });
  assert.equal(ui.$("report-overlay-dialog").open, false, "Unmarked candles do not fabricate fill details");
  ui.change("chart-type", "candles");
  assert.deepEqual(ui.candles().markers, markers); assert.deepEqual(ui.line().markers, []);
  ui.$("open-drawings").click();
  ui.$("chart-trend").click();
  assert.equal(ui.$("draw-sheet").open, false, "Choosing a tool returns to the chart for placement");
  ui.market().click({ time: markers[0].time, point: { x: 1, y: 100 } });
  assert.equal(ui.$("report-overlay-dialog").open, false, "Trend drawing does not unexpectedly open fill details");
});

test("All enabled intervals map exact source buckets and range changes retain only displayed fills", async (t) => {
  const ui = await boot(t);
  const fills = exampleFills();
  await ui.importReport(report({ fills }));
  for (const interval of research.INTERVALS) {
    ui.choose("interval", interval);
    for (const range of [0, 90, 365]) {
      ui.choose("range", range);
      const times = new Set(ui.candles().values.map((bar) => bar.time));
      const shown = fills.filter((f) => times.has(research.bucketTime(f.ts, interval)));
      const keys = new Map();
      shown.forEach((f) => { const key = `${research.bucketTime(f.ts, interval)}:${f.side}`; keys.set(key, (keys.get(key) || 0) + 1); });
      const actual = ui.candles().markers.map((marker) => [`${marker.time}:${marker.shape === "arrowUp" ? "buy" : "sell"}`, marker.text || "1"]);
      assert.deepEqual(actual.sort(), [...keys].map(([key, count]) => [key, String(count)]).sort(), `${interval}/${range}`);
      assert.match(ui.$("overlay-summary").textContent, new RegExp(`${shown.length}/${fills.length} fills shown`));
      assert.ok(ui.candles().markers.every((marker) => times.has(marker.time)));
    }
  }
  for (const button of ui.doc.querySelectorAll("[data-interval]")) {
    assert.equal(button.disabled, !research.INTERVALS.includes(button.dataset.interval));
  }
});

test("Empty and incomplete reports never synthesize markers or profitability", async (t) => {
  const ui = await boot(t);
  await ui.importReport(report({ run: "empty-run", processed: 0 }));
  assert.deepEqual(ui.candles().markers, []);
  assert.match(ui.$("overlay-summary").textContent, /Incomplete backtest.*0\/0 fills shown.*unverified/);
  assert.match(ui.$("overlay-fill-list").textContent, /No recorded fills/);
  assert.doesNotMatch(ui.$("overlay-details").textContent, /100%|profitable trades|win rate/i);
});

test("Malformed/oversize/mismatched JSON fails visibly without discarding the prior valid overlay", async (t) => {
  const ui = await boot(t);
  await ui.importReport(report({ fills: exampleFills() }));
  const markers = plain(ui.candles().markers);
  const mismatch = report(); mismatch.provenance.dataset.manifest_hash = H;
  const otherAsset = report(); otherAsset.provenance.dataset.dataset_id = secondDataset.dataset_id;
  for (const [value, expected] of [["{", /valid JSON/], [mismatch, /Source data hash/], [otherAsset, /does not match/]]) {
    ui.selectFile(value);
    await until(() => expected.test(ui.$("report-import-status").textContent), "import rejection");
    assert.deepEqual(ui.candles().markers, markers);
  }
  let reads = 0;
  ui.selectFile("", { size: research.LIMITS.reportBytes + 1, read: async () => { reads++; return ""; } });
  await until(() => /4 MiB/.test(ui.$("report-import-status").textContent), "oversize rejection");
  assert.equal(reads, 0, "Oversize input must be rejected before reading contents");
  assert.deepEqual(ui.candles().markers, markers);
  ui.selectFile("", { read: async () => { throw new Error("Unreadable local report"); } });
  await until(() => /Unreadable local report/.test(ui.$("report-import-status").textContent), "file read failure");
  assert.deepEqual(ui.candles().markers, markers);
  assertReadOnly(ui);
});

test("Tampered source bars cannot be imported even when report/catalog identities match", async (t) => {
  const changed = plain(sourceBars); changed[10].close = "102.01";
  const ui = await boot(t, { bars: changed });
  ui.selectFile(report({ fills: exampleFills() }));
  await until(() => /Source data hash/.test(ui.$("report-import-status").textContent), "source-content hash failure");
  assert.equal(ui.$("overlay-readout").hidden, true);
  assert.deepEqual(ui.candles().markers, []);
});

test("Clear removes both style marker sets and details without changing the chart or source report", async (t) => {
  const ui = await boot(t);
  const rep = report({ fills: exampleFills() }), before = JSON.stringify(rep);
  await ui.importReport(rep);
  ui.change("chart-type", "line");
  const candles = plain(ui.candles().values);
  ui.$("clear-overlay").click();
  assert.equal(ui.$("overlay-readout").hidden, true); assert.equal(ui.$("overlay-details").hidden, true);
  assert.deepEqual(ui.candles().markers, []); assert.deepEqual(ui.line().markers, []);
  assert.equal(ui.$("overlay-fill-list").children.length, 0);
  assert.match(ui.$("report-import-status").textContent, /Overlay cleared/);
  assert.deepEqual(ui.candles().values, candles); assert.equal(JSON.stringify(rep), before);
  assertReadOnly(ui);
});

test("A slower earlier file read cannot overwrite a newer valid import", async (t) => {
  const ui = await boot(t), slow = deferred();
  const old = report({ run: "older-run", fills: [fill(370, "buy", "1", "1")] });
  const latest = report({ run: "newer-run", fills: [fill(450, "buy", "1", "1")] });
  ui.selectFile(old, { read: () => slow.promise });
  await ui.importReport(latest);
  const markers = plain(ui.candles().markers);
  slow.resolve(JSON.stringify(old)); await ui.settleImports();
  assert.match(ui.$("report-import-status").textContent, /Run newer-run/);
  assert.deepEqual(ui.candles().markers, markers);
});

test("Clear while a file read is pending cancels it before it can restore an overlay", async (t) => {
  const ui = await boot(t), slow = deferred();
  await ui.importReport(report({ run: "visible-run", fills: exampleFills() }));
  ui.selectFile(report({ run: "cleared-run" }), { read: () => slow.promise });
  ui.$("clear-overlay").click();
  slow.resolve(JSON.stringify(report({ run: "cleared-run" }))); await ui.settleImports();
  assert.equal(ui.$("overlay-readout").hidden, true);
  assert.deepEqual(ui.candles().markers, []);
  assert.match(ui.$("report-import-status").textContent, /Overlay cleared/);
});

test("Stale source-hash completion cannot overwrite a newer import or its status", async (t) => {
  const slow = deferred();
  const ui = await boot(t, { beforeDigest: (i) => i < 2 ? slow.promise : undefined });
  ui.selectFile(report({ run: "hash-old", fills: [fill(370, "buy", "1", "1")] }));
  await until(() => ui.digests.length === 2, "first source hash requests");
  await ui.importReport(report({ run: "hash-new", fills: [fill(450, "buy", "1", "1")] }));
  const markers = plain(ui.candles().markers);
  slow.resolve(); await ui.settleImports();
  assert.match(ui.$("report-import-status").textContent, /Run hash-new/);
  assert.deepEqual(ui.candles().markers, markers);
});

test("Closing the import dialog cancels a pending read without creating a hidden overlay", async (t) => {
  const ui = await boot(t), slow = deferred();
  ui.$("chart-report").click();
  ui.selectFile(report({ run: "cancelled" }), { read: () => slow.promise });
  ui.$("close-report-overlay").click();
  slow.resolve(JSON.stringify(report({ run: "cancelled" }))); await ui.settleImports();
  assert.equal(ui.$("report-overlay-dialog").open, false);
  assert.equal(ui.$("overlay-readout").hidden, true);
  assert.deepEqual(ui.candles().markers, []);
});

test("a queued old report-dialog close does not cancel a newly selected import after reopening", async (t) => {
  const ui = await boot(t), slow = deferred();
  ui.$("chart-report").click();
  const oldClose = queueNextDialogClose(ui, "report-overlay-dialog");
  ui.$("close-report-overlay").click();
  const current = report({ run: "reopened-new", fills: exampleFills() });
  ui.selectFile(current, { read: () => slow.promise });
  ui.$("report-file").focus();
  oldClose();
  assert.equal(ui.$("report-overlay-dialog").open, true);
  assert.match(ui.$("report-import-status").textContent, /^Reading/);
  assert.equal(ui.doc.activeElement, ui.$("report-file"));
  slow.resolve(JSON.stringify(current)); await ui.settleImports();
  assert.match(ui.$("report-import-status").textContent, /Run reopened-new/);
  assert.ok(ui.candles().markers.length > 0);
  assertReadOnly(ui);
});

test("reopening before a queued close cannot revive the prior pending report import", async (t) => {
  const ui = await boot(t), slow = deferred();
  await ui.importReport(report({ run: "kept-overlay", fills: exampleFills() }));
  const markers = plain(ui.candles().markers);
  ui.selectFile(report({ run: "cancelled-old" }), { read: () => slow.promise });
  const oldClose = queueNextDialogClose(ui, "report-overlay-dialog");
  ui.$("close-report-overlay").click();
  ui.$("chart-report").click();
  oldClose();
  slow.resolve(JSON.stringify(report({ run: "cancelled-old" }))); await ui.settleImports();
  assert.equal(ui.$("report-overlay-dialog").open, true);
  assert.deepEqual(ui.candles().markers, markers);
  assert.doesNotMatch(ui.$("report-import-status").textContent, /Run cancelled-old/);
  assertReadOnly(ui);
});

test("pending report reads and hashes cancel before the queued native close event", async (t) => {
  for (const phase of ["read", "hash"]) for (const action of ["button", "escape", "navigation"]) {
    const slow = deferred();
    const ui = await boot(t, { beforeDigest: (i) => phase === "hash" && i >= 2 ? slow.promise : undefined });
    await ui.importReport(report({ run: "retained", fills: exampleFills() }));
    const markers = plain(ui.candles().markers), cancelled = report({ run: "must-not-commit" });
    ui.selectFile(cancelled, phase === "read" ? { read: () => slow.promise } : {});
    if (phase === "hash") await until(() => ui.digests.length === 4, "pending report hashes");
    const oldClose = queueNextDialogClose(ui, "report-overlay-dialog");
    if (action === "button") ui.$("close-report-overlay").click();
    else if (action === "navigation") await ui.navigate("#code");
    else {
      const event = new ui.w.Event("cancel", { cancelable: true });
      if (ui.$("report-overlay-dialog").dispatchEvent(event)) ui.$("report-overlay-dialog").close();
    }
    assert.equal(ui.$("report-overlay-dialog").open, false, `${action} closes during ${phase}`);
    slow.resolve(JSON.stringify(cancelled)); await ui.settleImports();
    assert.deepEqual(ui.candles().markers, markers, `${action} cancels ${phase} before the close event`);
    assert.doesNotMatch(ui.$("report-import-status").textContent, /Run must-not/);
    oldClose();
    assert.deepEqual(ui.candles().markers, markers);
    assertReadOnly(ui);
  }
});

test("Asset changes reject pending imports and hide a mismatched existing overlay until reselected", async (t) => {
  const ui = await boot(t), slow = deferred();
  await ui.importReport(report({ run: "existing", fills: exampleFills() }));
  const markers = plain(ui.candles().markers);
  ui.selectFile(report({ run: "stale-asset" }), { read: () => slow.promise });
  ui.change("market-dataset", secondDataset.dataset_id);
  await until(() => ui.$("market-symbol").textContent === "ETH-USD" && ui.$("market-meta").textContent.startsWith("As of"), "second asset");
  slow.resolve(JSON.stringify(report({ run: "stale-asset" }))); await ui.settleImports();
  assert.deepEqual(ui.candles().markers, []);
  assert.match(ui.$("overlay-summary").textContent, /matching synthetic asset|hidden/i);
  ui.change("market-dataset", dataset.dataset_id);
  await until(() => ui.$("market-symbol").textContent === "BTC-USD" && ui.$("market-meta").textContent.startsWith("As of"), "original asset");
  assert.deepEqual(ui.candles().markers, markers);
  assert.match(ui.$("report-import-status").textContent, /Run existing/);
});

function serverRoutes(rep, extra) {
  const job = { id: rep.run_id, state: "settled", outcome: "completed", report_id: "fixture-report", settled_at: "2026-01-01T00:00:00Z",
    progress: { bars_done: sourceBars.length, bars_total: sourceBars.length },
    receipt: { supplier_cost_nano: 0, platform_fee_bps: 2000, platform_fee_nano: 0, customer_charge_nano: 0,
      authorized_max_nano: 0, released_nano: 0, tax_nano: null } };
  return (call) => {
    if (call.path === `/v1/jobs/${rep.run_id}`) return response(job);
    if (call.path === "/v1/reports/fixture-report/artifacts/report.json") return response(rep);
    return extra?.(call);
  };
}

test("View recorded fills opens the report's dataset chart through the real report route", async (t) => {
  const rep = report({ run: "server-run", fills: exampleFills() });
  const ui = await boot(t, { hash: "#run/server-run", user: true, handle: serverRoutes(rep) });
  await until(() => !ui.$("show-run-chart").hidden, "server report");
  ui.$("show-run-chart").click();
  await until(() => ui.w.location.hash === "#markets" && !ui.$("overlay-readout").hidden && ui.candles().markers.length === 4, "report chart overlay");
  assert.equal(ui.$("market-dataset").value, dataset.dataset_id);
  assert.match(ui.$("overlay-summary").textContent, /5\/6 fills shown/);
  assert.match(ui.$("overlay-evidence").textContent, /unverified/);
  assert.equal(ui.digests.length, 2);
  assert.equal(ui.calls.filter((call) => call.path.endsWith("/bars")).length, 1, "Source history is cached across chart navigation");
  assertReadOnly(ui);
});

test("A pending View recorded fills request never overrides newer navigation", async (t) => {
  const slow = deferred(), rep = report({ run: "server-run", fills: exampleFills() });
  const ui = await boot(t, { hash: "#run/server-run", user: true, handle: serverRoutes(rep, (call) =>
    call.path.endsWith("/bars") ? slow.promise : undefined) });
  await until(() => !ui.$("show-run-chart").hidden, "server report");
  ui.$("show-run-chart").click();
  await until(() => ui.calls.some((call) => call.path.endsWith("/bars")), "pending source data");
  await ui.navigate("#code");
  slow.resolve(response({ bars: sourceBars }));
  await delay(20);
  assert.equal(ui.$("show-run-chart").disabled, true, "A stale chart request cannot restore the old run's control");
  assert.equal(ui.w.location.hash, "#code");
  assert.equal(ui.$("view-code").hidden, false);
  assert.equal(ui.$("overlay-readout").hidden, true);
  assertReadOnly(ui);
});

test("A stale file-read error cannot replace a newer successful import status", async (t) => {
  const ui = await boot(t), slow = deferred();
  ui.selectFile(report({ run: "unreadable" }), { read: () => slow.promise });
  await ui.importReport(report({ run: "good-current", fills: exampleFills() }));
  const markers = plain(ui.candles().markers);
  slow.reject(new Error("Old file is no longer readable")); await ui.settleImports();
  assert.match(ui.$("report-import-status").textContent, /Run good-current/);
  assert.deepEqual(ui.candles().markers, markers);
});

test("Dialog cancellation during real source hashing keeps the prior overlay unchanged", async (t) => {
  const slow = deferred();
  const ui = await boot(t, { beforeDigest: (i) => i >= 2 ? slow.promise : undefined });
  await ui.importReport(report({ run: "kept-report", fills: exampleFills() }));
  const markers = plain(ui.candles().markers);
  ui.selectFile(report({ run: "cancel-hash" }));
  await until(() => ui.digests.length === 4, "pending source hash");
  const event = new ui.w.Event("cancel", { cancelable: true });
  if (ui.$("report-overlay-dialog").dispatchEvent(event)) ui.$("report-overlay-dialog").close();
  slow.resolve(); await ui.settleImports();
  assert.equal(ui.$("report-overlay-dialog").open, false);
  assert.deepEqual(ui.candles().markers, markers);
  assert.match(ui.$("report-import-status").textContent, /cancelled|kept-report/i);
});

test("Leaving markets cancels an open dialog's pending file import", async (t) => {
  const ui = await boot(t), slow = deferred();
  ui.$("chart-report").click();
  ui.selectFile(report({ run: "away-report" }), { read: () => slow.promise });
  await ui.navigate("#code");
  slow.resolve(JSON.stringify(report({ run: "away-report" }))); await ui.settleImports();
  assert.equal(ui.$("overlay-readout").hidden, true);
  assert.equal(ui.w.location.hash, "#code");
  await ui.navigate("#markets");
  assert.equal(ui.$("overlay-readout").hidden, true);
});

test("Returning to the same asset cannot revive a file import begun before switching away", async (t) => {
  const ui = await boot(t), slow = deferred();
  ui.$("chart-report").click();
  ui.selectFile(report({ run: "old-btc" }), { read: () => slow.promise });
  for (const ds of [secondDataset, dataset]) {
    ui.change("market-dataset", ds.dataset_id);
    await until(() => ui.$("market-symbol").textContent === ds.instrument_id.slice(6) && ui.$("market-meta").textContent.startsWith("As of"), "asset reload");
  }
  slow.resolve(JSON.stringify(report({ run: "old-btc" }))); await ui.settleImports();
  assert.equal(ui.$("overlay-readout").hidden, true);
  assert.deepEqual(ui.candles().markers, []);
});

test("Clear during source hashing invalidates completion and preserves its cleared status", async (t) => {
  const slow = deferred();
  const ui = await boot(t, { beforeDigest: (i) => i >= 2 ? slow.promise : undefined });
  await ui.importReport(report({ run: "visible-old", fills: exampleFills() }));
  ui.selectFile(report({ run: "cleared-hash", fills: exampleFills() }));
  await until(() => ui.digests.length === 4, "pending source hashes");
  ui.$("clear-overlay").click();
  slow.resolve(); await ui.settleImports();
  assert.equal(ui.$("overlay-readout").hidden, true);
  assert.deepEqual(ui.candles().markers, []);
  assert.match(ui.$("report-import-status").textContent, /Overlay cleared/);
});

test("RSI selected while the initial asset is loading still configures both panes when data arrives", async (t) => {
  const slow = deferred();
  const ui = await boot(t, { handle: (call) => call.path.endsWith("/bars") ? slow.promise : undefined });
  ui.$("chart-indicators").click(); ui.$("chart-rsi").click();
  slow.resolve(response({ bars: sourceBars }));
  await until(() => ui.$("market-meta").textContent.startsWith("As of"), "initial bars");
  assert.equal(ui.$("rsi-pane").hidden, false);
  assert.ok(ui.charts.get("rsi-chart").series[0].values.length > 0);
  assert.ok(ui.market().optionCalls.some((options) => options.timeScale?.visible === false) ||
    ui.market().options.timeScale?.visible === false, "Main time axis must hide when the RSI pane was enabled before chart creation");
});

test("Leaving and reopening the same run invalidates an older View recorded fills request", async (t) => {
  const slow = deferred(), rep = report({ run: "same-run", fills: exampleFills() });
  const ui = await boot(t, { hash: "#run/same-run", user: true, handle: serverRoutes(rep, (call) =>
    call.path.endsWith("/bars") ? slow.promise : undefined) });
  await until(() => !ui.$("show-run-chart").hidden, "server report");
  ui.$("show-run-chart").click();
  await until(() => ui.calls.some((call) => call.path.endsWith("/bars")), "pending source data");
  await ui.navigate("#code");
  await ui.navigate("#run/same-run");
  await until(() => !ui.$("show-run-chart").hidden, "reopened run report");
  slow.resolve(response({ bars: sourceBars }));
  await until(() => !ui.$("show-run-chart").disabled, "finished old request");
  assert.equal(ui.w.location.hash, "#run/same-run", "Newer navigation takes precedence even when its final URL matches");
  assert.equal(ui.$("overlay-readout").hidden, true);
});

test("An import finishing after interval/range/style changes uses the current chart selection", async (t) => {
  const slow = deferred();
  const ui = await boot(t, { beforeDigest: () => slow.promise });
  const fills = exampleFills();
  ui.selectFile(report({ run: "current-view", fills }));
  await until(() => ui.digests.length === 2, "pending hashes");
  ui.choose("interval", "1M"); ui.choose("range", 90); ui.change("chart-type", "line");
  slow.resolve(); await ui.settleImports();
  const times = new Set(ui.line().values.map((point) => point.time));
  const shown = fills.filter((f) => times.has(research.bucketTime(f.ts, "1M")));
  assert.match(ui.$("overlay-summary").textContent, new RegExp(`${shown.length}/${fills.length} fills shown`));
  assert.ok(ui.line().markers.every((marker) => times.has(marker.time) && research.bucketTime(marker.time, "1M") === marker.time));
  assert.ok(ui.line().markers.length > 0);
  assert.deepEqual(ui.candles().markers, []);
});

test("Server-report chart action fails closed on mismatched source hashes without navigating", async (t) => {
  const rep = report({ run: "bad-source", fills: exampleFills() });
  rep.provenance.dataset.manifest_hash = H;
  const ui = await boot(t, { hash: "#run/bad-source", user: true, handle: serverRoutes(rep) });
  await until(() => !ui.$("show-run-chart").hidden, "server report");
  ui.$("show-run-chart").click();
  await until(() => /Source data hash/.test(ui.$("status").textContent), "server report validation failure");
  assert.equal(ui.w.location.hash, "#run/bad-source");
  assert.equal(ui.$("overlay-readout").hidden, true);
  assert.equal(ui.$("show-run-chart").disabled, false);
  assertReadOnly(ui);
});

// Saved-run picker fixtures, entirely synthetic and served by the in-memory fake API.
const savedId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function savedFixture(n, { asset = dataset, created = `2026-01-${String(n).padStart(2, "0")}T12:00:00.123456Z`, project = 100, fills = exampleFills() } = {}) {
  const rep = report({ run: savedId(n), fills });
  rep.provenance.code.project_version_id = savedId(200);
  rep.provenance.dataset.dataset_id = asset.dataset_id;
  const row = { id: rep.run_id, project_id: savedId(project), project_name: project === 100 ? "Saved example" : "Other strategy",
    project_version_id: savedId(200), version_no: 1, report_id: savedId(n + 1000), state: "settled", outcome: rep.outcome,
    dataset_id: asset.dataset_id, start: rep.provenance.dataset.start, end: rep.provenance.dataset.end, created_at: created };
  const job = { ...row, org_id: "fixture-org", config: { project_version_id: row.project_version_id,
    input_hash: H, dataset_id: asset.dataset_id, start: row.start, end: row.end } };
  return { row, job, rep };
}
const savedPage = (fixtures, cursor = null) => ({ jobs: fixtures.map(f => f.row || f), next_cursor: cursor, has_more: cursor !== null });
const savedApi = (fixtures, extra) => (call) => {
  const other = extra?.(call);
  if (other !== undefined) return other;
  if (call.path === "/v1/orgs/fixture-org/jobs?limit=25") return response(savedPage(fixtures));
  for (const fixture of fixtures) {
    if (call.path === `/v1/jobs/${fixture.job.id}`) return response(fixture.job);
    if (call.path === `/v1/reports/${fixture.row.report_id}/artifacts/report.json`) return response(fixture.rep);
  }
};
async function openSaved(ui, count = 1) {
  ui.$("chart-report").click();
  await until(() => ui.doc.querySelectorAll("[data-chart-run]").length === count, "saved-run rows");
}
const chooseSaved = (ui, fixture) => ui.doc.querySelector(`[data-chart-run="${fixture.row.id}"]`).click();
const loadedSaved = (ui, fixture) => until(() => ui.$("chart-run-selection-status").textContent.startsWith(`Run ${fixture.row.id} loaded`), "saved run on chart");
const assertPickerReads = (ui) => {
  assertReadOnly(ui);
  for (const call of ui.calls) assert.ok(/^\/v1\/(catalog\/datasets(?:\/[^/]+\/bars)?|me|orgs\/fixture-org\/(billing\/balance|projects|jobs\?limit=25(?:&cursor=[^&]+)?)|jobs\/[\da-f-]+|reports\/[\da-f-]+\/artifacts\/report.json)$/.test(call.path), `Read outside picker fixture scope: ${call.path}`);
};

test("Strategy dialog has honest disconnected, loading, empty and unavailable states", async (t) => {
  const offline = await boot(t); offline.$("chart-report").click();
  assert.match(offline.$("chart-runs-status").textContent, /Connect an account.*import/);
  assert.equal(offline.$("chart-runs-refresh").disabled, true);
  assert.equal(offline.calls.some(call => call.path.includes("/jobs")), false);
  const pending = deferred();
  const ui = await boot(t, { user: true, handle: call => call.path.includes("/jobs?") ? pending.promise : undefined });
  ui.$("chart-report").click();
  assert.match(ui.$("chart-runs-status").textContent, /Loading saved/);
  assert.equal(ui.$("chart-runs-refresh").disabled, true);
  pending.resolve(response(savedPage([])));
  await until(() => /No saved runs/.test(ui.$("chart-runs-status").textContent), "empty history");
  assert.equal(ui.$("chart-runs-more").hidden, true);
  assertPickerReads(ui);
  const failed = await boot(t, { user: true, handle: call => call.path.includes("/jobs?") ? response({ detail: "History offline" }, 503) : undefined });
  failed.$("chart-report").click();
  await until(() => /Saved backtests unavailable.*History offline/.test(failed.$("chart-runs-status").textContent), "history error");
  assert.equal(failed.$("chart-runs-refresh").disabled, false);
});

test("Saved runs are explicitly paged, grouped by strategy and UTC date, newest first, and never fetched on row render", async (t) => {
  const a = savedFixture(3), b = savedFixture(2, { project: 101 }), c = savedFixture(1);
  const ui = await boot(t, { user: true, handle: savedApi([a,b,c], call => {
    if (call.path === "/v1/orgs/fixture-org/jobs?limit=25") return response(savedPage([b,a], "older-page"));
    if (call.path === "/v1/orgs/fixture-org/jobs?limit=25&cursor=older-page") return response(savedPage([c]));
  }) });
  await openSaved(ui, 2);
  assert.equal(ui.calls.filter(call => call.path.includes("/jobs?")).length, 1);
  assert.deepEqual([...ui.doc.querySelectorAll("#chart-run-list summary")].map(n => n.textContent), ["Saved example", "Other strategy"]);
  assert.equal(ui.calls.some(call => /\/v1\/(jobs\/|reports\/)/.test(call.path)), false);
  ui.$("chart-runs-more").click(); ui.$("chart-runs-more").click();
  await until(() => ui.doc.querySelectorAll("[data-chart-run]").length === 3, "older page appended");
  assert.deepEqual([...ui.doc.querySelectorAll("#chart-run-list li:first-child h3")].map(n => n.textContent), ["2026-01-03 UTC", "2026-01-01 UTC"]);
  assert.equal(ui.$("chart-runs-more").hidden, true);
  assert.equal(ui.calls.filter(call => call.path.includes("cursor=")).length, 1);
  assertPickerReads(ui);
});

test("Malformed or duplicate older pages preserve loaded rows and stop repeated cursor paging", async (t) => {
  for (const bad of ["duplicate", "repeat-cursor", "shape"]) {
    const a = savedFixture(2), b = savedFixture(1);
    const ui = await boot(t, { user: true, handle: savedApi([a,b], call => {
      if (call.path === "/v1/orgs/fixture-org/jobs?limit=25") return response(savedPage([a], "older"));
      if (call.path.includes("cursor=older")) return response(bad === "duplicate" ? savedPage([a]) : bad === "repeat-cursor" ? savedPage([b], "older") : { jobs: "wrong" });
    }) });
    await openSaved(ui); ui.$("chart-runs-more").click();
    await until(() => /unavailable/.test(ui.$("chart-runs-status").textContent), "invalid page rejected");
    assert.deepEqual([...ui.doc.querySelectorAll("[data-chart-run]")].map(b => b.dataset.chartRun), [a.row.id]);
    assert.equal(ui.$("chart-runs-more").hidden, true);
    ui.$("chart-runs-more").click(); await delay(10);
    assert.equal(ui.calls.filter(call => call.path.includes("cursor=older")).length, 1);
  }
});

test("Validated saved selection switches matching synthetic asset atomically, labels evidence, keeps chart controls and route", async (t) => {
  const fixture = savedFixture(1, { asset: secondDataset }), pending = deferred();
  const ui = await boot(t, { user: true, handle: savedApi([fixture], call => call.path.includes(secondDataset.dataset_id + "/bars") ? pending.promise : undefined) });
  await ui.importReport(report({ run: "kept-before-selection", fills: exampleFills() }));
  const prior = plain(ui.candles().markers), candles = plain(ui.candles().values);
  chooseSaved(ui, fixture);
  await until(() => /Checking/.test(ui.$("chart-run-selection-status").textContent), "source validation loading");
  assert.deepEqual(ui.candles().markers, prior); assert.deepEqual(ui.candles().values, candles);
  assert.equal(ui.$("market-dataset").value, dataset.dataset_id);
  ui.choose("interval", "1M"); ui.choose("range", 90); ui.change("chart-type", "line");
  pending.resolve(response({ bars: sourceBars }));
  await loadedSaved(ui, fixture);
  assert.equal(ui.w.location.hash, "#markets"); assert.equal(ui.$("report-overlay-dialog").open, true);
  assert.equal(ui.$("market-dataset").value, secondDataset.dataset_id);
  assert.equal(ui.$("market-symbol").textContent, "ETH-USD");
  assert.ok(ui.line().markers.length > 0); assert.deepEqual(ui.candles().markers, []);
  assert.ok(ui.line().markers.every(marker => research.bucketTime(marker.time, "1M") === marker.time));
  assert.match(ui.$("overlay-source").textContent, /v1.*Run .*Created 2026-01-01.*veyra-synthetic.*synth-ethusd/);
  assert.match(ui.$("overlay-evidence").textContent, /unverified.*not market history, live trades/);
  assert.match(ui.$("overlay-details").textContent, /Recorded simulation fills/);
  assert.doesNotMatch(ui.$("overlay-details").textContent, /win rate|profitable/i);
  assertPickerReads(ui);
});

test("No-report and unsupported datasets remain visible disabled; legacy and unavailable report artifacts preserve the current overlay", async (t) => {
  const missing = savedFixture(1), unsupported = savedFixture(2), legacy = savedFixture(3), unavailable = savedFixture(4);
  missing.row.report_id = null; unsupported.row.dataset_id = "live-unknown";
  legacy.rep = { metrics: { version: "metrics-v1" } };
  const ui = await boot(t, { user: true, handle: savedApi([missing, unsupported, legacy, unavailable], call =>
    call.path === `/v1/reports/${unavailable.row.report_id}/artifacts/report.json` ? response({ detail: "Artifact not found" }, 404) : undefined) });
  await ui.importReport(report({ fills: exampleFills() }));
  const markers = plain(ui.candles().markers);
  for (const fixture of [missing, unsupported]) assert.equal(ui.doc.querySelector(`[data-chart-run="${fixture.row.id}"]`).disabled, true);
  for (const fixture of [legacy, unavailable]) {
    chooseSaved(ui, fixture);
    await until(() => /Report unavailable/.test(ui.$("chart-run-selection-status").textContent), "unavailable report");
    assert.deepEqual(ui.candles().markers, markers);
    assert.equal(ui.$("market-dataset").value, dataset.dataset_id);
  }
  assertPickerReads(ui);
});

test("Saved selection rejects job/report identity, version, inputs, data provenance and source-hash mismatches", async (t) => {
  const changes = [f => { f.job.org_id = "foreign"; }, f => { f.job.report_id = savedId(9999); },
    f => { f.job.project_version_id = savedId(9999); }, f => { f.job.config.input_hash = `sha256:${"b".repeat(64)}`; },
    f => { f.rep.run_id = savedId(9999); }, f => { f.rep.provenance.code.version_no = 2; },
    f => { f.rep.provenance.code.project_version_id = savedId(9999); }, f => { f.rep.provenance.dataset.start = "2024-01-01"; },
    f => { f.rep.provenance.dataset.dataset_id = secondDataset.dataset_id; }, f => { f.rep.provenance.dataset.manifest_hash = H; }];
  for (const change of changes) {
    const fixture = savedFixture(1); change(fixture);
    const ui = await boot(t, { user: true, handle: savedApi([fixture]) });
    await ui.importReport(report({ fills: exampleFills() }));
    const before = plain(ui.candles().markers);
    chooseSaved(ui, fixture);
    await until(() => /Report unavailable/.test(ui.$("chart-run-selection-status").textContent), "mismatched report rejected");
    assert.deepEqual(ui.candles().markers, before);
    assert.equal(ui.$("market-dataset").value, dataset.dataset_id);
    assertPickerReads(ui);
  }
});

test("Newer saved-run choices win even when older requests finish last", async (t) => {
  const old = savedFixture(1), latest = savedFixture(2, { fills: [fill(450, "buy", "1", "1")] }), pending = deferred();
  const ui = await boot(t, { user: true, handle: savedApi([old,latest], call => call.path === `/v1/jobs/${old.row.id}` ? pending.promise : undefined) });
  await openSaved(ui, 2); chooseSaved(ui, old); chooseSaved(ui, latest); await loadedSaved(ui, latest);
  const markers = plain(ui.candles().markers);
  pending.resolve(response(old.job)); await delay(20);
  assert.deepEqual(ui.candles().markers, markers);
  assert.match(ui.$("overlay-source").textContent, new RegExp(latest.row.id));
  assert.equal(ui.calls.some(call => call.path === `/v1/reports/${old.row.report_id}/artifacts/report.json`), false);
  assertPickerReads(ui);
});

test("Pending saved selections cannot survive close/reopen, Escape, routing, account/org change, asset switching, import, clear or refresh", async (t) => {
  for (const action of ["close", "escape", "route", "same-market-route", "account", "org", "asset", "file", "clear", "refresh"]) {
    const fixture = savedFixture(1), pending = deferred();
    const ui = await boot(t, { user: true, handle: savedApi([fixture], call => call.path.includes("/artifacts/report.json") ? pending.promise : undefined) });
    await ui.importReport(report({ run: "retained-overlay", fills: exampleFills() }));
    chooseSaved(ui, fixture);
    await until(() => ui.calls.some(c => c.path.includes("/artifacts/")), "pending saved report");
    if (action === "close") { const oldClose = queueNextDialogClose(ui, "report-overlay-dialog"); ui.$("close-report-overlay").click(); ui.$("chart-report").click(); oldClose(); }
    if (action === "escape") { ui.$("report-overlay-dialog").dispatchEvent(new ui.w.Event("cancel")); ui.$("report-overlay-dialog").close(); }
    if (action === "route") { await ui.navigate("#code"); await ui.navigate("#markets"); }
    if (action === "same-market-route") { ui.w.location.hash = "#markets/browse"; await delay(15); }
    if (action === "account") ui.w.chartFixtureState.user = "other-user";
    if (action === "org") ui.w.chartFixtureState.org = "other-org";
    if (action === "asset") {
      for (const ds of [secondDataset,dataset]) { ui.change("market-dataset", ds.dataset_id); await delay(10); }
    }
    if (action === "file") await ui.importReport(report({ run: "new-file-overlay", fills: [fill(450, "buy", "1", "1")] }));
    if (action === "clear") ui.$("clear-overlay").click();
    if (action === "refresh") ui.$("chart-runs-refresh").click();
    const markers = plain(ui.candles().markers);
    pending.resolve(response(fixture.rep)); await delay(30);
    assert.deepEqual(ui.candles().markers, markers, `Stale ${action} completion cannot change markers`);
    assert.doesNotMatch(ui.$("chart-run-selection-status").textContent, /loaded · recorded/);
    assert.doesNotMatch(ui.$("overlay-source").textContent, new RegExp(fixture.row.id));
    assertPickerReads(ui);
  }
});

test("Closing during saved-run source hashing keeps the existing overlay after reopening", async (t) => {
  const fixture = savedFixture(1), pending = deferred();
  const ui = await boot(t, { user: true, handle: savedApi([fixture]), beforeDigest: i => i >= 2 ? pending.promise : undefined });
  await ui.importReport(report({ run: "kept-hash", fills: exampleFills() }));
  chooseSaved(ui, fixture);
  await until(() => ui.digests.length === 4, "saved report hashes in flight");
  ui.$("close-report-overlay").click(); ui.$("chart-report").click();
  const markers = plain(ui.candles().markers);
  pending.resolve(); await delay(30);
  assert.deepEqual(ui.candles().markers, markers);
  assert.match(ui.$("overlay-source").textContent, /kept-hash/);
});

test("Old paginated-list responses cannot repopulate a reopened dialog or a changed account", async (t) => {
  for (const action of ["reopen", "account", "org"]) {
    const old = savedFixture(1), latest = savedFixture(2), pending = deferred(); let reads = 0;
    const ui = await boot(t, { user: true, handle: savedApi([old,latest], call => call.path.includes("/jobs?") ? ++reads === 1 ? pending.promise : response(savedPage([latest])) : undefined) });
    ui.$("chart-report").click();
    if (action === "reopen") { ui.$("close-report-overlay").click(); await openSaved(ui); }
    if (action === "account") ui.w.chartFixtureState.user = "new-user";
    if (action === "org") ui.w.chartFixtureState.org = "new-org";
    pending.resolve(response(savedPage([old]))); await delay(30);
    assert.equal(ui.doc.querySelector(`[data-chart-run="${old.row.id}"]`), null);
    assertPickerReads(ui);
  }
});

test("Older-page transient failures allow explicit retry without losing rows; access failures clear private run rows", async (t) => {
  const a = savedFixture(2), b = savedFixture(1); let older = 0;
  const ui = await boot(t, { user: true, handle: savedApi([a,b], call => {
    if (call.path === "/v1/orgs/fixture-org/jobs?limit=25") return response(savedPage([a], "older"));
    if (call.path.includes("cursor=older")) return ++older === 1 ? response({ detail: "Retry later" }, 503) : response(savedPage([b]));
  }) });
  await openSaved(ui); ui.$("chart-runs-more").click();
  await until(() => /Retry later/.test(ui.$("chart-runs-status").textContent), "older-page error");
  assert.equal(ui.doc.querySelectorAll("[data-chart-run]").length, 1);
  assert.equal(ui.$("chart-runs-more").hidden, false); ui.$("chart-runs-more").click();
  await until(() => ui.doc.querySelectorAll("[data-chart-run]").length === 2, "explicit retry");
  assert.equal(older, 2);
  const denied = await boot(t, { user: true, handle: savedApi([a], call => {
    if (call.path === "/v1/orgs/fixture-org/jobs?limit=25") return response(savedPage([a], "older"));
    if (call.path.includes("cursor=older")) return response({ detail: "Access unavailable" }, 403);
  }) });
  await openSaved(denied); denied.$("chart-runs-more").click();
  await until(() => /Access unavailable/.test(denied.$("chart-runs-status").textContent), "access failure");
  assert.equal(denied.doc.querySelectorAll("[data-chart-run]").length, 0);
  assert.equal(denied.$("chart-runs-more").hidden, true);
});

test("The chart picker stops after twenty explicit pages and labels its bound without background reads", async (t) => {
  let pages = 0;
  const ui = await boot(t, { user: true, handle: call => {
    if (call.path.includes("/jobs?")) return response(savedPage([savedFixture(++pages)], `cursor-${pages}`));
  } });
  await openSaved(ui);
  for (let page = 2; page <= research.SAVED_RUN_LIMITS.pages; page++) {
    ui.$("chart-runs-more").click();
    await until(() => ui.doc.querySelectorAll("[data-chart-run]").length === page, `explicit page ${page}`);
  }
  assert.equal(pages, 20);
  assert.equal(ui.$("chart-runs-more").hidden, true);
  assert.match(ui.$("chart-runs-status").textContent, /list limit reached.*Backtest history/);
  ui.$("chart-runs-more").click(); await delay(20); assert.equal(pages, 20);
  assertPickerReads(ui);
});

test("A saved-run choice supersedes a pending file import and keeps only the matching recorded metadata", async (t) => {
  const fixture = savedFixture(1), pending = deferred();
  const ui = await boot(t, { user: true, handle: savedApi([fixture]) });
  await openSaved(ui);
  ui.selectFile(report({ run: "old-file" }), { read: () => pending.promise });
  chooseSaved(ui, fixture); await loadedSaved(ui, fixture);
  const markers = plain(ui.candles().markers);
  pending.resolve(JSON.stringify(report({ run: "old-file" }))); await ui.settleImports();
  assert.deepEqual(ui.candles().markers, markers);
  assert.match(ui.$("overlay-source").textContent, new RegExp(fixture.row.id));
  assert.match(ui.$("overlay-source").textContent, /Created 2026-01-01T12:00:00.123456Z/);
  await ui.importReport(report({ run: "new-local-file" }));
  assert.equal(ui.$("chart-run-selection-status").textContent, "");
  assert.doesNotMatch(ui.$("overlay-source").textContent, /Created/);
});

test("Clear or a newer saved choice during hashing cannot let old verified fills return", async (t) => {
  for (const action of ["clear", "newer"]) {
    const a = savedFixture(1), b = savedFixture(2, { fills: [fill(450, "buy", "1", "1")] }), pending = deferred();
    const ui = await boot(t, { user: true, handle: savedApi([a,b]), beforeDigest: i => i < 2 ? pending.promise : undefined });
    await openSaved(ui, 2); chooseSaved(ui,a);
    await until(() => ui.digests.length === 2, "old saved hashes");
    if (action === "clear") ui.$("clear-overlay").click();
    else { chooseSaved(ui,b); await loadedSaved(ui,b); }
    const markers = plain(ui.candles().markers), status = ui.$("chart-run-selection-status").textContent;
    pending.resolve(); await delay(30);
    assert.deepEqual(ui.candles().markers, markers);
    assert.equal(ui.$("chart-run-selection-status").textContent, status);
  }
});

test("Pending source bars and stale errors do not replace a newer file overlay", async (t) => {
  for (const reject of [false,true]) {
    const fixture = savedFixture(1, { asset: secondDataset }), pending = deferred();
    const ui = await boot(t, { user: true, handle: savedApi([fixture], call => call.path.includes(secondDataset.dataset_id + "/bars") ? pending.promise : undefined) });
    await openSaved(ui); chooseSaved(ui,fixture);
    await until(() => ui.calls.some(c => c.path.includes(secondDataset.dataset_id + "/bars")), "pending source bars");
    await ui.importReport(report({ run: "new-local", fills: exampleFills() }));
    const markers = plain(ui.candles().markers);
    pending.resolve(response(reject ? { detail: "STALE SOURCE FAILURE" } : { bars: sourceBars }, reject ? 503 : 200)); await delay(30);
    assert.deepEqual(ui.candles().markers, markers);
    assert.equal(ui.$("market-dataset").value, dataset.dataset_id);
    assert.doesNotMatch(ui.$("chart-run-selection-status").textContent, /STALE|loaded · recorded/);
  }
});

test("Saved labels are text-only and empty/incomplete reports keep honest fill counts", async (t) => {
  const fixture = savedFixture(1, { fills: [] });
  fixture.row.project_name = '<img src=x onerror="alert(1)">';
  fixture.rep = report({ run: fixture.row.id, processed: 0 });
  fixture.rep.provenance.code.project_version_id = fixture.row.project_version_id;
  fixture.job.outcome = fixture.row.outcome = "incomplete";
  const ui = await boot(t, { user: true, handle: savedApi([fixture]) });
  await openSaved(ui); chooseSaved(ui,fixture); await loadedSaved(ui,fixture);
  assert.match(ui.$("chart-run-list").textContent, /<img src=x/);
  assert.equal(ui.$("chart-run-list").querySelector("img"), null);
  assert.deepEqual(ui.candles().markers, []);
  assert.match(ui.$("overlay-summary").textContent, /Incomplete backtest.*0\/0 fills shown/);
  assert.match(ui.$("overlay-fill-list").textContent, /No recorded fills/);
  assertPickerReads(ui);
});

test("Workspace access lost while an artifact is pending invalidates the saved selection and preserves the existing overlay", async (t) => {
  for (const status of [401,403,404]) {
    const fixture = savedFixture(1), pending = deferred();
    const ui = await boot(t, { user: true, handle: savedApi([fixture], call => {
      if (call.path === "/v1/orgs/fixture-org/jobs?limit=25") return response(savedPage([fixture], "older"));
      if (call.path.includes("cursor=older")) return response({ detail: "Workspace access unavailable" }, status);
      if (call.path.includes("/artifacts/")) return pending.promise;
    }) });
    await ui.importReport(report({ run: "prior-validated-overlay", fills: exampleFills() }));
    const markers = plain(ui.candles().markers), candles = plain(ui.candles().values);
    chooseSaved(ui,fixture);
    await until(() => ui.calls.some(call => call.path.includes("/artifacts/")), "pending artifact");
    ui.$("chart-runs-more").click();
    await until(() => /Workspace access unavailable/.test(ui.$("chart-runs-status").textContent), "revoked access");
    assert.equal(ui.doc.querySelectorAll("[data-chart-run]").length, 0);
    pending.resolve(response(fixture.rep)); await delay(30);
    assert.deepEqual(ui.candles().markers, markers);
    assert.deepEqual(ui.candles().values, candles);
    assert.match(ui.$("overlay-source").textContent, /prior-validated-overlay/);
    assert.match(ui.$("chart-run-selection-status").textContent, /cancelled.*access is unavailable/);
    assert.equal(ui.digests.length, 2, "The revoked saved report is never verified or committed");
    assertPickerReads(ui);
  }
});

test("History access failure cancels the older saved selection without cancelling a newer local file import", async (t) => {
  for (const status of [401,403,404]) {
    const fixture = savedFixture(1), artifact = deferred(), page = deferred(), file = deferred();
    const ui = await boot(t, { user: true, handle: savedApi([fixture], call => {
      if (call.path === "/v1/orgs/fixture-org/jobs?limit=25") return response(savedPage([fixture], "older"));
      if (call.path.includes("cursor=older")) return page.promise;
      if (call.path.includes("/artifacts/")) return artifact.promise;
    }) });
    await openSaved(ui); chooseSaved(ui,fixture);
    await until(() => ui.calls.some(call => call.path.includes("/artifacts/")), "pending saved artifact");
    ui.$("chart-runs-more").click();
    const local = report({ run: "newer-local-file", fills: exampleFills() });
    ui.selectFile(local, { read: () => file.promise });
    page.resolve(response({ detail: "History access denied" }, status));
    await until(() => /History access denied/.test(ui.$("chart-runs-status").textContent), "denied history");
    assert.match(ui.$("report-import-status").textContent, /^Reading report locally/);
    file.resolve(JSON.stringify(local)); await ui.settleImports();
    assert.match(ui.$("report-import-status").textContent, /Run newer-local/);
    const markers = plain(ui.candles().markers);
    artifact.resolve(response(fixture.rep)); await delay(25);
    assert.deepEqual(ui.candles().markers, markers);
    assert.match(ui.$("overlay-source").textContent, /newer-local-file/);
    assert.equal(ui.doc.querySelectorAll("[data-chart-run]").length, 0);
    assertPickerReads(ui);
  }
});
