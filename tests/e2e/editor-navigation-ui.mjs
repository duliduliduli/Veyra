// Offline editor-navigation contract: inert Python strings and intercepted APIs only.
// NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test tests/e2e/editor-navigation-ui.mjs
// shortcut: jsdom history/events are synthetic; authorize browser QA to verify native dialogs and traversal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom");
const root = process.env.VEYRA_NAVIGATION_SOURCE ? pathToFileURL(`${resolve(process.env.VEYRA_NAVIGATION_SOURCE)}/`) : new URL("../../", import.meta.url);
const html = readFileSync(new URL("apps/web/index.html", root), "utf8");
const scripts = ["chart-research.js", "chart-tools.js", "workspace-store.js", "studio-assistant.js", "backtest-params.js", "report-evidence.js", "proposal-diff.js", "strategy-backup.js", "saved-links.js", "app.js"]
  .map((name) => readFileSync(new URL(`apps/web/${name}`, root), "utf8"));
const files = { "strategy.py": "# π 😀\r\n\tvalue = 1\r\nlast\r", "helpers/entry.py": "# inert\n<svg onload=window.unsafe=true>\u00a0", "helpers/empty.py": "" };
const orgId = "30000000-0000-4000-8000-000000000001", cloudId = "40000000-0000-4000-8000-000000000001";
const me = { user_id: "20000000-0000-4000-8000-000000000001", subject: "owner@example.test", organizations: [{ id: orgId, name: "Private research team", role: "owner" }] };
const inputProject = (extra = {}) => ({ name: "Device strategy", description: "Private notes", folder: "Research", files, entrypoint: "helpers/entry.py", ...extra });
const plain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const reply = (value, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => plain(value) });
const created = (body) => ({ ...body, id: cloudId, org_id: orgId, created_by: me.user_id, latest_version: { id: "50000000-0000-4000-8000-000000000001", project_id: cloudId,
  version_no: 1, entrypoint: body.entrypoint, content_hash: `sha256:${"a".repeat(64)}` } });
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function until(condition, label) { for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); } assert.fail(`Timed out: ${label}`); }
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function boot(t, { connected = true, seed, handle } = {}) {
  const errors = [], calls = [], closes = [], storage = new Map(), locks = [], prompts = [];
  let accepted = false, reloads = 0, reloadPrevented = null;
  const shared = { get length() { return storage.size; }, key: (i) => [...storage.keys()][i], getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k), snapshot: () => Object.fromEntries(storage) };
  const virtualConsole = new VirtualConsole(); virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: "https://veyra.test/#code/device", runScripts: "outside-only", virtualConsole });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  t.after(async () => { await delay(20); w.close(); assert.deepEqual(errors, [], "No uncaught errors or unexpected requests"); });
  w.confirm = (message) => { prompts.push(message); return accepted; };
  const unload = () => { const event = new w.Event("beforeunload", { cancelable: true }); w.dispatchEvent(event); return event.defaultPrevented; };
  const location = w.location[Object.getOwnPropertySymbols(w.location).find((key) => String(key) === "Symbol(impl)")];
  location.reload = () => { reloads++; reloadPrevented = unload(); };
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  Object.defineProperty(w, "localStorage", { value: shared });
  Object.defineProperty(w.navigator, "locks", { value: { request(name, options, action) { locks.push(name); return Promise.resolve().then(action); } } });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { if (this.open) { this.open = false; closes.push(() => this.dispatchEvent(new w.Event("close"))); } };
  if (connected) shared.setItem("veyra.user", "owner@example.test");
  w.fetch = async (path, options = {}) => {
    const call = { path, ...options, body: options.body ? JSON.parse(options.body) : undefined }; calls.push(call);
    const custom = await handle?.(call, calls); if (custom !== undefined) return custom;
    if (path === "/v1/me") return reply(me);
    if (path === "/v1/catalog/datasets") return reply({ datasets: [] });
    if (path.endsWith("/billing/balance")) return reply({ available_nano: 0 });
    if (path === `/v1/orgs/${orgId}/projects` && call.method === "GET") return reply({ projects: [], has_more: false, next_cursor: null });
    if (path === `/v1/orgs/${orgId}/projects` && call.method === "POST") return reply(created(call.body), 201);
    errors.push(`Unexpected request ${call.method} ${path}`); return reply({ detail: "Unexpected test request" }, 500);
  };
  scripts.slice(0, -1).forEach((s) => w.eval(s));
  const store = w.VeyraWorkspaceStore.create(shared), seeded = seed ? seed(store) : store.createProject(inputProject());
  w.eval(`${scripts.at(-1)}\nwindow.fixtureState = state; window.fixture = { route, persistDraft, markDraft, setDraftSnapshot, forgetRememberedUser,
    context: () => ({ project: state.project, generation: routeGeneration, load: projectLoad, fileName, strategyHistory, historyCloudCopy, strategyFile, strategySettings, assistantProposal, assistantUndo }),
    historyCurrent: () => historyCurrent(strategyHistory) };`);
  await until(() => !$("view-code").hidden && $("workspace-mode").textContent, "boot");
  const input = (id, value, type = "input") => { $(id).value = value; $(id).dispatchEvent(new w.Event(type, { bubbles: true })); };
  async function open(id = seeded.id) { w.location.hash = `#project/${id}`; await until(() => w.fixtureState.project?.id === id && !$("editor").disabled, "editor"); }
  async function history() { $("project-history").click(); await until(() => !$("history-snapshot").hidden, "history"); }
  async function select(number) { input("history-version", String(number), "change"); await until(() => !$("history-snapshot").hidden, "selected source"); }
  async function review() { $("review-cloud-copy").click(); await until(() => !$("cloud-copy-status").textContent.startsWith("Checking") && $("cloud-copy-status").textContent, "cloud review"); }
  const submit = () => $("cloud-copy-form").dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
  const writes = () => calls.filter((c) => c.method !== "GET");
  const flushCloses = () => { for (const close of closes.splice(0)) close(); };
  return { w, $, shared, store, seeded, locks, calls, input, open, history, select, review, submit, writes, flushCloses, prompts, unload, accept: (value = true) => { accepted = value; }, reloads: () => reloads, reloadPrevented: () => reloadPrevented };
}

const memoryFiles = { "strategy.py": "# exact π 😀\r\n\tvalue = 2\r\nlast\r", "renamed.py": "# renamed\r\n", "new/empty.py": "", "new/entry.py": "# new entry\n\tpass" };
async function dirty(ui, { review = true } = {}) {
  ui.shared.setItem = () => { throw new Error("Read-only storage"); };
  ui.w.fixture.setDraftSnapshot({ files: memoryFiles, entrypoint: "new/entry.py" }, "strategy.py");
  assert.equal(ui.w.fixtureState.project.draftStored, false);
  if (review) {
    await ui.history(); await ui.review(); ui.input("cloud-copy-name", "Keep this review name");
    ui.input("history-file", "strategy.py", "change"); ui.$("history-compare").click();
  }
  ui.$("editor").setSelectionRange(3, 12, "backward");
}
function capture(ui) {
  const context = ui.w.fixture.context();
  return { context, project: plain(context.project), url: ui.w.location.href, historyState: plain(ui.w.history.state),
    user: ui.w.fixtureState.user, org: ui.w.fixtureState.org, storage: ui.shared.snapshot(),
    editor: ui.$("editor").value, selection: [ui.$("editor").selectionStart, ui.$("editor").selectionEnd, ui.$("editor").selectionDirection],
    controls: ["editor-file", "editor-entrypoint", "history-version", "history-file", "history-compare-file", "cloud-copy-name"].map((id) => ui.$(id).value),
    history: ui.$("strategy-history-dialog").innerHTML, dialog: ui.$("strategy-history-dialog").open,
    writes: plain(ui.writes()), draftState: ui.$("draft-state").textContent };
}
function unchanged(ui, before) {
  const context = ui.w.fixture.context();
  for (const key of Object.keys(before.context)) assert.equal(context[key], before.context[key], `${key} identity/value is preserved`);
  assert.deepEqual(plain(ui.w.fixtureState.project), before.project);
  assert.equal(ui.w.location.href, before.url); assert.deepEqual(plain(ui.w.history.state), before.historyState);
  assert.equal(ui.w.fixtureState.user, before.user); assert.equal(ui.w.fixtureState.org, before.org);
  assert.deepEqual(ui.shared.snapshot(), before.storage); assert.equal(ui.$("editor").value, before.editor);
  assert.deepEqual([ui.$("editor").selectionStart, ui.$("editor").selectionEnd, ui.$("editor").selectionDirection], before.selection);
  assert.deepEqual(["editor-file", "editor-entrypoint", "history-version", "history-file", "history-compare-file", "cloud-copy-name"].map((id) => ui.$(id).value), before.controls);
  assert.equal(ui.$("strategy-history-dialog").innerHTML, before.history); assert.equal(ui.$("strategy-history-dialog").open, before.dialog);
  assert.deepEqual(plain(ui.writes()), before.writes); assert.equal(ui.$("draft-state").textContent, before.draftState);
  if (before.dialog) assert.equal(ui.w.fixture.historyCurrent(), true);
}

test("counterfactual: All strategies cancellation retains the only exact in-memory project", async (t) => {
  const ui = await boot(t); await ui.open(); await dirty(ui); const before = capture(ui);
  ui.$("project-library-link").click(); await delay(25);
  unchanged(ui, before); assert.equal(ui.prompts.length, 1);
  assert.deepEqual(plain(ui.w.fixtureState.project.files), memoryFiles);
  assert.match(ui.prompts[0], /unsaved edits could not be stored.*Cancel and download a snapshot.*discard/s);
  assert.deepEqual(ui.writes(), []);
});

for (const destination of ["#code/device", "#code/cloud", "#markets", "#project/local-missing"]) test(`ordinary link ${destination} guards before any state or URL mutation`, async (t) => {
  const ui = await boot(t); await ui.open(); await dirty(ui); const before = capture(ui), length = ui.w.history.length;
  const link = ui.w.document.createElement("a"); link.href = destination; link.innerHTML = "<span>Nested destination</span>"; ui.w.document.body.append(link);
  for (let i = 0; i < 3; i++) {
    link.firstChild.click(); unchanged(ui, before); assert.equal(ui.w.history.length, length);
  }
  await delay(25); unchanged(ui, before); assert.equal(ui.prompts.length, 3);
});

for (const destination of ["#code/device", "#code/cloud", "#project/local-missing"]) test(`programmatic hash ${destination} restores URL before clearing the project or review`, async (t) => {
  const ui = await boot(t); await ui.open(); await dirty(ui); const before = capture(ui);
  for (let i = 0; i < 3; i++) {
    ui.w.location.hash = destination; await delay(25); unchanged(ui, before);
    assert.equal(ui.prompts.length, i + 1, "Exactly one prompt per attempted route");
  }
});

test("queued away/back hashes cannot reopen the active project or close its review", async (t) => {
  const ui = await boot(t); await ui.open(); await dirty(ui); const before = capture(ui);
  ui.w.location.hash = "#code/cloud"; ui.w.location.hash = "#code/device"; ui.w.location.hash = new URL(before.url).hash;
  await delay(30); unchanged(ui, before); assert.equal(ui.prompts.length, 0);
  ui.w.location.hash = "#code/cloud"; ui.w.location.hash = "#code/device";
  await delay(30); unchanged(ui, before); assert.equal(ui.prompts.length, 1);
  ui.w.dispatchEvent(new ui.w.HashChangeEvent("hashchange", { oldURL: "https://veyra.test/#code/cloud", newURL: before.url }));
  unchanged(ui, before); assert.equal(ui.prompts.length, 1, "The restoration event is not a destructive same-project reload");
});

test("synthetic Back and Forward cancellation preserve the draft while replacing the traversed entry", async (t) => {
  const ui = await boot(t); await ui.open();
  ui.w.location.hash = "#code/cloud"; await until(() => !ui.$("view-code").hidden, "forward destination");
  ui.w.history.back(); await until(() => ui.w.fixtureState.project && !ui.$("editor").disabled, "back to editor");
  await dirty(ui); const before = capture(ui), length = ui.w.history.length;
  ui.w.history.back(); await delay(30); unchanged(ui, before); assert.equal(ui.prompts.length, 1);
  assert.equal(ui.w.history.length, length, "Cancellation does not create a history entry");
  ui.w.history.forward(); await delay(30); unchanged(ui, before); assert.equal(ui.prompts.length, 1, "Same-URL traversal cannot destroy the editor");
  ui.w.history.forward(); await delay(30); unchanged(ui, before); assert.equal(ui.prompts.length, 2);
  for (const method of ["back", "back", "forward", "forward"]) { ui.w.history[method](); await delay(20); unchanged(ui, before); }
  assert.equal(ui.prompts.length, 2); assert.equal(ui.w.history.length, length);
});

test("same-project route reload cancels intact and only reloads after explicit discard", async (t) => {
  const ui = await boot(t); await ui.open(); await dirty(ui); const before = capture(ui);
  for (let i = 0; i < 2; i++) { ui.w.fixture.route(); unchanged(ui, before); }
  assert.equal(ui.prompts.length, 2); ui.accept(); ui.w.fixture.route();
  await until(() => ui.w.fixtureState.project && ui.w.fixtureState.project !== before.context.project && !ui.$("editor").disabled, "confirmed same-project reload");
  assert.equal(ui.prompts.length, 3); assert.deepEqual(plain(ui.w.fixtureState.project.files), files);
  assert.equal(ui.$("strategy-history-dialog").open, false); assert.equal(ui.unload(), false);
});

for (const kind of ["link", "hash", "Back", "Forward"]) test(`explicit discard allows ${kind} exactly once`, async (t) => {
  const ui = await boot(t); await ui.open();
  if (kind === "Forward") {
    ui.w.location.hash = "#code/cloud"; await until(() => !ui.$("view-code").hidden, "next library");
    ui.w.history.back(); await until(() => ui.w.fixtureState.project && !ui.$("editor").disabled, "editor before forward");
  }
  await dirty(ui); ui.accept();
  if (kind === "link") ui.$("project-library-link").click();
  if (kind === "hash") ui.w.location.hash = "#code/device";
  if (kind === "Back") ui.w.history.back();
  if (kind === "Forward") ui.w.history.forward();
  await until(() => !ui.$("view-code").hidden && !ui.$("strategy-history-dialog").open, "confirmed departure");
  await delay(25); assert.equal(ui.prompts.length, 1); assert.equal(ui.w.fixtureState.project, null); assert.equal(ui.unload(), false);
  await ui.open(); assert.deepEqual(plain(ui.w.fixtureState.project.files), files); assert.equal(ui.prompts.length, 1);
});

for (const kind of ["clean", "stored dirty", "clean failed removal"]) test(`${kind} source needs no discard prompt and recoverable drafts reopen exactly`, async (t) => {
  const ui = await boot(t); await ui.open();
  if (kind === "stored dirty") ui.w.fixture.setDraftSnapshot({ files: memoryFiles, entrypoint: "new/entry.py" });
  if (kind === "clean failed removal") { ui.shared.removeItem = () => { throw new Error("Read-only"); }; ui.w.fixture.persistDraft(); ui.w.fixture.markDraft(); }
  assert.equal(ui.unload(), false); ui.$("project-library-link").click(); await until(() => !ui.$("view-code").hidden, "safe library");
  await ui.open(); assert.deepEqual(plain(ui.w.fixtureState.project.files), kind === "stored dirty" ? memoryFiles : files);
  assert.equal(ui.prompts.length, 0); assert.equal(ui.unload(), false);
});

test("failed storage never counts as a backup even if an older recoverable draft exists", async (t) => {
  const ui = await boot(t); await ui.open(); ui.input("editor", "# older stored draft\n");
  const key = ui.w.fixtureState.project.draftKey, backup = ui.shared.getItem(key), originalSet = ui.shared.setItem;
  await dirty(ui); assert.equal(ui.shared.getItem(key), backup); assert.equal(ui.unload(), true);
  ui.$("project-library-link").click(); assert.equal(ui.prompts.length, 1); assert.deepEqual(plain(ui.w.fixtureState.project.files), memoryFiles);
  ui.shared.setItem = originalSet; ui.w.fixture.persistDraft(); ui.w.fixture.markDraft();
  assert.equal(ui.w.fixtureState.project.draftStored, true); assert.equal(ui.unload(), false);
  ui.$("project-library-link").click(); await until(() => !ui.$("view-code").hidden, "library after backup succeeded");
  await ui.open(); assert.deepEqual(plain(ui.w.fixtureState.project.files), memoryFiles); assert.equal(ui.prompts.length, 1);
});

test("beforeunload requests only native prevention and never claims persistence or mutates the draft", async (t) => {
  const ui = await boot(t); await ui.open(); assert.equal(ui.unload(), false); await dirty(ui); const before = capture(ui);
  for (let i = 0; i < 3; i++) { assert.equal(ui.unload(), true); unchanged(ui, before); }
  assert.equal(ui.prompts.length, 0, "The browser owns unload confirmation; window.confirm is not called");
});

test("modified/new-tab/download/external links keep native behavior and never consume a discard approval", async (t) => {
  const ui = await boot(t); await ui.open(); await dirty(ui); const before = capture(ui);
  const link = ui.$("project-library-link"); let activations = 0;
  ui.w.document.addEventListener("click", (event) => { if (event.target === link) { assert.equal(event.defaultPrevented, false); activations++; event.preventDefault(); } });
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])
    link.dispatchEvent(new ui.w.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...options }));
  for (const target of ["_blank", "named-window"]) { link.target = target; link.click(); }
  link.removeAttribute("target"); link.download = "fixture"; link.click(); link.removeAttribute("download");
  link.href = "https://elsewhere.test/"; link.click(); link.href = before.url; link.click();
  assert.equal(activations, 10); assert.equal(ui.prompts.length, 0); unchanged(ui, before);
  assert.equal(ui.unload(), true, "A real same-tab document departure would request the native warning");
});

test("previously cancelled click events do not ask or mutate state", async (t) => {
  const ui = await boot(t); await ui.open(); await dirty(ui); const before = capture(ui), link = ui.$("project-library-link");
  link.addEventListener("click", (event) => event.preventDefault()); link.click(); unchanged(ui, before); assert.equal(ui.prompts.length, 0);
});

for (const removal of ["allowed", "denied"]) test(`approved signout with ${removal} remembered-user removal clears identity without a second prompt`, async (t) => {
  const ui = await boot(t); await ui.open(); await dirty(ui); const before = capture(ui);
  ui.$("signout").click(); unchanged(ui, before); assert.equal(ui.prompts.length, 1);
  if (removal === "denied") ui.shared.removeItem = () => { throw new Error("Denied"); };
  ui.accept(); ui.$("signout").click(); await delay(30);
  assert.equal(ui.prompts.length, 2); assert.equal(ui.w.fixtureState.project, null); assert.equal(ui.w.fixtureState.user, null); assert.equal(ui.w.fixtureState.org, null);
  assert.equal(ui.w.location.hash, ""); assert.equal(ui.$("strategy-history-dialog").open, false); assert.equal(ui.unload(), false);
  assert.equal(ui.reloads(), removal === "allowed" ? 1 : 0);
  if (removal === "allowed") assert.equal(ui.reloadPrevented(), false, "Already-approved discard cannot raise native unload again");
});

for (const actor of ["user", "org"]) test(`a changed ${actor} is never rolled back to the prior editor owner`, async (t) => {
  const ui = await boot(t); await ui.open(); await dirty(ui); const old = ui.w.fixtureState.project;
  ui.w.fixtureState[actor] = actor === "user" ? "new-owner@example.test" : null;
  ui.w.location.hash = "#code/device"; await until(() => !ui.$("view-code").hidden, "new context library");
  assert.equal(ui.prompts.length, 0); assert.equal(ui.w.fixtureState.project, null); assert.equal(ui.$("strategy-history-dialog").open, false);
  assert.equal(ui.w.fixtureState[actor], actor === "user" ? "new-owner@example.test" : null); assert.equal(ui.unload(), false);
  assert.notEqual(ui.w.location.hash, `#project/${old.id}`);
});

test("pending review response remains owned after cancellation and a later disconnect clears it", async (t) => {
  const pending = deferred(); let gets = 0;
  const ui = await boot(t, { handle: (call) => call.path === "/v1/me" && ++gets === 2 ? pending.promise : undefined });
  await ui.open(); await dirty(ui, { review: false }); await ui.history(); ui.$("review-cloud-copy").click();
  const project = ui.w.fixtureState.project, review = ui.w.fixture.context().historyCloudCopy;
  ui.w.location.hash = "#code/device"; await delay(25); assert.equal(ui.w.fixture.context().historyCloudCopy, review);
  assert.equal(ui.w.fixture.historyCurrent(), true); pending.resolve(reply(me)); await settle();
  assert.match(ui.$("cloud-copy-status").textContent, /Review every saved file/); assert.equal(ui.w.fixtureState.project, project);
  ui.w.fixture.forgetRememberedUser(); ui.w.location.hash = "#code/device"; await delay(25);
  assert.equal(ui.w.fixtureState.user, null); assert.equal(ui.w.fixtureState.project, null); assert.equal(ui.prompts.length, 1);
  assert.equal(ui.$("strategy-history-dialog").open, false); assert.equal(ui.unload(), false);
});

for (const kind of ["cloud", "anonymous-device"]) test(`${kind} editors share the same exact-source guard`, async (t) => {
  const version = { ...created(inputProject()).latest_version, files, created_at: "2026-01-01T00:00:00Z" };
  const ui = await boot(t, { connected: kind === "cloud", handle(call) {
    if (call.path === `/v1/projects/${cloudId}`) return reply({ ...inputProject(), id: cloudId, visibility: "private", versions: [version] });
    if (call.path === `/v1/projects/${cloudId}/versions/1`) return reply(version);
  } });
  await ui.open(kind === "cloud" ? cloudId : ui.seeded.id); await dirty(ui, { review: false }); const before = capture(ui);
  ui.$("project-library-link").click(); unchanged(ui, before); assert.equal(ui.prompts.length, 1); assert.equal(ui.unload(), true);
  ui.w.location.hash = "#code/device"; await delay(25); unchanged(ui, before); assert.equal(ui.prompts.length, 2);
});

for (const actor of ["user", "org"]) test(`${actor} change during a cancelled confirmation cannot resurrect the previous route`, async (t) => {
  const ui = await boot(t); await ui.open(); await dirty(ui);
  ui.w.confirm = () => { ui.w.fixtureState[actor] = null; return false; };
  ui.w.location.hash = "#code/device"; await until(() => !ui.$("view-code").hidden, "privacy takes precedence");
  assert.equal(ui.w.location.hash, "#code/device"); assert.equal(ui.w.fixtureState[actor], null); assert.equal(ui.w.fixtureState.project, null);
  assert.equal(ui.$("strategy-history-dialog").open, false); assert.equal(ui.unload(), false);
});

for (const [button, dialog, input] of [["add-file", "strategy-file-dialog", "file-path"], ["project-settings", "strategy-settings-dialog", "settings-description"]])
  test(`${dialog} keeps its open review and unsubmitted fields after blocked navigation`, async (t) => {
    const ui = await boot(t); await ui.open(); await dirty(ui, { review: false });
    ui.$(button).click(); ui.input(input, input === "file-path" ? "new/proposed.py" : "Keep unsent notes\n雪");
    const before = capture(ui), contents = ui.$(dialog).innerHTML, value = ui.$(input).value;
    ui.w.location.hash = "#code/device"; await delay(25); unchanged(ui, before);
    assert.equal(ui.$(dialog).open, true); assert.equal(ui.$(dialog).innerHTML, contents); assert.equal(ui.$(input).value, value);
    assert.equal(ui.prompts.length, 1);
  });

for (const invalid of ["closed", "user", "org", "selected version", "hidden"]) test(`stale cloud-copy ${invalid} link is rejected before shared navigation confirmation`, async (t) => {
  const ui = await boot(t); await ui.open(); await dirty(ui); const link = ui.$("cloud-copy-inspect"), url = ui.w.location.href;
  if (invalid === "closed") ui.$("close-strategy-history").click();
  if (invalid === "user") ui.w.fixtureState.user = "another@example.test";
  if (invalid === "org") ui.w.fixtureState.org = "another-workspace";
  if (invalid === "selected version") ui.$("history-version").value = "missing";
  if (invalid === "hidden") link.hidden = true;
  let prevented;
  link.addEventListener("click", (event) => { prevented = event.defaultPrevented; });
  link.click(); await delay(20); assert.equal(prevented, true); assert.equal(ui.prompts.length, 0); assert.equal(ui.w.location.href, url);
});

test("a review response arriving after disconnect cannot restore private ownership or its old route", async (t) => {
  const pending = deferred(); let gets = 0;
  const ui = await boot(t, { handle: (call) => call.path === "/v1/me" && ++gets === 2 ? pending.promise : undefined });
  await ui.open(); await dirty(ui, { review: false }); await ui.history(); ui.$("review-cloud-copy").click();
  ui.w.fixture.forgetRememberedUser(); ui.w.location.hash = "#code/device";
  await until(() => !ui.$("view-code").hidden, "disconnected library"); pending.resolve(reply(me)); await settle();
  assert.equal(ui.w.fixtureState.user, null); assert.equal(ui.w.fixtureState.org, null); assert.equal(ui.w.fixtureState.project, null);
  assert.equal(ui.$("cloud-copy-details").textContent, ""); assert.equal(ui.$("cloud-copy-status").textContent, "");
  assert.equal(ui.$("strategy-history-dialog").open, false); assert.equal(ui.w.location.hash, "#code/device");
  assert.equal(ui.unload(), false); assert.equal(ui.prompts.length, 0);
});

test("exact reversion to saved source removes the unload warning even when draft removal fails", async (t) => {
  const ui = await boot(t); await ui.open(); await dirty(ui, { review: false }); assert.equal(ui.unload(), true);
  ui.shared.removeItem = () => { throw new Error("Read-only removal"); };
  ui.w.fixture.setDraftSnapshot({ files, entrypoint: "helpers/entry.py" });
  assert.equal(ui.w.fixtureState.project.draftStored, false); assert.equal(ui.unload(), false);
  ui.$("project-library-link").click(); await until(() => !ui.$("view-code").hidden, "safe saved-source departure");
  assert.equal(ui.prompts.length, 0);
});

// Independent review regressions: responses before the queued hashchange decision.
test("review lookup completing before hashchange survives cancelled navigation", async (t) => {
  const pending = deferred(); let gets = 0;
  const ui = await boot(t, {handle: (call) => call.path === "/v1/me" && ++gets === 2 ? pending.promise : undefined});
  await ui.open(); await dirty(ui, {review: false}); await ui.history(); ui.$("review-cloud-copy").click();
  const project = ui.w.fixtureState.project, review = ui.w.fixture.context().historyCloudCopy, originalURL = ui.w.location.href;
  ui.w.location.hash = "#code/device";
  pending.resolve(reply(me)); await settle();
  assert.equal(ui.w.location.hash, "#code/device", "Response settled before hashchange dispatch");
  await delay(30);
  assert.equal(ui.w.location.href, originalURL); assert.equal(ui.prompts.length,1);
  assert.equal(ui.w.fixtureState.project,project); assert.equal(ui.w.fixture.context().historyCloudCopy, review);
  assert.equal(ui.w.fixture.historyCurrent(),true); assert.deepEqual(plain(project.files),memoryFiles);
  assert.match(ui.$("cloud-copy-status").textContent, /Review every saved file/, "Owned response must not leave preserved review permanently loading");
});

test("successful reviewed copy completing before hashchange remains visible after cancellation", async (t) => {
  const pending = deferred(); let body;
  const ui = await boot(t, {handle: (call) => call.method === "POST" ? (body = call.body, pending.promise) : undefined});
  await ui.open(); await dirty(ui); ui.submit();
  const project = ui.w.fixtureState.project, review = ui.w.fixture.context().historyCloudCopy, originalURL = ui.w.location.href;
  ui.w.location.hash = "#code/device";
  pending.resolve(reply(created(body))); await settle();
  assert.equal(ui.w.location.hash, "#code/device", "Response settled before hashchange dispatch");
  await delay(30);
  assert.equal(ui.w.location.href, originalURL); assert.equal(ui.prompts.length,1);
  assert.equal(ui.w.fixtureState.project,project); assert.equal(ui.w.fixture.context().historyCloudCopy, review);
  assert.equal(ui.w.fixture.historyCurrent(),true); assert.deepEqual(plain(project.files),memoryFiles);
  assert.equal(ui.writes().length,1);
  assert.match(ui.$("cloud-copy-status").textContent, /created at saved v1/, "Confirmed success must be retained after cancelled route");
  assert.equal(ui.$("cloud-copy-result").hidden,false);
});

// A provisional destination must not grant new write authority before its decision.
test("unpersisted editor cannot start a new cloud-copy send while a different hash is pending", async (t) => {
  const ui = await boot(t); await ui.open(); await dirty(ui);
  const originalURL = ui.w.location.href;
  ui.w.location.hash = "#code/device"; ui.submit(); await settle();
  assert.deepEqual(ui.writes(), [], "No new upload before the route decision");
  await delay(30); assert.equal(ui.w.location.href, originalURL); assert.equal(ui.prompts.length,1);
  ui.submit(); await settle(); assert.equal(ui.writes().length,1, "A fresh explicit submit after Cancel remains allowed");
});

for (const actor of ["user", "org"]) test(`pending review cannot populate after ${actor} changes during provisional departure`, async (t) => {
  const pending = deferred(); let gets = 0;
  const ui = await boot(t, {handle: (call) => call.path === "/v1/me" && ++gets === 2 ? pending.promise : undefined});
  await ui.open(); await dirty(ui, {review:false}); await ui.history(); ui.$("review-cloud-copy").click();
  ui.w.location.hash = "#code/device";
  ui.w.fixtureState[actor] = null; pending.resolve(reply(me)); await settle();
  assert.equal(ui.$("confirm-cloud-copy").disabled, true); assert.equal(ui.$("cloud-copy-details").textContent, "");
  await delay(30);
  assert.equal(ui.w.location.hash,"#code/device"); assert.equal(ui.prompts.length,0);
  assert.equal(ui.w.fixtureState[actor],null); assert.equal(ui.w.fixtureState.project,null);
  assert.equal(ui.$("strategy-history-dialog").open,false); assert.deepEqual(ui.writes(),[]);
});

test("committed departure keeps a later review response stale", async (t) => {
  const pending = deferred(); let gets = 0;
  const ui = await boot(t, {handle: (call) => call.path === "/v1/me" && ++gets === 2 ? pending.promise : undefined});
  await ui.open(); await dirty(ui, {review:false}); await ui.history(); ui.$("review-cloud-copy").click();
  ui.accept(); ui.w.location.hash = "#code/device"; await delay(30);
  assert.equal(ui.w.fixtureState.project,null); assert.equal(ui.$("strategy-history-dialog").open,false);
  pending.resolve(reply(me)); await settle();
  assert.equal(ui.$("cloud-copy-details").textContent, ""); assert.equal(ui.$("confirm-cloud-copy").disabled,true);
  assert.equal(ui.w.location.hash,"#code/device"); assert.deepEqual(ui.writes(),[]);
});

test("response retained before an accepted departure never survives that route commit", async (t) => {
  const pending = deferred(); let gets = 0;
  const ui = await boot(t, {handle: (call) => call.path === "/v1/me" && ++gets === 2 ? pending.promise : undefined});
  await ui.open(); await dirty(ui, {review:false}); await ui.history(); ui.$("review-cloud-copy").click();
  ui.accept(); ui.w.location.hash = "#code/device";
  pending.resolve(reply(me)); await settle(); await delay(30);
  assert.equal(ui.w.fixtureState.project,null); assert.equal(ui.$("strategy-history-dialog").open,false);
  assert.equal(ui.$("cloud-copy-details").textContent, ""); assert.equal(ui.$("confirm-cloud-copy").disabled,true);
  assert.equal(ui.w.location.hash,"#code/device"); assert.deepEqual(ui.writes(),[]);
});

test("cloud History page completion can finish its saved-source read across cancelled provisional navigation", async (t) => {
  const pending = deferred();
  const version = {...created(inputProject()).latest_version, files, created_at:"2026-01-01T00:00:00Z"};
  const ui = await boot(t, {handle(call) {
    if(call.path === `/v1/projects/${cloudId}`) return reply({...inputProject(),id:cloudId,visibility:"private",versions:[version]});
    if(call.path === `/v1/projects/${cloudId}/versions/1`) return reply(version);
    if(call.path === `/v1/projects/${cloudId}/versions?limit=50`) return pending.promise;
  }});
  await ui.open(cloudId); await dirty(ui,{review:false}); ui.$("project-history").click();
  const originalURL = ui.w.location.href, project = ui.w.fixtureState.project;
  ui.w.location.hash="#code/device";
  pending.resolve(reply({versions:[version],total_count:1,has_more:false,next_before_version:null}));
  await settle(); await delay(30);
  assert.equal(ui.w.location.href,originalURL); assert.equal(ui.prompts.length,1); assert.equal(ui.w.fixtureState.project,project);
  assert.equal(ui.$("strategy-history-dialog").open,true); assert.equal(ui.w.fixture.historyCurrent(),true);
  assert.equal(ui.$("history-snapshot").hidden,false,"History's already-started page load must finish selecting its source");
  assert.match(ui.$("history-version-status").textContent,/Viewing saved v1/); assert.deepEqual(ui.writes(),[]);
});

const savedCloudVersion = { ...created(inputProject()).latest_version, files, created_at: "2026-01-01T00:00:00Z" };
const savedCloudProject = { ...inputProject(), id: cloudId, visibility: "private", versions: [savedCloudVersion] };
function cloudRead(call) {
  if (call.path === `/v1/projects/${cloudId}` && call.method === "GET") return reply(savedCloudProject);
  if (call.path === `/v1/projects/${cloudId}/versions/1`) return reply(savedCloudVersion);
}
const submitForm = (ui, id) => ui.$(id).dispatchEvent(new ui.w.Event("submit", { bubbles: true, cancelable: true }));

for (const outcome of ["success", "error"]) test(`settings ${outcome} arriving during provisional navigation updates its retained review without another write`, async (t) => {
  const pending = deferred();
  const ui = await boot(t, { handle: (call) => call.method === "PATCH" ? pending.promise : cloudRead(call) });
  await ui.open(cloudId); await dirty(ui, { review: false }); ui.$("project-settings").click(); ui.input("settings-name", "Reviewed new name");
  submitForm(ui, "strategy-settings-form"); const project = ui.w.fixtureState.project, url = ui.w.location.href;
  ui.w.location.hash = "#code/device";
  pending.resolve(outcome === "success" ? reply({ ...savedCloudProject, name: "Reviewed new name" }) : reply({ detail: "Settings unavailable" }, 409));
  await settle(); assert.equal(ui.w.location.hash, "#code/device"); await delay(25);
  assert.equal(ui.w.location.href, url); assert.equal(ui.w.fixtureState.project, project); assert.deepEqual(plain(project.files), memoryFiles);
  assert.equal(ui.writes().length, 1); assert.equal(ui.prompts.length, 1);
  if (outcome === "success") { assert.equal(project.name, "Reviewed new name"); assert.equal(ui.$("strategy-settings-dialog").open, false); }
  else { assert.match(ui.$("settings-status").textContent, /Settings unavailable/); assert.equal(ui.$("strategy-settings-form").querySelector("button[type=submit]").disabled, false); }
});

test("queued settings write remains blocked during provisional departure and requires a fresh explicit save", async (t) => {
  const pending = deferred(); let writes = 0;
  const ui = await boot(t, { handle(call) {
    if (call.method === "PATCH") return ++writes === 1 ? pending.promise : reply({ ...savedCloudProject, ...call.body });
    return cloudRead(call);
  } });
  await ui.open(cloudId); await dirty(ui, { review: false }); ui.$("project-settings").click(); ui.input("settings-name", "First write");
  submitForm(ui, "strategy-settings-form"); ui.$("close-strategy-settings").click(); ui.$("project-settings").click();
  ui.input("settings-name", "Queued write"); submitForm(ui, "strategy-settings-form");
  ui.w.location.hash = "#code/device"; pending.resolve(reply({ ...savedCloudProject, name: "First write" })); await settle();
  assert.equal(ui.writes().length, 1, "The completion cannot authorize the queued mutation while raw hash is away");
  await delay(25); assert.equal(ui.$("strategy-settings-dialog").open, true);
  assert.match(ui.$("settings-status").textContent, /not saved.*navigation was pending/);
  assert.equal(ui.$("strategy-settings-form").querySelector("button[type=submit]").disabled, false);
  assert.equal(ui.$("settings-name").value, "Queued write"); assert.equal(ui.writes().length, 1);
  submitForm(ui, "strategy-settings-form"); await settle(); assert.equal(ui.writes().length, 2); assert.equal(ui.$("project-title").textContent, "Queued write");
});

for (const actor of [null, "user", "org"]) test(`Share read completion across provisional navigation ${actor ? `rejects changed ${actor}` : "finishes its retained source preview"}`, async (t) => {
  const pending = deferred();
  const ui = await boot(t, { handle(call) {
    if (call.path === `/v1/projects/${cloudId}/publications?limit=20`) return pending.promise;
    return cloudRead(call);
  } });
  await ui.open(cloudId); await dirty(ui, { review: false }); ui.$("share-project").click(); const url = ui.w.location.href;
  ui.w.location.hash = "#code/device"; if (actor) ui.w.fixtureState[actor] = null;
  pending.resolve(reply({ publications: [], has_more: false, next_cursor: null })); await settle();
  if (actor) {
    assert.equal(ui.$("share-snapshot").hidden, true); assert.equal(ui.$("share-source").textContent, "");
    assert.equal(ui.calls.filter((call) => call.path === `/v1/projects/${cloudId}/versions/1`).length, 1, "No old-actor chained read");
  }
  await delay(25); assert.deepEqual(ui.writes(), []);
  if (actor) { assert.equal(ui.w.fixtureState.project, null); assert.equal(ui.$("share-dialog").open, false); }
  else {
    assert.equal(ui.w.location.href, url); assert.equal(ui.$("share-dialog").open, true); assert.equal(ui.$("share-snapshot").hidden, false);
    assert.match(ui.$("share-version-status").textContent, /Pinned saved v1/); assert.equal(ui.$("share-source").textContent, files["helpers/entry.py"]);
    assert.deepEqual(plain(ui.w.fixtureState.project.files), memoryFiles);
  }
});

test("Share cannot start publication while the raw hash is provisionally away", async (t) => {
  const ui = await boot(t, { handle(call) {
    if (call.path === `/v1/projects/${cloudId}/publications?limit=20`) return reply({ publications: [], has_more: false, next_cursor: null });
    return cloudRead(call);
  } });
  await ui.open(cloudId); await dirty(ui, { review: false }); ui.$("share-project").click();
  await until(() => !ui.$("share-snapshot").hidden, "saved source preview");
  ui.input("share-public-title", "Deliberately reviewed title"); ui.$("share-consent").checked = true;
  ui.$("share-consent").dispatchEvent(new ui.w.Event("change"));
  ui.w.location.hash = "#code/device"; submitForm(ui, "share-form"); await settle(); assert.deepEqual(ui.writes(), []);
  await delay(25); assert.equal(ui.$("share-dialog").open, true); assert.equal(ui.$("share-consent").checked, true); assert.deepEqual(ui.writes(), []);
});

test("quote response cleanup survives cancellation without restoring a quote for changed code", async (t) => {
  const pending = deferred();
  const ui = await boot(t, { handle: (call) => call.path === "/v1/quotes" ? pending.promise : cloudRead(call) });
  await ui.open(cloudId); submitForm(ui, "quote-form");
  await until(() => ui.writes().length === 1, "in-flight quote fixture");
  await dirty(ui, { review: false }); const button = ui.$("quote-form").querySelector("button[type=submit]");
  assert.equal(button.disabled, true); ui.w.location.hash = "#code/device";
  pending.resolve(reply({ id: "old-quote", customer_max_nano: 1, estimate: { customer_expected_nano: 1 } }));
  await settle(); await delay(25); assert.equal(button.disabled, false); assert.equal(ui.w.fixtureState.quote, null);
  assert.equal(ui.$("quote-box").hidden, true); assert.equal(ui.$("approve").disabled, true); assert.equal(ui.writes().length, 1);
});

test("queued device settings cannot write during provisional navigation and its retained controls recover", async (t) => {
  const ui = await boot(t); await ui.open(); await dirty(ui, { review: false });
  ui.$("project-settings").click(); ui.input("settings-name", "Queued changed name");
  const url = ui.w.location.href, name = ui.w.fixtureState.project.name, storage = ui.shared.snapshot();
  submitForm(ui, "strategy-settings-form"); ui.w.location.hash = "#code/device"; await settle(); await delay(25);
  assert.equal(ui.w.location.href, url); assert.equal(ui.w.fixtureState.project.name, name);
  assert.equal(ui.$("strategy-settings-dialog").open, true); assert.equal(ui.$("settings-name").disabled, false);
  assert.equal(ui.$("settings-name").value, "Queued changed name"); assert.deepEqual(ui.shared.snapshot(), storage);
  assert.match(ui.$("settings-status").textContent, /not saved.*navigation/); assert.deepEqual(ui.writes(), []);
});

for (const actor of ["user", "org"]) test(`Share response on an unchanged URL still rejects a changed ${actor}`, async (t) => {
  const pending = deferred();
  const ui = await boot(t, { handle(call) {
    if (call.path === `/v1/projects/${cloudId}/publications?limit=20`) return pending.promise;
    return cloudRead(call);
  } });
  await ui.open(cloudId); await dirty(ui, { review: false }); ui.$("share-project").click(); const url = ui.w.location.href;
  ui.w.fixtureState[actor] = null; pending.resolve(reply({ publications: [], has_more: false, next_cursor: null })); await settle();
  assert.equal(ui.w.location.href, url); assert.equal(ui.$("share-form").hidden, true); assert.equal(ui.$("share-snapshot").hidden, true);
  assert.equal(ui.$("share-source").textContent, ""); assert.deepEqual(ui.writes(), []);
  assert.equal(ui.calls.filter((call) => call.path === `/v1/projects/${cloudId}/versions/1`).length, 1);
});

for (const outcome of ["rejected", "unknown"]) test(`cloud-copy ${outcome} response during provisional navigation is retained without replay`, async (t) => {
  const pending = deferred();
  const ui = await boot(t, { handle: (call) => call.method === "POST" ? pending.promise : undefined });
  await ui.open(); await dirty(ui); ui.submit(); ui.w.location.hash = "#code/device";
  if (outcome === "unknown") pending.reject(new Error("Lost response"));
  else pending.resolve(reply({ detail: "Already exists" }, 409));
  await settle(); await delay(25);
  assert.match(ui.$("cloud-copy-status").textContent, outcome === "unknown" ? /Copy outcome unknown/ : /Copy not created.*Already exists/);
  assert.equal(ui.$("cloud-copy-checked").hidden, outcome !== "unknown");
  assert.deepEqual(plain(ui.w.fixtureState.project.files), memoryFiles); assert.equal(ui.writes().length, 1); assert.equal(ui.prompts.length, 1);
});

for (const operation of ["publish", "revoke"]) test(`already-sent ${operation} response remains visible after cancelled navigation without an automatic retry`, async (t) => {
  const pending = deferred();
  const receipt = { id: "60000000-0000-4000-8000-000000000001", project_version_id: savedCloudVersion.id, version_no: 1,
    title: "Reviewed title", description: "", published_at: savedCloudVersion.created_at, content_hash: savedCloudVersion.content_hash,
    entrypoint: savedCloudVersion.entrypoint, status: "published", revoked_at: null };
  const ui = await boot(t, { handle(call) {
    if (call.path === `/v1/projects/${cloudId}/publications?limit=20`) return reply({ publications: operation === "revoke" ? [receipt] : [], has_more: false, next_cursor: null });
    if (call.method === "POST" || call.method === "DELETE") return pending.promise;
    return cloudRead(call);
  } });
  await ui.open(cloudId); await dirty(ui, { review: false }); ui.$("share-project").click();
  await until(() => !ui.$("share-snapshot").hidden, "saved source preview");
  if (operation === "publish") {
    ui.input("share-public-title", receipt.title); ui.$("share-consent").checked = true;
    ui.$("share-consent").dispatchEvent(new ui.w.Event("change")); submitForm(ui, "share-form");
  } else { ui.w.document.querySelector("[data-revoke]").click(); ui.w.document.querySelector("[data-confirm-revoke]").click(); }
  assert.equal(ui.writes().length, 1); ui.w.location.hash = "#code/device";
  pending.resolve(reply(operation === "publish" ? receipt : { ...receipt, status: "revoked", revoked_at: "2026-01-02T00:00:00Z" }));
  await settle(); await delay(25);
  assert.equal(ui.$("share-dialog").open, true); assert.deepEqual(plain(ui.w.fixtureState.project.files), memoryFiles);
  assert.match(ui.$(operation === "publish" ? "share-status" : "share-history-status").textContent, operation === "publish" ? /Snapshot published/ : /Link revoked/);
  assert.equal(ui.writes().length, 1); assert.equal(ui.prompts.length, 1);
});
