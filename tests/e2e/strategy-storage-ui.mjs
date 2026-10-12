// Offline synthetic store-selection checks; no browser, server, database or real network writes.
// NODE_PATH=/path/to/jsdom/node_modules node --test tests/e2e/strategy-storage-ui.mjs
// shortcut: native dialog focus, browser history and visual layout need separately authorized browser QA.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "chart-tools.js", "workspace-store.js", "studio-assistant.js", "report-evidence.js", "proposal-diff.js", "strategy-backup.js", "saved-links.js", "app.js"]
  .map((name) => readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
const path = "/v1/orgs/fixture-org/projects";
const plain = (value) => JSON.parse(JSON.stringify(value));
const reply = (value, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => plain(value) });
const page = (projects, next_cursor = null) => reply({ projects, next_cursor, has_more: next_cursor !== null });
const project = (id, extras = {}) => ({ id, name: `Cloud ${id}`, description: "", folder: "Cloud folder", visibility: "private",
  latest_version_no: 1, updated_at: "2026-01-01T00:00:00Z",
  versions: [{ id: `${id}-v1`, project_id: id, version_no: 1, files: { "strategy.py": "# inert cloud fixture\n" }, entrypoint: "strategy.py" }], ...extras });
const snapshot = (name = "Imported private copy") => ({ format: "veyra-strategy-snapshot", schema_version: 1,
  name, description: "Synthetic fixture", folder: "Imported folder", files: { "strategy.py": "# inert snapshot\n" },
  entrypoint: "strategy.py", has_unsaved_changes: false });
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function until(condition, label) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail(`Timed out waiting for ${label}`);
}
async function microtasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function storage() {
  const values = new Map();
  return { failWrite: false, get length() { return values.size; }, key: (i) => [...values.keys()][i],
    getItem: (key) => values.get(key) ?? null, removeItem: (key) => values.delete(key),
    setItem(key, value) { if (this.failWrite) throw new Error("Synthetic storage failure"); values.set(key, String(value)); },
    snapshot: () => Object.fromEntries(values) };
}
function locks() {
  let tail = Promise.resolve();
  return { calls: [], request(name, options, operation) {
    this.calls.push({ name, ...options });
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  } };
}
const seedDevice = (store) => store.createProject({ name: "Existing device strategy", description: "Local-only research",
  folder: "Device folder", files: { "strategy.py": "# inert device fixture\n" }, entrypoint: "strategy.py" });

async function boot(t, { user = true, hash = "#code", shared = storage(), lock = locks(), seed = seedDevice,
  remote = [project("cloud-1")], handle } = {}) {
  const errors = [], calls = [], virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: `https://veyra.test/${hash}`, runScripts: "outside-only", virtualConsole });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  t.after(() => { w.close(); assert.deepEqual(errors, [], "No uncaught DOM errors or unexpected fake API calls"); });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  Object.defineProperty(w, "localStorage", { value: shared });
  if (lock) Object.defineProperty(w.navigator, "locks", { value: lock });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  if (user) shared.setItem("veyra.user", "synthetic-fixture-user");
  w.fetch = async (url, options = {}) => {
    const call = { path: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (call.path === "/v1/me") return reply({ organizations: [{ id: "fixture-org" }] });
    if (call.path === "/v1/catalog/datasets") return reply({ datasets: [] });
    if (call.path === "/v1/orgs/fixture-org/billing/balance") return reply({ available_nano: 0 });
    if (call.path === "/v1/public/strategies?q=&limit=21&offset=0") return reply({ strategies: [] });
    const result = await handle?.(call);
    if (result !== undefined) return result;
    if (call.path === path && call.method === "GET") return page(remote);
    const match = remote.find((p) => call.path === `/v1/projects/${p.id}` || call.path === `/v1/projects/${p.id}/versions/1`);
    if (match && call.method === "GET") return reply(call.path.endsWith("/versions/1") ? match.versions[0] : match);
    errors.push(`Unexpected fake request: ${call.method} ${call.path}`);
    return reply({ detail: "Unexpected fake request" }, 500);
  };
  scripts.slice(0, -1).forEach((script) => w.eval(script));
  const store = w.VeyraWorkspaceStore.create(shared), seeded = seed?.(store, w);
  w.eval(scripts.at(-1));
  await until(() => !$("view-code").hidden && $("workspace-mode").textContent, "Studio boot");
  await delay(5);
  const input = (id, value, type = "input") => { $(id).value = value; $(id).dispatchEvent(new w.Event(type, { bubbles: true })); };
  async function navigate(next) {
    w.location.hash = next;
    await delay(10);
    await until(() => !$(`view-${next.slice(1).split("/")[0]}`).hidden, `route ${next}`);
  }
  async function choose(value) {
    input("project-store", value, "change");
    await until(() => w.location.hash === `#code/${value}`, `${value} explicit route`);
    await delay(10);
  }
  const done = () => until(() => !$("refresh-projects").disabled, "library finish");
  const links = () => [...$("project-list").querySelectorAll("a")].map((a) => a.getAttribute("href"));
  const reads = () => calls.filter((c) => c.path.startsWith(path) && c.method === "GET");
  const posts = () => calls.filter((c) => c.method === "POST");
  const submit = (name) => { input("new-project-name", name); $("create-project").click(); };
  const tab = () => w.document.querySelector('.tabs a[data-tab="code"]');
  const editor = () => until(() => !$("view-project").hidden && !$("editor").disabled, "opened editor");
  function selectSnapshot(value = snapshot(), read) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    Object.defineProperty($("strategy-import-file"), "files", { configurable: true, value: [{ size: bytes.length,
      arrayBuffer: read || (async () => new w.Uint8Array(bytes).buffer), text() { assert.fail("Snapshot must use strict bytes"); } }] });
    $("strategy-import-file").dispatchEvent(new w.Event("change"));
  }
  async function preview(value = snapshot()) {
    $("import-strategy").click(); selectSnapshot(value);
    await until(() => !$("strategy-import-preview").hidden, "import preview");
  }
  return { w, $, calls, store, seeded, shared, lock, input, navigate, choose, done, links, reads, posts, submit, tab, editor, preview, selectSnapshot };
}

test("connected default shows only cloud; the selector finds existing device strategies without migration", async (t) => {
  const ui = await boot(t); await ui.done();
  const original = ui.shared.snapshot();
  assert.deepEqual([...ui.$("project-store").options].map((o) => o.value).sort(), ["cloud", "device"]);
  assert.equal(ui.$("project-store").value, "cloud");
  assert.equal(ui.$("project-store").querySelector('[value="cloud"]').disabled, false);
  assert.equal(ui.$("create-project").textContent, "Create in cloud");
  assert.deepEqual(ui.links(), ["#project/cloud-1"]);
  assert.doesNotMatch(ui.$("project-folder").textContent, /Device folder/);
  assert.equal(ui.tab().getAttribute("href"), "#code/cloud");
  await ui.choose("device"); await ui.done();
  assert.equal(ui.$("create-project").textContent, "Create on device");
  assert.deepEqual(ui.links(), [`#project/${ui.seeded.id}`]);
  assert.match(ui.$("projects-scope").textContent, /All strategies on this device/);
  assert.doesNotMatch(ui.$("project-folder").textContent, /Cloud folder/);
  assert.equal(ui.tab().getAttribute("href"), "#code/device");
  assert.equal(ui.reads().length, 1);
  assert.deepEqual(ui.posts(), []);
  assert.deepEqual(ui.shared.snapshot(), original, "Changing views does not migrate or rewrite saved data");
  await ui.choose("cloud"); await ui.done();
  assert.deepEqual(ui.links(), ["#project/cloud-1"]);
});

for (const store of ["cloud", "device"]) test(`connected direct #code/${store} opens the requested store`, async (t) => {
  const ui = await boot(t, { hash: `#code/${store}` }); await ui.done();
  assert.equal(ui.$("project-store").value, store);
  assert.deepEqual(ui.links(), [store === "cloud" ? "#project/cloud-1" : `#project/${ui.seeded.id}`]);
  assert.equal(ui.reads().length, store === "cloud" ? 1 : 0);
});

for (const hash of ["#code", "#code/device", "#code/cloud"]) test(`unauthenticated ${hash} stays device-local and never requests a cloud library`, async (t) => {
  const ui = await boot(t, { user: false, hash }); await ui.done();
  assert.equal(ui.$("project-store").value, "device");
  assert.equal(ui.$("project-store").querySelector('[value="cloud"]').disabled, true);
  assert.equal(ui.$("create-project").textContent, "Create on device");
  assert.equal(ui.tab().getAttribute("href"), "#code/device");
  assert.deepEqual(ui.links(), [`#project/${ui.seeded.id}`]);
  assert.deepEqual(ui.calls.map((c) => c.path), ["/v1/catalog/datasets"]);
});

test("search and folders reset between stores but same-store Refresh preserves them", async (t) => {
  const ui = await boot(t, { remote: [project("cloud-1", { description: "needle" }), project("cloud-2", { folder: "Other" })] });
  await ui.done(); ui.input("project-search", "needle"); ui.input("project-folder", "Cloud folder");
  ui.$("refresh-projects").click(); await ui.done();
  assert.equal(ui.$("project-search").value, "needle");
  assert.equal(ui.$("project-folder").value, "Cloud folder");
  assert.deepEqual(ui.links(), ["#project/cloud-1"]);
  await ui.choose("device"); await ui.done();
  assert.equal(ui.$("project-search").value, ""); assert.equal(ui.$("project-folder").value, "");
  assert.deepEqual(ui.links(), [`#project/${ui.seeded.id}`]);
  assert.doesNotMatch(ui.$("project-folder").textContent, /Cloud folder|Other/);
  ui.input("project-search", "local-only"); ui.input("project-folder", "Device folder");
  ui.$("refresh-projects").click(); await ui.done();
  assert.equal(ui.$("project-search").value, "local-only"); assert.equal(ui.$("project-folder").value, "Device folder");
  assert.deepEqual(ui.links(), [`#project/${ui.seeded.id}`]);
  await ui.choose("cloud"); await ui.done();
  assert.equal(ui.$("project-search").value, ""); assert.equal(ui.$("project-folder").value, "");
  assert.equal(ui.links().length, 2); assert.doesNotMatch(ui.$("project-folder").textContent, /Device folder/);
});

for (const store of ["cloud", "device"]) test(`${store} editor library link and Studio tab retain the actual project's store`, async (t) => {
  const ui = await boot(t); await ui.done();
  const id = store === "cloud" ? "cloud-1" : ui.seeded.id;
  await ui.navigate(`#project/${id}`); await ui.editor();
  assert.equal(ui.$("project-library-link").getAttribute("href"), `#code/${store}`);
  assert.match(ui.$("project-library-link").textContent, new RegExp(`All ${store} strategies`));
  assert.equal(ui.tab().getAttribute("href"), `#code/${store}`);
  ui.$("project-library-link").click();
  await until(() => ui.w.location.hash === `#code/${store}` && !ui.$("view-code").hidden, "library back link");
  await ui.done(); assert.equal(ui.$("project-store").value, store);
  await ui.navigate("#discover");
  assert.equal(ui.tab().getAttribute("href"), `#code/${store}`);
  ui.tab().click(); await until(() => !ui.$("view-code").hidden, "Studio tab return"); await ui.done();
  assert.equal(ui.$("project-store").value, store);
});

test("a connected import creates only a device copy and returns to its device library", async (t) => {
  const ui = await boot(t); await ui.done(); await ui.preview();
  ui.$("confirm-strategy-import").click(); await ui.editor();
  assert.match(ui.w.location.hash, /^#project\/local-/);
  assert.equal(ui.$("project-title").textContent, "Imported private copy");
  assert.equal(ui.$("project-library-link").getAttribute("href"), "#code/device");
  assert.equal(ui.tab().getAttribute("href"), "#code/device");
  ui.$("project-library-link").click();
  await until(() => !ui.$("view-code").hidden, "import library return"); await ui.done();
  assert.equal(ui.$("project-store").value, "device");
  assert.equal(ui.links().length, 2); assert.match(ui.$("project-list").textContent, /Imported private copy/);
  assert.doesNotMatch(ui.$("project-list").textContent, /Cloud cloud-1/);
  assert.deepEqual(ui.posts(), []); assert.equal(ui.reads().length, 1);
});

test("connected device creation stays local, opens the editor and never sends cloud POST", async (t) => {
  const ui = await boot(t, { hash: "#code/device" }); await ui.done();
  ui.submit("New device strategy"); await ui.editor();
  assert.match(ui.w.location.hash, /^#project\/local-/);
  assert.equal(ui.$("project-title").textContent, "New device strategy");
  assert.equal(ui.$("project-library-link").getAttribute("href"), "#code/device");
  assert.deepEqual(plain(ui.store.listProjects().projects.map((p) => p.name)).sort(), ["Existing device strategy", "New device strategy"]);
  assert.deepEqual(ui.posts(), []); assert.equal(ui.reads().length, 0);
});

test("cloud creation sends exactly one project POST while pending and opens the cloud editor", async (t) => {
  const pending = deferred(), created = project("new-cloud", { name: "New cloud strategy" });
  const ui = await boot(t, { remote: [created], handle: (c) => c.method === "POST" ? pending.promise : undefined });
  await ui.done(); const original = ui.shared.snapshot(); ui.submit(created.name);
  await until(() => ui.posts().length === 1, "cloud create request");
  assert.equal(ui.$("create-project").disabled, true);
  assert.match(ui.$("new-project-status").textContent, /creat|waiting|saving/i);
  ui.$("new-project-form").dispatchEvent(new ui.w.SubmitEvent("submit", { cancelable: true, submitter: ui.$("create-project") }));
  assert.equal(ui.posts().length, 1, "Duplicate submissions are ignored while pending");
  assert.equal(ui.posts()[0].path, path); assert.equal(ui.posts()[0].body.name, created.name);
  assert.equal(ui.posts()[0].body.entrypoint, "strategy.py");
  pending.resolve(reply(created)); await ui.editor();
  assert.equal(ui.w.location.hash, "#project/new-cloud");
  assert.equal(ui.$("project-library-link").getAttribute("href"), "#code/cloud");
  assert.deepEqual(ui.shared.snapshot(), original, "Cloud creation never writes a device strategy");
});

for (const failure of [false, true]) test(`a stale ${failure ? "failed" : "successful"} cloud page cannot replace the device view or a cloud revisit`, async (t) => {
  const old = deferred(), fresh = deferred(); let firstReads = 0;
  const ui = await boot(t, { handle: (c) => {
    if (c.path === path) return ++firstReads === 1 ? page([project("old")], "old-page") : fresh.promise;
    if (c.path === `${path}?cursor=old-page`) return old.promise;
  } });
  await until(() => ui.reads().length === 2, "pending old page");
  await ui.choose("device"); await ui.done();
  assert.deepEqual(ui.links(), [`#project/${ui.seeded.id}`]);
  await ui.choose("cloud");
  assert.equal(ui.$("refresh-projects").disabled, true);
  old.resolve(failure ? reply({ detail: "Stale cloud page error" }, 503) : page([project("stale")], "never-fetch"));
  await delay(20);
  assert.equal(ui.$("refresh-projects").disabled, true, "The abandoned page cannot unlock a newer request");
  assert.deepEqual(ui.links(), []); assert.doesNotMatch(ui.$("projects-scope").textContent, /Stale|Loading failed/);
  assert.equal(ui.reads().length, 3, "An abandoned page cannot continue pagination");
  fresh.resolve(page([project("fresh")])); await ui.done(); assert.deepEqual(ui.links(), ["#project/fresh"]);
});

test("an initial cloud page finishing on the device view cannot mix rows, folders or status", async (t) => {
  const pending = deferred(); const ui = await boot(t, { handle: () => pending.promise });
  await ui.choose("device"); await ui.done();
  const status = ui.$("projects-scope").textContent;
  pending.resolve(page([project("stale", { folder: "Stale cloud folder" })], "never-fetch")); await delay(20);
  assert.equal(ui.w.location.hash, "#code/device"); assert.equal(ui.$("project-store").value, "device");
  assert.deepEqual(ui.links(), [`#project/${ui.seeded.id}`]);
  assert.equal(ui.$("projects-scope").textContent, status);
  assert.doesNotMatch(ui.$("project-folder").textContent, /Stale/); assert.equal(ui.reads().length, 1);
});

for (const failure of [false, true]) test(`a stale cloud create ${failure ? "error" : "result"} cannot affect a newer pending create after switching away and back`, async (t) => {
  const old = deferred(), fresh = deferred(); let creates = 0;
  const ui = await boot(t, { handle: (c) => c.method === "POST" ? (++creates === 1 ? old.promise : fresh.promise) : undefined });
  await ui.done(); ui.submit("Abandoned cloud create"); await until(() => ui.posts().length === 1, "old create");
  await ui.choose("device"); await ui.done();
  assert.equal(ui.$("create-project").disabled, false);
  await ui.choose("cloud"); await ui.done(); ui.submit("Current cloud create");
  await until(() => ui.posts().length === 2, "current create");
  const currentStatus = ui.$("new-project-status").textContent;
  old.resolve(failure ? reply({ detail: "Stale creation failed" }, 503) : reply(project("abandoned")));
  await delay(20);
  assert.equal(ui.w.location.hash, "#code/cloud");
  assert.equal(ui.$("new-project-name").value, "Current cloud create");
  assert.equal(ui.$("create-project").disabled, true);
  assert.equal(ui.$("new-project-status").textContent, currentStatus);
  assert.doesNotMatch(ui.$("status").textContent, /Stale|Created|Abandoned/);
  fresh.resolve(reply({ detail: "Current cloud rejection" }, 409));
  await until(() => !ui.$("create-project").disabled, "current create failure");
  assert.match(ui.$("new-project-status").textContent, /Current cloud rejection/);
  assert.equal(ui.$("new-project-name").value, "Current cloud create");
});

test("a cloud create finishing while on device cannot clear the new name or redirect", async (t) => {
  const pending = deferred(); const ui = await boot(t, { handle: (c) => c.method === "POST" ? pending.promise : undefined });
  await ui.done(); ui.submit("Cloud operation"); await until(() => ui.posts().length === 1, "create request");
  await ui.choose("device"); await ui.done(); ui.input("new-project-name", "Next device strategy");
  const status = ui.$("new-project-status").textContent;
  pending.resolve(reply(project("finished-cloud"))); await delay(20);
  assert.equal(ui.w.location.hash, "#code/device"); assert.equal(ui.$("new-project-name").value, "Next device strategy");
  assert.equal(ui.$("new-project-status").textContent, status); assert.equal(ui.$("create-project").disabled, false);
  assert.deepEqual(ui.links(), [`#project/${ui.seeded.id}`]);
});

test("queued local creation cancels before writing after a store round trip", async (t) => {
  const lock = locks(), gate = deferred();
  const held = lock.request("veyra.workspace.v1", { mode: "exclusive" }, () => gate.promise);
  const ui = await boot(t, { hash: "#code/device", lock }); await ui.done();
  const original = ui.shared.snapshot(); ui.submit("Cancelled local create");
  assert.equal(ui.$("create-project").disabled, true);
  await ui.choose("cloud"); await ui.done(); await ui.choose("device"); await ui.done();
  ui.input("new-project-name", "Newer device name");
  gate.resolve(); await held; await delay(20);
  assert.deepEqual(ui.shared.snapshot(), original, "Queued cancelled work never reaches local storage");
  assert.equal(ui.w.location.hash, "#code/device"); assert.equal(ui.$("new-project-name").value, "Newer device name");
  assert.equal(ui.$("create-project").disabled, false); assert.deepEqual(ui.posts(), []);
  ui.submit("Fresh local create"); await ui.editor(); assert.equal(ui.$("project-title").textContent, "Fresh local create");
});

test("a local create already written but awaiting its lock result cannot replace newer cloud UI", async (t) => {
  const gate = deferred(); let written = false;
  const lock = { request: async (_name, _options, operation) => { const result = operation(); written = true; await gate.promise; return result; } };
  const ui = await boot(t, { hash: "#code/device", lock }); await ui.done(); ui.submit("Already saved device strategy");
  await until(() => written, "atomic local write"); await ui.choose("cloud"); await ui.done();
  ui.input("new-project-name", "New cloud name"); gate.resolve(); await delay(20);
  assert.equal(ui.w.location.hash, "#code/cloud"); assert.equal(ui.$("new-project-name").value, "New cloud name");
  assert.equal(ui.$("create-project").disabled, false); assert.deepEqual(ui.links(), ["#project/cloud-1"]);
  assert.equal(ui.store.listProjects().projects.length, 2);
  assert.doesNotMatch(ui.$("status").textContent, /Created|Already saved/);
});

test("device write failure keeps the name and existing saved data and permits a retry", async (t) => {
  const ui = await boot(t, { hash: "#code/device" }); await ui.done(); const original = ui.shared.snapshot();
  ui.shared.failWrite = true; ui.submit("Retry device create");
  await until(() => !ui.$("create-project").disabled, "local failure");
  assert.match(ui.$("new-project-status").textContent, /not saved|storage/i);
  assert.equal(ui.$("new-project-name").value, "Retry device create"); assert.equal(ui.w.location.hash, "#code/device");
  assert.deepEqual(ui.shared.snapshot(), original); assert.deepEqual(ui.posts(), []);
  ui.shared.failWrite = false; ui.$("create-project").click(); await ui.editor();
  assert.equal(ui.$("project-title").textContent, "Retry device create");
});

test("a cloud list error never falls back to device rows and switching stores clears its error", async (t) => {
  const ui = await boot(t, { handle: (c) => c.path === path ? reply({ detail: "Synthetic cloud unavailable" }, 503) : undefined });
  await ui.done(); assert.equal(ui.$("project-store").value, "cloud"); assert.deepEqual(ui.links(), []);
  assert.match(ui.$("projects-scope").textContent, /Loading failed.*Synthetic cloud unavailable/);
  assert.doesNotMatch(ui.$("project-list").textContent, /Existing device|Create your first/);
  await ui.choose("device"); await ui.done(); assert.deepEqual(ui.links(), [`#project/${ui.seeded.id}`]);
  assert.doesNotMatch(ui.$("projects-scope").textContent, /Loading failed|unavailable/);
});

test("a pending import read cannot reopen or overwrite the new store's dialog", async (t) => {
  const pending = deferred(); const ui = await boot(t); await ui.done();
  ui.$("import-strategy").click(); ui.selectSnapshot(snapshot("Stale import"), () => pending.promise);
  await ui.choose("device"); await ui.done(); assert.equal(ui.$("strategy-import-dialog").open, false);
  await ui.preview(snapshot("Current device preview"));
  pending.resolve(new ui.w.Uint8Array(new TextEncoder().encode(JSON.stringify(snapshot("Stale import")))).buffer);
  await delay(20);
  assert.equal(ui.w.location.hash, "#code/device"); assert.equal(ui.$("strategy-import-dialog").open, true);
  assert.equal(ui.$("strategy-import-name").value, "Current device preview");
  assert.equal(ui.store.listProjects().projects.length, 1); assert.deepEqual(ui.posts(), []);
});

test("a queued import is cancelled on store change before the local write", async (t) => {
  const lock = locks(), gate = deferred();
  const held = lock.request("veyra.workspace.v1", { mode: "exclusive" }, () => gate.promise);
  const ui = await boot(t, { lock }); await ui.done(); await ui.preview();
  const original = ui.shared.snapshot(); ui.$("confirm-strategy-import").click();
  await ui.choose("device"); await ui.done(); gate.resolve(); await held; await delay(20);
  assert.deepEqual(ui.shared.snapshot(), original); assert.equal(ui.w.location.hash, "#code/device");
  assert.equal(ui.$("strategy-import-dialog").open, false); assert.deepEqual(ui.links(), [`#project/${ui.seeded.id}`]);
  assert.deepEqual(ui.posts(), []);
});

test("an import written before a store switch cannot steal navigation when its lock finishes", async (t) => {
  const gate = deferred(); let written = false;
  const lock = { request: async (_name, _options, operation) => { const result = operation(); written = true; await gate.promise; return result; } };
  const ui = await boot(t, { lock }); await ui.done(); await ui.preview(); ui.$("confirm-strategy-import").click();
  await until(() => written, "import write"); await ui.choose("device"); await ui.done(); await ui.choose("cloud"); await ui.done();
  await ui.preview(snapshot("New cloud preview")); gate.resolve(); await delay(20);
  assert.equal(ui.w.location.hash, "#code/cloud"); assert.equal(ui.$("project-store").value, "cloud");
  assert.equal(ui.$("strategy-import-dialog").open, true); assert.equal(ui.$("strategy-import-name").value, "New cloud preview");
  assert.match(ui.$("strategy-import-status").textContent, /No strategy has been created/);
  assert.deepEqual(ui.links(), ["#project/cloud-1"]); assert.equal(ui.store.listProjects().projects.length, 2);
  assert.deepEqual(ui.posts(), []);
});

for (const failure of [false, true]) test(`same-turn store round trip invalidates a cloud create ${failure ? "error" : "result"} before hashchange`, async (t) => {
  const pending = deferred();
  const ui = await boot(t, { hash: "#code/cloud", handle: (c) => c.method === "POST" ? pending.promise : undefined });
  await ui.done(); ui.submit("Abandoned create"); await until(() => ui.posts().length === 1, "pending cloud creation");
  ui.input("project-store", "device", "change"); ui.input("project-store", "cloud", "change");
  ui.input("new-project-name", "Newer cloud name");
  pending.resolve(failure ? reply({ detail: "Same-turn stale error" }, 503) : reply(project("same-turn-stale")));
  await microtasks();
  assert.equal(ui.w.location.hash, "#code/cloud");
  assert.equal(ui.$("new-project-name").value, "Newer cloud name");
  assert.doesNotMatch(ui.$("status").textContent, /Same-turn stale|Created/);
  assert.doesNotMatch(ui.$("new-project-status").textContent, /Same-turn stale error/);
  await delay(20); await ui.done();
  assert.equal(ui.w.location.hash, "#code/cloud"); assert.equal(ui.$("create-project").disabled, false);
  assert.deepEqual(ui.links(), ["#project/cloud-1"]);
});

for (const failure of [false, true]) test(`same-turn store round trip invalidates a cloud page ${failure ? "error" : "result"} before hashchange`, async (t) => {
  const pending = deferred(); let initial = true;
  const ui = await boot(t, { hash: "#code/cloud", handle: (c) => {
    if (c.path === path) { if (initial) { initial = false; return page([project("old")], "pending"); } return page([project("fresh")]); }
    if (c.path === `${path}?cursor=pending`) return pending.promise;
  } });
  await until(() => ui.reads().length === 2, "pending page");
  const scope = ui.$("projects-scope").textContent;
  ui.input("project-store", "device", "change"); ui.input("project-store", "cloud", "change");
  pending.resolve(failure ? reply({ detail: "Same-turn stale page error" }, 503) : page([project("stale")], "must-not-fetch"));
  await microtasks();
  assert.deepEqual(ui.links(), ["#project/old"]);
  assert.equal(ui.$("projects-scope").textContent, scope);
  assert.equal(ui.reads().length, 2, "No stale pagination starts before the queued hashchange");
  await delay(20); await ui.done();
  assert.deepEqual(ui.links(), ["#project/fresh"]);
  assert.doesNotMatch(ui.$("projects-scope").textContent, /Same-turn stale|Loading failed/);
});

test("same-turn device round trip cancels a queued local create before the lock runs", async (t) => {
  const lock = locks(), gate = deferred();
  const held = lock.request("veyra.workspace.v1", { mode: "exclusive" }, () => gate.promise);
  const ui = await boot(t, { hash: "#code/device", lock }); await ui.done();
  const original = ui.shared.snapshot(); ui.submit("Cancelled same-turn local create");
  ui.input("project-store", "cloud", "change"); ui.input("project-store", "device", "change");
  gate.resolve(); await held; await microtasks();
  assert.deepEqual(ui.shared.snapshot(), original);
  assert.equal(ui.w.location.hash, "#code/device");
  await delay(20); await ui.done(); assert.equal(ui.$("create-project").disabled, false);
  assert.deepEqual(ui.posts(), []);
});

test("same-turn store round trip invalidates a pending import read before hashchange closes the dialog", async (t) => {
  const pending = deferred(); const ui = await boot(t, { hash: "#code/cloud" }); await ui.done();
  ui.$("import-strategy").click(); ui.selectSnapshot(snapshot("Stale same-turn import"), () => pending.promise);
  ui.input("project-store", "device", "change"); ui.input("project-store", "cloud", "change");
  pending.resolve(new ui.w.Uint8Array(new TextEncoder().encode(JSON.stringify(snapshot("Stale same-turn import")))).buffer);
  await microtasks();
  assert.equal(ui.$("strategy-import-preview").hidden, true);
  assert.equal(ui.$("strategy-import-name").value, "");
  await delay(20); await ui.done();
  assert.equal(ui.$("strategy-import-dialog").open, false); assert.equal(ui.w.location.hash, "#code/cloud");
  assert.equal(ui.store.listProjects().projects.length, 1);
});

test("same-turn store round trip cancels a queued import before its local write", async (t) => {
  const lock = locks(), gate = deferred();
  const held = lock.request("veyra.workspace.v1", { mode: "exclusive" }, () => gate.promise);
  const ui = await boot(t, { hash: "#code/cloud", lock }); await ui.done(); await ui.preview();
  const original = ui.shared.snapshot(); ui.$("confirm-strategy-import").click();
  ui.input("project-store", "device", "change"); ui.input("project-store", "cloud", "change");
  gate.resolve(); await held; await microtasks();
  assert.deepEqual(ui.shared.snapshot(), original); assert.equal(ui.w.location.hash, "#code/cloud");
  await delay(20); await ui.done(); assert.equal(ui.$("strategy-import-dialog").open, false);
});

for (const failure of [false, true]) test(`opening a newer import invalidates a cloud create ${failure ? "error" : "result"} on the same route`, async (t) => {
  const pending = deferred();
  const ui = await boot(t, { hash: "#code/cloud", handle: (c) => c.method === "POST" ? pending.promise : undefined });
  await ui.done(); ui.submit("Older cloud create"); await until(() => ui.posts().length === 1, "old cloud create");
  await ui.preview(snapshot("Newer import preview"));
  ui.$("new-project-form").dispatchEvent(new ui.w.SubmitEvent("submit", { cancelable: true, submitter: ui.$("create-project") }));
  assert.equal(ui.posts().length, 1, "An open import dialog prevents a competing create submission");
  const status = ui.$("strategy-import-status").textContent;
  pending.resolve(failure ? reply({ detail: "Older cloud create failed" }, 503) : reply(project("older-create")));
  await delay(20);
  assert.equal(ui.w.location.hash, "#code/cloud"); assert.equal(ui.$("strategy-import-dialog").open, true);
  assert.equal(ui.$("strategy-import-name").value, "Newer import preview");
  assert.equal(ui.$("strategy-import-status").textContent, status);
  assert.doesNotMatch(ui.$("status").textContent, /Older cloud create failed|Created/);
  assert.doesNotMatch(ui.$("new-project-status").textContent, /Older cloud create failed/);
  ui.$("confirm-strategy-import").click(); await ui.editor();
  assert.equal(ui.$("project-title").textContent, "Newer import preview");
  assert.equal(ui.$("project-library-link").getAttribute("href"), "#code/device");
});

for (const [label, result] of [["null", null], ["missing ID", {}], ["empty ID", { id: "" }],
  ["non-text ID", { id: 123 }], ["device ID", { id: "local-00000000-0000-4000-8000-000000000000" }]]) {
  test(`a cloud create response with ${label} retains input and requires refresh without navigation`, async (t) => {
    const ui = await boot(t, { hash: "#code/cloud", handle: (c) => c.method === "POST" ? reply(result) : undefined });
    await ui.done(); const original = ui.shared.snapshot(); ui.submit("Unconfirmed cloud strategy");
    await until(() => !ui.$("create-project").disabled, "unconfirmed cloud result");
    assert.equal(ui.posts().length, 1);
    assert.equal(ui.w.location.hash, "#code/cloud");
    assert.equal(ui.$("new-project-name").value, "Unconfirmed cloud strategy");
    assert.match(ui.$("new-project-status").textContent, /Creation could not be confirmed.*Refresh/);
    assert.deepEqual(ui.links(), ["#project/cloud-1"]);
    assert.deepEqual(ui.shared.snapshot(), original);
    assert.equal(ui.calls.some((c) => c.path.startsWith("/v1/projects/")), false);
  });
}

test("Refresh ignores an old store while a selector hashchange is still queued", async (t) => {
  const ui = await boot(t, { hash: "#code/cloud" }); await ui.done();
  ui.input("project-store", "device", "change"); ui.$("refresh-projects").click(); await microtasks();
  assert.equal(ui.reads().length, 1, "No cloud refresh starts after the selector has changed to device");
  await delay(20); await ui.done();
  assert.equal(ui.$("project-store").value, "device"); assert.deepEqual(ui.links(), [`#project/${ui.seeded.id}`]);
});
