// DOM-only saved approval recovery checks. Every HTTP response is synthetic.
// No real browser, API, database, billing operation or Python execution.
// NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test tests/e2e/approval-recovery-ui.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "workspace-store.js", "studio-assistant.js", "report-evidence.js", "proposal-diff.js", "strategy-backup.js", "saved-links.js", "backtest-params.js", "app.js"]
  .map(name => readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = id(100), project = id(200), version = id(201), jobId = id(300);
const now = Date.parse("2026-10-12T10:00:00Z");
const iso = time => new Date(time).toISOString();
const plain = value => JSON.parse(JSON.stringify(value));
const response = (value, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => plain(value) });
const page = (authorizations = [], extra = {}) => ({ authorizations, next_cursor: null, has_more: false, as_of: iso(now), ...extra });
function approval(n = 1, extra = {}) {
  const created = now - n * 1000;
  return { id: id(n), quote_id: id(1000 + n), project_id: project, project_name: "Current strategy name",
    project_version_id: version, version_no: 7, content_hash: "sha256:" + "a".repeat(64), input_hash: "sha256:" + "b".repeat(64),
    request: { project_version_id: version, dataset_id: "synthetic-test", start: "2024-01-01", end: "2025-01-01",
      starting_cash: "10000.00", params: { fast: 10, slow: 30 }, resource_class: "small", max_runtime_seconds: 30,
      taker_fee_bps: "10", slippage_bps: "5" },
    reserved_nano: 1007979, created_at: iso(created), claim_expires_at: iso(created + 900000), status: "reserved",
    job: null, recovery_state: "claimable", ...extra };
}
const createdJob = (extra = {}) => ({ id: jobId, authorization_id: id(1), org_id: org, project_version_id: version,
  budget: { reserved_nano: 1007979 }, state: "queued", ...extra });
const expired = (n = 1, extra = {}) => approval(n, { created_at: iso(now - 1000000), claim_expires_at: iso(now - 100000), recovery_state: "expired_pending_release", ...extra });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function until(condition, label) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail(`Timed out waiting for ${label}`);
}
async function boot(t, { hash = "#approvals", user = true, handle } = {}) {
  const errors = [], calls = [], timers = new Map(); let elapsed = 0, timerId = 0;
  const vc = new VirtualConsole(); vc.on("jsdomError", error => errors.push(error.message));
  const dom = new JSDOM(html, { url: `https://veyra.test/${hash}`, runScripts: "outside-only", virtualConsole: vc });
  const w = dom.window, doc = w.document, $ = name => doc.getElementById(name);
  t.after(() => { w.close(); assert.deepEqual(errors, []); });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  if (user) w.localStorage.setItem("veyra.user", "fixture-user");
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  w.performance.now = () => elapsed;
  const set = w.setTimeout.bind(w), clear = w.clearTimeout.bind(w);
  w.setTimeout = (fn, ms, ...args) => {
    if (ms === 4000 || ms < 1000) return set(fn, ms, ...args);
    const key = --timerId; timers.set(key, { fn, at: elapsed + ms }); return key;
  };
  w.clearTimeout = key => timers.has(key) ? timers.delete(key) : clear(key);
  w.fetch = async (path, options = {}) => {
    const call = { path: String(path), method: options.method || "GET", headers: options.headers,
      body: options.body ? JSON.parse(options.body) : null }; calls.push(call);
    if (path === "/v1/me") return response({ organizations: [{ id: org }] });
    if (path === "/v1/catalog/datasets") return response({ datasets: [] });
    const custom = await handle?.(call);
    if (custom !== undefined) return custom;
    if (path === `/v1/orgs/${org}/billing/balance`) return response({ available_nano: 1000000000 });
    if (path === `/v1/orgs/${org}/projects`) return response({ projects: [], has_more: false, next_cursor: null });
    if (String(path).includes("/jobs?")) return response({ jobs: [], next_cursor: null });
    if (String(path).startsWith("/v1/jobs/") && call.method === "GET") return response({ id: String(path).split("/").at(-1), state: "queued", budget: { reserved_nano: 1007979 }, progress: {} });
    errors.push(`Unexpected synthetic API call: ${call.method} ${path}`);
    return response({ detail: "Unexpected synthetic API call" }, 500);
  };
  scripts.forEach((s, index) => w.eval(s + (index === scripts.length - 1 ? "\nwindow.recoveryTest = { state, route, refreshBalance };" : "")));
  const view = hash.slice(1).split("/")[0];
  await until(() => !$(`view-${view}`).hidden, "initial route"); await delay(5);
  async function navigate(hash) {
    w.location.hash = hash;
    await until(() => !$(`view-${hash.slice(1).split("/")[0]}`).hidden, hash); await delay(5);
  }
  const posts = () => calls.filter(call => call.method !== "GET");
  const listCalls = () => calls.filter(call => call.path.includes("/authorizations?"));
  const loaded = () => until(() => !$("approvals-refresh").disabled && !$("approvals-status").textContent.startsWith("Loading"), "approvals loaded");
  function open(index = 0) { $("approval-list").querySelectorAll("button")[index].click(); }
  function advance(ms) {
    elapsed += ms;
    for (const [key, timer] of [...timers]) if (timer.at <= elapsed) { timers.delete(key); timer.fn(); }
  }
  return { w, doc, $, calls, posts, listCalls, navigate, loaded, open, advance, timers };
}

test("Backtests reads no approvals until explicit navigation; project links retain scope", async t => {
  const ui = await boot(t, { hash: `#runs/${project}`, handle: call => call.path.includes("/authorizations?") ? response(page()) : undefined });
  assert.equal(ui.listCalls().length, 0);
  assert.equal(ui.$("open-approvals").getAttribute("href"), `#approvals/${project}`);
  ui.$("open-approvals").click(); await ui.loaded();
  await until(() => ui.listCalls().length === 1, "explicit approval read");
  const query = new URL(ui.listCalls()[0].path, "https://veyra.test").searchParams;
  assert.equal(query.get("project_id"), project); assert.equal(query.get("limit"), "50");
  assert.equal(ui.$("approvals-back").getAttribute("href"), `#runs/${project}`);
  assert.equal(ui.$("approvals-all").hidden, false);
  assert.equal(ui.doc.querySelector('[data-tab="runs"]').getAttribute("aria-current"), "page");
  assert.equal(ui.posts().length, 0);
});

test("reload discovers server records, exact immutable inputs, no source reads or automatic execution", async t => {
  const item = approval(1, { project_name: '<img src=x onerror="boom()">' });
  item.request.params = { note: '<script>alert("x")</script>', fast: 10 };
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([item])) : undefined });
  await ui.loaded(); ui.open();
  const details = ui.$("approval-review-details").textContent;
  for (const value of ["Current strategy name", "v7", version, item.content_hash, item.input_hash, item.id, item.quote_id,
    "synthetic-test", "2024-01-01 to 2025-01-01", "10000.00", "fast", "small", "30 seconds", "10 bps", "5 bps", "$0.001007979", item.claim_expires_at]) assert.ok(details.includes(value), value);
  assert.equal(ui.$("approval-list").querySelector("img"), null);
  assert.equal(ui.$("approval-review-details").querySelector("script"), null);
  assert.equal(ui.posts().length, 0); assert.equal(ui.calls.some(c => /versions|\/quotes/.test(c.path)), false);
  assert.equal(ui.w.localStorage.length, 1, "Only pre-existing session identity is stored");
  ui.$("close-approval-review").click(); assert.equal(ui.$("approval-review-dialog").open, false);
  assert.equal(ui.doc.activeElement, ui.$("approval-list").querySelector("button"));
  ui.open(); assert.equal(ui.$("approval-review-submit").disabled, false);
  assert.equal(ui.posts().length, 0);
});

test("explicit confirmation sends only original authorization and canonical quote key once", async t => {
  const pending = deferred(), item = approval();
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([item])) : call.path === "/v1/jobs" ? pending.promise : undefined });
  await ui.loaded(); ui.open(); ui.$("approval-review-submit").click(); ui.$("approval-review-submit").click();
  assert.equal(ui.posts().length, 1);
  assert.deepEqual(ui.posts()[0].body, { authorization_id: item.id });
  assert.equal(ui.posts()[0].headers["idempotency-key"], `quote-${item.quote_id}`);
  assert.equal(ui.posts()[0].headers["x-veyra-dev-user"], "fixture-user");
  pending.resolve(response(createdJob()));
  await until(() => ui.w.location.hash === `#run/${jobId}`, "confirmed run route");
  assert.equal(ui.$("status").textContent, "Run confirmed.");
  assert.equal(ui.posts().length, 1); assert.equal(ui.$("approval-review-dialog").open, false);
});

test("empty and signed-out views never submit or read account approvals", async t => {
  const empty = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page()) : undefined });
  await empty.loaded(); assert.match(empty.$("approval-list").textContent, /No saved approvals/);
  const signedOut = await boot(t, { user: false });
  assert.match(signedOut.$("approvals-status").textContent, /connected account/);
  assert.equal(signedOut.listCalls().length, 0); assert.equal(signedOut.posts().length, 0);
});

for (const status of [401, 403, 404]) test(`closed account HTTP ${status} fails closed and allows explicit refresh`, async t => {
  let reads = 0;
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? ++reads === 1
    ? response({ detail: "closed" }, status) : response(page([approval()])) : undefined });
  await ui.loaded(); assert.match(ui.$("approvals-status").textContent, /unavailable for this account/);
  assert.equal(ui.$("approval-list").children.length, 0); assert.equal(ui.posts().length, 0);
  ui.$("approvals-refresh").click(); await ui.loaded(); assert.equal(ui.$("approval-list").querySelectorAll("button").length, 1);
});

test("all bounded keyset pages stay newest-first; repeat clicks, page error and retry preserve rows", async t => {
  let secondReads = 0; const second = deferred();
  const ui = await boot(t, { handle: call => {
    if (!call.path.includes("/authorizations?")) return;
    const query = new URL(call.path, "https://veyra.test").searchParams;
    if (!query.get("cursor")) return response(page([approval(2), approval(1)], { next_cursor: "opaque+a/b=", has_more: true }));
    assert.equal(query.get("cursor"), "opaque+a/b=");
    return ++secondReads === 1 ? second.promise : response(page([approval(2), approval(3)]));
  } });
  await ui.loaded(); const initial = ui.$("approval-list").textContent;
  ui.$("load-more-approvals").click(); ui.$("load-more-approvals").click(); assert.equal(secondReads, 1);
  second.resolve(response({ detail: "Synthetic page error" }, 503)); await ui.loaded();
  assert.equal(ui.$("approval-list").textContent, initial); assert.match(ui.$("approvals-status").textContent, /Loaded approvals are unchanged/);
  ui.$("load-more-approvals").click(); await ui.loaded();
  assert.equal(ui.$("approval-list").children.length, 3); assert.equal(ui.$("load-more-approvals").hidden, true);
  ui.open(0); assert.ok(ui.$("approval-review-details").textContent.includes(id(1))); ui.$("close-approval-review").click();
  ui.open(2); assert.ok(ui.$("approval-review-details").textContent.includes(id(3)));
  assert.equal(ui.posts().length, 0);
});

test("existing jobs link directly even after deadline; held and released expired records remain distinct", async t => {
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([
    expired(1), expired(2, { status: "settled", recovery_state: "released" }),
    expired(3, { job: { id: jobId, state: "settled" }, status: "settled", recovery_state: "used" }),
  ])) : undefined });
  await ui.loaded(); const text = ui.$("approval-list").textContent;
  assert.match(text, /reservation still held/); assert.match(text, /unused reservation released/); assert.match(text, /Run already exists/);
  assert.equal(ui.$("approval-list").querySelector("a").getAttribute("href"), `#run/${jobId}`);
  for (let n = 0; n < 2; n++) { ui.open(n); assert.equal(ui.$("approval-review-submit").disabled, true); ui.$("approval-review-submit").click(); ui.$("close-approval-review").click(); }
  assert.equal(ui.posts().length, 0); assert.equal(ui.listCalls().length, 1);
});

test("server-relative expiry disables unused confirmation without fetching or releasing funds", async t => {
  const item = approval(1, { created_at: iso(now - 899000), claim_expires_at: iso(now + 1000) });
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([item])) : undefined });
  await ui.loaded(); ui.open(); assert.equal(ui.$("approval-review-submit").disabled, false);
  ui.advance(1001);
  assert.equal(ui.$("approval-review-submit").disabled, true); assert.match(ui.$("approval-review-status").textContent, /deadline passed/);
  ui.$("approval-review-submit").click(); assert.equal(ui.posts().length, 0); assert.equal(ui.listCalls().length, 1);
});

for (const failure of ["network", "server", "unverified"]) test(`uncertain ${failure} response permits only manual same-identity retry`, async t => {
  const item = approval(1, { created_at: iso(now - 899000), claim_expires_at: iso(now + 1000) }); let sends = 0;
  const ui = await boot(t, { handle: call => {
    if (call.path.includes("/authorizations?")) return response(page([item]));
    if (call.path === "/v1/jobs") {
      if (++sends > 1) return response(createdJob());
      if (failure === "network") return Promise.reject(new Error("Lost response"));
      if (failure === "server") return response({ detail: "Unknown commit" }, 503);
      return response({ id: "not-a-run" });
    }
  } });
  await ui.loaded(); ui.open(); ui.$("approval-review-submit").click();
  await until(() => !ui.$("approval-review-submit").disabled, "manual retry");
  assert.match(ui.$("approval-review-status").textContent, /could not be confirmed/); assert.equal(sends, 1);
  ui.$("close-approval-review").click(); ui.open();
  assert.match(ui.$("approval-review-submit").textContent, /Retry this same submission/);
  ui.$("approval-review-submit").click(); await until(() => ui.w.location.hash === `#run/${jobId}`, "retried existing run");
  assert.deepEqual(ui.posts()[0].body, ui.posts()[1].body);
  assert.equal(ui.posts()[0].headers["idempotency-key"], ui.posts()[1].headers["idempotency-key"]);
  assert.equal(ui.posts().length, 2); assert.equal(ui.$("status").textContent, "Run confirmed.");
});

test("HTTP 410 is terminal without repricing; reopening cannot resubmit the expired record", async t => {
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([approval()]))
    : call.path === "/v1/jobs" ? response({ detail: "authorization expired" }, 410) : undefined });
  await ui.loaded(); ui.open(); ui.$("approval-review-submit").click();
  await until(() => /unused approval expired/.test(ui.$("approval-review-status").textContent), "terminal expiry");
  assert.equal(ui.$("approval-review-submit").disabled, true); ui.$("close-approval-review").click(); ui.open();
  ui.$("approval-review-submit").click(); assert.equal(ui.posts().length, 1); assert.equal(ui.listCalls().length, 1);
});

test("generic 409 is distinct; explicit refresh discovers a job created elsewhere", async t => {
  let reads = 0;
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([approval(1, ++reads === 1 ? {}
    : { job: { id: jobId, state: "running" }, recovery_state: "used" })])) : call.path === "/v1/jobs"
      ? response({ detail: "authorization already used by another job" }, 409) : undefined });
  await ui.loaded(); ui.open(); ui.$("approval-review-submit").click();
  await until(() => !ui.$("approval-review-submit").disabled, "rejected submission");
  assert.match(ui.$("approval-review-status").textContent, /already used by another job/);
  assert.doesNotMatch(ui.$("approval-review-status").textContent, /expired|could not be confirmed/);
  assert.equal(ui.listCalls().length, 1); ui.$("approval-review-refresh").click(); await ui.loaded();
  assert.equal(ui.$("approval-review-dialog").open, false);
  assert.equal(ui.$("approval-list").querySelector("a").getAttribute("href"), `#run/${jobId}`);
  assert.equal(ui.posts().length, 1);
});

test("Cancel and reopen cannot duplicate a pending submission; late success does not steal the reopened dialog", async t => {
  const pending = deferred();
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([approval()])) : call.path === "/v1/jobs" ? pending.promise : undefined });
  await ui.loaded(); ui.open(); ui.$("approval-review-submit").click();
  ui.$("approval-review-dialog").dispatchEvent(new ui.w.Event("cancel", { cancelable: true }));
  assert.equal(ui.$("approval-review-dialog").open, false); ui.open();
  assert.equal(ui.$("approval-review-submit").disabled, true); ui.$("approval-review-submit").click(); assert.equal(ui.posts().length, 1);
  ui.$("approval-review-status").textContent = "New review owns this status";
  pending.resolve(response(createdJob())); await delay(20);
  assert.equal(ui.w.location.hash, "#approvals"); assert.equal(ui.$("approval-review-status").textContent, "New review owns this status");
  ui.$("approval-review-refresh").click(); await ui.loaded();
  assert.equal(ui.$("approval-list").querySelector("a").getAttribute("href"), `#run/${jobId}`);
});

for (const failure of [false, true]) test(`late submission ${failure ? "failure" : "success"} cannot touch another route/account`, async t => {
  const pending = deferred();
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([approval()])) : call.path === "/v1/jobs" ? pending.promise : undefined });
  await ui.loaded(); ui.open(); ui.$("approval-review-submit").click(); await ui.navigate("#runs");
  ui.w.recoveryTest.state.user = "other-user"; ui.$("status").textContent = "Current account status";
  const balanceReads = ui.calls.filter(c => c.path.endsWith("billing/balance")).length;
  pending.resolve(failure ? response({ detail: "Old terminal error" }, 410) : response(createdJob())); await delay(20);
  assert.equal(ui.w.location.hash, "#runs"); assert.equal(ui.$("status").textContent, "Current account status");
  assert.equal(ui.calls.filter(c => c.path.endsWith("billing/balance")).length, balanceReads);
  assert.equal(ui.$("approval-review-dialog").open, false);
});

for (const failure of [false, true]) test(`old list ${failure ? "error" : "success"} cannot replace a same-URL revisit`, async t => {
  const old = deferred(); let reads = 0;
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? ++reads === 1 ? old.promise : response(page([approval(2)])) : undefined });
  await ui.navigate("#runs"); await ui.navigate("#approvals"); await ui.loaded();
  const text = ui.$("approval-list").textContent;
  old.resolve(failure ? response({ detail: "STALE" }, 503) : response(page([approval(1)]))); await delay(20);
  assert.equal(ui.$("approval-list").textContent, text); assert.doesNotMatch(ui.$("approvals-status").textContent, /STALE/);
  assert.equal(ui.$("approvals-refresh").disabled, false);
});

test("account change before confirmation blocks the POST; late discovery cannot reveal old account rows", async t => {
  const pending = deferred(); let reads = 0;
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? ++reads === 1 ? response(page([approval()])) : pending.promise : undefined });
  await ui.loaded(); ui.open(); ui.w.recoveryTest.state.user = "other-user";
  ui.$("approval-review-submit").click(); assert.equal(ui.posts().length, 0);
  ui.w.recoveryTest.state.user = "fixture-user"; ui.$("approval-review-refresh").click();
  ui.w.recoveryTest.state.user = "other-user"; ui.$("approvals-status").textContent = "New account";
  pending.resolve(response(page([approval(2)]))); await delay(20);
  assert.equal(ui.$("approval-list").children.length, 0); assert.equal(ui.$("approvals-status").textContent, "New account");
});

for (const [label, mutate] of [
  ["unsafe ceiling", item => item.reserved_nano = Number.MAX_SAFE_INTEGER + 1],
  ["changed version", item => item.request.project_version_id = id(555)],
  ["extended deadline", item => item.claim_expires_at = iso(now + 9000000)],
  ["inconsistent state", item => item.recovery_state = "released"],
  ["invalid auth identity", item => item.id = "javascript:alert(1)"],
]) test(`malformed ${label} fails closed without usable review`, async t => {
  const item = approval(); mutate(item);
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([item])) : undefined });
  await ui.loaded(); assert.match(ui.$("approvals-status").textContent, /Could not load/);
  assert.equal(ui.$("approval-list").querySelector("button"), null); assert.equal(ui.posts().length, 0);
});

test("pagination rejects repeated cursors without replacing loaded records", async t => {
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([approval()], { next_cursor: "same", has_more: true })) : undefined });
  await ui.loaded(); const text = ui.$("approval-list").textContent;
  ui.$("load-more-approvals").click(); await ui.loaded();
  assert.equal(ui.$("approval-list").textContent, text); assert.match(ui.$("approvals-status").textContent, /could not be read safely/);
  assert.equal(ui.posts().length, 0);
});

test("uncertain submission past deadline offers discovery, with no retry that could release a hold", async t => {
  const item = approval(1, { created_at: iso(now - 899000), claim_expires_at: iso(now + 1000) });
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([item]))
    : call.path === "/v1/jobs" ? Promise.reject(new Error("Lost response")) : undefined });
  await ui.loaded(); ui.open(); ui.$("approval-review-submit").click();
  await until(() => !ui.$("approval-review-submit").disabled, "retry available before deadline");
  ui.advance(1001); assert.equal(ui.$("approval-review-submit").hidden, true);
  assert.equal(ui.$("approval-review-submit").disabled, true);
  assert.match(ui.$("approval-review-status").textContent, /Refresh approvals to find an existing run/);
  ui.$("approval-review-submit").click(); assert.equal(ui.posts().length, 1);
});

for (const status of [401, 403, 404]) test(`POST access closure ${status} invalidates an in-flight older page and removes all submission controls`, async t => {
  const older = deferred();
  const ui = await boot(t, { handle: call => {
    if (call.path.includes("/authorizations?")) return call.path.includes("cursor=") ? older.promise
      : response(page([approval()], { next_cursor: "older", has_more: true }));
    if (call.path === "/v1/jobs") return response({ detail: "Access removed" }, status);
  } });
  await ui.loaded(); ui.$("load-more-approvals").click(); ui.open(); ui.$("approval-review-submit").click();
  await until(() => !ui.$("approval-review-dialog").open, "access closure");
  assert.equal(ui.$("approval-list").children.length, 0);
  older.resolve(response(page([approval(2)]))); await delay(20);
  assert.equal(ui.$("approval-list").children.length, 0); assert.equal(ui.$("load-more-approvals").hidden, true);
  assert.equal(ui.$("approvals-refresh").disabled, false);
  assert.match(ui.$("approvals-status").textContent, /unavailable for this account/);
});

test("stale submission does not unlock a newer confirmation dialog for another approval", async t => {
  const first = deferred(), second = deferred();
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([approval(1), approval(2)]))
    : call.path === "/v1/jobs" ? call.body.authorization_id === id(1) ? first.promise : second.promise : undefined });
  await ui.loaded(); ui.open(0); ui.$("approval-review-submit").click(); ui.$("close-approval-review").click();
  ui.open(1); ui.$("approval-review-submit").click(); ui.$("approval-review-status").textContent = "Newer pending confirmation";
  first.resolve(response({ detail: "Old expired approval" }, 410)); await delay(20);
  assert.equal(ui.$("approval-review-submit").disabled, true);
  assert.equal(ui.$("approval-review-status").textContent, "Newer pending confirmation");
  second.resolve(response({ detail: "Newer conflict" }, 409));
  await until(() => !ui.$("approval-review-submit").disabled, "current confirmation unlock");
  assert.match(ui.$("approval-review-status").textContent, /Newer conflict/);
  assert.equal(ui.posts().length, 2);
});

test("navigation before hashchange prevents hidden-view confirmation", async t => {
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([approval()])) : undefined });
  await ui.loaded(); ui.open(); ui.w.location.hash = "#runs"; ui.$("approval-review-submit").click();
  assert.equal(ui.posts().length, 0); await until(() => !ui.$("view-runs").hidden, "new route");
  assert.equal(ui.$("approval-review-dialog").open, false);
});

test("exact ceiling is retained across large safe integer and minimal nano amounts", async t => {
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([
    approval(1, { reserved_nano: 9007199254740991 }), approval(2, { reserved_nano: 1 }),
  ])) : undefined });
  await ui.loaded(); ui.open(0); assert.match(ui.$("approval-review-details").textContent, /\$9007199\.254740991/);
  ui.$("close-approval-review").click(); ui.open(1); assert.match(ui.$("approval-review-details").textContent, /\$0\.000000001/);
  assert.equal(ui.posts().length, 0);
});

for (const failure of [false, true]) test(`recovery-triggered late balance ${failure ? "error" : "value"} cannot replace a newer view`, async t => {
  const old = deferred(); let balances = 0;
  const ui = await boot(t, { handle: call => {
    if (call.path.includes("/authorizations?")) return response(page([approval()]));
    if (call.path === "/v1/jobs") return response(createdJob());
    if (call.path.endsWith("billing/balance")) return ++balances === 1 ? response({ available_nano: 1000000000 }) : old.promise;
  } });
  await ui.loaded(); ui.open(); ui.$("approval-review-submit").click();
  await until(() => !ui.$("view-run").hidden && balances === 2, "confirmed run and balance refresh");
  await ui.navigate("#runs"); ui.$("status").textContent = "New view status";
  old.resolve(failure ? response({ detail: "Stale balance error" }, 503) : response({ available_nano: 9 })); await delay(20);
  assert.equal(ui.$("balance-pill").textContent, "$1.0000");
  assert.equal(ui.$("status").textContent, "New view status");
});

test("an empty continuing page fails safely without claiming a complete or empty discovery", async t => {
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([], { next_cursor: "next", has_more: true })) : undefined });
  await ui.loaded(); assert.match(ui.$("approvals-status").textContent, /made no progress/);
  assert.equal(ui.$("approval-list").children.length, 0); assert.equal(ui.posts().length, 0);
});

test("expiry preserves dialog close focus and displays explicit per-record server UTC observation", async t => {
  const item = approval(1, { created_at: iso(now - 899000), claim_expires_at: iso(now + 1000) });
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([item])) : undefined });
  await ui.loaded(); assert.match(ui.$("approval-list").textContent, /Server snapshot 2026-10-12 10:00:00.000 UTC/);
  ui.open(); assert.match(ui.$("approval-review-details").textContent, /Server snapshot \(UTC\)/);
  ui.advance(1001); ui.$("close-approval-review").click();
  assert.equal(ui.doc.activeElement, ui.$("approval-list").querySelector("button"));
});

for (const [label, mutate] of [
  ["missing authorization", job => delete job.authorization_id],
  ["wrong authorization", job => job.authorization_id = id(999)],
  ["missing workspace", job => delete job.org_id],
  ["wrong workspace", job => job.org_id = id(999)],
  ["missing version", job => delete job.project_version_id],
  ["wrong version", job => job.project_version_id = id(999)],
  ["missing budget", job => delete job.budget],
  ["wrong ceiling", job => job.budget.reserved_nano++],
  ["unsafe ceiling", job => job.budget.reserved_nano = Number.MAX_SAFE_INTEGER + 1],
]) test(`a successful job response with ${label} stays uncertain and cannot navigate`, async t => {
  const job = createdJob(); mutate(job);
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([approval()]))
    : call.path === "/v1/jobs" ? response(job) : undefined });
  await ui.loaded(); ui.open(); ui.$("approval-review-submit").click();
  await until(() => !ui.$("approval-review-submit").disabled, "uncertain response");
  assert.equal(ui.w.location.hash, "#approvals");
  assert.match(ui.$("approval-review-status").textContent, /could not be confirmed/);
  assert.match(ui.$("approval-review-submit").textContent, /Retry this same submission/);
  assert.equal(ui.posts().length, 1); assert.equal(ui.listCalls().length, 1);
  assert.equal(ui.$("approval-review-status").querySelector("a"), null);
});

for (const status of [401, 403, 404]) test(`late POST access closure ${status} closes a newer dialog within the same view`, async t => {
  const pending = deferred();
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([approval(1), approval(2)]))
    : call.path === "/v1/jobs" ? pending.promise : undefined });
  await ui.loaded(); ui.open(0); ui.$("approval-review-submit").click(); ui.$("close-approval-review").click(); ui.open(1);
  assert.equal(ui.$("approval-review-submit").disabled, false);
  pending.resolve(response({ detail: "Access removed" }, status));
  await until(() => !ui.$("approval-review-dialog").open, "same-view access invalidation");
  assert.equal(ui.$("approval-list").children.length, 0);
  assert.equal(ui.$("approval-review-details").children.length, 0);
  assert.equal(ui.$("approval-review-submit").disabled, true);
  ui.$("approval-review-submit").click(); assert.equal(ui.posts().length, 1);
  assert.match(ui.$("approvals-status").textContent, /unavailable for this account/);
});

for (const status of [401, 403, 404]) test(`late POST access closure ${status} cannot close a later route visit's new dialog`, async t => {
  const pending = deferred();
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([approval(1), approval(2)]))
    : call.path === "/v1/jobs" ? pending.promise : undefined });
  await ui.loaded(); ui.open(0); ui.$("approval-review-submit").click();
  await ui.navigate("#runs"); await ui.navigate("#approvals"); await ui.loaded(); ui.open(1);
  ui.$("approval-review-status").textContent = "Current route owns this review";
  pending.resolve(response({ detail: "Old access removed" }, status)); await delay(20);
  assert.equal(ui.$("approval-review-dialog").open, true);
  assert.equal(ui.$("approval-list").children.length, 2);
  assert.equal(ui.$("approval-review-submit").disabled, false);
  assert.equal(ui.$("approval-review-status").textContent, "Current route owns this review");
});

for (const status of [401, 403, 404]) test(`late POST access closure ${status} cannot change a new account's view`, async t => {
  const pending = deferred();
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? response(page([approval(1), approval(2)]))
    : call.path === "/v1/jobs" ? pending.promise : undefined });
  await ui.loaded(); ui.open(0); ui.$("approval-review-submit").click();
  ui.w.recoveryTest.state.user = "other-user"; ui.w.recoveryTest.route(); await ui.loaded(); ui.open(1);
  ui.$("approval-review-status").textContent = "Current account owns this review";
  pending.resolve(response({ detail: "Old account denied" }, status)); await delay(20);
  assert.equal(ui.$("approval-review-dialog").open, true);
  assert.equal(ui.$("approval-list").children.length, 2);
  assert.equal(ui.$("approval-review-submit").disabled, false);
  assert.equal(ui.$("approval-review-status").textContent, "Current account owns this review");
});

test("delayed older page cannot move server-relative time backward and reopen an expired claim", async t => {
  const older = deferred(), nearExpiry = approval(1, { created_at: iso(now - 899000), claim_expires_at: iso(now + 1000) });
  const ui = await boot(t, { handle: call => {
    if (call.path.includes("/authorizations?")) return call.path.includes("cursor=") ? older.promise
      : response(page([nearExpiry], { has_more: true, next_cursor: "older" }));
  } });
  await ui.loaded(); ui.$("load-more-approvals").click(); ui.advance(1500);
  ui.open(); assert.equal(ui.$("approval-review-submit").hidden, true); ui.$("close-approval-review").click();
  older.resolve(response(page([approval(2)], { as_of: iso(now + 100) }))); await ui.loaded();
  ui.$("approval-list").querySelector(`[data-approval-id="${nearExpiry.id}"]`).click();
  assert.equal(ui.$("approval-review-submit").hidden, true);
  assert.equal(ui.$("approval-review-submit").disabled, true);
  ui.$("approval-review-submit").click(); assert.equal(ui.posts().length, 0);
  assert.match(ui.$("approval-review-status").textContent, /deadline passed/);
});

test("same-view refresh retains elapsed server time while its replacement snapshot is delayed", async t => {
  const refreshed = deferred(), nearExpiry = approval(1, { created_at: iso(now - 899000), claim_expires_at: iso(now + 1000) }); let reads = 0;
  const ui = await boot(t, { handle: call => call.path.includes("/authorizations?") ? ++reads === 1
    ? response(page([nearExpiry])) : refreshed.promise : undefined });
  await ui.loaded(); ui.$("approvals-refresh").click(); ui.advance(1500);
  refreshed.resolve(response(page([nearExpiry], { as_of: iso(now + 100) }))); await ui.loaded(); ui.open();
  assert.equal(ui.$("approval-review-submit").hidden, true);
  assert.equal(ui.$("approval-review-submit").disabled, true);
  assert.match(ui.$("approval-review-status").textContent, /deadline passed/);
  assert.equal(ui.posts().length, 0);
});

test('native queued close event cannot revoke a freshly reopened review', async t => {
  const ui = await boot(t, { handle: call => call.path.includes('/authorizations?') ? response(page([approval(1), approval(2)])) : undefined });
  await ui.loaded();
  ui.w.HTMLDialogElement.prototype.close = function () { this.open = false; const dialog = this; ui.w.setTimeout(() => dialog.dispatchEvent(new ui.w.Event('close')), 0); };
  ui.open(0); ui.$('close-approval-review').click(); ui.open(1); await delay(15);
  assert.equal(ui.$('approval-review-dialog').open, true);
  assert.equal(ui.$('approval-review-submit').disabled, false);
  assert.ok(ui.$('approval-review-details').textContent.includes(id(2)));
  ui.$('close-approval-review').click(); await delay(15);
  assert.equal(ui.$('approval-review-details').textContent, '');
  assert.equal(ui.doc.activeElement, ui.$('approval-list').querySelectorAll('button')[1]);
  assert.equal(ui.posts().length, 0);
});

test('initial approval and explicit recovery race retain original single authorization and idempotency key', async t => {
  const auth = deferred(), initialJob = deferred(); let sends = 0;
  const item = approval();
  const saved = { id: version, project_id: project, version_no: 7, entrypoint: 'strategy.py', files: { 'strategy.py': '# Inert fixture source\n' }, created_at: iso(now - 2000) };
  const p = { id: project, name: 'Fixture', versions: [saved], latest_version_no: 7, visibility: 'private', created_at: saved.created_at, updated_at: saved.created_at };
  const confirmed = { id: jobId, authorization_id: item.id, org_id: org, project_version_id: version, state: 'queued', budget: { reserved_nano: item.reserved_nano } };
  const ui = await boot(t, { hash: `#project/${project}`, handle: call => {
    if (call.path === `/v1/projects/${project}`) return response(p);
    if (call.path === `/v1/projects/${project}/versions/7`) return response(saved);
    if (call.path === '/v1/quotes') return response({ id: item.quote_id, customer_max_nano: item.reserved_nano, estimate: { customer_expected_nano: item.reserved_nano } });
    if (call.path === `/v1/quotes/${item.quote_id}/authorize`) return auth.promise;
    if (call.path.includes('/authorizations?')) return response(page([item]));
    if (call.path === '/v1/jobs') return ++sends === 1 ? response(confirmed) : initialJob.promise;
  } });
  await until(() => ui.$('project-title').textContent === 'Fixture' && !ui.$('editor').disabled, 'initial project');
  ui.$('quote-form').dispatchEvent(new ui.w.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: ui.$('quote-form').querySelector('button[type=submit]') })); await until(() => !ui.$('quote-box').hidden, 'quote');
  ui.$('approve').click(); await ui.navigate('#approvals'); await ui.loaded(); ui.open(); ui.$('approval-review-submit').click();
  await until(() => ui.w.location.hash === `#run/${jobId}`, 'recovery confirms first');
  auth.resolve(response({ id: item.id })); await until(() => sends === 2, 'approved initial response creates original POST');
  const jobPosts = ui.posts().filter(call => call.path === '/v1/jobs');
  assert.deepEqual(jobPosts[0].body, jobPosts[1].body);
  assert.equal(jobPosts[0].headers['idempotency-key'], `quote-${item.quote_id}`);
  assert.equal(jobPosts[1].headers['idempotency-key'], `quote-${item.quote_id}`);
  assert.equal(ui.posts().filter(call => call.path.endsWith('/authorize')).length, 1);
  assert.equal(ui.posts().filter(call => call.path === '/v1/quotes').length, 1);
  await ui.navigate('#runs'); ui.$('status').textContent = 'Current route status';
  initialJob.resolve(response(confirmed)); await delay(20);
  assert.equal(ui.w.location.hash, '#runs'); assert.equal(ui.$('status').textContent, 'Current route status');
});
