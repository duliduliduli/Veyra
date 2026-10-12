// Offline synthetic DOM tests. No browser launch, account, server, database, upload or strategy execution.
// NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test tests/e2e/public-private-copy-ui.mjs
// shortcut: real dialog focus, browser history and visual layout need separately authorized browser QA.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "workspace-store.js", "studio-assistant.js", "report-evidence.js", "proposal-diff.js", "strategy-backup.js", "saved-links.js", "app.js"]
  .map((name) => readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
const id = "11111111-1111-4111-8111-111111111111", otherId = "22222222-2222-4222-8222-222222222222";
const path = `/v1/public/strategies/${id}`;
const plain = (value) => JSON.parse(JSON.stringify(value));
const fixture = (extra = {}) => ({ id, title: "Published Python", description: "P".repeat(4000),
  published_at: "2026-01-01T00:00:00Z", content_hash: `sha256:${"a".repeat(64)}`,
  files: { "strategy.py": "# License: fixture only\r\nfrom signals.entry import value\r\n",
    "signals/entry.py": "# Preserve this header\r\nvalue = '☀'\r\n", "signals/empty.py": "" },
  entrypoint: "signals/entry.py", ...extra });
const reply = (value, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => plain(value) });
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
async function blobText(w, blob) {
  return new Promise((resolve, reject) => {
    const reader = new w.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}
async function boot(t, { user = false, snapshot = fixture(), shared = storage(), lock = locks(), seed, handle } = {}) {
  const errors = [], calls = [], downloads = [], blobs = new Map(), virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: `https://veyra.test/#public/${id}`, runScripts: "outside-only", virtualConsole });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  t.after(() => { w.close(); assert.deepEqual(errors, [], "No uncaught DOM errors or unexpected fake API calls"); });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  Object.defineProperty(w, "localStorage", { value: shared });
  if (lock) Object.defineProperty(w.navigator, "locks", { value: lock });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  w.URL.createObjectURL = (blob) => { const url = `blob:https://veyra.test/${blobs.size}`; blobs.set(url, blob); return url; };
  w.URL.revokeObjectURL = (url) => blobs.delete(url);
  w.document.addEventListener("click", (event) => {
    const link = event.target.closest("a[download]");
    if (link) { event.preventDefault(); downloads.push({ name: link.download, blob: blobs.get(link.href) }); }
  });
  if (user) shared.setItem("veyra.user", "synthetic-fixture-user");
  let publicReads = 0;
  w.fetch = async (url, options = {}) => {
    const call = { path: String(url), method: options.method || "GET", body: options.body, ...options };
    calls.push(call);
    if (call.method !== "GET") { errors.push(`Unexpected write: ${call.method} ${url}`); return reply({ detail: "No writes allowed" }, 500); }
    if (call.path === "/v1/me") return reply({ organizations: [{ id: "fixture-org" }] });
    if (call.path === "/v1/catalog/datasets") return reply({ datasets: [] });
    if (call.path === "/v1/orgs/fixture-org/billing/balance") return reply({ available_nano: 0 });
    if (call.path.startsWith("/v1/public/strategies/")) {
      const result = await handle?.(call, ++publicReads);
      return result === undefined ? reply({ ...snapshot, id: call.path.split("/").at(-1) }) : result;
    }
    if (call.path === "/v1/public/strategies?q=&limit=21&offset=0") return reply({ strategies: [] });
    errors.push(`Unexpected fake request: ${call.method} ${call.path}`);
    return reply({ detail: "Unexpected fake request" }, 500);
  };
  scripts.slice(0, -1).forEach((script) => w.eval(script));
  const store = w.VeyraWorkspaceStore.create(shared), seeded = seed?.(store, w);
  w.eval(`${scripts.at(-1)}\nwindow.fixtureState = state;`);
  await until(() => !$("view-public").hidden && !$("public-content").hidden, "public snapshot boot");
  const input = (id, value, type = "input") => { $(id).value = value; $(id).dispatchEvent(new w.Event(type, { bubbles: true })); };
  const open = () => $("public-copy").click();
  const confirm = () => $("confirm-public-copy").click();
  const status = () => $("public-copy-status").textContent;
  async function preview() { open(); await until(() => !$("public-copy-preview").hidden, "copy preview"); }
  async function navigate(next) {
    w.location.hash = next; await delay(10);
    await until(() => !$(`view-${next.slice(1).split("/")[0]}`).hidden, `route ${next}`);
  }
  const reads = () => calls.filter((call) => call.path.startsWith("/v1/public/strategies/"));
  return { w, $, calls, store, seeded, shared, lock, downloads, input, open, confirm, status, preview, navigate, reads };
}
async function copied(ui, name = "Published Python") {
  await until(() => !ui.$("view-project").hidden && !ui.$("editor").disabled && ui.$("project-title").textContent === name, "copied editor");
  return ui.store.getProject(ui.w.location.hash.split("/")[1]);
}
const seed = (store, w) => {
  const p = store.createProject({ name: "Existing", files: { "strategy.py": "# existing\r\n" }, entrypoint: "strategy.py" });
  w.localStorage.setItem(`veyra.draft.${p.id}.other-tab`, "untouched opaque draft"); return p;
};

for (const user of [false, true]) test(`public review is read-only and copy is byte-exact device v1 (connected=${user})`, async (t) => {
  const snapshot = fixture(), ui = await boot(t, { user, snapshot, seed }), before = ui.shared.snapshot(), original = plain(ui.store.getProject(ui.seeded.id));
  await ui.preview();
  assert.deepEqual(ui.shared.snapshot(), before);
  assert.equal(ui.reads().length, 2);
  assert.equal(ui.$("public-copy-name").value, snapshot.title);
  for (const value of [id, snapshot.title, snapshot.content_hash, snapshot.entrypoint]) assert.ok(ui.$("public-copy-details").textContent.includes(value));
  assert.deepEqual([...ui.$("public-copy-files").children].map((li) => li.textContent), Object.keys(snapshot.files));
  assert.match(ui.$("public-copy-dialog").textContent, /description and folder start blank/);
  assert.match(ui.$("public-copy-dialog").textContent, /Nothing is uploaded, published or executed/);
  assert.match(ui.$("public-copy-dialog").textContent, /not proof of performance or permission/);
  ui.confirm(); const copy = await copied(ui);
  assert.notEqual(copy.id, ui.seeded.id); assert.equal(copy.visibility, "private"); assert.equal(copy.description, ""); assert.equal(copy.folder, "");
  assert.equal(copy.versions.length, 1); assert.equal(copy.latest_version_no, 1); assert.equal(copy.versions[0].entrypoint, snapshot.entrypoint);
  assert.deepEqual(plain(copy.versions[0].files), snapshot.files);
  assert.deepEqual(plain(ui.store.getProject(ui.seeded.id)), original);
  assert.equal(ui.shared.getItem(`veyra.draft.${ui.seeded.id}.other-tab`), before[`veyra.draft.${ui.seeded.id}.other-tab`]);
  assert.equal(ui.$("project-store").value, "device");
  assert.equal(ui.$("project-library-link").getAttribute("href"), "#code/device");
  assert.equal(ui.w.document.querySelector('.tabs a[data-tab="code"]').getAttribute("href"), "#code/device");
  ui.$("share-project").click();
  assert.equal(ui.$("share-form").hidden, true); assert.match(ui.$("share-availability").textContent, /device-local/);
  ui.$("share-close").click();
  assert.equal(ui.reads().length, 3);
  for (const call of ui.reads()) {
    assert.equal(call.method, "GET"); assert.equal(call.cache, "no-store"); assert.equal(call.credentials, "omit"); assert.deepEqual(plain(call.headers), {}); assert.equal(call.body, undefined);
  }
  await ui.navigate("#code/device");
  assert.equal(ui.store.listProjects().projects.length, 2);
  assert.equal(ui.calls.filter((call) => call.path.includes("/projects")).length, 0);
});

test("public raw source JSON and file download remain unchanged, with a clearer source label", async (t) => {
  const ui = await boot(t), source = fixture();
  assert.equal(ui.$("public-download-snapshot").textContent, "Download source JSON");
  ui.$("public-download-snapshot").click(); ui.$("public-download-file").click();
  assert.equal(ui.downloads[0].name, `veyra-public-${id}.json`);
  assert.equal(await blobText(ui.w, ui.downloads[0].blob), JSON.stringify({ files: source.files, entrypoint: source.entrypoint }, null, 2));
  assert.equal(await blobText(ui.w, ui.downloads[1].blob), source.files[source.entrypoint]);
  assert.equal(ui.store.listProjects().projects.length, 0);
});

test("public metadata stays inert and source is never executed", async (t) => {
  const title = '<img src=x onerror="window.injected=true">', source = 'window.executed = true;';
  const ui = await boot(t, { snapshot: fixture({ title, files: { "strategy.py": source }, entrypoint: "strategy.py" }) });
  await ui.preview(); assert.equal(ui.$("public-copy-dialog").querySelectorAll("img").length, 0);
  ui.confirm(); const copy = await copied(ui, title);
  assert.equal(copy.versions[0].files["strategy.py"], source);
  assert.equal(ui.w.injected, undefined); assert.equal(ui.w.executed, undefined);
});

test("local path and source limits reject unsupported snapshots without shortening", async (t) => {
  const longPath = `${"x".repeat(254)}.py`;
  const invalid = [fixture({ files: { [longPath]: "# intact" }, entrypoint: longPath }),
    fixture({ files: { "../outside.py": "# intact" }, entrypoint: "../outside.py" }),
    fixture({ files: { "strategy.py": "x".repeat(256 * 1024 + 1) }, entrypoint: "strategy.py" }),
    fixture({ files: { "strategy.py": "\ud800" }, entrypoint: "strategy.py" })];
  for (const snapshot of invalid) {
    const ui = await boot(t, { snapshot }); const before = ui.shared.snapshot(); ui.open();
    await until(() => !ui.$("public-copy-retry").hidden, "unsupported snapshot");
    assert.equal(ui.$("public-copy-preview").hidden, true); assert.equal(ui.$("confirm-public-copy").disabled, true);
    assert.deepEqual(ui.shared.snapshot(), before); assert.equal(ui.store.listProjects().projects.length, 0);
  }
});

for (const stage of [2, 3]) test(`revoked/unavailable source check at read ${stage} creates nothing and supports retry`, async (t) => {
  let rejected = true;
  const ui = await boot(t, { handle: (_call, count) => count === stage && rejected ? reply({ detail: "Not found" }, 404) : undefined });
  const before = ui.shared.snapshot();
  if (stage === 2) ui.open(); else { await ui.preview(); ui.confirm(); }
  await until(() => /revoked/.test(ui.status()), "revoked message");
  assert.deepEqual(ui.shared.snapshot(), before); assert.equal(ui.store.listProjects().projects.length, 0);
  assert.doesNotMatch(ui.$("status").textContent, /Created/); rejected = false;
  if (stage === 2) { ui.$("public-copy-retry").click(); await until(() => !ui.$("public-copy-preview").hidden, "rechecked preview"); }
  ui.confirm(); await copied(ui); assert.equal(ui.store.listProjects().projects.length, 1);
});

test("fresh reads pin every identity field, file path, source byte and entrypoint", async (t) => {
  const changes = [{ id: otherId }, { title: "Changed title" }, { description: "Changed description" },
    { published_at: "2026-02-01T00:00:00Z" }, { content_hash: `sha256:${"b".repeat(64)}` },
    { entrypoint: "strategy.py" }, { files: { ...fixture().files, "strategy.py": "# changed with same hash" } },
    { files: { ...fixture().files, "new.py": "# unexpected" } }];
  for (const stage of [2, 3]) for (const change of changes) {
    const ui = await boot(t, { handle: (_call, count) => count === stage ? reply(fixture(change)) : undefined });
    const before = ui.shared.snapshot();
    if (stage === 2) ui.open(); else { await ui.preview(); ui.confirm(); }
    await until(() => /snapshot changed/.test(ui.status()), "mismatched snapshot");
    assert.deepEqual(ui.shared.snapshot(), before); assert.equal(ui.store.listProjects().projects.length, 0);
  }
});

test("name conflict and quota failure preserve preview, existing versions and drafts for retry", async (t) => {
  const ui = await boot(t, { seed }); await ui.preview(); ui.input("public-copy-name", "Existing");
  const before = ui.shared.snapshot(); ui.confirm();
  await until(() => /already exists/.test(ui.status()), "name collision");
  assert.equal(ui.w.document.activeElement, ui.$("public-copy-name")); assert.deepEqual(ui.shared.snapshot(), before);
  ui.input("public-copy-name", "New private name"); ui.shared.failWrite = true; ui.confirm();
  await until(() => /not saved/.test(ui.status()), "quota failure");
  assert.equal(ui.$("public-copy-preview").hidden, false); assert.equal(ui.$("confirm-public-copy").disabled, false);
  assert.equal(ui.$("public-copy-name").value, "New private name"); assert.deepEqual(ui.shared.snapshot(), before);
  ui.shared.failWrite = false; ui.confirm(); await copied(ui, "New private name");
  assert.equal(ui.store.listProjects().projects.length, 2);
});

test("missing Web Locks, malformed local storage and invalid renamed metadata fail closed", async (t) => {
  for (const mode of ["locks", "storage", "name"]) {
    const ui = await boot(t, { lock: mode === "locks" ? null : locks() }); await ui.preview();
    if (mode === "storage") ui.shared.setItem("veyra.workspace.v1", "not valid storage");
    if (mode === "name") ui.input("public-copy-name", "x".repeat(121));
    const before = ui.shared.snapshot();
    ui.$("public-copy-form").dispatchEvent(new ui.w.Event("submit", { cancelable: true }));
    await until(() => /Web Locks|damaged|120 characters/.test(ui.status()), `${mode} error`);
    assert.deepEqual(ui.shared.snapshot(), before); assert.equal(ui.$("confirm-public-copy").disabled, false);
    assert.doesNotMatch(ui.$("status").textContent, /Created/);
  }
});

test("network errors retain the review and retries recheck without a local write lock", async (t) => {
  let fail = true;
  const ui = await boot(t, { handle: (_call, count) => { if (count === 3 && fail) throw new Error("Offline fixture"); } });
  await ui.preview(); const before = ui.shared.snapshot(); ui.confirm();
  await until(() => /Offline fixture/.test(ui.status()), "network error");
  assert.equal(ui.lock.calls.length, 0); assert.deepEqual(ui.shared.snapshot(), before);
  assert.equal(ui.$("public-copy-preview").hidden, false); fail = false; ui.confirm(); await copied(ui);
});

test("Close, Cancel, Escape and navigation invalidate delayed checks at review and submit", async (t) => {
  for (const stage of [2, 3]) for (const action of ["close-public-copy", "cancel-public-copy", "escape", "navigation"]) {
    const gate = deferred(), ui = await boot(t, { handle: (_call, count) => count === stage ? gate.promise : undefined });
    if (stage === 2) ui.open(); else { await ui.preview(); ui.confirm(); }
    await until(() => ui.reads().length === stage, "pending read");
    assert.equal(ui.lock.calls.length, 0, "Network check must never hold the workspace lock");
    if (action === "escape") ui.$("public-copy-dialog").dispatchEvent(new ui.w.Event("cancel", { cancelable: true }));
    else if (action === "navigation") await ui.navigate("#discover"); else ui.$(action).click();
    gate.resolve(reply(fixture())); await delay(20);
    assert.equal(ui.$("public-copy-dialog").open, false); assert.equal(ui.store.listProjects().projects.length, 0);
    assert.doesNotMatch(ui.$("status").textContent, /Created/);
  }
});

test("cancel/reopen ignores a stale success or failure and delayed native close event", async (t) => {
  for (const reject of [false, true]) {
    const gate = deferred(), ui = await boot(t, { handle: (_call, count) => count === 2 ? gate.promise : undefined });
    ui.open(); await until(() => ui.reads().length === 2, "slow check"); ui.$("cancel-public-copy").click();
    await ui.preview(); const status = ui.status(); ui.$("public-copy-dialog").dispatchEvent(new ui.w.Event("close"));
    if (reject) gate.reject(new Error("Stale failure")); else gate.resolve(reply(fixture({ title: "Stale response" })));
    await delay(20); assert.equal(ui.$("public-copy-dialog").open, true); assert.equal(ui.status(), status);
    ui.confirm(); await copied(ui); assert.equal(ui.store.listProjects().projects.length, 1);
  }
});

test("duplicate submit queues only one local create and queued cancellation permits a fresh review", async (t) => {
  for (const cancel of [false, true]) {
    const lock = locks(), gate = deferred(), held = lock.request("veyra.workspace.v1", { mode: "exclusive" }, () => gate.promise);
    const ui = await boot(t, { lock }); await ui.preview(); ui.confirm();
    ui.$("public-copy-form").dispatchEvent(new ui.w.Event("submit", { cancelable: true }));
    await until(() => lock.calls.length === 2, "queued copy");
    assert.equal(ui.reads().length, 3); assert.equal(ui.store.listProjects().projects.length, 0);
    if (cancel) {
      ui.$("cancel-public-copy").click(); await ui.preview(); ui.input("public-copy-name", "Fresh review"); ui.confirm();
      await until(() => lock.calls.length === 3, "new queued copy");
    }
    gate.resolve(); await held; await copied(ui, cancel ? "Fresh review" : "Published Python");
    assert.equal(ui.store.listProjects().projects.length, 1);
    assert.deepEqual(lock.calls.at(-1), { name: "veyra.workspace.v1", mode: "exclusive" });
  }
});

test("route, source selection, refreshed public request and name guards hold inside the write lock", async (t) => {
  for (const action of ["route", "same-route-return", "selection", "refresh", "name"]) {
    const lock = locks(), gate = deferred(), held = lock.request("veyra.workspace.v1", { mode: "exclusive" }, () => gate.promise);
    const ui = await boot(t, { lock }); await ui.preview(); ui.confirm();
    await until(() => lock.calls.length === 2, "queued write");
    if (action === "route") ui.w.history.replaceState(null, "", `#public/${otherId}`);
    else if (action === "same-route-return") { await ui.navigate("#discover"); await ui.navigate(`#public/${id}`); }
    else if (action === "selection") ui.input("public-file", "strategy.py", "change");
    else if (action === "refresh") ui.$("public-retry").click();
    else ui.$("public-copy-name").value = "Unreviewed replacement";
    gate.resolve(); await held; await delay(20);
    assert.equal(ui.store.listProjects().projects.length, 0); assert.doesNotMatch(ui.$("status").textContent, /Created/);
  }
});

test("same-turn route or source selection change before submit cannot even start another check", async (t) => {
  for (const action of ["route", "selection"]) {
    const ui = await boot(t); await ui.preview();
    if (action === "route") ui.w.history.replaceState(null, "", `#public/${otherId}`);
    else ui.input("public-file", "strategy.py", "change");
    ui.confirm(); await delay(20);
    assert.equal(ui.reads().length, 2); assert.equal(ui.lock.calls.length, 0); assert.equal(ui.store.listProjects().projects.length, 0);
  }
});

test("completion after an atomic write cannot navigate away from a newer review", async (t) => {
  const gate = deferred(); let written = false;
  const lock = { request: async (_name, _options, operation) => { const result = operation(); written = true; await gate.promise; return result; } };
  const ui = await boot(t, { lock }); await ui.preview(); ui.confirm(); await until(() => written, "atomic write");
  ui.$("cancel-public-copy").click(); await ui.preview(); ui.input("public-copy-name", "New review"); const status = ui.status();
  gate.resolve(); await delay(20);
  assert.equal(ui.w.location.hash, `#public/${id}`); assert.equal(ui.$("public-copy-dialog").open, true);
  assert.equal(ui.$("public-copy-name").value, "New review"); assert.equal(ui.status(), status);
  assert.equal(ui.store.listProjects().projects.length, 1); assert.doesNotMatch(ui.$("status").textContent, /Created/);
});

test("two tabs share the lock and preserve data when copy names collide", async (t) => {
  const shared = storage(), lock = locks(), first = await boot(t, { shared, lock }), second = await boot(t, { shared, lock });
  await first.preview(); await second.preview(); first.confirm(); second.confirm(); await copied(first);
  await until(() => /already exists/.test(second.status()), "cross-tab conflict");
  assert.equal(first.store.listProjects().projects.length, 1);
  second.input("public-copy-name", "Second tab copy"); second.confirm(); await copied(second, "Second tab copy");
  assert.equal(first.store.listProjects().projects.length, 2);
  for (const p of first.store.listProjects().projects) assert.equal(p.latest_version_no, 1);
});


for (const field of ["user", "org"]) test(`changed ${field} invalidates a review before submission and permits a fresh review`, async (t) => {
  const ui = await boot(t, { user: true }); await ui.preview(); const before = ui.shared.snapshot();
  ui.w.fixtureState[field] = "new-synthetic-account"; ui.confirm(); await delay(20);
  assert.equal(ui.reads().length, 2); assert.deepEqual(ui.shared.snapshot(), before);
  ui.$("cancel-public-copy").click(); await ui.preview(); ui.confirm(); await copied(ui);
  assert.equal(ui.store.listProjects().projects.length, 1);
});

for (const field of ["user", "org"]) test(`changed ${field} cancels pending initial and submit reads without stale errors`, async (t) => {
  for (const stage of [2, 3]) for (const reject of [false, true]) {
    const gate = deferred(), ui = await boot(t, { user: true, handle: (_call, count) => count === stage ? gate.promise : undefined });
    if (stage === 2) ui.open(); else { await ui.preview(); ui.confirm(); }
    await until(() => ui.reads().length === stage, "pending account-bound read");
    ui.w.fixtureState[field] = "new-synthetic-account"; const status = ui.status();
    if (reject) gate.reject(new Error("Stale account error")); else gate.resolve(reply(fixture()));
    await delay(20);
    assert.equal(ui.status(), status); assert.equal(ui.$("public-copy-preview").hidden, stage === 2);
    assert.equal(ui.store.listProjects().projects.length, 0); assert.equal(ui.lock.calls.length, 0);
    ui.$("cancel-public-copy").click(); await ui.preview(); ui.input("public-copy-name", "New account review");
    ui.confirm(); await copied(ui, "New account review"); assert.equal(ui.store.listProjects().projects.length, 1);
  }
});

for (const field of ["user", "org"]) test(`changed ${field} cancels a queued write without blocking a reopened review`, async (t) => {
  const lock = locks(), gate = deferred(), held = lock.request("veyra.workspace.v1", { mode: "exclusive" }, () => gate.promise);
  const ui = await boot(t, { user: true, lock }); await ui.preview(); ui.confirm();
  await until(() => lock.calls.length === 2, "queued account-bound write");
  ui.w.fixtureState[field] = "new-synthetic-account"; gate.resolve(); await held; await delay(20);
  assert.equal(ui.store.listProjects().projects.length, 0); assert.doesNotMatch(ui.$("status").textContent, /Created/);
  ui.$("cancel-public-copy").click(); await ui.preview(); ui.confirm(); await copied(ui);
  assert.equal(ui.store.listProjects().projects.length, 1);
});


test("an emoji-rich public title stays intact and can be replaced with a valid private name", async (t) => {
  for (const title of ["🧪".repeat(120), "outer whitespace ", "two\nlines"]) {
    const ui = await boot(t, { snapshot: fixture({ title }) }); await ui.preview();
    assert.ok(ui.$("public-copy-details").textContent.includes(title));
    assert.equal(ui.$("public-copy-name").value, title.includes("\n") ? "" : title);
    assert.equal(ui.$("public-copy-name").disabled, false);
    if (title.includes("\n")) assert.match(ui.status(), /cannot be used unchanged/);
    ui.$("public-copy-form").dispatchEvent(new ui.w.Event("submit", { cancelable: true }));
    await until(() => /120 characters|outer whitespace|Name is required/.test(ui.status()), "invalid default name");
    assert.equal(ui.store.listProjects().projects.length, 0); assert.equal(ui.reads().length, 2);
    ui.input("public-copy-name", "My private copy"); ui.confirm(); const copy = await copied(ui, "My private copy");
    assert.deepEqual(plain(copy.versions[0].files), fixture().files); assert.equal(copy.name, "My private copy");
    assert.equal(ui.store.listProjects().projects.length, 1);
  }
});
