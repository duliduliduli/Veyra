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
const scripts = ["workspace-store.js", "studio-assistant.js", "app.js"].map((name) =>
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
  const series = () => ({ values: [], setData(rows) { this.values = rows; }, data() { return this.values; }, applyOptions() {} });
  w.LightweightCharts = { createChart: () => ({ addLineSeries: series, addCandlestickSeries: series,
    addHistogramSeries: series, priceScale: () => ({ applyOptions() {} }), timeScale: () => ({ fitContent() {} }),
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
  w.eval(scripts[0]);
  w.eval(scripts[1]);
  const store = w.VeyraWorkspaceStore.create(w.localStorage);
  const seeded = seed?.(store, w);
  w.eval(scripts[2]);
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
    if (call.path === "/v1/orgs/fixture-org/projects") return response({ projects: Object.values(projects) });
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
        complete: true, metrics, equity_curve: [["2024-01-01", "10000"]], bars: { processed: 1, total: 1 },
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
