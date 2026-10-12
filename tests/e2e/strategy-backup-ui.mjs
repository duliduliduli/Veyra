// Isolated DOM checks: synthetic fixtures, no browser launch, server, upload or Python execution.
// NODE_PATH=/path/to/jsdom/node_modules node --test tests/e2e/strategy-backup-ui.mjs
// shortcut: native dialog focus and visual layout need separately authorized browser QA.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "workspace-store.js", "studio-assistant.js", "report-evidence.js", "proposal-diff.js", "strategy-backup.js", "saved-links.js", "app.js"]
  .map((name) => readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
const plain = (value) => JSON.parse(JSON.stringify(value));
const fixture = (overrides = {}) => ({ format: "veyra-strategy-snapshot", schema_version: 1,
  name: "Private snapshot", description: "Synthetic test fixture", folder: "Research",
  files: { "strategy.py": "from signals.entry import value\n", "signals/entry.py": "value = '☀'\n", "signals/empty.py": "" },
  entrypoint: "signals/entry.py", has_unsaved_changes: true, ...overrides });
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function until(condition, label) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail(`Timed out waiting for ${label}`);
}
function storage() {
  const values = new Map();
  return { failWrite: false, get length() { return values.size; }, key: (i) => [...values.keys()][i],
    getItem: (key) => values.get(key) ?? null, removeItem: (key) => values.delete(key),
    setItem(key, value) { if (this.failWrite) throw new Error("Storage blocked"); values.set(key, String(value)); },
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
async function boot(t, { user = false, shared = storage(), lock = locks(), seed, remote } = {}) {
  const errors = [], calls = [], downloads = [], blobs = new Map();
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: "https://veyra.test/#code", runScripts: "outside-only", virtualConsole });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  t.after(() => { w.close(); assert.deepEqual(errors, [], "No uncaught DOM errors"); });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  Object.defineProperty(w, "localStorage", { value: shared });
  if (lock) Object.defineProperty(w.navigator, "locks", { value: lock });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  w.URL.createObjectURL = (blob) => { const url = `blob:https://veyra.test/${blobs.size}`; blobs.set(url, blob); return url; };
  w.URL.revokeObjectURL = (url) => blobs.delete(url);
  w.document.addEventListener("click", (e) => {
    const link = e.target.closest("a[download]");
    if (link) { e.preventDefault(); downloads.push({ name: link.download, blob: blobs.get(link.href) }); }
  });
  if (user) shared.setItem("veyra.user", "fixture-user");
  w.fetch = async (path, options = {}) => {
    const call = { path, method: options.method || "GET", body: options.body };
    calls.push(call);
    const reply = (data) => ({ ok: true, json: async () => plain(data) });
    if (path === "/v1/catalog/datasets") return reply({ datasets: [] });
    if (user && path === "/v1/me") return reply({ organizations: [{ id: "fixture-org" }] });
    if (user && path.endsWith("/billing/balance")) return reply({ available_nano: 0 });
    if (user && path === "/v1/orgs/fixture-org/projects") return reply({ projects: remote ? [remote] : [], has_more: false, next_cursor: null });
    if (remote && path === `/v1/projects/${remote.id}`) return reply(remote);
    if (remote && path === `/v1/projects/${remote.id}/versions/1`) return reply(remote.versions[0]);
    errors.push(`Unexpected API call: ${call.method} ${path}`);
    return { ok: false, status: 500, json: async () => ({ detail: "Unexpected test request" }) };
  };
  scripts.slice(0, -1).forEach((script) => w.eval(script));
  const store = w.VeyraWorkspaceStore.create(shared), seeded = seed?.(store, w);
  w.eval(scripts.at(-1));
  await until(() => !$("view-code").hidden && $("workspace-mode").textContent, "Studio boot");
  const input = (id, value, type = "input") => { $(id).value = value; $(id).dispatchEvent(new w.Event(type, { bubbles: true })); };
  const select = (source, read) => {
    const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
    const file = { size: bytes.length, arrayBuffer: read || (async () => new w.Uint8Array(bytes).buffer), text() { assert.fail("Must read strict bytes, never File.text()"); } };
    Object.defineProperty($("strategy-import-file"), "files", { configurable: true, value: [file] });
    $("strategy-import-file").dispatchEvent(new w.Event("change"));
    return file;
  };
  const open = () => $("import-strategy").click();
  const confirm = () => $("confirm-strategy-import").click();
  async function preview(value = fixture()) {
    open(); select(JSON.stringify(value));
    await until(() => !$("strategy-import-preview").hidden, "snapshot preview");
  }
  async function navigate(hash) {
    w.location.hash = hash;
    await until(() => !$(`view-${hash.slice(1).split("/")[0]}`).hidden, `route ${hash}`);
    await delay(10);
  }
  return { w, $, shared, lock, store, seeded, calls, downloads, input, select, open, confirm, preview, navigate };
}
async function openProject(ui, id) {
  await ui.navigate(`#project/${id}`);
  await until(() => !ui.$("editor").disabled, "editor");
}
async function blobText(ui, blob) {
  return new Promise((resolve, reject) => {
    const reader = new ui.w.FileReader();
    reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}
const waitImported = (ui, name = "Private snapshot") => until(() => ui.$("project-title").textContent === name && !ui.$("editor").disabled, "imported copy");

test("HTML loads the contract before the app and gives private source/import disclosures", () => {
  assert.ok(html.indexOf('src="strategy-backup.js"') < html.indexOf('src="app.js'));
  assert.match(html, /complete private source, including unsaved edits in every file/);
  assert.match(html, /No source is uploaded or executed/);
  assert.match(html, /Previous versions, run history and other device drafts are not included/);
});

test("download preserves all current files, unsaved edits, empty files and entrypoint without saving", async (t) => {
  const snapshot = fixture();
  const ui = await boot(t, { seed: (store) => store.createProject(snapshot) });
  await openProject(ui, ui.seeded.id);
  ui.input("editor", "value = 'unsaved active helper'\n");
  ui.input("editor-file", "strategy.py", "change");
  ui.input("editor", "# unsaved entrypoint\r\n");
  const before = ui.shared.snapshot();
  ui.$("download-snapshot").click();
  assert.equal(ui.downloads.length, 1);
  const downloaded = JSON.parse(await blobText(ui, ui.downloads[0].blob));
  assert.equal(downloaded.has_unsaved_changes, true);
  assert.deepEqual(downloaded.files, { ...snapshot.files, "strategy.py": "# unsaved entrypoint\n", "signals/entry.py": "value = 'unsaved active helper'\n" });
  assert.equal(downloaded.entrypoint, "signals/entry.py");
  assert.equal(ui.downloads[0].name, "veyra-strategy-snapshot.json");
  assert.equal(ui.downloads[0].blob.type, "application/json");
  assert.deepEqual(ui.shared.snapshot(), before, "Export never mutates versions or drafts");
  assert.deepEqual(ui.calls.map(({ path }) => path), ["/v1/catalog/datasets"]);
  assert.equal(ui.store.getProject(ui.seeded.id).latest_version_no, 1);
});


test("opening and switching files does not normalize unedited CRLF source during export", async (t) => {
  const data = fixture({ files: { "strategy.py": "# keep exact\r\n\t\r\n", "signals/entry.py": "# also exact\r\n" }, has_unsaved_changes: false });
  const ui = await boot(t, { seed: (store) => store.createProject(data) });
  await openProject(ui, ui.seeded.id);
  ui.input("editor-file", "strategy.py", "change");
  ui.$("download-snapshot").click();
  assert.deepEqual(JSON.parse(await blobText(ui, ui.downloads[0].blob)), data);
});

test("download of a connected saved strategy selects portable fields without sharing IDs or history", async (t) => {
  const data = fixture({ has_unsaved_changes: false });
  const remote = { ...data, id: "cloud-private", org_id: "private-org", visibility: "private", share_token: "fixture-token",
    versions: [{ id: "private-version", version_no: 1, files: data.files, entrypoint: data.entrypoint }] };
  const ui = await boot(t, { user: true, remote });
  await openProject(ui, remote.id);
  const before = ui.calls.length;
  ui.$("download-snapshot").click();
  assert.deepEqual(JSON.parse(await blobText(ui, ui.downloads[0].blob)), data);
  assert.equal(ui.calls.length, before, "Export is purely local even for a connected strategy");
});

test("export failures preserve oversized current source and unsupported old metadata", async (t) => {
  const ui = await boot(t, { seed: (store) => store.createProject(fixture({ folder: "." })) });
  await openProject(ui, ui.seeded.id);
  const original = ui.shared.snapshot();
  ui.$("download-snapshot").click();
  assert.match(ui.$("status").textContent, /Snapshot not downloaded.*Folder/);
  assert.equal(ui.downloads.length, 0);
  assert.deepEqual(ui.shared.snapshot(), original);
  ui.store.updateProject(ui.seeded.id, { folder: "Supported" });
  await ui.navigate("#code"); await openProject(ui, ui.seeded.id);
  const code = "#".repeat(256 * 1024 + 1);
  ui.input("editor", code);
  const edited = ui.shared.snapshot();
  ui.$("download-snapshot").click();
  assert.match(ui.$("status").textContent, /Snapshot not downloaded.*size limit/);
  assert.equal(ui.$("editor").value, code);
  assert.equal(ui.downloads.length, 0);
  assert.deepEqual(ui.shared.snapshot(), edited);
});

test("import previews exact files and creates a fresh private local v1 only after explicit confirmation", async (t) => {
  const ui = await boot(t), data = fixture();
  await ui.preview(data);
  assert.equal(ui.store.listProjects().projects.length, 0);
  assert.equal(ui.$("strategy-import-name").value, data.name);
  assert.match(ui.$("strategy-import-details").textContent, /Research.*signals\/entry.py.*3 Python files.*Includes unsaved edits/);
  assert.deepEqual([...ui.$("strategy-import-files").children].map((n) => n.textContent), Object.keys(data.files));
  assert.match(ui.$("strategy-import-status").textContent, /No strategy has been created/);
  ui.confirm(); await waitImported(ui);
  const id = ui.w.location.hash.slice(9), p = ui.store.getProject(id);
  assert.match(id, /^local-/); assert.equal(p.visibility, "private"); assert.equal(p.latest_version_no, 1);
  assert.equal(p.description, data.description);
  assert.equal(p.folder, data.folder);
  assert.deepEqual(plain(p.versions[0].files), data.files);
  assert.equal(p.versions[0].entrypoint, data.entrypoint);
  assert.equal(ui.$("draft-state").textContent, "Saved");
  assert.match(ui.$("status").textContent, /private device copy.*saved v1/);
  assert.match(ui.$("project-storage").textContent, /device-local.*browser only/);
  assert.deepEqual(ui.lock.calls, [{ name: "veyra.workspace.v1", mode: "exclusive" }]);
  assert.deepEqual(ui.calls.map(({ path }) => path), ["/v1/catalog/datasets"]);
  assert.equal(ui.$("strategy-import-dialog").open, false);
});

test("connected-account import never uses cloud POST and opens the private device copy", async (t) => {
  const ui = await boot(t, { user: true });
  await ui.preview(fixture({ has_unsaved_changes: false }));
  assert.match(ui.$("strategy-import-details").textContent, /No unsaved edits reported/);
  const requests = ui.calls.length;
  ui.confirm(); await waitImported(ui);
  assert.equal(ui.calls.length, requests);
  assert.ok(ui.calls.every((c) => c.method === "GET"));
  assert.match(ui.w.location.hash, /#project\/local-/);
  for (const control of ui.$("quote-form").querySelectorAll("input, select, button")) assert.equal(control.disabled, true);
});

test("name collision keeps preview, supports rename, and never overwrites existing versions or drafts", async (t) => {
  const ui = await boot(t, { seed: (store, w) => {
    const p = store.createProject(fixture());
    store.saveVersion(p.id, { files: { "strategy.py": "# older saved revision\n" }, expected_version_no: 1 });
    w.localStorage.setItem(`veyra.draft.${p.id}.other-tab`, '{"files":{"strategy.py":"# private draft"}}');
    return p;
  } });
  const old = plain(ui.store.getProject(ui.seeded.id)), before = ui.shared.snapshot();
  await ui.preview(); ui.confirm();
  await until(() => /already exists/.test(ui.$("strategy-import-status").textContent), "collision");
  assert.equal(ui.$("strategy-import-preview").hidden, false);
  assert.equal(ui.$("confirm-strategy-import").disabled, false);
  assert.equal(ui.w.document.activeElement, ui.$("strategy-import-name"));
  assert.deepEqual(ui.shared.snapshot(), before);
  ui.input("strategy-import-name", "Renamed private copy"); ui.confirm(); await waitImported(ui, "Renamed private copy");
  assert.deepEqual(plain(ui.store.getProject(ui.seeded.id)), old);
  assert.equal(ui.shared.getItem(`veyra.draft.${ui.seeded.id}.other-tab`), before[`veyra.draft.${ui.seeded.id}.other-tab`]);
  assert.equal(ui.store.listProjects().projects.length, 2);
});

test("storage failure retains preview and can retry without a false success or data loss", async (t) => {
  const ui = await boot(t);
  await ui.preview(); const before = ui.shared.snapshot(); ui.shared.failWrite = true; ui.confirm();
  await until(() => /not saved/.test(ui.$("strategy-import-status").textContent), "storage failure");
  assert.equal(ui.$("strategy-import-preview").hidden, false);
  assert.equal(ui.$("confirm-strategy-import").disabled, false);
  assert.equal(ui.w.location.hash, "#code"); assert.deepEqual(ui.shared.snapshot(), before);
  assert.doesNotMatch(ui.$("status").textContent, /Created/);
  ui.shared.failWrite = false; ui.confirm(); await waitImported(ui);
  assert.equal(ui.store.listProjects().projects.length, 1);
});

test("missing Web Locks fails closed with preview intact and zero storage writes", async (t) => {
  const ui = await boot(t, { lock: null }); await ui.preview(); const before = ui.shared.snapshot();
  ui.confirm(); await until(() => /Web Locks/.test(ui.$("strategy-import-status").textContent), "lock error");
  assert.deepEqual(ui.shared.snapshot(), before);
  assert.equal(ui.$("strategy-import-preview").hidden, false);
  assert.equal(ui.$("confirm-strategy-import").disabled, false);
});

test("malformed and oversized bytes are rejected before preview without falling back to File.text", async (t) => {
  const ui = await boot(t); ui.open();
  const invalid = [new Uint8Array([0xff]), new TextEncoder().encode('{"format":"duplicate","format":"again"}'),
    new TextEncoder().encode(JSON.stringify({ ...fixture(), owner_id: "authority" })),
    new TextEncoder().encode(JSON.stringify(fixture({ files: { "../unsafe.py": "# no" }, entrypoint: "../unsafe.py" })))];
  for (const bytes of invalid) {
    ui.select(bytes);
    await until(() => !/^Reading/.test(ui.$("strategy-import-status").textContent), "invalid bytes");
    assert.equal(ui.$("strategy-import-preview").hidden, true);
    assert.equal(ui.$("confirm-strategy-import").disabled, true);
  }
  ui.select(new Uint8Array(2 * 1024 * 1024 + 1), () => assert.fail("Oversized files must not be read"));
  assert.match(ui.$("strategy-import-status").textContent, /2 MiB/);
  assert.equal(ui.store.listProjects().projects.length, 0);
});

test("untrusted metadata is display text and imported source is never evaluated", async (t) => {
  const ui = await boot(t), name = '<img src=x onerror="window.injected=true">';
  await ui.preview(fixture({ name, folder: "<b>Private</b>".replaceAll("/", ""), files: { "strategy.py": "throw new Error('must never execute');" }, entrypoint: "strategy.py" }));
  assert.equal(ui.$("strategy-import-dialog").querySelectorAll("img, b").length, 0);
  assert.equal(ui.w.injected, undefined); assert.equal(ui.$("strategy-import-name").value, name);
  ui.confirm(); await waitImported(ui, name);
  assert.equal(ui.$("project-title").querySelectorAll("img").length, 0);
  assert.equal(ui.$("editor").value, "throw new Error('must never execute');");
});

test("a newer file wins over a slower read or an older read error", async (t) => {
  for (const reject of [false, true]) {
    const ui = await boot(t), slow = deferred(); ui.open();
    ui.select("old", () => slow.promise);
    ui.select(JSON.stringify(fixture({ name: "Newest" })));
    await until(() => ui.$("strategy-import-name").value === "Newest", "newest preview");
    const status = ui.$("strategy-import-status").textContent;
    if (reject) slow.reject(new Error("Stale read failed"));
    else slow.resolve(new ui.w.Uint8Array(new TextEncoder().encode(JSON.stringify(fixture({ name: "Stale" })))).buffer);
    await delay(20);
    assert.equal(ui.$("strategy-import-name").value, "Newest");
    assert.equal(ui.$("strategy-import-status").textContent, status);
    assert.equal(ui.store.listProjects().projects.length, 0);
  }
});

test("Close, Cancel, Escape and newer navigation invalidate pending reads", async (t) => {
  for (const action of ["close-strategy-import", "cancel-strategy-import", "escape", "navigation"]) {
    const ui = await boot(t), slow = deferred(); ui.open(); ui.select("old", () => slow.promise);
    if (action === "escape") ui.$("strategy-import-dialog").dispatchEvent(new ui.w.Event("cancel", { cancelable: true }));
    else if (action === "navigation") await ui.navigate("#wallet");
    else ui.$(action).click();
    slow.resolve(new ui.w.Uint8Array(new TextEncoder().encode(JSON.stringify(fixture()))).buffer);
    await delay(20);
    assert.equal(ui.$("strategy-import-dialog").open, false);
    assert.equal(ui.$("strategy-import-preview").hidden, true);
    assert.equal(ui.store.listProjects().projects.length, 0);
    assert.doesNotMatch(ui.$("status").textContent, /Created/);
  }
});

test("cancel then reopen ignores late native close events and allows a fresh preview", async (t) => {
  const ui = await boot(t); await ui.preview(); ui.$("cancel-strategy-import").click();
  await ui.preview(fixture({ name: "Fresh preview" }));
  ui.$("strategy-import-dialog").dispatchEvent(new ui.w.Event("close"));
  assert.equal(ui.$("strategy-import-dialog").open, true);
  assert.equal(ui.$("strategy-import-name").value, "Fresh preview");
  ui.confirm(); await waitImported(ui, "Fresh preview");
});

test("duplicate confirmation while a local lock is held makes exactly one new copy", async (t) => {
  const lock = locks(), gate = deferred();
  const held = lock.request("veyra.workspace.v1", { mode: "exclusive" }, () => gate.promise);
  const ui = await boot(t, { lock }); await ui.preview(); ui.confirm();
  ui.$("strategy-import-form").dispatchEvent(new ui.w.Event("submit", { cancelable: true }));
  assert.equal(ui.$("confirm-strategy-import").disabled, true);
  assert.equal(ui.$("strategy-import-file").disabled, true);
  assert.equal(ui.store.listProjects().projects.length, 0);
  gate.resolve(); await held; await waitImported(ui);
  assert.equal(ui.store.listProjects().projects.length, 1);
  assert.equal(lock.calls.length, 2, "One pre-existing holder plus one import");
});

test("cancelled queued writes never create copies or affect a second import", async (t) => {
  const lock = locks(), gate = deferred();
  const held = lock.request("veyra.workspace.v1", { mode: "exclusive" }, () => gate.promise);
  const ui = await boot(t, { lock }); await ui.preview(fixture({ name: "Cancelled" })); ui.confirm();
  ui.$("cancel-strategy-import").click();
  await ui.preview(fixture({ name: "Current" })); ui.confirm();
  gate.resolve(); await held; await waitImported(ui, "Current");
  assert.deepEqual(plain(ui.store.listProjects().projects.map((p) => p.name)), ["Current"]);
});

test("navigation away and back cancels a queued write even at the same eventual route", async (t) => {
  const lock = locks(), gate = deferred();
  const held = lock.request("veyra.workspace.v1", { mode: "exclusive" }, () => gate.promise);
  const ui = await boot(t, { lock }); await ui.preview(); ui.confirm();
  await ui.navigate("#wallet"); await ui.navigate("#code");
  gate.resolve(); await held; await delay(20);
  assert.equal(ui.store.listProjects().projects.length, 0);
  assert.equal(ui.w.location.hash, "#code");
  assert.doesNotMatch(ui.$("status").textContent, /Created/);
});

test("late completion after the atomic write cannot navigate or overwrite a reopened dialog", async (t) => {
  const gate = deferred(); let written = false;
  const lock = { request: async (_name, _options, operation) => { const result = operation(); written = true; await gate.promise; return result; } };
  const ui = await boot(t, { lock }); await ui.preview(fixture({ name: "Already written" })); ui.confirm();
  await until(() => written, "atomic store write");
  await ui.navigate("#wallet"); await ui.navigate("#code");
  await ui.preview(fixture({ name: "New preview" }));
  gate.resolve(); await delay(20);
  assert.equal(ui.w.location.hash, "#code");
  assert.equal(ui.$("strategy-import-dialog").open, true);
  assert.equal(ui.$("strategy-import-name").value, "New preview");
  assert.match(ui.$("strategy-import-status").textContent, /No strategy has been created/);
  assert.doesNotMatch(ui.$("status").textContent, /Created/);
  assert.deepEqual(plain(ui.store.listProjects().projects.map((p) => p.name)), ["Already written"]);
});

test("two tabs import under one shared lock and resolve name collisions without lost data", async (t) => {
  const shared = storage(), lock = locks();
  const first = await boot(t, { shared, lock }), second = await boot(t, { shared, lock });
  await first.preview(); await second.preview(); first.confirm(); second.confirm();
  await waitImported(first);
  await until(() => /already exists/.test(second.$("strategy-import-status").textContent), "cross-tab collision");
  assert.equal(first.store.listProjects().projects.length, 1);
  second.input("strategy-import-name", "Second tab copy"); second.confirm(); await waitImported(second, "Second tab copy");
  assert.equal(first.store.listProjects().projects.length, 2);
  for (const p of first.store.listProjects().projects) assert.equal(p.latest_version_no, 1);
});
