// Offline cloud-copy contract: inert Python strings, intercepted APIs, no strategy execution.
// NODE_PATH=/path/to/jsdom/node_modules node --test tests/e2e/reviewed-cloud-copy-ui.mjs
// shortcut: native modal focus, layout and real backend integration need authorized browser/server QA.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "workspace-store.js", "studio-assistant.js", "report-evidence.js", "proposal-diff.js", "strategy-backup.js", "saved-links.js", "app.js"]
  .map((name) => readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
const files = { "strategy.py": "# π 😀\r\n\tvalue = 1\r\nlast\r", "helpers/entry.py": "# inert\n<svg onload=window.unsafe=true>\u00a0", "helpers/empty.py": "" };
const orgId = "30000000-0000-4000-8000-000000000001", cloudId = "40000000-0000-4000-8000-000000000001";
const me = { user_id: "20000000-0000-4000-8000-000000000001", subject: "owner@example.test", organizations: [{ id: orgId, name: "Private research team", role: "owner" }] };
const inputProject = (extra = {}) => ({ name: "Device strategy", description: "Private notes", folder: "Research", files, entrypoint: "helpers/entry.py", ...extra });
const plain = (value) => JSON.parse(JSON.stringify(value));
const reply = (value, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => plain(value) });
const created = (body) => ({ ...body, id: cloudId, org_id: orgId, created_by: me.user_id, latest_version: { id: "50000000-0000-4000-8000-000000000001", project_id: cloudId,
  version_no: 1, entrypoint: body.entrypoint, content_hash: `sha256:${"a".repeat(64)}` } });
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function until(condition, label) { for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); } assert.fail(`Timed out: ${label}`); }
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function boot(t, { connected = true, seed, handle } = {}) {
  const errors = [], calls = [], closes = [], storage = new Map(), locks = [];
  const shared = { get length() { return storage.size; }, key: (i) => [...storage.keys()][i], getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k), snapshot: () => Object.fromEntries(storage) };
  const virtualConsole = new VirtualConsole(); virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: "https://veyra.test/#code/device", runScripts: "outside-only", virtualConsole });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  t.after(() => { w.close(); assert.deepEqual(errors, [], "No uncaught errors or unexpected requests"); });
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
  w.eval(`${scripts.at(-1)}\nwindow.fixtureState = state;`);
  await until(() => !$("view-code").hidden && $("workspace-mode").textContent, "boot");
  const input = (id, value, type = "input") => { $(id).value = value; $(id).dispatchEvent(new w.Event(type, { bubbles: true })); };
  async function open(id = seeded.id) { w.location.hash = `#project/${id}`; await until(() => w.fixtureState.project?.id === id && !$("editor").disabled, "editor"); }
  async function history() { $("project-history").click(); await until(() => !$("history-snapshot").hidden, "history"); }
  async function select(number) { input("history-version", String(number), "change"); await until(() => !$("history-snapshot").hidden, "selected source"); }
  async function review() { $("review-cloud-copy").click(); await until(() => !$("cloud-copy-status").textContent.startsWith("Checking") && $("cloud-copy-status").textContent, "cloud review"); }
  const submit = () => $("cloud-copy-form").dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
  const writes = () => calls.filter((c) => c.method !== "GET");
  const flushCloses = () => { for (const close of closes.splice(0)) close(); };
  return { w, $, shared, store, seeded, locks, calls, input, open, history, select, review, submit, writes, flushCloses };
}

test("review is accessible, scoped to saved source, and discloses workspace-member access", () => {
  assert.match(html, /id="review-cloud-copy"[^>]*aria-controls="cloud-copy-review"[^>]*aria-expanded="false"/);
  assert.match(html, /workspace members can read it/);
  assert.match(html, /Private means it is not publicly published/);
  assert.match(html, /id="cloud-copy-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /no history, account credentials, run results or publication settings are copied/);
});

test("connection, source browsing and review never upload; confirmation copies only the exact selected saved snapshot", async (t) => {
  const ui = await boot(t, { seed(store) { const p = store.createProject(inputProject()); store.saveVersion(p.id, { files: { "newer.py": "# newer" }, entrypoint: "newer.py", expected_version_no: 1 }); return p; } });
  await ui.open(); ui.input("editor", "# unsaved draft");
  ui.store.updateProject(ui.seeded.id, { name: "Current metadata", description: "Current private description", folder: "Current\u0085  folder" });
  const original = ui.shared.snapshot(), editor = plain(ui.w.fixtureState.project), hash = ui.w.location.hash;
  await ui.history(); await ui.select(1);
  ui.input("history-file", "strategy.py", "change");
  assert.equal(ui.$("history-source").textContent, files["strategy.py"]);
  ui.submit(); assert.deepEqual(ui.writes(), []);
  await ui.review();
  assert.deepEqual(ui.writes(), []);
  assert.match(ui.$("cloud-copy-details").textContent, /owner@example.test.*Private research team/s);
  assert.match(ui.$("cloud-copy-details").textContent, new RegExp(orgId));
  assert.match(ui.$("cloud-copy-details").textContent, /Saved v1.*helpers\/entry.py.*Current private description.*Current folder/s);
  ui.input("cloud-copy-name", "Reviewed new name"); ui.submit(); await settle();
  assert.equal(ui.writes().length, 1);
  assert.deepEqual(ui.writes()[0].body, { name: "Reviewed new name", description: "Current private description", folder: "Current folder", files, entrypoint: "helpers/entry.py", visibility: "private", template: null });
  assert.equal(ui.writes()[0].path, `/v1/orgs/${orgId}/projects`);
  assert.equal(ui.writes()[0].headers["x-veyra-dev-user"], "owner@example.test");
  assert.equal(ui.writes()[0].credentials, "same-origin");
  assert.match(ui.$("cloud-copy-status").textContent, /created at saved v1/);
  assert.equal(ui.$("cloud-copy-result").getAttribute("href"), `#project/${cloudId}`);
  assert.equal(ui.w.location.hash, hash, "Success never navigates away from a draft");
  assert.deepEqual(ui.shared.snapshot(), original); assert.deepEqual(plain(ui.w.fixtureState.project), editor); assert.deepEqual(ui.locks, []);
  ui.submit(); await settle(); assert.equal(ui.writes().length, 1, "Completed confirmation cannot be submitted twice");
});

test("all files are available as inert exact text, including empty and unusual Unicode source", async (t) => {
  const ui = await boot(t); await ui.open(); await ui.history(); await ui.review();
  assert.deepEqual([...ui.$("history-file-list").children].map((li) => li.textContent), Object.keys(files));
  for (const path of Object.keys(files)) { ui.input("history-file", path, "change"); assert.equal(ui.$("history-source").textContent, files[path]); }
  assert.equal(ui.$("strategy-history-dialog").querySelector("svg,script"), null); assert.equal(ui.w.unsafe, undefined);
  assert.deepEqual(ui.writes(), []);
});

test("disconnected device history is honest and cannot send even synthetic confirmation", async (t) => {
  const ui = await boot(t, { connected: false }); await ui.open(); await ui.history();
  assert.match(ui.$("cloud-copy-availability").textContent, /No cloud account\/workspace is connected/);
  assert.equal(ui.$("review-cloud-copy").disabled, true);
  ui.$("review-cloud-copy").dispatchEvent(new ui.w.Event("click")); ui.submit(); await settle();
  assert.deepEqual(ui.calls.map((c) => c.path), ["/v1/catalog/datasets"]);
});

for (const role of ["viewer", "billing_admin", "unknown", undefined]) test(`${role} destination never receives source`, async (t) => {
  const ui = await boot(t, { handle: (c) => c.path === "/v1/me" ? reply({ ...me, organizations: [{ ...me.organizations[0], role }] }) : undefined });
  await ui.open(); await ui.history(); await ui.review(); ui.submit(); await settle();
  assert.match(ui.$("cloud-copy-status").textContent, /cannot create strategies.*Nothing was uploaded/s);
  assert.equal(ui.$("confirm-cloud-copy").disabled, true); assert.deepEqual(ui.writes(), []);
});
for (const invalid of ["account", "subject", "workspace", "workspace name"]) test(`invalid ${invalid} blocks review before sending`, async (t) => {
  let gets = 0;
  const ui = await boot(t, { handle(c) {
    if (c.path !== "/v1/me" || ++gets === 1) return;
    const value = plain(me);
    if (invalid === "account") value.user_id = "unknown";
    if (invalid === "subject") value.subject = null;
    if (invalid === "workspace") value.organizations = [];
    if (invalid === "workspace name") value.organizations[0].name = "";
    return reply(value);
  } });
  await ui.open(); await ui.history(); await ui.review(); ui.submit();
  assert.match(ui.$("cloud-copy-status").textContent, /could not be verified/); assert.deepEqual(ui.writes(), []);
});

for (const [label, input] of [
  ["multiline name", { name: "line\nbreak" }], ["control metadata", { description: "private\0notes" }],
  ["invalid cloud folder", { folder: ".." }], ["legacy long path", { files: { [`${"a".repeat(254)}.py`]: "# inert" }, entrypoint: `${"a".repeat(254)}.py` }],
  ["outer server whitespace", { description: "\u0085Private notes" }],
]) test(`${label} is rejected without normalizing source or uploading`, async (t) => {
  const ui = await boot(t, { seed: (store) => store.createProject(inputProject(input)) });
  await ui.open(); await ui.history(); const before = ui.shared.snapshot(); await ui.review(); ui.submit();
  assert.match(ui.$("cloud-copy-status").textContent, /Copy review unavailable/); assert.deepEqual(ui.writes(), []); assert.deepEqual(ui.shared.snapshot(), before);
});

for (const changed of ["user", "org", "project", "route", "selected version", "selection without event", "close", "cancel", "cancel review"]) test(`${changed} before account lookup completes discards stale review`, async (t) => {
  const pending = deferred(); let gets = 0;
  const ui = await boot(t, { seed(store) { const p = store.createProject(inputProject()); store.saveVersion(p.id, { files, entrypoint: "strategy.py", expected_version_no: 1 }); return p; },
    handle: (c) => c.path === "/v1/me" && ++gets > 1 ? pending.promise : undefined });
  await ui.open(); await ui.history(); ui.$("review-cloud-copy").click();
  if (["user", "org"].includes(changed)) ui.w.fixtureState[changed] = "new-context";
  if (changed === "project") ui.w.fixtureState.project = { ...ui.w.fixtureState.project };
  if (changed === "route") ui.w.location.hash = "#code/device";
  if (changed === "selected version") await ui.select(1);
  if (changed === "selection without event") ui.$("history-version").value = "1";
  if (changed === "close") ui.$("close-strategy-history").click();
  if (changed === "cancel") ui.$("strategy-history-dialog").dispatchEvent(new ui.w.Event("cancel", { cancelable: true }));
  if (changed === "cancel review") ui.$("cancel-cloud-copy").click();
  pending.resolve(reply(me)); await settle(); ui.submit(); await settle();
  assert.equal(ui.$("confirm-cloud-copy").disabled, true); assert.deepEqual(ui.writes(), []);
});

for (const changed of ["user", "org", "project", "route", "selected version"]) test(`${changed} after review but before confirm cannot transmit`, async (t) => {
  const ui = await boot(t); await ui.open(); await ui.history(); await ui.review();
  if (["user", "org"].includes(changed)) ui.w.fixtureState[changed] = "new-context";
  if (changed === "project") ui.w.fixtureState.project = { ...ui.w.fixtureState.project };
  if (changed === "route") ui.w.location.hash = "#code/device";
  if (changed === "selected version") ui.$("history-version").replaceChildren();
  ui.submit(); await settle(); assert.deepEqual(ui.writes(), []);
});

for (const change of ["metadata", "same-id source", "invalid source", "blocked read"]) test(`changed ${change} is rechecked locally before upload`, async (t) => {
  const ui = await boot(t); await ui.open(); await ui.history(); await ui.review();
  if (change === "metadata") ui.store.updateProject(ui.seeded.id, { description: "Changed after review" });
  else if (change === "blocked read") ui.shared.getItem = () => { throw new Error("Unavailable"); };
  else { const data = JSON.parse(ui.shared.getItem("veyra.workspace.v1")); data.projects[0].versions[0].files["strategy.py"] = change === "invalid source" ? 123 : "# changed"; ui.shared.setItem("veyra.workspace.v1", JSON.stringify(data)); }
  const before = ui.shared.snapshot(); ui.submit(); await settle();
  assert.match(ui.$("cloud-copy-status").textContent, /Copy not created/); assert.deepEqual(ui.writes(), []); assert.deepEqual(ui.shared.snapshot(), before);
});

test("a newer saved version does not replace the reviewed older snapshot", async (t) => {
  const ui = await boot(t); await ui.open(); await ui.history(); await ui.review();
  ui.store.saveVersion(ui.seeded.id, { files: { "newer.py": "# newest" }, entrypoint: "newer.py", expected_version_no: 1 });
  ui.submit(); await settle(); assert.deepEqual(ui.writes()[0].body.files, files); assert.equal(ui.store.getProject(ui.seeded.id).latest_version_no, 2);
});

test("read-only browser storage still permits an explicit cloud copy without touching in-memory unsaved edits", async (t) => {
  const ui = await boot(t); await ui.open();
  ui.shared.setItem = () => { throw new Error("Storage is read-only"); }; ui.input("editor", "# only in memory");
  const before = ui.shared.snapshot(); await ui.history(); await ui.review(); ui.submit(); await settle();
  assert.match(ui.$("cloud-copy-status").textContent, /created at saved v1/); assert.equal(ui.$("editor").value, "# only in memory");
  assert.deepEqual(ui.shared.snapshot(), before); assert.deepEqual(ui.writes()[0].body.files, files);
});

test("double-submit and reopening while a sent request is pending do not send a second copy", async (t) => {
  const pending = deferred(); let sent;
  const ui = await boot(t, { handle: (c) => c.method === "POST" ? (sent = c.body, pending.promise) : undefined });
  await ui.open(); await ui.history(); await ui.review(); ui.submit(); ui.submit();
  assert.equal(ui.writes().length, 1); assert.equal(ui.$("confirm-cloud-copy").disabled, true);
  ui.$("close-strategy-history").click(); await ui.history(); await ui.review();
  assert.match(ui.$("cloud-copy-status").textContent, /earlier copy request is still pending/); ui.submit();
  const status = ui.$("cloud-copy-status").textContent;
  pending.resolve(reply(created(sent))); await settle(); ui.flushCloses();
  assert.equal(ui.$("strategy-history-dialog").open, true); assert.equal(ui.$("cloud-copy-status").textContent, status);
  assert.equal(ui.$("cloud-copy-result").hidden, true); assert.equal(ui.writes().length, 1);
});

for (const changed of ["close", "cancel", "cancel review", "route", "newer draft", "name", "user", "org", "selected version"]) test(`late successful creation preserves ${changed}`, async (t) => {
  const pending = deferred(); let body;
  const ui = await boot(t, { seed(store) { const p = store.createProject(inputProject()); store.saveVersion(p.id, { files, entrypoint: "strategy.py", expected_version_no: 1 }); return p; },
    handle: (c) => c.method === "POST" ? (body = c.body, pending.promise) : undefined });
  await ui.open(); await ui.history(); await ui.review(); ui.submit();
  if (changed === "close") ui.$("close-strategy-history").click();
  if (changed === "cancel") ui.$("strategy-history-dialog").dispatchEvent(new ui.w.Event("cancel", { cancelable: true }));
  if (changed === "cancel review") ui.$("cancel-cloud-copy").click();
  if (changed === "route") { ui.w.location.hash = "#code/device"; await delay(10); }
  if (changed === "newer draft") ui.input("editor", "# newer unsaved work");
  if (changed === "name") ui.input("cloud-copy-name", "Newer name");
  if (["user", "org"].includes(changed)) ui.w.fixtureState[changed] = "new-context";
  if (changed === "selected version") await ui.select(1);
  const hash = ui.w.location.hash, state = plain(ui.w.fixtureState.project), storage = ui.shared.snapshot(), status = ui.$("cloud-copy-status").textContent;
  pending.resolve(reply(created(body))); await settle();
  assert.equal(ui.w.location.hash, hash); assert.deepEqual(plain(ui.w.fixtureState.project), state); assert.deepEqual(ui.shared.snapshot(), storage);
  if (changed !== "newer draft") { assert.equal(ui.$("cloud-copy-status").textContent, status); assert.equal(ui.$("cloud-copy-result").hidden, true); }
  else assert.equal(ui.$("editor").value, "# newer unsaved work");
});

for (const failure of ["network", 408, 500, "malformed success", "wrong workspace", "wrong creator", "missing creator", "wrong visibility", "wrong version", "wrong metadata", "bad JSON"]) test(`${failure} is an uncertain outcome with no automatic retry`, async (t) => {
  const ui = await boot(t, { handle(c) {
    if (c.method !== "POST") return;
    if (failure === "network") throw new Error("Disconnected");
    if (typeof failure === "number") return reply({ detail: "Failed" }, failure);
    if (failure === "bad JSON") return { ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } };
    const value = created(c.body);
    if (failure === "malformed success") delete value.id;
    if (failure === "wrong workspace") value.org_id = "other";
    if (failure === "wrong creator") value.created_by = "20000000-0000-4000-8000-000000000099";
    if (failure === "missing creator") delete value.created_by;
    if (failure === "wrong visibility") value.visibility = "public";
    if (failure === "wrong version") value.latest_version.version_no = 2;
    if (failure === "wrong metadata") value.description = "Unexpected description";
    return reply(value);
  } });
  await ui.open(); await ui.history(); await ui.review(); const before = ui.shared.snapshot(); ui.submit(); await settle();
  assert.match(ui.$("cloud-copy-status").textContent, /outcome unknown.*Inspect Cloud workspace before another copy.*Nothing will be retried automatically/s);
  assert.equal(ui.$("cloud-copy-result").hidden, true); assert.equal(ui.$("confirm-cloud-copy").disabled, true);
  ui.submit(); await settle(); assert.equal(ui.writes().length, 1);
  ui.$("close-strategy-history").click(); await ui.history(); await ui.review(); ui.submit();
  assert.match(ui.$("cloud-copy-status").textContent, /earlier copy outcome is unknown/); assert.equal(ui.writes().length, 1);
  ui.$("cloud-copy-checked").click(); await until(() => !ui.$("confirm-cloud-copy").disabled, "fresh review");
  assert.equal(ui.writes().length, 1, "Acknowledging a library check only reopens review, never sends");
  assert.deepEqual(ui.shared.snapshot(), before);
});

for (const status of [401, 403, 409, 422]) test(`${status} remains a rejected request, never a fake success or automatic retry`, async (t) => {
  const ui = await boot(t, { handle: (c) => c.method === "POST" ? reply({ detail: status === 409 ? "project name already exists" : "Request rejected" }, status) : undefined });
  await ui.open(); await ui.history(); await ui.review(); const before = ui.shared.snapshot(); ui.submit(); await settle();
  assert.match(ui.$("cloud-copy-status").textContent, /Copy not created/);
  assert.equal(ui.$("cloud-copy-result").hidden, true); assert.equal(ui.writes().length, 1); assert.deepEqual(ui.shared.snapshot(), before);
  if (status === 409) assert.match(ui.$("cloud-copy-status").textContent, /project name already exists/);
});

test("invalid private name is rejected before sending, and a deliberate corrected submit works", async (t) => {
  const ui = await boot(t); await ui.open(); await ui.history(); await ui.review();
  ui.input("cloud-copy-name", " leading whitespace"); ui.submit(); await settle();
  assert.match(ui.$("cloud-copy-status").textContent, /Copy not created/); assert.deepEqual(ui.writes(), []);
  ui.input("cloud-copy-name", "Corrected name"); ui.submit(); await settle();
  assert.equal(ui.writes()[0].body.name, "Corrected name"); assert.match(ui.$("cloud-copy-status").textContent, /created at saved v1/);
});

test("Back and Forward close review and cannot let a sent copy redirect the later editor visit", async (t) => {
  const pending = deferred(); let body;
  const ui = await boot(t, { handle: (c) => c.method === "POST" ? (body = c.body, pending.promise) : undefined });
  await ui.open(); ui.input("editor", "# keep through browser history"); await ui.history(); await ui.review(); ui.submit();
  ui.w.history.back(); await until(() => !ui.$("view-code").hidden, "Back to device library");
  assert.equal(ui.$("strategy-history-dialog").open, false);
  ui.w.history.forward(); await until(() => !ui.$("view-project").hidden && !ui.$("editor").disabled, "Forward to device editor");
  await ui.history(); await ui.review();
  const hash = ui.w.location.hash, status = ui.$("cloud-copy-status").textContent, storage = ui.shared.snapshot();
  pending.resolve(reply(created(body))); await settle(); ui.flushCloses();
  assert.equal(ui.w.location.hash, hash); assert.equal(ui.$("cloud-copy-status").textContent, status);
  assert.equal(ui.$("editor").value, "# keep through browser history"); assert.deepEqual(ui.shared.snapshot(), storage);
  assert.equal(ui.$("cloud-copy-result").hidden, true); assert.equal(ui.writes().length, 1);
});

test("pending destination checks cancelled and reopened cannot populate the newer review", async (t) => {
  const old = deferred(); let gets = 0;
  const ui = await boot(t, { handle: (c) => c.path === "/v1/me" && ++gets === 2 ? old.promise : undefined });
  await ui.open(); await ui.history(); ui.$("review-cloud-copy").click(); ui.$("cancel-cloud-copy").click(); await ui.review();
  ui.input("cloud-copy-name", "Keep this newer name");
  const details = ui.$("cloud-copy-details").textContent;
  old.resolve(reply({ ...me, subject: "old-result@example.test" })); await settle();
  assert.equal(ui.$("cloud-copy-name").value, "Keep this newer name"); assert.equal(ui.$("cloud-copy-details").textContent, details);
  assert.deepEqual(ui.writes(), []);
});

test("a researcher can deliberately copy all 50 saved files with an empty cloud folder", async (t) => {
  const full = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`files/file${i}.py`, i % 2 ? "" : `# inert ${i}\r\n`]));
  const ui = await boot(t, { seed: (store) => store.createProject(inputProject({ files: full, entrypoint: "files/file49.py", folder: "" })),
    handle: (c) => c.path === "/v1/me" ? reply({ ...me, organizations: [{ ...me.organizations[0], role: "researcher" }] }) : undefined });
  await ui.open(); await ui.history(); await ui.review();
  assert.equal(ui.$("history-file-list").children.length, 50); ui.submit(); await settle();
  assert.deepEqual(ui.writes()[0].body.files, full); assert.equal(ui.writes()[0].body.folder, null);
  assert.match(ui.$("cloud-copy-status").textContent, /created at saved v1/);
});

test("cloud-source history remains read-only and cannot enter this device-copy flow", async (t) => {
  const version = { ...created(inputProject()).latest_version, files, created_at: "2026-01-01T00:00:00Z" };
  const project = { ...inputProject(), id: cloudId, org_id: orgId, visibility: "private", versions: [version] };
  const ui = await boot(t, { handle(c) {
    if (c.path === `/v1/projects/${cloudId}`) return reply(project);
    if (c.path === `/v1/projects/${cloudId}/versions/1`) return reply(version);
    if (c.path === `/v1/projects/${cloudId}/versions?limit=50`) return reply({ versions: [version], total_count: 1, has_more: false, next_before_version: null });
  } });
  await ui.open(cloudId); await ui.history();
  assert.equal(ui.$("history-cloud-copy").hidden, true); assert.equal(ui.$("review-cloud-copy").disabled, true);
  ui.$("review-cloud-copy").dispatchEvent(new ui.w.Event("click")); ui.submit(); await settle();
  assert.deepEqual(ui.writes(), []); assert.equal(ui.$("cloud-copy-review").hidden, true);
});

for (const link of ["cloud-copy-inspect", "cloud-copy-result"]) test(`${link} cancelled native navigation preserves unpersisted source and the full review`, async (t) => {
  const ui = await boot(t, { seed(store) { const p = store.createProject(inputProject()); store.saveVersion(p.id, { files, entrypoint: "strategy.py", expected_version_no: 1 }); return p; },
    handle: (c) => c.method === "POST" && link === "cloud-copy-inspect" ? Promise.reject(new Error("Lost response")) : undefined });
  await ui.open(); ui.shared.setItem = () => { throw new Error("Read-only storage"); }; ui.input("editor", "# only remaining draft\n");
  await ui.history(); await ui.select(1); await ui.review(); ui.input("cloud-copy-name", "Reviewed copy name"); ui.submit(); await settle();
  let prompts = 0; ui.w.confirm = (message) => { prompts++; assert.match(message, /unsaved edits could not be stored.*Cancel and download a snapshot.*discard/s); return false; };
  const before = { hash: ui.w.location.hash, project: plain(ui.w.fixtureState.project), storage: ui.shared.snapshot(), source: ui.$("history-source").textContent,
    selected: ui.$("history-version").value, details: ui.$("cloud-copy-details").textContent, status: ui.$("cloud-copy-status").textContent, name: ui.$("cloud-copy-name").value, href: ui.$(link).href };
  assert.equal(ui.$(link).hidden, false); ui.$(link).click(); await delay(20);
  assert.equal(prompts, 1); assert.equal(ui.w.location.hash, before.hash); assert.equal(ui.$("strategy-history-dialog").open, true);
  assert.deepEqual(plain(ui.w.fixtureState.project), before.project); assert.deepEqual(ui.shared.snapshot(), before.storage);
  assert.equal(ui.$("history-source").textContent, before.source); assert.equal(ui.$("history-version").value, before.selected);
  assert.equal(ui.$("cloud-copy-details").textContent, before.details); assert.equal(ui.$("cloud-copy-status").textContent, before.status);
  assert.equal(ui.$("cloud-copy-name").value, before.name); assert.equal(ui.$(link).href, before.href); assert.equal(ui.writes().length, 1);
});

for (const link of ["cloud-copy-inspect", "cloud-copy-result"]) test(`${link} acknowledged native navigation may leave an unpersisted draft`, async (t) => {
  const saved = { ...created(inputProject()).latest_version, files, created_at: "2026-01-01T00:00:00Z" };
  const ui = await boot(t, { handle(c) {
    if (c.path === `/v1/projects/${cloudId}`) return reply({ ...inputProject(), id: cloudId, visibility: "private", versions: [saved] });
    if (c.path === `/v1/projects/${cloudId}/versions/1`) return reply(saved);
  } });
  await ui.open(); ui.shared.setItem = () => { throw new Error("Read-only storage"); }; ui.input("editor", "# consciously discarded");
  await ui.history(); await ui.review(); ui.submit(); await settle();
  let prompts = 0; ui.w.confirm = () => { prompts++; return true; }; ui.$(link).click();
  const destination = link === "cloud-copy-inspect" ? "#code/cloud" : `#project/${cloudId}`;
  await until(() => ui.w.location.hash === destination && !ui.$("strategy-history-dialog").open, "acknowledged navigation");
  if (link === "cloud-copy-result") await until(() => ui.w.fixtureState.project?.id === cloudId && !ui.$("editor").disabled, "destination editor loaded");
  assert.equal(prompts, 1); assert.equal(ui.writes().length, 1);
});

for (const link of ["cloud-copy-inspect", "cloud-copy-result"]) test(`${link} modified and new-tab links leave browser behavior intact and preserve the original draft`, async (t) => {
  const ui = await boot(t); await ui.open(); ui.shared.setItem = () => { throw new Error("Read-only storage"); }; ui.input("editor", "# keep in original tab");
  await ui.history(); await ui.review(); ui.submit(); await settle();
  ui.w.confirm = () => assert.fail("Opening another tab must not ask to discard the original tab's draft");
  const project = plain(ui.w.fixtureState.project), storage = ui.shared.snapshot(), hash = ui.w.location.hash;
  let browserActivations = 0;
  // jsdom does not implement native new-tab navigation: inspect the uncancelled event, then stub only its default.
  ui.w.document.addEventListener("click", (event) => { if (event.target.id === link) { assert.equal(event.defaultPrevented, false); browserActivations++; event.preventDefault(); } });
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    ui.$(link).dispatchEvent(new ui.w.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...options }));
  }
  ui.$(link).target = "_blank"; ui.$(link).click(); await settle();
  assert.equal(browserActivations, 6); assert.equal(ui.w.location.hash, hash); assert.equal(ui.$("strategy-history-dialog").open, true);
  assert.deepEqual(plain(ui.w.fixtureState.project), project); assert.deepEqual(ui.shared.snapshot(), storage); assert.equal(ui.writes().length, 1);
});

for (const draft of ["saved source", "persisted dirty draft"]) test(`cloud inspection does not prompt for ${draft}`, async (t) => {
  const ui = await boot(t); await ui.open(); if (draft === "persisted dirty draft") ui.input("editor", "# recoverable draft");
  await ui.history(); await ui.review(); ui.w.confirm = () => assert.fail("No irreplaceable edits to discard"); ui.$("cloud-copy-inspect").click();
  await until(() => !ui.$("view-code").hidden, "safe navigation"); await ui.open();
  if (draft === "persisted dirty draft") assert.equal(ui.$("editor").value, "# recoverable draft");
});
