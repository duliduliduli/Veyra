"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VeyraReportEvidence = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MISSING = "Not recorded in this report";
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const scalar = (value) => typeof value === "string" && value.trim() !== "" || typeof value === "number" && Number.isFinite(value);
  const numeric = (value) => (typeof value === "number" || typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) && Number.isFinite(Number(value));
  const recorded = (value) => scalar(value) ? String(value) : MISSING;
  const list = (value) => Array.isArray(value) && value.every(scalar) ? value.map(String) : null;
  const bps = (value) => numeric(value) && Number(value) >= 0 ? `${value} bps` : MISSING;

  function timestamp(value) {
    if (typeof value !== "string") return NaN;
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
    if (!match) return NaN;
    const [, year, month, day, hour = "0", minute = "0", second = "0", zone = "Z"] = match;
    const calendar = new Date(0);
    calendar.setUTCFullYear(+year, +month - 1, +day);
    if (+year < 1 || calendar.getUTCFullYear() !== +year || calendar.getUTCMonth() !== +month - 1 || calendar.getUTCDate() !== +day ||
        +hour > 23 || +minute > 59 || +second > 59 || (zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) return NaN;
    return Math.floor(Date.parse(value) / 1000);
  }

  function read(report, job, runId) {
    if (!object(report) || typeof runId !== "string" || !runId || job?.id !== runId || report.run_id !== runId || typeof job.report_id !== "string" || !job.report_id) {
      throw new Error("Report identity is missing or does not match this run. Reopen the run to try again.");
    }
    const provenance = object(report.provenance) ? report.provenance : {};
    const code = object(provenance.code) ? provenance.code : {};
    const dataset = object(provenance.dataset) ? provenance.dataset : {};
    const config = object(job.config) ? job.config : {};
    for (const [actual, expected] of [[code.project_version_id, job.project_version_id],
      [provenance.run_inputs_hash, config.input_hash], [dataset.dataset_id, config.dataset_id]]) {
      if (actual != null && (typeof actual !== "string" || !actual.trim() || (expected != null && actual !== expected))) {
        throw new Error("Recorded report inputs do not match this run. Reopen the run to try again.");
      }
    }
    if (!object(report.metrics) || !Array.isArray(report.equity_curve)) {
      throw new Error("The report's metrics or equity curve are missing or unreadable.");
    }
    for (const name of ["percent_profitable", "closed_trade_count", "winning_trade_count", "net_return", "cagr", "max_drawdown", "max_drawdown_days", "sharpe", "fill_count", "trade_count", "total_fees", "exposure"]) {
      const value = report.metrics[name];
      if (value != null && !numeric(value)) {
        throw new Error("The report's metrics are unreadable.");
      }
    }
    const metrics = report.metrics;
    for (const name of ["closed_trade_count", "winning_trade_count", "fill_count", "trade_count", "max_drawdown_days"]) {
      if (metrics[name] != null && (!Number.isSafeInteger(Number(metrics[name])) || Number(metrics[name]) < 0)) {
        throw new Error("The report's trade counts or drawdown duration are invalid.");
      }
    }
    if (metrics.percent_profitable != null && (Number(metrics.percent_profitable) < 0 || Number(metrics.percent_profitable) > 100 ||
        metrics.closed_trade_count != null && Number(metrics.closed_trade_count) === 0) ||
        metrics.winning_trade_count != null && metrics.closed_trade_count != null && Number(metrics.winning_trade_count) > Number(metrics.closed_trade_count)) {
      throw new Error("The report's closed-trade profitability is inconsistent.");
    }
    if (report.complete != null && typeof report.complete !== "boolean" ||
        report.outcome != null && (typeof report.outcome !== "string" || job.outcome != null && report.outcome !== job.outcome) ||
        typeof report.complete === "boolean" && [report.outcome, job.outcome].some((outcome) => outcome != null && report.complete !== (outcome === "completed"))) {
      throw new Error("The report's completion status does not match this run.");
    }
    const bars = object(report.bars) ? report.bars : {};
    for (const count of [bars.processed, bars.total, dataset.bars]) {
      if (count != null && (!numeric(count) || !Number.isSafeInteger(Number(count)) || Number(count) < 0)) {
        throw new Error("The report's bar counts are invalid.");
      }
    }
    if (bars.processed != null && bars.total != null && (Number(bars.processed) > Number(bars.total) || report.complete === true && Number(bars.processed) !== Number(bars.total))) {
      throw new Error("The report's bar counts are inconsistent with its completion status.");
    }
    let previous = -Infinity;
    const equityRows = [];
    const equity = report.equity_curve.map((point) => {
      const time = Array.isArray(point) && point.length === 2 ? timestamp(point[0]) : NaN;
      const value = Array.isArray(point) && numeric(point[1]) ? Number(point[1]) : NaN;
      if (!Number.isFinite(time) || time <= previous || !Number.isFinite(value)) {
        throw new Error("The report's equity curve is unreadable.");
      }
      previous = time;
      equityRows.push({ timestamp: point[0], value: String(point[1]) });
      return { time, value };
    });
    const model = object(report.execution_model) ? report.execution_model : {};
    const synthetic = dataset.provider === "veyra-synthetic";
    const notes = [];
    if (report.complete === false) notes.push(`Incomplete run: ${recorded(bars.processed)} of ${recorded(bars.total)} bars. Not a finished performance report.`);
    else if (report.complete !== true) notes.push("Completion status was not recorded. Do not treat this as a finished performance report.");
    if (synthetic) notes.push("Synthetic development data. Not market history and not evidence of real-world performance.");
    if (typeof report.evidence_note === "string" && report.evidence_note.trim() && !notes.includes(report.evidence_note)) notes.push(report.evidence_note);
    const orders = list(model.order_types), limitations = list(model.not_modeled);
    const findings = Array.isArray(report.quality_findings) ? report.quality_findings : null;
    const checks = { impossible_ohlc: "Impossible OHLC", negative_volume: "Negative volume", nonmonotonic_timestamp: "Nonmonotonic timestamp" };
    return {
      equity, equityRows, note: notes.join(" "),
      source: [
        ["Recorded evidence grade", recorded(report.evidence_grade)],
        ["Run ID", report.run_id], ["Report ID", job.report_id],
        ["Report schema version", recorded(report.schema_version)],
        ["Recorded outcome", recorded(report.outcome)],
        ["Strategy version", scalar(code.version_no) ? `v${code.version_no}` : MISSING],
        ["Strategy version ID", recorded(code.project_version_id)],
        ["Entrypoint", recorded(code.entrypoint)],
        ["Recorded source hash", recorded(code.content_hash)],
        ["Recorded input hash", recorded(provenance.run_inputs_hash)],
        ["Recorded data hash", recorded(dataset.manifest_hash)],
        ["Recorded result digest", recorded(report.result_digest)],
        ["Engine version", recorded(provenance.engine)],
        ["Metric version", recorded(report.metrics.version)],
        ["Parameters", object(provenance.params) ? (Object.keys(provenance.params).length ? JSON.stringify(provenance.params, null, 2) : "None (empty recorded parameters)") : MISSING],
        ["Starting cash (quote units)", recorded(provenance.starting_cash)],
        ["Resource class", recorded(provenance.resource_class)],
        ["Quote ID", recorded(provenance.quote_id)], ["Rate version", recorded(provenance.rate_version)],
      ],
      execution: [["Fidelity", recorded(model.fidelity)], ["Fill timing", recorded(model.fill_timing)],
        ["Order types", orders ? orders.join(", ") || "None recorded" : MISSING],
        ["Position model", recorded(model.position_model)], ["Taker fee", bps(model.taker_fee_bps)],
        ["Slippage", bps(model.slippage_bps)]],
      limitations: limitations?.length ? limitations : [limitations ? "No exclusions recorded. This does not mean every execution effect was modeled." : "Execution limitations were not recorded in this report."],
      data: [["Dataset ID", recorded(dataset.dataset_id)], ["Provider", recorded(dataset.provider)],
        ["License statement", recorded(dataset.license)], ["Start (UTC, inclusive)", recorded(dataset.start)],
        ["End (UTC, exclusive)", recorded(dataset.end)], ["Dataset bars", recorded(dataset.bars)],
        ["Processed bars", recorded(bars.processed)], ["Expected run bars", recorded(bars.total)]],
      qualitySummary: findings ? (findings.length ? `${findings.length} recorded quality finding${findings.length === 1 ? "" : "s"}${findings.length > 50 ? "; showing the first 50. Report JSON contains the full list" : ""}.`
        : "No quality findings recorded. This is not a comprehensive data-quality guarantee.") : "Quality findings were not recorded in this report; data quality is unknown.",
      quality: (findings || []).slice(0, 50).map((finding) => object(finding)
        ? `${typeof finding.check === "string" && Object.hasOwn(checks, finding.check) ? checks[finding.check] : recorded(finding.check)} · ${recorded(finding.ts)}${Object.keys(finding).some((key) => !["check", "ts"].includes(key)) ? ` · ${JSON.stringify(finding)}` : ""}`
        : scalar(finding) ? String(finding) : "Unreadable recorded finding"),
    };
  }
  return Object.freeze({ read });
});
