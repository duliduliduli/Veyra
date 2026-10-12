// DOM integration checks without Chromium, HTTP servers, accounts, billing, or code execution.
// npm install --no-save --package-lock=false --ignore-scripts jsdom@26.1.0
// node --test tests/e2e/publications.mjs
// An external installation also works: NODE_PATH=/path/to/node_modules node --test tests/e2e/publications.mjs
// shortcut: chart rendering and native dialog focus are stubbed, verify layout/focus in browser QA.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require("jsdom");
const html = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const scripts = ["chart-research.js", "workspace-store.js", "studio-assistant.js", "report-evidence.js", "proposal-diff.js", "strategy-backup.js", "saved-links.js", "app.js"].map((name) =>
  readFileSync(new URL(`../../apps/web/${name}`, import.meta.url), "utf8"));
const plain = (value) => JSON.parse(JSON.stringify(value));
const dataset = { dataset_id: "synthetic-test", instrument_id: "TEST/USD", provider: "synthetic",
  coverage_start: "2021-01-01T00:00:00Z", coverage_end: "2025-01-01T00:00:00Z", bars: 1462,
  quote_currency: "USD", license: "test fixture" };
const response = (value, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => plain(value) });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(condition, label) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function lockManager() {
  const tails = new Map(), calls = [];
  return { calls, request(name, options, operation) {
    calls.push({ name, ...options });
    const result = (tails.get(name) || Promise.resolve()).then(operation);
    tails.set(name, result.catch(() => {}));
    return result;
  } };
}
function sharedStorage() {
  const entries = new Map();
  return { get length() { return entries.size; }, key: (i) => [...entries.keys()][i],
    getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key) };
}
async function blobText(w, blob) {
  return new Promise((resolve, reject) => {
    const reader = new w.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function boot(t, { hash = "#discover", user = false, storage = {}, shared, locks = lockManager(), randomUUID = true, seed, handle } = {}) {
  const errors = [], calls = [], downloads = [], blobs = new Map();
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(html, { url: `https://veyra.test/${hash}`, runScripts: "outside-only", virtualConsole });
  const w = dom.window, doc = w.document;
  t.after(() => { dom.window.close(); assert.deepEqual(errors, [], "No uncaught DOM errors"); });
  w.TextEncoder = TextEncoder;
  if (!randomUUID) Object.defineProperty(w.crypto, "randomUUID", { value: undefined });
  if (shared) Object.defineProperty(w, "localStorage", { value: shared });
  if (locks) Object.defineProperty(w.navigator, "locks", { value: locks });
  w.URL.createObjectURL = (blob) => { const url = `blob:https://veyra.test/${blobs.size}`; blobs.set(url, blob); return url; };
  w.URL.revokeObjectURL = (url) => blobs.delete(url);
  doc.addEventListener("click", (event) => {
    const link = event.target.closest("a[download]");
    if (!link) return;
    event.preventDefault();
    downloads.push({ name: link.download, blob: blobs.get(link.href) });
  });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  const series = () => ({ values: [], setData(rows) { this.values = rows; }, data() { return this.values; }, setMarkers() {}, applyOptions() {} });
  w.LightweightCharts = { createChart: () => ({ addLineSeries: series, addCandlestickSeries: series,
    addHistogramSeries: series, priceScale: () => ({ applyOptions() {} }), timeScale: () => ({ fitContent() {} }),
    subscribeCrosshairMove() {}, subscribeClick() {}, applyOptions() {} }) };
  for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
  if (user) w.localStorage.setItem("veyra.user", "fixture-user");
  w.fetch = async (path, options = {}) => {
    const call = { path: String(path), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null, headers: options.headers, cache: options.cache, credentials: options.credentials };
    calls.push(call);
    if (call.path === "/v1/catalog/datasets") return response({ datasets: [dataset] });
    if (call.path === "/v1/me" && user) return response({ organizations: [{ id: "fixture-org", role: "owner" }] });
    if (call.path === "/v1/orgs/fixture-org/billing/balance" && user) {
      return response({ available_nano: 0, reserved_nano: 0, settled_usage_nano: 0 });
    }
    const result = await handle?.(call);
    if (result !== undefined) return result;
    errors.push(`Unexpected API request: ${call.method} ${call.path}`);
    return response({ detail: "Unexpected fixture request" }, 500);
  };
  scripts.slice(0, -1).forEach((script) => w.eval(script));
  const store = w.VeyraWorkspaceStore.create(w.localStorage);
  const seeded = seed?.(store, w);
  w.eval(scripts.at(-1));
  const $ = (id) => { const element = doc.getElementById(id); assert.ok(element, `Missing #${id}`); return element; };
  const input = (id, value, type = "input") => {
    $(id).value = value;
    $(id).dispatchEvent(new w.Event(type, { bubbles: true }));
  };
  const submit = (id) => $(id).querySelector('button[type="submit"]').click();
  async function navigate(next) {
    w.location.hash = next;
    await until(() => !$(`view-${next.slice(1).split("/")[0]}`).hidden, `route ${next}`);
    await delay(5);
  }
  await until(() => $("bt-dataset").options.length === 1, "public catalog boot");
  await delay(5);
  const ids = [...doc.querySelectorAll("[id]")].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, "HTML IDs must be unique");
  return { w, doc, $, store, seeded, calls, input, submit, navigate, downloads, locks,
    storage: () => Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => {
      const key = w.localStorage.key(i); return [key, w.localStorage.getItem(key)];
    })) };
}

const A = "10000000-0000-4000-8000-000000000001", B = "10000000-0000-4000-8000-000000000002";
const V1 = "20000000-0000-4000-8000-000000000001", V2 = "20000000-0000-4000-8000-000000000002";
const P1 = "30000000-0000-4000-8000-000000000001", P2 = "30000000-0000-4000-8000-000000000002";
const stamp = "2026-10-12T09:00:00Z";
const attack = '<img src=x onerror="window.publicAttack=true"><script>window.publicAttack=true</script>';
function fixtureProject(id = A) {
  const versions = [2, 1].map((n) => ({ id: n === 2 ? V2 : V1, project_id: id, version_no: n, content_hash: "sha256:" + String(n).repeat(64),
    files: { "strategy.py": `# saved version ${n}\n${attack}\n`, "lib/helper.py": `# saved helper ${n}\n` },
    entrypoint: "strategy.py", created_at: stamp }));
  return { id, org_id: "fixture-org", name: "PRIVATE PROJECT NAME", description: "PRIVATE NOTES", folder: "PRIVATE FOLDER",
    versions, latest_version_no: 2, visibility: "private", created_at: stamp, updated_at: stamp };
}
function metadata(id = P1, title = "A public strategy") {
  return { id, title, description: "Chosen public description", published_at: stamp, content_hash: "sha256:" + "1".repeat(64), entrypoint: "strategy.py", public_path: "https://evil.test/never-follow" };
}
function receipt(id = P1, extras = {}) {
  return { ...metadata(id), project_version_id: V1, version_no: 1, status: "published", revoked_at: null, ...extras };
}
function routes(project = fixtureProject(), handle) {
  return async (call) => {
    const result = await handle?.(call);
    if (result !== undefined) return result;
    if (call.path === "/v1/orgs/fixture-org/projects") return response({ projects: [project], has_more: false, next_cursor: null });
    if (call.path === `/v1/projects/${project.id}`) return response(project);
    for (const version of project.versions) if (call.path === `/v1/projects/${project.id}/versions/${version.version_no}`) return response(version);
    if (call.path.startsWith(`/v1/projects/${project.id}/publications?`) && call.method === "GET") return response({ publications: [], has_more: false, next_cursor: null });
    if (call.path.startsWith("/v1/public/strategies?")) return response({ strategies: [] });
  };
}
async function owner(t, handle, project = fixtureProject()) {
  const ui = await boot(t, { user: true, hash: `#project/${project.id}`, handle: routes(project, handle) });
  await until(() => ui.$("project-title").textContent === project.name, "private project");
  return ui;
}
async function review(ui) {
  ui.$("share-project").click();
  await until(() => !ui.$("share-snapshot").hidden, "saved source review");
}
function consent(ui, title = "Public title", description = "Public description") {
  ui.input("share-public-title", title);
  ui.input("share-description", description);
  ui.$("share-consent").checked = true;
  ui.$("share-consent").dispatchEvent(new ui.w.Event("change", { bubbles: true }));
}
const publications = (ui) => ui.calls.filter((call) => call.method === "POST" && call.path.endsWith("/publications"));

test("device-local Share stays private and does not request cloud publication or identity setup", async (t) => {
  const ui = await boot(t, { hash: "#code", seed: (store) => store.createProject({ name: "Local secret", files: { "strategy.py": "# local only" } }) });
  await ui.navigate(`#project/${ui.seeded.id}`);
  await until(() => ui.$("project-title").textContent === "Local secret", "local strategy");
  const before = ui.calls.length;
  ui.$("share-project").click();
  assert.equal(ui.$("share-dialog").open, true);
  assert.match(ui.$("share-availability").textContent, /device-local.*secure cloud identity and database storage/);
  assert.equal(ui.$("share-form").hidden, true);
  assert.equal(ui.$("share-history").hidden, true);
  assert.equal(ui.calls.length, before);
  ui.$("share-close").click();
  assert.equal(ui.$("share-dialog").open, false);
});

test("publication requires fresh public metadata and explicit consent to the exact saved version, never unsaved files", async (t) => {
  const p = fixtureProject();
  const ui = await owner(t, (call) => {
    if (call.method === "POST" && call.path.endsWith("/publications")) return response(receipt(P1, { ...call.body,
      content_hash: "sha256:" + "1".repeat(64) }), 201);
  }, p);
  ui.input("editor", "# UNSAVED PRIVATE EDITS");
  await review(ui);
  assert.equal(ui.$("share-public-title").value, "");
  assert.equal(ui.$("share-description").value, "");
  assert.equal(ui.$("share-consent").checked, false);
  assert.equal(ui.$("share-publish").disabled, true);
  assert.equal(ui.$("share-version").value, V2);
  assert.match(ui.$("share-identity").textContent, new RegExp(`v2.*${V2}`));
  assert.equal(ui.$("share-file-list").children.length, 2);
  assert.equal(ui.$("share-source").textContent, p.versions[0].files["strategy.py"]);
  assert.doesNotMatch(ui.$("share-dialog").textContent, /PRIVATE PROJECT NAME|PRIVATE NOTES|PRIVATE FOLDER|UNSAVED PRIVATE EDITS/);
  assert.equal(ui.$("share-source").querySelector("img,script"), null);
  ui.input("share-version", V1, "change");
  await until(() => ui.$("share-version-status").textContent.startsWith("Pinned saved v1"), "older saved version");
  ui.input("share-file", "lib/helper.py", "change");
  assert.equal(ui.$("share-source").textContent, p.versions[1].files["lib/helper.py"]);
  ui.input("share-public-title", "Public title");
  ui.$("share-form").dispatchEvent(new ui.w.Event("submit", { cancelable: true }));
  assert.equal(publications(ui).length, 0, "Synthetic submit cannot bypass unchecked consent");
  consent(ui, "  Public title  ", "  chosen public\ndescription  ");
  assert.equal(ui.$("share-publish").disabled, false);
  assert.equal(ui.calls.some((call) => call.method !== "GET"), false, "Review never silently saves or publishes");
  ui.submit("share-form");
  await until(() => ui.$("share-status").textContent.startsWith("Snapshot published"), "publication receipt");
  const [post] = publications(ui);
  assert.deepEqual(post.body, { project_version_id: V1, title: "Public title", description: "chosen public\ndescription", confirm_public: true });
  assert.match(post.headers["Idempotency-Key"], /^[a-f0-9]{32}$/);
  assert.equal(post.cache, "no-store");
  assert.equal(ui.$("share-receipts").querySelector("a").href, `https://veyra.test/#public/${P1}`);
  assert.equal(ui.$("editor").value, "# UNSAVED PRIVATE EDITS");
  assert.match(ui.$("draft-state").textContent, /Unsaved/);
  assert.equal(ui.calls.some((call) => call.path.endsWith("/versions") && call.method === "POST"), false);
  assert.equal(ui.$("share-publish").disabled, true, "Repeated clicks do not publish twice");
  ui.submit("share-form");
  assert.equal(publications(ui).length, 1);
  ui.$("share-close").click();
  await review(ui);
  assert.equal(ui.$("share-public-title").value, "");
  assert.equal(ui.$("share-description").value, "");
  assert.equal(ui.$("share-consent").checked, false);
});

test("anonymous public source is text-only, read-only, exact multi-file and downloadable without executing or leaking extra fields", async (t) => {
  const files = { "strategy.py": `${attack}\n# exact CRLF\r\n`, "lib/helper.py": "# helper\n" };
  const ui = await boot(t, { user: true, hash: `#public/${P1}`, handle: (call) => {
    if (call.path === `/v1/public/strategies/${P1}`) return response({ ...metadata(P1, attack), description: attack,
      files, private_name: "PRIVATE EXTRA", org_id: "PRIVATE ORG" });
  } });
  await until(() => !ui.$("public-content").hidden, "public source");
  assert.equal(ui.$("public-title").textContent, attack);
  assert.equal(ui.$("public-description").textContent, attack);
  assert.equal(ui.$("public-source").textContent, files["strategy.py"]);
  assert.equal(ui.$("view-public").querySelector("img,script,textarea"), null);
  assert.equal(ui.w.publicAttack, undefined);
  assert.doesNotMatch(ui.$("view-public").textContent, /PRIVATE EXTRA|PRIVATE ORG/);
  ui.$("public-download-file").click();
  assert.equal(ui.downloads[0].name, "strategy.py");
  assert.equal(await blobText(ui.w, ui.downloads[0].blob), files["strategy.py"]);
  ui.input("public-file", "lib/helper.py", "change");
  assert.equal(ui.$("public-source").textContent, files["lib/helper.py"]);
  ui.$("public-download-file").click();
  assert.equal(ui.downloads[1].name, "helper.py");
  assert.equal(await blobText(ui.w, ui.downloads[1].blob), files["lib/helper.py"]);
  ui.$("public-download-snapshot").click();
  assert.deepEqual(JSON.parse(await blobText(ui.w, ui.downloads[2].blob)), { files, entrypoint: "strategy.py" });
  const get = ui.calls.find((call) => call.path === `/v1/public/strategies/${P1}`);
  assert.equal(get.headers["x-veyra-dev-user"], undefined);
  assert.equal(get.credentials, "omit");
  assert.equal(get.cache, "no-store");
  assert.equal(ui.calls.every((call) => call.method === "GET"), true);
  assert.equal(Object.values(ui.storage()).some((raw) => raw.includes(attack)), false, "No public source in browser persistence");
  assert.equal(ui.doc.querySelector('[data-tab="discover"]').getAttribute("aria-current"), "page");
});

test("Discover searches only public metadata, paginates actual results and renders untrusted text safely", async (t) => {
  const ui = await boot(t, { handle: (call) => {
    if (!call.path.startsWith("/v1/public/strategies?")) return;
    const query = new URL(call.path, "https://veyra.test").searchParams;
    if (query.get("q") === "nothing") return response({ strategies: [] });
    const offset = Number(query.get("offset"));
    const rows = Array.from({ length: offset ? 1 : 21 }, (_, i) => metadata(`30000000-0000-4000-8000-${String(offset + i + 1).padStart(12, "0")}`, i === 0 ? attack : `Result ${offset + i + 1}`));
    return response({ strategies: rows });
  } });
  await until(() => ui.$("discover-list").children.length === 20, "first page");
  assert.equal(ui.$("discover-list").querySelector("img,script"), null);
  assert.equal(ui.$("discover-list").querySelector("a").textContent.includes(attack), true);
  assert.equal(ui.$("discover-prev").disabled, true);
  assert.equal(ui.$("discover-next").disabled, false);
  assert.match(ui.$("discover-status").textContent, /Showing 1–20/);
  ui.$("discover-next").click();
  await until(() => ui.$("discover-status").textContent.startsWith("Showing 21–21"), "second page");
  assert.equal(ui.$("discover-list").children.length, 1);
  assert.equal(ui.$("discover-next").disabled, true);
  ui.$("discover-prev").click();
  await until(() => ui.$("discover-list").children.length === 20, "previous page");
  ui.input("discover-search", "  nothing  ");
  ui.submit("discover-form");
  await until(() => ui.$("discover-status").textContent.includes("No public snapshots match"), "search empty state");
  const query = new URL(ui.calls.at(-1).path, "https://veyra.test").searchParams;
  assert.deepEqual(Object.fromEntries(query), { q: "nothing", limit: "21", offset: "0" });
  assert.equal(ui.calls.every((call) => call.path === "/v1/catalog/datasets" || call.path.startsWith("/v1/public/strategies?")), true);
  for (const call of ui.calls) assert.equal(call.cache, "no-store");
});

test("Discover errors are retryable, and empty discovery has no invented example posts", async (t) => {
  let attempts = 0;
  const ui = await boot(t, { handle: (call) => {
    if (call.path.startsWith("/v1/public/strategies?")) return ++attempts === 1
      ? response({ detail: attack }, 503) : response({ strategies: [] });
  } });
  await until(() => !ui.$("discover-retry").hidden, "discovery error");
  assert.equal(ui.$("discover-status").querySelector("img,script"), null);
  assert.equal(ui.$("discover-list").children.length, 0);
  ui.$("discover-retry").click();
  await until(() => ui.$("discover-status").textContent === "No public strategies have been published yet.", "empty real feed");
  assert.equal(ui.$("discover-list").children.length, 0);
  assert.equal(ui.$("discover-next").disabled, true);
});

test("newer discovery search and route generations defeat late old responses", async (t) => {
  const slow = deferred(), oldRoute = deferred();
  const ui = await boot(t, { handle: routes(fixtureProject(), (call) => {
    if (!call.path.startsWith("/v1/public/strategies?")) return;
    const q = new URL(call.path, "https://veyra.test").searchParams.get("q");
    if (q === "old") return slow.promise;
    if (q === "away") return oldRoute.promise;
    return response({ strategies: [metadata(P2, "NEWEST RESULT")] });
  }) });
  ui.input("discover-search", "old"); ui.submit("discover-form");
  await until(() => ui.calls.some((call) => call.path.includes("q=old")), "old request");
  ui.input("discover-search", "new"); ui.submit("discover-form");
  await until(() => ui.$("discover-list").textContent.includes("NEWEST RESULT"), "new request");
  slow.resolve(response({ strategies: [metadata(P1, "STALE RESULT")] }));
  await delay(10);
  assert.doesNotMatch(ui.$("discover-list").textContent, /STALE RESULT/);
  ui.input("discover-search", "away"); ui.submit("discover-form");
  await until(() => ui.calls.some((call) => call.path.includes("q=away")), "request before leaving");
  await ui.navigate("#code");
  ui.input("discover-search", "new");
  // Return to the same path before its previous request finishes.
  await ui.navigate("#discover");
  ui.submit("discover-form");
  await until(() => ui.$("discover-list").textContent.includes("NEWEST RESULT"), "returned discovery");
  oldRoute.resolve(response({ strategies: [metadata(P1, "OLD ROUTE RESULT")] }));
  await delay(10);
  assert.doesNotMatch(ui.$("discover-list").textContent, /OLD ROUTE RESULT/);
});

test("public source clears on navigation, ignores late source and treats revoked and missing links alike", async (t) => {
  const slow = deferred();
  const ui = await boot(t, { hash: `#public/${P1}`, handle: (call) => {
    if (call.path === `/v1/public/strategies/${P1}`) return slow.promise;
    if (call.path === `/v1/public/strategies/${P2}`) return response({ detail: "not found" }, 404);
    if (call.path.startsWith("/v1/public/strategies?")) return response({ strategies: [] });
  } });
  await ui.navigate(`#public/${P2}`);
  await until(() => ui.$("public-status").textContent.includes("unavailable or has been revoked"), "revoked public link");
  slow.resolve(response({ ...metadata(P1, "STALE SOURCE"), files: { "strategy.py": "# stale source" } }));
  await delay(10);
  assert.equal(ui.$("public-content").hidden, true);
  assert.equal(ui.$("public-source").textContent, "");
  assert.equal(ui.$("public-retry").hidden, true);
  assert.doesNotMatch(ui.$("public-title").textContent, /STALE SOURCE/);
  const before = ui.calls.length;
  await ui.navigate("#public/not-a-uuid");
  assert.equal(ui.calls.length, before, "Malformed identifiers never make a request");
  ui.$("public-download-snapshot").click();
  assert.equal(ui.downloads.length, 0);
});

test("public source fetch errors can retry without retaining earlier source", async (t) => {
  let attempts = 0;
  const ui = await boot(t, { hash: `#public/${P1}`, handle: (call) => {
    if (call.path === `/v1/public/strategies/${P1}`) return ++attempts === 1 ? response({ detail: "snapshot unavailable" }, 503)
      : response({ ...metadata(P1), files: { "strategy.py": "# exact public source" } });
  } });
  await until(() => !ui.$("public-retry").hidden, "public retry");
  assert.equal(ui.$("public-content").hidden, true);
  ui.$("public-retry").click();
  await until(() => !ui.$("public-content").hidden, "public retry success");
  assert.equal(ui.$("public-source").textContent, "# exact public source");
});

test("late saved-version source cannot replace a newer publication selection or restore prior consent", async (t) => {
  const slow = deferred(), p = fixtureProject(); let v1Calls = 0;
  const ui = await owner(t, (call) => {
    if (call.path === `/v1/projects/${A}/versions/1` && ++v1Calls === 1) return slow.promise;
  }, p);
  await review(ui);
  consent(ui);
  ui.input("share-version", V1, "change");
  assert.equal(ui.$("share-publish").disabled, true);
  assert.equal(ui.$("share-consent").checked, false);
  assert.equal(ui.$("share-snapshot").hidden, true);
  ui.input("share-version", V2, "change");
  await until(() => ui.$("share-version-status").textContent.startsWith("Pinned saved v2"), "latest saved selection");
  slow.resolve(response(p.versions[1]));
  await delay(10);
  assert.equal(ui.$("share-source").textContent, p.versions[0].files["strategy.py"]);
  assert.match(ui.$("share-identity").textContent, new RegExp(V2));
  assert.equal(ui.$("share-consent").checked, false);
  assert.equal(publications(ui).length, 0);
  consent(ui);
  ui.input("share-description", "Changed after consent");
  assert.equal(ui.$("share-consent").checked, false);
  assert.equal(ui.$("share-publish").disabled, true);
});

test("mismatched saved-version identities fail closed instead of publishing different code", async (t) => {
  let reads = 0;
  const p = fixtureProject();
  const ui = await owner(t, (call) => {
    if (call.path === `/v1/projects/${A}/versions/2` && ++reads > 1) return response({ ...p.versions[0], id: V1 });
  }, p);
  ui.$("share-project").click();
  await until(() => ui.$("share-version-status").textContent.includes("identity changed"), "identity mismatch");
  assert.equal(ui.$("share-snapshot").hidden, true);
  assert.equal(ui.$("share-publish").disabled, true);
  consent(ui);
  ui.$("share-form").dispatchEvent(new ui.w.Event("submit", { cancelable: true }));
  assert.equal(publications(ui).length, 0);
});

test("owner-only control failures cannot expose a publication form", async (t) => {
  const ui = await owner(t, (call) => {
    if (call.path.startsWith(`/v1/projects/${A}/publications?`)) return response({ detail: "role cannot perform this action" }, 403);
  });
  ui.$("share-project").click();
  await until(() => ui.$("share-status").textContent.includes("Only a workspace owner"), "owner access boundary");
  assert.equal(ui.$("share-form").hidden, true);
  assert.equal(ui.$("share-history").hidden, true);
  assert.equal(publications(ui).length, 0);
});

test("closing or changing routes cancels the review UI and late owner reads cannot restore it", async (t) => {
  const slow = deferred();
  const ui = await owner(t, (call) => {
    if (call.path.startsWith(`/v1/projects/${A}/publications?`)) return slow.promise;
  });
  ui.$("share-project").click();
  await until(() => ui.calls.some((call) => call.path.includes("/publications?")), "owner request");
  await ui.navigate("#discover");
  assert.equal(ui.$("share-dialog").open, false);
  slow.resolve(response({ publications: [receipt()], has_more: false, next_cursor: null }));
  await delay(10);
  assert.equal(ui.$("share-dialog").open, false);
  assert.equal(ui.$("share-form").hidden, true);
  assert.equal(ui.$("share-receipts").children.length, 0);
  assert.equal(publications(ui).length, 0);
  await ui.navigate(`#project/${A}`);
  await until(() => ui.$("project-title").textContent === "PRIVATE PROJECT NAME", "reopened private project");
  await review(ui);
  ui.$("share-dialog").close();
  assert.equal(ui.$("share-consent").checked, false);
  assert.equal(ui.$("share-source").textContent, "");
});

test("uncertain publish retries reuse their idempotency key and a revoked replay never looks published", async (t) => {
  let attempts = 0;
  const ui = await owner(t, (call) => {
    if (call.method === "POST" && call.path.endsWith("/publications")) {
      if (++attempts === 1) throw new Error("Connection lost");
      return response(receipt(P1, { ...call.body, version_no: 2, content_hash: "sha256:" + "2".repeat(64), status: "revoked", revoked_at: stamp }));
    }
  });
  await review(ui); consent(ui);
  ui.submit("share-form");
  await until(() => ui.$("share-status").textContent.includes("Publication was not confirmed"), "uncertain publish");
  assert.equal(ui.$("share-publish").disabled, false);
  ui.submit("share-form");
  await until(() => ui.$("share-status").textContent.includes("did not reactivate"), "revoked retry");
  const posts = publications(ui);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].headers["Idempotency-Key"], posts[1].headers["Idempotency-Key"]);
  assert.deepEqual(posts[0].body, posts[1].body);
  assert.equal(ui.$("share-receipts").querySelector("a"), null);
  assert.match(ui.$("share-receipts").textContent, /Revoked.*Outside copies cannot be recalled/s);
  assert.equal(ui.$("share-publish").disabled, true);
});

test("double submits and late publish responses cannot mutate a new review or steal navigation", async (t) => {
  const slow = deferred();
  const ui = await owner(t, (call) => {
    if (call.method === "POST" && call.path.endsWith("/publications")) return slow.promise;
  });
  await review(ui); consent(ui); ui.submit("share-form");
  await until(() => publications(ui).length === 1, "publish request");
  ui.$("share-form").dispatchEvent(new ui.w.Event("submit", { cancelable: true }));
  assert.equal(publications(ui).length, 1);
  ui.$("share-close").click();
  await review(ui);
  const freshStatus = ui.$("share-status").textContent;
  slow.resolve(response(receipt(P1, { ...publications(ui)[0].body, version_no: 2, content_hash: "sha256:" + "2".repeat(64) })));
  await delay(10);
  assert.equal(ui.$("share-status").textContent, freshStatus);
  assert.equal(ui.$("share-receipts").querySelector("a"), null);
  assert.equal(ui.$("share-public-title").value, "");
  assert.equal(ui.w.location.hash, `#project/${A}`);
});

test("a queued close from an earlier Share dialog preserves the reopened review and its confirmation", async (t) => {
  const ui = await owner(t, (call) => {
    if (call.method === "POST" && call.path.endsWith("/publications")) return response(receipt(P1, {
      ...call.body, version_no: 2, content_hash: "sha256:" + "2".repeat(64),
    }), 201);
  });
  await review(ui);
  const dialog = ui.$("share-dialog"), close = dialog.close;
  dialog.close = function () { this.open = false; this.close = close; };
  ui.$("share-close").click();
  await review(ui);
  consent(ui, "Fresh reviewed title", "Fresh reviewed description");
  ui.$("share-public-title").focus();
  const source = ui.$("share-source").textContent, identity = ui.$("share-identity").textContent;
  dialog.dispatchEvent(new ui.w.Event("close"));
  assert.equal(dialog.open, true);
  assert.equal(ui.$("share-source").textContent, source);
  assert.equal(ui.$("share-identity").textContent, identity);
  assert.equal(ui.$("share-public-title").value, "Fresh reviewed title");
  assert.equal(ui.$("share-description").value, "Fresh reviewed description");
  assert.equal(ui.$("share-consent").checked, true);
  assert.equal(ui.doc.activeElement, ui.$("share-public-title"));
  assert.equal(ui.$("share-publish").disabled, false);
  assert.equal(publications(ui).length, 0);
  ui.submit("share-form");
  await until(() => ui.$("share-status").textContent.startsWith("Snapshot published"), "fresh review publication");
  assert.equal(publications(ui).length, 1);
  assert.equal(publications(ui)[0].body.project_version_id, V2);
});

test("a late cloud publication cannot alter a new private local import or enable its sharing", async (t) => {
  const pending = deferred();
  const ui = await owner(t, (call) => {
    if (call.method === "POST" && call.path.endsWith("/publications")) return pending.promise;
  });
  await review(ui); consent(ui); ui.submit("share-form");
  await until(() => publications(ui).length === 1, "pending publication");
  await ui.navigate("#code");
  ui.w.TextDecoder = TextDecoder;
  const archive = { format: "veyra-strategy-snapshot", schema_version: 1, name: "Fresh private import",
    description: "Private description", folder: "Personal", files: { "strategy.py": "# private imported source\r\n", "empty.py": "" },
    entrypoint: "strategy.py", has_unsaved_changes: true };
  ui.$("import-strategy").click();
  const bytes = new ui.w.Uint8Array(new TextEncoder().encode(JSON.stringify(archive)));
  Object.defineProperty(ui.$("strategy-import-file"), "files", { configurable: true,
    value: [{ size: bytes.length, arrayBuffer: async () => bytes.buffer }] });
  ui.$("strategy-import-file").dispatchEvent(new ui.w.Event("change"));
  await until(() => !ui.$("strategy-import-preview").hidden, "private import preview");
  ui.$("confirm-strategy-import").click();
  await until(() => ui.$("project-title").textContent === archive.name, "new local project");
  const newRoute = ui.w.location.hash;
  assert.match(newRoute, /^#project\/local-/);
  ui.$("share-project").click();
  assert.equal(ui.$("share-form").hidden, true);
  const localSharing = ui.$("share-availability").textContent, calls = ui.calls.length;
  pending.resolve(response(receipt(P1, { ...publications(ui)[0].body, version_no: 2, content_hash: "sha256:" + "2".repeat(64) })));
  await delay(20);
  assert.equal(ui.w.location.hash, newRoute);
  assert.equal(ui.$("share-availability").textContent, localSharing);
  assert.equal(ui.$("share-form").hidden, true);
  assert.equal(ui.$("share-source").textContent, "");
  assert.equal(ui.$("share-receipts").children.length, 0);
  assert.equal(ui.calls.length, calls);
  assert.equal(ui.calls.filter((call) => call.method !== "GET").length, 1, "Import and local Share cause no writes to the API");
  const project = ui.store.getProject(newRoute.slice(9));
  assert.equal(project.visibility, "private");
  assert.equal(project.latest_version_no, 1);
  assert.deepEqual(plain(project.versions[0].files), archive.files);
});

test("owner receipts revoke only after an explicit second action, retain permanence warning, and ignore stale refresh", async (t) => {
  const slowRefresh = deferred(); let lists = 0, revoked = false;
  const ui = await owner(t, (call) => {
    if (call.path.startsWith(`/v1/projects/${A}/publications?`)) {
      if (++lists === 2) return slowRefresh.promise;
      return response({ publications: [receipt(P1, { title: attack, description: attack })], has_more: false, next_cursor: null });
    }
    if (call.path === `/v1/publications/${P1}` && call.method === "DELETE") {
      revoked = true;
      return response(receipt(P1, { title: attack, description: attack, status: "revoked", revoked_at: stamp }));
    }
    if (call.path === `/v1/public/strategies/${P1}`) return revoked ? response({ detail: "not found" }, 404)
      : response({ ...metadata(), files: { "strategy.py": "# public" } });
  });
  await review(ui);
  assert.equal(ui.$("share-receipts").querySelector("img,script"), null);
  assert.equal(ui.$("share-receipts").querySelector("a").href, `https://veyra.test/#public/${P1}`);
  ui.$("share-refresh").click();
  await until(() => lists === 2, "pending receipt refresh");
  ui.doc.querySelector(`[data-revoke="${P1}"]`).click();
  assert.match(ui.$("share-receipts").textContent, /Copies others have saved.*cannot be recalled/);
  assert.equal(ui.calls.some((call) => call.method === "DELETE"), false);
  ui.doc.querySelector(`[data-confirm-revoke="${P1}"]`).click();
  await until(() => ui.$("share-history-status").textContent.startsWith("Link revoked"), "confirmed revoke");
  slowRefresh.resolve(response({ publications: [receipt()], has_more: false, next_cursor: null }));
  await delay(10);
  assert.equal(ui.$("share-receipts").querySelector("a"), null);
  assert.equal(ui.$("share-receipts").querySelector("[data-revoke]"), null);
  assert.match(ui.$("share-receipts").textContent, /Revoked/);
  assert.equal(ui.calls.filter((call) => call.method === "DELETE").length, 1);
  await ui.navigate(`#public/${P1}`);
  await until(() => ui.$("public-status").textContent.includes("unavailable or has been revoked"), "revoked anonymous route");
  assert.equal(ui.$("public-content").hidden, true);
});

test("real Python canonical serialization and digest are accepted by saved and public snapshot views", async (t) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const input = { files: { "strategy.py": "# Ångström\r\nvalue = '雪'\n", "lib/helper.py": "# Python fixture source\n" }, entrypoint: "strategy.py" };
  const generated = JSON.parse(execFileSync("python", ["-c", [
    "import json,sys", "from veyra_sim.report import canonical_json,digest", "snapshot=json.load(sys.stdin)",
    "print(canonical_json(dict(snapshot, content_hash=digest(snapshot))))",
  ].join("; ")], { cwd: root, input: JSON.stringify(input), encoding: "utf8",
    env: { ...process.env, PYTHONPATH: `${root}/runtimes/simulator/src:${root}/packages/python-sdk/src` } }));
  assert.match(generated.content_hash, /^sha256:[0-9a-f]{64}$/);
  const p = fixtureProject();
  p.versions = [{ ...p.versions[0], ...generated }];
  const ui = await owner(t, (call) => {
    if (call.path === `/v1/public/strategies/${P1}`) return response({ ...metadata(P1), ...generated });
  }, p);
  await review(ui);
  assert.match(ui.$("share-identity").textContent, new RegExp(generated.content_hash));
  assert.equal(ui.$("share-source").textContent, input.files["strategy.py"]);
  await ui.navigate(`#public/${P1}`);
  await until(() => !ui.$("public-content").hidden, "Python-produced public digest");
  assert.match(ui.$("public-identity").textContent, new RegExp(generated.content_hash));
  assert.equal(ui.$("public-source").textContent, input.files["strategy.py"]);
});

test("owner keyset pagination retains older active links through refresh, deduplicates pages and retries failures", async (t) => {
  const id = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const rows = Array.from({ length: 25 }, (_, i) => receipt(id(25 - i), { title: `Receipt ${25 - i}`,
    status: i < 24 ? "revoked" : "published", revoked_at: i < 24 ? stamp : null }));
  const cursor = "opaque+/cursor==", requests = []; let moreAttempts = 0, refreshed = false;
  const newest = receipt(id(26), { title: "Newest link" });
  const ui = await owner(t, (call) => {
    if (!call.path.startsWith(`/v1/projects/${A}/publications?`)) return;
    const query = new URL(call.path, "https://veyra.test").searchParams;
    requests.push(Object.fromEntries(query));
    if (query.has("cursor")) {
      assert.equal(query.get("cursor"), cursor);
      if (++moreAttempts === 1) return response({ detail: "Try again" }, 503);
      return response({ publications: rows.slice(19), has_more: false, next_cursor: null });
    }
    return response({ publications: refreshed ? [newest, ...rows.slice(0, 19)] : rows.slice(0, 20), has_more: true, next_cursor: cursor });
  });
  await review(ui);
  assert.equal(ui.$("share-receipts").children.length, 20);
  assert.equal(ui.$("share-receipts").querySelector("a"), null, "The only active old snapshot is not in the first page");
  assert.equal(ui.$("share-more").hidden, false);
  ui.$("share-more").click();
  await until(() => ui.$("share-history-status").textContent.startsWith("Could not refresh"), "page failure");
  assert.equal(ui.$("share-receipts").children.length, 20);
  assert.equal(ui.$("share-more").disabled, false);
  ui.$("share-more").click();
  await until(() => ui.$("share-receipts").children.length === 25, "all older receipts");
  assert.equal(ui.$("share-more").hidden, true);
  assert.equal(ui.$("share-receipts").querySelector("a").href, `https://veyra.test/#public/${id(1)}`);
  assert.ok(ui.doc.querySelector(`[data-revoke="${id(1)}"]`));
  assert.equal(ui.$("share-receipts").lastChild.textContent.includes("Receipt 1"), true);
  assert.deepEqual(requests.slice(1), [{ limit: "20", cursor }, { limit: "20", cursor }]);
  refreshed = true;
  ui.$("share-refresh").click();
  await until(() => ui.$("share-receipts").children.length === 26, "refreshed first page merged");
  assert.ok(ui.doc.querySelector(`[data-revoke="${id(1)}"]`), "Explicit refresh keeps older loaded active links reachable");
  assert.equal(ui.$("share-receipts").firstChild.textContent.includes("Newest link"), true);
  ui.$("share-more").click();
  await until(() => ui.$("share-more").hidden, "pagination refreshed");
  assert.equal(ui.$("share-receipts").children.length, 26, "Overlapping pages never duplicate rows");
});

test("a stale receipt-page request cannot restore a revoked link or disable further paging", async (t) => {
  const pending = deferred();
  const active = receipt(P1), cursor = "next-page";
  const ui = await owner(t, (call) => {
    if (call.path === `/v1/projects/${A}/publications?limit=20`) return response({ publications: [active], has_more: true, next_cursor: cursor });
    if (call.path.includes("cursor=next-page")) return pending.promise;
    if (call.method === "DELETE") return response({ ...active, status: "revoked", revoked_at: stamp });
  });
  await review(ui);
  ui.$("share-more").click();
  await until(() => ui.calls.some((call) => call.path.includes("cursor=next-page")), "pending older page");
  ui.doc.querySelector(`[data-revoke="${P1}"]`).click();
  ui.doc.querySelector(`[data-confirm-revoke="${P1}"]`).click();
  await until(() => ui.$("share-history-status").textContent.startsWith("Link revoked"), "revoke during page load");
  pending.resolve(response({ publications: [active], has_more: false, next_cursor: null }));
  await delay(10);
  assert.equal(ui.$("share-receipts").querySelector("a"), null);
  assert.equal(ui.$("share-more").hidden, false);
  assert.equal(ui.$("share-more").disabled, false);
});
