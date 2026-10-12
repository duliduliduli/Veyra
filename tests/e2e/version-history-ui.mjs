// Isolated saved-history checks: no browser launch, database, upload, or strategy execution.
// NODE_PATH=/path/to/jsdom/node_modules node --test tests/e2e/version-history-ui.mjs
// shortcut: native dialog focus and visual layout still need authorized browser QA.
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
const files = { "strategy.py": "# exact saved source\r\nfrom helpers.entry import value\r\n", "helpers/entry.py": "value = '☀'\r\n", "helpers/empty.py": "" };
const projectInput = (extra = {}) => ({ name: "Saved strategy", description: "Private notes", folder: "Research", files, entrypoint: "helpers/entry.py", ...extra });
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
  return { writes: 0, get length() { return values.size; }, key: (i) => [...values.keys()][i],
    getItem: (key) => values.get(key) ?? null,
    removeItem(key) { this.writes++; values.delete(key); },
    setItem(key, value) { this.writes++; values.set(key, String(value)); },
    snapshot: () => Object.fromEntries(values) };
}
const cloudId = "10000000-0000-4000-8000-000000000000";
function cloud(count = 62, extra = {}) {
  const revisions = Array.from({ length: count }, (_, i) => ({ id: `20000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    project_id: cloudId, version_no: i + 1, content_hash: `sha256:${(i + 1).toString(16).padStart(64, "0")}`,
    entrypoint: "helpers/entry.py", files: { ...files, "helpers/entry.py": `# saved v${i + 1}\r\n` }, created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z` })).reverse();
  const metadata = ({ files, project_id, ...row }) => row;
  const project = { ...projectInput(), id: cloudId, org_id: "fixture-org", visibility: "private", versions: revisions.slice(0, 50).map(metadata), ...extra };
  return { project, revisions, metadata, page(before = Infinity) {
    const rows = revisions.filter((row) => row.version_no < before), result = rows.slice(0, 50);
    return { versions: result.map(metadata), total_count: revisions.length, has_more: rows.length > result.length,
      next_before_version: rows.length > result.length ? result.at(-1).version_no : null };
  } };
}
async function boot(t, { seed, remote, respond } = {}) {
  const errors = [], calls = [], downloads = [], blobs = new Map(), shared = storage(), lockCalls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: "https://veyra.test/#code", runScripts: "outside-only", virtualConsole });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  t.after(() => { w.close(); assert.deepEqual(errors, [], "No uncaught DOM errors"); });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  Object.defineProperty(w, "localStorage", { value: shared });
  Object.defineProperty(w.navigator, "locks", { value: { request(name, options, action) { lockCalls.push(name); return Promise.resolve().then(action); } } });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  w.URL.createObjectURL = (blob) => { const url = `blob:https://veyra.test/${blobs.size}`; blobs.set(url, blob); return url; };
  w.URL.revokeObjectURL = (url) => blobs.delete(url);
  w.document.addEventListener("click", (event) => {
    const link = event.target.closest("a[download]");
    if (link) { event.preventDefault(); downloads.push({ name: link.download, blob: blobs.get(link.href) }); }
  });
  if (remote) shared.setItem("veyra.user", "fixture-user");
  w.fetch = async (path, options = {}) => {
    const call = { path, method: options.method || "GET", ...options }; calls.push(call);
    const reply = (data) => ({ ok: true, json: async () => w.JSON.parse(JSON.stringify(data)) });
    const custom = await respond?.(path, call);
    if (custom !== undefined) return custom.ok === false ? custom : reply(custom);
    if (path === "/v1/catalog/datasets") return reply({ datasets: [] });
    if (remote && path === "/v1/me") return reply({ organizations: [{ id: "fixture-org" }] });
    if (remote && path.endsWith("/billing/balance")) return reply({ available_nano: 0 });
    if (remote && path === "/v1/orgs/fixture-org/projects") return reply({ projects: [remote.project], has_more: false, next_cursor: null });
    if (remote && path === `/v1/projects/${cloudId}`) return reply(remote.project);
    if (remote && path.startsWith(`/v1/projects/${cloudId}/versions?`)) return reply(remote.page(Number(new URL(path, w.location.href).searchParams.get("before_version")) || Infinity));
    if (remote && path.startsWith(`/v1/projects/${cloudId}/versions/`)) return reply(remote.revisions.find((v) => v.version_no === Number(path.split("/").at(-1))));
    errors.push(`Unexpected API call: ${call.method} ${path}`);
    return { ok: false, status: 500, json: async () => ({ detail: "Unexpected test request" }) };
  };
  scripts.slice(0, -1).forEach((script) => w.eval(script));
  const store = w.VeyraWorkspaceStore.create(shared), seeded = seed?.(store);
  w.eval(scripts.at(-1) + "\nwindow.fixtureState = state;");
  await until(() => !$("view-code").hidden && $("workspace-mode").textContent, "Studio boot");
  const input = (id, value, type = "input") => { $(id).value = value; $(id).dispatchEvent(new w.Event(type, { bubbles: true })); };
  async function navigate(hash) {
    w.location.hash = hash;
    await until(() => !$(`view-${hash.slice(1).split("/")[0]}`).hidden, `route ${hash}`);
    await delay(10);
  }
  async function open(id = seeded?.id || cloudId) {
    await navigate(`#project/${id}`);
    await until(() => !$("editor").disabled, "editor");
  }
  async function history() { $("project-history").click(); await until(() => !$("history-snapshot").hidden, "saved source"); }
  async function select(number) { input("history-version", String(number), "change"); await until(() => !$("history-snapshot").hidden, `saved v${number}`); }
  async function download() {
    $("history-download").click();
    return new Promise((resolve, reject) => {
      const reader = new w.FileReader();
      reader.onload = () => resolve(JSON.parse(reader.result)); reader.onerror = () => reject(reader.error);
      reader.readAsText(downloads.at(-1).blob);
    });
  }
  return { w, $, shared, lockCalls, store, seeded, calls, downloads, input, navigate, open, history, select, download };
}
const denied = (detail) => ({ ok: false, status: 503, json: async () => ({ detail }) });

test("history is an accessible read-only source dialog with explicit metadata and copy disclosure", () => {
  assert.match(html, /id="project-history" aria-haspopup="dialog" disabled>History/);
  assert.match(html, /id="strategy-history-dialog"[^>]*aria-labelledby="history-title"/);
  assert.match(html, /<pre id="history-source"[^>]*tabindex="0"[^>]*aria-label="Read-only saved Python source"/);
  assert.match(html, /current project metadata, not part of the selected saved source version/);
  assert.match(html, /The copy starts at saved v1/);
});

test("all 73 device versions are newest-first; exact selected source download never touches unsaved multi-file edits", async (t) => {
  const ui = await boot(t, { seed(store) {
    const p = store.createProject(projectInput());
    for (let n = 2; n <= 73; n++) store.saveVersion(p.id, { files: { ...files, "helpers/entry.py": `# version ${n}\r\n` }, entrypoint: "helpers/entry.py", expected_version_no: n - 1 });
    return p;
  } });
  await ui.open();
  ui.input("editor", "# active unsaved helper\n");
  ui.input("editor-file", "strategy.py", "change");
  ui.input("editor", "# unsaved main\n");
  ui.store.updateProject(ui.seeded.id, { name: "Current title", description: "Current private description", folder: "Current folder" });
  const before = ui.shared.snapshot(), writes = ui.shared.writes;
  await ui.history();
  assert.deepEqual([...ui.$("history-version").options].map((v) => Number(v.value)), Array.from({ length: 73 }, (_, i) => 73 - i));
  assert.match(ui.$("history-status").textContent, /73 saved versions · all device history/);
  assert.equal(ui.$("history-more").hidden, true);
  await ui.select(1);
  assert.equal(ui.$("history-source").textContent, files["helpers/entry.py"]);
  assert.deepEqual([...ui.$("history-file-list").children].map((row) => row.textContent), Object.keys(files));
  ui.input("history-file", "helpers/empty.py", "change");
  assert.equal(ui.$("history-source").textContent, "");
  ui.input("history-file", "strategy.py", "change");
  assert.equal(ui.$("history-source").textContent, files["strategy.py"]);
  const exported = await ui.download();
  assert.deepEqual(exported, { format: "veyra-strategy-snapshot", schema_version: 1, name: "Current title",
    description: "Current private description", folder: "Current folder", files, entrypoint: "helpers/entry.py", has_unsaved_changes: false });
  assert.equal(ui.downloads[0].name, "veyra-saved-v1-snapshot.json");
  assert.equal(ui.downloads[0].blob.type, "application/json");
  assert.match(ui.$("history-identity").textContent, /Not recorded for device-local versions/);
  assert.deepEqual(ui.shared.snapshot(), before);
  assert.equal(ui.shared.writes, writes, "History and download make no storage writes");
  assert.deepEqual(ui.lockCalls, [], "No write lock is acquired");
  assert.deepEqual(ui.calls.map(({ path }) => path), ["/v1/catalog/datasets"]);
  ui.$("close-strategy-history").click();
  assert.equal(ui.$("editor-file").value, "strategy.py");
  assert.equal(ui.$("editor").value, "# unsaved main\n");
  ui.input("editor-file", "helpers/entry.py", "change");
  assert.equal(ui.$("editor").value, "# active unsaved helper\n");
  assert.match(ui.$("draft-state").textContent, /Unsaved edits/);
  assert.equal(ui.store.getProject(ui.seeded.id).latest_version_no, 73);
});

test("cloud history loads older pages beyond get_project's 50-row cap and downloads only selected complete source", async (t) => {
  const remote = cloud(), ui = await boot(t, { remote });
  await ui.open(); await ui.history();
  assert.equal(ui.$("history-version").options.length, 50);
  assert.match(ui.$("history-status").textContent, /50 versions loaded · 62 saved/);
  assert.equal(ui.$("history-version").value, "62");
  ui.$("history-more").click();
  await until(() => ui.$("history-version").options.length === 62, "older cloud versions");
  assert.equal(ui.$("history-version").value, "62");
  assert.equal(ui.$("history-more").hidden, true);
  assert.ok(ui.calls.some((call) => call.path.endsWith("?limit=50&before_version=13")));
  await ui.select(1);
  const exported = await ui.download();
  assert.deepEqual(exported.files, remote.revisions.at(-1).files);
  assert.equal(exported.has_unsaved_changes, false);
  assert.equal(exported.name, remote.project.name);
  assert.equal(exported.id, undefined); assert.equal(exported.content_hash, undefined); assert.equal(exported.versions, undefined);
  assert.ok(ui.calls.every((call) => call.method === "GET" && call.cache === "no-store"));
  const requests = ui.calls.filter((call) => call.path.includes(`/projects/${cloudId}/versions`));
  assert.ok(requests.every((call) => call.credentials === "same-origin" && call.headers["x-veyra-dev-user"] === "fixture-user"));
});

test("older-page failures retry in place, repeated clicks do not duplicate requests or reset selected source", async (t) => {
  const remote = cloud(), pending = deferred(); let requests = 0;
  const ui = await boot(t, { remote, respond(path) {
    if (path.endsWith("before_version=13")) { requests++; return requests === 1 ? pending.promise : remote.page(13); }
  } });
  await ui.open(); await ui.history(); await ui.select(15);
  ui.$("history-more").click(); ui.$("history-more").click();
  assert.equal(requests, 1);
  pending.resolve(denied("Offline test"));
  await until(() => !ui.$("history-retry").hidden, "pagination retry");
  assert.equal(ui.$("history-version").options.length, 50);
  assert.equal(ui.$("history-source").textContent, "# saved v15\r\n");
  ui.$("history-retry").click();
  await until(() => ui.$("history-version").options.length === 62, "retried page");
  assert.equal(ui.$("history-version").value, "15");
  assert.equal(ui.$("history-source").textContent, "# saved v15\r\n");
  assert.equal(requests, 2);
});

test("out-of-order selection responses cannot overwrite the newer exact revision or enable stale download", async (t) => {
  const remote = cloud(4), pending = deferred();
  const ui = await boot(t, { remote, respond(path) { if (path.endsWith("/versions/1")) return pending.promise; } });
  await ui.open(); await ui.history();
  ui.input("history-version", "1", "change");
  assert.equal(ui.$("history-source").textContent, "");
  assert.equal(ui.$("history-download").disabled, true);
  assert.equal(ui.$("history-snapshot").hidden, true);
  await ui.select(2);
  pending.resolve(remote.revisions.at(-1)); await delay(20);
  assert.equal(ui.$("history-version").value, "2");
  assert.equal(ui.$("history-source").textContent, "# saved v2\r\n");
  assert.deepEqual((await ui.download()).files, remote.revisions.find((v) => v.version_no === 2).files);
});

test("failed selected source stays hidden until an explicit retry succeeds", async (t) => {
  const remote = cloud(2); let attempts = 0;
  const ui = await boot(t, { remote, respond(path) {
    if (path.endsWith("/versions/1")) return ++attempts === 1 ? denied("Source offline") : remote.revisions.at(-1);
  } });
  await ui.open(); await ui.history();
  ui.input("history-version", "1", "change");
  await until(() => !ui.$("history-version-retry").hidden, "source retry");
  assert.equal(ui.$("history-download").disabled, true);
  assert.equal(ui.$("history-source").textContent, "");
  assert.match(ui.$("history-version-status").textContent, /Source offline/);
  ui.$("history-version-retry").click();
  await until(() => !ui.$("history-snapshot").hidden, "retried source");
  assert.equal(ui.$("history-source").textContent, "# saved v1\r\n");
});

test("closing and reopening discards stale first-page responses and preserves the editor", async (t) => {
  const remote = cloud(3), pending = deferred(); let pages = 0;
  const ui = await boot(t, { remote, respond(path) {
    if (path.endsWith("/versions?limit=50") && ++pages === 1) return pending.promise;
  } });
  await ui.open(); ui.input("editor", "# editor draft\n");
  const before = ui.shared.snapshot();
  ui.$("project-history").click(); ui.$("close-strategy-history").click();
  await ui.history(); await ui.select(1);
  pending.resolve(remote.page()); await delay(20);
  assert.equal(ui.$("history-version").value, "1");
  assert.equal(ui.$("history-source").textContent, "# saved v1\r\n");
  assert.equal(ui.$("editor").value, "# editor draft\n");
  assert.deepEqual(ui.shared.snapshot(), before);
});

test("Escape closes and invalidates pending source; later navigation cannot repopulate hidden history", async (t) => {
  const remote = cloud(3), pending = deferred();
  const ui = await boot(t, { remote, respond(path) { if (path.endsWith("/versions/1")) return pending.promise; } });
  await ui.open(); await ui.history();
  ui.input("editor", "# kept across navigation\n");
  const before = ui.shared.snapshot();
  ui.input("history-version", "1", "change");
  ui.$("strategy-history-dialog").dispatchEvent(new ui.w.Event("cancel", { cancelable: true }));
  assert.equal(ui.$("strategy-history-dialog").open, false);
  assert.equal(ui.w.document.activeElement, ui.$("project-history"));
  await ui.navigate("#code");
  pending.resolve(remote.revisions.at(-1)); await delay(20);
  assert.equal(ui.$("history-snapshot").hidden, true);
  assert.equal(ui.$("history-source").textContent, "");
  assert.equal(ui.$("history-download").disabled, true);
  assert.deepEqual(ui.shared.snapshot(), before);
  await ui.open();
  assert.equal(ui.$("editor").value, "# kept across navigation\n");
});

test("navigation closes History while an older page is pending; reopening cannot inherit stale page results", async (t) => {
  const remote = cloud(), pending = deferred();
  const ui = await boot(t, { remote, respond(path) { if (path.endsWith("before_version=13")) return pending.promise; } });
  await ui.open(); await ui.history(); ui.$("history-more").click();
  await ui.navigate("#code");
  assert.equal(ui.$("strategy-history-dialog").open, false);
  await ui.open(); await ui.history();
  pending.resolve(remote.page(13)); await delay(20);
  assert.equal(ui.$("history-version").options.length, 50);
  assert.equal(ui.$("history-version").value, "62");
});

for (const kind of ["folder", "long path", "long description"]) test(`unsupported older ${kind} remains inspectable and rejects backup without truncation`, async (t) => {
  let remote, seed;
  if (kind === "long description") remote = cloud(1, { description: "a".repeat(2001) });
  else seed = (store) => store.createProject(projectInput(kind === "folder" ? { folder: "." } : {
    files: { ["a".repeat(254) + ".py"]: "# exact old source\r\n" }, entrypoint: "a".repeat(254) + ".py",
  }));
  const ui = await boot(t, { seed, remote });
  await ui.open(); await ui.history();
  const before = ui.shared.snapshot(), source = ui.$("history-source").textContent;
  ui.$("history-download").click();
  assert.match(ui.$("history-version-status").textContent, /Snapshot not downloaded.*Saved source is unchanged/);
  assert.equal(ui.downloads.length, 0);
  assert.equal(ui.$("history-source").textContent, source);
  assert.equal(ui.$("history-snapshot").hidden, false);
  assert.deepEqual(ui.shared.snapshot(), before);
});

for (const key of ["id", "project_id", "version_no", "entrypoint", "content_hash", "created_at"]) test(`source ${key} mismatch fails closed without changing the editor`, async (t) => {
  const remote = cloud(2);
  const bad = { ...remote.revisions.at(-1), [key]: key === "version_no" ? 2 : key === "entrypoint" ? "strategy.py" : "mismatch" };
  const ui = await boot(t, { remote, respond(path) { if (path.endsWith("/versions/1")) return bad; } });
  await ui.open(); await ui.history();
  const editor = ui.$("editor").value, before = ui.shared.snapshot();
  ui.input("history-version", "1", "change");
  await until(() => !ui.$("history-version-retry").hidden, "mismatch error");
  assert.match(ui.$("history-version-status").textContent, /identity changed/);
  assert.equal(ui.$("history-compare").disabled, true);
  ui.$("history-compare").dispatchEvent(new ui.w.Event("click"));
  assert.equal(ui.$("history-comparison").hidden, true);
  assert.equal(ui.$("history-download").disabled, true);
  assert.equal(ui.$("history-source").textContent, "");
  assert.equal(ui.$("editor").value, editor);
  assert.deepEqual(ui.shared.snapshot(), before);
});

test("malformed or overlapping cloud pages preserve previously loaded history and selected source", async (t) => {
  const remote = cloud();
  const ui = await boot(t, { remote, respond(path) { if (path.endsWith("before_version=13")) return remote.page(); } });
  await ui.open(); await ui.history();
  ui.$("history-more").click();
  await until(() => !ui.$("history-retry").hidden, "bad page error");
  assert.match(ui.$("history-status").textContent, /out of order/);
  assert.equal(ui.$("history-version").options.length, 50);
  assert.equal(ui.$("history-source").textContent, "# saved v62\r\n");
});

test("HTML-looking saved source and metadata are rendered as text and never executed", async (t) => {
  const text = "<img src=x onerror=window.unsafe=true>\r\n<script>window.unsafe=true</script>\r\n";
  const ui = await boot(t, { seed: (store) => store.createProject(projectInput({ name: "<script>name</script>", files: { "strategy.py": text }, entrypoint: "strategy.py" })) });
  await ui.open(); await ui.history();
  assert.equal(ui.$("history-source").textContent, text);
  assert.equal(ui.$("history-source").querySelector("script,img"), null);
  assert.equal(ui.$("history-details").querySelector("script"), null);
  assert.equal(ui.w.unsafe, undefined);
});


test("a queued native close event cannot clear a reopened History dialog", async (t) => {
  const ui = await boot(t, { seed: (store) => store.createProject(projectInput()) });
  await ui.open(); await ui.history();
  ui.$("close-strategy-history").click();
  await ui.history();
  ui.$("strategy-history-dialog").dispatchEvent(new ui.w.Event("close"));
  assert.equal(ui.$("strategy-history-dialog").open, true);
  assert.equal(ui.$("history-snapshot").hidden, false);
  assert.equal(ui.$("history-source").textContent, files["helpers/entry.py"]);
  assert.deepEqual((await ui.download()).files, files);
});

test("new cloud saves between pages are excluded from the older cursor while the exact total may grow", async (t) => {
  const remote = cloud(); let olderRequested = false;
  const ui = await boot(t, { remote, respond(path) {
    if (path.endsWith("before_version=13")) { olderRequested = true; return { ...remote.page(13), total_count: 63 }; }
  } });
  await ui.open(); await ui.history(); ui.$("history-more").click();
  await until(() => ui.$("history-version").options.length === 62, "stable continuation after a new save");
  assert.equal(olderRequested, true);
  assert.deepEqual([...ui.$("history-version").options].map((v) => Number(v.value)), Array.from({ length: 62 }, (_, i) => 62 - i));
  assert.match(ui.$("history-status").textContent, /62 versions loaded · 63 saved at last check/);
  assert.match(ui.$("history-status").textContent, /Reopen History for newer saves/);
  assert.equal(ui.$("history-more").hidden, true);
});

function compare(ui) {
  ui.$("history-compare").click();
  assert.equal(ui.$("history-comparison").hidden, false);
}
function fileAction(ui, action, path) {
  ui.$(`${action}-file`).click();
  if (path) ui.input("file-path", path);
  ui.$("strategy-file-form").dispatchEvent(new ui.w.Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(ui.$("strategy-file-dialog").open, false);
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test("compare is wired, accessible, exact and read-only across file selection and repeated review", async (t) => {
  const saved = "# π 😀\r\n\tvalue = 1\r\nlast\r";
  const newer = "# π 😀\r\n\tvalue = 2\r\nlast\rfinal\u00a0text";
  const ui = await boot(t, { seed(store) {
    const p = store.createProject(projectInput({ files: { ...files, "helpers/entry.py": saved } }));
    store.saveVersion(p.id, { files: { ...files, "helpers/entry.py": newer }, entrypoint: "helpers/entry.py", expected_version_no: 1 });
    return p;
  } });
  await ui.open();
  ui.input("editor", ui.$("editor").value.replace("value = 2", "value = 3"));
  const expected = newer.replace("value = 2", "value = 3");
  const before = ui.shared.snapshot(), writes = ui.shared.writes, current = plain(ui.w.fixtureState.project);
  await ui.history(); await ui.select(1); compare(ui);
  assert.equal(ui.$("history-before").textContent, saved);
  assert.equal(ui.$("history-after").textContent, expected);
  assert.match(ui.$("history-before-title").textContent, /Saved v1 · helpers\/entry.py/);
  assert.match(ui.$("history-after-title").textContent, /Current draft at comparison/);
  assert.match(ui.$("history-compare-identity").textContent, /based on saved v2; includes unsaved edits/);
  assert.match(ui.$("history-before-info").textContent, /2 CRLF, 1 CR.*ends with newline/);
  assert.match(ui.$("history-after-info").textContent, /2 CRLF, 1 CR.*no final newline/);
  assert.match(ui.$("history-diff-lines").textContent, /Added, draft line/);
  assert.match(ui.$("history-diff-lines").textContent, /Removed, saved line/);
  assert.match(ui.$("history-diff-lines").textContent, /⇥value·=·3/);
  assert.match(ui.$("history-diff-lines").textContent, /⟦U\+00A0⟧/);
  assert.equal(ui.$("history-diff-scroll").getAttribute("tabindex"), "0");
  assert.equal(ui.$("history-diff-scroll").getAttribute("aria-describedby"), "history-diff-legend");
  assert.equal(ui.$("history-before").getAttribute("aria-labelledby"), "history-before-title");
  assert.equal(ui.$("history-after").getAttribute("aria-describedby"), "history-after-info");
  assert.equal(ui.$("history-compare").getAttribute("aria-expanded"), "true");
  assert.equal(ui.w.document.activeElement, ui.$("history-compare-title"));
  ui.$("history-full-source").open = true;
  ui.$("history-show-whitespace").click();
  assert.equal(ui.$("history-full-source").open, true, "Toggling markers preserves expanded complete source");
  assert.match(ui.$("history-diff-lines").textContent, /\tvalue = 3/);
  ui.input("history-compare-file", "helpers/empty.py", "change");
  assert.match(ui.$("history-diff-summary").textContent, /^Unchanged · \+0 added \/ −0 removed/);
  assert.match(ui.$("history-before-info").textContent, /empty source/);
  assert.match(ui.$("history-compare-summary").textContent, /0 added files · 0 removed files · 1 modified files · 2 unchanged files/);
  assert.equal(ui.$("history-file").value, "helpers/entry.py", "Saved source selector is independent");
  compare(ui); compare(ui);
  assert.equal(ui.$("history-compare-file").value, "helpers/empty.py");
  assert.deepEqual(ui.shared.snapshot(), before); assert.equal(ui.shared.writes, writes);
  assert.deepEqual(plain(ui.w.fixtureState.project), current);
  assert.deepEqual(ui.lockCalls, []);
  assert.deepEqual(ui.calls.map(({ path }) => path), ["/v1/catalog/datasets"]);
  ui.$("close-strategy-history").click();
  assert.equal(ui.$("history-before").textContent, ""); assert.equal(ui.$("history-after").textContent, "");
  assert.equal(ui.$("history-comparison").hidden, true);
  assert.equal(ui.$("history-compare").getAttribute("aria-expanded"), "false");
  assert.equal(ui.$("editor").value, expected.replace(/\r\n?/g, "\n"));
  assert.match(ui.$("draft-state").textContent, /Unsaved edits/);
});

test("added and removed empty files differ from unchanged files; entrypoint-only changes stay explicit", async (t) => {
  const ui = await boot(t, { seed: (store) => store.createProject(projectInput()) });
  await ui.open();
  ui.input("editor-file", "helpers/empty.py", "change"); fileAction(ui, "remove");
  fileAction(ui, "add", "new_empty.py");
  ui.input("editor-entrypoint", "strategy.py", "change");
  const current = plain(ui.w.fixtureState.project), before = ui.shared.snapshot(), writes = ui.shared.writes;
  await ui.history(); compare(ui);
  assert.deepEqual([...ui.$("history-compare-file").options].map((o) => o.textContent), [
    "Unchanged · strategy.py", "Unchanged · helpers/entry.py", "Removed file · helpers/empty.py", "Added file · new_empty.py",
  ]);
  assert.equal(ui.$("history-compare-file").value, "new_empty.py");
  assert.match(ui.$("history-diff-summary").textContent, /^Added file · \+0 added \/ −0 removed/);
  assert.equal(ui.$("history-before-info").textContent, "File absent in saved version");
  assert.match(ui.$("history-after-info").textContent, /empty source/);
  ui.input("history-compare-file", "helpers/empty.py", "change");
  assert.match(ui.$("history-diff-summary").textContent, /^Removed file · \+0 added \/ −0 removed/);
  assert.equal(ui.$("history-after-info").textContent, "File absent in draft");
  assert.match(ui.$("history-before-info").textContent, /empty source/);
  ui.input("history-compare-file", "strategy.py", "change");
  assert.match(ui.$("history-diff-summary").textContent, /^Unchanged/);
  assert.match(ui.$("history-compare-entrypoint").textContent, /Entrypoint changed · saved v1: helpers\/entry.py · draft: strategy.py/);
  assert.match(ui.$("history-compare-summary").textContent, /1 added files · 1 removed files · 0 modified files · 2 unchanged files/);
  assert.deepEqual(ui.shared.snapshot(), before); assert.equal(ui.shared.writes, writes);
  assert.deepEqual(plain(ui.w.fixtureState.project), current);
  assert.deepEqual((await ui.download()).files, files, "Existing saved download excludes added/removed draft edits");
});

test("rename is a removed and added file; nonempty sources remain exact on their respective side", async (t) => {
  const ui = await boot(t, { seed: (store) => store.createProject(projectInput()) });
  await ui.open(); fileAction(ui, "rename", "renamed.py");
  const before = ui.shared.snapshot();
  await ui.history(); compare(ui);
  assert.match(ui.$("history-diff-summary").textContent, /^Added file · \+1 added \/ −0 removed/);
  assert.equal(ui.$("history-after").textContent, files["helpers/entry.py"]);
  ui.input("history-compare-file", "helpers/entry.py", "change");
  assert.match(ui.$("history-diff-summary").textContent, /^Removed file · \+0 added \/ −1 removed/);
  assert.equal(ui.$("history-before").textContent, files["helpers/entry.py"]);
  assert.equal(ui.$("history-after").textContent, "");
  assert.deepEqual(ui.shared.snapshot(), before);
});

for (const [name, before, after] of [
  ["line-ending-only", "x = 'π'\r\n", "x = 'π'\n"],
  ["final-newline-only", "x = 'π'\n", "x = 'π'"],
  ["Unicode whitespace-only", "x\t= 1\n", "x\u00a0= 1\n"],
]) test(`comparison exposes ${name} edits without normalization`, async (t) => {
  const ui = await boot(t, { seed(store) {
    const p = store.createProject(projectInput({ files: { "strategy.py": before }, entrypoint: "strategy.py" }));
    store.saveVersion(p.id, { files: { "strategy.py": after }, entrypoint: "strategy.py", expected_version_no: 1 });
    return p;
  } });
  await ui.open(); await ui.history(); await ui.select(1); compare(ui);
  assert.equal(ui.$("history-before").textContent, before); assert.equal(ui.$("history-after").textContent, after);
  assert.match(ui.$("history-diff-summary").textContent, /Modified · \+1 added \/ −1 removed lines · whitespace-only changes/);
  assert.match(ui.$("history-compare-identity").textContent, /based on saved v2; no unsaved edits/);
  assert.match(ui.$("history-compare-entrypoint").textContent, /Entrypoint unchanged/);
  assert.match(ui.$("history-comparison").textContent, /Whitespace or indentation changes can change Python behavior/);
});

for (const [label, before, after, reason] of [
  ["character limit", "a".repeat(100001), "b".repeat(100001), /100,000-character/],
  ["LCS limit", "old\n".repeat(510), "new\r\n".repeat(510), /bounded line comparison/],
  ["dense display", "", "new\n".repeat(401), /too dense/],
]) test(`comparison uses complete-source fallback at ${label}`, async (t) => {
  const ui = await boot(t, { seed(store) {
    const p = store.createProject(projectInput({ files: { "strategy.py": before }, entrypoint: "strategy.py" }));
    store.saveVersion(p.id, { files: { "strategy.py": after }, entrypoint: "strategy.py", expected_version_no: 1 });
    return p;
  } });
  await ui.open(); await ui.history(); await ui.select(1); compare(ui);
  assert.equal(ui.$("history-before").textContent, before); assert.equal(ui.$("history-after").textContent, after);
  assert.equal(ui.$("history-full-source").open, true); assert.equal(ui.$("history-diff-review").hidden, true);
  assert.equal(ui.$("history-diff-lines").childElementCount, 0);
  assert.match(ui.$("history-diff-note").textContent, reason);
  assert.match(ui.$("history-diff-note").textContent, /nothing is truncated.*not a minimal line diff/);
  assert.match(ui.$("history-diff-summary").textContent, /Replacement block:/);
});

test("comparison is an immutable capture until explicitly compared again, including unsaved file removal", async (t) => {
  const ui = await boot(t, { seed: (store) => store.createProject(projectInput()) });
  await ui.open(); ui.input("editor", "# first draft"); await ui.history(); compare(ui);
  const first = ui.$("history-after").textContent;
  // Synthetic background edits model changes while modal; native dialog prevents direct editor interaction.
  ui.input("editor", "# newer draft");
  ui.input("history-compare-file", "strategy.py", "change");
  ui.input("history-compare-file", "helpers/entry.py", "change");
  assert.equal(ui.$("history-after").textContent, first);
  compare(ui); assert.equal(ui.$("history-after").textContent, "# newer draft");
  ui.$("close-strategy-history").click();
  ui.input("editor-file", "helpers/empty.py", "change"); fileAction(ui, "remove");
  await ui.history(); compare(ui);
  ui.input("history-compare-file", "helpers/empty.py", "change");
  assert.match(ui.$("history-diff-summary").textContent, /^Removed file/);
  assert.equal(ui.$("editor-file").value, "helpers/entry.py");
  assert.equal(ui.$("editor").value, "# newer draft");
});

test("stale cloud selections cannot repopulate a comparison and pagination keeps the selected comparison", async (t) => {
  const remote = cloud(), pending = deferred();
  const ui = await boot(t, { remote, respond(path) { if (path.endsWith("/versions/14")) return pending.promise; } });
  await ui.open(); ui.input("editor", "# unsaved cloud draft"); await ui.history(); compare(ui);
  ui.input("history-version", "14", "change");
  assert.equal(ui.$("history-comparison").hidden, true); assert.equal(ui.$("history-compare").disabled, true);
  assert.equal(ui.$("history-after").textContent, "");
  await ui.select(15); compare(ui);
  const before = ui.$("history-before").textContent, after = ui.$("history-after").textContent;
  pending.resolve(remote.revisions.find((v) => v.version_no === 14)); await delay(20);
  assert.equal(ui.$("history-before").textContent, before); assert.equal(ui.$("history-after").textContent, after);
  ui.$("history-more").click();
  await until(() => ui.$("history-version").options.length === 62, "comparison pagination");
  assert.equal(ui.$("history-before").textContent, before); assert.equal(ui.$("history-comparison").hidden, false);
  assert.ok(ui.calls.every((call) => call.method === "GET"));
});

for (const changed of ["user", "org"]) test(`a changed ${changed} rejects pending history and comparison actions`, async (t) => {
  const remote = cloud(3), pending = deferred();
  const ui = await boot(t, { remote, respond(path) { if (path.endsWith("/versions/1")) return pending.promise; } });
  await ui.open(); ui.input("editor", "# private draft"); await ui.history(); compare(ui);
  ui.input("history-version", "1", "change");
  ui.w.fixtureState[changed] = "new-context";
  pending.resolve(remote.revisions.at(-1)); await delay(20);
  assert.equal(ui.$("history-snapshot").hidden, true); assert.equal(ui.$("history-comparison").hidden, true);
  assert.equal(ui.$("history-before").textContent, ""); assert.equal(ui.$("history-compare").disabled, true);
  const calls = ui.calls.length;
  ui.$("history-compare").dispatchEvent(new ui.w.Event("click"));
  ui.input("history-version", "2", "change");
  ui.$("history-more").dispatchEvent(new ui.w.Event("click"));
  ui.$("history-download").dispatchEvent(new ui.w.Event("click"));
  assert.equal(ui.calls.length, calls); assert.equal(ui.downloads.length, 0);
  assert.equal(ui.$("editor").value, "# private draft");
});

for (const dismissal of ["close", "cancel", "project switch"]) test(`${dismissal} clears comparison and ignores pending source on reopen`, async (t) => {
  const remote = cloud(3), pending = deferred();
  const ui = await boot(t, { remote, seed: (store) => store.createProject(projectInput({ name: "Other strategy" })),
    respond(path) { if (path.endsWith("/versions/1")) return pending.promise; } });
  await ui.open(cloudId); ui.input("editor", "# kept cloud draft"); await ui.history(); compare(ui);
  ui.input("history-version", "1", "change");
  if (dismissal === "close") ui.$("close-strategy-history").click();
  else if (dismissal === "cancel") ui.$("strategy-history-dialog").dispatchEvent(new ui.w.Event("cancel", { cancelable: true }));
  else await ui.open(ui.seeded.id);
  assert.equal(ui.$("strategy-history-dialog").open, false);
  assert.equal(ui.$("history-comparison").hidden, true); assert.equal(ui.$("history-before").textContent, "");
  await ui.history();
  compare(ui);
  const before = ui.$("history-before").textContent, after = ui.$("history-after").textContent;
  pending.resolve(remote.revisions.at(-1)); await delay(20);
  ui.$("strategy-history-dialog").dispatchEvent(new ui.w.Event("close"));
  assert.equal(ui.$("history-comparison").hidden, false); assert.equal(ui.$("strategy-history-dialog").open, true);
  assert.equal(ui.$("history-before").textContent, before); assert.equal(ui.$("history-after").textContent, after);
});

test("comparison source is inert text, including added files", async (t) => {
  const source = "<img src=x onerror=window.unsafe=true>\r\n<script>window.unsafe=true</script>\n";
  const ui = await boot(t, { seed: (store) => store.createProject(projectInput()) });
  await ui.open(); fileAction(ui, "add", "untrusted.py"); ui.input("editor", source);
  const expected = ui.w.fixtureState.project.files["untrusted.py"], before = ui.shared.snapshot();
  await ui.history(); compare(ui);
  assert.equal(ui.$("history-after").textContent, expected);
  assert.equal(ui.$("history-comparison").querySelector("script,img"), null);
  assert.equal(ui.w.unsafe, undefined); assert.deepEqual(ui.shared.snapshot(), before);
});

for (const changed of ["user", "org"]) test(`a changed ${changed} discards pending first-page metadata before enabling comparison`, async (t) => {
  const remote = cloud(2), pending = deferred();
  const ui = await boot(t, { remote, respond(path) { if (path.endsWith("/versions?limit=50")) return pending.promise; } });
  await ui.open(); ui.$("project-history").click();
  ui.w.fixtureState[changed] = "new-context";
  pending.resolve(remote.page()); await delay(20);
  assert.equal(ui.$("history-version").options.length, 0);
  assert.equal(ui.$("history-project-details").hidden, true);
  assert.equal(ui.$("history-compare").disabled, true);
  assert.equal(ui.$("history-comparison").hidden, true);
});

test("storage failure does not prevent comparison or overwrite an unpersisted dirty draft", async (t) => {
  const ui = await boot(t, { seed: (store) => store.createProject(projectInput()) });
  await ui.open();
  const before = ui.shared.snapshot();
  ui.shared.setItem = () => { throw new Error("Storage unavailable"); };
  ui.input("editor", "# only in memory 😀");
  assert.match(ui.$("draft-state").textContent, /browser storage unavailable/);
  const current = plain(ui.w.fixtureState.project);
  await ui.history(); compare(ui);
  assert.equal(ui.$("history-after").textContent, "# only in memory 😀");
  ui.$("close-strategy-history").click();
  assert.equal(ui.$("editor").value, "# only in memory 😀");
  assert.deepEqual(plain(ui.w.fixtureState.project), current);
  assert.deepEqual(ui.shared.snapshot(), before);
});

test("a pending save finishing after comparison cannot mutate the captured source or newer dirty draft", async (t) => {
  const remote = cloud(1), pending = deferred(); let save;
  const ui = await boot(t, { remote, respond(path, call) {
    if (path === `/v1/projects/${cloudId}/versions` && call.method === "POST") {
      save = JSON.parse(call.body); return pending.promise;
    }
  } });
  await ui.open(); ui.input("editor", "# sent draft"); ui.$("save-version").click();
  await until(() => save, "synthetic save request");
  ui.input("editor", "# newer unsaved draft");
  await ui.history(); compare(ui);
  const captured = ui.$("history-after").textContent, identity = ui.$("history-compare-identity").textContent;
  const calls = ui.calls.length;
  pending.resolve({ ...remote.revisions[0], id: "20000000-0000-4000-8000-000000000002", version_no: 2, files: save.files, entrypoint: save.entrypoint });
  await until(() => ui.w.fixtureState.project.version.version_no === 2, "synthetic save completion");
  assert.equal(ui.$("history-after").textContent, captured);
  assert.equal(ui.$("history-compare-identity").textContent, identity);
  assert.equal(ui.$("editor").value, "# newer unsaved draft");
  assert.match(ui.$("draft-state").textContent, /Unsaved edits/);
  compare(ui);
  assert.match(ui.$("history-compare-identity").textContent, /based on saved v2; includes unsaved edits/);
  assert.equal(ui.$("history-after").textContent, captured);
  assert.equal(ui.calls.length, calls, "Comparison sends no requests, including after a separate in-flight save");
  assert.equal(ui.calls.filter((c) => c.method !== "GET").length, 1, "Only the explicitly clicked synthetic save wrote");
});
