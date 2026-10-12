// DOM integration checks without Chromium, HTTP servers, accounts, billing, or code execution.
// npm install --no-save --package-lock=false --ignore-scripts jsdom@26.1.0
// node --test tests/e2e/studio.mjs
// An external installation also works: NODE_PATH=/path/to/node_modules node --test tests/e2e/studio.mjs
// shortcut: chart rendering and native dialog focus are stubbed, verify layout/focus in browser QA.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "chart-tools.js", "workspace-store.js", "studio-assistant.js", "report-evidence.js", "proposal-diff.js", "strategy-backup.js", "saved-links.js", "backtest-params.js", "app.js"].map((name) =>
  readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
const plain = (value) => JSON.parse(JSON.stringify(value));
const dataset = { dataset_id: "synthetic-test", instrument_id: "TEST/USD", provider: "synthetic",
  coverage_start: "2021-01-01T00:00:00Z", coverage_end: "2025-01-01T00:00:00Z", bars: 1462,
  quote_currency: "USD", license: "test fixture" };
const response = (value, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => plain(value) });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(condition, label) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function lockManager() {
  const tails = new Map(), calls = [];
  return { calls, request(name, options, operation) {
    calls.push({ name, ...options });
    const result = (tails.get(name) || Promise.resolve()).then(operation);
    tails.set(name, result.catch(() => {}));
    return result;
  } };
}
function sharedStorage() {
  const entries = new Map();
  return { get length() { return entries.size; }, key: (i) => [...entries.keys()][i],
    getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key) };
}
async function blobText(w, blob) {
  return new Promise((resolve, reject) => {
    const reader = new w.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function boot(t, { hash = "#code", user = false, storage = {}, shared, locks = lockManager(), randomUUID = true, seed, handle } = {}) {
  const errors = [], calls = [], downloads = [], blobs = new Map();
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: `https://veyra.test/${hash}`, runScripts: "outside-only", virtualConsole });
  const w = dom.window, doc = w.document;
  t.after(() => { dom.window.close(); assert.deepEqual(errors, [], "No uncaught DOM errors"); });
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  if (!randomUUID) Object.defineProperty(w.crypto, "randomUUID", { value: undefined });
  if (shared) Object.defineProperty(w, "localStorage", { value: shared });
  if (locks) Object.defineProperty(w.navigator, "locks", { value: locks });
  w.URL.createObjectURL = (blob) => { const url = `blob:https://veyra.test/${blobs.size}`; blobs.set(url, blob); return url; };
  w.URL.revokeObjectURL = (url) => blobs.delete(url);
  doc.addEventListener("click", (event) => {
    const link = event.target.closest("a[download]");
    if (!link) return;
    event.preventDefault();
    downloads.push({ name: link.download, blob: blobs.get(link.href) });
  });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  const series = () => ({ values: [], setData(rows) { this.values = rows; }, data() { return this.values; }, setMarkers() {}, applyOptions() {},
    attachPrimitive() {}, createPriceLine: (line) => line, removePriceLine() {} });
  w.LightweightCharts = { createChart: () => ({ addLineSeries: series, addCandlestickSeries: series, addBarSeries: series, addAreaSeries: series,
    addHistogramSeries: series, priceScale: () => ({ applyOptions() {} }), timeScale: () => ({ fitContent() {}, applyOptions() {} }),
    subscribeCrosshairMove() {}, subscribeClick() {}, applyOptions() {} }) };
  for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
  if (user) w.localStorage.setItem("veyra.user", "fixture-user");
  w.fetch = async (path, options = {}) => {
    const call = { path: String(path), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    if (call.path === "/v1/catalog/datasets") return response({ datasets: [dataset] });
    if (call.path === "/v1/me" && user) return response({ organizations: [{ id: "fixture-org" }] });
    if (call.path === "/v1/orgs/fixture-org/billing/balance" && user) {
      return response({ available_nano: 0, reserved_nano: 0, settled_usage_nano: 0 });
    }
    const result = await handle?.(call);
    if (result !== undefined) return result;
    errors.push(`Unexpected API request: ${call.method} ${call.path}`);
    return response({ detail: "Unexpected fixture request" }, 500);
  };
  scripts.slice(0, -1).forEach((script) => w.eval(script));
  const store = w.VeyraWorkspaceStore.create(w.localStorage);
  const seeded = seed?.(store, w);
  w.eval(scripts.at(-1));
  const $ = (id) => { const element = doc.getElementById(id); assert.ok(element, `Missing #${id}`); return element; };
  const input = (id, value, type = "input") => {
    $(id).value = value;
    $(id).dispatchEvent(new w.Event(type, { bubbles: true }));
  };
  const submit = (id) => $(id).querySelector('button[type="submit"]').click();
  async function navigate(next) {
    w.location.hash = next;
    await until(() => !$(`view-${next.slice(1).split("/")[0]}`).hidden, `route ${next}`);
    await delay(5);
  }
  await until(() => $("bt-dataset").options.length === 1, "public catalog boot");
  await delay(5);
  const ids = [...doc.querySelectorAll("[id]")].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, "HTML IDs must be unique");
  return { w, doc, $, store, seeded, calls, input, submit, navigate, downloads, locks,
    storage: () => Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => {
      const key = w.localStorage.key(i); return [key, w.localStorage.getItem(key)];
    })) };
}

async function createLocal(ui, name = "Private experiment") {
  ui.input("new-project-name", name);
  ui.submit("new-project-form");
  await until(() => ui.w.location.hash.startsWith("#project/local-") && ui.$("project-title").textContent === name, "local strategy editor");
  return ui.w.location.hash.slice("#project/".length);
}

function ask(ui, prompt) { ui.input("assistant-prompt", prompt); ui.submit("assistant-form"); }
function project(id, files = { "strategy.py": `# ${id}\n` }) {
  const version = { id: `${id}-version-1`, project_id: id, version_no: 1, files, entrypoint: "strategy.py", created_at: "2026-01-01T00:00:00Z" };
  return { id, name: id, description: "", folder: "", visibility: "private", latest_version_no: 1,
    created_at: version.created_at, updated_at: version.created_at, versions: [version] };
}
function projectRoutes(projects, fallback) {
  return (call) => {
    if (call.path === "/v1/orgs/fixture-org/projects") return response({ projects: Object.values(projects), has_more: false, next_cursor: null });
    for (const p of Object.values(projects)) {
      if (call.path === `/v1/projects/${p.id}` && call.method === "GET") return response(p);
      if (call.path === `/v1/projects/${p.id}/versions/1`) return response(p.versions[0]);
    }
    return fallback?.(call);
  };
}

test("signed-out Studio creates, saves, renames, filters, duplicates and reloads private local strategies", async (t) => {
  const ui = await boot(t);
  assert.match(ui.$("workspace-mode").textContent, /browser|device/);
  const id = await createLocal(ui);
  assert.equal(ui.$("editor").value, ui.w.VeyraStudioAssistant.templates.blank);
  assert.equal(ui.$("draft-state").textContent, "Saved");
  assert.match(ui.$("project-storage").textContent, /Private.*browser only.*no cloud backup/);
  assert.equal(ui.$("strategy-runs-link").hidden, true);
  for (const control of ui.$("quote-form").querySelectorAll("input, select, button")) assert.equal(control.disabled, true);
  ui.input("editor", "# private source\n");
  assert.match(ui.$("draft-state").textContent, /Unsaved/);
  ui.$("save-version").click();
  await until(() => ui.$("project-version").textContent === "saved v2", "saved local revision");
  assert.equal(ui.$("draft-state").textContent, "Saved");
  assert.equal(ui.store.getVersion(id, 1).files["strategy.py"], ui.w.VeyraStudioAssistant.templates.blank);
  assert.equal(ui.store.getVersion(id, 2).files["strategy.py"], "# private source\n");
  assert.equal(Object.keys(ui.storage()).some((key) => key.startsWith(`veyra.draft.${id}`)), false);
  ui.$("project-settings").click();
  assert.equal(ui.$("strategy-settings-dialog").open, true);
  ui.input("settings-name", "Renamed experiment");
  ui.input("settings-description", "Momentum research");
  ui.input("settings-folder", "Signals");
  ui.submit("strategy-settings-form");
  await until(() => ui.$("project-title").textContent === "Renamed experiment", "settings saved");
  assert.equal(ui.$("strategy-settings-dialog").open, false);
  ui.$("duplicate-project").click();
  await until(() => ui.$("project-title").textContent === "Renamed experiment copy", "duplicate editor");
  const copyId = ui.w.location.hash.slice(9);
  assert.notEqual(copyId, id);
  assert.equal(ui.store.getProject(copyId).latest_version_no, 1);
  assert.equal(ui.store.getVersion(copyId, 1).files["strategy.py"], "# private source\n");
  await ui.navigate("#code");
  ui.input("project-folder", "Signals");
  assert.equal(ui.$("project-list").querySelectorAll("a").length, 2);
  ui.input("project-search", "Momentum");
  assert.equal(ui.$("project-list").querySelectorAll("a").length, 2);
  ui.input("project-search", "missing");
  assert.match(ui.$("project-list").textContent, /No matching/);
  const reload = await boot(t, { hash: `#project/${id}`, storage: ui.storage() });
  await until(() => reload.$("project-title").textContent === "Renamed experiment", "reloaded strategy");
  assert.equal(reload.$("editor").value, "# private source\n");
  assert.equal(reload.store.getProject(id).folder, "Signals");
  for (const p of reload.store.listProjects().projects) assert.equal(p.visibility, "private");
  assert.deepEqual(ui.calls.map(({ path }) => path), ["/v1/catalog/datasets"], "Private source never leaves this device");
  assert.deepEqual(reload.calls.map(({ path }) => path), ["/v1/catalog/datasets"]);
});

test("assistant previews, applies original proposals, rejects stale edits and preserves user changes on undo", async (t) => {
  const ui = await boot(t);
  const id = await createLocal(ui);
  const before = ui.$("editor").value;
  ask(ui, "Create SMA crossover");
  const proposed = ui.$("assistant-after").textContent;
  assert.equal(ui.$("assistant-proposal").hidden, false);
  assert.equal(ui.$("assistant-before").textContent, before);
  assert.equal(ui.$("editor").value, before, "Preview does not modify the editor");
  assert.match(proposed, /class SmaCross/);
  ui.$("assistant-apply").click();
  assert.equal(ui.$("editor").value, proposed, "Apply must pass the original proposal object to the helper");
  assert.equal(ui.$("assistant-undo").hidden, false);
  assert.equal(ui.store.getProject(id).latest_version_no, 1, "Applying is only a draft");
  ui.$("assistant-undo").click();
  assert.equal(ui.$("editor").value, before);
  ask(ui, "Create SMA crossover");
  ui.input("editor", `${before}# newer edit\n`);
  ui.$("assistant-apply").click();
  assert.equal(ui.$("editor").value, `${before}# newer edit\n`);
  assert.match(ui.$("assistant-messages").textContent, /changed|stale/i);
  ask(ui, "Create SMA crossover");
  ui.$("assistant-apply").click();
  ui.input("editor", `${proposed}# keep this\n`);
  ui.$("assistant-undo").click();
  assert.equal(ui.$("editor").value, `${proposed}# keep this\n`);
  assert.match(ui.$("assistant-messages").textContent, /overwrite your work/);
  ask(ui, "Create buy and hold");
  ui.$("assistant-dismiss").click();
  assert.equal(ui.$("assistant-proposal").hidden, true);
  assert.deepEqual(ui.calls.map(({ path }) => path), ["/v1/catalog/datasets"], "The helper never sends source to an API");
});

test("file switching, draft reloads, saves and duplication preserve complete multi-file snapshots", async (t) => {
  const files = { "strategy.py": "from helpers.signals import signal\n", "helpers/signals.py": "signal = '☀'\n" };
  const ui = await boot(t, { seed: (store) => store.createProject({ name: "Multiple files", files }) });
  const id = ui.seeded.id;
  await ui.navigate(`#project/${id}`);
  await until(() => !ui.$("editor").disabled, "multi-file editor");
  assert.equal(ui.$("editor-file").options.length, 2);
  ui.input("editor", "# edited entrypoint\n");
  ask(ui, "Create SMA crossover");
  ui.input("editor-file", "helpers/signals.py", "change");
  assert.equal(ui.$("assistant-proposal").hidden, true, "Changing files invalidates pending edits");
  assert.equal(ui.$("editor").value, files["helpers/signals.py"]);
  ui.input("editor", "signal = 'private helper'\n");
  const reload = await boot(t, { hash: `#project/${id}`, storage: ui.storage() });
  await until(() => !reload.$("editor").disabled, "draft reload");
  assert.equal(reload.$("editor").value, "# edited entrypoint\n");
  reload.input("editor-file", "helpers/signals.py", "change");
  assert.equal(reload.$("editor").value, "signal = 'private helper'\n");
  reload.$("save-version").click();
  await until(() => reload.$("project-version").textContent === "saved v2", "multi-file save");
  const expected = { "strategy.py": "# edited entrypoint\n", "helpers/signals.py": "signal = 'private helper'\n" };
  assert.deepEqual(plain(reload.store.getVersion(id, 2).files), expected);
  assert.deepEqual(plain(reload.store.getVersion(id, 1).files), files);
  reload.$("duplicate-project").click();
  await until(() => reload.$("project-title").textContent === "Multiple files copy", "multi-file duplicate");
  assert.deepEqual(plain(reload.store.getProject(reload.w.location.hash.slice(9)).versions[0].files), expected);
});

test("a late project load cannot replace the strategy selected more recently", async (t) => {
  const slow = deferred(), a = project("strategy-a"), b = project("strategy-b");
  const ui = await boot(t, { user: true, handle: (call) => {
    if (call.path === "/v1/projects/strategy-a" && call.method === "GET") return slow.promise;
    return projectRoutes({ a, b })(call);
  } });
  await ui.navigate("#project/strategy-a");
  await until(() => ui.calls.some((call) => call.path === "/v1/projects/strategy-a"), "slow project request");
  await ui.navigate("#project/strategy-b");
  await until(() => ui.$("project-title").textContent === b.name, "newer project");
  slow.resolve(response(a));
  await delay(20);
  assert.equal(ui.w.location.hash, "#project/strategy-b");
  assert.equal(ui.$("project-title").textContent, b.name);
  assert.equal(ui.$("editor").value, b.versions[0].files["strategy.py"]);
});

test("a delayed duplicate response does not pull the user away from a new route", async (t) => {
  const slow = deferred(), a = project("strategy-a"), copy = project("strategy-copy");
  const ui = await boot(t, { user: true, handle: projectRoutes({ a, copy }, (call) => {
    if (call.path === "/v1/projects/strategy-a/duplicate") return slow.promise;
  }) });
  await ui.navigate("#project/strategy-a");
  await until(() => ui.$("project-title").textContent === a.name, "source project");
  ui.$("duplicate-project").click();
  await until(() => ui.calls.some((call) => call.path.endsWith("/duplicate")), "duplicate request");
  await ui.navigate("#code");
  slow.resolve(response(copy));
  await delay(20);
  assert.equal(ui.w.location.hash, "#code", "Completing an old action must not navigate the user backwards");
  assert.equal(ui.$("view-code").hidden, false);
});

const receipt = { supplier_cost_nano: 1, platform_fee_bps: 500, platform_fee_nano: 0,
  customer_charge_nano: 1, authorized_max_nano: 2, released_nano: 1, tax_nano: null };
function job(id, projectId, metrics = { percent_profitable: 50 }) {
  return { id, project_id: projectId, project_name: projectId, project_run_count: 3,
    version_no: 2, dataset_id: "synthetic-test", start: "2024-01-01", end: "2025-01-01",
    state: "settled", outcome: "completed", created_at: "2026-01-01T00:00:00Z",
    settled_at: "2026-01-01T00:01:00Z", charge_nano: 1, metrics, report_id: `${id}-report`, receipt };
}

test("run history groups by strategy, paginates without repeats and labels profitability honestly", async (t) => {
  const first = [job("a-new", "Strategy A"), job("b-new", "Strategy B", { percent_profitable: 0 }), job("a-old", "Strategy A", {})];
  const older = job("a-older", "Strategy A", { percent_profitable: null });
  const ui = await boot(t, { hash: "#runs", user: true, handle: (call) => {
    if (call.path.startsWith("/v1/orgs/fixture-org/jobs?")) {
      const params = new URL(`https://veyra.test${call.path}`).searchParams;
      if (params.get("project_id")) return response({ jobs: [first[0], first[2], older], next_cursor: null });
      return response(params.has("cursor") ? { jobs: [first[2], older], next_cursor: null } : { jobs: first, next_cursor: "next-page" });
    }
  } });
  await until(() => ui.$("run-list").querySelectorAll("details").length === 2, "grouped history");
  const groups = ui.$("run-list").querySelectorAll("details");
  assert.match(groups[0].querySelector("summary").textContent, /Strategy A.*2 of 3 runs/);
  assert.equal(groups[0].querySelectorAll(".strategy-history li").length, 2);
  assert.deepEqual([...ui.$("run-list").querySelectorAll(".run-profit")].map((el) => el.textContent), ["50.00%", "Unavailable", "0.00%"]);
  assert.match(ui.$("run-list").textContent, /Profitable closed trades · after fees/);
  ui.$("load-more-runs").click();
  await until(() => ui.$("run-list").querySelectorAll(".strategy-history li").length === 4, "older page");
  assert.equal(ui.$("load-more-runs").hidden, true);
  assert.equal(ui.$("run-list").querySelectorAll('a[href="#run/a-old"]').length, 1);
  await ui.navigate("#runs/Strategy%20A");
  await until(() => ui.$("run-list").querySelectorAll("details").length === 1, "strategy-filtered history");
  assert.equal(ui.$("run-list").querySelector("details").open, true);
});

test("reports distinguish zero wins, no closed trades and missing older metrics", async (t) => {
  let metrics = { percent_profitable: 0, closed_trade_count: 2, winning_trade_count: 0, fill_count: 4, total_fees: "1" };
  const current = job("run-current", "Strategy A"), old = job("run-old", "Strategy A"), empty = job("run-empty", "Strategy A");
  const ui = await boot(t, { hash: "#run/run-current", user: true, handle: (call) => {
    for (const row of [current, old, empty]) {
      if (call.path === `/v1/jobs/${row.id}`) return response(row);
      if (call.path === `/v1/reports/${row.report_id}/artifacts/report.json`) return response({
        run_id: row.id, complete: true, metrics, equity_curve: [["2024-01-01", "10000"]], bars: { processed: 1, total: 1 },
      });
    }
  } });
  await until(() => !ui.$("run-report").hidden, "completed report");
  assert.equal(ui.$("run-profitability-value").textContent, "0.00%");
  assert.match(ui.$("run-profitability-definition").textContent, /0 profitable \/ 2 closed trades/);
  assert.match(ui.$("run-profitability-definition").textContent, /Open positions are excluded; breakeven trades are not wins/);
  metrics = { fill_count: 1, total_fees: "1" };
  await ui.navigate("#run/run-old");
  await until(() => ui.$("run-profitability-definition").textContent.includes("older report"), "legacy report");
  assert.equal(ui.$("run-profitability-value").textContent, "Unavailable");
  metrics = { percent_profitable: null, closed_trade_count: 0, winning_trade_count: 0, fill_count: 1, total_fees: "1" };
  await ui.navigate("#run/run-empty");
  await until(() => ui.$("run-profitability-definition").textContent.includes("until a trade closes"), "zero closed trades");
  assert.equal(ui.$("run-profitability-value").textContent, "Unavailable");
});

test("older drafts can be downloaded after new edits and a reload without overwriting current saved code", async (t) => {
  const stale = JSON.stringify({ base_version: 1, files: { "strategy.py": "# recovered private source\n" } });
  const ui = await boot(t, { seed: (store, w) => {
    const p = store.createProject({ name: "Recovery", files: { "strategy.py": "# original\n" } });
    store.saveVersion(p.id, { files: { "strategy.py": "# latest saved\n" }, expected_version_no: 1 });
    w.localStorage.setItem(`veyra.draft.${p.id}`, stale);
    return p;
  } });
  const id = ui.seeded.id;
  await ui.navigate(`#project/${id}`);
  await until(() => ui.$("project-title").textContent === "Recovery", "recovery strategy");
  assert.equal(ui.$("editor").value, "# latest saved\n");
  assert.equal(ui.$("recover-draft").hidden, false);
  assert.equal(ui.w.localStorage.getItem(`veyra.draft.${id}`), stale);
  ui.$("recover-draft").click();
  assert.equal(ui.downloads.length, 1);
  assert.equal(ui.downloads[0].name, "veyra-recovered-draft.json");
  assert.deepEqual(JSON.parse(await blobText(ui.w, ui.downloads[0].blob)), { project_id: id, drafts: [stale] });
  ui.input("editor", "# a new draft\n");
  const reload = await boot(t, { hash: `#project/${id}`, storage: ui.storage() });
  await until(() => reload.$("project-title").textContent === "Recovery", "reloaded recovery");
  assert.equal(reload.$("editor").value, "# a new draft\n");
  assert.equal(reload.$("recover-draft").hidden, false);
  reload.$("recover-draft").click();
  assert.ok(JSON.parse(await blobText(reload.w, reload.downloads[0].blob)).drafts.includes(stale));
  assert.equal(reload.store.getVersion(id, 2).files["strategy.py"], "# latest saved\n");
});

test("switching strategies closes the settings dialog and a late settings response cannot rename the new project", async (t) => {
  const slow = deferred(), a = project("strategy-a"), b = project("strategy-b");
  const ui = await boot(t, { user: true, handle: projectRoutes({ a, b }, (call) => {
    if (call.path === "/v1/projects/strategy-a" && call.method === "PATCH") return slow.promise;
  }) });
  await ui.navigate("#project/strategy-a");
  await until(() => ui.$("project-title").textContent === a.name, "settings source");
  ui.$("project-settings").click();
  ui.input("settings-name", "Edited A");
  ui.submit("strategy-settings-form");
  await until(() => ui.calls.some((call) => call.method === "PATCH"), "settings request");
  await ui.navigate("#project/strategy-b");
  await until(() => ui.$("project-title").textContent === b.name, "settings destination");
  assert.equal(ui.$("strategy-settings-dialog").open, false);
  slow.resolve(response({ ...a, name: "Edited A" }));
  await delay(20);
  assert.equal(ui.$("project-title").textContent, b.name);
});

test("device mutations use an exclusive workspace lock and fail closed without Web Locks", async (t) => {
  const ui = await boot(t), id = await createLocal(ui);
  ui.input("editor", "# locked save\n");
  ui.$("save-version").click();
  await until(() => ui.$("project-version").textContent === "saved v2", "locked save");
  ui.$("project-settings").click();
  ui.input("settings-name", "Locked settings");
  ui.submit("strategy-settings-form");
  await until(() => ui.$("project-title").textContent === "Locked settings", "locked settings");
  ui.$("duplicate-project").click();
  await until(() => ui.$("project-title").textContent === "Locked settings copy", "locked duplicate");
  assert.deepEqual(ui.locks.calls, Array.from({ length: 4 }, () => ({ name: "veyra.workspace.v1", mode: "exclusive" })));
  const blocked = await boot(t, { locks: null });
  blocked.input("new-project-name", "Must not persist");
  blocked.submit("new-project-form");
  await until(() => blocked.$("status").textContent.includes("Web Locks"), "unsupported browser warning");
  assert.equal(blocked.store.listProjects().projects.length, 0);
  assert.equal(blocked.w.location.hash, "#code");
  const blockedSave = await boot(t, { hash: `#project/${id}`, storage: ui.storage(), locks: null });
  await until(() => !blockedSave.$("editor").disabled, "read-only saved strategy");
  blockedSave.input("editor", "# unsaved without locks\n");
  blockedSave.$("save-version").click();
  await until(() => blockedSave.$("status").textContent.includes("Web Locks"), "save lock warning");
  assert.equal(blockedSave.store.getProject(id).latest_version_no, 2);
  assert.match(blockedSave.$("draft-state").textContent, /Unsaved/);
});

test("two tabs serialize creates and reject stale saves without replacing saved versions", async (t) => {
  const shared = sharedStorage(), locks = lockManager();
  const one = await boot(t, { shared, locks }), two = await boot(t, { shared, locks });
  const [firstId, secondId] = await Promise.all([createLocal(one, "Tab one"), createLocal(two, "Tab two")]);
  assert.notEqual(firstId, secondId);
  assert.equal(one.store.listProjects().projects.length, 2);
  await two.navigate(`#project/${firstId}`);
  await until(() => two.$("project-title").textContent === "Tab one", "shared strategy");
  one.input("editor", "# first tab save\n");
  two.input("editor", "# second tab unsaved work\n");
  one.$("save-version").click();
  two.$("save-version").click();
  await until(() => one.$("project-version").textContent === "saved v2", "first tab saved");
  await until(() => two.$("status").classList.contains("error"), "stale version rejected");
  assert.equal(two.store.getProject(firstId).latest_version_no, 2);
  assert.equal(two.store.getVersion(firstId, 2).files["strategy.py"], "# first tab save\n");
  assert.equal(two.$("editor").value, "# second tab unsaved work\n");
  assert.equal(locks.calls.length, 4);
  const reload = await boot(t, { hash: `#project/${firstId}`, shared, locks });
  await until(() => reload.$("project-title").textContent === "Tab one", "cross-tab recovery");
  assert.equal(reload.$("editor").value, "# first tab save\n");
  assert.equal(reload.$("recover-draft").hidden, false, "Stale tab edits remain available after reload");
  reload.$("recover-draft").click();
  const recovery = JSON.parse(await blobText(reload.w, reload.downloads[0].blob));
  assert.ok(recovery.drafts.some((raw) => JSON.parse(raw).files["strategy.py"] === "# second tab unsaved work\n"));
});

test("late price responses cannot reveal a quote for changed code or another strategy", async (t) => {
  const pending = [], a = project("strategy-a"), b = project("strategy-b");
  const ui = await boot(t, { user: true, handle: projectRoutes({ a, b }, (call) => {
    if (call.path === "/v1/quotes") { const next = deferred(); pending.push(next); return next.promise; }
  }) });
  await ui.navigate("#project/strategy-a");
  await until(() => ui.$("project-title").textContent === a.name, "quote source");
  ui.submit("quote-form");
  await until(() => pending.length === 1, "first quote request");
  ui.input("bt-cash", "20000");
  pending[0].resolve(response({ id: "quote-a", estimate: { customer_expected_nano: 1 }, customer_max_nano: 2 }));
  await delay(20);
  assert.equal(ui.$("quote-box").hidden, true, "A changed amount invalidates the pending price");
  ui.submit("quote-form");
  await until(() => pending.length === 2, "second quote request");
  await ui.navigate("#project/strategy-b");
  await until(() => ui.$("project-title").textContent === b.name, "new quote destination");
  pending[1].resolve(response({ id: "quote-old", estimate: { customer_expected_nano: 1 }, customer_max_nano: 2 }));
  await delay(20);
  assert.equal(ui.$("quote-box").hidden, true);
  assert.equal(ui.$("project-title").textContent, b.name);
  assert.equal(ui.calls.some((call) => /authorize|\/jobs$/.test(call.path)), false, "Prices alone never authorize billing or runs");
});

test("reload restores the newest compatible draft and retains all conflicting drafts for recovery", async (t) => {
  const originals = {};
  const ui = await boot(t, { seed: (store, w) => {
    const p = store.createProject({ name: "Draft selection", files: { "strategy.py": "# saved v1\n" } });
    store.saveVersion(p.id, { files: { "strategy.py": "# saved v2\n" }, expected_version_no: 1 });
    for (const [suffix, base_version, saved_at, code] of [
      ["old", 2, 20, "# older matching draft\n"], ["stale", 1, 999, "# newer incompatible draft\n"],
      ["new", 2, 30, "# newest matching draft\n"],
    ]) {
      const key = `veyra.draft.${p.id}.${suffix}`;
      originals[key] = JSON.stringify({ base_version, saved_at, files: { "strategy.py": code } });
      w.localStorage.setItem(key, originals[key]);
    }
    return p;
  } });
  await ui.navigate(`#project/${ui.seeded.id}`);
  await until(() => ui.$("project-title").textContent === "Draft selection", "draft selection");
  assert.equal(ui.$("editor").value, "# newest matching draft\n");
  for (const [key, raw] of Object.entries(originals)) assert.equal(ui.w.localStorage.getItem(key), raw);
  ui.$("recover-draft").click();
  const bundle = JSON.parse(await blobText(ui.w, ui.downloads[0].blob));
  assert.deepEqual(new Set(bundle.drafts), new Set(Object.values(originals)));
  assert.equal(ui.store.getProject(ui.seeded.id).latest_version_no, 2);
});

test("a delayed create response cannot pull the user away from an existing strategy", async (t) => {
  const slow = deferred(), existing = project("existing"), created = project("created");
  const base = projectRoutes({ existing, created });
  const ui = await boot(t, { user: true, handle: (call) => {
    if (call.path === "/v1/orgs/fixture-org/projects" && call.method === "POST") return slow.promise;
    return base(call);
  } });
  ui.input("new-project-name", "created");
  ui.submit("new-project-form");
  await until(() => ui.calls.some((call) => call.method === "POST"), "create request");
  await ui.navigate("#project/existing");
  await until(() => ui.$("project-title").textContent === existing.name, "selected existing strategy");
  slow.resolve(response(created));
  await delay(20);
  assert.equal(ui.w.location.hash, "#project/existing");
  assert.equal(ui.$("project-title").textContent, existing.name);
});

test("edits made during an in-flight save stay unsaved and all files remain in the saved snapshot", async (t) => {
  const slow = deferred(), p = project("server-multifile", { "strategy.py": "# original\n", "helper.py": "# untouched helper\n" });
  const ui = await boot(t, { user: true, handle: projectRoutes({ p }, (call) => {
    if (call.path === "/v1/projects/server-multifile/versions" && call.method === "POST") return slow.promise;
  }) });
  await ui.navigate("#project/server-multifile");
  await until(() => ui.$("project-title").textContent === p.name, "server editor");
  ui.input("editor", "# submitted edit\n");
  ui.$("save-version").click();
  await until(() => ui.calls.some((call) => call.path.endsWith("/versions") && call.method === "POST"), "save request");
  const saved = ui.calls.find((call) => call.path.endsWith("/versions") && call.method === "POST");
  assert.deepEqual(saved.body.files, { "strategy.py": "# submitted edit\n", "helper.py": "# untouched helper\n" });
  assert.equal(saved.body.expected_version_no, 1);
  ui.input("editor", "# newer unsaved edit\n");
  slow.resolve(response({ ...p.versions[0], id: "server-version-2", version_no: 2, files: saved.body.files }));
  await until(() => ui.$("project-version").textContent === "saved v2", "save completion");
  assert.equal(ui.$("editor").value, "# newer unsaved edit\n");
  assert.match(ui.$("draft-state").textContent, /Unsaved/);
  const drafts = Object.entries(ui.storage()).filter(([key]) => key.startsWith("veyra.draft.server-multifile."));
  assert.equal(drafts.length, 1);
  assert.equal(JSON.parse(drafts[0][1]).base_version, 2);
  assert.equal(JSON.parse(drafts[0][1]).files["strategy.py"], "# newer unsaved edit\n");
});

test("unversioned legacy Python drafts remain recovery-only after saving and reopening", async (t) => {
  const legacy = "# legacy source with no saved-version identity\nprint('recover me')\n";
  const ui = await boot(t, { seed: (store, w) => {
    const p = store.createProject({ name: "Legacy recovery", files: { "strategy.py": "# current saved source\n" } });
    w.localStorage.setItem(`veyra.draft.${p.id}`, legacy);
    return p;
  } });
  const id = ui.seeded.id;
  await ui.navigate(`#project/${id}`);
  await until(() => ui.$("project-title").textContent === "Legacy recovery", "legacy recovery editor");
  assert.equal(ui.$("editor").value, "# current saved source\n", "An unversioned draft cannot replace current saved source");
  assert.equal(ui.$("draft-state").textContent, "Saved");
  assert.equal(ui.$("recover-draft").hidden, false);
  ui.$("recover-draft").click();
  assert.deepEqual(JSON.parse(await blobText(ui.w, ui.downloads[0].blob)), { project_id: id, drafts: [legacy] });
  ui.input("editor", "# deliberately saved newer source\n");
  ui.$("save-version").click();
  await until(() => ui.$("project-version").textContent === "saved v2", "newer saved version");
  await ui.navigate("#code");
  await ui.navigate(`#project/${id}`);
  await until(() => ui.$("project-title").textContent === "Legacy recovery", "reopened saved strategy");
  assert.equal(ui.$("editor").value, "# deliberately saved newer source\n");
  assert.equal(ui.$("draft-state").textContent, "Saved");
  const reload = await boot(t, { hash: `#project/${id}`, storage: ui.storage() });
  await until(() => reload.$("project-title").textContent === "Legacy recovery", "fresh session with legacy draft");
  assert.equal(reload.$("editor").value, "# deliberately saved newer source\n");
  assert.equal(reload.$("draft-state").textContent, "Saved");
  assert.equal(reload.store.getVersion(id, 2).files["strategy.py"], "# deliberately saved newer source\n");
  assert.equal(reload.w.localStorage.getItem(`veyra.draft.${id}`), legacy, "Legacy source must stay recoverable");
  assert.equal(reload.$("recover-draft").hidden, false);
  reload.$("recover-draft").click();
  assert.deepEqual(JSON.parse(await blobText(reload.w, reload.downloads[0].blob)), { project_id: id, drafts: [legacy] });
});

test("missing randomUUID and Web Locks do not prevent market or Studio reads", async (t) => {
  const ui = await boot(t, { hash: "#markets", randomUUID: false, locks: null,
    seed: (store) => store.createProject({ name: "Readable local strategy", files: { "strategy.py": "# saved safely\n" } }),
    handle: (call) => {
      if (call.path === "/v1/catalog/datasets/synthetic-test/bars") return response({ bars: [
        { ts: "2025-01-01T00:00:00Z", open: "10", high: "12", low: "9", close: "11", volume: "100" },
      ] });
    },
  });
  assert.equal(ui.w.crypto.randomUUID, undefined);
  assert.equal(ui.w.navigator.locks, undefined);
  await until(() => ui.$("market-meta").textContent.startsWith("As of"), "public market chart data");
  assert.equal(ui.$("view-markets").hidden, false);
  assert.equal(ui.$("chart-empty").hidden, true);
  assert.equal(ui.$("market-price").textContent, "11 USD");
  await ui.navigate("#code");
  assert.match(ui.$("project-list").textContent, /Readable local strategy/);
  await ui.navigate(`#project/${ui.seeded.id}`);
  await until(() => ui.$("project-title").textContent === "Readable local strategy", "Studio read without secure-context APIs");
  assert.equal(ui.$("editor").value, "# saved safely\n");
  ui.input("editor", "# unsaved edit\n");
  ui.$("save-version").click();
  await until(() => ui.$("status").textContent.includes("Web Locks"), "explicit unsupported-save warning");
  assert.equal(ui.store.getProject(ui.seeded.id).latest_version_no, 1);
  assert.equal(ui.store.getVersion(ui.seeded.id, 1).files["strategy.py"], "# saved safely\n");
  assert.match(ui.$("draft-state").textContent, /Unsaved/);
});

function fileAction(ui, action, path) {
  ui.$(`${action}-file`).click();
  assert.equal(ui.$("strategy-file-dialog").open, true);
  if (path !== undefined) ui.input("file-path", path);
  ui.$("confirm-strategy-file").click();
}
const latestDraft = (ui, id) => Object.entries(ui.storage()).filter(([key]) => key.startsWith(`veyra.draft.${id}.`))
  .map(([, raw]) => JSON.parse(raw)).sort((a, b) => b.saved_at - a.saved_at)[0];

test("file additions, rename, removal and entrypoint survive complete draft recovery before one explicit save", async (t) => {
  const original = { "strategy.py": "from helpers.entry import value\r\n", "helpers/entry.py": "value = '雪'\r\n", "empty.py": "" };
  const ui = await boot(t, { seed: (store) => store.createProject({ name: "File controls", files: original }) });
  const id = ui.seeded.id;
  await ui.navigate(`#project/${id}`); await until(() => !ui.$("editor").disabled, "file controls");
  const saved = ui.w.localStorage.getItem("veyra.workspace.v1");
  fileAction(ui, "add", "signals/blank.py");
  assert.equal(ui.$("editor-file").value, "signals/blank.py"); assert.equal(ui.$("editor").value, "");
  fileAction(ui, "rename", "signals/entry.py");
  ui.input("editor-entrypoint", "signals/entry.py", "change");
  assert.equal(ui.$("remove-file").disabled, true, "The entrypoint cannot be removed");
  ui.input("editor-file", "empty.py", "change");
  ui.$("remove-file").click();
  assert.match(ui.$("file-dialog-notice").textContent, /Saved versions keep this file/);
  assert.equal(ui.w.document.activeElement, ui.$("cancel-strategy-file"), "Removal defaults to Cancel");
  ui.$("cancel-strategy-file").click();
  assert.ok([...ui.$("editor-file").options].some((item) => item.value === "empty.py"));
  fileAction(ui, "remove");
  assert.equal(ui.$("strategy-file-dialog").open, false);
  const expected = { "strategy.py": original["strategy.py"], "helpers/entry.py": original["helpers/entry.py"], "signals/entry.py": "" };
  assert.equal(ui.w.localStorage.getItem("veyra.workspace.v1"), saved, "Only the device draft changed");
  const draft = latestDraft(ui, id);
  assert.equal(draft.schema_version, 2); assert.equal(draft.base_version_id, ui.seeded.latest_version.id);
  assert.equal(draft.entrypoint, "signals/entry.py"); assert.deepEqual(draft.files, expected);
  ui.$("download-snapshot").click();
  const backup = JSON.parse(await blobText(ui.w, ui.downloads[0].blob));
  assert.deepEqual(backup.files, expected); assert.equal(backup.entrypoint, draft.entrypoint); assert.equal(backup.has_unsaved_changes, true);
  const reload = await boot(t, { hash: `#project/${id}`, storage: ui.storage() });
  await until(() => !reload.$("editor").disabled, "complete draft reload");
  assert.equal(reload.$("editor-entrypoint").value, "signals/entry.py");
  assert.equal(reload.$("editor-file").value, "signals/entry.py");
  assert.deepEqual([...reload.$("editor-file").options].map((item) => item.value), Object.keys(expected));
  reload.$("save-version").click(); await until(() => reload.$("project-version").textContent === "saved v2", "complete snapshot save");
  assert.deepEqual(plain(reload.store.getVersion(id, 2).files), expected);
  assert.deepEqual(plain(reload.store.getVersion(id, 1).files), original);
  assert.equal(reload.store.getVersion(id, 2).entrypoint, "signals/entry.py");
  assert.deepEqual(ui.calls.map((call) => call.path), ["/v1/catalog/datasets"]);
  assert.deepEqual(reload.calls.map((call) => call.path), ["/v1/catalog/datasets"]);
});

test("entrypoint-only edits are dirty, reload, save and duplicate the complete source exactly", async (t) => {
  const files = { "strategy.py": "# original\r\n", "other.py": "# other\r\n" };
  const ui = await boot(t, { seed: (store) => store.createProject({ name: "Entrypoint", files }) });
  const id = ui.seeded.id;
  await ui.navigate(`#project/${id}`); await until(() => !ui.$("editor").disabled, "entrypoint controls");
  ui.input("editor-entrypoint", "other.py", "change");
  assert.match(ui.$("draft-state").textContent, /Unsaved/);
  assert.equal(ui.$("editor-file").value, "strategy.py", "Entrypoint selection does not switch the edited file");
  ui.$("duplicate-project").click(); await delay(10);
  assert.match(ui.$("status").textContent, /Save version before duplicating/);
  assert.equal(ui.store.listProjects().projects.length, 1); assert.equal(ui.store.getProject(id).latest_version_no, 1);
  const reload = await boot(t, { hash: `#project/${id}`, storage: ui.storage() });
  await until(() => !reload.$("editor").disabled, "entrypoint draft reload");
  assert.equal(reload.$("editor-entrypoint").value, "other.py");
  reload.$("save-version").click(); await until(() => reload.$("project-version").textContent === "saved v2", "entrypoint save");
  assert.equal(reload.$("draft-state").textContent, "Saved");
  assert.deepEqual(plain(reload.store.getVersion(id, 2).files), files);
  assert.equal(reload.store.getVersion(id, 1).entrypoint, "strategy.py");
  reload.$("duplicate-project").click(); await until(() => reload.$("project-title").textContent === "Entrypoint copy", "entrypoint duplicate");
  const copy = reload.store.getVersion(reload.w.location.hash.slice(9), 1);
  assert.equal(copy.entrypoint, "other.py"); assert.deepEqual(plain(copy.files), files);
  const savedReload = await boot(t, { hash: `#project/${id}`, storage: reload.storage() });
  await until(() => !savedReload.$("editor").disabled, "saved entrypoint reload");
  assert.equal(savedReload.$("editor-entrypoint").value, "other.py"); assert.equal(savedReload.$("draft-state").textContent, "Saved");
});

test("entrypoint rename preserves exact CRLF and leaves imports untouched; final file cannot disappear", async (t) => {
  const text = "from strategy import value\r\nvalue = 1\r\n";
  const ui = await boot(t, { seed: (store) => store.createProject({ name: "Rename entry", files: { "strategy.py": text } }) });
  await ui.navigate(`#project/${ui.seeded.id}`); await until(() => !ui.$("editor").disabled, "single file");
  assert.equal(ui.$("remove-file").disabled, true); ui.$("remove-file").click();
  assert.equal(ui.$("strategy-file-dialog").open, false);
  fileAction(ui, "rename", "pkg/main.py");
  assert.equal(ui.$("editor-entrypoint").value, "pkg/main.py");
  ui.$("download-code").click(); assert.equal(await blobText(ui.w, ui.downloads[0].blob), text);
  assert.equal(latestDraft(ui, ui.seeded.id).files["pkg/main.py"], text);
  assert.equal(ui.store.getVersion(ui.seeded.id, 1).files["strategy.py"], text);
  assert.match(ui.$("file-controls-note").textContent, /Imports are not rewritten/);
});

test("invalid and colliding file paths fail without altering files, versions or recovery drafts", async (t) => {
  const ui = await boot(t), id = await createLocal(ui), before = ui.storage();
  for (const path of ["strategy.py", "../escape.py", "/absolute.py", "a//b.py", "a\\b.py", ".hidden.py", "a.py.js", "snow雪.py", "a.py ", "__proto__", "a".repeat(254) + ".py", "<img>.py"]) {
    ui.$("add-file").click(); ui.input("file-path", path);
    ui.$("strategy-file-form").dispatchEvent(new ui.w.Event("submit", { cancelable: true }));
    assert.match(ui.$("file-dialog-status").textContent, /path|relative/i, path);
    assert.deepEqual(ui.storage(), before, path);
    ui.$("cancel-strategy-file").click();
  }
  fileAction(ui, "rename", "strategy.py");
  assert.match(ui.$("file-dialog-status").textContent, /already uses/);
  assert.deepEqual(ui.storage(), before);
  assert.equal(ui.store.getProject(id).latest_version_no, 1);
  assert.equal(ui.w.injected, undefined);
});

test("50-file and source-size limits reject new controls without discarding editor text", async (t) => {
  const files = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`file${i}.py`, ""]));
  const ui = await boot(t, { seed: (store) => store.createProject({ name: "Fifty", files, entrypoint: "file0.py" }) });
  await ui.navigate(`#project/${ui.seeded.id}`); await until(() => !ui.$("editor").disabled, "maximum files");
  assert.equal(ui.$("add-file").disabled, true);
  ui.$("add-file").dispatchEvent(new ui.w.Event("click")); ui.input("file-path", "extra.py");
  ui.$("confirm-strategy-file").click();
  assert.match(ui.$("file-dialog-status").textContent, /50/);
  assert.equal(ui.$("editor-file").options.length, 50);
  ui.$("cancel-strategy-file").click();
  const text = "雪".repeat(90000); ui.input("editor", text);
  fileAction(ui, "rename", "renamed.py");
  assert.match(ui.$("file-dialog-status").textContent, /256 KiB/);
  assert.equal(ui.$("editor").value, text);
  ui.$("cancel-strategy-file").click(); ui.$("save-version").click();
  await until(() => /256 KiB/.test(ui.$("status").textContent), "oversized save rejection");
  assert.equal(ui.store.getProject(ui.seeded.id).latest_version_no, 1);
  assert.equal(latestDraft(ui, ui.seeded.id).files["file0.py"], text, "Invalid large edits remain recoverable");
});

test("Close, Escape, navigation and stale confirmation never perform a file action", async (t) => {
  const ui = await boot(t), id = await createLocal(ui);
  fileAction(ui, "add", "helper.py");
  for (const action of ["close", "cancel", "escape"]) {
    const before = ui.storage(); ui.$("remove-file").click();
    if (action === "escape") ui.$("strategy-file-dialog").dispatchEvent(new ui.w.Event("cancel", { cancelable: true }));
    else ui.$(action === "close" ? "close-strategy-file" : "cancel-strategy-file").click();
    assert.equal(ui.$("strategy-file-dialog").open, false); assert.deepEqual(ui.storage(), before);
  }
  ui.$("remove-file").click(); ui.input("editor", "# newer source\n"); ui.$("confirm-strategy-file").click();
  assert.match(ui.$("file-dialog-status").textContent, /draft changed/);
  assert.equal(ui.$("editor-file").value, "helper.py");
  await ui.navigate("#code"); assert.equal(ui.$("strategy-file-dialog").open, false);
  ui.$("confirm-strategy-file").click();
  await ui.navigate(`#project/${id}`); await until(() => !ui.$("editor").disabled, "reopened draft");
  ui.input("editor-file", "helper.py", "change"); assert.equal(ui.$("editor").value, "# newer source\n");
  ui.$("rename-file").click(); ui.$("cancel-strategy-file").click(); ui.$("rename-file").click();
  ui.$("strategy-file-dialog").dispatchEvent(new ui.w.Event("close"));
  ui.input("file-path", "fresh.py"); ui.$("confirm-strategy-file").click();
  assert.equal(ui.$("editor-file").value, "fresh.py", "A queued native close must not clear the reopened action");
});

test("new file and entrypoint edits during an in-flight save remain drafts against the accepted version", async (t) => {
  const gate = deferred(), p = project("inflight", { "strategy.py": "# original\r\n", "helper.py": "# helper\r\n" });
  const ui = await boot(t, { user: true, handle: projectRoutes({ p }, (call) => {
    if (call.path === "/v1/projects/inflight/versions" && call.method === "POST") return gate.promise;
  }) });
  await ui.navigate("#project/inflight"); await until(() => !ui.$("editor").disabled, "inflight editor");
  ui.input("editor-entrypoint", "helper.py", "change"); ui.$("save-version").click();
  await until(() => ui.calls.some((call) => call.method === "POST"), "entrypoint save request");
  const request = ui.calls.find((call) => call.method === "POST");
  assert.equal(request.body.entrypoint, "helper.py"); assert.deepEqual(request.body.files, p.versions[0].files);
  fileAction(ui, "add", "new.py"); fileAction(ui, "rename", "next.py");
  ui.input("editor-entrypoint", "next.py", "change");
  ui.input("editor-file", "helper.py", "change"); fileAction(ui, "remove");
  ui.$("editor").dispatchEvent(new ui.w.KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
  assert.equal(ui.calls.filter((call) => call.method === "POST").length, 1, "Keyboard save joins the pending save");
  gate.resolve(response({ ...p.versions[0], id: "inflight-v2", version_no: 2, ...request.body }));
  await until(() => ui.$("project-version").textContent === "saved v2", "accepted snapshot");
  const draft = latestDraft(ui, p.id);
  assert.equal(draft.base_version, 2); assert.equal(draft.base_version_id, "inflight-v2");
  assert.equal(draft.entrypoint, "next.py"); assert.deepEqual(draft.files, { "strategy.py": p.versions[0].files["strategy.py"], "next.py": "" });
  assert.match(ui.$("draft-state").textContent, /Unsaved/);
  assert.equal(ui.$("editor-entrypoint").value, "next.py");
});

test("cloud file actions, pricing and duplicate attempts never save a draft implicitly", async (t) => {
  const p = project("cloud-files", { "strategy.py": "# main\n", "helper.py": "# helper\n" });
  const ui = await boot(t, { user: true, handle: projectRoutes({ p }, (call) => {
    if (call.path === "/v1/projects/cloud-files/versions" && call.method === "POST") return response({ ...p.versions[0], id: "v2", version_no: 2, ...call.body });
  }) });
  await ui.navigate("#project/cloud-files"); await until(() => !ui.$("editor").disabled, "cloud file editor");
  fileAction(ui, "add", "added.py"); ui.input("editor-entrypoint", "added.py", "change");
  ui.submit("quote-form"); ui.$("duplicate-project").click(); await delay(10);
  assert.equal(ui.calls.filter((call) => call.method !== "GET").length, 0);
  ui.$("save-version").click(); await until(() => ui.$("project-version").textContent === "saved v2", "explicit cloud save");
  const writes = ui.calls.filter((call) => call.method !== "GET");
  assert.equal(writes.length, 1); assert.equal(writes[0].path, "/v1/projects/cloud-files/versions");
  assert.equal(writes[0].body.entrypoint, "added.py"); assert.deepEqual(writes[0].body.files, { ...p.versions[0].files, "added.py": "" });
});

test("late quotes cannot reappear after entrypoint/file edits, even if edits are reversed", async (t) => {
  const pending = [], p = project("quote-files", { "strategy.py": "# main\n", "helper.py": "# helper\n" });
  const ui = await boot(t, { user: true, handle: projectRoutes({ p }, (call) => {
    if (call.path === "/v1/quotes") { const gate = deferred(); pending.push(gate); return gate.promise; }
  }) });
  await ui.navigate("#project/quote-files"); await until(() => !ui.$("editor").disabled, "quote files");
  ui.submit("quote-form"); await until(() => pending.length === 1, "pending entrypoint quote");
  ui.input("editor-entrypoint", "helper.py", "change"); ui.input("editor-entrypoint", "strategy.py", "change");
  pending[0].resolve(response({ id: "stale-quote", estimate: { customer_expected_nano: 1 }, customer_max_nano: 2 }));
  await delay(20); assert.equal(ui.$("quote-box").hidden, true);
  ui.submit("quote-form"); await until(() => pending.length === 2, "pending file quote");
  fileAction(ui, "add", "temp.py"); fileAction(ui, "remove");
  pending[1].resolve(response({ id: "stale-files", estimate: { customer_expected_nano: 1 }, customer_max_nano: 2 }));
  await delay(20); assert.equal(ui.$("quote-box").hidden, true);
  ui.$("approve").click(); await delay(5);
  assert.equal(ui.calls.some((call) => /authorize|\/jobs$/.test(call.path)), false);
  assert.equal(ui.calls.some((call) => call.method === "POST" && call.path.endsWith("/versions")), false);
});

test("assistant proposal/undo stay file-scoped and preserve exact CRLF sources", async (t) => {
  const ui = await boot(t, { seed: (store, w) => store.createProject({ name: "Exact assistant", files: {
    "strategy.py": w.VeyraStudioAssistant.templates.sma_cross.replace(/\n/g, "\r\n"), "helper.py": "# untouched\r\n",
  } }) });
  await ui.navigate(`#project/${ui.seeded.id}`); await until(() => !ui.$("editor").disabled, "exact helper");
  const original = ui.store.getVersion(ui.seeded.id, 1).files["strategy.py"];
  ask(ui, "set fast to 12"); assert.equal(ui.$("assistant-before").textContent, original);
  ui.$("assistant-apply").click();
  assert.equal(latestDraft(ui, ui.seeded.id).files["strategy.py"], original.replace('"fast", 10', '"fast", 12'));
  ui.$("assistant-undo").click(); assert.equal(ui.$("draft-state").textContent, "Saved");
  ask(ui, "set fast to 12"); ui.input("editor-entrypoint", "helper.py", "change"); ui.$("assistant-apply").click();
  assert.equal(ui.$("assistant-proposal").hidden, true);
  assert.equal(latestDraft(ui, ui.seeded.id).files["strategy.py"], original);
  ui.input("editor-entrypoint", "strategy.py", "change");
  ask(ui, "set fast to 12"); fileAction(ui, "rename", "main.py"); ui.$("assistant-apply").click();
  assert.equal(latestDraft(ui, ui.seeded.id).files["main.py"], original);
  ui.input("editor", ui.$("editor").value.replace('"fast", 10', '"fast", 13'));
  assert.equal(latestDraft(ui, ui.seeded.id).files["main.py"], original.replace('"fast", 10', '"fast", 13'));
  assert.equal(latestDraft(ui, ui.seeded.id).files["helper.py"], "# untouched\r\n");
  ui.$("download-code").click(); assert.equal(await blobText(ui.w, ui.downloads[0].blob), original.replace('"fast", 10', '"fast", 13'));
});

test("two-tab added/removed file drafts stay separate and stale snapshot saves preserve both histories", async (t) => {
  const shared = sharedStorage(), locks = lockManager();
  const one = await boot(t, { shared, locks }), id = await createLocal(one, "Shared files");
  const two = await boot(t, { shared, locks, hash: `#project/${id}` });
  await until(() => !two.$("editor").disabled, "second file tab");
  fileAction(one, "add", "first.py"); one.input("editor-entrypoint", "first.py", "change");
  fileAction(two, "rename", "second.py");
  const keys = Object.keys(one.storage()).filter((key) => key.startsWith(`veyra.draft.${id}.`));
  assert.equal(keys.length, 2);
  one.$("save-version").click(); two.$("save-version").click();
  await until(() => one.$("project-version").textContent === "saved v2", "first structural save");
  await until(() => /another tab/.test(two.$("status").textContent), "second structural conflict");
  assert.equal(two.$("editor-entrypoint").value, "second.py");
  assert.equal(two.store.getVersion(id, 2).entrypoint, "first.py");
  assert.equal(two.store.getVersion(id, 1).entrypoint, "strategy.py");
  const reload = await boot(t, { shared, locks, hash: `#project/${id}` });
  await until(() => !reload.$("editor").disabled, "structural conflict recovery");
  assert.equal(reload.$("editor-entrypoint").value, "first.py"); assert.equal(reload.$("recover-draft").hidden, false);
  reload.$("recover-draft").click();
  const bundle = JSON.parse(await blobText(reload.w, reload.downloads[0].blob));
  assert.ok(bundle.drafts.some((raw) => JSON.parse(raw).entrypoint === "second.py"));
  assert.equal(reload.store.getProject(id).versions.length, 2);
});

test("malformed, future, oversized and wrong-base complete drafts stay recovery-only without deletion", async (t) => {
  const originals = {};
  const ui = await boot(t, { seed: (store, w) => {
    const p = store.createProject({ name: "Untrusted drafts", files: { "strategy.py": "# saved\r\n" } });
    const base = { schema_version: 2, base_version: 1, base_version_id: p.latest_version.id, saved_at: 999,
      files: { "new.py": "# must not restore\n" }, entrypoint: "new.py" };
    const invalid = [null, [], { ...base, schema_version: 99 }, { ...base, base_version_id: "wrong" },
      { ...base, files: { "../escape.py": "" }, entrypoint: "../escape.py" }, { ...base, entrypoint: "missing.py" },
      { ...base, files: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}.py`, ""])), entrypoint: "f0.py" },
      { ...base, files: { "new.py": "x".repeat(256 * 1024 + 1) } }, { ...base, files: { "new.py": "\ud800" } }];
    invalid.forEach((value, index) => { const key = `veyra.draft.${p.id}.invalid-${index}`; originals[key] = JSON.stringify(value); w.localStorage.setItem(key, originals[key]); });
    const legacyKey = `veyra.draft.${p.id}`; originals[legacyKey] = "# legacy raw source\r\n"; w.localStorage.setItem(legacyKey, originals[legacyKey]);
    return p;
  } });
  await ui.navigate(`#project/${ui.seeded.id}`); await until(() => !ui.$("editor").disabled, "untrusted drafts");
  assert.equal(ui.$("editor").value, "# saved\n"); assert.equal(ui.$("draft-state").textContent, "Saved");
  for (const [key, raw] of Object.entries(originals)) assert.equal(ui.w.localStorage.getItem(key), raw);
  ui.$("recover-draft").click();
  assert.deepEqual(new Set(JSON.parse(await blobText(ui.w, ui.downloads[0].blob)).drafts), new Set(Object.values(originals)));
});

test("unconfirmed cloud save identity preserves the draft instead of marking it saved", async (t) => {
  for (const kind of ["wrong-project", "empty-id", "missing-id", "reused-id", "wrong-entrypoint", "wrong-source"]) {
    const p = project(`save-${kind}`, { "strategy.py": "# saved\n", "other.py": "# exact\r\n" });
    const ui = await boot(t, { user: true, handle: projectRoutes({ p }, (call) => {
      if (call.path === `/v1/projects/${p.id}/versions` && call.method === "POST") {
        const saved = { ...p.versions[0], id: "fresh-version", version_no: 2, ...call.body };
        if (kind === "wrong-project") saved.project_id = "another-project";
        if (kind === "empty-id") saved.id = "";
        if (kind === "missing-id") delete saved.id;
        if (kind === "reused-id") saved.id = p.versions[0].id;
        if (kind === "wrong-entrypoint") saved.entrypoint = "strategy.py";
        if (kind === "wrong-source") saved.files = { "other.py": "wrong" };
        return response(saved);
      }
    }) });
    await ui.navigate(`#project/${p.id}`); await until(() => !ui.$("editor").disabled, kind);
    ui.input("editor-entrypoint", "other.py", "change");
    ui.$("save-version").click();
    await until(() => /identity could not be confirmed/.test(ui.$("status").textContent), `${kind} rejected`);
    assert.equal(ui.$("project-version").textContent, "saved v1");
    assert.equal(ui.$("editor-entrypoint").value, "other.py"); assert.match(ui.$("draft-state").textContent, /Unsaved/);
    assert.equal(latestDraft(ui, p.id).base_version, 1);
  }
});

test("oversized typed drafts warn before reload and remain exactly downloadable afterward", async (t) => {
  const ui = await boot(t), id = await createLocal(ui), source = "x".repeat(256 * 1024 + 1);
  ui.input("editor", source);
  assert.match(ui.$("draft-state").textContent, /recovery-only.*256 KiB.*cannot restore automatically/);
  const raw = Object.entries(ui.storage()).find(([key]) => key.startsWith(`veyra.draft.${id}.`))[1];
  await ui.navigate("#code"); await ui.navigate(`#project/${id}`);
  await until(() => !ui.$("editor").disabled, "oversized recovery notice");
  assert.match(ui.$("status").textContent, /invalid or unsupported.*not applied/);
  assert.equal(ui.$("recover-draft").hidden, false);
  ui.$("recover-draft").click();
  assert.ok(JSON.parse(await blobText(ui.w, ui.downloads[0].blob)).drafts.includes(raw));
  assert.equal(JSON.parse(raw).files["strategy.py"], source);
});

test("untrusted draft timestamps do not coerce objects or block saved-source reads", async (t) => {
  const ui = await boot(t, { seed: (store, w) => {
    const p = store.createProject({ name: "Safe timestamps", files: { "strategy.py": "# source\n" } });
    for (const [index, saved_at] of [0, { valueOf: 1, toString: 1 }, "999", null].entries()) {
      w.localStorage.setItem(`veyra.draft.${p.id}.invalid-${index}`, JSON.stringify({ saved_at, base_version: 0, files: {} }));
    }
    return p;
  } });
  await ui.navigate(`#project/${ui.seeded.id}`); await until(() => !ui.$("editor").disabled, "safe draft timestamp read");
  assert.equal(ui.$("editor").value, "# source\n"); assert.equal(ui.$("recover-draft").hidden, false);
});

test("fresh draft keys preserve this tab's recovery-only or conflicted draft across subsequent edits and navigation", async (t) => {
  for (const kind of ["oversized", "old-base"]) {
    const ui = await boot(t), id = await createLocal(ui, `Retain ${kind}`);
    const original = kind === "oversized" ? "x".repeat(256 * 1024 + 1) : "# this tab's conflicted source\n";
    ui.input("editor", original);
    const [oldKey, oldRaw] = Object.entries(ui.storage()).find(([key]) => key.startsWith(`veyra.draft.${id}.`));
    if (kind === "old-base") ui.store.saveVersion(id, { files: { "strategy.py": "# other tab saved\n" }, expected_version_no: 1 });
    await ui.navigate("#code"); await ui.navigate(`#project/${id}`); await until(() => !ui.$("editor").disabled, "first recovery-only reopen");
    ui.input("editor", "# newer valid local draft\n");
    assert.equal(ui.w.localStorage.getItem(oldKey), oldRaw, "New edits must not replace an old owned recovery key");
    await ui.navigate("#code"); await ui.navigate(`#project/${id}`); await until(() => !ui.$("editor").disabled, "second recovery reopen");
    assert.equal(ui.$("editor").value, "# newer valid local draft\n");
    ui.$("save-version").click(); await until(() => ui.$("draft-state").textContent === "Saved", "save newer draft");
    ui.$("recover-draft").click();
    assert.ok(JSON.parse(await blobText(ui.w, ui.downloads[0].blob)).drafts.includes(oldRaw));
    assert.equal(ui.w.localStorage.getItem(oldKey), oldRaw);
  }
});

test("connected-account local file editing and explicit saves remain exclusively on this device", async (t) => {
  const ui = await boot(t, { user: true, seed: (store) => store.createProject({ name: "Production local", files: { "strategy.py": "# local\r\n" } }),
    handle: (call) => call.path === "/v1/orgs/fixture-org/projects" ? response({ projects: [], has_more: false, next_cursor: null }) : undefined });
  const id = ui.seeded.id;
  await ui.navigate(`#project/${id}`); await until(() => !ui.$("editor").disabled, "connected local editor");
  fileAction(ui, "add", "nested/main.py"); ui.input("editor-entrypoint", "nested/main.py", "change");
  ui.input("editor-file", "strategy.py", "change"); fileAction(ui, "remove");
  ui.$("save-version").click(); await until(() => ui.$("project-version").textContent === "saved v2", "connected local save");
  assert.equal(ui.store.getVersion(id, 2).entrypoint, "nested/main.py");
  assert.deepEqual(plain(ui.store.getVersion(id, 2).files), { "nested/main.py": "" });
  assert.deepEqual(plain(ui.store.getVersion(id, 1).files), { "strategy.py": "# local\r\n" });
  assert.equal(ui.calls.some((call) => call.method !== "GET"), false, "No cloud source/save/publication writes");
  assert.equal(ui.calls.some((call) => /\/projects\/local-/.test(call.path)), false);
  for (const control of ui.$("quote-form").querySelectorAll("input, select, button")) assert.equal(control.disabled, true);
});

test("saved history inspection does not revive removed draft files or reset its current entrypoint", async (t) => {
  const files = { "strategy.py": "# exact original\r\n", "helper.py": "# exact helper\r\n" };
  const ui = await boot(t, { seed: (store) => store.createProject({ name: "File history", files }) });
  await ui.navigate(`#project/${ui.seeded.id}`); await until(() => !ui.$("editor").disabled, "history file controls");
  fileAction(ui, "add", "next.py"); ui.input("editor-entrypoint", "next.py", "change");
  ui.input("editor-file", "strategy.py", "change"); fileAction(ui, "remove");
  const before = ui.storage(); ui.$("project-history").click();
  await until(() => !ui.$("history-snapshot").hidden, "original saved history");
  assert.equal(ui.$("history-source").textContent, files["strategy.py"]);
  assert.deepEqual([...ui.$("history-file-list").children].map((node) => node.textContent), Object.keys(files));
  ui.$("history-download").click();
  const old = JSON.parse(await blobText(ui.w, ui.downloads[0].blob));
  assert.deepEqual(old.files, files); assert.equal(old.entrypoint, "strategy.py"); assert.equal(old.has_unsaved_changes, false);
  ui.$("close-strategy-history").click();
  assert.equal(ui.$("editor-entrypoint").value, "next.py");
  assert.deepEqual([...ui.$("editor-file").options].map((item) => item.value), ["helper.py", "next.py"]);
  assert.deepEqual(ui.storage(), before);
});

test("reverting recovered files or entrypoint to saved state stays clean across reopening without deleting recovery data", async (t) => {
  for (const mode of ["file", "entrypoint"]) {
    const files = { "strategy.py": "# exact saved\r\n", "helper.py": "# helper\r\n" };
    const ui = await boot(t, { seed: (store) => store.createProject({ name: `Revert ${mode}`, files }) });
    const id = ui.seeded.id;
    await ui.navigate(`#project/${id}`); await until(() => !ui.$("editor").disabled, "revert editor");
    if (mode === "file") fileAction(ui, "rename", "renamed.py");
    else ui.input("editor-entrypoint", "helper.py", "change");
    const [oldKey, raw] = Object.entries(ui.storage()).find(([key]) => key.startsWith(`veyra.draft.${id}.`));
    await ui.navigate("#code"); await ui.navigate(`#project/${id}`); await until(() => !ui.$("editor").disabled, "restored structural draft");
    if (mode === "file") fileAction(ui, "rename", "strategy.py");
    else ui.input("editor-entrypoint", "strategy.py", "change");
    assert.equal(ui.$("draft-state").textContent, "Saved");
    await ui.navigate("#code"); await ui.navigate(`#project/${id}`); await until(() => !ui.$("editor").disabled, "clean reset reopen");
    assert.equal(ui.$("draft-state").textContent, "Saved");
    assert.equal(ui.$("editor-entrypoint").value, "strategy.py");
    assert.deepEqual([...ui.$("editor-file").options].map((option) => option.value), Object.keys(files));
    assert.equal(ui.w.localStorage.getItem(oldKey), raw, "Reverted source remains available in recovery");
    ui.$("recover-draft").click(); assert.ok(JSON.parse(await blobText(ui.w, ui.downloads[0].blob)).drafts.includes(raw));
    assert.equal(ui.store.getProject(id).latest_version_no, 1);
  }
});

test("same-millisecond clean recovery markers win with shuffled storage enumeration", async (t) => {
  const shared = sharedStorage(), originalKey = shared.key;
  shared.key = (index) => Array.from({ length: shared.length }, (_, i) => originalKey(i)).sort().reverse()[index];
  const ui = await boot(t, { shared }), id = await createLocal(ui), source = ui.$("editor").value;
  ui.w.Date.now = () => 12345;
  ui.input("editor", "# old draft\n");
  const old = latestDraft(ui, id);
  await ui.navigate("#code"); await ui.navigate(`#project/${id}`); await until(() => !ui.$("editor").disabled, "same-time restored draft");
  ui.input("editor", source);
  assert.ok(latestDraft(ui, id).saved_at > old.saved_at, "A clean marker explicitly supersedes the prior record");
  await ui.navigate("#code"); await ui.navigate(`#project/${id}`); await until(() => !ui.$("editor").disabled, "same-time clean reopen");
  assert.equal(ui.$("draft-state").textContent, "Saved"); assert.equal(ui.$("editor").value, source);
  ui.$("recover-draft").click(); assert.ok(JSON.parse(await blobText(ui.w, ui.downloads[0].blob)).drafts.some((raw) => JSON.parse(raw).files["strategy.py"] === old.files["strategy.py"]));
});

test("two tabs cannot duplicate a newer saved snapshot over the clean displayed version", async (t) => {
  const shared = sharedStorage(), locks = lockManager(), one = await boot(t, { shared, locks });
  const id = await createLocal(one, "Duplicate conflict");
  const two = await boot(t, { shared, locks, hash: `#project/${id}` });
  await until(() => !two.$("editor").disabled, "duplicate second tab");
  const shown = two.$("editor").value;
  fileAction(one, "add", "new.py"); one.input("editor-entrypoint", "new.py", "change");
  one.$("save-version").click(); await until(() => one.$("project-version").textContent === "saved v2", "newer saved version");
  const before = two.storage(); two.$("duplicate-project").click();
  await until(() => /Reopen the latest version before duplicating/.test(two.$("status").textContent), "duplicate conflict");
  assert.equal(two.$("editor").value, shown); assert.equal(two.$("editor-entrypoint").value, "strategy.py");
  assert.equal(two.$("project-version").textContent, "saved v1"); assert.equal(two.w.location.hash, `#project/${id}`);
  assert.deepEqual(two.storage(), before); assert.equal(two.store.listProjects().projects.length, 1);
});

test("cloud duplicate sends the displayed version guard and a conflict keeps the editor and drafts unchanged", async (t) => {
  const p = project("cloud-duplicate-conflict", { "strategy.py": "# main\r\n", "helper.py": "# exact\r\n" });
  const ui = await boot(t, { user: true, handle: projectRoutes({ p }, (call) => {
    if (call.path.endsWith("/duplicate")) return response({ detail: "Strategy changed. Reopen the latest version before duplicating." }, 409);
  }) });
  await ui.navigate(`#project/${p.id}`); await until(() => !ui.$("editor").disabled, "cloud guarded duplicate");
  const before = ui.storage(); ui.$("duplicate-project").click();
  await until(() => /Reopen the latest version/.test(ui.$("status").textContent), "cloud duplicate conflict");
  assert.deepEqual(ui.calls.find((call) => call.path.endsWith("/duplicate")).body, { expected_version_no: 1 });
  assert.equal(ui.$("editor").value, "# main\n"); assert.equal(ui.$("editor-entrypoint").value, "strategy.py");
  assert.deepEqual(ui.storage(), before); assert.equal(ui.w.location.hash, `#project/${p.id}`);
});
