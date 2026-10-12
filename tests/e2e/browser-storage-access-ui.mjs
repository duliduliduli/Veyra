// Offline synthetic jsdom checks only: no browser, network, database or strategy execution.
// NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test tests/e2e/browser-storage-access-ui.mjs
// shortcut: real storage policy, navigation and native confirmation UI need separately authorized browser QA.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "chart-tools.js", "workspace-store.js", "studio-assistant.js", "backtest-params.js", "report-evidence.js", "proposal-diff.js", "strategy-backup.js", "saved-links.js", "app.js"]
  .map((name) => readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
const plain = (value) => JSON.parse(JSON.stringify(value));
const id = "11111111-1111-4111-8111-111111111111", versionId = "22222222-2222-4222-8222-222222222222";
const source = "# inert exact source\r\n# 雪\r\n";
const version = { id: versionId, project_id: id, version_no: 1, files: { "strategy.py": source }, entrypoint: "strategy.py", content_hash: `sha256:${"a".repeat(64)}`, created_at: "2026-01-01T00:00:00Z" };
const project = { id, name: "Private cloud fixture", versions: [version], folder: "Private folder" };
const snapshot = { ...version, id, title: "Public fixture", description: "Public description", published_at: "2026-01-01T00:00:00Z" };
const bars = Array.from({ length: 25 }, (_, i) => ({ ts: new Date(Date.UTC(2026, 0, i + 1)).toISOString(), open: "10", high: "12", low: "8", close: "11", volume: "100" }));
const dataset = { dataset_id: "synthetic-fixture", instrument_id: "SYNTH:BTC-USD", provider: "fixture", coverage_start: bars[0].ts, coverage_end: bars.at(-1).ts, quote_currency: "USD", license: "Synthetic fixture only" };
const reply = (value, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => plain(value) });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { resolve, promise }; };
async function until(condition, label) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail(`Timed out: ${label}`);
}
function storage(seed = {}) {
  const values = new Map(Object.entries(seed)), calls = [];
  const deny = (name) => { throw Object.assign(new Error(`Synthetic ${name}`), { name }); };
  return { values, calls, readError: null, writeError: null, removeError: null, enumerationError: null, blockedKey: null,
    get length() { calls.push(["length"]); if (this.enumerationError === "length") deny("SecurityError"); return values.size; },
    key(i) { calls.push(["key", i]); if (this.enumerationError === "key") deny("SecurityError"); return [...values.keys()][i] ?? null; },
    getItem(key) { calls.push(["get", key]); if (this.readError || this.blockedKey === key) deny(this.readError || "SecurityError"); return values.get(key) ?? null; },
    setItem(key, value) { calls.push(["set", key]); if (this.writeError) deny(this.writeError); values.set(key, String(value)); },
    removeItem(key) { calls.push(["remove", key]); if (this.removeError) deny(this.removeError); values.delete(key); },
    snapshot: () => Object.fromEntries(values), mutations: () => calls.filter(([op]) => op === "set" || op === "remove") };
}
function chartStub(charts) {
  return { createChart(element) {
    const scale = { fitContent() {}, applyOptions() {}, getVisibleLogicalRange: () => null, subscribeVisibleLogicalRangeChange() {}, setVisibleLogicalRange() {} };
    const chart = { series: [], applyOptions() {}, subscribeClick() {}, subscribeCrosshairMove() {},
      priceScale: () => ({ applyOptions() {} }), timeScale: () => scale };
    const add = () => { const series = { values: [], setData(values) { this.values = plain(values); }, data() { return this.values; }, applyOptions() {}, setMarkers() {},
      attachPrimitive() {}, createPriceLine: (line) => line, removePriceLine() {} }; chart.series.push(series); return series; };
    chart.addCandlestickSeries = chart.addLineSeries = chart.addHistogramSeries = chart.addBarSeries = chart.addAreaSeries = add;
    charts.set(element.id, chart); return chart;
  } };
}
async function boot(t, { hash = "#markets", shared = storage(), getterDenied = false, handle, confirm = false, wait = true } = {}) {
  const errors = [], calls = [], charts = new Map(), confirmations = [], console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: `https://veyra.test/${hash}`, runScripts: "outside-only", virtualConsole: console });
  const w = dom.window, $ = (name) => w.document.getElementById(name);
  t.after(async () => { await delay(20); w.close(); assert.deepEqual(errors, [], "No uncaught DOM errors or real navigation/network"); });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.LightweightCharts = chartStub(charts);
  Object.defineProperty(w, "localStorage", { configurable: true, get() { if (getterDenied) throw new w.DOMException("Synthetic denied getter", "SecurityError"); return shared; } });
  Object.defineProperty(w.navigator, "locks", { value: { request: async (_name, _options, fn) => fn() } });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  w.confirm = (message) => { confirmations.push(message); return typeof confirm === "function" ? confirm() : confirm; };
  let reloads = 0;
  // Stub only the navigation implementation: exercise the real click handler without navigating.
  const location = w.location[Object.getOwnPropertySymbols(w.location).find((key) => String(key) === "Symbol(impl)")];
  location.reload = () => { reloads++; };
  w.fetch = async (url, options = {}) => {
    const call = { path: String(url), method: options.method || "GET", ...options }; calls.push(call);
    const result = await handle?.(call); if (result !== undefined) return result;
    if (call.path === "/v1/me") return reply({ organizations: [{ id: "fixture-org" }] });
    if (call.path === "/v1/catalog/datasets") return reply({ datasets: [dataset] });
    if (call.path === `/v1/catalog/datasets/${dataset.dataset_id}/bars`) return reply({ bars });
    if (call.path === "/v1/orgs/fixture-org/billing/balance") return reply({ available_nano: 0, reserved_nano: 0, settled_usage_nano: 0 });
    if (call.path === "/v1/orgs/fixture-org/billing/usage") return reply({ usage_events: [] });
    if (call.path === `/v1/projects/${id}`) return reply(project);
    if (call.path === `/v1/projects/${id}/versions/1`) return reply(version);
    if (call.path.startsWith(`/v1/projects/${id}/publications`)) return reply({ publications: [], next_cursor: null, has_more: false });
    if (call.path.startsWith("/v1/public/strategies?")) return reply({ strategies: [snapshot] });
    if (call.path === `/v1/public/strategies/${id}`) return reply(snapshot);
    errors.push(`Unexpected fixture request: ${call.method} ${call.path}`); return reply({ detail: "Unexpected fixture request" }, 500);
  };
  scripts.slice(0, -1).forEach((script) => w.eval(script));
  w.eval(`${scripts.at(-1)}\nwindow.fixture = { state, route, readDeviceDrafts, persistDraft, markDraft, showProject,
    overlay(value) { selectedOverlay = value; updateOverlay(); } };`);
  if (wait) await until(() => !$(`view-${hash.slice(1).split("/")[0]}`).hidden && calls.some((call) => call.path === "/v1/catalog/datasets"), "boot");
  async function navigate(next) { w.location.hash = next; await delay(10); await until(() => !$(`view-${next.slice(1).split("/")[0]}`).hidden, next); }
  const input = (name, value) => { $(name).value = value; $(name).dispatchEvent(new w.Event("input", { bubbles: true })); };
  const editor = () => until(() => !$("editor").disabled && w.fixture.state.project, "editor");
  const posts = () => calls.filter((call) => call.method !== "GET");
  return { w, $, shared, calls, charts, confirmations, navigate, input, editor, posts, reloads: () => reloads };
}

for (const failure of ["getter", "getItem"]) test(`${failure} denial leaves chart, discovery and exact public source usable without writes`, async (t) => {
  const shared = storage({ "veyra.user": "remembered-fixture", "unrelated": "exact original bytes" });
  if (failure === "getItem") shared.readError = "SecurityError";
  const before = shared.snapshot(), ui = await boot(t, { shared, getterDenied: failure === "getter" });
  await until(() => ui.charts.get("market-chart")?.series[0].values.length === 25, "public chart data");
  assert.equal(ui.w.fixture.state.user, null); assert.equal(ui.w.fixture.state.org, null);
  assert.match(ui.$("session-storage-status").textContent, /anonymous access/);
  await ui.navigate("#discover"); await until(() => ui.$("discover-list").textContent.includes("Public fixture"), "discovery");
  await ui.navigate(`#public/${id}`); await until(() => !ui.$("public-content").hidden, "public source");
  assert.equal(ui.$("public-source").textContent, source); assert.equal(ui.$("public-save-link").disabled, true);
  assert.match(ui.$("public-save-status").textContent, /storage|read saved links/i);
  ui.$("public-copy").click(); await until(() => !ui.$("confirm-public-copy").disabled, "public copy review");
  ui.$("confirm-public-copy").click(); await until(() => /storage|read browser/i.test(ui.$("public-copy-status").textContent), "public copy denied");
  assert.equal(ui.$("public-copy-dialog").open, true); ui.$("cancel-public-copy").click();
  await ui.navigate("#discover/saved"); assert.match(ui.$("saved-links-status").textContent, /storage|read saved links/i);
  await ui.navigate("#code/device"); assert.match(ui.$("projects-scope").textContent, /Loading failed/);
  assert.doesNotMatch(ui.$("projects-scope").textContent, /All strategies on this device loaded/);
  ui.input("new-project-name", "Cannot save"); ui.$("create-project").click();
  await until(() => /storage/i.test(ui.$("new-project-status").textContent), "device creation denied");
  assert.equal(ui.w.location.hash, "#code/device");
  assert.deepEqual(shared.snapshot(), before); assert.deepEqual(shared.mutations(), []); assert.deepEqual(ui.posts(), []);
  assert.equal(ui.calls.some((call) => call.path === "/v1/me"), false);
  for (const call of ui.calls) assert.equal(call.headers?.["x-veyra-dev-user"], undefined);
  for (const call of ui.calls.filter((call) => call.path.includes("/public/"))) assert.equal(call.credentials, "omit");
  const methods = [["VeyraWorkspaceStore", "listProjects"], ["VeyraSavedLinks", "listLinks"]];
  if (failure === "getter") for (const [helper, method] of methods) {
    const store = ui.w[helper].create();
    assert.throws(() => store[method](), (error) => error.code === "STORAGE_UNAVAILABLE" && error.status === 503);
  }
});

for (const error of ["QuotaExceededError", "SecurityError"]) test(`${error} writes fail visibly without replacing any stored bytes`, async (t) => {
  const shared = storage({ untouched: "# exact private bytes\r\n" }), ui = await boot(t, { hash: `#public/${id}`, shared });
  await until(() => !ui.$("public-content").hidden, "source"); shared.writeError = error;
  ui.$("public-save-link").click(); ui.$("saved-link-confirm").click();
  await until(() => /were not changed/.test(ui.$("saved-link-status").textContent), "saved-link write failure");
  assert.equal(ui.$("saved-link-dialog").open, true); assert.equal(ui.$("public-save-link").textContent, "Save link");
  assert.deepEqual(shared.snapshot(), { untouched: "# exact private bytes\r\n" });
  ui.$("saved-link-cancel").click(); await ui.navigate("#code/device"); ui.input("new-project-name", "Cannot save"); ui.$("create-project").click();
  await until(() => /not saved/.test(ui.$("new-project-status").textContent), "workspace write failure");
  assert.deepEqual(shared.snapshot(), { untouched: "# exact private bytes\r\n" }); assert.deepEqual(ui.posts(), []);
});

for (const failure of ["length", "key", "getItem"]) test(`unreadable draft ${failure} fails editing closed without discarding or overwriting the draft`, async (t) => {
  const key = `veyra.draft.${id}.existing`, raw = '{"exact unreadable draft":"雪\\r\\n"}', shared = storage({ "veyra.user": "fixture-user", [key]: raw });
  if (failure === "getItem") shared.blockedKey = key; else shared.enumerationError = failure;
  const before = shared.snapshot(), ui = await boot(t, { shared, hash: `#project/${id}` });
  await until(() => ui.$("project-title").textContent === "Strategy unavailable", "draft read failure");
  assert.equal(ui.w.fixture.state.project, null); assert.equal(ui.$("editor").disabled, true);
  assert.match(ui.$("status").textContent, /Device drafts could not be read.*Editing is unavailable.*left unchanged/);
  assert.deepEqual(shared.snapshot(), before); assert.deepEqual(shared.mutations(), []); assert.deepEqual(ui.posts(), []);
  await ui.navigate("#discover"); await until(() => ui.$("discover-list").textContent.includes("Public fixture"), "public navigation after draft error");
});

test("draft write and cleanup failures keep exact prior bytes and show recovery status", async (t) => {
  const shared = storage({ "veyra.user": "fixture-user" }), ui = await boot(t, { shared, hash: `#project/${id}` }); await ui.editor();
  const p = ui.w.fixture.state.project, edited = "# changed inert bytes\r\n# 雪";
  ui.input("editor", edited); const saved = shared.values.get(p.draftKey);
  assert.equal(JSON.parse(saved).files["strategy.py"], edited); assert.equal(p.draftStored, true);
  shared.writeError = "QuotaExceededError"; ui.input("editor", "# memory only\n");
  assert.equal(shared.values.get(p.draftKey), saved); assert.equal(p.draftStored, false);
  assert.match(ui.$("draft-state").textContent, /Unsaved edits.*storage unavailable/);
  shared.writeError = null; shared.removeError = "SecurityError"; ui.input("editor", source.replaceAll("\r\n", "\n"));
  // The textarea normalizes CRLF, so select the exact saved snapshot through the existing draft state.
  p.files["strategy.py"] = source; ui.w.fixture.persistDraft(); ui.w.fixture.markDraft();
  assert.equal(shared.values.get(p.draftKey), saved); assert.equal(p.draftStored, false);
  assert.match(ui.$("draft-state").textContent, /draft reset not stored.*retained draft may return/);
});

test("normal exact draft restoration and successful signout preserve unrelated device data", async (t) => {
  const key = `veyra.draft.${id}.retained`, edited = "# restored exact\r\n# 雪\r\n";
  const raw = JSON.stringify({ schema_version: 2, base_version: 1, base_version_id: versionId, saved_at: 1, files: { "strategy.py": edited }, entrypoint: "strategy.py" });
  const shared = storage({ "veyra.user": "fixture-user", [key]: raw }), ui = await boot(t, { shared, hash: `#project/${id}` }); await ui.editor();
  assert.equal(ui.w.fixture.state.project.files["strategy.py"], edited); assert.match(ui.$("status").textContent, /Restored a device draft/);
  ui.$("signout").click(); assert.equal(ui.reloads(), 1); assert.equal(shared.values.has("veyra.user"), false);
  assert.equal(shared.values.get(key), raw); assert.deepEqual(ui.confirmations, []);
});

for (const endpoint of ["/v1/me", "/v1/catalog/datasets"]) test(`401 at ${endpoint} still reaches public route when remembered-user removal is denied`, async (t) => {
  const shared = storage({ "veyra.user": "fixture-user" }); shared.removeError = "SecurityError";
  const ui = await boot(t, { shared, hash: "#discover", handle: (call) => call.path === endpoint ? reply({ detail: "Synthetic unauthorized" }, 401) : undefined });
  await until(() => ui.$("discover-list").textContent.includes("Public fixture"), "discovery after 401");
  assert.equal(ui.w.fixture.state.user, null); assert.equal(ui.w.fixture.state.org, null);
  assert.match(ui.$("session-storage-status").textContent, /for this page only.*reloading may reconnect/);
  assert.equal(shared.values.get("veyra.user"), "fixture-user"); assert.equal(ui.reloads(), 0);
  assert.equal(ui.$("balance-pill").hidden, true);
});

test("failed signout invalidates an in-flight quote, closes source reviews, and clears usable report/source actions", async (t) => {
  const quote = deferred(), shared = storage({ "veyra.user": "fixture-user" });
  const ui = await boot(t, { shared, hash: `#project/${id}`, handle: (call) => call.path === "/v1/quotes" ? quote.promise : undefined }); await ui.editor();
  ui.$("quote-form").dispatchEvent(new ui.w.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => ui.posts().some((call) => call.path === "/v1/quotes"), "pending quote");
  ui.$("share-project").click(); await until(() => ui.$("share-source").textContent === source, "real saved-source review");
  ui.w.fixture.state.report = { fixture: "private report" }; ui.w.fixture.state.reportId = "fixture-report";
  for (const button of ui.w.document.querySelectorAll("[data-artifact]")) button.disabled = false;
  shared.removeError = "SecurityError"; const before = shared.snapshot(); ui.$("signout").click();
  assert.equal(ui.reloads(), 0); assert.equal(ui.w.fixture.state.user, null); assert.equal(ui.w.fixture.state.org, null);
  assert.equal(ui.w.fixture.state.project, null); assert.equal(ui.w.fixture.state.report, null); assert.equal(ui.w.fixture.state.reportId, null);
  assert.equal(ui.$("view-project").hidden, true); assert.equal(ui.$("share-dialog").open, false); assert.equal(ui.$("share-source").textContent, "");
  assert.equal(ui.$("editor").value, ""); assert.equal(ui.$("editor").disabled, true);
  assert.equal(ui.$("approve").disabled, true); assert.equal(ui.$("quote-box").hidden, true);
  assert.ok([...ui.w.document.querySelectorAll("[data-artifact], [data-topup]")].every((button) => button.disabled));
  quote.resolve(reply({ id: "stale-quote", customer_max_nano: 1, estimate: { customer_expected_nano: 1 } })); await delay(10);
  assert.equal(ui.w.fixture.state.quote, null); assert.equal(ui.$("approve").disabled, true);
  ui.$("approve").click(); ui.$("share-publish").click(); ui.$("save-version").click();
  assert.deepEqual(ui.posts().map((call) => call.path), ["/v1/quotes"]); assert.deepEqual(shared.snapshot(), before);
  ui.w.location.hash = `#project/${id}`; await until(() => !ui.$("view-code").hidden, "anonymous route guard");
});

for (const pending of ["usage", "topup"]) test(`failed signout prevents stale ${pending} results from restoring account UI or chaining a write`, async (t) => {
  const late = deferred(), shared = storage({ "veyra.user": "fixture-user" });
  const path = `/v1/orgs/fixture-org/billing/${pending === "usage" ? "usage" : "topups"}`;
  const ui = await boot(t, { shared, hash: "#wallet", handle: (call) => call.path === path ? late.promise : undefined });
  if (pending === "topup") { await until(() => !ui.$("balance-pill").hidden, "account ready"); ui.w.document.querySelector("[data-topup]").click(); }
  await until(() => ui.calls.some((call) => call.path === path), "pending account operation");
  shared.removeError = "SecurityError"; ui.$("signout").click();
  late.resolve(reply(pending === "usage" ? { usage_events: [{ meter: "private stale fixture", units: 1, unit: "second", supplier_cost_nano: 0, created_at: "2026-01-01", detail: {} }] } : { id: "fixture-payment", amount_nano: 1 })); await delay(10);
  assert.equal(ui.$("usage-list").textContent, ""); assert.equal(ui.$("balance-pill").hidden, true);
  assert.equal(ui.calls.some((call) => call.path.includes("/v1/dev/payments/")), false);
  assert.ok([...ui.w.document.querySelectorAll("[data-topup]")].every((button) => button.disabled));
  assert.equal(ui.reloads(), 0);
});

test("memory-only edits require discard confirmation; cancellation preserves identity, exact source and selection", async (t) => {
  let accepted = false;
  const shared = storage({ "veyra.user": "fixture-user" }), ui = await boot(t, { shared, hash: `#project/${id}`, confirm: () => accepted }); await ui.editor();
  shared.writeError = "SecurityError"; ui.input("editor", "# inert memory-only 雪\n"); ui.$("editor").setSelectionRange(3, 9);
  const p = ui.w.fixture.state.project, exact = p.files["strategy.py"], before = shared.snapshot(), removals = shared.mutations().length;
  ui.$("signout").click();
  assert.equal(ui.confirmations.length, 1); assert.match(ui.confirmations[0], /may be lost.*download a snapshot.*discard/s);
  assert.equal(ui.w.fixture.state.user, "fixture-user"); assert.equal(ui.w.fixture.state.project, p);
  assert.equal(p.files["strategy.py"], exact); assert.equal(ui.$("editor").selectionStart, 3); assert.equal(ui.$("editor").selectionEnd, 9);
  assert.equal(ui.reloads(), 0); assert.equal(shared.mutations().length, removals); assert.deepEqual(shared.snapshot(), before);
  accepted = true; shared.removeError = "SecurityError"; ui.$("signout").click();
  assert.equal(ui.confirmations.length, 2); assert.equal(ui.w.fixture.state.user, null); assert.equal(ui.w.fixture.state.project, null);
  assert.deepEqual(shared.snapshot(), before); assert.equal(ui.reloads(), 0);
});

for (const pending of ["identity", "organization"]) test(`failed signout during pending ${pending} boot still initializes anonymous chart data`, async (t) => {
  const late = deferred(), shared = storage({ "veyra.user": "fixture-user" }); shared.removeError = "SecurityError";
  const path = pending === "identity" ? "/v1/me" : "/v1/orgs";
  const ui = await boot(t, { shared, hash: "#wallet", wait: false, handle(call) {
    if (call.path === path) return late.promise;
    if (pending === "organization" && call.path === "/v1/me") return reply({ organizations: [] });
  } });
  await until(() => ui.calls.some((call) => call.path === path), "pending identity boot");
  ui.$("signout").click();
  late.resolve(reply(pending === "identity" ? { organizations: [{ id: "late-org" }] } : { id: "late-org" }));
  await until(() => ui.charts.get("market-chart")?.series[0].values.length === 25, "anonymous catalog and chart");
  assert.equal(ui.w.fixture.state.user, null); assert.equal(ui.w.fixture.state.org, null); assert.equal(ui.reloads(), 0);
  assert.equal(ui.calls.some((call) => call.path.includes("late-org")), false);
});

test("failed signout between project metadata and version response sends no old-account source request", async (t) => {
  const late = deferred(), shared = storage({ "veyra.user": "fixture-user" });
  const ui = await boot(t, { shared, hash: `#project/${id}`, handle: (call) => call.path === `/v1/projects/${id}` ? late.promise : undefined });
  await until(() => ui.calls.some((call) => call.path === `/v1/projects/${id}`), "pending project metadata");
  shared.removeError = "SecurityError"; ui.$("signout").click(); late.resolve(reply(project)); await delay(10);
  assert.equal(ui.calls.some((call) => call.path === `/v1/projects/${id}/versions/1`), false);
  assert.equal(ui.$("editor").value, ""); assert.equal(ui.w.fixture.state.project, null);
});

test("failed signout after explicit approval does not chain a job request from the late authorization", async (t) => {
  const late = deferred(), shared = storage({ "veyra.user": "fixture-user" });
  const ui = await boot(t, { shared, hash: `#project/${id}`, handle(call) {
    if (call.path === "/v1/quotes") return reply({ id: "fixture-quote", customer_max_nano: 1, estimate: { customer_expected_nano: 1 } });
    if (call.path === "/v1/quotes/fixture-quote/authorize") return late.promise;
  } }); await ui.editor();
  ui.$("quote-form").dispatchEvent(new ui.w.Event("submit", { cancelable: true })); await until(() => !ui.$("approve").disabled, "quote");
  ui.$("approve").click(); await until(() => ui.calls.some((call) => call.path.endsWith("/authorize")), "authorization pending");
  shared.removeError = "SecurityError"; ui.$("signout").click(); late.resolve(reply({ id: "fixture-authorization" })); await delay(10);
  assert.equal(ui.calls.some((call) => call.path === "/v1/jobs"), false); assert.equal(ui.w.fixture.state.quote, null);
  assert.equal(ui.$("approve").disabled, true);
});

test("failed signout suppresses a late private duplicate name", async (t) => {
  const late = deferred(), shared = storage({ "veyra.user": "fixture-user" });
  const ui = await boot(t, { shared, hash: `#project/${id}`, handle: (call) => call.path.endsWith("/duplicate") ? late.promise : undefined }); await ui.editor();
  ui.$("duplicate-project").click(); await until(() => ui.calls.some((call) => call.path.endsWith("/duplicate")), "duplicate pending");
  shared.removeError = "SecurityError"; ui.$("signout").click(); late.resolve(reply({ id: "copy", name: "PRIVATE LATE NAME" })); await delay(10);
  assert.doesNotMatch(ui.$("status").textContent, /PRIVATE LATE NAME/); assert.equal(ui.w.location.hash, "");
});

test("failed signout clears in-page report overlays as successful page reload would", async (t) => {
  const shared = storage({ "veyra.user": "fixture-user" }), ui = await boot(t, { shared });
  await until(() => ui.charts.get("market-chart")?.series[0].values.length === 25, "market chart");
  ui.w.fixture.overlay({ note: "PRIVATE REPORT EVIDENCE", dataset_id: "other-dataset", fills: [],
    version_no: 1, run_id: "fixture-run", provider: "synthetic",
    range: { start: "2020-01-01", end: "2020-01-02" } });
  ui.$("overlay-fill-list").textContent = "PRIVATE FILL";
  assert.equal(ui.$("overlay-readout").hidden, false);
  shared.removeError = "SecurityError"; ui.$("signout").click();
  assert.equal(ui.$("overlay-readout").hidden, true); assert.equal(ui.$("overlay-details").hidden, true);
  assert.equal(ui.$("overlay-fill-list").textContent, ""); assert.equal(ui.$("overlay-evidence").textContent, "");
  ui.$("chart-report").click(); assert.doesNotMatch(ui.$("report-overlay-dialog").textContent, /PRIVATE REPORT EVIDENCE|PRIVATE FILL/);
});

test("failed signout retains a stored dirty draft exactly without requesting discard", async (t) => {
  const shared = storage({ "veyra.user": "fixture-user" }), ui = await boot(t, { shared, hash: `#project/${id}` }); await ui.editor();
  ui.input("editor", "# exact stored dirty draft\n# 雪\n");
  const p = ui.w.fixture.state.project, raw = shared.values.get(p.draftKey), exact = p.files["strategy.py"];
  assert.equal(JSON.parse(raw).files["strategy.py"], exact); assert.equal(p.draftStored, true);
  const before = shared.snapshot(); shared.removeError = "SecurityError"; ui.$("signout").click();
  assert.deepEqual(ui.confirmations, []); assert.equal(ui.w.fixture.state.project, null);
  assert.equal(shared.values.get(p.draftKey), raw); assert.deepEqual(shared.snapshot(), before);
  assert.equal(ui.reloads(), 0); assert.match(ui.$("session-storage-status").textContent, /drafts were left unchanged/);
});
