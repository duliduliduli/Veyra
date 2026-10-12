// Synthetic run lifecycle checks: no browser, server, code execution, billing or real API writes.
// NODE_PATH=/path/to/jsdom/node_modules node --test tests/e2e/run-lifecycle-ui.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "workspace-store.js", "studio-assistant.js", "saved-links.js", "proposal-diff.js", "strategy-backup.js", "report-evidence.js", "app.js"]
  .map((name) => readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
const plain = (value) => JSON.parse(JSON.stringify(value));
const response = (value, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => plain(value) });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(condition, label) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail(`Timed out waiting for ${label}`);
}
async function boot(t, { hash = "#code", handle } = {}) {
  const errors = [], calls = [], downloads = [], equityUpdates = [], polls = new Map();
  const console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: `https://veyra.test/${hash}`, runScripts: "outside-only", virtualConsole: console });
  const w = dom.window, doc = w.document, $ = (id) => doc.getElementById(id);
  t.after(() => { w.close(); assert.deepEqual(errors, []); });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.localStorage.setItem("veyra.user", "synthetic-fixture-user");
  const set = w.setTimeout.bind(w), clear = w.clearTimeout.bind(w); let timerId = 0;
  w.setTimeout = (fn, ms, ...args) => {
    if (ms !== 1500) return set(fn, ms, ...args);
    const id = --timerId; polls.set(id, fn); return id;
  };
  w.clearTimeout = (id) => { if (polls.has(id)) polls.delete(id); else clear(id); };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  const series = () => ({ setData(data) { equityUpdates.push(plain(data)); }, applyOptions() {} });
  w.LightweightCharts = { createChart: () => ({ addLineSeries: series, timeScale: () => ({ fitContent() {} }) }) };
  const blobs = new Map();
  w.URL.createObjectURL = (blob) => { const url = `blob:https://veyra.test/${blobs.size}`; blobs.set(url, blob); return url; };
  w.URL.revokeObjectURL = (url) => blobs.delete(url);
  doc.addEventListener("click", (e) => {
    const link = e.target.closest("a[download]");
    if (link) { e.preventDefault(); downloads.push({ name: link.download, blob: blobs.get(link.href) }); }
  });
  w.fetch = async (path, options = {}) => {
    const call = { path: String(path), method: options.method || "GET", body: options.body };
    calls.push(call);
    if (path === "/v1/me") return response({ organizations: [{ id: "fixture-org" }] });
    if (path === "/v1/catalog/datasets") return response({ datasets: [] });
    if (path === "/v1/orgs/fixture-org/billing/balance") return response({ available_nano: 0, reserved_nano: 0, settled_usage_nano: 0 });
    const result = await handle?.(call);
    if (result !== undefined) return result;
    errors.push(`Unexpected fake API call: ${call.method} ${path}`);
    return response({ detail: "Unexpected fixture call" }, 500);
  };
  scripts.forEach((script, index) => w.eval(script + (index === scripts.length - 1 ? "\nwindow.runFixtureState = state;" : "")));
  await until(() => !$(`view-${hash.slice(1).split("/")[0]}`).hidden, "initial route");
  await delay(5);
  async function navigate(next) {
    w.location.hash = next;
    await until(() => !$(`view-${next.slice(1).split("/")[0]}`).hidden, `route ${next}`);
    await delay(5);
  }
  async function poll() {
    assert.equal(polls.size, 1, "Exactly one live-run poll");
    const [id, fn] = [...polls][0]; polls.delete(id); fn(); await delay(5);
  }
  return { w, doc, $, calls, downloads, equityUpdates, polls, navigate, poll };
}

const receipt = { supplier_cost_nano: 1, platform_fee_bps: 500, platform_fee_nano: 0,
  customer_charge_nano: 1, authorized_max_nano: 2, released_nano: 1, tax_nano: null };
const settled = (id, extras = {}) => ({ id, project_id: "project-fixture", project_name: "Test strategy", state: "settled",
  outcome: "completed", settled_at: "2026-01-01T00:01:00Z", created_at: "2026-01-01T00:00:00Z", receipt, ...extras });
const live = (id) => ({ ...settled(id), state: "running", outcome: null, receipt: null,
  budget: { reserved_nano: 2 }, progress: { bars_done: 1, bars_total: 100 } });
const report = (id = "a") => ({ run_id: id, complete: true, metrics: { percent_profitable: 99, closed_trade_count: 100,
  winning_trade_count: 99, fill_count: 200, total_fees: "1" }, equity_curve: [["2024-01-01", "10000"]], bars: { processed: 1, total: 1 } });
const routes = (handle) => call => {
  if (call.path === "/v1/orgs/fixture-org/projects") return response({ projects: [], has_more: false, next_cursor: null });
  return handle(call);
};

test("old run response must not replace a completed same-URL revisit or restart polling", async (t) => {
  const old = deferred(); let reads = 0;
  const ui = await boot(t, { hash: "#run/a", user: true, handle: routes(call => {
    if (call.path === "/v1/jobs/a") return ++reads === 1 ? old.promise : response(settled("a"));
  }) });
  await ui.navigate("#code"); await ui.navigate("#run/a");
  await until(() => ui.$("run-state").textContent === "completed", "fresh completed run");
  old.resolve(response(live("a"))); await delay(20);
  assert.equal(ui.$("run-state").textContent, "completed");
  assert.equal(ui.polls.size, 0);
});

test("old report response must not resurrect artifacts after reopening a receipt-only run", async (t) => {
  const old = deferred(); let reads = 0;
  const ui = await boot(t, { hash: "#run/a", user: true, handle: routes(call => {
    if (call.path === "/v1/jobs/a") return response(++reads === 1 ? settled("a", { report_id: "old-report" }) : settled("a", { outcome: "cancelled" }));
    if (call.path === "/v1/reports/old-report/artifacts/report.json") return old.promise;
  }) });
  await until(() => ui.calls.some(call => call.path.includes("old-report")), "first report read");
  await ui.navigate("#code"); await ui.navigate("#run/a");
  await until(() => ui.$("run-state").textContent === "cancelled", "new receipt-only run");
  old.resolve(response(report())); await delay(20);
  assert.equal(ui.$("show-run-chart").hidden, true);
  assert.ok([...ui.doc.querySelectorAll("[data-artifact]")].every(button => button.disabled));
  assert.equal(ui.$("run-profitability").hidden, true);
});

test("late cancellation of run A must leave run B polling and UI alone", async (t) => {
  const cancellation = deferred();
  const ui = await boot(t, { hash: "#run/a", user: true, handle: routes(call => {
    if (call.path === "/v1/jobs/a/cancel") return cancellation.promise;
    if (call.path === "/v1/jobs/a") return response(live("a"));
    if (call.path === "/v1/jobs/b") return response(live("b"));
  }) });
  await until(() => !ui.$("run-cancel").hidden, "running A");
  ui.$("run-cancel").click();
  await ui.navigate("#run/b");
  assert.equal(ui.polls.size, 1, "B has its own poll");
  const bPoll = [...ui.polls.keys()][0];
  cancellation.resolve(response({ ok: true })); await delay(20);
  assert.equal(ui.polls.has(bPoll), true, "A cancellation must not clear B's timer");
  assert.equal(ui.calls.filter(call => call.path === "/v1/jobs/a").length, 1, "A must not be reopened after leaving");
  assert.doesNotMatch(ui.$("status").textContent, /Stop requested/);
});

test("run B loading must not expose run A's Stop control or cancel unreviewed B", async (t) => {
  const pending = deferred();
  const ui = await boot(t, { hash: "#run/a", user: true, handle: routes(call => {
    if (call.path === "/v1/jobs/a") return response(live("a"));
    if (call.path === "/v1/jobs/b") return pending.promise;
    if (call.path === "/v1/jobs/b/cancel") return response({ ok: true });
  }) });
  await until(() => !ui.$("run-cancel").hidden, "running A");
  await ui.navigate("#run/b");
  const stop = ui.$("run-cancel");
  assert.ok(stop.hidden || stop.disabled, "No Stop action before B's current state is loaded");
  stop.click();
  assert.equal(ui.calls.some(call => call.path === "/v1/jobs/b/cancel"), false);
  pending.resolve(response(settled("b")));
  await until(() => ui.$("run-state").textContent === "completed", "B loaded");
});

test("a stale run-list error must not overwrite the new list's successful state", async (t) => {
  const old = deferred();
  const ui = await boot(t, { hash: "#runs/a", user: true, handle: routes(call => {
    if (call.path.includes("/jobs?")) return call.path.includes("project_id=a") ? old.promise : response({ jobs: [], next_cursor: null });
  }) });
  await ui.navigate("#runs/b");
  await until(() => ui.$("runs-scope").textContent.includes("all available"), "new history");
  old.resolve(response({ detail: "OLD REQUEST FAILED" }, 503)); await delay(20);
  assert.doesNotMatch(ui.$("status").textContent, /OLD REQUEST FAILED/);
});

test("late artifact completion must not re-enable a receipt-only new run's unavailable artifacts", async (t) => {
  const pending = deferred(); let blob;
  const ui = await boot(t, { hash: "#run/a", user: true, handle: routes(call => {
    if (call.path === "/v1/jobs/a") return response(settled("a", { report_id: "a-report" }));
    if (call.path === "/v1/jobs/b") return response(settled("b", { outcome: "cancelled" }));
    if (call.path === "/v1/reports/a-report/artifacts/report.json") return response(report());
    if (call.path === "/v1/reports/a-report/artifacts/trades.csv?download=true") return pending.promise;
  }) });
  await until(() => !ui.$("show-run-chart").hidden, "A report");
  const button = ui.doc.querySelector('[data-artifact="trades.csv"]');
  button.click(); await until(() => ui.calls.some(call => call.path.endsWith("?download=true")), "requested artifact");
  await ui.navigate("#run/b");
  await until(() => ui.$("run-state").textContent === "cancelled", "receipt-only B");
  blob = new ui.w.Blob(["synthetic fixture"]);
  pending.resolve({ ok: true, blob: async () => blob }); await delay(20);
  assert.equal(button.disabled, true, "The old busy() finally must not enable B's missing artifact");
});

test("a newer cancellation refresh defeats an older in-flight poll and leaves no settled-run timer", async (t) => {
  const cancellation = deferred(), oldPoll = deferred(); let reads = 0;
  const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
    if (call.path === "/v1/jobs/a/cancel") return cancellation.promise;
    if (call.path === "/v1/jobs/a") {
      reads++;
      return reads === 1 ? response(live("a")) : reads === 2 ? oldPoll.promise : response(settled("a", { outcome: "cancelled" }));
    }
  }) });
  await until(() => !ui.$("run-cancel").hidden, "running A");
  ui.$("run-cancel").click();
  ui.$("run-cancel").dispatchEvent(new ui.w.Event("click"));
  await ui.poll();
  cancellation.resolve(response({ ok: true }));
  await until(() => ui.$("run-state").textContent === "cancelled", "current cancellation refresh");
  oldPoll.resolve(response(live("a"))); await delay(20);
  assert.equal(ui.$("run-state").textContent, "cancelled");
  assert.equal(ui.polls.size, 0);
  assert.equal(ui.calls.filter(call => call.method === "POST").length, 1);
  assert.match(ui.$("status").textContent, /Stop requested.*until its next checkpoint.*final receipt shows measured usage/);
});

test("late cancellation does not refresh the same URL after leaving and reopening it", async (t) => {
  const cancellation = deferred();
  const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
    if (call.path === "/v1/jobs/a/cancel") return cancellation.promise;
    if (call.path === "/v1/jobs/a") return response(live("a"));
  }) });
  await until(() => !ui.$("run-cancel").hidden, "running A");
  ui.$("run-cancel").click();
  await ui.navigate("#code"); await ui.navigate("#run/a");
  const [id] = ui.polls.keys();
  cancellation.resolve(response({ ok: true })); await delay(20);
  assert.equal(ui.calls.filter(call => call.path === "/v1/jobs/a").length, 2);
  assert.ok(ui.polls.has(id));
  assert.equal(ui.$("run-cancel").disabled, false);
  assert.doesNotMatch(ui.$("status").textContent, /Stop requested/);
});

test("stale run, report, cancel and artifact errors cannot replace a newer run's successful state", async (t) => {
  for (const kind of ["run", "report", "cancel", "artifact"]) {
    const pending = deferred();
    const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
      if (call.path === "/v1/jobs/a") return kind === "run" ? pending.promise
        : response(kind === "cancel" ? live("a") : settled("a", { report_id: "a-report" }));
      if (call.path === "/v1/jobs/b") return response(settled("b"));
      if (call.path === "/v1/reports/a-report/artifacts/report.json") return kind === "report" ? pending.promise : response(report());
      if (call.path === "/v1/jobs/a/cancel" || call.path.endsWith("?download=true")) return pending.promise;
    }) });
    if (kind === "cancel") { await until(() => !ui.$("run-cancel").hidden, "cancel action"); ui.$("run-cancel").click(); }
    if (kind === "artifact") { await until(() => !ui.$("show-run-chart").hidden, "artifact action"); ui.doc.querySelector("[data-artifact]").click(); }
    await ui.navigate("#run/b");
    await until(() => ui.$("run-state").textContent === "completed", "new B state");
    pending.resolve(response({ detail: `STALE ${kind} FAILURE` }, 503)); await delay(20);
    assert.equal(ui.$("run-state").textContent, "completed");
    assert.doesNotMatch(ui.$("status").textContent, /STALE/);
    assert.equal(ui.polls.size, 0);
  }
});

test("run-history pagination failure retains every loaded row and cursor for a clean retry", async (t) => {
  let attempts = 0;
  const rows = [settled("first"), settled("second")];
  const ui = await boot(t, { hash: "#runs", handle: routes(call => {
    if (!call.path.includes("/jobs?")) return;
    if (!call.path.includes("cursor=")) return response({ jobs: rows, next_cursor: "older" });
    return ++attempts === 1 ? response({ detail: "Could not load older runs" }, 503)
      : response({ jobs: [rows[1], settled("third")], next_cursor: null });
  }) });
  await until(() => ui.$("run-list").querySelectorAll(".strategy-history li").length === 2, "first history page");
  const before = ui.$("run-list").textContent;
  ui.$("load-more-runs").click();
  await until(() => !ui.$("load-more-runs").disabled, "failed pagination response");
  assert.equal(ui.$("run-list").textContent, before);
  assert.equal(ui.$("load-more-runs").hidden, false);
  ui.$("load-more-runs").click();
  await until(() => ui.$("run-list").querySelectorAll(".strategy-history li").length === 3, "retried page");
  assert.equal(ui.$("load-more-runs").hidden, true);
  assert.equal(ui.$("run-list").querySelectorAll('a[href="#run/second"]').length, 1);
  assert.ok(ui.calls.filter(call => call.path.includes("cursor=")).every(call => call.path.includes("cursor=older")));
});

test("two deliberate artifact downloads retain their report identity and independent button ownership", async (t) => {
  const a = deferred(), b = deferred();
  const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
    for (const id of ["a", "b"]) {
      if (call.path === `/v1/jobs/${id}`) return response(settled(id, { report_id: `${id}-report` }));
      if (call.path === `/v1/reports/${id}-report/artifacts/report.json`) return response(report(id));
      if (call.path === `/v1/reports/${id}-report/artifacts/trades.csv?download=true`) return id === "a" ? a.promise : b.promise;
    }
  }) });
  await until(() => !ui.$("show-run-chart").hidden, "A report");
  const button = ui.doc.querySelector('[data-artifact="trades.csv"]');
  button.click(); button.dispatchEvent(new ui.w.Event("click"));
  await ui.navigate("#run/b");
  await until(() => !ui.$("show-run-chart").hidden, "B report");
  button.click();
  a.resolve({ ok: true, blob: async () => new ui.w.Blob(["A fixture"]) });
  await until(() => ui.downloads.length === 1, "A download completion");
  assert.equal(button.disabled, true, "A's finally cannot enable B's pending download");
  b.resolve({ ok: true, blob: async () => new ui.w.Blob(["B fixture"]) });
  await until(() => ui.downloads.length === 2, "B download completion");
  assert.deepEqual(ui.downloads.map(d => d.name), ["veyra-a-report-trades.csv", "veyra-b-report-trades.csv"]);
  assert.equal(button.disabled, false);
  assert.equal(ui.calls.filter(call => call.path.endsWith("?download=true")).length, 2);
});

test("an obsolete polling callback cannot read or reset a new route", async (t) => {
  const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
    if (call.path === "/v1/jobs/a") return response(live("a"));
    if (call.path === "/v1/jobs/b") return response(settled("b"));
  }) });
  await until(() => ui.polls.size === 1, "A polling");
  const callback = [...ui.polls.values()][0];
  await ui.navigate("#run/b");
  await until(() => ui.$("run-state").textContent === "completed", "B completed");
  const count = ui.calls.length;
  callback(); await delay(10);
  assert.equal(ui.calls.length, count);
  assert.equal(ui.$("run-state").textContent, "completed");
  assert.equal(ui.polls.size, 0);
});

test("a failed fresh history scope never retains rows or counts from the prior scope", async (t) => {
  const scoped = deferred();
  const ui = await boot(t, { hash: "#runs", handle: routes(call => {
    if (!call.path.includes("/jobs?")) return;
    if (call.path.includes("project_id=")) return scoped.promise;
    return response({ jobs: [settled("a", { project_id: "project-a", project_name: "Strategy A" }),
      settled("b", { project_id: "project-b", project_name: "Strategy B" })], next_cursor: "older-all" });
  }) });
  await until(() => ui.$("run-list").querySelectorAll(".strategy-history li").length === 2, "all strategies history");
  assert.match(ui.$("runs-scope").textContent, /2 runs loaded/);
  await ui.navigate("#runs/project-a");
  await until(() => ui.calls.some(call => call.path.includes("project_id=project-a")), "new scope request");
  assert.equal(ui.$("run-list").querySelectorAll(".strategy-history li").length, 0, "Old rows disappear as soon as the scope changes");
  assert.match(ui.$("runs-scope").textContent, /Loading/);
  assert.equal(ui.$("load-more-runs").hidden, true);
  scoped.resolve(response({ detail: "Scoped history unavailable" }, 503));
  await until(() => ui.$("status").textContent.includes("Scoped history unavailable"), "new scope failure");
  assert.equal(ui.$("run-list").querySelectorAll(".strategy-history li").length, 0);
  assert.doesNotMatch(ui.$("run-list").textContent, /Strategy A|Strategy B/);
  assert.match(ui.$("runs-scope").textContent, /Could not load/);
  assert.doesNotMatch(ui.$("runs-scope").textContent, /2 runs loaded|all available runs/);
  assert.equal(ui.$("load-more-runs").hidden, true);
});

const evidenceReport = (id = "a") => ({ ...report(id), schema_version: 1, result_digest: "sha256:fixture-result",
  evidence_grade: "platform-reproduced backtest", metrics: { ...report(id).metrics, version: "metrics-v2" },
  provenance: { run_inputs_hash: "sha256:fixture-inputs", code: { version_no: 4, project_version_id: "fixture-version",
    content_hash: "sha256:fixture-source", entrypoint: "strategy.py" }, dataset: { dataset_id: "fixture-synthetic",
    provider: "veyra-synthetic", manifest_hash: "sha256:fixture-data", license: "synthetic only", start: "2024-01-01",
    end: "2024-01-02", bars: 1 }, params: { window: 12 }, starting_cash: "10000", engine: "veyra-sim==fixture",
    quote_id: "fixture-quote", rate_version: "fixture-rates", resource_class: "small" },
  execution_model: { fidelity: "daily-bar", fill_timing: "next bar open", order_types: ["market"],
    taker_fee_bps: "10", slippage_bps: "5", position_model: "spot long-only, no leverage", not_modeled: ["market impact", "latency"] },
  quality_findings: [{ check: "negative_volume", ts: "2024-01-01T00:00:00Z" }],
});
const artifactButtons = (ui) => [...ui.doc.querySelectorAll("[data-artifact]")];

test("run details display the exact report's recorded provenance, assumptions and quality using read-only requests", async (t) => {
  const rep = evidenceReport();
  const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
    if (call.path === "/v1/jobs/a") return response(settled("a", { report_id: "a-report", project_version_id: "fixture-version",
      config: { input_hash: "sha256:fixture-inputs", dataset_id: "fixture-synthetic" } }));
    if (call.path === "/v1/reports/a-report/artifacts/report.json") return response(rep);
  }) });
  await until(() => !ui.$("run-evidence").hidden, "recorded evidence");
  assert.match(ui.$("run-source-details").textContent, /v4.*fixture-version.*strategy.py.*sha256:fixture-source.*sha256:fixture-inputs.*sha256:fixture-data.*sha256:fixture-result/);
  assert.match(ui.$("run-source-details").textContent, /veyra-sim==fixture.*metrics-v2.*window.*12/s);
  assert.match(ui.$("run-execution-details").textContent, /daily-bar.*next bar open.*market.*long-only.*10 bps.*5 bps/);
  assert.match(ui.$("run-model-limitations").textContent, /market impact.*latency/);
  assert.match(ui.$("run-data-details").textContent, /fixture-synthetic.*veyra-synthetic.*Start \(UTC, inclusive\).*2024-01-01.*End \(UTC, exclusive\).*2024-01-02/);
  assert.match(ui.$("run-quality-findings").textContent, /Negative volume.*2024-01-01/);
  assert.match(ui.$("run-quality-summary").textContent, /1 recorded quality finding/);
  assert.match(ui.$("run-note").textContent, /Synthetic development data.*Not market history/);
  assert.match(ui.$("run-evidence").textContent, /not an independent audit.*separate from the platform compute charges/s);
  assert.equal(ui.$("run-profitability-value").textContent, "99.00%");
  assert.ok(artifactButtons(ui).every(button => !button.disabled));
  assert.ok([...ui.$("run-evidence").querySelectorAll("details")].every(detail => !detail.open));
  assert.ok(ui.calls.every(call => call.method === "GET"));
  assert.equal(ui.calls.filter(call => call.path.includes("/artifacts/")).length, 1);
});

test("missing or foreign report identity never displays evidence or performance and keeps the current job receipt", async (t) => {
  for (const run_id of [undefined, "foreign-run"]) {
    const rep = evidenceReport(); rep.run_id = run_id;
    const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
      if (call.path === "/v1/jobs/a") return response(settled("a", { report_id: "a-report" }));
      if (call.path === "/v1/reports/a-report/artifacts/report.json") return response(rep);
    }) });
    await until(() => !ui.$("run-report-status").hidden, "invalid report message");
    assert.match(ui.$("run-report-status").textContent, /Performance report unavailable.*identity/);
    assert.match(ui.$("run-receipt").textContent, /Compute used.*Charged/);
    for (const id of ["run-evidence", "run-profitability", "equity-chart", "run-equity-heading", "show-run-chart"]) assert.equal(ui.$(id).hidden, true);
    assert.equal(ui.$("run-source-details").textContent, "");
    assert.equal(ui.$("run-equity-rows").textContent, "");
    assert.equal(ui.$("run-equity-table").hidden, true);
    assert.equal(ui.$("run-profitability-value").textContent, "");
    assert.ok(artifactButtons(ui).every(button => button.disabled));
    assert.deepEqual(ui.equityUpdates, []);
    assert.equal(ui.w.runFixtureState.report, null);
  }
});

test("legacy and incomplete reports show missing evidence and explicit completion limitations", async (t) => {
  const rep = { ...report(), complete: false, bars: { processed: 1, total: 12 } };
  const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
    if (call.path === "/v1/jobs/a") return response(settled("a", { outcome: "incomplete", report_id: "a-report" }));
    if (call.path === "/v1/reports/a-report/artifacts/report.json") return response(rep);
  }) });
  await until(() => !ui.$("run-evidence").hidden, "legacy evidence");
  assert.match(ui.$("run-note").textContent, /Incomplete run: 1 of 12 bars.*Not a finished/);
  assert.match(ui.$("run-source-details").textContent, /Recorded source hashNot recorded in this report/);
  assert.match(ui.$("run-execution-details").textContent, /Taker feeNot recorded in this report/);
  assert.match(ui.$("run-model-limitations").textContent, /not recorded/);
  assert.match(ui.$("run-quality-summary").textContent, /data quality is unknown/);
  assert.equal(ui.$("run-profitability-value").textContent, "99.00%");
});

test("receipt-only navigation removes old report text, chart data and expanded sections", async (t) => {
  const pending = deferred();
  const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
    if (call.path === "/v1/jobs/a") return response(settled("a", { report_id: "a-report" }));
    if (call.path === "/v1/reports/a-report/artifacts/report.json") return response(evidenceReport());
    if (call.path === "/v1/jobs/b") return pending.promise;
  }) });
  await until(() => !ui.$("run-evidence").hidden, "A evidence");
  ui.$("run-evidence").querySelector("details").open = true;
  await ui.navigate("#run/b");
  assert.equal(ui.$("run-report").hidden, true);
  assert.equal(ui.$("run-source-details").textContent, "");
  assert.equal(ui.$("run-equity-rows").textContent, "");
  assert.equal(ui.$("run-equity-page-status").textContent, "");
  assert.equal(ui.$("run-equity-values").open, false);
  assert.deepEqual(ui.equityUpdates.at(-1), []);
  pending.resolve(response(settled("b", { outcome: "cancelled" })));
  await until(() => !ui.$("run-report-status").hidden, "receipt only");
  assert.match(ui.$("run-report-status").textContent, /No performance report was recorded/);
  assert.equal(ui.$("run-evidence").hidden, true);
  assert.ok([...ui.$("run-evidence").querySelectorAll("details")].every(detail => !detail.open));
  assert.equal(ui.$("run-profitability-value").textContent, "");
  assert.equal(ui.$("run-equity-heading").hidden, true);
  assert.ok(artifactButtons(ui).every(button => button.disabled));
});

test("malformed report content leaves a receipt and no partial evidence, chart or exports", async (t) => {
  for (const extras of [{ metrics: null }, { equity_curve: [["not-a-date", "20"]] }, { metrics: { net_return: "broken" } }]) {
    const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
      if (call.path === "/v1/jobs/a") return response(settled("a", { report_id: "a-report" }));
      if (call.path === "/v1/reports/a-report/artifacts/report.json") return response({ ...evidenceReport(), ...extras });
    }) });
    await until(() => !ui.$("run-report-status").hidden, "malformed report status");
    assert.match(ui.$("run-report-status").textContent, /Performance report unavailable/);
    assert.match(ui.$("run-receipt").textContent, /Charged/);
    assert.equal(ui.$("run-evidence").hidden, true);
    assert.equal(ui.$("run-source-details").textContent, "");
    assert.equal(ui.$("run-equity-rows").textContent, "");
    assert.equal(ui.$("run-equity-table").hidden, true);
    assert.ok(artifactButtons(ui).every(button => button.disabled));
    assert.deepEqual(ui.equityUpdates, []);
  }
});

test("all report-derived detail is rendered as text and cannot inject HTML", async (t) => {
  const unsafe = '<img src=x onerror="window.reportInjected=true">';
  const rep = evidenceReport(); rep.evidence_note = unsafe; rep.provenance.code.entrypoint = unsafe;
  rep.provenance.params = { unsafe }; rep.execution_model.not_modeled = [unsafe]; rep.quality_findings = [{ check: unsafe, ts: unsafe }];
  const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
    if (call.path === "/v1/jobs/a") return response(settled("a", { report_id: "a-report" }));
    if (call.path === "/v1/reports/a-report/artifacts/report.json") return response(rep);
  }) });
  await until(() => !ui.$("run-evidence").hidden, "escaped details");
  assert.ok(ui.$("run-evidence").textContent.includes(unsafe));
  assert.ok(ui.$("run-note").textContent.includes(unsafe));
  assert.equal(ui.$("run-report").querySelector("img"), null);
  assert.equal(ui.w.reportInjected, undefined);
});

test("old report successes and failures cannot overwrite a same-URL revisit's evidence", async (t) => {
  for (const failure of [false, true]) {
    const old = deferred(); let reads = 0;
    const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
      if (call.path === "/v1/jobs/a") return response(settled("a", { report_id: ++reads === 1 ? "old-report" : "new-report" }));
      if (call.path === "/v1/reports/old-report/artifacts/report.json") return old.promise;
      if (call.path === "/v1/reports/new-report/artifacts/report.json") return response(evidenceReport());
    }) });
    await until(() => ui.calls.some(call => call.path.includes("old-report")), "old read");
    await ui.navigate("#code"); await ui.navigate("#run/a");
    await until(() => !ui.$("run-evidence").hidden, "new evidence");
    const before = ui.$("run-evidence").textContent;
    const stale = evidenceReport(); stale.provenance.code.content_hash = "STALE-SOURCE";
    stale.equity_curve = [["2024-01-01", "999999.0000"]];
    old.resolve(failure ? response({ detail: "STALE-FAILURE" }, 503) : response(stale)); await delay(20);
    assert.equal(ui.$("run-evidence").textContent, before);
    assert.equal(ui.$("run-report-status").hidden, true);
    assert.match(ui.$("run-source-details").textContent, /Report IDnew-report/);
  }
});

test("pending run and report responses cannot disclose data after account or organization changes", async (t) => {
  for (const phase of ["job", "report"]) for (const field of ["user", "org"]) {
    const pending = deferred();
    const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
      if (call.path === "/v1/jobs/a") return phase === "job" ? pending.promise : response(settled("a", { report_id: "a-report" }));
      if (call.path === "/v1/reports/a-report/artifacts/report.json") return pending.promise;
    }) });
    await until(() => ui.calls.some(call => phase === "job" ? call.path === "/v1/jobs/a" : call.path.includes("a-report")), "pending owned request");
    ui.w.runFixtureState[field] = "new-account-value";
    pending.resolve(response(phase === "job" ? settled("a", { report_id: "a-report" }) : evidenceReport())); await delay(20);
    assert.equal(ui.$("run-report").hidden, true);
    assert.equal(ui.$("run-evidence").hidden, true);
    assert.equal(ui.$("run-source-details").textContent, "");
    assert.equal(ui.$("run-equity-rows").textContent, "");
    assert.equal(ui.$("run-equity-table").hidden, true);
    assert.equal(ui.w.runFixtureState.report, null);
    assert.ok(artifactButtons(ui).every(button => button.disabled));
  }
});

test("a job returned for another organization is rejected before receipt or report access", async (t) => {
  const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
    if (call.path === "/v1/jobs/a") return response(settled("a", { org_id: "other-org", report_id: "foreign-report" }));
  }) });
  await until(() => ui.$("status").textContent.includes("Run identity changed"), "organization mismatch");
  assert.equal(ui.$("run-report").hidden, true);
  assert.equal(ui.calls.some(call => call.path.includes("foreign-report")), false);
});

test("deliberate downloads stop delivering after account ownership changes", async (t) => {
  const pending = deferred();
  const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
    if (call.path === "/v1/jobs/a") return response(settled("a", { report_id: "a-report" }));
    if (call.path === "/v1/reports/a-report/artifacts/report.json") return response(evidenceReport());
    if (call.path.endsWith("?download=true")) return pending.promise;
  }) });
  await until(() => !ui.$("show-run-chart").hidden, "report for download");
  ui.doc.querySelector("[data-artifact]").click();
  await until(() => ui.calls.some(call => call.path.endsWith("?download=true")), "download request");
  ui.w.runFixtureState.user = "other-user";
  pending.resolve({ ok: true, blob: async () => new ui.w.Blob(["private fixture"]) }); await delay(20);
  assert.equal(ui.downloads.length, 0);
});

test("late recorded-fills source failures cannot overwrite a newer run or enable its chart action", async (t) => {
  for (const accountChanged of [false, true]) {
    const pending = deferred();
    const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
      if (call.path === "/v1/jobs/a") return response(settled("a", { report_id: "a-report" }));
      if (call.path === "/v1/jobs/b") return response(settled("b"));
      if (call.path === "/v1/reports/a-report/artifacts/report.json") return response(evidenceReport());
      if (call.path === "/v1/catalog/datasets/fixture-synthetic/bars") return pending.promise;
    }) });
    await until(() => !ui.$("show-run-chart").hidden, "A report");
    ui.w.runFixtureState.datasets = [{ dataset_id: "fixture-synthetic" }];
    ui.$("show-run-chart").click();
    ui.$("show-run-chart").dispatchEvent(new ui.w.Event("click"));
    await until(() => ui.calls.some(call => call.path.endsWith("/bars")), "recorded-fills source read");
    if (accountChanged) ui.w.runFixtureState.user = "new-user";
    else {
      await ui.navigate("#run/b");
      await until(() => !ui.$("run-report-status").hidden, "receipt-only B");
    }
    pending.resolve(response({ detail: "STALE SOURCE FAILURE" }, 503)); await delay(20);
    assert.doesNotMatch(ui.$("status").textContent, /STALE SOURCE/);
    assert.equal(ui.$("show-run-chart").disabled, true);
    assert.equal(ui.calls.filter(call => call.path.endsWith("/bars")).length, 1);
  }
});

test("sparse legacy metrics never print undefined or confuse closed-trade counts with fills", async (t) => {
  for (const [metrics, expectedFills] of [[{}, "n/a"], [{ closed_trade_count: 2 }, "n/a"],
    [{ version: "metrics-v1", trade_count: 3 }, "3"], [{ version: "metrics-v2", trade_count: 3 }, "n/a"]]) {
    const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
      if (call.path === "/v1/jobs/a") return response(settled("a", { report_id: "a-report" }));
      if (call.path === "/v1/reports/a-report/artifacts/report.json") return response({ ...report(), metrics });
    }) });
    await until(() => !ui.$("run-evidence").hidden, "sparse report");
    assert.doesNotMatch(ui.$("run-report").textContent, /undefined|NaN/);
    const tile = [...ui.$("run-tiles").children].find(item => item.querySelector("dt").textContent === "Fills");
    assert.equal(tile.querySelector("dd").textContent, expectedFills);
    assert.match(ui.$("run-profitability-definition").textContent, /older report/);
  }
});

const equityCells = (ui) => [...ui.$("run-equity-rows").rows].map(row => [...row.cells].map(cell => cell.textContent));
const pagedReport = (id = "a", count = 101) => ({ ...report(id), bars: { processed: count, total: count },
  equity_curve: Array.from({ length: count }, (_, index) => [new Date(Date.UTC(2024, 0, index + 1)).toISOString(), `${10000 + index}.00000001`]) });
const reportRoute = (rep) => routes(call => {
  if (call.path === `/v1/jobs/${rep.run_id}`) return response(settled(rep.run_id, { report_id: "fixture-report", ...(rep.complete === false ? { outcome: "incomplete" } : {}) }));
  if (call.path === "/v1/reports/fixture-report/artifacts/report.json") return response(rep);
});

function assertEquityCleared(ui) {
  assert.equal(ui.$("run-equity-values").open, false);
  assert.equal(ui.$("run-equity-table").hidden, true);
  assert.equal(ui.$("run-equity-pages").hidden, true);
  assert.equal(ui.$("run-equity-rows").textContent, "");
  assert.equal(ui.$("run-equity-page-status").textContent, "");
  assert.equal(ui.$("run-equity-previous").disabled, true);
  assert.equal(ui.$("run-equity-next").disabled, true);
}

test("collapsed equity table exposes exact quote-unit values and honest UTC timestamp precision", async (t) => {
  const equity_curve = [
    ["2024-01-01", "10000.000100"],
    ["2024-01-01T02:03:04+01:00", "1.00000000E+4"],
    ["2024-01-01T02:03:05.1+01:00", "-0.0000"],
    ["2024-01-01T02:03:06.10+01:00", "1e-999"],
    ["2024-01-01T02:03:07.100+01:00", "9007199254740993.0001"],
    ["2024-01-01T02:03:08.000+01:00", 100],
    ["2024-01-01T02:03:09-01:00", -12.5],
    ["2024-01-02T23:00:00-01:00", "10000.0000000000001"],
    ["2024-01-04", "-0"],
  ];
  const rep = { ...report(), equity_curve };
  const ui = await boot(t, { hash: "#run/a", handle: reportRoute(rep) });
  await until(() => !ui.$("run-evidence").hidden, "equity table");
  const details = ui.$("run-equity-values"), table = ui.$("run-equity-table");
  assert.equal(details.tagName, "DETAILS"); assert.equal(details.open, false);
  assert.equal(details.firstElementChild.tagName, "SUMMARY");
  assert.equal(details.firstElementChild.textContent, "Equity values");
  details.firstElementChild.click(); assert.equal(details.open, true);
  assert.equal(table.tagName, "TABLE"); assert.equal(table.caption.textContent, "Recorded equity values");
  assert.deepEqual([...table.tHead.querySelectorAll("th")].map(th => [th.scope, th.textContent]),
    [["col", "Row"], ["col", "Time (UTC)"], ["col", "Equity (quote units)"]]);
  assert.ok([...ui.$("run-equity-rows").querySelectorAll("th")].every(th => th.scope === "row"));
  assert.match(table.getAttribute("aria-describedby"), /run-equity-description.*run-equity-page-status/);
  assert.equal(ui.$("run-equity-page-status").getAttribute("role"), "status");
  assert.equal(ui.$("run-equity-page-status").getAttribute("aria-live"), "polite");
  assert.deepEqual(equityCells(ui).map(row => row[1]), ["2024-01-01 (date only)", "2024-01-01 01:03:04 UTC",
    "2024-01-01 01:03:05.1 UTC", "2024-01-01 01:03:06.10 UTC", "2024-01-01 01:03:07.100 UTC",
    "2024-01-01 01:03:08.000 UTC", "2024-01-01 03:03:09 UTC", "2024-01-03 00:00:00 UTC", "2024-01-04 (date only)"]);
  assert.deepEqual(equityCells(ui).map(row => row[2]), equity_curve.map(row => String(row[1])));
  assert.doesNotMatch(details.textContent, /\$|USD/);
  assert.deepEqual(ui.equityUpdates.at(-1), equity_curve.map(([ts, value]) => ({ time: Math.floor(Date.parse(ts) / 1000), value: Number(value) === 0 ? 0 : Number(value) })));
  assert.equal(ui.$("run-equity-page-status").textContent, "Rows 1–9 of 9 · Page 1 of 1");
  assert.equal(ui.$("run-equity-previous").disabled, true); assert.equal(ui.$("run-equity-next").disabled, true);
});

test("native equity page buttons reach every recorded row forward and backward with bounded DOM and no extra reads", async (t) => {
  const rep = pagedReport(), ui = await boot(t, { hash: "#run/a", handle: reportRoute(rep) });
  await until(() => !ui.$("run-evidence").hidden, "paged equity");
  const details = ui.$("run-equity-values"), previous = ui.$("run-equity-previous"), next = ui.$("run-equity-next");
  details.firstElementChild.click();
  for (const button of [previous, next]) {
    assert.equal(button.tagName, "BUTTON"); assert.equal(button.type, "button"); assert.equal(button.tabIndex, 0);
    assert.equal(button.getAttribute("aria-controls"), "run-equity-table");
  }
  next.focus(); assert.equal(ui.doc.activeElement, next);
  const before = ui.calls.length, chartUpdates = ui.equityUpdates.length, seen = [];
  for (let page = 0; page < 3; page++) {
    const cells = equityCells(ui), start = page * 50;
    assert.ok(cells.length <= 50);
    assert.deepEqual(cells.map(row => row[0]), rep.equity_curve.slice(start, start + 50).map((_, i) => String(start + i + 1)));
    assert.equal(ui.$("run-equity-page-status").textContent, `Rows ${start + 1}–${Math.min(start + 50, 101)} of 101 · Page ${page + 1} of 3`);
    assert.equal(previous.disabled, page === 0); assert.equal(next.disabled, page === 2);
    seen.push(...cells.map(row => row[2])); next.click();
  }
  assert.deepEqual(seen, rep.equity_curve.map(row => row[1]));
  const lastPage = equityCells(ui); next.dispatchEvent(new ui.w.Event("click")); assert.deepEqual(equityCells(ui), lastPage);
  details.firstElementChild.click(); assert.equal(details.open, false);
  details.firstElementChild.click(); assert.equal(details.open, true); assert.deepEqual(equityCells(ui), lastPage);
  previous.focus(); assert.equal(ui.doc.activeElement, previous);
  previous.click(); assert.equal(equityCells(ui)[0][0], "51");
  previous.click(); assert.equal(equityCells(ui)[0][0], "1");
  previous.dispatchEvent(new ui.w.Event("click")); assert.equal(equityCells(ui)[0][0], "1");
  assert.equal(ui.calls.length, before); assert.equal(ui.equityUpdates.length, chartUpdates);
  assert.ok(ui.calls.every(call => call.method === "GET"));
});

test("equity paging handles exact page boundaries, legacy empty data and incomplete report caveats", async (t) => {
  for (const count of [0, 1, 50, 100]) {
    const rep = count ? pagedReport("a", count) : { run_id: "a", metrics: {}, equity_curve: [] };
    const ui = await boot(t, { hash: "#run/a", handle: reportRoute(rep) });
    await until(() => !ui.$("run-evidence").hidden, "boundary report");
    assert.equal(equityCells(ui).length, Math.min(count, 50));
    if (!count) {
      assert.equal(ui.$("run-equity-page-status").textContent, "No equity values were recorded in this report (0 rows).");
      assert.equal(ui.$("run-equity-table").hidden, true); assert.equal(ui.$("run-equity-pages").hidden, true);
      assert.match(ui.$("run-note").textContent, /Completion status was not recorded/);
    } else {
      if (count > 50) ui.$("run-equity-next").click();
      assert.equal(ui.$("run-equity-next").disabled, true);
      assert.equal(equityCells(ui).at(-1)[0], String(count));
      assert.match(ui.$("run-equity-page-status").textContent, new RegExp(`Page ${Math.ceil(count / 50)} of ${Math.ceil(count / 50)}$`));
    }
  }
  const rep = { ...pagedReport("a", 2), complete: false, bars: { processed: 2, total: 10 } };
  const ui = await boot(t, { hash: "#run/a", handle: reportRoute(rep) });
  await until(() => !ui.$("run-evidence").hidden, "incomplete table");
  assert.equal(equityCells(ui).length, 2); assert.match(ui.$("run-note").textContent, /Incomplete run: 2 of 10 bars.*Not a finished/);
});

test("route exits and repeated same-run navigation clear equity rows, paging and expansion before reload", async (t) => {
  const rep = pagedReport(), ui = await boot(t, { hash: "#run/a", handle: reportRoute(rep) });
  for (let visit = 0; visit < 3; visit++) {
    await until(() => !ui.$("run-evidence").hidden, "reloaded equity");
    assert.equal(ui.$("run-equity-values").open, false); assert.equal(equityCells(ui)[0][0], "1");
    ui.$("run-equity-values").firstElementChild.click(); ui.$("run-equity-next").click();
    assert.equal(equityCells(ui)[0][0], "51");
    await ui.navigate("#code"); assertEquityCleared(ui);
    ui.$("run-equity-next").dispatchEvent(new ui.w.Event("click")); assertEquityCleared(ui);
    await ui.navigate("#run/a");
  }
  await until(() => !ui.$("run-evidence").hidden, "final revisit");
  assert.equal(equityCells(ui).length, 50); assert.equal(equityCells(ui)[0][0], "1");
  assert.equal(ui.calls.filter(call => call.path === "/v1/reports/fixture-report/artifacts/report.json").length, 4);
});

test("old run reports cannot replace a newer run's exact equity page", async (t) => {
  const old = deferred(), rep = pagedReport("b");
  const ui = await boot(t, { hash: "#run/a", handle: routes(call => {
    if (call.path === "/v1/jobs/a") return response(settled("a", { report_id: "old-report" }));
    if (call.path === "/v1/reports/old-report/artifacts/report.json") return old.promise;
    return reportRoute(rep)(call);
  }) });
  await until(() => ui.calls.some(call => call.path.includes("old-report")), "old report read");
  await ui.navigate("#run/b"); await until(() => !ui.$("run-evidence").hidden, "B equity");
  ui.$("run-equity-values").firstElementChild.click(); ui.$("run-equity-next").click();
  const cells = equityCells(ui), status = ui.$("run-equity-page-status").textContent;
  old.resolve(response({ ...report(), equity_curve: [["2024-01-01", "987654321.0000"]] })); await delay(20);
  assert.deepEqual(equityCells(ui), cells); assert.equal(ui.$("run-equity-page-status").textContent, status);
  assert.equal(ui.$("run-equity-values").open, true);
});

test("loaded equity is cleared if page actions find a changed account or organization", async (t) => {
  for (const field of ["user", "org"]) {
    const ui = await boot(t, { hash: "#run/a", handle: reportRoute(pagedReport()) });
    await until(() => !ui.$("run-evidence").hidden, "owned equity");
    ui.$("run-equity-values").firstElementChild.click(); ui.$("run-equity-next").click();
    const calls = ui.calls.length; ui.w.runFixtureState[field] = "another-account";
    ui.$("run-equity-next").click(); assertEquityCleared(ui);
    ui.$("run-equity-previous").dispatchEvent(new ui.w.Event("click")); assertEquityCleared(ui);
    assert.equal(ui.calls.length, calls); assert.equal(ui.w.runFixtureState.report, null);
  }
});

test("signout clears loaded equity synchronously even before the page reload", async (t) => {
  const ui = await boot(t, { hash: "#run/a", handle: reportRoute(pagedReport()) });
  await until(() => !ui.$("run-evidence").hidden, "account equity");
  ui.$("run-equity-values").firstElementChild.click(); ui.$("run-equity-next").click();
  const location = ui.w.location[Object.getOwnPropertySymbols(ui.w.location).find(key => String(key) === "Symbol(impl)")];
  let reloads = 0; location.reload = () => { reloads++; };
  ui.$("signout").click(); assertEquityCleared(ui);
  assert.equal(reloads, 1); assert.equal(ui.w.runFixtureState.user, null); assert.equal(ui.w.runFixtureState.report, null);
});
