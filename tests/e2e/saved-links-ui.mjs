// Synthetic jsdom checks only. No browser launch, Python, server, account, database, upload or source execution.
// NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test tests/e2e/saved-links-ui.mjs
// shortcut: actual focus, browser storage events and visual layout still need authorized browser QA.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "workspace-store.js", "studio-assistant.js", "report-evidence.js", "proposal-diff.js", "strategy-backup.js", "saved-links.js", "app.js"]
  .map((name) => readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
const KEY = "veyra.saved-links.v1", id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const plain = (value) => JSON.parse(JSON.stringify(value));
const fixture = (extra = {}) => ({ id, title: "Public trend", description: "DO NOT STORE PUBLIC DESCRIPTION",
  published_at: "2026-01-01T00:00:00Z", content_hash: `sha256:${"a".repeat(64)}`, owner: "DO NOT STORE IDENTITY",
  files: { "strategy.py": "# DO NOT STORE SOURCE\r\nvalue = '雪'\r\n" }, entrypoint: "strategy.py", ...extra });
const reply = (value, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => plain(value) });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function until(condition, label) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail(`Timed out waiting for ${label}`);
}
function storage() {
  const values = new Map();
  return { failWrite: false, failRead: false, writes: 0, get length() { return values.size; }, key: (i) => [...values.keys()][i],
    getItem(key) { if (this.failRead && key === KEY) throw new Error("Synthetic read failure"); return values.get(key) ?? null; },
    setItem(key, value) { if (this.failWrite && key === KEY) throw new Error("Synthetic write failure"); this.writes++; values.set(key, String(value)); },
    removeItem: (key) => values.delete(key), snapshot: () => Object.fromEntries(values) };
}
function locks() {
  let tail = Promise.resolve();
  return { calls: [], request(name, options, operation) {
    this.calls.push({ name, ...options }); const result = tail.then(operation); tail = result.catch(() => {}); return result;
  } };
}
async function boot(t, { hash = `#public/${id}`, user = false, shared = storage(), lock = locks(), snapshot = fixture(), seed, handle } = {}) {
  const errors = [], calls = [], console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: `https://veyra.test/${hash}`, runScripts: "outside-only", virtualConsole: console });
  const w = dom.window, $ = (name) => { const node = w.document.getElementById(name); assert.ok(node, `Missing #${name}`); return node; };
  t.after(() => { w.close(); assert.deepEqual(errors, [], "No uncaught DOM errors or unexpected fake API calls"); });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  Object.defineProperty(w, "localStorage", { value: shared });
  if (lock) Object.defineProperty(w.navigator, "locks", { value: lock });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  if (user) shared.setItem("veyra.user", "synthetic-fixture-user");
  w.fetch = async (url, options = {}) => {
    const call = { path: String(url), method: options.method || "GET", ...options }; calls.push(call);
    if (call.method !== "GET") { errors.push(`Unexpected write: ${call.method} ${url}`); return reply({ detail: "No writes" }, 500); }
    if (call.path === "/v1/me") return reply({ organizations: [{ id: "fixture-org" }] });
    if (call.path === "/v1/catalog/datasets") return reply({ datasets: [] });
    if (call.path === "/v1/orgs/fixture-org/billing/balance") return reply({ available_nano: 0 });
    const result = await handle?.(call); if (result !== undefined) return result;
    if (call.path.startsWith("/v1/public/strategies/")) return reply({ ...snapshot, id: call.path.split("/").at(-1) });
    if (call.path.startsWith("/v1/public/strategies?")) return reply({ strategies: [] });
    errors.push(`Unexpected fake request: ${call.method} ${call.path}`); return reply({ detail: "Unexpected request" }, 500);
  };
  scripts.slice(0, -1).forEach((script) => w.eval(script));
  const store = w.VeyraSavedLinks.create(shared), workspace = w.VeyraWorkspaceStore.create(shared); seed?.(store, workspace, w);
  w.eval(`${scripts.at(-1)}\nwindow.fixtureState = state; window.recheckPublic = showPublicStrategy; window.fixtureRoute = route;`);
  await until(() => !$(`view-${hash.slice(1).split("/")[0]}`).hidden, "initial route");
  if (hash.startsWith("#public/")) await until(() => $("public-status").textContent !== "Loading published source…", "public result");
  if (hash === "#discover/saved") await until(() => !$("saved-links-library").hidden, "saved library");
  const input = (name, value, type = "input") => { $(name).value = value; $(name).dispatchEvent(new w.Event(type, { bubbles: true })); };
  const open = () => $("public-save-link").click(), confirm = () => $("saved-link-confirm").click();
  const manage = (publication = id) => $(`saved-links-list`).querySelector(`[data-saved-link="${publication}"]`).click();
  const status = () => $("saved-link-status").textContent;
  async function navigate(next) { w.location.hash = next; await delay(10); await until(() => !$(`view-${next.slice(1).split("/")[0]}`).hidden, `route ${next}`); }
  const reads = () => calls.filter((call) => call.path.startsWith("/v1/public/strategies/"));
  const ids = [...w.document.querySelectorAll("[id]")].map((node) => node.id); assert.equal(new Set(ids).size, ids.length);
  return { w, $, calls, store, workspace, shared, lock, input, open, confirm, manage, status, navigate, reads };
}
async function saved(ui, folder = "") {
  ui.open(); ui.input("saved-link-folder", folder); ui.confirm();
  await until(() => !ui.$("saved-link-dialog").open, "saved link"); return ui.store.getLink(id);
}

for (const user of [false, true]) test(`save review is local, explicit and metadata-only (account connected=${user})`, async (t) => {
  const ui = await boot(t, { user, seed(_links, workspace, w) {
    const project = workspace.createProject({ name: "Existing private", files: { "strategy.py": "# private" } });
    w.localStorage.setItem(`veyra.draft.${project.id}.other-tab`, "opaque unchanged draft");
  } }), before = ui.shared.snapshot();
  ui.open();
  assert.equal(ui.$("saved-link-dialog").open, true); assert.deepEqual(ui.shared.snapshot(), before);
  assert.match(ui.$("saved-link-dialog").textContent, /no cloud backup/); assert.match(ui.$("saved-link-dialog").textContent, /does not save source/);
  ui.input("saved-link-folder", " Research "); ui.confirm(); await until(() => !ui.$("saved-link-dialog").open, "save");
  const record = plain(ui.store.getLink(id)); assert.equal(record.folder, "Research"); assert.equal(record.saved_title, "Public trend");
  assert.deepEqual(Object.keys(record).sort(), ["publication_id", "saved_title", "folder", "created_at", "updated_at"].sort());
  for (const [key, value] of Object.entries(before)) assert.equal(ui.shared.getItem(key), value);
  assert.doesNotMatch(ui.shared.getItem(KEY), /DO NOT STORE|files|entrypoint|owner|description|content_hash/);
  assert.equal(ui.$("public-save-link").textContent, "Saved on device"); assert.equal(ui.$("public-save-link").getAttribute("aria-pressed"), "true");
  assert.equal(ui.reads().length, 1); assert.deepEqual(ui.lock.calls, [{ name: "veyra.workspace.v1", mode: "exclusive" }]);
  for (const call of ui.reads()) { assert.equal(call.cache, "no-store"); assert.equal(call.credentials, "omit"); assert.deepEqual(plain(call.headers), {}); }
  const reloaded = await boot(t, { user, shared: ui.shared }); assert.equal(reloaded.$("public-save-link").textContent, "Saved on device");
  assert.deepEqual(plain(reloaded.store.getLink(id)), record);
});

test("saved library searches, filters, moves and removes private folders without fetching cached links", async (t) => {
  const ui = await boot(t, { hash: "#discover/saved", seed(store) {
    store.saveLink({ publication_id: id, saved_title: "Older trend title", folder: "Signals" });
    store.saveLink({ publication_id: other, saved_title: "Other research", folder: "" });
  } });
  assert.equal(ui.calls.filter((call) => call.path.includes("/public/")).length, 0);
  assert.equal(ui.$("discover-public").hidden, true); assert.equal(ui.$("discover-saved-tab").getAttribute("aria-current"), "page");
  assert.match(ui.$("saved-links-library").textContent, /shared across accounts/); assert.match(ui.$("saved-links-library").textContent, /may have been revoked/);
  assert.equal(ui.$("saved-links-list").children.length, 2); assert.match(ui.$("saved-links-list").textContent, /Saved title/);
  ui.input("saved-links-search", "SIGNALS"); assert.equal(ui.$("saved-links-list").children.length, 1);
  ui.input("saved-links-search", "no matches"); assert.match(ui.$("saved-links-status").textContent, /No saved links match/);
  ui.input("saved-links-search", ""); ui.input("saved-links-folder", "unfiled", "change"); assert.equal(ui.$("saved-links-list").children.length, 1);
  ui.input("saved-links-folder", "folder:Signals", "change"); ui.manage();
  assert.equal(ui.$("saved-link-name").textContent, "Older trend title"); ui.input("saved-link-folder", "New folder"); ui.confirm();
  await until(() => !ui.$("saved-link-dialog").open, "moved link"); assert.equal(ui.store.getLink(id).folder, "New folder");
  assert.equal(ui.w.document.activeElement.dataset.savedLink, id, "Move restores focus to the replacement manage control");
  assert.equal(ui.$("saved-links-folder").value, "", "An absent folder filter must not strand the list");
  ui.manage(); ui.$("saved-link-remove").click(); await until(() => !ui.$("saved-link-dialog").open, "removed link");
  assert.equal(ui.store.listLinks().links.length, 1); assert.equal(ui.store.getLink(other).saved_title, "Other research");
  assert.equal(ui.w.document.activeElement, ui.$("saved-links-search"), "Removal returns focus to a stable library control");
  assert.equal(ui.calls.filter((call) => call.path.includes("/public/")).length, 0);
  await ui.navigate("#discover"); assert.equal(ui.$("saved-links-library").hidden, true); assert.equal(ui.$("discover-public").hidden, false);
});

test("saved link opens the live public route; revoked snapshots never display cached title or source as public", async (t) => {
  const ui = await boot(t, { hash: "#discover/saved", seed: (store) => store.saveLink({ publication_id: id, saved_title: "Old title", folder: "Archived" }),
    handle: (call) => call.path.endsWith(id) ? reply({ detail: "Unavailable" }, 404) : undefined });
  const link = ui.$("saved-links-list").querySelector("a"); assert.equal(link.hash, `#public/${id}`);
  link.click(); await until(() => ui.$("public-status").textContent.includes("revoked"), "revocation");
  assert.equal(ui.$("public-content").hidden, true); assert.equal(ui.$("public-source").textContent, "");
  assert.equal(ui.$("public-title").textContent, "Public strategy"); assert.equal(ui.$("public-save-status").textContent, "");
  assert.equal(ui.store.getLink(id).saved_title, "Old title"); assert.equal(ui.reads().length, 1);
  await ui.navigate("#discover/saved"); ui.manage(); ui.$("saved-link-remove").click();
  await until(() => !ui.$("saved-link-dialog").open, "remove unavailable link"); assert.match(ui.$("saved-links-status").textContent, /No links saved/);
});

test("public titles preserve 120 emoji and render hostile saved metadata as inert text", async (t) => {
  const title = "😀".repeat(120), ui = await boot(t, { snapshot: fixture({ title }) });
  await saved(ui); assert.equal(ui.store.getLink(id).saved_title, title); await ui.navigate("#discover/saved");
  assert.equal(ui.$("saved-links-list").querySelector("a").textContent, title);
  const attack = '<img src=x onerror="window.attack=true">';
  ui.store.saveLink({ publication_id: other, saved_title: attack, folder: attack });
  ui.$("saved-links-retry").click(); assert.equal(ui.$("saved-links-list").querySelectorAll("img,script").length, 0); assert.equal(ui.w.attack, undefined);
  ui.manage(other); assert.equal(ui.$("saved-link-name").textContent, attack); assert.equal(ui.$("saved-link-dialog").querySelectorAll("img,script").length, 0);
});

for (const close of ["saved-link-close", "saved-link-cancel", "escape"]) test(`${close} leaves storage unchanged and an old close event cannot cancel a newer review`, async (t) => {
  const ui = await boot(t), before = ui.shared.snapshot(); ui.open();
  if (close === "escape") ui.$("saved-link-dialog").dispatchEvent(new ui.w.Event("cancel", { cancelable: true })); else ui.$(close).click();
  assert.equal(ui.$("saved-link-dialog").open, false); assert.deepEqual(ui.shared.snapshot(), before);
  ui.open(); ui.$("saved-link-dialog").dispatchEvent(new ui.w.Event("close")); ui.confirm();
  await until(() => !ui.$("saved-link-dialog").open, "new review saved"); assert.equal(ui.store.listLinks().links.length, 1);
});

test("quota failure keeps review for retry; invalid folder, missing lock and corrupted storage fail closed", async (t) => {
  const ui = await boot(t); ui.open(); const before = ui.shared.snapshot();
  ui.input("saved-link-folder", "nested/folder"); ui.confirm(); await until(() => !ui.$("saved-link-confirm").disabled, "invalid folder");
  assert.match(ui.status(), /single name/); assert.deepEqual(ui.shared.snapshot(), before);
  ui.input("saved-link-folder", "Valid"); ui.shared.failWrite = true; ui.confirm(); await until(() => !ui.$("saved-link-confirm").disabled, "quota failure");
  assert.match(ui.status(), /not changed/); assert.equal(ui.$("saved-link-folder").value, "Valid"); assert.deepEqual(ui.shared.snapshot(), before);
  ui.shared.failWrite = false; ui.confirm(); await until(() => !ui.$("saved-link-dialog").open, "retry saved");
  const blocked = await boot(t, { lock: null }); blocked.open(); blocked.confirm(); await until(() => /Web Locks/.test(blocked.status()), "lock error");
  assert.equal(blocked.shared.getItem(KEY), null);
  const broken = storage(); broken.setItem(KEY, "{broken");
  const bad = await boot(t, { shared: broken }); assert.equal(bad.$("public-save-link").disabled, true); assert.match(bad.$("public-save-status").textContent, /damaged/);
  await bad.navigate("#discover/saved"); assert.equal(bad.$("saved-links-retry").hidden, false); assert.equal(bad.$("saved-links-list").children.length, 0);
  bad.$("saved-links-retry").click(); assert.equal(broken.getItem(KEY), "{broken");
  broken.removeItem(KEY); bad.$("saved-links-retry").click(); assert.match(bad.$("saved-links-status").textContent, /No links saved/);
});

test("two tabs saving one publication keep one link and the first private folder", async (t) => {
  const shared = storage(), lock = locks(), first = await boot(t, { shared, lock }), second = await boot(t, { shared, lock });
  first.open(); second.open(); first.input("saved-link-folder", "First"); second.input("saved-link-folder", "Second"); first.confirm(); second.confirm();
  await until(() => !first.$("saved-link-dialog").open && !second.$("saved-link-dialog").open, "both saves");
  assert.equal(first.store.listLinks().links.length, 1); assert.equal(first.store.getLink(id).folder, "First");
  assert.match(second.$("status").textContent, /existing private folder was kept/);
  assert.equal(first.reads().length, 1); assert.equal(second.reads().length, 1);
});

test("concurrent move and remove reviews reject stale revisions and recreated links", async (t) => {
  const shared = storage(), lock = locks(), seed = (store) => store.saveLink({ publication_id: id, saved_title: "Saved title", folder: "First" });
  const first = await boot(t, { shared, lock, hash: "#discover/saved", seed }), second = await boot(t, { shared, lock, hash: "#discover/saved" });
  first.manage(); second.manage(); first.input("saved-link-folder", "Changed"); first.confirm(); await until(() => !first.$("saved-link-dialog").open, "first move");
  second.$("saved-link-remove").click(); await until(() => /another tab/.test(second.status()), "stale remove"); assert.equal(second.store.getLink(id).folder, "Changed");
  second.$("saved-link-cancel").click(); second.manage(); const record = first.store.getLink(id);
  first.store.removeLink(id, { expected_updated_at: record.updated_at }); first.store.saveLink({ publication_id: id, saved_title: "Saved again", folder: "Recreated" });
  second.$("saved-link-remove").click(); await until(() => /another tab/.test(second.status()), "recreated stale remove"); assert.equal(second.store.getLink(id).folder, "Recreated");
});

for (const mode of ["cancel", "route", "user", "org", "refresh", "folder"]) test(`queued ${mode} invalidation prevents any stale write`, async (t) => {
  const lock = locks(), gate = deferred(), held = lock.request("veyra.workspace.v1", { mode: "exclusive" }, () => gate.promise);
  const ui = await boot(t, { lock }); ui.open(); ui.input("saved-link-folder", "Queued"); ui.confirm();
  ui.$("saved-link-form").dispatchEvent(new ui.w.Event("submit", { bubbles: true, cancelable: true })); assert.equal(lock.calls.length, 2, "Double submit must not queue again");
  if (mode === "cancel") ui.$("saved-link-cancel").click();
  else if (mode === "route") ui.w.location.hash = "#discover/saved";
  else if (mode === "user" || mode === "org") ui.w.fixtureState[mode] = "new synthetic account";
  else if (mode === "refresh") ui.w.recheckPublic(id);
  else ui.input("saved-link-folder", "Changed while queued");
  gate.resolve(); await held; await delay(20);
  assert.equal(ui.shared.getItem(KEY), null, "Canceled queued work must not save any metadata");
  if (ui.$("saved-link-dialog").open) ui.$("saved-link-cancel").click();
  if (mode === "route") await ui.navigate(`#public/${id}`);
  await saved(ui, "Fresh review"); assert.equal(ui.store.getLink(id).folder, "Fresh review");
});

for (const mode of ["move", "remove"]) test(`queued ${mode} review cancellation preserves the original record`, async (t) => {
  const lock = locks(), gate = deferred(), held = lock.request("veyra.workspace.v1", { mode: "exclusive" }, () => gate.promise);
  const ui = await boot(t, { lock, hash: "#discover/saved", seed: (store) => store.saveLink({ publication_id: id, saved_title: "Saved", folder: "Original" }) });
  const before = ui.shared.snapshot(); ui.manage(); ui.input("saved-link-folder", "Changed");
  if (mode === "remove") ui.$("saved-link-remove").click(); else ui.confirm();
  ui.$("saved-link-cancel").click(); gate.resolve(); await held; await delay(20); assert.deepEqual(ui.shared.snapshot(), before);
});

test("late completion cannot close or overwrite a newer review", async (t) => {
  const gate = deferred(); let written = false;
  const lock = { async request(_name, _options, operation) { const result = operation(); written = true; await gate.promise; return result; } };
  const ui = await boot(t, { lock }); ui.open(); ui.confirm(); await until(() => written, "atomic save");
  ui.$("saved-link-cancel").click(); ui.open(); ui.input("saved-link-folder", "New review"); const currentStatus = ui.status();
  gate.resolve(); await delay(20);
  assert.equal(ui.$("saved-link-dialog").open, true); assert.equal(ui.$("saved-link-folder").value, "New review"); assert.equal(ui.status(), currentStatus);
});

test("storage refresh and history navigation stay local and never restore cached public source", async (t) => {
  const ui = await boot(t, { hash: "#discover/saved" }); assert.match(ui.$("saved-links-status").textContent, /No links saved/);
  ui.store.saveLink({ publication_id: id, saved_title: "Stored elsewhere", folder: "Remote tab" });
  ui.w.dispatchEvent(new ui.w.StorageEvent("storage", { key: KEY })); assert.equal(ui.$("saved-links-list").children.length, 1);
  ui.shared.failRead = true; ui.w.dispatchEvent(new ui.w.StorageEvent("storage", { key: KEY })); assert.match(ui.$("saved-links-status").textContent, /Could not read/);
  ui.shared.failRead = false; ui.$("saved-links-retry").click(); assert.equal(ui.$("saved-links-list").children.length, 1);
  await ui.navigate(`#public/${id}`); await until(() => !ui.$("public-content").hidden, "public open");
  ui.w.history.back(); await until(() => !ui.$("saved-links-library").hidden && ui.w.location.hash === "#discover/saved", "back to saved");
  assert.equal(ui.$("public-source").textContent, "");
  ui.w.history.forward(); await until(() => !ui.$("public-content").hidden && ui.w.location.hash === `#public/${id}`, "forward rechecks public");
  assert.equal(ui.reads().length, 2); assert.equal(ui.calls.filter((call) => call.path.includes("/public/strategies?")).length, 0);
});

test("cancel restores focus after another tab rerenders the library, without stealing focus after navigation", async (t) => {
  const ui = await boot(t, { hash: "#discover/saved", seed: (store) => store.saveLink({ publication_id: id, saved_title: "Saved", folder: "First" }) });
  ui.manage(); const oldTrigger = ui.$("saved-links-list").querySelector("button");
  ui.w.dispatchEvent(new ui.w.StorageEvent("storage", { key: KEY })); assert.equal(oldTrigger.isConnected, false);
  ui.$("saved-link-cancel").click(); assert.equal(ui.w.document.activeElement.dataset.savedLink, id);
  ui.manage(); const link = ui.store.getLink(id); ui.store.removeLink(id, { expected_updated_at: link.updated_at });
  ui.w.dispatchEvent(new ui.w.StorageEvent("storage", { key: KEY }));
  ui.$("saved-link-cancel").click(); assert.equal(ui.w.document.activeElement, ui.$("saved-links-search"));
  ui.store.saveLink({ publication_id: id, saved_title: "Saved again", folder: "" });
  ui.w.dispatchEvent(new ui.w.StorageEvent("storage", { key: KEY })); ui.manage();
  ui.w.location.hash = "#discover"; ui.$("discover-search").focus(); ui.$("saved-link-cancel").click();
  assert.equal(ui.w.document.activeElement, ui.$("discover-search"), "A stale review cannot focus an old route's controls");
});
