"use strict";
// Veyra phone-first client. Talks only to the public /v1 API; holds no money logic.

const $ = (id) => document.getElementById(id);
const state = { user: localStorage.getItem("veyra.user"), org: null, datasets: [],
  project: null, quote: null, pollTimer: null };
const charts = {};

// ---------------------------------------------------------------- helpers
async function api(path, { method = "GET", body, headers = {}, raw = false } = {}) {
  const res = await fetch(path, { method, headers: { "x-veyra-dev-user": state.user,
    ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail; } catch { /* non-JSON error body */ }
    const err = new Error(typeof detail === "string" ? detail : "Request was rejected");
    err.status = res.status;
    throw err;
  }
  return raw ? res : res.json();
}

// Exact nano-USD formatting, half-even like the server's format_usd; never uses floats.
function usd(nano, places = 4) {
  const n = BigInt(nano ?? 0), neg = n < 0n, abs = neg ? -n : n;
  const unit = 10n ** BigInt(9 - places), rem = (abs % unit) * 2n;
  let scaled = abs / unit;
  if (rem > unit || (rem === unit && scaled % 2n === 1n)) scaled += 1n;
  const s = scaled.toString().padStart(places + 1, "0");
  return `${neg ? "-" : ""}$${s.slice(0, -places)}.${s.slice(-places)}`;
}
const pct = (v) => (v == null ? "n/a" : `${(Number(v) * 100).toFixed(2)}%`);
const num = (v) => (v == null ? "n/a" : Number(v).toFixed(2));
const when = (ts) => new Date(ts).toLocaleString();

function say(message, isError = false) {
  const el = $("status");
  el.textContent = message || "";
  el.classList.toggle("error", isError);
  if (message && !isError) setTimeout(() => el.textContent === message && say(""), 4000);
}
const fail = (e) => say(e.message || String(e), true);

async function busy(button, fn) {
  button.disabled = true;
  try { return await fn(); } catch (e) { fail(e); } finally { button.disabled = false; }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v; else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function fillTiles(dl, pairs) {
  dl.replaceChildren(...pairs.map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v))));
}

function chartColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return { ink: v("--fg"), muted: v("--muted"), line: v("--line"), bg: v("--panel"),
    accent: v("--accent"), mono: v("--mono") };
}

function makeChart(id) {
  if (charts[id]) return charts[id];
  const c = chartColors();
  charts[id] = LightweightCharts.createChart($(id), {
    autoSize: true,
    layout: { background: { color: c.bg }, textColor: c.muted, fontFamily: c.mono, fontSize: 11,
      attributionLogo: true },
    grid: { vertLines: { color: c.line, style: 2 }, horzLines: { color: c.line, style: 2 } },
    timeScale: { borderColor: c.line }, rightPriceScale: { borderColor: c.line },
    // Vertical swipes scroll the page; horizontal drags pan the chart.
    handleScroll: { vertTouchDrag: false },
  });
  return charts[id];
}

const toTime = (ts) => Math.floor(Date.parse(ts) / 1000);
const isoDay = (d) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------- session
async function boot() {
  if (state.user) {
    try {
      const me = await api("/v1/me");
      state.org = me.organizations[0]?.id ??
        (await api("/v1/orgs", { method: "POST", body: { name: "My workspace" } })).id;
    } catch (e) {
      if (e.status !== 401) throw e;
      localStorage.removeItem("veyra.user");
      state.user = null;
    }
  }
  state.datasets = (await api("/v1/catalog/datasets")).datasets;
  for (const sel of [$("market-dataset"), $("bt-dataset")]) {
    sel.replaceChildren(...state.datasets.map((d) =>
      el("option", { value: d.dataset_id }, `${d.instrument_id} · daily · ${d.provider}`)));
  }
  $("signout").hidden = !state.org;
  for (const control of document.querySelectorAll("#new-project-form input, #new-project-form button, [data-topup]")) {
    control.disabled = !state.org;
  }
  if (state.org) refreshBalance();
}

async function refreshBalance() {
  try {
    const b = await api(`/v1/orgs/${state.org}/billing/balance`);
    $("balance-pill").textContent = usd(b.available_nano);
    $("balance-pill").hidden = false;
    return b;
  } catch (e) { fail(e); }
}

$("signout").addEventListener("click", () => {
  localStorage.removeItem("veyra.user");
  location.hash = "";
  location.reload();
});

// ---------------------------------------------------------------- routing
const views = [ "markets", "code", "project", "runs", "run", "wallet"];

function route() {
  clearTimeout(state.pollTimer);
  const [name, arg] = location.hash.slice(1).split("/");
  let view = views.includes(name) ? name : "markets";
  if (!state.org) view = { project: "code", run: "runs" }[view] || view;
  for (const v of views) $(`view-${v}`).hidden = v !== view;
  const tab = { project: "code", run: "runs" }[view] || view;
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  ({ markets: showMarkets, code: showProjects, project: () => showProject(arg),
     runs: showRuns, run: () => showRun(arg), wallet: showWallet }[view] || (() => {}))();
}
window.addEventListener("hashchange", route);

// ---------------------------------------------------------------- markets
let marketRange = 365;

async function showMarkets() {
  const id = $("market-dataset").value;
  const ds = state.datasets.find((d) => d.dataset_id === id);
  if (!ds) return;
  const end = ds.coverage_end.slice(0, 10);
  const start = marketRange ? isoDay(new Date(Date.parse(end) - marketRange * 864e5)) : null;
  try {
    const q = new URLSearchParams(start ? { start } : {});
    const { bars } = await api(`/v1/catalog/datasets/${id}/bars?${q}`);
    const chart = makeChart("market-chart");
    const c = chartColors(); // rises in ink, falls in the signal color
    charts.candles ??= chart.addCandlestickSeries({ upColor: c.bg, borderUpColor: c.ink,
      wickUpColor: c.ink, downColor: c.accent, borderDownColor: c.accent, wickDownColor: c.accent });
    charts.candles.setData(bars.map((b) => ({ time: toTime(b.ts), open: +b.open, high: +b.high,
      low: +b.low, close: +b.close })));
    chart.timeScale().fitContent();
    const last = bars.at(-1);
    $("market-meta").textContent = `Last close ${last.close} ${ds.quote_currency} on ` +
      `${last.ts.slice(0, 10)} (UTC) · Source: ${ds.provider} · ${ds.license}`;
  } catch (e) { fail(e); }
}
$("market-dataset").addEventListener("change", showMarkets);
for (const b of document.querySelectorAll("[data-range]")) {
  b.addEventListener("click", () => {
    marketRange = Number(b.dataset.range);
    document.querySelectorAll("[data-range]").forEach((x) => {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-pressed", String(x === b));
    });
    showMarkets();
  });
}

// ---------------------------------------------------------------- projects & editor
async function showProjects() {
  if (!state.org) {
    $("project-list").replaceChildren(el("li", { class: "muted" }, "Strategy saving and backtests are coming soon."));
    return;
  }
  try {
    const { projects } = await api(`/v1/orgs/${state.org}/projects`);
    $("project-list").replaceChildren(...projects.map((p) => el("li", {},
      el("a", { href: `#project/${p.id}` }, p.name,
        el("span", { class: "sub" }, `v${p.latest_version_no} · created ${when(p.created_at)}`)))));
    if (!projects.length) $("project-list").append(el("li", { class: "muted" }, "No strategies yet."));
  } catch (e) { fail(e); }
}

$("new-project-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const p = await api(`/v1/orgs/${state.org}/projects`, { method: "POST",
      body: { name: $("new-project-name").value.trim(), template: "sma_cross" } });
    $("new-project-name").value = "";
    location.hash = `#project/${p.id}`;
  } catch (err) { fail(err); }
});

const draftKey = () => `veyra.draft.${state.project.id}`;

async function showProject(id) {
  $("quote-box").hidden = true;
  try {
    const p = await api(`/v1/projects/${id}`);
    const latest = p.versions[0];
    const v = await api(`/v1/projects/${id}/versions/${latest.version_no}`);
    state.project = { id, name: p.name, version: v, saved: v.files[v.entrypoint] };
    $("project-title").textContent = p.name;
    $("editor").value = localStorage.getItem(draftKey()) ?? state.project.saved;
    markDraft();
    const ds = state.datasets.find((d) => d.dataset_id === $("bt-dataset").value);
    if (ds && !$("bt-end").value) {
      $("bt-end").value = ds.coverage_end.slice(0, 10);
      $("bt-start").value = isoDay(new Date(Date.parse(ds.coverage_end) - 3 * 365 * 864e5));
    }
  } catch (e) { fail(e); }
}

function markDraft() {
  const dirty = $("editor").value !== state.project.saved;
  $("project-version").textContent = `strategy.py · saved v${state.project.version.version_no}`;
  $("draft-state").textContent = dirty ? "unsaved changes (kept on this device)" : "up to date";
}

$("editor").addEventListener("input", () => {
  if (!state.project) return;
  if ($("editor").value === state.project.saved) localStorage.removeItem(draftKey());
  else localStorage.setItem(draftKey(), $("editor").value);
  markDraft();
  $("quote-box").hidden = true; // a quote is only valid for the code it priced
});

function insertAtCursor(text) {
  const ed = $("editor");
  ed.focus();
  ed.setRangeText(text, ed.selectionStart, ed.selectionEnd, "end");
  ed.dispatchEvent(new Event("input"));
}
for (const b of document.querySelectorAll("[data-key]")) {
  // pointerdown + preventDefault keeps the keyboard open on phones
  b.addEventListener("pointerdown", (e) => { e.preventDefault(); insertAtCursor(b.dataset.key); });
}
$("editor").addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    insertAtCursor("    ");
  }
});

async function saveIfDirty() {
  const code = $("editor").value;
  if (code === state.project.saved) return state.project.version;
  const v = await api(`/v1/projects/${state.project.id}/versions`, { method: "POST",
    body: { files: { "strategy.py": code }, entrypoint: "strategy.py" } });
  state.project.version = v;
  state.project.saved = code;
  localStorage.removeItem(draftKey());
  markDraft();
  say(`Saved v${v.version_no}`);
  return v;
}
$("save-version").addEventListener("click", (e) => busy(e.currentTarget, saveIfDirty));

$("quote-form").addEventListener("submit", (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    let params;
    try { params = JSON.parse($("bt-params").value || "{}"); } catch {
      throw new Error("Parameters must be valid JSON, for example {\"fast\": 10}");
    }
    const v = await saveIfDirty();
    state.quote = await api("/v1/quotes", { method: "POST", body: {
      project_version_id: v.id, dataset_id: $("bt-dataset").value,
      start: $("bt-start").value, end: $("bt-end").value, starting_cash: $("bt-cash").value,
      params, max_runtime_seconds: Number($("bt-runtime").value) } });
    $("q-expected").textContent = usd(state.quote.estimate.customer_expected_nano);
    $("q-max").textContent = usd(state.quote.customer_max_nano);
    $("approve").textContent = `Approve up to ${usd(state.quote.customer_max_nano)} and run`;
    $("quote-box").hidden = false;
    $("approve").focus();
  });
});

// A quote prices exact inputs; any change means a new quote.
$("quote-form").addEventListener("input", () => { $("quote-box").hidden = true; });

$("approve").addEventListener("click", (e) => busy(e.currentTarget, async () => {
  const q = state.quote;
  let auth;
  try {
    auth = await api(`/v1/quotes/${q.id}/authorize`, { method: "POST",
      body: { accept_max_nano: q.customer_max_nano } });
  } catch (err) {
    if (err.status === 402) { say("Not enough credit. Add credit in Wallet.", true); return; }
    throw err;
  }
  // The quote id doubles as the idempotency key, so a retried tap cannot start two runs.
  const job = await api("/v1/jobs", { method: "POST", body: { authorization_id: auth.id },
    headers: { "idempotency-key": `quote-${q.id}` } });
  refreshBalance();
  location.hash = `#run/${job.id}`;
}));

// ---------------------------------------------------------------- runs
const outcomeClass = { completed: "good", failed: "bad", incomplete: "warn", cancelled: "warn" };

async function showRuns() {
  if (!state.org) {
    $("run-list").replaceChildren(el("li", { class: "muted" }, "No runs yet. Backtests are coming soon."));
    return;
  }
  try {
    const { jobs } = await api(`/v1/orgs/${state.org}/jobs`);
    $("run-list").replaceChildren(...jobs.map((j) => el("li", {},
      el("a", { href: `#run/${j.id}`, class: ["failed", "incomplete"].includes(j.outcome) ? "alert" : "" },
        `${j.outcome ?? j.state} · ${j.dataset_id}`,
        el("span", { class: "sub" }, `${when(j.created_at)} · ` + (j.charge_nano == null
          ? `up to ${usd(j.reserved_nano)} reserved` : `charged ${usd(j.charge_nano)}`))))));
    if (!jobs.length) $("run-list").append(el("li", { class: "muted" }, "No runs yet."));
  } catch (e) { fail(e); }
}

async function showRun(id) {
  let job;
  try { job = await api(`/v1/jobs/${id}`); } catch (e) { fail(e); return; }
  const live = job.state !== "settled";
  const label = live ? job.state : job.outcome;
  $("run-state").textContent = label;
  $("run-state").className = `badge ${outcomeClass[job.outcome] || ""}`;
  const { bars_done = 0, bars_total = 0 } = job.progress || {};
  $("run-progress").max = bars_total || 1;
  $("run-progress").value = live ? bars_done : bars_total || 1;
  $("run-budget").textContent = live
    ? `Up to ${usd(job.budget.reserved_nano)} reserved · ${bars_done}/${bars_total || "?"} days`
    : `Settled ${when(job.settled_at)}`;
  $("run-cancel").hidden = !live || job.cancel_requested;
  $("run-error").hidden = !job.error;
  $("run-error").textContent = job.error || "";
  $("run-report").hidden = true;
  if (live) {
    state.pollTimer = setTimeout(() => location.hash === `#run/${id}` && showRun(id), 1500);
    return;
  }
  refreshBalance();
  if (job.report_id) await showReport(job);
  else if (job.receipt) { $("run-report").hidden = false; fillReceipt(job.receipt); }
}

function fillReceipt(r) {
  const rows = [["Compute used", usd(r.supplier_cost_nano, 6)],
    [`Platform fee (${r.platform_fee_bps / 100}%)`, usd(r.platform_fee_nano, 6)],
    ["Charged", usd(r.customer_charge_nano, 6)], ["Approved maximum", usd(r.authorized_max_nano, 6)],
    ["Returned to balance", usd(r.released_nano, 6)], ["Tax", r.tax_nano == null ? "not calculated" : usd(r.tax_nano)]];
  if (r.absorbed_by_platform_nano) rows.push(["Covered by Veyra", usd(r.absorbed_by_platform_nano, 6)]);
  $("run-receipt").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
  $("run-report").hidden = false;
  for (const x of ["run-note", "run-tiles", "equity-chart"]) $(x).hidden = true;
}

async function showReport(job) {
  const rep = await api(`/v1/reports/${job.report_id}/artifacts/report.json`);
  fillReceipt(job.receipt);
  for (const x of ["run-note", "run-tiles", "equity-chart"]) $(x).hidden = false;
  const m = rep.metrics;
  $("run-note").textContent = [rep.complete ? "" : `Incomplete run: ${rep.bars.processed} of ${rep.bars.total} days. Not a finished performance report.`,
    rep.evidence_note || ""].filter(Boolean).join(" ");
  $("run-note").hidden = !$("run-note").textContent;
  fillTiles($("run-tiles"), [["Net return", pct(m.net_return)], ["Annualized", pct(m.cagr)],
    ["Max drawdown", pct(m.max_drawdown)], ["Days below peak", m.max_drawdown_days ?? "n/a"],
    ["Sharpe (rf 0)", num(m.sharpe)], ["Trades", m.trade_count], ["Fees paid", num(m.total_fees)],
    ["Time in market", pct(m.exposure)]]);
  const chart = makeChart("equity-chart");
  charts.equity ??= chart.addLineSeries({ color: chartColors().ink, lineWidth: 2 });
  charts.equity.setData(rep.equity_curve.map(([ts, v]) => ({ time: toTime(ts), value: +v })));
  chart.timeScale().fitContent();
  state.reportId = job.report_id;
}

$("run-cancel").addEventListener("click", (e) => busy(e.currentTarget, async () => {
  const id = location.hash.split("/")[1];
  await api(`/v1/jobs/${id}/cancel`, { method: "POST" });
  say("Stopping. You pay only for compute already used.");
  clearTimeout(state.pollTimer);
  showRun(id);
}));

for (const b of document.querySelectorAll("[data-artifact]")) {
  b.addEventListener("click", () => busy(b, async () => {
    const res = await api(`/v1/reports/${state.reportId}/artifacts/${b.dataset.artifact}`, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    el("a", { href: url, download: `veyra-${state.reportId.slice(0, 8)}-${b.dataset.artifact}` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }));
}

// ---------------------------------------------------------------- wallet
async function showWallet() {
  if (!state.org) {
    $("wallet-balance").replaceChildren();
    $("usage-list").replaceChildren(el("li", { class: "muted" }, "Payments are not available yet."));
    return;
  }
  const b = await refreshBalance();
  if (!b) return;
  fillTiles($("wallet-balance"), [["Available", usd(b.available_nano, 4)],
    ["Reserved for runs", usd(b.reserved_nano, 4)], ["Spent to date", usd(b.settled_usage_nano, 4)]]);
  try {
    const { usage_events } = await api(`/v1/orgs/${state.org}/billing/usage`);
    $("usage-list").replaceChildren(...usage_events.map((u) => el("li", {}, el("div", {},
      `${u.meter}: ${u.units} ${u.unit}s · ${usd(u.supplier_cost_nano, 6)} supplier cost`,
      el("span", { class: "sub" }, `${when(u.created_at)} · ${u.detail.vcpus} vCPU / ${u.detail.memory_gb} GB`)))));
    if (!usage_events.length) $("usage-list").append(el("li", { class: "muted" }, "No usage yet."));
  } catch (e) { fail(e); }
}

for (const b of document.querySelectorAll("[data-topup]")) {
  b.addEventListener("click", () => busy(b, async () => {
    const pay = await api(`/v1/orgs/${state.org}/billing/topups`, { method: "POST",
      body: { amount_usd: b.dataset.topup } });
    // Real checkout redirects to the payment provider; locally we confirm the test payment.
    await api(`/v1/dev/payments/${pay.id}/complete`, { method: "POST" });
    say(`Added ${usd(pay.amount_nano, 2)}`);
    showWallet();
  }));
}

// ---------------------------------------------------------------- start
(async () => {
  try { await boot(); } catch (e) {
    if (e.status === 401) { localStorage.removeItem("veyra.user"); state.user = null; } else fail(e);
  }
  route();
})();
