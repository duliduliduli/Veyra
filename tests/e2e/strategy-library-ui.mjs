// Offline synthetic metadata paging checks; no browser, server, source execution or real writes.
// NODE_PATH=/path/to/jsdom/node_modules node --test tests/e2e/strategy-library-ui.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "workspace-store.js", "studio-assistant.js", "report-evidence.js", "proposal-diff.js", "strategy-backup.js", "saved-links.js", "app.js"]
  .map((name) => readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
const reply = (value, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => value });
const page = (projects, next_cursor = null) => reply({ projects, next_cursor, has_more: next_cursor !== null });
const project = (n, extras = {}) => ({ id: `project-${n}`, name: `Strategy ${n}`, description: "", folder: null,
  visibility: "private", latest_version_no: 1, updated_at: "2026-01-01T00:00:00Z", ...extras });
const path = "/v1/orgs/fixture-org/projects";
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(condition, label) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail(`Timed out waiting for ${label}`);
}
async function boot(t, { user = true, handle, seed } = {}) {
  const calls = [], errors = [], console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: "https://veyra.test/#code", runScripts: "outside-only", virtualConsole: console });
  const w = dom.window, doc = w.document, $ = (id) => doc.getElementById(id);
  t.after(() => { w.close(); assert.deepEqual(errors, [], "No unexpected DOM or API activity"); });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  if (user) w.localStorage.setItem("veyra.user", "synthetic-fixture-user");
  w.fetch = async (url, options = {}) => {
    const call = { path: String(url), method: options.method || "GET" }; calls.push(call);
    if (call.path === "/v1/me") return reply({ organizations: [{ id: "fixture-org" }] });
    if (call.path === "/v1/catalog/datasets") return reply({ datasets: [] });
    if (call.path === "/v1/orgs/fixture-org/billing/balance") return reply({ available_nano: 0 });
    if (call.path === "/v1/public/strategies?q=&limit=21&offset=0") return reply({ strategies: [] });
    const result = await handle?.(call);
    if (result !== undefined) return result;
    errors.push(`Unexpected fake request: ${call.method} ${url}`);
    return reply({ detail: "Unexpected fake request" }, 500);
  };
  scripts.slice(0, -1).forEach((script) => w.eval(script));
  seed?.(w.VeyraWorkspaceStore.create(w.localStorage), w);
  w.eval(`${scripts.at(-1)}\nwindow.libraryFixtureState = state;`);
  await until(() => !$("view-code").hidden, "library route");
  await delay(5);
  const input = (id, value) => { $(id).value = value; $(id).dispatchEvent(new w.Event("input", { bubbles: true })); };
  const navigate = async (hash) => {
    w.location.hash = hash;
    await until(() => !$(`view-${hash.slice(1)}`).hidden, `route ${hash}`); await delay(5);
  };
  const reads = () => calls.filter((call) => call.path.startsWith(path));
  const links = () => [...$("project-list").querySelectorAll("a")];
  const done = () => until(() => !$("refresh-projects").disabled, "library finish");
  return { w, $, calls, input, navigate, reads, links, done };
}

test("loads beyond 100 in bounded pages; the oldest strategy, description and folder become discoverable", async (t) => {
  const second = deferred(), third = deferred();
  const rows = Array.from({ length: 237 }, (_, i) => project(i));
  rows[236] = project(236, { name: "Oldest experiment", description: "Deep Value", folder: "Archive" });
  const ui = await boot(t, { handle: ({ path: url }) => {
    if (url === path) return page(rows.slice(0, 100), "cursor+/1=");
    if (url === `${path}?cursor=cursor%2B%2F1%3D`) return second.promise;
    if (url === `${path}?cursor=cursor2`) return third.promise;
  } });
  assert.equal(ui.links().length, 100);
  assert.match(ui.$("projects-scope").textContent, /100 strategies loaded.*Loading more/);
  assert.equal(ui.$("project-list").getAttribute("aria-busy"), "true");
  ui.input("project-search", "deep VALUE");
  assert.match(ui.$("project-list").textContent, /No matches loaded yet/);
  assert.doesNotMatch(ui.$("project-list").textContent, /Create your first|No matching strategies/);
  second.resolve(page(rows.slice(100, 200), "cursor2"));
  await until(() => ui.reads().length === 3, "third page");
  assert.match(ui.$("projects-scope").textContent, /200 strategies loaded · 0 shown/);
  third.resolve(page(rows.slice(200))); await ui.done();
  assert.equal(ui.links().length, 1);
  assert.equal(ui.links()[0].getAttribute("href"), "#project/project-236");
  assert.match(ui.$("project-folder").textContent, /Archive/);
  ui.input("project-folder", "Archive");
  assert.equal(ui.links().length, 1);
  assert.match(ui.$("projects-scope").textContent, /237 strategies loaded · 1 shown.*All pages loaded.*Refresh/);
  assert.equal(ui.$("project-list").getAttribute("aria-busy"), "false");
  ui.input("project-search", "oldest"); assert.equal(ui.links().length, 1);
  ui.input("project-search", "not present"); assert.match(ui.$("project-list").textContent, /No matching strategies/);
  assert.equal(ui.reads().length, 3, "Filters only search loaded metadata");
  assert.ok(ui.calls.every((call) => call.method === "GET"), "Listing is read-only");
});

test("empty library is complete only after the terminal page", async (t) => {
  const first = deferred(); const ui = await boot(t, { handle: () => first.promise });
  assert.match(ui.$("projects-scope").textContent, /0 strategies loaded.*Loading more/);
  assert.doesNotMatch(ui.$("project-list").textContent, /Create your first/);
  first.resolve(page([])); await ui.done();
  assert.match(ui.$("project-list").textContent, /Create your first/);
  assert.match(ui.$("projects-scope").textContent, /0 strategies loaded.*All pages loaded/);
});

test("later-page failure retains loaded matches and Refresh starts from the first page", async (t) => {
  let refresh = false;
  const ui = await boot(t, { handle: ({ path: url }) => {
    if (url === path) return refresh ? page([project(2, { folder: "Kept" }), project(3)]) : page([project(1, { folder: "Kept" })], "older");
    if (url === `${path}?cursor=older`) return reply({ detail: "Synthetic read failure" }, 503);
  } });
  await ui.done();
  assert.equal(ui.links().length, 1);
  assert.match(ui.$("projects-scope").textContent, /1 strategies loaded.*Loading failed.*incomplete.*Synthetic read failure/);
  ui.input("project-search", "missing");
  assert.match(ui.$("project-list").textContent, /No matches in the loaded strategies/);
  ui.input("project-search", ""); ui.input("project-folder", "Kept"); refresh = true;
  ui.$("refresh-projects").click(); await ui.done();
  assert.equal(ui.$("project-folder").value, "Kept");
  assert.match(ui.$("projects-scope").textContent, /2 strategies loaded · 1 shown.*All pages loaded/);
  assert.doesNotMatch(ui.$("project-list").textContent, /Strategy 1/);
  assert.equal(ui.reads().at(-1).path, path);
});

test("a fresh refresh clears prior rows and folders before an initial-page error", async (t) => {
  const pending = deferred(); let calls = 0;
  const ui = await boot(t, { handle: () => ++calls === 1 ? page([project(1, { folder: "Old folder" })]) : pending.promise });
  await ui.done(); ui.$("refresh-projects").click();
  assert.equal(ui.links().length, 0);
  assert.doesNotMatch(ui.$("project-folder").textContent, /Old folder/);
  assert.match(ui.$("projects-scope").textContent, /0 strategies loaded.*Loading more/);
  pending.resolve(reply({ detail: "Not available" }, 503)); await ui.done();
  assert.equal(ui.links().length, 0);
  assert.match(ui.$("projects-scope").textContent, /0 strategies loaded.*Loading failed/);
  assert.doesNotMatch(ui.$("project-list").textContent, /Create your first/);
});

test("overlapping pages deduplicate IDs, keep known metadata and retain a selected late folder during refresh", async (t) => {
  let refresh = false; const late = deferred();
  const ui = await boot(t, { handle: ({ path: url }) => {
    if (url === path) return refresh ? page([project(1)], "late") : page([project(1), project(2, { folder: "Late" })]);
    if (url === `${path}?cursor=late`) return late.promise;
  } });
  await ui.done(); ui.input("project-folder", "Late"); refresh = true; ui.$("refresh-projects").click();
  await until(() => ui.reads().length === 3, "later refresh page");
  assert.equal(ui.$("project-folder").value, "Late");
  assert.match(ui.$("projects-scope").textContent, /1 strategies loaded · 0 shown/);
  late.resolve(page([project(1, { name: "Older duplicate" }), project(2, { folder: "Late" })])); await ui.done();
  assert.equal(ui.links().length, 1);
  ui.input("project-folder", "");
  assert.equal(ui.links().length, 2);
  assert.doesNotMatch(ui.$("project-list").textContent, /Older duplicate/);
});

for (const [label, value] of [
  ["legacy missing paging metadata", { projects: [project(1)] }],
  ["empty continuing page", { projects: [], has_more: true, next_cursor: "next" }],
  ["missing continuing cursor", { projects: [project(1)], has_more: true, next_cursor: null }],
  ["oversized cursor", { projects: [project(1)], has_more: true, next_cursor: "a".repeat(513) }],
  ["contradictory terminal cursor", { projects: [project(1)], has_more: false, next_cursor: "next" }],
  ["oversized page", { projects: Array.from({ length: 101 }, (_, i) => project(i)), has_more: false, next_cursor: null }],
  ["invalid record", { projects: [null], has_more: false, next_cursor: null }],
]) test(`rejects ${label} without claiming a complete or empty library`, async (t) => {
  const ui = await boot(t, { handle: () => reply(value) }); await ui.done();
  assert.match(ui.$("projects-scope").textContent, /Loading failed.*incomplete/);
  assert.doesNotMatch(ui.$("projects-scope").textContent, /All pages loaded/);
  assert.doesNotMatch(ui.$("project-list").textContent, /Create your first/);
  assert.equal(ui.reads().length, 1);
});

test("repeated cursor cycles stop safely with the previously accepted metadata", async (t) => {
  let calls = 0;
  const ui = await boot(t, { handle: () => ++calls === 1 ? page([project(1)], "a") : calls === 2 ? page([project(2)], "b") : page([project(3)], "a") });
  await ui.done();
  assert.equal(ui.reads().length, 3);
  assert.equal(ui.links().length, 2);
  assert.match(ui.$("projects-scope").textContent, /2 strategies loaded.*Loading failed/);
});

test("no-progress continuing pages stop even if they invent a different cursor", async (t) => {
  let calls = 0;
  const ui = await boot(t, { handle: () => page([project(1)], String(++calls)) }); await ui.done();
  assert.equal(ui.reads().length, 2);
  assert.equal(ui.links().length, 1);
  assert.match(ui.$("projects-scope").textContent, /repeated a strategy page/);
});

for (const failure of [false, true]) test(`an old ${failure ? "failed" : "successful"} page cannot replace a same-URL revisit`, async (t) => {
  const old = deferred(); let first = 0;
  const ui = await boot(t, { handle: ({ path: url }) => {
    if (url === path) return ++first === 1 ? page([project(1)], "old") : page([project(99, { folder: "Current" })]);
    if (url === `${path}?cursor=old`) return old.promise;
  } });
  await until(() => ui.reads().length === 2, "old second page");
  await ui.navigate("#discover"); await ui.navigate("#code"); await ui.done();
  old.resolve(failure ? reply({ detail: "Stale failed page" }, 503) : page([project(2)], "should-not-fetch"));
  await delay(20);
  assert.equal(ui.links().length, 1);
  assert.equal(ui.links()[0].getAttribute("href"), "#project/project-99");
  assert.match(ui.$("projects-scope").textContent, /1 strategies loaded.*All pages loaded/);
  assert.doesNotMatch(ui.$("status").textContent, /Stale/);
  assert.equal(ui.reads().length, 3, "No next request from the abandoned visit");
  assert.equal(ui.$("refresh-projects").disabled, false);
});

test("leaving during the first page stops pagination and late UI/error effects", async (t) => {
  const pending = deferred(); const ui = await boot(t, { handle: () => pending.promise });
  await ui.navigate("#discover");
  pending.resolve(page([project(1)], "unused")); await delay(20);
  assert.equal(ui.reads().length, 1);
  assert.equal(ui.links().length, 0);
  assert.equal(ui.$("view-code").hidden, true);
});

test("repeated Refresh clicks start one read chain and an older request cannot unlock it", async (t) => {
  const old = deferred(), fresh = deferred(); let calls = 0;
  const ui = await boot(t, { handle: () => ++calls === 1 ? old.promise : fresh.promise });
  await ui.navigate("#discover"); await ui.navigate("#code");
  old.resolve(page([project(1)])); await delay(20);
  assert.equal(ui.$("refresh-projects").disabled, true);
  ui.$("refresh-projects").click();
  ui.$("refresh-projects").dispatchEvent(new ui.w.Event("click"));
  assert.equal(ui.reads().length, 2);
  fresh.resolve(page([project(2)])); await ui.done();
  assert.equal(ui.links()[0].getAttribute("href"), "#project/project-2");
});

test("a different workspace identity invalidates in-flight metadata", async (t) => {
  const pending = deferred(); const ui = await boot(t, { handle: () => pending.promise });
  ui.w.libraryFixtureState.org = "different-org";
  pending.resolve(page([project(1)], "unused")); await delay(20);
  assert.equal(ui.reads().length, 1); assert.equal(ui.links().length, 0);
});

test("device-local library remains complete beyond 100 without cloud reads or storage changes", async (t) => {
  let original;
  const ui = await boot(t, { user: false, seed: (store, w) => {
    for (let i = 0; i < 105; i++) store.createProject({ name: `Local ${i}`, files: { "strategy.py": "# inert fixture\n" }, folder: i === 0 ? "Archive" : "" });
    original = w.localStorage.getItem("veyra.workspace.v1");
  } });
  await ui.done(); assert.equal(ui.links().length, 105);
  assert.match(ui.$("projects-scope").textContent, /105 strategies loaded.*All strategies on this device/);
  ui.input("project-folder", "Archive"); assert.equal(ui.links().length, 1);
  assert.match(ui.links()[0].textContent, /Local 0/);
  ui.$("refresh-projects").click(); await ui.done();
  assert.equal(ui.links().length, 1);
  assert.equal(ui.reads().length, 0);
  assert.equal(ui.w.localStorage.getItem("veyra.workspace.v1"), original);
});

test("hash changes invalidate pending reads before the hashchange handler runs", async (t) => {
  const pending = deferred(); const ui = await boot(t, { handle: () => pending.promise });
  ui.w.location.hash = "#discover";
  pending.resolve(page([project(1)], "must-not-fetch"));
  await Promise.resolve(); await Promise.resolve(); await delay(20);
  assert.equal(ui.reads().length, 1);
  assert.equal(ui.links().length, 0);
});
