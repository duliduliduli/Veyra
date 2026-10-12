(function (root, factory) {
  "use strict";
  const research = factory();
  if (typeof module === "object" && module.exports) module.exports = research;
  else root.VeyraChartResearch = research;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LIMITS = Object.freeze({ reportBytes: 4 * 1024 * 1024, fills: 10000, bars: 10000,
    stringLength: 8192, depth: 12, nodes: 200000 });
  const DATASETS = Object.freeze({ "synth-btcusd-1d-v1": "SYNTH:BTC-USD",
    "synth-ethusd-1d-v1": "SYNTH:ETH-USD" });
  const INTERVALS = Object.freeze(["1d", "3d", "1w", "1M", "30w"]);
  const NOTE = "Imported backtest fills are unverified. Synthetic development data; " +
    "not market history, live trades, or evidence of real-world performance.";
  const validated = new WeakMap();
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const problem = (message) => { throw new Error(message); };
  const object = (value, name) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) problem(`${name} must be an object.`);
  };
  function fields(value, required, optional, name) {
    object(value, name);
    for (const key of required) if (!own(value, key)) problem(`${name}.${key} is required.`);
    for (const key of Object.keys(value)) {
      if (!required.includes(key) && !optional.includes(key)) problem(`Unknown field ${name}.${key}.`);
    }
  }
  function string(value, name, max = 256, empty = false) {
    if (typeof value !== "string" || value.length > max || (!empty && !value.length) ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) problem(`${name} must be a bounded string.`);
    return value;
  }
  function count(value, name, max = LIMITS.bars) {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) problem(`${name} is out of bounds.`);
    return value;
  }
  function array(value, name, max) {
    if (!Array.isArray(value) || value.length > max) problem(`${name} must be an array of at most ${max} items.`);
  }
  function hash(value, name) {
    if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) problem(`${name} must be a SHA-256 digest.`);
  }

  // All numeric conversion is display-only; position validation stays in exact decimal units.
  function decimal(value, name, positive = false) {
    if (typeof value !== "string" || value.length > 80 ||
        !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(value)) {
      problem(`${name} must be a finite decimal string.`);
    }
    const number = Number(value);
    if (!Number.isFinite(number) || (positive ? number <= 0 : number < 0)) problem(`${name} is out of bounds.`);
    const [mantissa, exponent = "0"] = value.toLowerCase().split("e");
    const [whole, fraction = ""] = mantissa.split(".");
    const scale = fraction.length - Number(exponent);
    if (Math.abs(scale) > 100) problem(`${name} decimal scale is out of bounds.`);
    return { number, units: BigInt(whole + fraction), scale };
  }
  function sameDecimal(a, b) {
    const scale = Math.max(a.scale, b.scale);
    return a.units * 10n ** BigInt(scale - a.scale) === b.units * 10n ** BigInt(scale - b.scale);
  }
  function addDecimal(a, b, sign = 1n) {
    const scale = Math.max(a.scale, b.scale);
    return { units: a.units * 10n ** BigInt(scale - a.scale) + sign * b.units * 10n ** BigInt(scale - b.scale), scale };
  }

  /** Wilder RSI: period price changes, first value at index period. Missing/non-finite
   * closes reset the seed; no skipped-gap bridging. No changes => 50, only gains => 100,
   * only losses => 0. Compute on complete aggregated history before cropping the range. */
  function rsi(closes, period = 14) {
    array(closes, "closes", LIMITS.bars);
    if (!Number.isInteger(period) || period < 1 || period > LIMITS.bars) problem("RSI period is out of bounds.");
    let previous = null, changes = 0, gain = 0, loss = 0;
    return Array.from(closes, (close) => {
      if (!Number.isFinite(close) || (previous !== null && !Number.isFinite(close - previous))) {
        previous = null; changes = gain = loss = 0;
        return null;
      }
      if (previous === null) { previous = close; return null; }
      const change = close - previous;
      previous = close;
      const up = Math.max(change, 0), down = Math.max(-change, 0);
      if (changes < period) {
        gain += up / period; loss += down / period; changes++;
      } else {
        gain = gain * ((period - 1) / period) + up / period;
        loss = loss * ((period - 1) / period) + down / period;
      }
      if (changes < period) return null;
      return loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
    });
  }

  function timestamp(value, name = "timestamp") {
    if (typeof value !== "string") problem(`${name} must be an ISO timestamp with a timezone.`);
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) problem(`${name} must be an ISO timestamp with a timezone.`);
    const [, yy, mm, dd, hh, mi, ss, , zone] = match;
    const calendar = new Date(0);
    calendar.setUTCFullYear(+yy, +mm - 1, +dd);
    calendar.setUTCHours(+hh, +mi, +ss, 0);
    if (+yy < 1 || calendar.getUTCFullYear() !== +yy || calendar.getUTCMonth() !== +mm - 1 ||
        calendar.getUTCDate() !== +dd || +hh > 23 || +mi > 59 || +ss > 59 ||
        (zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) problem(`${name} is not a valid calendar timestamp.`);
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) problem(`${name} is not a valid timestamp.`);
    return ms / 1000;
  }
  function day(value, name) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) problem(`${name} must be an ISO date.`);
    return timestamp(value + "T00:00:00Z", name);
  }
  function bucketTime(value, interval) {
    if (!INTERVALS.includes(interval)) problem("Unsupported chart interval.");
    const seconds = typeof value === "number" ? value : timestamp(value);
    if (!Number.isFinite(seconds) || !Number.isSafeInteger(seconds * 1000) ||
        Math.abs(seconds) > 864e10) problem("Invalid chart timestamp.");
    const ms = seconds * 1000;
    if (interval === "1M") {
      const date = new Date(ms);
      date.setUTCDate(1); date.setUTCHours(0, 0, 0, 0);
      return date.getTime() / 1000;
    }
    const width = { "1d": 1, "3d": 3, "1w": 7, "30w": 210 }[interval] * 86400;
    const origin = interval.endsWith("w") ? Date.UTC(1970, 0, 5) / 1000 : 0;
    return origin + Math.floor((seconds - origin) / width) * width;
  }

  function parseJSON(text) {
    if (typeof text !== "string" || text.length > LIMITS.reportBytes ||
        new TextEncoder().encode(text).length > LIMITS.reportBytes) problem("Report JSON exceeds the 4 MiB limit.");
    let report;
    try { report = JSON.parse(text); } catch { problem("Report must be valid JSON."); }
    let nodes = 0;
    function bounded(value, depth) {
      if (++nodes > LIMITS.nodes || depth > LIMITS.depth) problem("Report structure exceeds safe limits.");
      if (typeof value === "string" && value.length > LIMITS.stringLength) problem("Report contains an overlong string.");
      if (typeof value === "number" && !Number.isFinite(value)) problem("Report contains a non-finite number.");
      if (value && typeof value === "object") {
        if (Object.keys(value).length > LIMITS.fills) problem("Report collection exceeds safe limits.");
        for (const [key, child] of Object.entries(value)) {
          if (["__proto__", "prototype", "constructor"].includes(key) || key.length > 128) problem("Report contains an unsafe field name.");
          bounded(child, depth + 1);
        }
      }
    }
    bounded(report, 0);
    return report;
  }
  function datasetIdentity(dataset) {
    object(dataset, "Selected dataset");
    if (!own(DATASETS, dataset.dataset_id) || dataset.instrument_id !== DATASETS[dataset.dataset_id] ||
        dataset.provider !== "veyra-synthetic" || dataset.resolution !== "1d" ||
        dataset.price_basis !== "synthetic last") problem("Select a supported synthetic daily dataset.");
    hash(dataset.manifest_hash, "Selected dataset manifest_hash");
    return [dataset.dataset_id, dataset.instrument_id, dataset.provider, dataset.manifest_hash].join("|");
  }
  function sourceData(dataset, sourceBars) {
    const identity = datasetIdentity(dataset);
    array(sourceBars, "sourceBars", LIMITS.bars);
    if (!sourceBars.length || dataset.bars !== sourceBars.length) problem("Complete source history is required.");
    let previous = -Infinity;
    const times = sourceBars.map((bar, i) => {
      fields(bar, ["ts", "open", "high", "low", "close", "volume"], [], `sourceBars[${i}]`);
      const time = timestamp(bar.ts, `sourceBars[${i}].ts`);
      if (!/^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(bar.ts) || time <= previous) problem("Source daily bars must be unique and increasing at UTC midnight.");
      previous = time;
      const values = {};
      for (const key of ["open", "high", "low", "close", "volume"]) values[key] = decimal(bar[key], `sourceBars[${i}].${key}`, key !== "volume").number;
      if (values.low > Math.min(values.open, values.close) || values.high < Math.max(values.open, values.close)) problem("Source candle OHLC is invalid.");
      return time;
    });
    if (timestamp(dataset.coverage_start) !== times[0] || timestamp(dataset.coverage_end) !== times.at(-1)) problem("Source coverage does not match the selected dataset.");
    return { identity, times, rows: sourceBars.map((bar) => [bar.ts, bar.open, bar.high, bar.low, bar.close, bar.volume].join(",")) };
  }
  async function csvHash(rows) {
    if (!globalThis.crypto?.subtle) problem("Web Crypto is required to verify the dataset; use a secure browser context.");
    const csv = "ts,open,high,low,close,volume\n" + rows.join("\n") + "\n";
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(csv));
    return "sha256:" + Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, "0")).join("");
  }

  function metadata(report) {
    fields(report, ["schema_version", "run_id", "outcome", "evidence_grade", "evidence_note", "complete", "bars", "metrics", "execution_model", "quality_findings", "equity_curve", "fills", "rejections", "strategy_logs", "provenance", "receipt", "result_digest"], [], "report");
    if (report.schema_version !== 1) problem("Unsupported report schema version.");
    string(report.run_id, "run_id", 128);
    if (!["completed", "incomplete", "cancelled", "failed"].includes(report.outcome) ||
        report.complete !== (report.outcome === "completed")) problem("Report completion status is inconsistent.");
    if (report.evidence_grade !== "platform-reproduced backtest") problem("Only backtest reports are supported.");
    string(report.evidence_note, "evidence_note", 1024);
    hash(report.result_digest, "result_digest");
    fields(report.bars, ["total", "processed"], [], "bars");
    count(report.bars.total, "bars.total"); count(report.bars.processed, "bars.processed");
    if (report.bars.processed > report.bars.total || (report.complete && report.bars.processed !== report.bars.total)) problem("Report bar counts are inconsistent.");
    const metricNames = ["definitions", "percent_profitable", "closed_trade_count", "winning_trade_count", "trade_count", "fill_count", "total_fees", "net_return", "cagr", "volatility_ann", "sharpe", "max_drawdown", "max_drawdown_days", "starting_equity", "ending_equity", "calendar_days", "monthly_returns", "exposure"];
    fields(report.metrics, ["version"], metricNames, "metrics");
    if (!["metrics-v1", "metrics-v2"].includes(report.metrics.version)) problem("Unsupported metrics version.");
    for (const [key, value] of Object.entries(report.metrics)) {
      if (["version", "definitions", "monthly_returns"].includes(key)) continue;
      if (value !== null && (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) || !Number.isFinite(Number(value)))) problem(`metrics.${key} must be numeric or null.`);
      if (["closed_trade_count", "winning_trade_count", "trade_count", "fill_count", "max_drawdown_days", "calendar_days"].includes(key) && value !== null) count(value, `metrics.${key}`, LIMITS.fills);
    }
    if (report.metrics.definitions !== undefined) {
      fields(report.metrics.definitions, [], metricNames, "metrics.definitions");
      for (const [key, value] of Object.entries(report.metrics.definitions)) string(value, `metrics.definitions.${key}`, 2048);
    }
    if (report.metrics.monthly_returns !== undefined) {
      object(report.metrics.monthly_returns, "metrics.monthly_returns");
      for (const [key, value] of Object.entries(report.metrics.monthly_returns)) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key) || value !== null && (typeof value !== "string" || value.length > 80 || !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(value) || !Number.isFinite(Number(value)))) problem("Invalid monthly return.");
      }
    }
    fields(report.execution_model, ["fidelity", "fill_timing", "order_types", "taker_fee_bps", "slippage_bps", "position_model", "not_modeled"], [], "execution_model");
    const model = report.execution_model;
    if (model.fidelity !== "daily-bar" || model.fill_timing !== "next bar open" ||
        model.position_model !== "spot long-only, no leverage" || !Array.isArray(model.order_types) ||
        model.order_types.length !== 1 || model.order_types[0] !== "market") problem("Unsupported backtest execution model.");
    for (const key of ["taker_fee_bps", "slippage_bps"]) if (decimal(model[key], key).number > 1000) problem(`${key} exceeds the supported model.`);
    array(model.not_modeled, "not_modeled", 32);
    model.not_modeled.forEach((item) => string(item, "not_modeled item"));
    array(report.quality_findings, "quality_findings", LIMITS.bars);
    report.quality_findings.forEach((item) => {
      fields(item, ["ts", "check"], [], "quality finding"); timestamp(item.ts); string(item.check, "quality check");
    });
    array(report.rejections, "rejections", LIMITS.fills);
    report.rejections.forEach((item) => {
      fields(item, ["client_id", "reason"], ["ts"], "rejection");
      string(item.client_id, "rejection.client_id", 160); string(item.reason, "rejection.reason");
      if (item.ts !== undefined) timestamp(item.ts);
    });
    array(report.strategy_logs, "strategy_logs", 200);
    report.strategy_logs.forEach((item) => {
      fields(item, ["ts", "message"], [], "strategy log"); timestamp(item.ts); string(item.message, "strategy log message", 1000, true);
    });
    if (report.receipt !== null) {
      fields(report.receipt, ["currency", "rate_version", "rate_source", "platform_fee_bps", "authorized_max_nano", "supplier_cost_nano", "platform_fee_nano", "customer_charge_nano", "absorbed_by_platform_nano", "released_nano", "tax_nano", "lines", "charge_usd"], [], "receipt");
      for (const key of ["currency", "rate_version", "rate_source"]) string(report.receipt[key], `receipt.${key}`);
      for (const key of ["platform_fee_bps", "authorized_max_nano", "supplier_cost_nano", "platform_fee_nano", "customer_charge_nano", "absorbed_by_platform_nano", "released_nano", "tax_nano"]) {
        if (key !== "tax_nano" || report.receipt[key] !== null) count(report.receipt[key], `receipt.${key}`, Number.MAX_SAFE_INTEGER);
      }
      decimal(report.receipt.charge_usd, "receipt.charge_usd");
      array(report.receipt.lines, "receipt.lines", 1000);
      report.receipt.lines.forEach((line) => {
        fields(line, ["supplier", "meter", "units", "unit", "supplier_cost_nano", "detail"], [], "receipt line");
        for (const key of ["supplier", "meter", "unit"]) string(line[key], `receipt line.${key}`);
        decimal(line.units, "receipt line.units"); count(line.supplier_cost_nano, "receipt line.supplier_cost_nano", Number.MAX_SAFE_INTEGER);
        object(line.detail, "receipt line.detail");
      });
    }
  }

  /** Strict schema-v1 import. Hashes verify matching source data, not report authorship.
   * Keeps only immutable overlay fields; drops metrics, receipts, logs, and params. */
  async function validateReportJSON(text, { dataset, sourceBars } = {}) {
    const report = parseJSON(text);
    metadata(report);
    const source = sourceData(dataset, sourceBars);
    const prov = report.provenance;
    fields(prov, ["run_inputs_hash", "code", "dataset", "engine", "rate_version", "params", "starting_cash", "resource_class", "quote_id"], [], "provenance");
    hash(prov.run_inputs_hash, "provenance.run_inputs_hash");
    fields(prov.code, ["project_version_id", "version_no", "content_hash", "entrypoint"], [], "provenance.code");
    string(prov.code.project_version_id, "project_version_id", 128); count(prov.code.version_no, "version_no", Number.MAX_SAFE_INTEGER);
    hash(prov.code.content_hash, "content_hash"); string(prov.code.entrypoint, "entrypoint", 256);
    for (const key of ["engine", "rate_version", "quote_id"]) string(prov[key], `provenance.${key}`, 128);
    if (!/^veyra-sim==\d+\.\d+\.\d+$/.test(prov.engine)) problem("Unsupported simulation engine.");
    if (!["small", "standard", "large"].includes(prov.resource_class)) problem("Unsupported resource_class.");
    decimal(prov.starting_cash, "starting_cash", true); object(prov.params, "params");
    if (new TextEncoder().encode(JSON.stringify(prov.params)).length > 8192) problem("Strategy parameters exceed 8 KiB.");
    const ds = prov.dataset;
    fields(ds, ["dataset_id", "provider", "license", "manifest_hash", "start", "end", "bars"], [], "provenance.dataset");
    string(ds.license, "provenance.dataset.license", 1024);
    if (ds.dataset_id !== dataset.dataset_id || ds.provider !== dataset.provider || ds.license !== dataset.license) problem("Report dataset provenance does not match the selected dataset.");
    hash(ds.manifest_hash, "provenance.dataset.manifest_hash");
    const start = day(ds.start, "dataset.start"), end = day(ds.end, "dataset.end");
    if (start >= end) problem("Report range must have start before end.");
    const indices = source.times.map((time, i) => time >= start && time < end ? i : -1).filter((i) => i >= 0);
    if (!indices.length || ds.bars !== indices.length || report.bars.total !== indices.length) problem("Report range and source bar counts do not match.");
    const processed = indices.slice(0, report.bars.processed).map((i) => source.times[i]);
    const processedTimes = new Set(processed);
    array(report.equity_curve, "equity_curve", LIMITS.bars);
    if (report.equity_curve.length !== processed.length) problem("Report equity and processed bar counts do not match.");
    report.equity_curve.forEach((point, i) => {
      if (!Array.isArray(point) || point.length !== 2 || timestamp(point[0]) !== processed[i]) problem("Equity timestamps do not match processed source bars.");
      decimal(point[1], "equity value");
    });
    array(report.fills, "fills", LIMITS.fills);
    if (report.metrics.fill_count !== undefined && report.metrics.fill_count !== report.fills.length) problem("Report fill count is inconsistent.");
    let position = { units: 0n, scale: 0 }, previous = -Infinity;
    const fills = report.fills.map((fill, i) => {
      fields(fill, ["ts", "client_id", "side", "qty", "price", "fee", "cash_after", "position_after"], [], `fills[${i}]`);
      const time = timestamp(fill.ts, `fills[${i}].ts`);
      if (time < previous || !processedTimes.has(time)) problem("Fill timestamps must be ordered and match processed source bars.");
      previous = time;
      if (!["buy", "sell"].includes(fill.side)) problem("Only executed buy/sell fills are supported.");
      string(fill.client_id, "fill.client_id", 160);
      const qty = decimal(fill.qty, "fill.qty", true), price = decimal(fill.price, "fill.price", true);
      decimal(fill.fee, "fill.fee"); decimal(fill.cash_after, "fill.cash_after");
      const after = decimal(fill.position_after, "fill.position_after");
      position = addDecimal(position, qty, fill.side === "buy" ? 1n : -1n);
      if (position.units < 0n || !sameDecimal(position, after)) problem("Fill positions do not match a flat-starting, long-only backtest.");
      return Object.freeze({ index: i, time, ts: fill.ts, client_id: fill.client_id,
        side: fill.side, kind: fill.side === "buy" ? "entry" : "exit", qty: fill.qty,
        price: fill.price, fee: fill.fee, position_after: fill.position_after,
        chartPrice: price.number });
    });
    const fullRows = source.rows.slice(), subsetRows = indices.map((i) => source.rows[i]);
    const expectedFull = dataset.manifest_hash, expectedSubset = ds.manifest_hash;
    const [fullHash, subsetHash] = await Promise.all([csvHash(fullRows), csvHash(subsetRows)]);
    if (fullHash !== expectedFull || subsetHash !== expectedSubset) problem("Source data hash does not match the catalog or report provenance.");
    const snapshot = Object.freeze({ schema_version: 1, run_id: report.run_id,
      dataset_id: ds.dataset_id, instrument_id: DATASETS[ds.dataset_id], provider: ds.provider,
      source_manifest_hash: fullHash, subset_manifest_hash: subsetHash,
      run_inputs_hash: prov.run_inputs_hash, result_digest: report.result_digest,
      project_version_id: prov.code.project_version_id, version_no: prov.code.version_no,
      complete: report.complete, outcome: report.outcome,
      bars: Object.freeze({ ...report.bars }), range: Object.freeze({ start: ds.start, end: ds.end }),
      fills: Object.freeze(fills), note: NOTE, provenance_verified: false, source_data_verified: true });
    validated.set(snapshot, { identity: source.identity, times: source.times });
    return snapshot;
  }

  /** At most two markers per displayed candle: entry/exit arrows, count-only labels.
   * A marker group's fillIndices index report.fills for an inspectable details panel.
   * Exits can be partial exits, and entries can add to an existing long position. */
  function buildOverlay(report, { dataset, candles, interval } = {}) {
    const source = validated.get(report);
    if (!source) problem("Import and validate a backtest report first.");
    if (datasetIdentity(dataset) !== source.identity) problem("Select the report's exact synthetic dataset.");
    if (!INTERVALS.includes(interval)) problem("Unsupported chart interval.");
    array(candles, "candles", LIMITS.bars);
    const available = new Set(source.times.map((time) => bucketTime(time, interval)));
    const visible = new Set();
    let previous = -Infinity;
    for (const candle of candles) {
      if (!candle || typeof candle.time !== "number" || !Number.isFinite(candle.time) ||
          candle.time <= previous || bucketTime(candle.time, interval) !== candle.time ||
          !available.has(candle.time)) problem("Displayed candles must be ordered source-data buckets for the selected interval.");
      previous = candle.time; visible.add(candle.time);
    }
    const byKey = new Map();
    let entries = 0, exits = 0;
    for (const fill of report.fills) {
      const time = bucketTime(fill.time, interval);
      if (!visible.has(time)) continue;
      const id = `${time}:${fill.kind}`;
      if (!byKey.has(id)) byKey.set(id, { id, time, kind: fill.kind, count: 0, fillIndices: [] });
      const group = byKey.get(id);
      group.count++; group.fillIndices.push(fill.index);
      if (fill.kind === "entry") entries++; else exits++;
    }
    const groups = [...byKey.values()].sort((a, b) => a.time - b.time || (a.kind === b.kind ? 0 : a.kind === "entry" ? -1 : 1));
    const markers = groups.map((group) => ({ id: group.id, time: group.time,
      position: group.kind === "entry" ? "belowBar" : "aboveBar",
      shape: group.kind === "entry" ? "arrowUp" : "arrowDown",
      color: group.kind === "entry" ? "#141414" : "#ff5a1f",
      text: group.count > 1 ? String(group.count) : "", size: 1 }));
    return { markers, groups, summary: { run_id: report.run_id, dataset_id: report.dataset_id,
      complete: report.complete, outcome: report.outcome, totalFills: report.fills.length,
      displayedFills: entries + exits, hiddenFills: report.fills.length - entries - exits,
      entryFills: entries, exitFills: exits, markerCount: markers.length,
      note: NOTE, source_data_verified: true, provenance_verified: false } };
  }

  const SAVED_RUN_LIMITS = Object.freeze({ pageSize: 25, pages: 20 });
  const runId = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  function runTime(value) {
    // Parse calendar validity at JS precision; ordering below retains all six API digits.
    if (typeof value !== "string" || !/T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) problem("Run date is unavailable.");
    return timestamp(value.replace(/(\.\d{3})\d+/, "$1"));
  }
  function readSavedRunPage(result, rows = [], cursors = []) {
    object(result, "Run history page");
    array(result.jobs, "Run history jobs", SAVED_RUN_LIMITS.pageSize);
    if (typeof result.has_more !== "boolean" || (result.has_more
      ? typeof result.next_cursor !== "string" || !/^[A-Za-z0-9_+/=-]{1,512}$/.test(result.next_cursor) ||
        cursors.includes(result.next_cursor) || !result.jobs.length
      : result.next_cursor !== null)) problem("Run history pagination is invalid or repeated. Refresh to try again.");
    if (cursors.length >= SAVED_RUN_LIMITS.pages || rows.length + result.jobs.length > SAVED_RUN_LIMITS.pageSize * SAVED_RUN_LIMITS.pages) problem("Run history limit reached.");
    const known = new Set(rows.map((row) => row.id));
    const jobs = result.jobs.map((row) => {
      object(row, "Run history row");
      if (![row.id, row.project_id, row.project_version_id].every(runId) || row.report_id !== null && !runId(row.report_id) || known.has(row.id)) problem("Run history contains an invalid or duplicate identity. Refresh to try again.");
      known.add(row.id);
      string(row.project_name, "Strategy name", 200);
      if (!Number.isSafeInteger(row.version_no) || row.version_no < 1) problem("Saved strategy version is unavailable.");
      if (!["queued", "running", "finalizing", "stopping", "settled"].includes(row.state) ||
        row.outcome !== null && !["completed", "incomplete", "cancelled", "failed"].includes(row.outcome)) problem("Run status is unavailable.");
      const created = runTime(row.created_at);
      const fraction = /\.(\d{1,6})(?:Z|[+-])/.exec(row.created_at)?.[1] || "";
      const created_order = new Date(Math.round(created * 1000)).toISOString().slice(0, 19) + "." + fraction.padEnd(6, "0");
      if (row.dataset_id !== null) string(row.dataset_id, "Run dataset", 256);
      if (row.start !== null) day(row.start, "Run start");
      if (row.end !== null) day(row.end, "Run end");
      const unavailable = !row.report_id ? "No saved report" : row.state !== "settled" ? "Report not settled"
        : !row.outcome ? "Recorded outcome unavailable"
        : !own(DATASETS, row.dataset_id) ? "Dataset unavailable on chart"
        : !row.start || !row.end || row.start >= row.end ? "Recorded date range unavailable" : null;
      return Object.freeze({ id: row.id, project_id: row.project_id, project_name: row.project_name,
        project_version_id: row.project_version_id, version_no: row.version_no, report_id: row.report_id,
        state: row.state, outcome: row.outcome, dataset_id: row.dataset_id, start: row.start, end: row.end,
        created_at: row.created_at, created, created_order, unavailable });
    });
    return { rows: [...rows, ...jobs].sort((a, b) => b.created_order.localeCompare(a.created_order) || b.id.localeCompare(a.id)), cursor: result.next_cursor };
  }
  function groupSavedRuns(rows) {
    const groups = new Map();
    for (const row of [...rows].sort((a, b) => b.created_order.localeCompare(a.created_order) || b.id.localeCompare(a.id))) {
      if (!groups.has(row.project_id)) groups.set(row.project_id, { id: row.project_id, name: row.project_name, dates: new Map() });
      const dates = groups.get(row.project_id).dates, date = new Date(row.created * 1000).toISOString().slice(0, 10);
      if (!dates.has(date)) dates.set(date, []);
      dates.get(date).push(row);
    }
    return [...groups.values()].map((group) => ({ ...group, dates: [...group.dates].map(([date, runs]) => ({ date, runs })) }));
  }
  function checkSavedRun(job, row, org) {
    if (!job || row.unavailable || job.id !== row.id || job.org_id !== org || job.report_id !== row.report_id ||
      job.project_version_id !== row.project_version_id || job.state !== "settled" || job.outcome !== row.outcome ||
      job.created_at !== row.created_at) problem("Saved run identity changed or its report is unavailable. Refresh the list.");
    const config = job.config;
    if (!config || config.project_version_id !== row.project_version_id || config.dataset_id !== row.dataset_id ||
      config.start !== row.start || config.end !== row.end) problem("Saved run inputs do not match its history entry. Refresh the list.");
    hash(config.input_hash, "Saved run input_hash");
  }

  return Object.freeze({ LIMITS, INTERVALS, NOTE, rsi, bucketTime, validateReportJSON, buildOverlay,
    SAVED_RUN_LIMITS, readSavedRunPage, groupSavedRuns, checkSavedRun });
});
