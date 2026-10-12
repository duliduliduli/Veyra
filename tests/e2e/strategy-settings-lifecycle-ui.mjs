// Offline synthetic settings ownership checks; no browser, server, database or real requests.
// NODE_PATH=/path/to/jsdom/node_modules node --test tests/e2e/strategy-settings-lifecycle-ui.mjs
// shortcut: native dialog focus and visual layout need separately authorized browser QA.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "chart-tools.js", "workspace-store.js", "studio-assistant.js", "report-evidence.js", "proposal-diff.js", "strategy-backup.js", "saved-links.js", "app.js"]
  .map((name) => readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
const plain = (value) => JSON.parse(JSON.stringify(value));
const reply = (value, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => plain(value) });
const files = { "strategy.py": "# inert exact source\r\n", "helpers/empty.py": "" };
const project = (id) => ({ id, name: `Strategy ${id}`, description: "Private notes", folder: "Research", visibility: "private",
  latest_version_no: 1, versions: [{ id: `${id}-v1`, project_id: id, version_no: 1, files, entrypoint: "strategy.py" }] });
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function until(condition, label) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail(`Timed out waiting for ${label}`);
}
async function microtasks() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function boot(t, { local = false, handle, lock } = {}) {
  const errors = [], calls = [], queuedCloses = [], locks = [], virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: "https://veyra.test/#code", runScripts: "outside-only", virtualConsole });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  t.after(() => { w.close(); assert.deepEqual(errors, [], "No uncaught DOM errors or unexpected fake requests"); });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  // Queue native close events independently from the synchronous open=false change.
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.open = false; queuedCloses.push(() => this.dispatchEvent(new w.Event("close")));
  };
  if (lock !== null) Object.defineProperty(w.navigator, "locks", { value: { request(name, options, operation) {
    locks.push({ name, ...options }); return lock ? lock(operation) : Promise.resolve().then(operation);
  } } });
  if (!local) w.localStorage.setItem("veyra.user", "fixture-user");
  w.fetch = async (path, options = {}) => {
    const call = { path: String(path), method: options.method || "GET", headers: options.headers,
      body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (path === "/v1/me") return reply({ organizations: [{ id: "fixture-org" }] });
    if (path === "/v1/catalog/datasets") return reply({ datasets: [] });
    if (path === "/v1/orgs/fixture-org/billing/balance") return reply({ available_nano: 0 });
    const result = await handle?.(call);
    if (result !== undefined) return result;
    if (path === "/v1/orgs/fixture-org/projects") return reply({ projects: [project("a"), project("b")], next_cursor: null, has_more: false });
    for (const id of ["a", "b"]) {
      if (path === `/v1/projects/${id}` && call.method === "GET") return reply(project(id));
      if (path === `/v1/projects/${id}/versions/1`) return reply(project(id).versions[0]);
    }
    errors.push(`Unexpected fake request: ${call.method} ${path}`);
    return reply({ detail: "Unexpected fake request" }, 500);
  };
  scripts.slice(0, -1).forEach((script) => w.eval(script));
  const store = w.VeyraWorkspaceStore.create(w.localStorage);
  const seeded = local ? store.createProject({ name: "Device strategy", description: "Private notes", folder: "Research", files, entrypoint: "strategy.py" }) : null;
  // State is exposed only inside this isolated fixture to simulate account changes without real authentication.
  w.eval(`${scripts.at(-1)}\nwindow.fixtureState = state;`);
  await until(() => !$("view-code").hidden && $("workspace-mode").textContent, "Studio boot");
  async function navigate(hash) { w.location.hash = hash; await delay(10); }
  async function open(id = seeded?.id || "a") {
    await navigate(`#project/${id}`);
    await until(() => !$("editor").disabled && $("project-title").textContent !== "Loading strategy…", "editor");
  }
  const input = (id, value) => { $(id).value = value; $(id).dispatchEvent(new w.Event("input", { bubbles: true })); };
  const form = $("strategy-settings-form"), save = form.querySelector("button[type=submit]"), dialog = $("strategy-settings-dialog");
  const submit = (submitter = save) => form.dispatchEvent(new w.SubmitEvent("submit", { cancelable: true, bubbles: true, submitter }));
  const settings = () => $("project-settings").click();
  const close = () => $("close-strategy-settings").click();
  const flushCloses = () => { for (const event of queuedCloses.splice(0)) event(); };
  const writes = () => calls.filter((call) => call.method === "PATCH");
  return { w, $, calls, store, seeded, locks, form, save, dialog, submit, settings, close, flushCloses, writes, open, navigate, input };
}

test("a delayed save dismissed and reopened on the same project cannot close or rename the new settings visit", async (t) => {
  const pending = deferred(), ui = await boot(t, { handle: (call) => call.method === "PATCH" ? pending.promise : undefined });
  await ui.open(); ui.settings(); ui.input("settings-name", "Old request"); ui.submit();
  ui.close(); ui.settings(); ui.input("settings-name", "New unsaved edit");
  pending.resolve(reply({ ...project("a"), name: "Old request" })); await microtasks();
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.$("settings-name").value, "New unsaved edit");
  assert.equal(ui.$("project-title").textContent, "Strategy a");
  assert.doesNotMatch(ui.$("status").textContent, /settings saved/);
});

test("a reopened settings visit can save immediately and owns its button until its own request ends", async (t) => {
  const older = deferred(), newer = deferred(); let writes = 0;
  const ui = await boot(t, { handle: (call) => call.method === "PATCH" ? (++writes === 1 ? older.promise : newer.promise) : undefined });
  await ui.open(); ui.settings(); ui.input("settings-name", "Old request"); ui.submit();
  ui.close(); ui.settings();
  assert.equal(ui.save.disabled, false, "The old request must not keep the reopened Save disabled");
  ui.input("settings-name", "New request"); ui.submit();
  assert.equal(ui.writes().length, 1, "The new write waits for the old write to settle");
  assert.match(ui.$("settings-status").textContent, /Waiting for the earlier/);
  older.resolve(reply({ ...project("a"), name: "Old request" })); await microtasks();
  assert.equal(ui.save.disabled, true, "The old request must not enable a newer in-flight Save");
  assert.equal(ui.dialog.open, true);
  newer.resolve(reply({ ...project("a"), name: "New request" })); await microtasks();
  assert.equal(ui.dialog.open, false);
  assert.equal(ui.$("project-title").textContent, "New request");
  assert.equal(ui.writes().length, 2);
});

test("stale errors after dismiss, reopen or route changes never replace current status", async (t) => {
  for (const next of ["dismiss", "reopen", "#code", "#project/b", "revisit"]) {
    const pending = deferred(), ui = await boot(t, { handle: (call) => call.method === "PATCH" ? pending.promise : undefined });
    await ui.open(); ui.settings(); ui.submit();
    if (next.startsWith("#")) await ui.navigate(next);
    else if (next === "revisit") { await ui.navigate("#code"); await ui.open(); ui.settings(); }
    else { ui.close(); if (next === "reopen") ui.settings(); }
    ui.$("status").textContent = "Current status";
    pending.resolve(reply({ detail: "OLD SAVE FAILURE" }, 503)); await microtasks();
    assert.equal(ui.$("status").textContent, "Current status", next);
  }
});

test("duplicate and repeated-open events cannot duplicate a pending save or reset typed metadata", async (t) => {
  const pending = deferred(), ui = await boot(t, { handle: (call) => call.method === "PATCH" ? pending.promise : undefined });
  await ui.open(); ui.settings(); ui.input("settings-name", "Reviewed name"); ui.submit();
  ui.submit(); ui.settings();
  assert.equal(ui.writes().length, 1);
  assert.equal(ui.$("settings-name").value, "Reviewed name");
  assert.equal(ui.save.disabled, true);
  pending.resolve(reply({ ...project("a"), name: "Reviewed name" })); await microtasks();
});

test("route changes before hashchange delivery reject stale settings opens, submits and save completions", async (t) => {
  const pending = deferred(), ui = await boot(t, { handle: (call) => call.method === "PATCH" ? pending.promise : undefined });
  await ui.open(); ui.settings(); ui.input("settings-name", "Stale name"); ui.submit();
  ui.w.location.hash = "#code";
  pending.resolve(reply({ ...project("a"), name: "Stale name" })); await microtasks();
  assert.equal(ui.$("project-title").textContent, "Strategy a");
  assert.doesNotMatch(ui.$("status").textContent, /settings saved/);
  ui.close(); ui.settings(); ui.submit();
  assert.equal(ui.dialog.open, false);
  assert.equal(ui.writes().length, 1);
});

test("account and organization changes invalidate old settings submissions and completions", async (t) => {
  for (const field of ["user", "org"]) {
    const pending = deferred(), ui = await boot(t, { handle: (call) => call.method === "PATCH" ? pending.promise : undefined });
    await ui.open(); ui.settings(); ui.input("settings-name", "Old identity save"); ui.submit();
    ui.w.fixtureState[field] = "different-fixture-identity";
    ui.$("status").textContent = "Account changed";
    ui.submit();
    pending.resolve(reply({ ...project("a"), name: "Old identity save" })); await microtasks();
    assert.equal(ui.$("project-title").textContent, "Strategy a", field);
    assert.equal(ui.$("status").textContent, "Account changed", field);
    assert.equal(ui.writes().length, 1, field);
  }
});

test("queued close events from a dismissed visit cannot invalidate a reopened pending save", async (t) => {
  const pending = deferred(), ui = await boot(t, { handle: (call) => call.method === "PATCH" ? pending.promise : undefined });
  await ui.open(); ui.settings(); ui.close(); ui.settings();
  ui.input("settings-name", "Current save"); ui.submit(); ui.flushCloses();
  assert.equal(ui.dialog.open, true); assert.equal(ui.save.disabled, true);
  pending.resolve(reply({ ...project("a"), name: "Current save" })); await microtasks();
  assert.equal(ui.$("project-title").textContent, "Current save"); assert.equal(ui.dialog.open, false);
});

test("Escape dismisses synchronously and a delayed completion remains obsolete on immediate reopen", async (t) => {
  const pending = deferred(), ui = await boot(t, { handle: (call) => call.method === "PATCH" ? pending.promise : undefined });
  await ui.open(); ui.settings(); ui.submit();
  const event = new ui.w.Event("cancel", { cancelable: true });
  if (ui.dialog.dispatchEvent(event)) ui.dialog.close();
  assert.equal(ui.dialog.open, false); ui.settings();
  pending.resolve(reply({ ...project("a"), name: "Stale cancelled save" })); await microtasks();
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.$("project-title").textContent, "Strategy a");
});

test("hidden or closed settings cannot submit a write", async (t) => {
  const ui = await boot(t, { handle: (call) => call.method === "PATCH" ? reply(project("a")) : undefined });
  await ui.open(); ui.settings(); ui.close(); ui.submit(); await microtasks();
  assert.equal(ui.writes().length, 0);
});

test("a current cloud save sends metadata only, uses existing authentication and preserves exact saved and draft source", async (t) => {
  const pending = deferred(), ui = await boot(t, { handle: (call) => call.method === "PATCH" ? pending.promise : undefined });
  await ui.open(); ui.input("editor", "# unsaved exact source\n");
  const before = plain(ui.w.fixtureState.project), stored = ui.w.localStorage.getItem(before.draftKey);
  ui.settings(); ui.input("settings-name", "Reviewed name"); ui.input("settings-description", "Reviewed notes"); ui.input("settings-folder", "");
  ui.submit(null);
  assert.equal(ui.writes().length, 1, "Submit works when the browser supplies no submitter");
  assert.deepEqual(ui.writes()[0].body, { name: "Reviewed name", description: "Reviewed notes", folder: null });
  assert.equal(ui.writes()[0].headers["x-veyra-dev-user"], "fixture-user");
  assert.ok([...ui.form.querySelectorAll("input, textarea, button[type=submit]")].every((control) => control.disabled));
  assert.equal(ui.$("close-strategy-settings").disabled, false, "Dismiss stays available");
  assert.equal(ui.$("settings-status").textContent, "Saving settings…");
  pending.resolve(reply({ ...project("a"), name: "Reviewed name", description: "Reviewed notes", folder: null,
    files: { "other.py": "# must not replace source" }, entrypoint: "other.py", visibility: "public" })); await microtasks();
  const after = plain(ui.w.fixtureState.project);
  assert.deepEqual(after, { ...before, name: "Reviewed name", description: "Reviewed notes", folder: null });
  assert.equal(ui.w.localStorage.getItem(before.draftKey), stored);
  assert.equal(ui.$("editor").value, "# unsaved exact source\n");
  assert.equal(ui.$("project-title").textContent, "Reviewed name");
  assert.equal(ui.dialog.open, false); assert.match(ui.$("status").textContent, /settings saved/);
  assert.deepEqual(ui.locks, []);
});

test("a current save error stays in its dialog, preserves values and permits exactly one clean retry", async (t) => {
  const first = deferred(), retry = deferred(); let writes = 0;
  const ui = await boot(t, { handle: (call) => call.method === "PATCH" ? (++writes === 1 ? first.promise : retry.promise) : undefined });
  await ui.open(); ui.settings(); ui.input("settings-name", "Needs retry"); ui.submit();
  first.resolve(reply({ detail: "Synthetic metadata rejection" }, 422)); await microtasks();
  assert.equal(ui.dialog.open, true); assert.equal(ui.$("settings-name").value, "Needs retry");
  assert.equal(ui.$("settings-status").textContent, "Synthetic metadata rejection");
  assert.equal(ui.$("settings-status").getAttribute("role"), "status");
  assert.ok([...ui.form.querySelectorAll("input, textarea, button[type=submit]")].every((control) => !control.disabled));
  assert.equal(ui.$("project-title").textContent, "Strategy a");
  ui.input("settings-name", "Corrected name"); ui.submit(); ui.submit();
  assert.equal(ui.writes().length, 2); assert.equal(ui.$("settings-status").textContent, "Saving settings…");
  retry.resolve(reply({ ...project("a"), name: "Corrected name" })); await microtasks();
  assert.equal(ui.$("project-title").textContent, "Corrected name"); assert.equal(ui.dialog.open, false);
  ui.settings(); ui.flushCloses();
  assert.equal(ui.dialog.open, true); assert.equal(ui.save.disabled, false); assert.equal(ui.$("settings-status").textContent, "");
  assert.equal(ui.$("settings-name").value, "Corrected name");
});

test("an older failure cannot replace a newer visit's pending status or enable its controls", async (t) => {
  const older = deferred(), newer = deferred(); let writes = 0;
  const ui = await boot(t, { handle: (call) => call.method === "PATCH" ? (++writes === 1 ? older.promise : newer.promise) : undefined });
  await ui.open(); ui.settings(); ui.submit(); ui.close(); ui.settings(); ui.submit();
  older.resolve(reply({ detail: "Obsolete failure" }, 422)); await microtasks();
  assert.equal(ui.$("settings-status").textContent, "Saving settings…");
  assert.ok([...ui.form.querySelectorAll("input, textarea, button[type=submit]")].every((control) => control.disabled));
  newer.resolve(reply({ detail: "Current failure" }, 422)); await microtasks();
  assert.equal(ui.$("settings-status").textContent, "Current failure"); assert.equal(ui.save.disabled, false);
});

test("leaving and revisiting the same project gives settings a new owner", async (t) => {
  const pending = deferred(), ui = await boot(t, { handle: (call) => call.method === "PATCH" ? pending.promise : undefined });
  await ui.open(); ui.settings(); ui.submit();
  await ui.navigate("#code"); assert.equal(ui.dialog.open, false);
  await ui.open(); ui.settings(); ui.input("settings-name", "Revisited edit"); ui.flushCloses();
  pending.resolve(reply({ ...project("a"), name: "Previous visit" })); await microtasks();
  assert.equal(ui.dialog.open, true); assert.equal(ui.save.disabled, false);
  assert.equal(ui.$("project-title").textContent, "Strategy a"); assert.equal(ui.$("settings-name").value, "Revisited edit");
});

test("changed account or organization prevents an unsubmitted stale dialog from writing", async (t) => {
  for (const field of ["user", "org"]) {
    const ui = await boot(t, { handle: (call) => call.method === "PATCH" ? reply(project("a")) : undefined });
    await ui.open(); ui.settings(); ui.w.fixtureState[field] = null; ui.submit(); await microtasks();
    assert.equal(ui.writes().length, 0, field);
  }
});

test("device settings retain exclusive locks, metadata validation, privacy and all saved source", async (t) => {
  const ui = await boot(t, { local: true });
  await ui.open();
  const before = plain(ui.store.getProject(ui.seeded.id));
  ui.settings(); ui.input("settings-folder", "nested/folder"); ui.submit(); await microtasks();
  assert.equal(ui.dialog.open, true); assert.equal(ui.save.disabled, false);
  assert.match(ui.$("settings-status").textContent, /Folder/);
  assert.deepEqual(plain(ui.store.getProject(ui.seeded.id)), before);
  ui.input("settings-name", "Renamed device strategy"); ui.input("settings-folder", "Checked folder"); ui.submit(); await microtasks();
  const after = plain(ui.store.getProject(ui.seeded.id));
  assert.equal(after.name, "Renamed device strategy"); assert.equal(after.folder, "Checked folder");
  assert.equal(after.visibility, "private"); assert.deepEqual(after.versions, before.versions);
  assert.equal(after.latest_version_no, 1);
  assert.deepEqual(ui.locks, [1, 2].map(() => ({ name: "veyra.workspace.v1", mode: "exclusive" })));
  assert.deepEqual(ui.calls.map(({ path }) => path), ["/v1/catalog/datasets"]);
});

test("device settings without Web Locks fail closed and retain inputs for recovery", async (t) => {
  const ui = await boot(t, { local: true, lock: null });
  await ui.open(); const before = plain(ui.store.getProject(ui.seeded.id));
  ui.settings(); ui.input("settings-name", "Must not save"); ui.submit(); await microtasks();
  assert.match(ui.$("settings-status").textContent, /Web Locks/);
  assert.equal(ui.dialog.open, true); assert.equal(ui.save.disabled, false);
  assert.equal(ui.$("settings-name").value, "Must not save");
  assert.deepEqual(plain(ui.store.getProject(ui.seeded.id)), before);
  assert.deepEqual(ui.calls.map(({ path }) => path), ["/v1/catalog/datasets"]);
});

test("closing a queued device save cancels its write without affecting the reopened dialog", async (t) => {
  const gate = deferred();
  const ui = await boot(t, { local: true, lock: (operation) => gate.promise.then(operation) });
  await ui.open(); ui.settings(); ui.input("settings-name", "Accepted device save"); ui.submit();
  ui.close(); ui.settings(); ui.input("settings-name", "New unsubmitted edit"); ui.flushCloses();
  gate.resolve(); await microtasks();
  assert.equal(ui.store.getProject(ui.seeded.id).name, "Device strategy");
  assert.equal(ui.dialog.open, true); assert.equal(ui.save.disabled, false);
  assert.equal(ui.$("settings-name").value, "New unsubmitted edit");
  assert.equal(ui.$("project-title").textContent, "Device strategy");
  assert.deepEqual(plain(ui.store.getVersion(ui.seeded.id, 1).files), files);
  assert.deepEqual(ui.calls.map(({ path }) => path), ["/v1/catalog/datasets"]);
});

test("a cloud save queued behind a previous visit is discarded on dismissal, navigation or account change", async (t) => {
  for (const change of ["close", "cancel", "route", "user", "org"]) {
    const first = deferred(), ui = await boot(t, { handle: (call) => call.method === "PATCH" ? first.promise : undefined });
    await ui.open(); ui.settings(); ui.input("settings-name", "Already sent"); ui.submit();
    ui.close(); ui.settings(); ui.input("settings-name", "Must stay queued"); ui.submit();
    assert.equal(ui.writes().length, 1);
    if (change === "close") ui.close();
    else if (change === "cancel") ui.dialog.dispatchEvent(new ui.w.Event("cancel", { cancelable: true }));
    else if (change === "route") ui.w.location.hash = "#code";
    else ui.w.fixtureState[change] = "new-fixture-identity";
    first.resolve(reply({ ...project("a"), name: "Already sent" })); await microtasks();
    assert.equal(ui.writes().length, 1, change);
    assert.equal(ui.$("project-title").textContent, "Strategy a", change);
  }
});

test("device writes queued on a lock recheck route and account ownership before mutating storage", async (t) => {
  for (const change of ["route", "user", "org"]) {
    const gate = deferred(), ui = await boot(t, { local: true, lock: (operation) => gate.promise.then(operation) });
    await ui.open(); const before = plain(ui.store.getProject(ui.seeded.id));
    ui.settings(); ui.input("settings-name", "Stale queued metadata"); ui.submit();
    if (change === "route") ui.w.location.hash = "#code";
    else ui.w.fixtureState[change] = "different-fixture-identity";
    gate.resolve(); await microtasks();
    assert.deepEqual(plain(ui.store.getProject(ui.seeded.id)), before, change);
    assert.deepEqual(ui.calls.map(({ path }) => path), ["/v1/catalog/datasets"]);
  }
});

test("multiple same-project visits serialize writes and skip dismissed intermediate saves", async (t) => {
  const first = deferred(), last = deferred(); let writes = 0;
  const ui = await boot(t, { handle: (call) => call.method === "PATCH" ? (++writes === 1 ? first.promise : last.promise) : undefined });
  await ui.open(); ui.settings(); ui.input("settings-name", "First"); ui.submit();
  ui.close(); ui.settings(); ui.input("settings-name", "Discarded middle"); ui.submit();
  ui.close(); ui.settings(); ui.input("settings-name", "Last"); ui.submit(); ui.flushCloses();
  assert.equal(ui.writes().length, 1);
  first.resolve(reply({ ...project("a"), name: "First" })); await microtasks();
  assert.deepEqual(ui.writes().map((call) => call.body.name), ["First", "Last"]);
  assert.equal(ui.save.disabled, true); assert.equal(ui.dialog.open, true);
  assert.equal(ui.$("settings-name").value, "Last");
  last.resolve(reply({ ...project("a"), name: "Last" })); await microtasks();
  assert.equal(ui.$("project-title").textContent, "Last"); assert.equal(ui.dialog.open, false);
});

test("different-project saves do not block one another or share control ownership", async (t) => {
  const a = deferred(), b = deferred();
  const ui = await boot(t, { handle: (call) => call.method === "PATCH" ? (call.path.endsWith("/a") ? a.promise : b.promise) : undefined });
  await ui.open(); ui.settings(); ui.input("settings-name", "Updated A"); ui.submit();
  await ui.open("b"); ui.settings(); ui.input("settings-name", "Updated B"); ui.submit();
  assert.deepEqual(ui.writes().map((call) => call.path), ["/v1/projects/a", "/v1/projects/b"]);
  a.resolve(reply({ ...project("a"), name: "Updated A" })); await microtasks();
  assert.equal(ui.$("project-title").textContent, "Strategy b");
  assert.equal(ui.dialog.open, true); assert.equal(ui.save.disabled, true);
  b.resolve(reply({ ...project("b"), name: "Updated B" })); await microtasks();
  assert.equal(ui.$("project-title").textContent, "Updated B"); assert.equal(ui.dialog.open, false);
});

test("native name constraints and device name conflicts retain the original metadata", async (t) => {
  const ui = await boot(t, { local: true });
  await ui.open(); const before = plain(ui.store.getProject(ui.seeded.id));
  ui.store.createProject({ name: "Taken name", files, entrypoint: "strategy.py" });
  ui.settings(); ui.input("settings-name", ""); ui.save.click(); await microtasks();
  assert.equal(ui.locks.length, 0, "Native required-name validation prevents submitting");
  assert.equal(ui.$("settings-name").maxLength, 120); assert.equal(ui.$("settings-description").maxLength, 2000);
  assert.equal(ui.$("settings-folder").maxLength, 80);
  ui.input("settings-name", "Taken name"); ui.submit(); await microtasks();
  assert.match(ui.$("settings-status").textContent, /already exists/);
  assert.equal(ui.save.disabled, false); assert.equal(ui.dialog.open, true);
  assert.deepEqual(plain(ui.store.getProject(ui.seeded.id)), before);
});


test("an ambiguous cloud result blocks automatic queued writes and requires a separate explicit retry", async (t) => {
  for (const outcome of ["network", 408, 503]) {
    const first = deferred(), retry = deferred(); let writes = 0;
    const ui = await boot(t, { handle: (call) => call.method === "PATCH" ? (++writes === 1 ? first.promise : retry.promise) : undefined });
    await ui.open(); ui.settings(); ui.input("settings-name", "Unconfirmed first save"); ui.submit();
    ui.close(); ui.settings(); ui.input("settings-name", "Latest queued values"); ui.submit();
    if (outcome === "network") first.reject(new TypeError("Synthetic connection lost"));
    else first.resolve(reply({ detail: "Synthetic ambiguous response" }, outcome));
    await microtasks();
    assert.equal(ui.writes().length, 1, String(outcome));
    assert.equal(ui.dialog.open, true); assert.equal(ui.save.disabled, false);
    assert.equal(ui.$("settings-name").value, "Latest queued values");
    assert.match(ui.$("settings-status").textContent, /outcome unknown.*server may still finish.*queued save was not sent.*retry could race/);
    assert.equal(ui.$("project-title").textContent, "Strategy a");
    ui.submit(); assert.equal(ui.writes().length, 2, "Only a new explicit submit sends the retry");
    assert.deepEqual(ui.writes()[1].body, { name: "Latest queued values", description: "Private notes", folder: "Research" });
    retry.resolve(reply({ ...project("a"), name: "Latest queued values" })); await microtasks();
    assert.equal(ui.dialog.open, false); assert.equal(ui.$("project-title").textContent, "Latest queued values");
  }
});

test("an uncertain result propagates past dismissed intermediate visits without sending the latest queued save", async (t) => {
  const first = deferred(), ui = await boot(t, { handle: (call) => call.method === "PATCH" ? first.promise : undefined });
  await ui.open(); ui.settings(); ui.input("settings-name", "First"); ui.submit();
  ui.close(); ui.settings(); ui.input("settings-name", "Dismissed middle"); ui.submit();
  ui.close(); ui.settings(); ui.input("settings-name", "Latest reviewed values"); ui.submit(); ui.flushCloses();
  first.reject(new TypeError("Synthetic lost response")); await microtasks();
  assert.deepEqual(ui.writes().map((call) => call.body.name), ["First"]);
  assert.equal(ui.save.disabled, false); assert.equal(ui.dialog.open, true);
  assert.equal(ui.$("settings-name").value, "Latest reviewed values");
  assert.match(ui.$("settings-status").textContent, /outcome unknown.*queued save was not sent/);
  assert.equal(ui.$("project-title").textContent, "Strategy a");
});

test("a current ambiguous cloud failure warns about unconfirmed persistence without claiming its request was unsent", async (t) => {
  const pending = deferred(), ui = await boot(t, { handle: (call) => call.method === "PATCH" ? pending.promise : undefined });
  await ui.open(); ui.settings(); ui.input("settings-name", "Unconfirmed current save"); ui.submit();
  pending.resolve(reply({ detail: "Synthetic server timeout" }, 503)); await microtasks();
  assert.equal(ui.dialog.open, true); assert.equal(ui.save.disabled, false);
  assert.equal(ui.$("settings-name").value, "Unconfirmed current save");
  assert.match(ui.$("settings-status").textContent, /outcome unknown.*server may still finish.*retry could race/);
  assert.doesNotMatch(ui.$("settings-status").textContent, /was not sent/);
  assert.equal(ui.$("project-title").textContent, "Strategy a");
});
