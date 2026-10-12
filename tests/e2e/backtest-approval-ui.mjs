// DOM-only quote/approval lifecycle checks: all HTTP responses are synthetic.
// No browser automation, database, billing, runtime or strategy source is executed.
// NODE_PATH=/path/to/jsdom/node_modules node --test tests/e2e/backtest-approval-ui.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "chart-tools.js", "workspace-store.js", "studio-assistant.js", "report-evidence.js", "proposal-diff.js", "strategy-backup.js", "saved-links.js", "backtest-params.js", "app.js"]
  .map((name) => readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const response = (value, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => plain(value) });
const quote = (id = "q-a") => ({ id, customer_max_nano: 2159955, estimate: { customer_expected_nano: 900000 } });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function until(condition, label) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail(`Timed out waiting for ${label}`);
}
function project(id) {
  const v = { id: `${id}-v1`, project_id: id, version_no: 1, entrypoint: "strategy.py",
    files: { "strategy.py": `# Inert ${id} source text\n` }, created_at: "2026-01-01T00:00:00Z" };
  return { id, name: id, versions: [v], latest_version_no: 1, visibility: "private", created_at: v.created_at, updated_at: v.created_at };
}
async function boot(t, handle) {
  const errors = [], calls = [], projects = [project("a"), project("b")];
  const console = new VirtualConsole(); console.on("jsdomError", error => errors.push(error.message));
  const dom = new JSDOM(html, { url: "https://veyra.test/#project/a", runScripts: "outside-only", virtualConsole: console });
  const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
  t.after(() => { w.close(); assert.deepEqual(errors, []); });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.localStorage.setItem("veyra.user", "fixture-user");
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  const originalSetTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...args) => ms === 1500 ? 0 : originalSetTimeout(fn, ms, ...args);
  w.fetch = async (path, options = {}) => {
    const call = { path: String(path), method: options.method || "GET", headers: options.headers,
      body: options.body ? JSON.parse(options.body) : null }; calls.push(call);
    if (path === "/v1/me") return response({ organizations: [{ id: "fixture-org" }] });
    if (path === "/v1/catalog/datasets") return response({ datasets: [{ dataset_id: "synthetic-test", instrument_id: "TEST/USD",
      provider: "synthetic", coverage_end: "2025-01-01T00:00:00Z", quote_currency: "USD" }] });
    if (path === "/v1/orgs/fixture-org/projects") return response({ projects, has_more: false, next_cursor: null });
    for (const p of projects) {
      if (path === `/v1/projects/${p.id}`) return response(p);
      if (path === `/v1/projects/${p.id}/versions/1`) return response(p.versions[0]);
    }
    const result = await handle?.(call);
    if (result !== undefined) return result;
    if (path === "/v1/orgs/fixture-org/billing/balance") return response({ available_nano: 1000000000 });
    if (path.startsWith("/v1/jobs/") && call.method === "GET") return response({ id: path.split("/").at(-1),
      state: "queued", budget: { reserved_nano: 2159955 }, progress: {} });
    errors.push(`Unexpected fake API call: ${call.method} ${path}`);
    return response({ detail: "Unexpected fake API call" }, 500);
  };
  scripts.forEach((script, index) => w.eval(script + (index === scripts.length - 1
    ? "\nwindow.balanceTest = { refreshBalance, state };" : "")));
  await until(() => $("project-title").textContent === "a" && !$("editor").disabled, "initial project");
  const priceButton = $("quote-form").querySelector("button[type=submit]");
  const input = (id, value) => { $(id).value = value; $(id).dispatchEvent(new w.Event("input", { bubbles: true })); };
  async function navigate(id) {
    w.location.hash = `#project/${id}`;
    await until(() => $("project-title").textContent === id && !$("editor").disabled, `project ${id}`);
  }
  function local() {
    const store = w.VeyraWorkspaceStore.create(w.localStorage);
    const p = store.createProject({ name: "local", files: { "strategy.py": "# local inert source\n" }, entrypoint: "strategy.py" });
    return p.id;
  }
  async function price() { priceButton.click(); await until(() => !$("quote-box").hidden, "displayed quote"); }
  return { w, $, doc, calls, input, navigate, price, priceButton, local };
}

test("navigation leaves an approved job pinned but prevents old success from stealing the new quote UI", async t => {
  const authorization = deferred(), job = deferred(); let prices = 0;
  const ui = await boot(t, call => {
    if (call.path === "/v1/quotes") return response(quote(++prices === 1 ? "q-a" : "q-b"));
    if (call.path === "/v1/quotes/q-a/authorize") return authorization.promise;
    if (call.path === "/v1/jobs" && call.method === "POST") return job.promise;
  });
  await ui.price(); ui.$("approve").click();
  await ui.navigate("b"); ui.input("bt-cash", "20000"); await ui.price();
  assert.equal(ui.$("approve").disabled, false, "New quote owns an enabled Approve control");
  authorization.resolve(response({ id: "auth-a" }));
  await until(() => ui.calls.some(c => c.path === "/v1/jobs"), "original approved job POST");
  const authorizationCall = ui.calls.find(c => c.path.endsWith("/authorize"));
  const jobCall = ui.calls.find(c => c.path === "/v1/jobs");
  assert.deepEqual(authorizationCall.body, { accept_max_nano: quote().customer_max_nano });
  assert.deepEqual(jobCall.body, { authorization_id: "auth-a" });
  assert.equal(jobCall.headers["idempotency-key"], "quote-q-a");
  job.resolve(response({ id: "job-a" })); await delay(20);
  assert.equal(ui.w.location.hash, "#project/b");
  assert.equal(ui.$("approve").disabled, false);
  assert.equal(ui.$("quote-box").hidden, false);
});

test("an old authorization error cannot overwrite new status or release a newer approval lock", async t => {
  const old = deferred(), next = deferred(); let prices = 0;
  const ui = await boot(t, call => {
    if (call.path === "/v1/quotes") return response(quote(++prices === 1 ? "q-a" : "q-b"));
    if (call.path === "/v1/quotes/q-a/authorize") return old.promise;
    if (call.path === "/v1/quotes/q-b/authorize") return next.promise;
  });
  await ui.price(); ui.$("approve").click(); await ui.navigate("b"); await ui.price(); ui.$("approve").click();
  ui.$("status").textContent = "Current B status";
  old.resolve(response({ detail: "OLD AUTHORIZATION FAILURE" }, 402)); await delay(20);
  assert.equal(ui.$("status").textContent, "Current B status");
  assert.equal(ui.$("approve").disabled, true);
  next.resolve(response({ detail: "Current failure" }, 402));
  await until(() => !ui.$("approve").disabled, "current approval unlock");
  assert.match(ui.$("status").textContent, /Not enough credit/);
});

for (const error of [false, true]) test(`stale quote ${error ? "failure" : "success"} preserves device-local disabled controls`, async t => {
  const old = deferred();
  const ui = await boot(t, call => { if (call.path === "/v1/quotes") return old.promise; });
  ui.priceButton.click(); const localId = ui.local(); ui.w.location.hash = `#project/${localId}`;
  await until(() => ui.$("project-title").textContent === "local", "device-local strategy");
  ui.$("status").textContent = "Current local status";
  old.resolve(error ? response({ detail: "OLD QUOTE FAILURE" }, 503) : response(quote())); await delay(20);
  assert.equal(ui.priceButton.disabled, true);
  assert.equal(ui.$("status").textContent, "Current local status");
  assert.equal(ui.$("quote-box").hidden, true);
});

test("old quote completion cannot release the newer pricing lock after a same-URL revisit", async t => {
  const pending = [];
  const ui = await boot(t, call => { if (call.path === "/v1/quotes") { const gate = deferred(); pending.push(gate); return gate.promise; } });
  ui.priceButton.click(); await until(() => pending.length === 1, "first quote");
  await ui.navigate("b"); await ui.navigate("a"); ui.priceButton.click();
  await until(() => pending.length === 2, "new quote on same URL");
  pending[0].resolve(response(quote("stale"))); await delay(20);
  assert.equal(ui.priceButton.disabled, true);
  assert.equal(ui.$("quote-box").hidden, true);
  pending[1].resolve(response(quote("current"))); await until(() => !ui.priceButton.disabled, "new quote complete");
  assert.equal(ui.$("quote-box").hidden, false);
});

test("editing source after approval does not cancel the request or navigate away from newer edits", async t => {
  const authorization = deferred(), job = deferred();
  const ui = await boot(t, call => {
    if (call.path === "/v1/quotes") return response(quote());
    if (call.path.endsWith("/authorize")) return authorization.promise;
    if (call.path === "/v1/jobs") return job.promise;
  });
  await ui.price(); ui.$("approve").click(); ui.input("editor", "# newer unexecuted draft\n");
  authorization.resolve(response({ id: "auth-a" })); await until(() => ui.calls.some(c => c.path === "/v1/jobs"), "approved old snapshot submission");
  job.resolve(response({ id: "job-a" })); await delay(20);
  assert.equal(ui.w.location.hash, "#project/a");
  assert.equal(ui.$("editor").value, "# newer unexecuted draft\n");
  assert.equal(ui.$("quote-box").hidden, true);
});

test("uncertain submission retries only the same immutable quote and idempotency key without automatic retry", async t => {
  let submits = 0;
  const ui = await boot(t, call => {
    if (call.path === "/v1/quotes") return response(quote());
    if (call.path.endsWith("/authorize")) return response({ id: "auth-a" });
    if (call.path === "/v1/jobs") return ++submits === 1 ? Promise.reject(new Error("Synthetic lost response")) : response({ id: "job-a" });
  });
  await ui.price(); ui.$("approve").click(); ui.$("approve").click();
  await until(() => !ui.$("approve").disabled, "retry availability");
  assert.equal(submits, 1, "No automatic retry or duplicate-click submission");
  assert.match(ui.$("status").textContent, /could not be confirmed/);
  assert.match(ui.$("approve").textContent, /Retry approved run/);
  ui.$("approve").click(); await until(() => ui.w.location.hash === "#run/job-a", "retried run");
  assert.equal(ui.$("status").textContent, "Run confirmed.", "A confirmed retry replaces the obsolete uncertainty warning");
  assert.equal(ui.$("status").classList.contains("error"), false);
  const auths = ui.calls.filter(c => c.path.endsWith("/authorize"));
  const jobs = ui.calls.filter(c => c.path === "/v1/jobs");
  assert.equal(auths.length, 2); assert.equal(jobs.length, 2);
  assert.deepEqual(auths[0].body, auths[1].body);
  assert.equal(auths[0].path, auths[1].path);
  assert.deepEqual(jobs[0].body, jobs[1].body);
  assert.equal(jobs[0].headers["idempotency-key"], jobs[1].headers["idempotency-key"]);
  assert.equal(ui.calls.filter(c => c.path === "/v1/quotes").length, 1);
});

test("edited inputs invalidate visible approval before any authorization is sent", async t => {
  const ui = await boot(t, call => { if (call.path === "/v1/quotes") return response(quote()); });
  await ui.price(); ui.input("bt-cash", "12000"); ui.$("approve").click(); await delay(10);
  assert.equal(ui.calls.some(c => c.path.endsWith("/authorize") || c.path === "/v1/jobs"), false);
  assert.equal(ui.$("quote-box").hidden, true);
});

for (const [maximum, exact] of [[1007979, "$0.001007979"], [2159955, "$0.002159955"], [1000000000, "$1.000000000"]]) {
  test(`approval displays the exact nano ceiling ${exact} and keeps estimates rounded`, async t => {
    const ui = await boot(t, call => {
      if (call.path === "/v1/quotes") return response({ ...quote(), customer_max_nano: maximum });
    });
    await ui.price();
    assert.equal(ui.$("q-max").textContent, exact);
    assert.equal(ui.$("approve").textContent, `Approve up to ${exact} and run`);
    assert.equal(ui.$("q-expected").textContent, "$0.0009");
  });
}

for (const error of [false, true]) test(`an approval-triggered balance ${error ? "error" : "response"} cannot overwrite a later view`, async t => {
  const balance = deferred(); let reads = 0;
  const ui = await boot(t, call => {
    if (call.path.endsWith("/billing/balance")) return ++reads === 1 ? response({ available_nano: 1000000000 }) : balance.promise;
    if (call.path === "/v1/quotes") return response(quote());
    if (call.path.endsWith("/authorize")) return response({ id: "auth-a" });
    if (call.path === "/v1/jobs") return response({ id: "job-a" });
  });
  assert.equal(ui.$("balance-pill").textContent, "$1.0000", "Unscoped default refresh still works");
  await ui.price(); ui.$("approve").click();
  await until(() => ui.w.location.hash === "#run/job-a" && reads === 2, "approval balance refresh");
  await ui.navigate("b");
  ui.$("status").textContent = "Current B status"; ui.$("balance-pill").textContent = "$CURRENT";
  balance.resolve(error ? response({ detail: "OLD BALANCE FAILURE" }, 503) : response({ available_nano: 777000000 }));
  await delay(20);
  assert.equal(ui.$("status").textContent, "Current B status");
  assert.equal(ui.$("balance-pill").textContent, "$CURRENT");
});

for (const stage of ["authorization", "job"]) test(`confirmed 410 at ${stage} clears only the current quote and asks for a new price`, async t => {
  let prices = 0;
  const ui = await boot(t, call => {
    if (call.path === "/v1/quotes") return response(quote(++prices === 1 ? "q-a" : "q-b"));
    if (call.path.endsWith("/authorize")) return stage === "authorization"
      ? response({ detail: "quote expired" }, 410) : response({ id: "auth-a" });
    if (call.path === "/v1/jobs") return response({ detail: "unused authorization expired" }, 410);
  });
  await ui.price(); ui.$("approve").click();
  await until(() => ui.$("quote-box").hidden, "confirmed expired quote cleared");
  assert.match(ui.$("status").textContent, /expired.*Get a new price/);
  assert.equal(prices, 1, "Expiry never automatically reprices or retries");
  await ui.price();
  assert.equal(ui.$("approve").disabled, false, "A fresh quote gets a usable approval control");
  assert.equal(prices, 2);
  assert.equal(ui.calls.filter(c => c.path.endsWith("/authorize")).length, 1);
});

test("a late job 410 cannot clear a newer quote on the same project", async t => {
  const job = deferred(); let prices = 0;
  const ui = await boot(t, call => {
    if (call.path === "/v1/quotes") return response(quote(++prices === 1 ? "q-a" : "q-b"));
    if (call.path.endsWith("/authorize")) return response({ id: "auth-a" });
    if (call.path === "/v1/jobs") return job.promise;
  });
  await ui.price(); ui.$("approve").click();
  await until(() => ui.calls.some(c => c.path === "/v1/jobs"), "first submitted run");
  ui.input("bt-cash", "12000"); await ui.price(); ui.$("status").textContent = "Current new quote";
  job.resolve(response({ detail: "old authorization expired" }, 410)); await delay(20);
  assert.equal(ui.$("quote-box").hidden, false);
  assert.equal(ui.$("approve").disabled, false);
  assert.equal(ui.$("status").textContent, "Current new quote");
});

for (const failure of ["network", "server"]) test(`uncertain ${failure} authorization failure offers only manual same-quote retry`, async t => {
  let authorizations = 0;
  const ui = await boot(t, call => {
    if (call.path === "/v1/quotes") return response(quote());
    if (call.path.endsWith("/authorize")) {
      if (++authorizations === 1) return failure === "network"
        ? Promise.reject(new Error("Synthetic lost authorization response"))
        : response({ detail: "Synthetic authorization response unavailable" }, 503);
      return response({ id: "auth-a" });
    }
    if (call.path === "/v1/jobs") return response({ id: "job-a" }, 201);
  });
  await ui.price(); ui.$("approve").click();
  await until(() => !ui.$("approve").disabled, "uncertain authorization retry available");
  assert.match(ui.$("status").textContent, /Approval could not be confirmed.*Retry this same quote/);
  assert.equal(ui.$("approve").textContent, "Retry same quote up to $0.002159955");
  assert.equal(authorizations, 1, "No automatic authorization retry");
  assert.equal(ui.calls.filter(c => c.path === "/v1/jobs").length, 0);
  ui.$("approve").click(); await until(() => ui.w.location.hash === "#run/job-a", "confirmed recovered authorization");
  const calls = ui.calls.filter(c => c.path.endsWith("/authorize"));
  assert.equal(calls[0].path, calls[1].path); assert.deepEqual(calls[0].body, calls[1].body);
  assert.equal(ui.calls.find(c => c.path === "/v1/jobs").headers["idempotency-key"], "quote-q-a");
  assert.equal(ui.$("status").textContent, "Run confirmed.");
  assert.equal(ui.$("status").classList.contains("error"), false);
  assert.equal(ui.calls.filter(c => c.path === "/v1/quotes").length, 1);
});

for (const stage of ["authorization", "job"]) test(`generic 409 at ${stage} remains distinct from expiry and uncertainty`, async t => {
  const ui = await boot(t, call => {
    if (call.path === "/v1/quotes") return response(quote());
    if (call.path.endsWith("/authorize")) return stage === "authorization"
      ? response({ detail: "Synthetic quote conflict" }, 409) : response({ id: "auth-a" });
    if (call.path === "/v1/jobs") return response({ detail: "Synthetic idempotency conflict" }, 409);
  });
  await ui.price(); ui.$("approve").click(); await until(() => !ui.$("approve").disabled, "conflict displayed");
  assert.equal(ui.$("quote-box").hidden, false, "Generic conflict does not establish expiry");
  assert.match(ui.$("status").textContent, /Synthetic .* conflict/);
  assert.doesNotMatch(ui.$("status").textContent, /expired|could not be confirmed/);
  assert.equal(ui.calls.filter(c => c.path.endsWith("/authorize")).length, 1);
});

test("a late uncertain authorization failure cannot replace a new quote's status or label", async t => {
  const old = deferred(); let prices = 0;
  const ui = await boot(t, call => {
    if (call.path === "/v1/quotes") return response(quote(++prices === 1 ? "q-a" : "q-b"));
    if (call.path.endsWith("/authorize")) return old.promise;
  });
  await ui.price(); ui.$("approve").click(); await ui.navigate("b"); await ui.price();
  ui.$("status").textContent = "Current B quote";
  old.reject(new Error("Synthetic lost old authorization response")); await delay(20);
  assert.equal(ui.$("status").textContent, "Current B quote");
  assert.equal(ui.$("approve").textContent, "Approve up to $0.002159955 and run");
  assert.equal(ui.$("approve").disabled, false);
});

test("an older approval balance cannot replace a newer settlement balance on the same run", async t => {
  const old = deferred(); let reads = 0;
  const ui = await boot(t, call => {
    if (call.path.endsWith("/billing/balance")) {
      if (++reads === 1) return response({ available_nano: 1000000000 });
      return reads === 2 ? old.promise : response({ available_nano: 999900000 });
    }
    if (call.path === "/v1/quotes") return response(quote());
    if (call.path.endsWith("/authorize")) return response({ id: "auth-a" });
    if (call.path === "/v1/jobs") return response({ id: "job-a" });
    if (call.path === "/v1/jobs/job-a") return response({ id: "job-a", state: "settled", outcome: "completed",
      budget: { reserved_nano: 2159955 }, progress: {} });
  });
  await ui.price(); ui.$("approve").click();
  await until(() => reads === 3 && ui.$("balance-pill").textContent === "$0.9999", "newer settled balance");
  old.resolve(response({ available_nano: 997840045 })); await delay(20);
  assert.equal(ui.$("balance-pill").textContent, "$0.9999");
});

for (const error of [false, true]) test(`only the newest shared balance refresh can publish a ${error ? "failure" : "value"}`, async t => {
  const old = deferred(); let reads = 0;
  const ui = await boot(t, call => {
    if (call.path.endsWith("/billing/balance")) {
      if (++reads === 2) return old.promise;
      return response({ available_nano: reads === 1 ? 1000000000 : 222000000 });
    }
  });
  const pending = ui.w.balanceTest.refreshBalance(); await ui.w.balanceTest.refreshBalance();
  ui.$("status").textContent = "Newest status";
  old.resolve(error ? response({ detail: "OLD REFRESH FAILURE" }, 503) : response({ available_nano: 777000000 }));
  assert.equal(await pending, undefined);
  assert.equal(ui.$("balance-pill").textContent, "$0.2220");
  assert.equal(ui.$("status").textContent, "Newest status");
});

for (const identity of ["org", "user"]) for (const error of [false, true]) {
  test(`a ${identity} change rejects an old shared balance ${error ? "error" : "response"} without needing another refresh`, async t => {
    const old = deferred(); let reads = 0;
    const ui = await boot(t, call => {
      if (call.path.endsWith("/billing/balance")) return ++reads === 1 ? response({ available_nano: 1000000000 }) : old.promise;
    });
    const pending = ui.w.balanceTest.refreshBalance();
    ui.w.balanceTest.state[identity] = `different-${identity}`;
    ui.$("status").textContent = "Current account status"; ui.$("balance-pill").textContent = "$CURRENT";
    old.resolve(error ? response({ detail: "OLD ACCOUNT FAILURE" }, 503) : response({ available_nano: 777000000 }));
    assert.equal(await pending, undefined);
    assert.equal(ui.$("balance-pill").textContent, "$CURRENT");
    assert.equal(ui.$("status").textContent, "Current account status");
    assert.equal(ui.calls.filter(c => c.path.endsWith("/billing/balance")).at(-1).path, "/v1/orgs/fixture-org/billing/balance");
  });
}

for (const text of ['{"x":1e999}', '{"x":9007199254740993}', '[]', '{"x":"\\ud800"}', '{"x":"\\u0000"}',
  '{"x":'.repeat(17) + '0' + '}'.repeat(17), JSON.stringify({ x: "é".repeat(4093) })]) {
  test(`invalid parameter input clears an old quote and sends no request: ${text.slice(0, 50)}`, async t => {
    const ui = await boot(t, call => { if (call.path === "/v1/quotes") return response(quote()); });
    await ui.price();
    const before = ui.calls.length;
    // Programmatic change skips the input listener: submit must still invalidate the old quote.
    ui.$("bt-params").value = text;
    ui.priceButton.click();
    await until(() => !ui.priceButton.disabled, "local validation rejection");
    assert.equal(ui.$("bt-params").value, text, "Rejected text remains available for correction");
    assert.equal(ui.$("quote-box").hidden, true);
    assert.equal(ui.$("approve").disabled, true);
    assert.match(ui.$("status").textContent, /Parameter/);
    ui.$("approve").click(); await delay(5);
    assert.equal(ui.calls.length, before, "No quote, approval, job or other HTTP call");
    ui.input("bt-params", '{"fixed":10}'); await ui.price();
    assert.deepEqual(ui.calls.filter(c => c.path === "/v1/quotes").at(-1).body.params, { fixed: 10 });
    assert.equal(ui.$("approve").disabled, false);
  });
}

test("valid nested parameters reach the quote unchanged and any subsequent edit invalidates approval", async t => {
  const ui = await boot(t, call => { if (call.path === "/v1/quotes") return response(quote()); });
  const params = { nested: [null, true, false, 1.25, 9007199254740991, "9007199254740993", "é😀\t\u0001", { x: [] }] };
  const text = JSON.stringify(params);
  ui.input("bt-params", text); await ui.price();
  assert.deepEqual(ui.calls.find(c => c.path === "/v1/quotes").body.params, params);
  assert.equal(ui.$("bt-params").value, text);
  const before = ui.calls.length;
  ui.input("bt-params", '{"x":1e999}');
  assert.equal(ui.$("quote-box").hidden, true);
  assert.equal(ui.$("approve").disabled, true);
  ui.$("approve").click(); await delay(5);
  assert.equal(ui.calls.length, before);
});

test("a pending old quote cannot reappear after invalid parameter replacement", async t => {
  const old = deferred();
  const ui = await boot(t, call => { if (call.path === "/v1/quotes") return old.promise; });
  ui.priceButton.click();
  await until(() => ui.calls.some(c => c.path === "/v1/quotes"), "pending original quote");
  ui.input("bt-params", '{"x":1e999}');
  old.resolve(response(quote()));
  await until(() => !ui.priceButton.disabled, "stale quote ignored");
  ui.priceButton.click();
  await until(() => !ui.priceButton.disabled, "invalid replacement rejected");
  assert.equal(ui.$("quote-box").hidden, true);
  assert.equal(ui.$("approve").disabled, true);
  assert.match(ui.$("status").textContent, /finite/);
  assert.equal(ui.calls.filter(c => c.path === "/v1/quotes").length, 1);
  assert.equal(ui.calls.some(c => c.path.endsWith("/authorize") || c.path === "/v1/jobs"), false);
});
