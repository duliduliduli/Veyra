"use strict";
// Veyra phone-first client. Talks only to the public /v1 API; holds no money logic.

const $ = (id) => document.getElementById(id);
let browserStorage = null, rememberedUser = null;
try { browserStorage = window.localStorage; rememberedUser = browserStorage.getItem("veyra.user"); }
catch {
  $("session-storage-status").hidden = false;
  $("session-storage-status").textContent = "Browser storage could not be read. This page is using anonymous access. Existing data was left unchanged; device saving may be unavailable.";
}
const state = { user: rememberedUser, org: null, datasets: [],
  project: null, quote: null, pollTimer: null };
const charts = {};

// ---------------------------------------------------------------- helpers
async function api(path, { method = "GET", body, headers = {}, raw = false, anonymous = false } = {}) {
  const res = await fetch(path, { method, cache: "no-store", credentials: anonymous ? "omit" : "same-origin",
    headers: { ...(!anonymous && state.user ? { "x-veyra-dev-user": state.user } : {}),
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
    accent: v("--accent"), mono: v("--mono"), up: v("--up"), down: v("--down") };
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
    const user = state.user;
    try {
      const me = await api("/v1/me");
      if (user === state.user) {
        const org = me.organizations[0]?.id ??
          (await api("/v1/orgs", { method: "POST", body: { name: "My workspace" } })).id;
        if (user === state.user) state.org = org;
      }
    } catch (e) {
      if (user === state.user) {
        if (e.status !== 401) throw e;
        forgetRememberedUser();
      }
    }
  }
  state.datasets = (await api("/v1/catalog/datasets")).datasets;
  for (const sel of [$("market-dataset"), $("bt-dataset")]) {
    sel.replaceChildren(...state.datasets.map((d) =>
      el("option", { value: d.dataset_id }, `${d.instrument_id} · daily · ${d.provider}`)));
  }
  $("signout").hidden = !state.org;
  for (const control of document.querySelectorAll("[data-topup]")) {
    control.disabled = !state.org;
  }
  if (state.org) refreshBalance();
}

let balanceRequest = 0;
async function refreshBalance(current = () => true) {
  const request = ++balanceRequest, org = state.org, user = state.user;
  const owned = () => request === balanceRequest && org === state.org && user === state.user && current();
  try {
    const b = await api(`/v1/orgs/${org}/billing/balance`);
    if (!owned()) return;
    $("balance-pill").textContent = usd(b.available_nano);
    $("balance-pill").hidden = false;
    return b;
  } catch (e) { if (owned()) fail(e); }
}

function forgetRememberedUser() {
  // Privacy exits must never restore a previous account or retain its in-page source.
  state.project = null;
  projectLoad++;
  window.removeEventListener("beforeunload", warnEditorUnload);
  state.user = null;
  state.org = null;
  cancelReportImport();
  closeChartRuns();
  clearRunReport();
  invalidateQuote();
  $("signout").hidden = true;
  $("balance-pill").hidden = true;
  for (const control of document.querySelectorAll("[data-topup]")) control.disabled = true;
  try {
    browserStorage.removeItem("veyra.user");
    $("session-storage-status").hidden = true;
    return true;
  } catch {
    $("session-storage-status").hidden = false;
    $("session-storage-status").textContent = "Account disconnected for this page only. The remembered account could not be removed from browser storage; reloading may reconnect it. This page was not reloaded. Device strategies and drafts were left unchanged.";
    return false;
  }
}
$("signout").addEventListener("click", () => {
  if (!confirmEditorDiscard("signing out", "Sign out")) return;
  const removed = forgetRememberedUser();
  location.hash = "";
  if (removed) location.reload();
  else {
    route();
    $("editor").value = "";
    $("editor").disabled = true;
    resetAssistant();
    for (const id of ["assistant-before", "assistant-after", "assistant-diff-lines", "usage-list", "wallet-balance"]) $(id).replaceChildren();
    clearRunReport();
    overlayImport++;
    selectedOverlay = null;
    selectedRunDate = null;
    updateOverlay();
    for (const id of ["overlay-fill-list", "overlay-summary", "overlay-source", "overlay-evidence", "report-import-status"]) $(id).replaceChildren();
  }
});

// ---------------------------------------------------------------- routing
const views = [ "markets", "code", "project", "discover", "public", "runs", "approvals", "run", "wallet"];

let routeGeneration = 0, activeRoute = null;
const unpersistedEditorDraft = () => state.project && projectDirty(state.project) && !state.project.draftStored;
function confirmEditorDiscard(action = "leaving this editor", verb = "Leave") {
  return !unpersistedEditorDraft() || window.confirm(`Your unsaved edits could not be stored on this device and may be lost when ${action}. Cancel and download a snapshot first to keep a backup. ${verb} and discard these in-page edits?`);
}
function warnEditorUnload(event) {
  if (!unpersistedEditorDraft()) return;
  event.preventDefault();
  event.returnValue = true; // Native wording/availability are controlled by the browser.
}
function route(event, destination) {
  if (event?.type === "hashchange" && event.newURL && event.newURL !== location.href) return;
  const owner = activeRoute;
  const owned = () => owner && owner === activeRoute && owner.user === state.user && owner.org === state.org;
  // A queued hashchange after cancellation must not reload the preserved project.
  if (event?.type === "hashchange" && owned() && unpersistedEditorDraft() && location.href === activeRoute.url) return;
  if (owned() && !confirmEditorDiscard() && owned()) {
    // shortcut: hash cancellation replaces this entry, not its index; use an indexed router if exact traversal is required.
    if (location.href !== activeRoute.url) history.replaceState(activeRoute.historyState, "", activeRoute.url);
    return;
  }
  if (destination) history.pushState(null, "", destination);
  activeRoute = { url: location.href, hash: location.hash, historyState: history.state, user: state.user, org: state.org };
  window.removeEventListener("beforeunload", warnEditorUnload);
  routeGeneration++;
  if ($("report-overlay-dialog").open) closeResearchDialog("report-overlay-dialog");
  editorTabExit = false;
  if (approvalsView) clearTimeout(approvalsView.timer);
  if ($("approval-review-dialog").open) closeRecoveryReview();
  approvalsView = null;
  projectCreation = null;
  $("create-project").disabled = false;
  $("new-project-status").textContent = "";
  if ($("strategy-file-dialog").open) closeStrategyFile();
  if ($("strategy-import-dialog").open) closeStrategyImport();
  if ($("public-copy-dialog").open) closePublicCopy();
  if ($("saved-link-dialog").open) closeSavedLink();
  if ($("strategy-history-dialog").open) closeStrategyHistory();
  clearTimeout(state.pollTimer);
  if ($("share-dialog").open) $("share-dialog").close();
  publicSnapshot = null;
  $("public-content").hidden = true;
  $("public-source").textContent = "";
  $("public-save-status").textContent = "";
  const [name, arg] = location.hash.slice(1).split("/");
  let view = views.includes(name) ? name : "markets";
  if (!state.org && view === "run") view = "runs";
  if (!state.org && view === "project" && !isLocalProject(arg)) view = "code";
  if (view === "code") selectProjectStore(arg === "device" || arg === "cloud" ? arg : projectStore);
  if (view === "project") selectProjectStore(isLocalProject(arg) ? "device" : "cloud");
  for (const v of views) $(`view-${v}`).hidden = v !== view;
  if (view !== "run") clearRunReport();
  document.body.classList.toggle("market-page", view === "markets");
  document.body.classList.toggle("studio-page", view === "project");
  if (view !== "project") { projectLoad++; state.project = null; }
  if (view !== "project" && $("strategy-settings-dialog").open) closeStrategySettings();
  if (view === "markets" && arg === "browse") openAssetBrowser();
  if (view !== "markets") {
    for (const id of ["indicator-dialog", "report-overlay-dialog"]) { if ($(id).open) closeResearchDialog(id); }
    for (const id of ["intervals-sheet", "draw-sheet", "hub-sheet", "panel-sheet"]) { if ($(id).open) $(id).close(); }
    leaveChartModes();
  }
  if ((view !== "markets" || arg !== "browse") && $("asset-browser").open) $("asset-browser").close();
  const tab = { project: "code", public: "discover", run: "runs", approvals: "runs" }[view] || view;
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  ({ markets: () => { if (!marketBars.length) showMarkets(); }, code: showProjects, project: () => showProject(arg),
     discover: showDiscover, public: () => showPublicStrategy(arg), runs: () => showRuns(arg), approvals: () => showApprovals(arg), run: () => showRun(arg), wallet: showWallet }[view] || (() => {}))();
}
window.addEventListener("hashchange", route);
document.addEventListener("click", (event) => {
  const link = event.target.closest?.("a[href]");
  if (!link || event.defaultPrevented || event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
      (link.target && link.target.toLowerCase() !== "_self") || link.hasAttribute("download") || !unpersistedEditorDraft()) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search || url.hash === location.hash) return;
  // Run target-specific context guards first, then confirm before changing the URL or any editor state.
  event.preventDefault();
  route(null, url.href);
});

// ---------------------------------------------------------------- markets
let marketRange = 365;
let marketInterval = "1d";
let marketRequest = 0;
let marketBars = [];
const marketCache = new Map();

const assetName = (d) => d.instrument_id.replace(/^SYNTH:/, "");
const marketNumber = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
const dayChange = (bars) => bars.length > 1 && Number(bars.at(-2).close) !== 0
  ? (Number(bars.at(-1).close) / Number(bars.at(-2).close) - 1) * 100 : null;
const changeLabel = (v) => v == null ? "Daily change unavailable" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}% · last day`;

async function assetBars(ds) {
  if (!marketCache.has(ds.dataset_id)) {
    const request = api(`/v1/catalog/datasets/${encodeURIComponent(ds.dataset_id)}/bars`)
      .then(({ bars }) => bars).catch((error) => { marketCache.delete(ds.dataset_id); throw error; });
    marketCache.set(ds.dataset_id, request);
  }
  return marketCache.get(ds.dataset_id);
}

function aggregateBars(bars, interval) {
  // Daily source bars cannot produce intraday candles; never fall back to daily.
  if (!["1d", "3d", "1w", "1M", "30w"].includes(interval)) return [];
  const days = { "1d": 1, "3d": 3, "1w": 7, "30w": 210 }[interval];
  const width = days * 864e5;
  // Fixed UTC buckets: days from the Unix epoch, weeks from Monday 1970-01-05.
  const origin = interval.endsWith("w") ? Date.UTC(1970, 0, 5) : 0;
  const result = [];
  let previousKey;
  for (const b of bars) {
    const date = new Date(b.ts);
    const key = interval === "1M" ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
      : origin + Math.floor((date.getTime() - origin) / width) * width;
    if (key !== previousKey) {
      result.push({ time: key / 1000, open: +b.open, high: +b.high, low: +b.low,
        close: +b.close, volume: +b.volume });
      previousKey = key;
    } else {
      const last = result.at(-1);
      last.high = Math.max(last.high, +b.high);
      last.low = Math.min(last.low, +b.low);
      last.close = +b.close;
      last.volume += +b.volume;
    }
  }
  return result;
}

function clearTrends() {
  cancelPlacement();
  exitReplay(false); // a replay date belongs to the old bars
  for (const d of drawings.splice(0)) if (d.line) charts["market-chart"]?.removeSeries(d.line);
  drawingLayer?.set([]);
  // Drawing positions are bar indexes of the old chart; never undo them onto new bars.
  undoStack.splice(0, undoStack.length, ...undoStack.filter((entry) => entry.kind !== "drawing"));
  updateUndo();
}

function marketChart() {
  const chart = makeChart("market-chart");
  if (charts.candles) return chart;
  const c = chartColors();
  charts.candles = chart.addCandlestickSeries();
  charts.marketLine = chart.addLineSeries({ color: c.ink, lineWidth: 2, visible: false });
  charts.marketBarsSeries = chart.addBarSeries({ visible: false });
  charts.marketArea = chart.addAreaSeries({ lineColor: c.ink, topColor: c.ink + "33", bottomColor: c.ink + "05", lineWidth: 2, visible: false });
  // Transparent close series: anchors drawings and price conversions for every chart type.
  charts.anchor = chart.addLineSeries({ color: "rgba(0,0,0,0)", lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
  drawingLayer = new DrawingLayer();
  charts.anchor.attachPrimitive(drawingLayer);
  chart.priceScale("right").applyOptions({ minimumWidth: 84, scaleMargins: { top: 0.1, bottom: 0.23 } });
  charts.volume = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "volume" });
  chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
  charts.sma = chart.addLineSeries({ color: c.accent, lineWidth: 1, visible: false,
    lastValueVisible: false, priceLineVisible: false });
  for (const [key, color, style] of [["sma50", c.up, 0], ["sma200", c.down, 0], ["ema20", c.ink, 2], ["ema50", c.muted, 2],
    ["bbUpper", c.muted, 0], ["bbMiddle", c.muted, 2], ["bbLower", c.muted, 0]]) {
    charts[key] = chart.addLineSeries({ color, lineWidth: 1, lineStyle: style, visible: false, lastValueVisible: false,
      priceLineVisible: false, crosshairMarkerVisible: false });
  }
  applyChartSettings();
  chart.subscribeCrosshairMove((param) => {
    const b = param.seriesData.get(charts.candles) ?? param.seriesData.get(charts.marketBarsSeries);
    const line = param.seriesData.get(charts.marketLine) ?? param.seriesData.get(charts.marketArea);
    $("chart-readout").textContent = b
      ? `O ${marketNumber(b.open)} H ${marketNumber(b.high)} L ${marketNumber(b.low)} C ${marketNumber(b.close)}`
      : line ? `Close ${marketNumber(line.value)} · UTC` : "Crosshair shows OHLC · UTC";
  });
  chart.subscribeClick((param) => {
    if (placing) return; // drawing taps are read from pointer events below

    if (replay.picking && param.time != null) { startReplayAt(param.time); return; }
    if (selectedOverlay && param.time && overlayGroups.some((group) => group.time === param.time)) {
      showOverlayFills(param.time);
      openResearchDialog("report-overlay-dialog");
    }
  });
  return chart;
}

function renderMarketChart() {
  const chart = marketChart();
  const ds = state.datasets.find((d) => d.dataset_id === $("market-dataset").value);
  const end = Date.parse(ds.coverage_end);
  const aggregated = aggregateBars(marketBars, marketInterval);
  // Keep complete candles that overlap the range; changing range must not change OHLC.
  const cutoff = (end - marketRange * 864e5) / 1000;
  const bars = marketRange ? aggregated.filter((b, i) =>
    (aggregated[i + 1]?.time ?? end / 1000 + 86400) > cutoff) : aggregated;
  const c = chartColors();
  charts.candles.setData(bars);
  charts.marketLine.setData(bars.map((b) => ({ time: b.time, value: b.close })));
  charts.volume.setData(bars.map((b) => ({ time: b.time, value: b.volume,
    color: b.close >= b.open ? c.line : c.accent + "66" })));
  const visibleTimes = new Set(bars.map((bar) => bar.time));
  charts.sma.setData(aggregated.slice(19).map((b, i) => ({ time: b.time,
    value: aggregated.slice(i, i + 20).reduce((sum, item) => sum + item.close, 0) / 20 })).filter((bar) => visibleTimes.has(bar.time)));
  chart.timeScale().fitContent();
  updateChartResearch(aggregated, bars);
  $("chart-empty").hidden = !!bars.length;
  $("chart-empty").textContent = "No bars for this range.";
  $("market-chart").setAttribute("aria-label", `${assetName(ds)} historical synthetic ${$("chart-type").value} chart, ${marketInterval} intervals`);
}

function displayMarketBars(ds, bars) {
  marketBars = bars;
  showSymbol(ds);
  renderMarketChart();
  const last = bars.at(-1), change = dayChange(bars);
  const delta = bars.length > 1 ? Number(last.close) - Number(bars.at(-2).close) : null;
  $("market-price").textContent = last ? `${marketNumber(last.close)} ${ds.quote_currency}` : "—";
  $("market-change").textContent = change == null ? changeLabel(change)
    : `${change >= 0 ? "▲" : "▼"} ${VeyraChartTools.signed(delta)} (${changeLabel(change)})`;
  $("market-price").parentElement.classList.toggle("loss", change < 0);
  $("market-price").parentElement.classList.toggle("gain", change > 0);
  $("market-meta").textContent = last
    ? `As of ${last.ts.slice(0, 10)} UTC · ${ds.license}` : "No bars in this dataset.";
}

async function showMarkets() {
  const request = ++marketRequest;
  const ds = state.datasets.find((d) => d.dataset_id === $("market-dataset").value);
  if (!ds) {
    $("chart-empty").hidden = false;
    $("chart-empty").textContent = "No datasets available.";
    return;
  }
  marketBars = [];
  cancelReportImport();
  studyBars = visibleStudyBars = [];
  if (charts.rsi) { charts.rsi.setData([]); charts.rsiTimeAnchor.setData([]); }
  for (const key of ["candles", "marketLine"]) charts[key]?.setMarkers([]);
  updateOverlay();
  showSymbol(ds);
  $("market-price").textContent = "—";
  $("market-change").textContent = "";
  $("market-meta").textContent = "Loading historical data…";
  $("chart-empty").hidden = false;
  $("chart-empty").textContent = "Loading chart…";
  if (charts.candles) {
    clearTrends();
    for (const key of ["candles", "marketLine", "marketBarsSeries", "marketArea", "anchor", "volume", "sma", ...lineIndicatorSeries]) charts[key].setData([]);
  }
  try {
    const bars = await assetBars(ds);
    if (request !== marketRequest) return;
    displayMarketBars(ds, bars);
  } catch (e) {
    if (request !== marketRequest) return;
    $("chart-empty").hidden = false;
    $("chart-empty").textContent = "Chart unavailable. Select the asset again to retry.";
    $("market-meta").textContent = e.message;
  }
}

function chooseAsset(id) {
  $("market-dataset").value = id;
  if ($("asset-browser").open) $("asset-browser").close();
  showMarkets();
}
function matchingAssets(query, provider = "") {
  const needle = query.trim().toLowerCase();
  return state.datasets.filter((d) => (!provider || d.provider === provider) &&
    `${d.instrument_id} ${d.dataset_id} ${d.provider}`.toLowerCase().includes(needle));
}
function renderAssetBrowser() {
  const list = $("browse-list"), watched = new Set(chartPrefs.watchlist), watchOnly = $("browse-tab-watch").getAttribute("aria-selected") === "true";
  const assets = matchingAssets($("browse-search").value, $("browse-provider").value).filter((d) => !watchOnly || watched.has(d.dataset_id))
    .sort((a, b) => assetName(a).localeCompare(assetName(b)) * ($("browse-sort").value === "name-desc" ? -1 : 1));
  list.replaceChildren(...assets.map((d) => {
    const price = el("span", {}, "Loading…");
    const change = el("span", { class: "asset-change" });
    const button = el("button", { type: "button", "data-asset": d.dataset_id },
      el("span", { class: "asset-top" }, el("span", { class: "asset-title" }, assetName(d)),
        el("span", {}, price, change)),
      el("span", { class: "asset-details" }, ...[
        d.provider, "Daily bars", `${d.coverage_start.slice(0, 10)} – ${d.coverage_end.slice(0, 10)}`,
      ].map((text) => el("span", {}, text))));
    button.addEventListener("click", () => chooseAsset(d.dataset_id));
    const star = el("button", { type: "button", class: "star", "aria-pressed": String(watched.has(d.dataset_id)), "aria-label": `Watchlist ${assetName(d)}` }, "★");
    star.addEventListener("click", () => toggleWatch(d.dataset_id));
    assetBars(d).then((bars) => {
      const last = bars.at(-1), delta = dayChange(bars);
      price.textContent = last ? `${marketNumber(last.close)} ${d.quote_currency}` : "No bars";
      change.textContent = changeLabel(delta);
      change.classList.toggle("loss", delta < 0);
      change.classList.toggle("gain", delta > 0);
    }).catch(() => { price.textContent = "Price unavailable"; });
    return el("li", {}, button, star);
  }));
  if (!assets.length) list.append(el("li", { class: "muted small" }, watchOnly ? "Your watchlist is empty. Star an asset to add it." : "No matching assets."));
}
function openAssetBrowser() {
  const provider = $("browse-provider"), previous = provider.value;
  provider.replaceChildren(el("option", { value: "" }, "All sources"),
    ...[...new Set(state.datasets.map((d) => d.provider))].map((p) => el("option", { value: p }, p)));
  provider.value = previous;
  renderAssetBrowser();
  if (!$("asset-browser").open) $("asset-browser").showModal();
  $("browse-search").focus();
}
$("browse-assets").addEventListener("click", () => {
  if (!$("asset-browser").open) history.pushState({ veyraBrowse: true }, "", "#markets/browse");
  openAssetBrowser();
});
$("close-browse").addEventListener("click", () => $("asset-browser").close());
$("asset-browser").addEventListener("close", () => {
  if ($("asset-browser").open) return;
  if (location.hash === "#markets/browse") {
    if (history.state?.veyraBrowse) history.back();
    else history.replaceState(null, "", "#markets");
  }
  if (!$("view-markets").hidden) $("browse-assets").focus();
});
for (const id of ["browse-search", "browse-provider", "browse-sort"]) $(id).addEventListener("input", renderAssetBrowser);
$("market-dataset").addEventListener("change", showMarkets);
for (const [selector, apply] of [
  ["[data-range]", (b) => { marketRange = Number(b.dataset.range); clearTrends(); }],
  ["[data-interval]", (b) => { marketInterval = b.dataset.interval; clearTrends(); }],
]) {
  for (const b of document.querySelectorAll(selector)) b.addEventListener("click", () => {
    if (b.disabled) return;
    apply(b);
    document.querySelectorAll(selector).forEach((x) => {
      x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b));
    });
    if (marketBars.length) renderMarketChart();
  });
}
let chartTypeShown = "candles";
$("chart-type").addEventListener("change", () => {
  const previous = chartTypeShown, next = $("chart-type").value;
  chartTypeShown = next;
  remember(`Change chart type to ${$("chart-type").selectedOptions[0].textContent}`, () => { $("chart-type").value = previous; $("chart-type").dispatchEvent(new Event("change")); });
  marketChart();
  if (marketBars.length) renderMarketChart();
  $("market-chart").setAttribute("aria-label", `Historical synthetic ${$("chart-type").selectedOptions[0].textContent.toLowerCase()} price chart`);
});
$("chart-log").addEventListener("click", () => {
  marketChart();
  setSetting("log", $("chart-log").getAttribute("aria-pressed") !== "true");
});
$("chart-reset").addEventListener("click", () => {
  if (!charts["market-chart"]) return;
  charts["market-chart"].timeScale().fitContent();
  charts["market-chart"].priceScale("right").applyOptions({ autoScale: true });
});
for (const [id, factor] of [["chart-zoom-in", 0.75], ["chart-zoom-out", 1.35]]) $(id).addEventListener("click", () => {
  const scale = charts["market-chart"]?.timeScale(), range = scale?.getVisibleLogicalRange();
  if (!range) return;
  const middle = (range.from + range.to) / 2, half = Math.max(2, (range.to - range.from) * factor / 2);
  scale.setVisibleLogicalRange({ from: middle - half, to: middle + half });
});

// ---------------------------------------------------------------- chart workspace
// Organized controls: one toolbar row, everything else in bottom sheets.
const lineIndicatorSeries = ["sma50", "sma200", "ema20", "ema50", "bbUpper", "bbMiddle", "bbLower"];
const indicatorSeries = { sma20: ["sma"], sma50: ["sma50"], sma200: ["sma200"], ema20: ["ema20"], ema50: ["ema50"], bb: ["bbUpper", "bbMiddle", "bbLower"] };
const indicatorButtonId = { volume: "chart-volume", sma20: "chart-sma", rsi: "chart-rsi" };
const INTERVAL_DAYS = { "1d": 1, "3d": 3, "1w": 7, "1M": 30.44, "30w": 210 };
const activeIndicators = new Set(["volume"]);
const compareIds = [], compareBars = new Map();
let chartSettings = { ...VeyraChartTools.SETTINGS }, layoutName = "Unnamed";
let drawings = [], drawingLayer = null, placing = null, drawingSeq = 0, drawCategory = "lines";
let replayTimeline = [], alertMarkerList = [], alertLines = [], unseenAlerts = false;
const replay = { time: null, picking: false, timer: null };
const currentDataset = () => state.datasets.find((d) => d.dataset_id === $("market-dataset").value);
const datasetIds = () => state.datasets.map((d) => d.dataset_id);
const indicatorName = (id) => VeyraChartTools.INDICATORS.find((i) => i.id === id)?.name || id;
const intervalLabel = (v) => v === "1M" ? "1M" : v.toUpperCase();
const rgba = (color, alpha) => {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
};
function activeSeries() {
  const type = $("chart-type").value;
  return { bars: charts.marketBarsSeries, line: charts.marketLine, area: charts.marketArea }[type] ?? charts.candles;
}

// Device storage is untrusted: every read is validated by VeyraChartTools.
const chartStore = {
  read(key, fallback) {
    try { const raw = browserStorage?.getItem(`veyra.chart.${key}`); return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; }
  },
  write(key, value) {
    try { browserStorage.setItem(`veyra.chart.${key}`, JSON.stringify(value)); return true; }
    catch { say("Could not save on this device. Browser storage is unavailable or full.", true); return false; }
  },
};
const chartPrefs = {
  get watchlist() { return VeyraChartTools.watchlist(chartStore.read("watchlist", []), datasetIds()); },
  get favorites() { return VeyraChartTools.favorites(chartStore.read("favorites", [])); },
  get alerts() { return VeyraChartTools.alerts(chartStore.read("alerts", []), datasetIds()); },
  get layouts() { return VeyraChartTools.layouts(chartStore.read("layouts", []), datasetIds()); },
  get templates() { return VeyraChartTools.templates(chartStore.read("templates", [])); },
};

// ---------------------------------------------------------------- undo
const undoStack = [];
let undoing = false;
function remember(label, undo, kind = "chart") {
  if (undoing) return;
  undoStack.push({ label, undo, kind });
  if (undoStack.length > 50) undoStack.shift();
  updateUndo();
}
function updateUndo() {
  const top = undoStack.at(-1);
  $("chart-undo").disabled = !top;
  $("chart-undo").setAttribute("aria-label", top ? `Undo: ${top.label}` : "Undo");
  $("chart-undo").title = top ? `Undo: ${top.label}` : "Nothing to undo";
}
$("chart-undo").addEventListener("click", () => {
  const top = undoStack.pop();
  if (!top) return;
  undoing = true;
  try { top.undo(); } finally { undoing = false; }
  updateUndo();
  say(`Undid: ${top.label}`);
});

// ---------------------------------------------------------------- sheets
const SHEETS = ["intervals-sheet", "draw-sheet", "hub-sheet", "panel-sheet"];
function closeSheets(except) { for (const id of SHEETS) if (id !== except && $(id).open) $(id).close(); }
function openSheet(id) { closeSheets(id); if (!$(id).open) $(id).showModal(); }
for (const dialog of document.querySelectorAll("dialog.sheet")) {
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  for (const b of dialog.querySelectorAll("[data-close]")) b.addEventListener("click", () => dialog.close());
  const handle = dialog.querySelector(".sheet-handle");
  let start = null;
  handle?.addEventListener("pointerdown", (e) => { start = e.clientY; handle.setPointerCapture(e.pointerId); });
  handle?.addEventListener("pointermove", (e) => { if (start != null) dialog.style.transform = `translateY(${Math.max(0, e.clientY - start)}px)`; });
  handle?.addEventListener("pointerup", (e) => {
    if (start == null) return;
    const dragged = e.clientY - start;
    start = null; dialog.style.transform = "";
    if (dragged > 80) dialog.close();
  });
  handle?.addEventListener("pointercancel", () => { start = null; dialog.style.transform = ""; });
}

// ---------------------------------------------------------------- header
function showSymbol(ds) {
  const name = assetName(ds), [base, quote] = name.split("-");
  $("market-symbol").textContent = name;
  $("market-icon").textContent = base.slice(0, 1);
  $("market-source").textContent = `${base} / ${quote || ds.quote_currency} · ${ds.provider} · historical`;
  applyChartSettings();
}
$("open-intervals").addEventListener("click", () => openSheet("intervals-sheet"));
for (const b of document.querySelectorAll("[data-interval]")) b.addEventListener("click", () => {
  if (b.disabled) return;
  $("open-intervals").firstChild.textContent = `${intervalLabel(b.dataset.interval)} `;
  if ($("intervals-sheet").open) $("intervals-sheet").close();
});
$("chart-fullscreen").addEventListener("click", () => setFullscreen(!document.body.classList.contains("chart-fullscreen")));
function setFullscreen(on) {
  document.body.classList.toggle("chart-fullscreen", on);
  $("chart-fullscreen").setAttribute("aria-pressed", String(on));
  $("chart-fullscreen").setAttribute("aria-label", on ? "Exit full screen" : "Full screen chart");
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
    if (placing) cancelPlacement(); else if (document.body.classList.contains("chart-fullscreen")) setFullscreen(false);
  }
});
function leaveChartModes() { cancelPlacement(); exitReplay(false); setFullscreen(false); }

// ---------------------------------------------------------------- settings and series styling
function applyChartSettings() {
  const chart = charts["market-chart"];
  if (!chart || !charts.candles) return;
  const c = chartColors(), s = chartSettings, classic = s.colors === "classic";
  const up = classic ? c.up : c.ink, down = classic ? c.down : c.accent;
  const hollow = $("chart-type").value === "hollow" || !classic;
  const ds = currentDataset(), title = s.symbolLabel && ds ? assetName(ds) : "";
  charts.candles.applyOptions({ upColor: hollow ? "rgba(0,0,0,0)" : up, borderUpColor: up, wickUpColor: up,
    downColor: down, borderDownColor: down, wickDownColor: down, priceLineVisible: s.priceLine, title });
  charts.marketBarsSeries.applyOptions({ upColor: up, downColor: down, priceLineVisible: s.priceLine, title });
  for (const key of ["marketLine", "marketArea"]) charts[key].applyOptions({ priceLineVisible: s.priceLine, title });
  chart.applyOptions({ grid: { vertLines: { visible: s.grid }, horzLines: { visible: s.grid } }, crosshair: { mode: s.crosshair ? 1 : 2 } });
  chart.priceScale("right").applyOptions({ mode: s.log ? 1 : 0 });
  $("chart-log").setAttribute("aria-pressed", String(s.log));
}
function setSetting(key, value) {
  const previous = chartSettings[key];
  if (previous === value) return;
  chartSettings = { ...chartSettings, [key]: value };
  remember(`${key === "log" ? "Log scale" : "Chart setting"} change`, () => setSetting(key, previous));
  applyChartSettings();
  if (marketBars.length) renderMarketChart();
  if ($("panel-sheet").open && panelName === "settings") openPanel("settings", panelFromHub);
}

// Runs inside updateChartResearch, after replay has cut future bars.
function updateChartWorkspace(aggregated, visible) {
  const chart = charts["market-chart"];
  if (!chart || !charts.anchor) return;
  const type = $("chart-type").value, c = chartColors(), classic = chartSettings.colors === "classic";
  const times = new Set(visible.map((b) => b.time)), closes = visible.map((b) => ({ time: b.time, value: b.close }));
  charts.candles.setData(type === "heikin" ? VeyraChartTools.heikinAshi(visible) : visible);
  charts.marketBarsSeries.setData(visible);
  charts.marketLine.setData(closes);
  charts.marketArea.setData(closes);
  charts.anchor.setData(closes);
  for (const [key, on] of [["candles", ["candles", "hollow", "heikin"].includes(type)], ["marketBarsSeries", type === "bars"],
    ["marketLine", type === "line"], ["marketArea", type === "area"]]) charts[key].applyOptions({ visible: on });
  const up = classic ? c.up : c.ink, down = classic ? c.down : c.accent;
  const volumeOn = activeIndicators.has("volume");
  charts.volume.setData(visible.map((b) => ({ time: b.time, value: b.volume, color: rgba(b.close >= b.open ? up : down, 0.35) })));
  charts.volume.applyOptions({ visible: volumeOn });
  chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.1, bottom: volumeOn ? 0.23 : 0.1 } });
  // Price-pane indicators use full history up to the replay point, then crop to the visible range.
  const all = aggregated.map((b) => b.close), bb = VeyraChartTools.bollinger(all);
  const values = { sma: VeyraChartTools.sma(all, 20), sma50: VeyraChartTools.sma(all, 50), sma200: VeyraChartTools.sma(all, 200),
    ema20: VeyraChartTools.ema(all, 20), ema50: VeyraChartTools.ema(all, 50), bbUpper: bb.upper, bbMiddle: bb.middle, bbLower: bb.lower };
  const missing = [];
  for (const [id, keys] of Object.entries(indicatorSeries)) {
    for (const key of keys) {
      const data = aggregated.map((b, i) => ({ time: b.time, value: values[key][i] })).filter((p) => p.value != null && times.has(p.time));
      charts[key].setData(data);
      charts[key].applyOptions({ visible: activeIndicators.has(id) });
      if (activeIndicators.has(id) && !data.length && !missing.includes(id)) missing.push(id);
    }
  }
  if (missing.length) $("chart-readout").textContent = `${missing.map(indicatorName).join(", ")}: not enough candles at this interval. Try a longer range.`;
  updateMacd(aggregated, visible);
  const lowerPanes = [!$("rsi-pane").hidden, !$("macd-pane").hidden];
  chart.applyOptions({ timeScale: { visible: !lowerPanes.some(Boolean) } });
  charts["rsi-chart"]?.applyOptions({ timeScale: { visible: lowerPanes[0] && !lowerPanes[1] } });
  updateCompare(visible, times);
  updateAlerts(visible);
  for (const d of drawings) if (d.line) d.line.setData(d.series.map((v, i) => v == null || !visible[i] ? null : { time: visible[i].time, value: v }).filter(Boolean));
  drawingLayer?.set(drawingShapes());
}

function makeMacdChart() {
  if (charts["macd-chart"]) return charts["macd-chart"];
  const chart = makeChart("macd-chart"), c = chartColors();
  chart.applyOptions({ handleScroll: false, handleScale: false }); // follows the price pane
  charts.macdHist = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
  charts.macdLine = chart.addLineSeries({ color: c.ink, lineWidth: 1, priceLineVisible: false });
  charts.macdSignal = chart.addLineSeries({ color: c.accent, lineWidth: 1, priceLineVisible: false });
  chart.priceScale("right").applyOptions({ minimumWidth: 84 });
  charts["market-chart"].timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (range && !$("macd-pane").hidden) chart.timeScale().setVisibleLogicalRange(range);
  });
  return chart;
}
function updateMacd(aggregated, visible) {
  if ($("macd-pane").hidden) return;
  const chart = makeMacdChart(), c = chartColors(), m = VeyraChartTools.macd(aggregated.map((b) => b.close));
  const index = new Map(aggregated.map((b, i) => [b.time, i]));
  const point = (arr, extra = () => ({})) => visible.map((b) => {
    const v = arr[index.get(b.time)];
    return v == null ? { time: b.time } : { time: b.time, value: v, ...extra(v) };
  });
  charts.macdHist.setData(point(m.histogram, (v) => ({ color: rgba(v >= 0 ? c.up : c.down, 0.5) })));
  charts.macdLine.setData(point(m.macd));
  charts.macdSignal.setData(point(m.signal));
  chart.timeScale().setVisibleLogicalRange(charts["market-chart"].timeScale().getVisibleLogicalRange());
}

function setIndicator(id, on, record = true) {
  if (activeIndicators.has(id) === on) return;
  if (on) activeIndicators.add(id); else activeIndicators.delete(id);
  if (record) remember(`${on ? "Add" : "Remove"} ${indicatorName(id)}`, () => setIndicator(id, !on, false));
  $("rsi-pane").hidden = !activeIndicators.has("rsi");
  $("macd-pane").hidden = !activeIndicators.has("macd");
  for (const b of document.querySelectorAll(`[data-indicator="${id}"]`)) b.setAttribute("aria-pressed", String(on));
  marketChart();
  if (marketBars.length) renderMarketChart();
}

// ---------------------------------------------------------------- compare and alerts
function updateCompare(visible, times) {
  const chart = charts["market-chart"], colors = [chartColors().accent, "#6366f1", "#0ea5e9"];
  charts.compare ??= new Map();
  for (const [id, series] of charts.compare) if (!compareIds.includes(id) || id === $("market-dataset").value) { chart.removeSeries(series); charts.compare.delete(id); }
  compareIds.forEach((id, i) => {
    const ds = state.datasets.find((d) => d.dataset_id === id);
    if (!ds || id === $("market-dataset").value) return; // never compare a symbol with itself
    if (!compareBars.has(id)) {
      compareBars.set(id, null);
      assetBars(ds).then((bars) => { compareBars.set(id, bars); if (marketBars.length) renderMarketChart(); })
        .catch(() => { compareBars.delete(id); say(`${assetName(ds)} could not be loaded for comparison.`, true); });
      return;
    }
    const bars = compareBars.get(id);
    if (!bars) return;
    const other = aggregateBars(bars, marketInterval).filter((b) => times.has(b.time));
    if (!charts.compare.has(id)) charts.compare.set(id, chart.addLineSeries({ color: colors[i % 3], lineWidth: 2, priceLineVisible: false, title: `${assetName(ds)} rebased` }));
    // Rebased onto this chart's first visible close so both read on one price scale.
    const base = visible[0]?.close, start = other[0]?.close;
    charts.compare.get(id).setData(base && start ? other.map((b) => ({ time: b.time, value: b.close * base / start })) : []);
  });
}
function updateAlerts(visible) {
  const c = chartColors(), ds = currentDataset();
  for (const line of alertLines.splice(0)) charts.anchor.removePriceLine(line);
  alertMarkerList = [];
  for (const alert of chartPrefs.alerts.filter((a) => a.dataset === ds?.dataset_id)) {
    alertLines.push(charts.anchor.createPriceLine({ price: alert.level, color: c.accent, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Alert" }));
    for (const hit of VeyraChartTools.crossings(visible, alert.level)) {
      alertMarkerList.push({ time: hit.time, position: hit.direction === "up" ? "belowBar" : "aboveBar", shape: "circle", color: c.accent, text: "Alert" });
    }
  }
}
const alertMarkers = () => [...alertMarkerList].sort((a, b) => a.time - b.time);
function setUnseenAlerts(on) {
  unseenAlerts = on;
  $("hub-dot").hidden = !on;
  const tileDot = document.querySelector('[data-hub="alerts"] .dot');
  if (tileDot) tileDot.hidden = !on;
}

// ---------------------------------------------------------------- drawings
class DrawingLayer {
  constructor() {
    this.items = [];
    this.requestUpdate = () => {};
    const layer = this;
    this.views = [{ zOrder: () => "top", renderer: () => ({ draw: (target) => layer.draw(target) }) }];
  }
  attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = () => {}; }
  paneViews() { return this.views; }
  updateAllViews() {}
  set(items) { this.items = items; this.requestUpdate(); }
  draw(target) {
    if (!this.chart || !this.items.length) return;
    const scale = this.chart.timeScale(), series = this.series, colors = chartColors();
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      for (const item of this.items) drawShape(context, item, (l) => scale.logicalToCoordinate(l), (p) => series.priceToCoordinate(p), colors, mediaSize);
    });
  }
}
function drawShape(g, s, x, y, c, size) {
  const col = (key, alpha = 1) => rgba(c[key] || c.accent, alpha);
  const pt = (p) => { const px = x(p.logical), py = y(p.price); return px == null || py == null ? null : [px, py]; };
  const fillStroke = (path) => {
    if (s.fill) { g.fillStyle = col(s.fill, s.alpha ?? 0.15); g.fill(path); }
    if (s.stroke) { g.strokeStyle = col(s.stroke); g.stroke(path); }
  };
  g.save();
  g.lineWidth = s.width || 1;
  g.setLineDash(s.dash ? [5, 4] : []);
  g.strokeStyle = col(s.color || "accent");
  switch (s.type) {
    case "line": case "path": {
      const pts = (s.points || [s.a, s.b]).map(pt);
      if (pts.some((p) => !p)) break;
      g.beginPath();
      pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
      g.stroke();
      if (s.arrow) {
        const [[x1, y1], [x2, y2]] = pts.slice(-2), a = Math.atan2(y2 - y1, x2 - x1);
        g.setLineDash([]);
        g.beginPath(); g.moveTo(x2, y2);
        g.lineTo(x2 - 10 * Math.cos(a - 0.4), y2 - 10 * Math.sin(a - 0.4));
        g.lineTo(x2 - 10 * Math.cos(a + 0.4), y2 - 10 * Math.sin(a + 0.4));
        g.closePath(); g.fillStyle = g.strokeStyle; g.fill();
      }
      break;
    }
    case "hline": {
      const py = y(s.price);
      if (py != null) { g.beginPath(); g.moveTo(0, py); g.lineTo(size.width, py); g.stroke(); }
      break;
    }
    case "rect": {
      const a = pt(s.a), b = pt(s.b);
      if (!a || !b) break;
      const path = new Path2D();
      path.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]) || 1, Math.abs(b[1] - a[1]) || 1);
      fillStroke(path);
      break;
    }
    case "poly": {
      const pts = s.points.map(pt);
      if (pts.some((p) => !p)) break;
      const path = new Path2D();
      pts.forEach(([px, py], i) => (i ? path.lineTo(px, py) : path.moveTo(px, py)));
      path.closePath();
      fillStroke(path);
      break;
    }
    case "circle": {
      const a = pt(s.center), b = pt(s.edge);
      if (!a || !b) break;
      const path = new Path2D();
      path.arc(a[0], a[1], Math.hypot(b[0] - a[0], b[1] - a[1]), 0, Math.PI * 2);
      fillStroke(path);
      break;
    }
    case "candle": {
      const xo = x(s.logical), next = x(s.logical + 1), ys = [s.high, s.low, s.open, s.close].map(y);
      if (xo == null || next == null || ys.some((v) => v == null)) break;
      const [yh, yl, yo, yc] = ys, color = col(s.close >= s.open ? "up" : "down", 0.5), w = Math.max(2, (next - xo) * 0.6);
      g.setLineDash([]); g.strokeStyle = color; g.fillStyle = color;
      g.beginPath(); g.moveTo(xo, yh); g.lineTo(xo, yl); g.stroke();
      g.fillRect(xo - w / 2, Math.min(yo, yc), w, Math.max(1, Math.abs(yc - yo)));
      break;
    }
    case "point": {
      const a = pt(s.at);
      if (a) { g.fillStyle = col("accent"); g.beginPath(); g.arc(a[0], a[1], 5, 0, Math.PI * 2); g.fill(); }
      break;
    }
    case "label": {
      const a = pt(s.at);
      if (!a) break;
      g.font = `11px ${c.mono}`;
      const text = s.text.length > 64 ? `${s.text.slice(0, 63)}…` : s.text, w = g.measureText(text).width + 10;
      const lx = Math.min(Math.max(4, a[0] + 6), size.width - w - 4), ly = Math.max(4, a[1] - 24);
      g.fillStyle = rgba(c.ink, 0.88); g.fillRect(lx, ly, w, 18);
      g.fillStyle = c.bg; g.fillText(text, lx + 5, ly + 13);
      break;
    }
  }
  g.restore();
}
function drawingShapes() {
  const shapes = drawings.filter((d) => !d.hidden).flatMap((d) => [...d.shapes,
    { type: "label", at: d.points.reduce((top, p) => (p.price > top.price ? p : top), d.points[0]), text: d.tag }]);
  if (placing) shapes.push(...placing.points.map((at) => ({ type: "point", at })));
  return shapes;
}
function addDrawing(d) {
  if (d.series) d.line = charts["market-chart"].addLineSeries({ color: chartColors().accent, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: "AVWAP" });
  drawings.push(d);
  if (marketBars.length) renderMarketChart();
  remember(`Add ${d.name}`, () => removeDrawing(d, false), "drawing");
}
function removeDrawing(d, record = true) {
  if (!drawings.includes(d)) return;
  drawings = drawings.filter((x) => x !== d);
  if (d.line) charts["market-chart"].removeSeries(d.line);
  d.line = null;
  drawingLayer?.set(drawingShapes());
  if (record) remember(`Remove ${d.name}`, () => addDrawing(d), "drawing");
}
function startPlacement(id) {
  closeSheets();
  exitReplay(false);
  if (!marketBars.length || !charts.anchor) { say("Load a chart before drawing.", true); return; }
  cancelPlacement();
  placing = { tool: VeyraChartTools.toolById(id), points: [] };
  // Projecting tools need empty space past the latest bar to tap into or to show their result.
  if (["long", "short", "forecast", "bars-pattern", "ghost-feed", "sector"].includes(id)) {
    const scale = charts["market-chart"].timeScale(), range = scale.getVisibleLogicalRange(), last = visibleStudyBars.length - 1;
    if (range && range.to < last + 12) scale.setVisibleLogicalRange({ from: range.from, to: last + 12 });
  }
  $("draw-bar").hidden = false;
  updatePlacement();
}
function updatePlacement() {
  const { tool, points } = placing;
  $("draw-hint").textContent = `${tool.name} · ${tool.help} ${points.length ? `(${points.length} placed)` : ""}`;
  $("draw-finish").hidden = !(tool.minPoints && points.length >= tool.minPoints);
  for (const b of document.querySelectorAll("#draw-tiles .tile")) b.setAttribute("aria-pressed", String(b.dataset.tool === tool.id));
  drawingLayer?.set(drawingShapes());
}
function placePoint(param) {
  if (!param.point) return;
  const logical = charts["market-chart"].timeScale().coordinateToLogical(param.point.x);
  const price = charts.anchor.coordinateToPrice(param.point.y);
  if (logical == null || price == null) return;
  placing.points.push({ logical, price });
  if (placing.points.length >= placing.tool.points) finishPlacement(); else updatePlacement();
}
function finishPlacement() {
  if (!placing) return;
  const { tool, points } = placing;
  try {
    const drawing = VeyraChartTools.buildDrawing(tool.id, points, { bars: visibleStudyBars, intervalDays: INTERVAL_DAYS[marketInterval],
      timeLabel: (i) => `${isoDay(new Date(visibleStudyBars[i].time * 1000))} UTC` });
    drawing.id = ++drawingSeq;
    cancelPlacement();
    addDrawing(drawing);
    say(drawing.label);
  } catch (error) {
    placing.points = [];
    updatePlacement();
    say(error.message, true);
  }
}
function cancelPlacement() {
  if (!placing) return;
  placing = null;
  $("draw-bar").hidden = true;
  for (const b of document.querySelectorAll("#draw-tiles .tile")) b.setAttribute("aria-pressed", "false");
  drawingLayer?.set(drawingShapes());
}
// The library delays and merges quick taps (double-tap detection), so drawing reads raw taps:
// a short press that barely moved places a point; a drag still pans the chart.
let drawTap = null;
$("market-chart").addEventListener("pointerdown", (e) => { drawTap = placing ? { x: e.clientX, y: e.clientY } : null; }, true);
$("market-chart").addEventListener("pointerup", (e) => {
  const start = drawTap;
  drawTap = null;
  if (!placing || !start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) return;
  const rect = $("market-chart").getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
  if (x > charts["market-chart"].timeScale().width()) return; // the price scale is not part of the plot
  placePoint({ point: { x, y } });
}, true);
$("draw-cancel").addEventListener("click", cancelPlacement);
$("draw-finish").addEventListener("click", finishPlacement);
const TOOL_GLYPHS = { trend: "╱", horizontal: "―", long: "⬆", short: "⬇", forecast: "↗", "bars-pattern": "▥", "ghost-feed": "⋰",
  sector: "◔", avwap: "∿", "fixed-vp": "▤", "anchored-vp": "⫣", "price-range": "↕", "date-range": "↔", "date-price-range": "⤡",
  rectangle: "▭", triangle: "△", circle: "○" };
function renderDrawSheet() {
  const query = $("draw-search").value.trim();
  $("draw-categories").replaceChildren(...VeyraChartTools.CATEGORIES.map((category) => {
    const tab = el("button", { type: "button", role: "tab", "aria-selected": String(!query && category.id === drawCategory) }, category.name);
    tab.addEventListener("click", () => { drawCategory = category.id; $("draw-search").value = ""; renderDrawSheet(); });
    return tab;
  }));
  const tools = VeyraChartTools.searchTools(query, drawCategory);
  $("draw-tiles").replaceChildren(...tools.map((t) => {
    const tile = el("button", { type: "button", class: "tile", id: t.id === "trend" ? "chart-trend" : `draw-${t.id}`, "data-tool": t.id,
      "aria-pressed": String(placing?.tool.id === t.id), title: t.help },
      el("span", { class: "glyph", "aria-hidden": "true" }, TOOL_GLYPHS[t.id]), t.name);
    tile.addEventListener("click", () => startPlacement(t.id));
    return tile;
  }));
  if (!tools.length) $("draw-tiles").append(el("p", { class: "sheet-note" }, "No drawing tools match."));
}
$("draw-search").addEventListener("input", renderDrawSheet);
$("open-drawings").addEventListener("click", () => { renderDrawSheet(); openSheet("draw-sheet"); $("draw-search").focus(); });

// ---------------------------------------------------------------- bar replay
function startReplay() {
  closeSheets();
  cancelPlacement();
  if (!marketBars.length) { say("Load a chart before starting a replay.", true); return; }
  replay.picking = true;
  $("replay-bar").hidden = false;
  $("replay-label").textContent = "Bar replay · tap the bar to start from";
}
function startReplayAt(time) {
  replay.picking = false;
  replay.time = time;
  renderMarketChart();
  updateReplayLabel();
}
function stepReplay(delta) {
  if (replay.time == null) return;
  const i = Math.max(0, Math.min(replayTimeline.length - 1, replayTimeline.indexOf(replay.time) + delta));
  replay.time = replayTimeline[i];
  if (i === replayTimeline.length - 1) setReplayPlaying(false);
  renderMarketChart();
  updateReplayLabel();
}
function updateReplayLabel() {
  const i = replayTimeline.indexOf(replay.time);
  $("replay-label").textContent = `Replay · ${isoDay(new Date(replay.time * 1000))} UTC · bar ${i + 1} of ${replayTimeline.length}${i === replayTimeline.length - 1 ? " · end of data" : ""}`;
}
function setReplayPlaying(on) {
  clearInterval(replay.timer);
  replay.timer = on ? setInterval(() => stepReplay(1), 600) : null;
  $("replay-play").setAttribute("aria-pressed", String(on));
  $("replay-play").setAttribute("aria-label", on ? "Pause" : "Play");
  $("replay-play").textContent = on ? "⏸" : "▶";
}
function exitReplay(render = true) {
  const active = replay.time != null || replay.picking;
  setReplayPlaying(false);
  replay.time = null;
  replay.picking = false;
  $("replay-bar").hidden = true;
  if (active && render && marketBars.length) renderMarketChart();
}
$("replay-back").addEventListener("click", () => stepReplay(-1));
$("replay-step").addEventListener("click", () => stepReplay(1));
$("replay-play").addEventListener("click", () => { if (replay.time != null) setReplayPlaying(!replay.timer); });
$("replay-exit").addEventListener("click", () => exitReplay());

// ---------------------------------------------------------------- layouts
function currentLayout() {
  return { name: layoutName, dataset: $("market-dataset").value, interval: marketInterval, range: marketRange,
    chartType: $("chart-type").value, indicators: [...activeIndicators], compare: [...compareIds], settings: { ...chartSettings } };
}
function applyLayout(raw, record = true) {
  const previous = currentLayout(), l = VeyraChartTools.layout(raw, datasetIds());
  if (record) remember(`Open layout “${l.name}”`, () => applyLayout(previous, false));
  layoutName = l.name;
  chartSettings = l.settings;
  activeIndicators.clear();
  l.indicators.forEach((id) => activeIndicators.add(id));
  for (const b of document.querySelectorAll("[data-indicator]")) b.setAttribute("aria-pressed", String(activeIndicators.has(b.dataset.indicator)));
  $("rsi-pane").hidden = !activeIndicators.has("rsi");
  $("macd-pane").hidden = !activeIndicators.has("macd");
  compareIds.splice(0, compareIds.length, ...l.compare.filter((id) => id !== l.dataset));
  $("chart-type").value = chartTypeShown = l.chartType;
  marketRange = l.range;
  marketInterval = l.interval;
  for (const [selector, value] of [["[data-range]", String(l.range)], ["[data-interval]", l.interval]]) {
    for (const b of document.querySelectorAll(selector)) {
      const on = (b.dataset.range ?? b.dataset.interval) === value;
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
    }
  }
  $("open-intervals").firstChild.textContent = `${intervalLabel(l.interval)} `;
  $("hub-layout-name").textContent = layoutName;
  updateHubLabels();
  clearTrends();
  applyChartSettings();
  if ($("market-dataset").value !== l.dataset) { $("market-dataset").value = l.dataset; showMarkets(); }
  else if (marketBars.length) renderMarketChart();
}
function saveLayout(name = layoutName) {
  if (!name || name === "Unnamed") { openPanel("manage"); say("Name this layout to save it."); return; }
  layoutName = name;
  const layout = currentLayout(), saved = chartPrefs.layouts.filter((l) => l.name !== name);
  if (chartStore.write("layouts", [layout, ...saved].slice(0, 50))) say(`Layout “${name}” saved on this device`);
  $("hub-layout-name").textContent = layoutName;
  updateHubLabels();
}

// ---------------------------------------------------------------- analysis hub
const HUB = [
  ["Layout", [["panes", "▦", "Layout setup"], ["manage", "✎", "Manage layout"], ["new", "＋", "New layout"], ["save", "⤓", "Save layout"], ["open", "☰", "Open layout"]]],
  ["Chart", [["indicators", "ƒx", "Indicators"], ["templates", "❏", "Indicator templates"], ["compare", "⇅", "Compare symbols"],
    ["alerts", "⏰", "Alerts"], ["replay", "⏯", "Bar replay"], ["objects", "☷", "Object tree"], ["settings", "⚙", "Chart settings"]]],
  ["Symbol", [["details", "ⓘ", "Symbol details"], ["technicals", "◎", "Technicals"],
    ["financials", "▤", "Financials", "No company financials for crypto"], ["forecast", "↗", "Forecast", "No analyst forecasts in this data"]]],
  ["Trade & code", [["broker", "⇄", "Trade with a broker"], ["strategy", "⚑", "Strategy on chart"], ["editor", "{ }", "Python editor"], ["watchlist", "★", "Watchlist"]]],
];
const hubActions = {
  new: () => { closeSheets(); applyLayout({ name: "Unnamed", dataset: $("market-dataset").value }); },
  save: () => { closeSheets(); saveLayout(); },
  indicators: () => $("chart-indicators").click(),
  replay: startReplay,
  editor: () => { closeSheets(); location.hash = "#code"; },
  watchlist: () => { closeSheets(); selectBrowseTab("watch"); $("browse-assets").click(); },
};
$("hub-sections").replaceChildren(...HUB.flatMap(([title, tiles]) => [el("h3", {}, title), el("div", { class: "tile-grid" }, ...tiles.map(([key, glyph, label, why]) => {
  const tile = el("button", { type: "button", class: "tile", "data-hub": key, ...(key === "strategy" ? { id: "chart-report", "aria-haspopup": "dialog" } : {}) },
    el("span", { class: "glyph", "aria-hidden": "true" }, glyph), el("span", { class: "tile-label" }, label));
  if (why) { tile.disabled = true; tile.append(el("span", { class: "why" }, why)); }
  if (key === "alerts") tile.append(el("span", { class: "dot", hidden: "" }));
  if (key !== "strategy") tile.addEventListener("click", () => (hubActions[key] || (() => openPanel(key)))());
  return tile;
}))]));
function updateHubLabels() {
  document.querySelector('[data-hub="manage"] .tile-label').textContent = `Manage “${layoutName}”`;
}
updateHubLabels();
$("open-hub").addEventListener("click", () => { $("hub-layout-name").textContent = layoutName; openSheet("hub-sheet"); });
$("open-broker").addEventListener("click", () => openPanel("broker", false));

let panelName = null, panelFromHub = true;
function openPanel(name, fromHub = true) {
  panelName = name;
  panelFromHub = fromHub;
  const body = $("panel-body");
  body.replaceChildren();
  $("panel-title").textContent = PANELS[name](body);
  $("panel-back").hidden = !fromHub;
  openSheet("panel-sheet");
}
$("panel-back").addEventListener("click", () => openSheet("hub-sheet"));
const note = (text) => el("p", { class: "sheet-note" }, text);
const action = (label, fn, attrs = {}) => { const b = el("button", { type: "button", ...attrs }, label); b.addEventListener("click", fn); return b; };
const rowItem = (title, sub, ...controls) => el("li", {}, el("div", { class: "grow" }, el("strong", {}, title), sub ? el("span", { class: "sub" }, sub) : ""), ...controls);
const toggleRow = (title, sub, on, fn) => rowItem(title, sub, action(on ? "On" : "Off", fn, { "aria-pressed": String(on) }));
const PANELS = {
  panes(body) {
    body.append(note("Phones show one chart with stacked panes. Multi-chart grids are not available yet."),
      el("ul", { class: "sheet-list" }, ...[["volume", "Volume in the price pane"], ["rsi", "RSI pane"], ["macd", "MACD pane"]].map(([id, label]) =>
        toggleRow(label, indicatorName(id), activeIndicators.has(id), () => { setIndicator(id, !activeIndicators.has(id)); openPanel("panes"); }))));
    return "Layout setup";
  },
  manage(body) {
    const input = el("input", { id: "layout-name", maxlength: "60", value: layoutName === "Unnamed" ? "" : layoutName, placeholder: "Layout name", autocomplete: "off" });
    const saved = chartPrefs.layouts.some((l) => l.name === layoutName);
    body.append(el("label", { for: "layout-name" }, "Name"), el("div", { class: "sheet-row" }, input,
      action("Save", () => { const v = input.value.trim(); if (!v) { say("Enter a layout name.", true); return; } saveLayout(v); openPanel("manage"); }, { class: "primary" })),
      note(`Saves the symbol, timeframe, range, chart type, indicators, compared symbols and settings on this device. Drawings are temporary and not saved.${saved ? " A saved copy exists." : ""}`));
    if (saved) body.append(action("Delete saved copy", () => {
      chartStore.write("layouts", chartPrefs.layouts.filter((l) => l.name !== layoutName)); say("Saved layout deleted"); openPanel("manage");
    }));
    return `Manage “${layoutName}”`;
  },
  open(body) {
    const layouts = chartPrefs.layouts;
    body.append(el("ul", { class: "sheet-list" }, ...layouts.map((l) => {
      const ds = state.datasets.find((d) => d.dataset_id === l.dataset);
      return rowItem(l.name, `${ds ? assetName(ds) : "Unavailable asset"} · ${intervalLabel(l.interval)} · ${l.indicators.length} indicators`,
        action("Open", () => { applyLayout(l); closeSheets(); }),
        action("Delete", () => { chartStore.write("layouts", layouts.filter((x) => x !== l)); openPanel("open"); }, { "aria-label": `Delete ${l.name}` }));
    })));
    if (!layouts.length) body.append(note("No saved layouts on this device yet. Use Save layout."));
    return "Open layout";
  },
  settings(body) {
    const s = chartSettings;
    body.append(el("ul", { class: "sheet-list" },
      toggleRow("Grid lines", "", s.grid, () => setSetting("grid", !s.grid)),
      toggleRow("Current price line", "Horizontal line at the latest close", s.priceLine, () => setSetting("priceLine", !s.priceLine)),
      toggleRow("Symbol on price scale", "Shows the symbol beside the price label", s.symbolLabel, () => setSetting("symbolLabel", !s.symbolLabel)),
      toggleRow("Crosshair", "Shows OHLC values under your finger", s.crosshair, () => setSetting("crosshair", !s.crosshair)),
      toggleRow("Log scale", "", s.log, () => setSetting("log", !s.log)),
      rowItem("Candle colors", s.colors === "classic" ? "Green up, red down" : "Ink up, orange down",
        action("Classic", () => setSetting("colors", "classic"), { "aria-pressed": String(s.colors === "classic") }),
        action("Mono", () => setSetting("colors", "mono"), { "aria-pressed": String(s.colors === "mono") }))),
      note("Times are shown in UTC. Settings are saved with a layout."));
    return "Chart settings";
  },
  templates(body) {
    const input = el("input", { id: "template-name", maxlength: "60", placeholder: "Template name", autocomplete: "off" });
    const templates = chartPrefs.templates;
    body.append(el("label", { for: "template-name" }, "Save current indicators as a template"), el("div", { class: "sheet-row" }, input,
      action("Save", () => {
        const name = input.value.trim();
        if (!name) { say("Enter a template name.", true); return; }
        if (chartStore.write("templates", [{ name, indicators: [...activeIndicators] }, ...templates.filter((t) => t.name !== name)].slice(0, 50))) say(`Template “${name}” saved`);
        openPanel("templates");
      }, { class: "primary" })),
      el("ul", { class: "sheet-list" }, ...templates.map((t) => rowItem(t.name, t.indicators.map(indicatorName).join(", ") || "No indicators",
        action("Apply", () => applyTemplate(t)),
        action("Delete", () => { chartStore.write("templates", templates.filter((x) => x !== t)); openPanel("templates"); }, { "aria-label": `Delete ${t.name}` })))));
    if (!templates.length) body.append(note("No templates yet."));
    return "Indicator templates";
  },
  compare(body) {
    const current = $("market-dataset").value;
    body.append(note("Compared symbols are rebased onto this chart’s first visible close, so both read on one price scale. Up to 3."),
      el("ul", { class: "sheet-list" }, ...state.datasets.filter((d) => d.dataset_id !== current).map((d) => {
        const on = compareIds.includes(d.dataset_id);
        return rowItem(assetName(d), d.provider, action(on ? "Remove" : "Add", () => setCompare(d.dataset_id, !on), { "aria-pressed": String(on) }));
      })));
    if (state.datasets.length < 2) body.append(note("Only one asset is available."));
    return "Compare symbols";
  },
  alerts(body) {
    setUnseenAlerts(false);
    const ds = currentDataset(), last = marketBars.at(-1);
    const input = el("input", { id: "alert-level", inputmode: "decimal", value: last ? String(Number(last.close)) : "", autocomplete: "off" });
    body.append(el("label", { for: "alert-level" }, `Alert when ${ds ? assetName(ds) : "price"} crosses`), el("div", { class: "sheet-row" }, input,
      action("Add alert", () => addAlert(Number(input.value)), { class: "primary" })),
      note("Alerts check this historical data and mark past crossings on the chart. Live notifications need a live data feed, which Veyra does not have yet."));
    const alerts = chartPrefs.alerts;
    body.append(el("ul", { class: "sheet-list" }, ...alerts.map((a) => {
      const asset = state.datasets.find((d) => d.dataset_id === a.dataset);
      const hits = a.dataset === ds?.dataset_id ? VeyraChartTools.crossings(visibleStudyBars, a.level).length : null;
      return rowItem(`${assetName(asset)} crosses ${marketNumber(a.level)}`, hits == null ? "Open this asset to check crossings" : `${hits} crossing${hits === 1 ? "" : "s"} in the visible range`,
        action("Remove", () => removeAlert(a), { "aria-label": `Remove alert at ${a.level}` }));
    })));
    if (!alerts.length) body.append(note("No alerts yet."));
    return "Alerts";
  },
  objects(body) {
    const list = el("ul", { class: "sheet-list" });
    for (const d of drawings) list.append(rowItem(d.name, d.label, action(d.hidden ? "Show" : "Hide", () => { d.hidden = !d.hidden; drawingLayer?.set(drawingShapes()); d.line?.applyOptions({ visible: !d.hidden }); openPanel("objects"); }),
      action("Remove", () => { removeDrawing(d); openPanel("objects"); }, { "aria-label": `Remove ${d.name}` })));
    for (const id of activeIndicators) list.append(rowItem(indicatorName(id), "Indicator", action("Remove", () => { setIndicator(id, false); openPanel("objects"); })));
    for (const id of compareIds) list.append(rowItem(assetName(state.datasets.find((d) => d.dataset_id === id)), "Compared symbol", action("Remove", () => { setCompare(id, false); openPanel("objects"); })));
    for (const a of chartPrefs.alerts.filter((x) => x.dataset === $("market-dataset").value)) list.append(rowItem(`Alert at ${marketNumber(a.level)}`, "Alert", action("Remove", () => { removeAlert(a); openPanel("objects"); })));
    if (selectedOverlay) list.append(rowItem("Strategy fills", `Run ${selectedOverlay.run_id}`, action("Clear", () => { $("clear-overlay").click(); openPanel("objects"); })));
    body.append(list);
    if (!list.children.length) body.append(note("Nothing on the chart yet."));
    if (drawings.length) body.append(action("Remove all drawings", () => {
      const removed = [...drawings];
      clearTrends();
      remember("Remove all drawings", () => removed.forEach(addDrawing), "drawing");
      openPanel("objects");
    }, { id: "chart-clear" }));
    return "Object tree";
  },
  details(body) {
    const d = currentDataset();
    if (!d) { body.append(note("No asset selected.")); return "Symbol details"; }
    body.append(el("dl", { class: "details" }, ...[["Symbol", assetName(d)], ["Instrument", d.instrument_id], ["Quote currency", d.quote_currency],
      ["Source", d.provider], ["Resolution", d.resolution], ["Price basis", d.price_basis], ["Coverage", `${d.coverage_start.slice(0, 10)} – ${d.coverage_end.slice(0, 10)} UTC`],
      ["Bars", String(d.bars)], ["Quality findings", String(d.quality_findings)], ["Allowed uses", (d.allowed_uses || []).join(", ")],
      ["License", d.license], ["Data fingerprint", d.manifest_hash]].flatMap(([k, v]) => [el("dt", { class: "sub" }, k), el("dd", {}, v)])));
    return "Symbol details";
  },
  technicals(body) {
    const rows = VeyraChartTools.technicals(studyBars, studyBars.map((b) => rsiByTime.get(b.time) ?? null));
    const last = studyBars.at(-1);
    body.append(note(`Readings at ${intervalLabel(marketInterval)} candles${last ? ` as of ${isoDay(new Date(last.time * 1000))} UTC` : ""}. Facts about the data, not a rating or advice.`),
      el("table", { class: "readings" }, el("thead", {}, el("tr", {}, el("th", {}, "Measure"), el("th", {}, "Value"), el("th", {}, "Reading"))),
        el("tbody", {}, ...rows.map((r) => el("tr", {}, el("td", {}, r.name), el("td", {}, r.value), el("td", {}, r.reading))))));
    if (!rows.length) body.append(note("Load a chart first."));
    return "Technicals";
  },
  broker(body) {
    body.append(note("Veyra does not place orders yet. Connected brokers and exchanges arrive after hosted paper trading, with withdrawal-free keys, explicit approval for every live deployment, and your funds kept at your own broker."),
      el("ul", { class: "sheet-list" }, rowItem("Connected brokers", "None available yet")),
      action("Test a strategy instead", () => { closeSheets(); location.hash = "#code"; }, { class: "primary" }));
    return "Trade with a broker";
  },
};
function applyTemplate(t) {
  const previous = [...activeIndicators];
  for (const i of VeyraChartTools.INDICATORS) setIndicator(i.id, t.indicators.includes(i.id), false);
  remember(`Apply template “${t.name}”`, () => { for (const i of VeyraChartTools.INDICATORS) setIndicator(i.id, previous.includes(i.id), false); });
  say(`Template “${t.name}” applied`);
}
function setCompare(id, on, record = true) {
  if (compareIds.includes(id) === on) return;
  if (on && compareIds.length >= 3) { say("Compare up to 3 symbols.", true); return; }
  if (on) compareIds.push(id); else compareIds.splice(compareIds.indexOf(id), 1);
  if (record) remember(`${on ? "Compare" : "Stop comparing"} ${assetName(state.datasets.find((d) => d.dataset_id === id))}`, () => setCompare(id, !on, false));
  if (marketBars.length) renderMarketChart();
  if ($("panel-sheet").open && panelName === "compare") openPanel("compare", panelFromHub);
}
function addAlert(level) {
  const ds = currentDataset();
  if (!ds || !Number.isFinite(level) || level <= 0) { say("Enter a price above zero.", true); return; }
  const alert = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, dataset: ds.dataset_id, level };
  if (!chartStore.write("alerts", [...chartPrefs.alerts, alert].slice(-50))) return;
  remember(`Add alert at ${marketNumber(level)}`, () => removeAlert(alert, false));
  if (marketBars.length) renderMarketChart();
  if (VeyraChartTools.crossings(visibleStudyBars, level).length && !$("panel-sheet").open) setUnseenAlerts(true);
  if ($("panel-sheet").open && panelName === "alerts") openPanel("alerts", panelFromHub);
}
function removeAlert(alert, record = true) {
  chartStore.write("alerts", chartPrefs.alerts.filter((a) => a.id !== alert.id));
  if (record) remember(`Remove alert at ${marketNumber(alert.level)}`, () => {
    chartStore.write("alerts", [...chartPrefs.alerts, alert]);
    if (marketBars.length) renderMarketChart();
  });
  if (marketBars.length) renderMarketChart();
  if ($("panel-sheet").open && panelName === "alerts") openPanel("alerts", panelFromHub);
}

// ---------------------------------------------------------------- symbols and watchlist
function selectBrowseTab(tab) {
  $("browse-tab-all").setAttribute("aria-selected", String(tab === "all"));
  $("browse-tab-watch").setAttribute("aria-selected", String(tab === "watch"));
  if ($("asset-browser").open) renderAssetBrowser();
}
$("browse-tab-all").addEventListener("click", () => selectBrowseTab("all"));
$("browse-tab-watch").addEventListener("click", () => selectBrowseTab("watch"));
function toggleWatch(id) {
  const list = chartPrefs.watchlist;
  chartStore.write("watchlist", list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  renderAssetBrowser();
}

// ---------------------------------------------------------------- indicators, metrics and strategies browser
let indicatorPage = "home", favoritesFilter = "all", communityRequest = 0, myScripts = null;
const INDICATOR_PAGES = { home: "Indicators, metrics & strategies", favorites: "Favorites", mine: "My scripts",
  picks: "Editors’ picks", top: "Top community scripts", trending: "Trending community scripts" };
const isFavorite = (kind, source, id) => chartPrefs.favorites.some((f) => f.kind === kind && f.source === source && f.id === id);
function toggleFavorite(item) {
  const list = chartPrefs.favorites, on = list.some((f) => f.kind === item.kind && f.source === item.source && f.id === item.id);
  chartStore.write("favorites", on ? list.filter((f) => !(f.kind === item.kind && f.source === item.source && f.id === item.id)) : [...list, item]);
  renderIndicatorBody();
}
const starButton = (item) => action("★", () => toggleFavorite(item), { class: "star", "aria-pressed": String(isFavorite(item.kind, item.source, item.id)), "aria-label": `Favorite ${item.name}` });
const typeIcon = (kind) => el("span", { class: "type-icon", "aria-hidden": "true", title: kind }, kind === "indicator" ? "ƒ" : "S");
function indicatorRow(i) {
  const on = activeIndicators.has(i.id);
  const toggle = el("button", { type: "button", class: "toggle", "data-indicator": i.id, "aria-pressed": String(on), ...(indicatorButtonId[i.id] ? { id: indicatorButtonId[i.id] } : { id: `chart-ind-${i.id}` }) },
    el("strong", {}, i.name), el("span", { class: "sub" }, `${i.about} · Veyra built-in`));
  toggle.addEventListener("click", () => setIndicator(i.id, !activeIndicators.has(i.id)));
  return el("li", {}, typeIcon("indicator"), toggle, starButton({ kind: "indicator", source: "builtin", id: i.id, name: i.name }));
}
function strategyRow(s) {
  const href = s.source === "community" ? `#public/${encodeURIComponent(s.id)}` : `#project/${encodeURIComponent(s.id)}`;
  const author = s.source === "community" ? "Published strategy · publisher not shown" : `You · ${s.store} strategy`;
  return el("li", {}, typeIcon("strategy"), el("div", { class: "grow" }, el("strong", {}, s.name), el("a", { class: "sub", href }, author)),
    el("a", { class: "doc", href, "aria-label": `Open ${s.name}` }, "▤"), starButton({ kind: "strategy", source: s.source, id: s.id, name: s.name }));
}
async function loadMyScripts() {
  if (myScripts) return myScripts;
  const rows = [];
  try { rows.push(...localWorkspace.listProjects().projects.map((p) => ({ id: p.id, name: p.name, source: "mine", store: "device" }))); } catch { /* storage blocked */ }
  if (state.org) {
    try {
      // shortcut: first page (100) of cloud strategies; page further when libraries grow past it.
      const result = await api(`/v1/orgs/${state.org}/projects`);
      rows.push(...(result.projects || []).map((p) => ({ id: p.id, name: p.name, source: "mine", store: "cloud" })));
    } catch { /* offline or signed out: device strategies still list */ }
  }
  return (myScripts = rows);
}
async function loadCommunity(query = "") {
  const request = ++communityRequest;
  const result = await api(`/v1/public/strategies?${new URLSearchParams({ limit: "20", q: query })}`, { anonymous: true });
  if (request !== communityRequest) return null;
  return (result.strategies || []).map((s) => ({ id: s.id, name: s.title, source: "community" }));
}
function showIndicators(page) {
  indicatorPage = page;
  $("indicator-back").hidden = page === "home";
  $("indicator-title").textContent = INDICATOR_PAGES[page];
  $("indicator-search").value = "";
  $("indicator-search").placeholder = page === "favorites" ? "Search favorites…" : page === "home" ? "Search indicators, metrics, strategies…" : "Search…";
  if (page === "mine") myScripts = null;
  if (page === "favorites") favoritesFilter = "all";
  renderIndicatorBody();
}
$("indicator-back").addEventListener("click", () => showIndicators("home"));
$("indicator-search").addEventListener("input", () => renderIndicatorBody());
const navRow = (label, sub, page) => el("li", {}, action(el("span", {}, el("strong", {}, label), el("span", { class: "sub" }, sub)), () => showIndicators(page), { class: "toggle" }), el("span", { "aria-hidden": "true" }, "›"));
async function renderIndicatorBody() {
  const body = $("indicator-body"), query = $("indicator-search").value.trim().toLowerCase(), page = indicatorPage;
  const matches = (name) => !query || name.toLowerCase().includes(query);
  const builtins = VeyraChartTools.INDICATORS.filter((i) => matches(`${i.name} ${i.about}`));
  if (page === "home") {
    body.replaceChildren(
      ...(query ? [] : [el("ul", { class: "sheet-list" }, navRow("★ Favorites", `${chartPrefs.favorites.length} saved`, "favorites"), navRow("My scripts", "Your private strategies", "mine"))]),
      el("h3", {}, "Technicals · built-in"), el("ul", { class: "sheet-list" }, ...builtins.map(indicatorRow)),
      el("h3", {}, "Fundamentals · built-in"), note("Not available: crypto assets have no company fundamentals, and this data source provides none."),
      el("h3", {}, "Community scripts"),
      ...(query ? [el("ul", { class: "sheet-list", id: "community-results" }, el("li", { class: "sheet-note" }, "Searching…"))]
        : [el("ul", { class: "sheet-list" }, navRow("Editors’ picks", "Selected by Veyra", "picks"), navRow("Top", "Most used", "top"), navRow("Trending", "Recently published", "trending"))]));
    if (!builtins.length && query) body.querySelector(".sheet-list")?.append(el("li", { class: "sheet-note" }, "No built-in matches."));
    if (query) {
      const [mine, community] = await Promise.all([loadMyScripts(), loadCommunity(query).catch(() => [])]);
      if (community === null || $("indicator-search").value.trim().toLowerCase() !== query || indicatorPage !== page) return;
      const list = $("community-results");
      const found = [...mine.filter((s) => matches(s.name)), ...community];
      list?.replaceChildren(...found.map(strategyRow));
      if (list && !found.length) list.append(el("li", { class: "sheet-note" }, "No strategies match."));
    }
  } else if (page === "favorites") {
    const chips = el("div", { class: "sheet-tabs", role: "group", "aria-label": "Filter favorites" }, ...[["all", "All"], ["indicator", "Indicators"], ["strategy", "Strategies"]].map(([k, label]) =>
      action(label, () => { favoritesFilter = k; renderIndicatorBody(); }, { "aria-pressed": String(favoritesFilter === k) })));
    const favorites = chartPrefs.favorites.filter((f) => (favoritesFilter === "all" || f.kind === favoritesFilter) && matches(f.name));
    body.replaceChildren(chips, el("ul", { class: "sheet-list" }, ...favorites.map((f) => {
      if (f.kind === "indicator") {
        const i = VeyraChartTools.INDICATORS.find((x) => x.id === f.id);
        return el("li", {}, starButton(f), typeIcon("indicator"), el("div", { class: "grow" }, el("strong", {}, i.name), el("span", { class: "sub" }, "Veyra built-in")),
          action(activeIndicators.has(f.id) ? "On chart" : "Add", () => { setIndicator(f.id, !activeIndicators.has(f.id)); renderIndicatorBody(); }, { "aria-pressed": String(activeIndicators.has(f.id)) }));
      }
      const row = strategyRow({ ...f, store: "saved" });
      row.prepend(starButton(f));
      row.querySelector(".star:last-child")?.remove();
      if (f.source === "mine") row.append(action("🗑", () => toggleFavorite(f), { "aria-label": `Remove ${f.name} from favorites` }));
      return row;
    })));
    if (!favorites.length) body.append(note(chartPrefs.favorites.length ? "No favorites match." : "Star indicators and strategies to collect them here."));
  } else if (page === "mine") {
    body.replaceChildren(note("Loading your strategies…"));
    const mine = await loadMyScripts();
    if (indicatorPage !== "mine") return;
    body.replaceChildren(note("Strategies are Python projects. Open one to edit or backtest it; show a backtest’s fills with Strategy on chart."),
      el("ul", { class: "sheet-list" }, ...mine.filter((s) => matches(s.name)).map(strategyRow)));
    if (!mine.length) body.append(note("No strategies yet."), el("a", { class: "button", href: "#code" }, "Create a strategy"));
  } else if (page === "picks" || page === "top") {
    body.replaceChildren(note(page === "picks" ? "No editors’ picks yet. Veyra has not started an editorial program." : "Not ranked yet. Rankings need usage data that Veyra does not collect yet."),
      action("See trending", () => showIndicators("trending")));
  } else {
    body.replaceChildren(note("Loading published strategies…"));
    try {
      const community = await loadCommunity(query);
      if (community === null || indicatorPage !== page) return;
      body.replaceChildren(note("Newest published strategies first. Trending by use needs usage data that Veyra does not collect yet."),
        el("ul", { class: "sheet-list" }, ...community.map(strategyRow)));
      if (!community.length) body.append(note("No published strategies yet."));
    } catch (e) { if (indicatorPage === page) body.replaceChildren(note(`Community scripts unavailable. ${e.message}`)); }
  }
}

renderIndicatorBody(); // stable toggle ids exist before the sheet first opens

// ---------------------------------------------------------------- projects & editor
const localWorkspace = VeyraWorkspaceStore.create(browserStorage);
let projectRows = [], projectLoad = 0, fileName = null, assistantProposal = null, assistantUndo = null;
let projectListLoad = 0, projectListPhase = "loading", projectListError = "";
let projectStore = null, projectCreation = null;
let editorTabExit = false, editorPointer = null;
function selectProjectStore(store) {
  store = state.org ? store || "cloud" : "device";
  if (store !== projectStore) {
    $("project-search").value = "";
    $("project-folder").value = "";
  }
  projectStore = store;
  $("project-store").querySelector('[value="cloud"]').disabled = !state.org;
  $("project-store").value = store;
  $("create-project").textContent = store === "cloud" ? "Create in cloud" : "Create on device";
  $("project-library-link").href = `#code/${store}`;
  $("project-library-link").textContent = `← All ${store} strategies`;
  document.querySelector('.tabs a[data-tab="code"]').href = `#code/${store}`;
}
$("project-store").addEventListener("change", () => {
  const store = $("project-store").value;
  if ($("view-code").hidden || (store !== "cloud" && store !== "device") || (store === "cloud" && !state.org)) {
    $("project-store").value = projectStore;
    return;
  }
  // Invalidate even a same-turn switch away and back before hashchange is delivered.
  if (location.hash !== `#code/${store}`) routeGeneration++;
  location.hash = `#code/${store}`;
});
const isLocalProject = (id) => String(id).startsWith("local-");
// Only responses already in flight may use the editor retained pending a discard decision.
function editorRouteHash(response = false) {
  if (response && activeRoute?.user === state.user && activeRoute?.org === state.org && unpersistedEditorDraft() &&
      activeRoute.hash === `#project/${state.project.id}` && !$("view-project").hidden) return activeRoute.hash;
  return location.hash;
}
const currentProjectRoute = (id, response = false) => editorRouteHash(response) === `#project/${id}`;
async function localWrite(operation) {
  if (!navigator.locks?.request) throw new Error("This browser cannot safely coordinate saved strategies across tabs. Use a current browser with Web Locks, or download your code as a backup.");
  return navigator.locks.request("veyra.workspace.v1", { mode: "exclusive" }, operation);
}
const blankStrategy = VeyraStudioAssistant.templates.blank;

async function projectRequest(id, action, body, current = () => true) {
  if (isLocalProject(id)) {
    if (action === "get") return localWorkspace.getProject(id);
    if (action === "version") return localWorkspace.getVersion(id, body);
    if (action === "save") return localWrite(() => localWorkspace.saveVersion(id, body));
    if (action === "settings") return localWrite(() => current() ? localWorkspace.updateProject(id, body) : null);
    if (action === "duplicate") return localWrite(() => localWorkspace.duplicateProject(id, body));
  }
  if (action === "get") return api(`/v1/projects/${id}`);
  if (action === "version") return api(`/v1/projects/${id}/versions/${body}`);
  if (action === "save") return api(`/v1/projects/${id}/versions`, { method: "POST", body });
  if (action === "settings") return api(`/v1/projects/${id}`, { method: "PATCH", body });
  if (action === "duplicate") return api(`/v1/projects/${id}/duplicate`, { method: "POST", body });
  throw new Error("Unknown strategy action");
}

async function showProjects() {
  const request = ++projectListLoad, visit = routeGeneration, origin = location.hash, org = state.org, user = state.user, store = projectStore;
  const current = () => request === projectListLoad && visit === routeGeneration && store === projectStore &&
    origin === location.hash && org === state.org && user === state.user && !$("view-code").hidden;
  $("workspace-mode").textContent = store === "cloud"
    ? "Private cloud workspace. Code snapshots are versioned; backtests use your approved spending ceiling. Device strategies stay separate. Import snapshot always creates a private device copy."
    : "Private device workspace. Strategies stay in this browser with no cloud backup, even with an account connected. Download a complete strategy snapshot as a backup. Device strategies cannot run server backtests or publish public links. Open History to review copying a saved version into a connected private cloud workspace.";
  projectRows = [];
  projectListPhase = "loading";
  projectListError = "";
  $("refresh-projects").disabled = true;
  renderProjects();
  try {
    if (store === "device") {
      projectRows = localWorkspace.listProjects().projects;
    } else {
      const loaded = new Map(), cursors = new Set();
      let cursor = null;
      do {
        const result = await api(`/v1/orgs/${org}/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
        if (!current()) return;
        if (!Array.isArray(result.projects) || result.projects.length > 100 ||
            result.projects.some((p) => !p || typeof p.id !== "string" || !p.id || typeof p.name !== "string") ||
            typeof result.has_more !== "boolean" ||
            (result.has_more ? !result.projects.length || typeof result.next_cursor !== "string" ||
              !result.next_cursor || result.next_cursor.length > 512 || cursors.has(result.next_cursor)
              : result.next_cursor !== null)) {
          throw new Error("The server returned an incomplete strategy page.");
        }
        const before = loaded.size;
        for (const p of result.projects) if (!loaded.has(p.id)) loaded.set(p.id, p);
        if (result.has_more && loaded.size === before) throw new Error("The server repeated a strategy page.");
        projectRows = [...loaded.values()];
        cursor = result.next_cursor;
        if (cursor) cursors.add(cursor);
        renderProjects();
      } while (cursor);
    }
    projectListPhase = "ready";
    renderProjects();
  } catch (e) {
    if (!current()) return;
    projectListPhase = "error";
    projectListError = e.message || String(e);
    renderProjects();
  } finally {
    if (current()) $("refresh-projects").disabled = false;
  }
}

function renderProjects() {
  const selected = $("project-folder").value;
  const folders = [...new Set(projectRows.map((p) => p.folder).filter(Boolean))].sort();
  // Keep a chosen folder while later pages may still contain it.
  if (projectListPhase !== "ready" && selected && selected !== "__none" && !folders.includes(selected)) folders.push(selected);
  $("project-folder").replaceChildren(el("option", { value: "" }, "All folders"),
    el("option", { value: "__none" }, "No folder"), ...folders.map((f) => el("option", { value: f }, f)));
  $("project-folder").value = folders.includes(selected) || selected === "__none" ? selected : "";
  const query = $("project-search").value.trim().toLocaleLowerCase(), folder = $("project-folder").value;
  const rows = projectRows.filter((p) => (!query || `${p.name} ${p.description || ""}`.toLocaleLowerCase().includes(query)) &&
    (!folder || (folder === "__none" ? !p.folder : p.folder === folder)));
  $("project-list").setAttribute("aria-busy", String(projectListPhase === "loading"));
  $("project-list").replaceChildren(...rows.map((p) => el("li", {},
    el("a", { href: `#project/${p.id}` }, p.name,
      el("span", { class: "sub" }, `${p.folder || "No folder"} · private · v${p.latest_version_no}`),
      el("span", { class: "sub" }, `Updated ${when(p.updated_at || p.created_at)}`)))));
  const scope = `${projectRows.length} strategies loaded · ${rows.length} shown. Search and folders cover loaded strategies.`;
  $("projects-scope").textContent = projectListPhase === "loading"
    ? `${scope} Loading more…`
    : projectListPhase === "error" ? `${scope} Loading failed; this list may be incomplete. Refresh to retry. ${projectListError}`
    : `${scope} ${projectStore === "cloud" ? "All pages loaded. Changes made during loading may require Refresh." : "All strategies on this device loaded."}`;
  if (!rows.length) $("project-list").append(el("li", { class: "muted" },
    projectListPhase === "loading" ? "No matches loaded yet. Loading strategies…" :
    projectListPhase === "error" ? "No matches in the loaded strategies. Refresh to retry the full library." :
    projectRows.length ? "No matching strategies." : "Create your first Python strategy."));
}
for (const id of ["project-search", "project-folder"]) $(id).addEventListener("input", renderProjects);
$("refresh-projects").addEventListener("click", () => {
  if (!$("refresh-projects").disabled && !$("view-code").hidden && $("project-store").value === projectStore) showProjects();
});

$("new-project-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (projectCreation || $("view-code").hidden || $("strategy-import-dialog").open || $("project-store").value !== projectStore ||
      (projectStore === "cloud" && !state.org)) return;
  const request = projectCreation = {}, generation = routeGeneration, origin = location.hash;
  const store = projectStore, org = state.org, user = state.user;
  const current = () => projectCreation === request && generation === routeGeneration && origin === location.hash &&
    store === projectStore && org === state.org && user === state.user && !$("view-code").hidden;
  const body = { name: $("new-project-name").value.trim(), files: { "strategy.py": blankStrategy }, entrypoint: "strategy.py", template: null };
  $("create-project").disabled = true;
  $("new-project-status").textContent = store === "cloud"
    ? "Creating in cloud… Leaving does not cancel an already-sent request. Refresh Cloud workspace to check its outcome."
    : "Waiting to create a private device strategy…";
  try {
    const p = store === "cloud" ? await api(`/v1/orgs/${org}/projects`, { method: "POST", body })
      : await localWrite(() => current() ? localWorkspace.createProject(body) : null);
    if (!current()) return;
    if (!p || typeof p.id !== "string" || !p.id || isLocalProject(p.id) !== (store === "device")) {
      throw new Error("Creation could not be confirmed. Refresh this library before trying again.");
    }
    $("new-project-name").value = "";
    location.hash = `#project/${p.id}`;
  } catch (error) {
    if (current()) { $("new-project-status").textContent = error.message; fail(error); }
  } finally {
    if (current()) { projectCreation = null; $("create-project").disabled = false; }
  }
});

const draftKey = (id) => `veyra.draft.${id}.${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
const draftTime = (value) => Number.isSafeInteger(value?.saved_at) && value.saved_at >= 0 ? value.saved_at : 0;
function readDeviceDrafts(id) {
  const prefix = `veyra.draft.${id}`;
  const drafts = [];
  try {
    for (let i = 0; i < browserStorage.length; i++) {
      const key = browserStorage.key(i);
      if (typeof key !== "string" || (key !== prefix && !key.startsWith(`${prefix}.`))) continue;
      const content = browserStorage.getItem(key);
      let value;
      try { value = JSON.parse(content); } catch { value = { legacy: content }; }
      drafts.push({ key, content, value });
    }
  } catch { throw new Error("Device drafts could not be read. Editing is unavailable until browser storage can be read. Existing drafts were left unchanged."); }
  return drafts.sort((a, b) => draftTime(b.value) - draftTime(a.value));
}
const snapshotSignature = (snapshot) => JSON.stringify({ entrypoint: snapshot.entrypoint,
  files: Object.keys(snapshot.files).sort().map((path) => [path, snapshot.files[path]]) });
const projectDirty = (p) => snapshotSignature(p) !== snapshotSignature({ files: p.savedFiles, entrypoint: p.version.entrypoint });
function recoveredSnapshot(value, version) {
  if (!value || value.base_version !== version.version_no) return null;
  try {
    if (value.schema_version === 2) {
      if (value.base_version_id !== version.id || typeof value.entrypoint !== "string") return null;
      return VeyraWorkspaceStore.validateSnapshot(value);
    }
    // Legacy drafts were file patches, not complete snapshots. Keep their original keys for recovery.
    if (value.schema_version !== undefined || !value.files || typeof value.files !== "object" || Array.isArray(value.files) ||
        Object.keys(value.files).some((path) => !Object.hasOwn(version.files, path))) return null;
    return VeyraWorkspaceStore.validateSnapshot({ files: { ...version.files, ...value.files }, entrypoint: version.entrypoint });
  } catch { return null; }
}
function persistDraft() {
  if (!state.project) return;
  try {
    const p = state.project;
    // A clean marker prevents older retained drafts from reappearing after an explicit reversion.
    if (!projectDirty(p) && p.recoveredBase !== p.version.id) browserStorage.removeItem(p.draftKey);
    else {
      p.draftTimestamp = Math.max(Date.now(), p.draftTimestamp + 1);
      if (!Number.isSafeInteger(p.draftTimestamp)) throw new Error("Draft ordering is unavailable");
      browserStorage.setItem(p.draftKey, JSON.stringify({ schema_version: 2, base_version: p.version.version_no,
        base_version_id: p.version.id, saved_at: p.draftTimestamp, files: p.files, entrypoint: p.entrypoint }));
    }
    p.draftStored = true;
    p.draftIssue = null;
    try { VeyraWorkspaceStore.validateSnapshot(p); }
    catch (error) { p.draftIssue = error.message; }
  } catch { state.project.draftStored = false; }
}

async function showProject(id) {
  const request = ++projectLoad;
  if ($("strategy-settings-dialog").open) closeStrategySettings();
  state.project = null;
  invalidateQuote();
  $("editor").disabled = true;
  for (const b of document.querySelectorAll("[data-key]")) b.disabled = true;
  for (const id of ["editor-file", "editor-entrypoint", "add-file", "rename-file", "remove-file"]) $(id).disabled = true;
  $("save-version").disabled = true;
  $("download-snapshot").disabled = true;
  $("project-history").disabled = true;
  $("project-title").textContent = "Loading strategy…";
  $("share-project").disabled = true;
  try {
    const p = await projectRequest(id, "get"), latest = p.versions[0];
    if (request !== projectLoad || !currentProjectRoute(id)) return;
    const v = await projectRequest(id, "version", latest.version_no);
    if (request !== projectLoad || !currentProjectRoute(id)) return;
    if (p.id !== id || v.id !== latest.id || v.version_no !== latest.version_no || typeof v.entrypoint !== "string" ||
        (latest.entrypoint !== undefined && v.entrypoint !== latest.entrypoint) || (v.project_id !== undefined && v.project_id !== id)) {
      throw new Error("Saved source identity changed. Reopen the strategy to try again.");
    }
    const saved = VeyraWorkspaceStore.validateSnapshot(v);
    let content = saved, draftNotice = "";
    const drafts = readDeviceDrafts(id);
    // Each opening gets a fresh key; rejected or conflicting drafts from this tab also stay recoverable.
    const matching = drafts.find(({ value }) => recoveredSnapshot(value, v));
    if (matching) content = recoveredSnapshot(matching.value, v);
    if (drafts.length) draftNotice = matching ? "Restored a device draft. Other drafts are retained for recovery." : "Older, invalid or unsupported device drafts were not applied. Download recovered drafts to keep their exact contents.";
    const recoveryDraft = drafts.length ? JSON.stringify({ project_id: id, drafts: drafts.map(({ content }) => content) }, null, 2) : null;
    state.project = { ...p, id, version: v, ...content, files: { ...content.files }, savedFiles: saved.files,
      revision: 0, draftKey: draftKey(id), recoveredBase: matching ? v.id : null,
      draftTimestamp: drafts.reduce((time, { value }) => Math.max(time, draftTime(value)), 0), draftStored: true, recoveryDraft };
    fileName = content.entrypoint;
    $("project-title").textContent = p.name;
    $("share-project").disabled = false;
    $("project-storage").textContent = isLocalProject(id) ? "Private · device-local · this browser only · no cloud backup" : `Private · database workspace · ${p.folder || "No folder"}`;
    renderEditorFiles();
    $("recover-draft").hidden = !recoveryDraft;
    $("editor").disabled = false;
    for (const b of document.querySelectorAll("[data-key]")) b.disabled = false;
    $("save-version").disabled = false;
    $("download-snapshot").disabled = false;
    $("project-history").disabled = false;
    markDraft();
    resetAssistant();
    if (draftNotice) say(draftNotice, true);
    const local = isLocalProject(id);
    $("backtest-availability").hidden = !local;
    $("backtest-availability").textContent = "This is a device-local strategy. Server backtests need authenticated database storage and an isolated Python runtime. No compute is running and no charges are incurred here.";
    for (const control of $("quote-form").querySelectorAll("input, select, button")) control.disabled = local;
    $("strategy-runs-link").hidden = local;
    $("strategy-runs-link").href = `#runs/${id}`;
    const ds = state.datasets.find((d) => d.dataset_id === $("bt-dataset").value);
    if (ds && !$("bt-end").value) {
      $("bt-end").value = ds.coverage_end.slice(0, 10);
      $("bt-start").value = isoDay(new Date(Date.parse(ds.coverage_end) - 3 * 365 * 864e5));
    }
  } catch (e) {
    if (request === projectLoad && currentProjectRoute(id)) { $("project-title").textContent = "Strategy unavailable"; fail(e); }
  }
}

function markDraft() {
  window.removeEventListener("beforeunload", warnEditorUnload);
  if (unpersistedEditorDraft()) window.addEventListener("beforeunload", warnEditorUnload);
  if (!state.project) return;
  const dirty = projectDirty(state.project);
  $("project-version").textContent = `saved v${state.project.version.version_no}`;
  $("draft-state").textContent = !dirty ? (!state.project.draftStored
    ? "Saved source selected · draft reset not stored; a retained draft may return on reopen" : "Saved") : !state.project.draftStored
    ? "Unsaved edits · browser storage unavailable, download a backup"
    : state.project.draftIssue ? `Unsaved edits · recovery-only draft kept: ${state.project.draftIssue}. Fix this before reloading; this draft cannot restore automatically.`
      : "Unsaved edits · device draft kept";
}

function invalidateQuote() {
  $("approve").disabled = true;
  state.quote = null;
  state.quoteRevision = (state.quoteRevision || 0) + 1;
  state.quoteSignature = null;
  $("quote-box").hidden = true;
}
function renderEditorFiles() {
  const p = state.project;
  if (!p) return;
  editorTabExit = false;
  if (editorPointer) editorPointer.cancelled = true;
  for (const id of ["editor-file", "editor-entrypoint"]) {
    $(id).replaceChildren(...Object.keys(p.files).map((path) => el("option", { value: path }, path)));
    $(id).disabled = false;
  }
  $("editor-file").value = fileName;
  $("editor-entrypoint").value = p.entrypoint;
  $("editor").value = p.files[fileName];
  $("editor-label").textContent = `Python source: ${fileName}`;
  $("add-file").disabled = Object.keys(p.files).length >= 50;
  $("rename-file").disabled = false;
  $("remove-file").disabled = Object.keys(p.files).length <= 1 || fileName === p.entrypoint;
}
function draftChanged() {
  state.project.revision++;
  persistDraft();
  markDraft();
  invalidateQuote();
}
function setDraftSnapshot(content, selected = fileName) {
  const checked = VeyraWorkspaceStore.validateSnapshot(content);
  Object.assign(state.project, checked);
  fileName = selected;
  renderEditorFiles();
  draftChanged();
  resetAssistant();
}

let strategyFile = null;
function closeStrategyFile() {
  strategyFile = null;
  $("strategy-file-dialog").close();
}
function openStrategyFile(action) {
  const p = state.project;
  if (!p || !currentProjectRoute(p.id) || $("editor").disabled || $("strategy-file-dialog").open) return;
  if (action === "remove" && (fileName === p.entrypoint || Object.keys(p.files).length <= 1)) return;
  strategyFile = { project: p, path: fileName, action, revision: p.revision, generation: routeGeneration };
  $("file-dialog-title").textContent = { add: "Add Python file", rename: "Rename Python file", remove: "Remove file from draft?" }[action];
  $("file-dialog-notice").textContent = action === "remove"
    ? `Remove ${fileName} from the next unsaved snapshot? Saved versions keep this file. Imports are not rewritten. Nothing is saved until Save version.`
    : action === "rename" ? `Rename ${fileName} in this draft. Its exact source is kept and the entrypoint follows a renamed entry file. Imports are not rewritten.`
      : "Add an empty Python file to this device draft. Nothing is uploaded or saved as a version until Save version.";
  $("file-path-field").hidden = action === "remove";
  $("file-path").required = action !== "remove";
  $("file-path").value = action === "rename" ? fileName : "";
  $("file-dialog-status").textContent = "";
  $("confirm-strategy-file").textContent = { add: "Add blank file", rename: "Rename in draft", remove: "Remove from draft" }[action];
  $("strategy-file-dialog").showModal();
  (action === "remove" ? $("cancel-strategy-file") : $("file-path")).focus();
}
for (const action of ["add", "rename", "remove"]) $(`${action}-file`).addEventListener("click", () => openStrategyFile(action));
for (const id of ["close-strategy-file", "cancel-strategy-file"]) $(id).addEventListener("click", closeStrategyFile);
$("strategy-file-dialog").addEventListener("cancel", (event) => { event.preventDefault(); closeStrategyFile(); });
$("strategy-file-dialog").addEventListener("close", () => {
  if ($("strategy-file-dialog").open) return;
  strategyFile = null;
  if (state.project && currentProjectRoute(state.project.id) && !$("view-project").hidden) $("editor-file").focus();
});
$("strategy-file-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const review = strategyFile, p = state.project;
  if (!review || !$("strategy-file-dialog").open) return;
  try {
    if (p !== review.project || !currentProjectRoute(p.id) || routeGeneration !== review.generation || p.revision !== review.revision) {
      throw new Error("The draft changed. Close this dialog and review the file action again.");
    }
    const files = { ...p.files };
    let entrypoint = p.entrypoint, selected = fileName;
    if (review.action === "remove") {
      if (!Object.hasOwn(files, review.path) || Object.keys(files).length <= 1 || review.path === entrypoint) {
        throw new Error("Keep at least one file and choose another entrypoint before removing its file.");
      }
      delete files[review.path];
      selected = entrypoint;
    } else {
      const path = VeyraWorkspaceStore.validateFilePath($("file-path").value);
      if (Object.hasOwn(files, path)) throw new Error("A file already uses that path. Choose a different path.");
      if (review.action === "rename") {
        if (!Object.hasOwn(files, review.path)) throw new Error("The file changed. Reopen this dialog.");
        // Rebuild in place so renaming never reorders or normalizes untouched sources.
        const renamed = Object.fromEntries(Object.entries(files).map(([name, source]) => [name === review.path ? path : name, source]));
        if (entrypoint === review.path) entrypoint = path;
        setDraftSnapshot({ files: renamed, entrypoint }, path);
        closeStrategyFile();
        return;
      }
      files[path] = "";
      selected = path;
    }
    setDraftSnapshot({ files, entrypoint }, selected);
    closeStrategyFile();
  } catch (error) { $("file-dialog-status").textContent = error.message; }
});
$("editor-entrypoint").addEventListener("change", () => {
  const p = state.project;
  if (!p || !currentProjectRoute(p.id)) return;
  try {
    if (p.entrypoint !== $("editor-entrypoint").value) setDraftSnapshot({ files: p.files, entrypoint: $("editor-entrypoint").value });
  } catch (error) { $("editor-entrypoint").value = p.entrypoint; fail(error); }
});
$("editor-file").addEventListener("change", () => {
  if (!state.project || !Object.hasOwn(state.project.files, $("editor-file").value)) return;
  fileName = $("editor-file").value;
  renderEditorFiles();
  resetAssistant();
  markDraft();
});
// Textareas expose LF only. Splice the changed range into exact source, retaining untouched CRLF/CR.
function editedSource(source, text) {
  const normalized = source.replace(/\r\n?/g, "\n");
  if (normalized === text) return source;
  let start = 0, end = normalized.length, nextEnd = text.length;
  while (start < end && start < nextEnd && normalized[start] === text[start]) start++;
  while (end > start && nextEnd > start && normalized[end - 1] === text[nextEnd - 1]) { end--; nextEnd--; }
  function offset(index) {
    let raw = 0, count = 0;
    while (count < index) { if (source[raw] === "\r" && source[raw + 1] === "\n") raw++; raw++; count++; }
    return raw;
  }
  const ending = source.match(/\r\n|\r|\n/)?.[0] || "\n";
  return source.slice(0, offset(start)) + text.slice(start, nextEnd).replace(/\n/g, ending) + source.slice(offset(end));
}
$("editor").addEventListener("input", () => {
  if (!state.project || !Object.hasOwn(state.project.files, fileName)) return;
  const before = state.project.files[fileName], after = editedSource(before, $("editor").value);
  if (before === after) return;
  state.project.files[fileName] = after;
  draftChanged();
});

function editorWritable() {
  return state.project && currentProjectRoute(state.project.id) && !$("view-project").hidden &&
    !$("editor").disabled && !$("editor").readOnly && Object.hasOwn(state.project.files, fileName);
}
function insertAtCursor(text) {
  const ed = $("editor");
  if (!editorWritable()) return;
  const start = ed.selectionStart, end = ed.selectionEnd;
  ed.focus();
  ed.setRangeText(text, start, end, "end");
  ed.dispatchEvent(new Event("input"));
}
for (const b of document.querySelectorAll("[data-key]")) {
  b.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.isPrimary === false || b.disabled) return;
    // Retain the textarea selection; native click is the sole activation path.
    e.preventDefault();
    editorPointer = { button: b, project: state.project, fileName, revision: state.project?.revision, generation: routeGeneration };
  });
  b.addEventListener("pointercancel", () => { if (editorPointer?.button === b) editorPointer.cancelled = true; });
  b.addEventListener("click", (e) => {
    const pointer = editorPointer;
    editorPointer = null;
    if (b.disabled || (e.detail && pointer && (pointer.cancelled || pointer.button !== b || pointer.project !== state.project ||
        pointer.fileName !== fileName || pointer.revision !== state.project?.revision || pointer.generation !== routeGeneration))) return;
    insertAtCursor(b.dataset.key);
  });
}
for (const type of ["blur", "pointerdown", "input", "compositionstart"]) {
  $("editor").addEventListener(type, () => { editorTabExit = false; });
}
$("editor").addEventListener("keydown", (e) => {
  const exit = editorTabExit;
  editorTabExit = false;
  if (!e.isComposing && e.keyCode !== 229 && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && editorWritable()) {
    if (e.key === "Escape") { e.preventDefault(); editorTabExit = true; }
    if (e.key === "Tab" && !exit) { e.preventDefault(); insertAtCursor("    "); }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); busy($("save-version"), saveIfDirty); }
});

async function saveIfDirty() {
  const p = state.project;
  if (!p || !currentProjectRoute(p.id)) throw new Error("Open a strategy first.");
  if (p.savePending) return p.savePending;
  if (!projectDirty(p)) return p.version;
  const content = VeyraWorkspaceStore.validateSnapshot(p), expected = p.version.version_no;
  p.savePending = (async () => {
    const v = await projectRequest(p.id, "save", { ...content, expected_version_no: expected });
    if (state.project !== p) return v;
    if (v.project_id !== p.id || v.version_no !== expected + 1 || v.entrypoint !== content.entrypoint ||
        typeof v.id !== "string" || !v.id.trim() || v.id !== v.id.trim() || v.id === p.version.id ||
        (v.files && snapshotSignature(v) !== snapshotSignature(content))) {
      throw new Error("Save identity could not be confirmed. Your draft is kept. Reopen the strategy to inspect saved versions before retrying.");
    }
    p.version = { ...v, ...content };
    p.savedFiles = content.files;
    persistDraft();
    markDraft();
    invalidateQuote();
    say(`Saved v${v.version_no}${isLocalProject(p.id) ? " on this device" : ""}${projectDirty(p) ? "; newer edits remain in your draft" : ""}`);
    return v;
  })();
  try { return await p.savePending; }
  finally { p.savePending = null; }
}
$("save-version").addEventListener("click", (e) => busy(e.currentTarget, saveIfDirty));

function downloadText(text, name, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$("recover-draft").addEventListener("click", () => {
  if (state.project?.recoveryDraft) downloadText(state.project.recoveryDraft, "veyra-recovered-draft.json", "application/json");
});
$("download-code").addEventListener("click", () => {
  if (state.project && Object.hasOwn(state.project.files, fileName)) downloadText(state.project.files[fileName], fileName.split("/").pop(), "text/x-python");
});
$("download-snapshot").addEventListener("click", () => {
  try {
    const p = state.project;
    if (!p || !currentProjectRoute(p.id) || $("editor").disabled) throw new Error("Open a strategy first.");
    const files = { ...p.files };
    const json = VeyraStrategyBackup.exportJSON({ name: p.name, description: p.description, folder: p.folder,
      files, entrypoint: p.entrypoint, has_unsaved_changes: projectDirty(p) });
    downloadText(json, "veyra-strategy-snapshot.json", "application/json");
    say("Snapshot download started. Keep it private: it contains the complete source, including current edits.");
  } catch (e) { say(`Snapshot not downloaded. ${e.message}`, true); }
});

// Saved history is a separate read-only view; never bind it to the editor's file map.
let strategyHistory = null;
const historyCurrent = (review, response = false) => strategyHistory === review && $("strategy-history-dialog").open &&
  state.project === review.project && currentProjectRoute(review.project.id, response) && routeGeneration === review.generation &&
  review.user === state.user && review.org === state.org && !$("view-project").hidden;
function clearHistoryComparison() {
  if (strategyHistory) strategyHistory.comparison = null;
  $("history-comparison").hidden = true;
  $("history-compare").setAttribute("aria-expanded", "false");
  for (const id of ["history-before", "history-after", "history-diff-lines", "history-compare-file"]) $(id).replaceChildren();
}
function closeStrategyHistory() {
  clearHistoryCloudCopy();
  clearHistoryComparison();
  strategyHistory = null;
  $("history-source").textContent = "";
  $("history-snapshot").hidden = true;
  $("history-download").disabled = $("history-compare").disabled = true;
  $("strategy-history-dialog").close();
}
function checkHistoryVersion(version, local) {
  if (!version || !Number.isInteger(version.version_no) || version.version_no < 1 || version.version_no > 2147483647 ||
      typeof version.id !== "string" || !(local ? isLocalProject(version.id) : publicationId(version.id)) ||
      typeof version.entrypoint !== "string" || typeof version.created_at !== "string" || !Number.isFinite(Date.parse(version.created_at)) ||
      (local ? version.content_hash !== null : !/^sha256:[0-9a-f]{64}$/.test(version.content_hash))) {
    throw new Error("Saved version metadata is unavailable. Close History and try again.");
  }
  return version;
}
async function loadHistoryVersion(review, response = false) {
  if (!historyCurrent(review, response)) return;
  clearHistoryCloudCopy();
  clearHistoryComparison();
  const selection = ++review.selection;
  review.snapshot = null;
  $("history-snapshot").hidden = true;
  $("history-source").textContent = "";
  $("history-download").disabled = $("history-compare").disabled = true;
  $("history-version-retry").hidden = true;
  $("history-version-status").textContent = "Loading saved source…";
  try {
    const selected = review.versions.find((version) => String(version.version_no) === $("history-version").value);
    if (!selected) throw new Error("Choose a saved version.");
    const snapshot = checkSnapshot(await projectRequest(review.project.id, "version", selected.version_no));
    if (!historyCurrent(review, true) || selection !== review.selection) return;
    if (["id", "version_no", "content_hash", "entrypoint", "created_at"].some((key) => snapshot[key] !== selected[key]) ||
        snapshot.project_id !== review.project.id) throw new Error("Saved source identity changed. Close History and try again.");
    review.snapshot = snapshot;
    const pairs = [["Saved version", `v${snapshot.version_no}`], ["Version ID", snapshot.id],
      ["Saved at", snapshot.created_at], ["Entrypoint", snapshot.entrypoint],
      ["Content hash", snapshot.content_hash ?? "Not recorded for device-local versions"],
      ["Source files", String(Object.keys(snapshot.files).length)]];
    $("history-identity").replaceChildren(...pairs.flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value)]));
    sourceSelector($("history-file"), $("history-source"), snapshot);
    $("history-file-list").replaceChildren(...Object.keys(snapshot.files).map((path) => el("li", {}, path)));
    $("history-snapshot").hidden = false;
    $("history-download").disabled = $("history-compare").disabled = false;
    $("history-version-status").textContent = `Viewing saved v${snapshot.version_no}. Your editor and unsaved edits are unchanged.`;
    $("review-cloud-copy").disabled = !isLocalProject(review.project.id) || !state.org || !state.user;
  } catch (error) {
    if (historyCurrent(review, true) && selection === review.selection) {
      $("history-version-status").textContent = `Saved source unavailable. ${error.message}`;
      $("history-version-retry").hidden = false;
    }
  }
}
async function loadHistoryPage(review) {
  if (!historyCurrent(review) || review.pending) return;
  review.pending = true;
  $("history-more").disabled = true;
  $("history-retry").hidden = true;
  $("history-status").textContent = "Loading saved versions…";
  try {
    const local = isLocalProject(review.project.id);
    const [metadata, page] = await Promise.all([
      review.metadata || projectRequest(review.project.id, "get"),
      local ? null : api(`/v1/projects/${review.project.id}/versions?limit=50${review.cursor ? `&before_version=${review.cursor}` : ""}`),
    ]);
    if (!historyCurrent(review, true)) return;
    if (metadata.id !== review.project.id || typeof metadata.name !== "string") throw new Error("Project details are unavailable.");
    const versions = (local ? metadata.versions : page.versions).map((version) => checkHistoryVersion(version, local));
    if (versions.some((version, index) => version.version_no >= (index ? versions[index - 1].version_no : review.cursor || Infinity))) {
      throw new Error("Saved versions arrived out of order. Close History and try again.");
    }
    if (!local && (!Number.isInteger(page.total_count) || page.total_count < review.versions.length + versions.length ||
        typeof page.has_more !== "boolean" || (page.has_more ? !versions.length || page.next_before_version !== versions.at(-1).version_no : page.next_before_version !== null))) {
      throw new Error("Saved version pagination is unavailable. Close History and try again.");
    }
    review.metadata = metadata;
    review.versions.push(...versions);
    review.cursor = !local && page.has_more ? page.next_before_version : null;
    const selected = $("history-version").value || String(review.project.version.version_no);
    $("history-version").replaceChildren(...review.versions.map((version) => el("option", { value: version.version_no }, `Saved v${version.version_no} · ${when(version.created_at)}`)));
    if (review.versions.some((version) => String(version.version_no) === selected)) $("history-version").value = selected;
    $("history-version").disabled = !review.versions.length;
    $("history-details").replaceChildren(...[["Name", metadata.name], ["Description", metadata.description || "None"],
      ["Folder", metadata.folder || "No folder"]].flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value)]));
    $("history-project-details").hidden = false;
    $("history-more").hidden = !review.cursor;
    $("history-status").textContent = local
      ? `${review.versions.length} saved versions · all device history · newest first`
      : `${review.versions.length} versions loaded · ${page.total_count} saved at last check · newest first. Reopen History for newer saves.`;
    if (!review.selection && review.versions.length) loadHistoryVersion(review, true);
  } catch (error) {
    if (historyCurrent(review, true)) {
      $("history-status").textContent = `Could not load saved versions. ${error.message}`;
      $("history-retry").hidden = false;
    }
  } finally {
    if (historyCurrent(review, true)) { review.pending = false; $("history-more").disabled = false; }
  }
}
$("project-history").addEventListener("click", () => {
  const project = state.project;
  if (!project || !currentProjectRoute(project.id) || $("view-project").hidden || $("editor").disabled || $("strategy-history-dialog").open) return;
  clearHistoryCloudCopy();
  clearHistoryComparison();
  $("history-cloud-copy").hidden = !isLocalProject(project.id);
  $("cloud-copy-availability").textContent = state.org && state.user
    ? "Review a saved device version before sending it to your connected private cloud workspace."
    : "No cloud account/workspace is connected. This strategy stays on this device. Connect an account from Wallet, then reopen History to review a copy.";
  const review = strategyHistory = { project, generation: routeGeneration, user: state.user, org: state.org, selection: 0, versions: [], cursor: null, metadata: null, snapshot: null, pending: false };
  $("history-version").replaceChildren();
  $("history-version").disabled = true;
  $("history-snapshot").hidden = $("history-project-details").hidden = true;
  $("history-more").hidden = $("history-retry").hidden = $("history-version-retry").hidden = true;
  $("history-source").textContent = $("history-version-status").textContent = "";
  $("history-download").disabled = $("history-compare").disabled = true;
  $("strategy-history-dialog").showModal();
  loadHistoryPage(review);
});
$("close-strategy-history").addEventListener("click", closeStrategyHistory);
$("strategy-history-dialog").addEventListener("cancel", (event) => { event.preventDefault(); closeStrategyHistory(); });
$("strategy-history-dialog").addEventListener("close", () => {
  if ($("strategy-history-dialog").open) return;
  clearHistoryCloudCopy();
  clearHistoryComparison();
  strategyHistory = null;
  $("history-source").textContent = "";
  $("history-snapshot").hidden = true;
  $("history-download").disabled = $("history-compare").disabled = true;
  if (!$("view-project").hidden && state.project && currentProjectRoute(state.project.id)) $("project-history").focus();
});
for (const id of ["history-more", "history-retry"]) $(id).addEventListener("click", () => { if (strategyHistory) loadHistoryPage(strategyHistory); });
for (const [id, event] of [["history-version", "change"], ["history-version-retry", "click"]]) {
  $(id).addEventListener(event, () => { if (strategyHistory && historyCurrent(strategyHistory)) loadHistoryVersion(strategyHistory); });
}
$("history-file").addEventListener("change", () => {
  const review = strategyHistory;
  if (review && historyCurrent(review) && review.snapshot && Object.hasOwn(review.snapshot.files, $("history-file").value)) {
    $("history-source").textContent = review.snapshot.files[$("history-file").value];
  }
});
$("history-download").addEventListener("click", () => {
  const review = strategyHistory;
  if (!review || !historyCurrent(review) || !review.snapshot || String(review.snapshot.version_no) !== $("history-version").value) return;
  try {
    const json = VeyraStrategyBackup.exportJSON({ name: review.metadata.name, description: review.metadata.description,
      folder: review.metadata.folder, files: review.snapshot.files, entrypoint: review.snapshot.entrypoint, has_unsaved_changes: false });
    downloadText(json, `veyra-saved-v${review.snapshot.version_no}-snapshot.json`, "application/json");
    $("history-version-status").textContent = `Saved v${review.snapshot.version_no} download started. It contains complete private source and the project details shown below; earlier history is not included.`;
  } catch (error) { $("history-version-status").textContent = `Snapshot not downloaded. ${error.message} Saved source is unchanged.`; }
});

// Only the selected saved source can leave the device, after a separate destination review.
let historyCloudCopy = null;
const cloudCopyAttempts = new Map();
const cloudCopyCurrent = (copy, response = false) => historyCloudCopy === copy && historyCurrent(copy.history, response) &&
  copy.selection === copy.history.selection && copy.snapshot === copy.history.snapshot &&
  String(copy.snapshot.version_no) === $("history-version").value;
function clearHistoryCloudCopy() {
  historyCloudCopy = null;
  $("cloud-copy-review").hidden = true;
  $("cloud-copy-details").replaceChildren();
  $("cloud-copy-name").value = "";
  $("cloud-copy-status").textContent = "";
  $("cloud-copy-result").hidden = $("cloud-copy-checked").hidden = true;
  $("cloud-copy-result").removeAttribute("href");
  $("confirm-cloud-copy").disabled = $("review-cloud-copy").disabled = true;
  $("review-cloud-copy").setAttribute("aria-expanded", "false");
}
function cloudCopyBody(copy, name) {
  // Reuse the portable snapshot boundary; select metadata explicitly, never saved IDs or provenance.
  const preview = VeyraStrategyBackup.importJSON(JSON.stringify({ format: VeyraStrategyBackup.FORMAT,
    schema_version: VeyraStrategyBackup.SCHEMA_VERSION, name, description: copy.metadata.description,
    folder: copy.metadata.folder, files: copy.snapshot.files, entrypoint: copy.snapshot.entrypoint,
    has_unsaved_changes: false }));
  if ([preview.project.name, preview.project.description].some((value) => /^\p{White_Space}|\p{White_Space}$/u.test(value))) {
    throw new Error("Cloud copy metadata must not have outer whitespace. Review the name or update device project settings first.");
  }
  return { ...preview.project, folder: preview.project.folder.replace(/\p{White_Space}+/gu, " ").trim() || null, template: null };
}
async function reviewCloudCopy() {
  const history = strategyHistory;
  if (!history || !historyCurrent(history) || !history.snapshot || !isLocalProject(history.project.id) ||
      !state.user || !state.org || String(history.snapshot.version_no) !== $("history-version").value || historyCloudCopy) return;
  const copy = historyCloudCopy = { history, snapshot: history.snapshot,
    metadata: { name: history.metadata.name, description: history.metadata.description, folder: history.metadata.folder, visibility: history.metadata.visibility },
    selection: history.selection, ready: false, sent: false };
  copy.key = JSON.stringify([history.user, history.org, history.project.id, copy.snapshot.id]);
  $("cloud-copy-review").hidden = false;
  $("review-cloud-copy").disabled = true;
  $("review-cloud-copy").setAttribute("aria-expanded", "true");
  $("cloud-copy-name").disabled = true;
  $("cloud-copy-status").textContent = "Checking the connected destination. No source has been sent…";
  try {
    if (copy.metadata.visibility !== "private") throw new Error("Only a private device strategy can be copied.");
    const body = cloudCopyBody(copy, copy.metadata.name);
    const me = await api("/v1/me");
    if (!cloudCopyCurrent(copy, true)) return;
    const org = me.organizations?.find((item) => item.id === history.org);
    if (!publicationId(me.user_id) || typeof me.subject !== "string" || !me.subject ||
        !org || typeof org.name !== "string" || !org.name) throw new Error("The connected account/workspace could not be verified. Close History and reconnect before copying.");
    if (!["owner", "researcher"].includes(org.role)) throw new Error("This account cannot create strategies in the connected workspace. Source has not been sent.");
    copy.accountId = me.user_id;
    $("cloud-copy-details").replaceChildren(...[
      ["Destination account", me.subject], ["Account ID", me.user_id],
      ["Private cloud workspace", org.name], ["Workspace ID", org.id],
      ["Selected source", `Saved v${copy.snapshot.version_no} · ${copy.snapshot.id}`],
      ["Entrypoint", body.entrypoint], ["Included source files", String(Object.keys(body.files).length)],
      ["Description", body.description || "None"], ["Cloud folder", body.folder || "No folder"],
    ].flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value)]));
    $("cloud-copy-name").value = body.name;
    if ($("cloud-copy-name").value !== body.name) throw new Error("The saved name cannot be reviewed unchanged. Update device project settings first.");
    $("cloud-copy-name").disabled = false;
    const previous = cloudCopyAttempts.get(copy.key);
    copy.ready = !previous;
    $("confirm-cloud-copy").disabled = !copy.ready;
    $("cloud-copy-checked").hidden = previous?.state !== "uncertain";
    $("cloud-copy-status").textContent = previous
      ? previous.state === "pending" ? "An earlier copy request is still pending. Closing does not cancel it. Inspect Cloud workspace before another copy; reopen History after it settles."
        : "The earlier copy outcome is unknown. Inspect Cloud workspace before another copy; it may already exist."
      : "Review every saved file above and the destination and metadata here. Only Confirm sends this saved version. Your unsaved editor content is excluded.";
    $("cloud-copy-name").focus();
  } catch (error) {
    if (cloudCopyCurrent(copy, true)) $("cloud-copy-status").textContent = `Copy review unavailable. ${error.message} Nothing was uploaded.`;
  }
}
$("review-cloud-copy").addEventListener("click", reviewCloudCopy);
$("cancel-cloud-copy").addEventListener("click", () => {
  const history = strategyHistory;
  clearHistoryCloudCopy();
  $("review-cloud-copy").disabled = !history || !historyCurrent(history) || !history.snapshot || !state.user || !state.org;
  $("review-cloud-copy").focus();
});
$("cloud-copy-checked").addEventListener("click", () => {
  const copy = historyCloudCopy;
  if (!copy || !cloudCopyCurrent(copy) || cloudCopyAttempts.get(copy.key)?.state !== "uncertain") return;
  cloudCopyAttempts.delete(copy.key);
  clearHistoryCloudCopy();
  reviewCloudCopy();
});
for (const id of ["cloud-copy-inspect", "cloud-copy-result"]) $(id).addEventListener("click", (event) => {
  const copy = historyCloudCopy;
  if (!copy || !cloudCopyCurrent(copy) || $(id).hidden) { event.preventDefault(); return; }
  // Valid links share the document-level editor navigation guard.
});
$("cloud-copy-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const copy = historyCloudCopy;
  if (!copy || !cloudCopyCurrent(copy) || !copy.ready || copy.sent || cloudCopyAttempts.has(copy.key)) return;
  const name = $("cloud-copy-name").value;
  const current = (response = false) => cloudCopyCurrent(copy, response) && $("cloud-copy-name").value === name;
  let attempt;
  try {
    const body = cloudCopyBody(copy, name);
    const fresh = localWorkspace.getProject(copy.history.project.id);
    const saved = fresh.versions.find((version) => version.id === copy.snapshot.id);
    if (["name", "description", "folder", "visibility"].some((key) => fresh[key] !== copy.metadata[key]) || !saved ||
        ["id", "project_id", "version_no", "created_at", "content_hash"].some((key) => saved[key] !== copy.snapshot[key]) ||
        snapshotSignature(saved) !== snapshotSignature(copy.snapshot)) throw new Error("Device saved source or metadata changed. Close History and review it again before copying.");
    if (!current()) return;
    copy.sent = true;
    attempt = { state: "pending" };
    cloudCopyAttempts.set(copy.key, attempt);
    $("confirm-cloud-copy").disabled = $("cloud-copy-name").disabled = true;
    $("cloud-copy-status").textContent = "Sending the reviewed saved version… Closing or leaving does not cancel an already-sent request. Inspect Cloud workspace before another copy.";
    const created = await api(`/v1/orgs/${copy.history.org}/projects`, { method: "POST", body });
    const version = created?.latest_version;
    if (!created || !publicationId(created.id) || created.org_id !== copy.history.org || created.created_by !== copy.accountId || created.visibility !== "private" ||
        ["name", "description", "folder"].some((key) => created[key] !== body[key]) ||
        !version || !publicationId(version.id) || version.project_id !== created.id || version.version_no !== 1 ||
        version.entrypoint !== body.entrypoint || !/^sha256:[0-9a-f]{64}$/.test(version.content_hash)) {
      throw new Error("The server's creation response could not be verified.");
    }
    cloudCopyAttempts.delete(copy.key);
    if (!current(true)) return;
    $("cloud-copy-status").textContent = "Private cloud copy created at saved v1. The device strategy and drafts are unchanged. No backtest was run and no public link was created.";
    $("cloud-copy-result").href = `#project/${created.id}`;
    $("cloud-copy-result").hidden = false;
  } catch (error) {
    const uncertain = attempt && (!error.status || error.status === 408 || error.status >= 500);
    if (attempt) {
      if (uncertain) attempt.state = "uncertain";
      else cloudCopyAttempts.delete(copy.key);
    }
    if (!current(true)) return;
    $("cloud-copy-status").textContent = uncertain
      ? "Copy outcome unknown: the server may have created it. Inspect Cloud workspace before another copy to avoid duplicates. Nothing will be retried automatically."
      : `Copy not created. ${error.message} Your device strategy and drafts are unchanged.`;
    $("cloud-copy-checked").hidden = !uncertain;
    if (!uncertain) {
      copy.sent = false;
      $("confirm-cloud-copy").disabled = $("cloud-copy-name").disabled = false;
    }
  }
});

function renderHistoryDiff() {
  const review = strategyHistory;
  if (!review || !historyCurrent(review) || !review.comparison || !review.snapshot) return;
  const { draft, statuses } = review.comparison, saved = review.snapshot, path = $("history-compare-file").value;
  if (!Object.hasOwn(statuses, path)) return;
  const before = Object.hasOwn(saved.files, path) ? saved.files[path] : "";
  const after = Object.hasOwn(draft.files, path) ? draft.files[path] : "";
  const diff = review.comparison.diff = VeyraProposalDiff.compare(before, after);
  $("history-before-title").textContent = `Saved v${saved.version_no} · ${path}`;
  $("history-after-title").textContent = `Current draft at comparison · ${path}`;
  $("history-before").textContent = before;
  $("history-after").textContent = after;
  $("history-before-info").textContent = Object.hasOwn(saved.files, path) ? sourceDiffInfo(diff.before) : "File absent in saved version";
  $("history-after-info").textContent = Object.hasOwn(draft.files, path) ? sourceDiffInfo(diff.after) : "File absent in draft";
  $("history-diff-summary").textContent = `${statuses[path]} · ${diff.countsExact ? "" : "Replacement block: "}+${diff.added} added / −${diff.removed} removed lines${diff.whitespaceOnly ? " · whitespace-only changes" : ""}`;
  $("history-diff-note").textContent = diff.mode === "full"
    ? `${diff.reason} Full-source review is open below; nothing is truncated.${diff.countsExact ? "" : " Counts describe the complete differing block, not a minimal line diff."}`
    : "All changed lines are shown with nearby context. Only unchanged lines may be omitted; complete source is available below.";
  $("history-diff-review").hidden = diff.mode === "full";
  $("history-full-source").open = diff.mode === "full";
  renderSourceDiff($("history-diff-lines"), diff, $("history-show-whitespace").checked, "saved line", "draft line");
  $("history-diff-scroll").scrollTop = $("history-diff-scroll").scrollLeft = 0;
}
$("history-compare").addEventListener("click", () => {
  const review = strategyHistory;
  if (!review || !historyCurrent(review) || !review.snapshot || String(review.snapshot.version_no) !== $("history-version").value) return;
  const saved = review.snapshot, p = review.project;
  // Copy the file map, never a textarea: browsing must preserve every exact source string.
  const draft = { files: { ...p.files }, entrypoint: p.entrypoint }, statuses = Object.create(null);
  const paths = [...new Set([...Object.keys(saved.files), ...Object.keys(draft.files)])];
  const counts = { "Added file": 0, "Removed file": 0, Modified: 0, Unchanged: 0 };
  for (const path of paths) {
    statuses[path] = !Object.hasOwn(saved.files, path) ? "Added file" : !Object.hasOwn(draft.files, path) ? "Removed file"
      : saved.files[path] !== draft.files[path] ? "Modified" : "Unchanged";
    counts[statuses[path]]++;
  }
  const selected = $("history-compare-file").value || fileName;
  review.comparison = { draft, statuses };
  $("history-compare-identity").textContent = `Saved v${saved.version_no} → current draft at comparison (based on saved v${p.version.version_no}; ${projectDirty(p) ? "includes unsaved edits" : "no unsaved edits"}).`;
  $("history-compare-summary").textContent = `${counts["Added file"]} added files · ${counts["Removed file"]} removed files · ${counts.Modified} modified files · ${counts.Unchanged} unchanged files`;
  $("history-compare-entrypoint").textContent = `${saved.entrypoint === draft.entrypoint ? "Entrypoint unchanged" : "Entrypoint changed"} · saved v${saved.version_no}: ${saved.entrypoint} · draft: ${draft.entrypoint}`;
  $("history-compare-file").replaceChildren(...paths.map((path) => el("option", { value: path }, `${statuses[path]} · ${path}`)));
  $("history-compare-file").value = Object.hasOwn(statuses, selected) ? selected : saved.entrypoint;
  $("history-show-whitespace").checked = true;
  $("history-comparison").hidden = false;
  renderHistoryDiff();
  $("history-compare").setAttribute("aria-expanded", "true");
  $("history-compare-title").focus();
});
$("history-compare-file").addEventListener("change", renderHistoryDiff);
$("history-show-whitespace").addEventListener("change", () => {
  const review = strategyHistory;
  if (review && historyCurrent(review) && review.comparison?.diff) renderSourceDiff($("history-diff-lines"),
    review.comparison.diff, $("history-show-whitespace").checked, "saved line", "draft line");
});

let strategyImport = 0, strategyPreview = null, strategyImportSaving = false;
function resetStrategyImport() {
  strategyImport++;
  strategyPreview = null;
  strategyImportSaving = false;
  $("strategy-import-file").value = "";
  $("strategy-import-file").disabled = false;
  $("strategy-import-name").value = "";
  $("strategy-import-name").disabled = true;
  $("strategy-import-preview").hidden = true;
  $("strategy-import-files").replaceChildren();
  $("strategy-import-details").replaceChildren();
  $("strategy-import-status").textContent = "";
  $("confirm-strategy-import").disabled = true;
}
function closeStrategyImport() {
  resetStrategyImport();
  $("strategy-import-dialog").close();
}
$("import-strategy").addEventListener("click", () => {
  if ($("strategy-import-dialog").open) return;
  projectCreation = null;
  $("create-project").disabled = false;
  $("new-project-status").textContent = "";
  resetStrategyImport();
  $("strategy-import-dialog").showModal();
  $("strategy-import-file").focus();
});
$("close-strategy-import").addEventListener("click", closeStrategyImport);
$("cancel-strategy-import").addEventListener("click", closeStrategyImport);
$("strategy-import-dialog").addEventListener("cancel", (e) => { e.preventDefault(); closeStrategyImport(); });
$("strategy-import-dialog").addEventListener("close", () => {
  if ($("strategy-import-dialog").open) return;
  resetStrategyImport();
  if (!$("view-code").hidden) $("import-strategy").focus();
});
$("strategy-import-file").addEventListener("change", async () => {
  const file = $("strategy-import-file").files?.[0];
  if (strategyImportSaving || !$("strategy-import-dialog").open) return;
  resetStrategyImport();
  if (!file) return;
  const request = strategyImport, generation = routeGeneration, origin = location.hash;
  const current = () => request === strategyImport && generation === routeGeneration && origin === location.hash && $("strategy-import-dialog").open;
  $("strategy-import-status").textContent = "Reading snapshot locally…";
  try {
    if (file.size > VeyraStrategyBackup.LIMITS.jsonBytes) throw new Error("Strategy snapshot exceeds the 2 MiB import limit.");
    const bytes = await file.arrayBuffer();
    if (!current()) return;
    const preview = VeyraStrategyBackup.importJSON(bytes);
    strategyPreview = preview;
    $("strategy-import-name").value = preview.project.name;
    $("strategy-import-name").disabled = false;
    $("strategy-import-details").replaceChildren(...[
      ["Folder", preview.project.folder || "No folder"], ["Entrypoint", preview.project.entrypoint],
      ["Source", `${preview.file_count} Python files · ${preview.source_bytes.toLocaleString()} bytes`],
      ["Exported edits", preview.has_unsaved_changes ? "Includes unsaved edits" : "No unsaved edits reported"],
    ].flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value)]));
    $("strategy-import-files").replaceChildren(...Object.keys(preview.project.files).map((path) => el("li", {}, path)));
    $("strategy-import-preview").hidden = false;
    $("confirm-strategy-import").disabled = false;
    $("strategy-import-status").textContent = "Preview ready. No strategy has been created.";
  } catch (e) { if (current()) $("strategy-import-status").textContent = e.message || "Could not read this snapshot. Try selecting the file again."; }
});
$("strategy-import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!strategyPreview || strategyImportSaving || !$("strategy-import-dialog").open) return;
  const request = strategyImport, generation = routeGeneration, origin = location.hash;
  const current = () => request === strategyImport && generation === routeGeneration && origin === location.hash && $("strategy-import-dialog").open;
  const project = { ...strategyPreview.project, name: $("strategy-import-name").value };
  let focusName = false;
  strategyImportSaving = true;
  for (const id of ["strategy-import-file", "strategy-import-name", "confirm-strategy-import"]) $(id).disabled = true;
  $("strategy-import-status").textContent = "Waiting to create a private device copy…";
  try {
    // Recheck inside the lock: cancellation or newer navigation must not create a queued copy.
    const copy = await localWrite(() => current() ? localWorkspace.createProject(project) : null);
    if (!current() || !copy) return;
    closeStrategyImport();
    location.hash = `#project/${copy.id}`;
    say("Created a private device copy as saved v1. It stays in this browser; earlier history is not included.");
  } catch (e) {
    if (current()) {
      $("strategy-import-status").textContent = e.message;
      focusName = e.code === "NAME_CONFLICT";
    }
  } finally {
    if (current()) {
      strategyImportSaving = false;
      for (const id of ["strategy-import-file", "strategy-import-name", "confirm-strategy-import"]) $(id).disabled = false;
      if (focusName) $("strategy-import-name").focus();
    }
  }
});

$("duplicate-project").addEventListener("click", (e) => busy(e.currentTarget, async () => {
  const p = state.project;
  if (!p) throw new Error("Open a strategy first.");
  if (projectDirty(p) || p.savePending) throw new Error("Save version before duplicating your current draft.");
  const revision = p.revision, user = state.user, org = state.org;
  const copy = await projectRequest(p.id, "duplicate", { expected_version_no: p.version.version_no });
  if (user !== state.user || org !== state.org) return;
  if (state.project === p && currentProjectRoute(p.id) && p.revision === revision) location.hash = `#project/${copy.id}`;
  else say(`Created ${copy.name || "strategy copy"}. Find it in Studio.`);
}));
let strategySettings = null;
const settingsWrites = new Map();
const settingsCurrent = (review, response = false) => strategySettings === review && $("strategy-settings-dialog").open &&
  review.project === state.project && review.generation === routeGeneration && currentProjectRoute(review.project.id, response) &&
  review.org === state.org && review.user === state.user && !$("view-project").hidden;
function settingsPending(pending) {
  for (const control of $("strategy-settings-form").querySelectorAll("input, textarea, button[type=submit]")) control.disabled = pending;
}
function closeStrategySettings() {
  strategySettings = null;
  $("strategy-settings-dialog").close();
}
$("project-settings").addEventListener("click", () => {
  const p = state.project;
  if (!p || !currentProjectRoute(p.id) || $("view-project").hidden || $("editor").disabled || $("strategy-settings-dialog").open) return;
  strategySettings = { project: p, generation: routeGeneration, org: state.org, user: state.user, pending: false };
  $("settings-name").value = p.name;
  $("settings-description").value = p.description || "";
  $("settings-folder").value = p.folder || "";
  $("settings-status").textContent = "";
  settingsPending(false);
  $("strategy-settings-dialog").showModal();
});
$("close-strategy-settings").addEventListener("click", closeStrategySettings);
$("strategy-settings-dialog").addEventListener("cancel", (event) => { event.preventDefault(); closeStrategySettings(); });
$("strategy-settings-dialog").addEventListener("close", () => {
  if ($("strategy-settings-dialog").open) return;
  strategySettings = null;
});
$("strategy-settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const review = strategySettings;
  if (!review || !settingsCurrent(review) || review.pending) return;
  const p = review.project;
  review.pending = true;
  settingsPending(true);
  const body = { name: $("settings-name").value, description: $("settings-description").value, folder: $("settings-folder").value || null };
  const earlier = settingsWrites.get(p.id);
  $("settings-status").textContent = earlier ? "Waiting for the earlier settings save…" : "Saving settings…";
  // Order same-project writes across visits, but never automatically retry an uncertain server outcome.
  let started = false;
  const request = (async () => {
    if (earlier) {
      try { await earlier; }
      catch (error) { if (error.settingsUncertain) throw error; }
    }
    if (!settingsCurrent(review)) return null;
    $("settings-status").textContent = "Saving settings…";
    started = true;
    try { return await projectRequest(p.id, "settings", body, () => settingsCurrent(review)); }
    catch (error) {
      if (!isLocalProject(p.id) && (!error.status || error.status === 408 || error.status >= 500)) error.settingsUncertain = true;
      throw error;
    }
  })();
  settingsWrites.set(p.id, request);
  try {
    const saved = await request;
    if (!settingsCurrent(review, true)) return;
    if (!saved) { $("settings-status").textContent = "Settings were not saved because navigation was pending. Review and save again."; return; }
    Object.assign(p, { name: saved.name, description: saved.description, folder: saved.folder });
    $("project-title").textContent = saved.name;
    closeStrategySettings();
    say("Strategy settings saved.");
  } catch (error) {
    if (settingsCurrent(review, true)) $("settings-status").textContent = error.settingsUncertain
      ? `Save outcome unknown: the server may still finish the request. ${started ? "" : "This queued save was not sent. "}Check saved settings before retrying; a retry could race the unconfirmed save.`
      : error.message || String(error);
  } finally {
    if (settingsWrites.get(p.id) === request) settingsWrites.delete(p.id);
    review.pending = false;
    if (settingsCurrent(review, true)) settingsPending(false);
  }
});

function assistantMessage(speaker, message) {
  $("assistant-messages").append(el("li", { class: speaker === "You" ? "from-user" : "from-assistant" }, el("strong", {}, speaker), message));
  $("assistant-messages").scrollTop = $("assistant-messages").scrollHeight;
}
function sourceDiffInfo(source) {
  const endings = Object.entries(source.endings).filter(([, count]) => count).map(([name, count]) => `${count} ${name}`).join(", ");
  return `${source.lines} lines${endings ? ` · ${endings}` : ""} · ${source.finalNewline === null ? "empty source" : source.finalNewline ? "ends with newline" : "no final newline"}`;
}
function renderSourceDiff(list, diff, whitespace, beforeLabel, afterLabel) {
  const labels = { add: "Added", remove: "Removed", equal: "Unchanged" };
  list.replaceChildren(...diff.rows.map((row) => {
    if (row.kind === "gap") return el("li", { class: "proposal-gap" }, `${row.count} unchanged lines omitted`);
    const lineLabel = [labels[row.kind], row.oldLine === null ? "" : `${beforeLabel} ${row.oldLine}`,
      row.newLine === null ? "" : `${afterLabel} ${row.newLine}`].filter(Boolean).join(", ");
    return el("li", { class: `proposal-line proposal-${row.kind}` },
      el("span", { class: "sr-only" }, `${lineLabel}: `),
      el("span", { class: "proposal-line-number", "aria-hidden": "true" }, row.oldLine ?? ""),
      el("span", { class: "proposal-line-number", "aria-hidden": "true" }, row.newLine ?? ""),
      el("span", { "aria-hidden": "true" }, row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "),
      el("code", {}, whitespace ? VeyraProposalDiff.visibleWhitespace(row.text) : row.text),
      el("span", { class: "proposal-ending" }, row.ending === "none" ? "no final newline" : row.ending));
  }));
}
function renderAssistantDiff() {
  if (assistantProposal) renderSourceDiff($("assistant-diff-lines"), assistantProposal.diff,
    $("assistant-show-whitespace").checked, "line before proposal", "proposed line");
}
function reviewAssistantProposal() {
  const { base_code: before, proposed_code: after } = assistantProposal.proposal;
  const diff = assistantProposal.diff = VeyraProposalDiff.compare(before, after);
  $("assistant-before").textContent = before;
  $("assistant-after").textContent = after;
  $("assistant-before-info").textContent = sourceDiffInfo(diff.before);
  $("assistant-after-info").textContent = sourceDiffInfo(diff.after);
  $("assistant-diff-summary").textContent = `${diff.countsExact ? "" : "Replacement block: "}+${diff.added} added / −${diff.removed} removed lines${diff.whitespaceOnly ? " · whitespace-only changes" : ""}`;
  $("assistant-diff-note").textContent = diff.mode === "full"
    ? `${diff.reason} Full-source review is open below; nothing is truncated.${diff.countsExact ? "" : " Counts describe the complete differing block, not a minimal line diff."}`
    : "All changed lines are shown with nearby context. Only unchanged lines may be omitted; complete source is available below.";
  $("assistant-diff-review").hidden = diff.mode === "full";
  $("assistant-full-source").open = diff.mode === "full";
  $("assistant-show-whitespace").checked = true;
  renderAssistantDiff();
  $("assistant-diff-scroll").scrollTop = 0;
  $("assistant-diff-scroll").scrollLeft = 0;
}
$("assistant-show-whitespace").addEventListener("change", renderAssistantDiff);
function resetAssistant() {
  assistantProposal = assistantUndo = null;
  $("assistant-proposal").hidden = true;
  $("assistant-undo").hidden = true;
  $("assistant-messages").replaceChildren();
  assistantMessage("Built-in helper", "Choose a Python template, ask about the SDK, or set an explicit parameter. You'll review each proposed edit before applying it.");
}
function askAssistant(prompt) {
  if (!state.project) return;
  assistantMessage("You", prompt);
  const response = VeyraStudioAssistant.propose({ code: state.project.files[fileName], prompt });
  assistantMessage("Built-in helper", response.message);
  assistantProposal = response.status === "proposal" ? { proposal: response, project: state.project, revision: state.project.revision, fileName } : null;
  $("assistant-proposal").hidden = !assistantProposal;
  if (assistantProposal) reviewAssistantProposal();
  $("assistant-prompt").value = "";
}
$("assistant-form").addEventListener("submit", (e) => { e.preventDefault(); askAssistant($("assistant-prompt").value.trim()); });
for (const b of document.querySelectorAll("[data-prompt]")) b.addEventListener("click", () => askAssistant(b.dataset.prompt));
$("assistant-dismiss").addEventListener("click", () => { assistantProposal = null; $("assistant-proposal").hidden = true; });
$("assistant-apply").addEventListener("click", () => {
  const p = state.project;
  if (!assistantProposal || assistantProposal.project !== p || assistantProposal.fileName !== fileName) return;
  if (assistantProposal.revision !== p.revision) { assistantMessage("Built-in helper", "The draft changed after this proposal. Request a new proposal to keep your edits."); return; }
  const result = VeyraStudioAssistant.applyProposal(p.files[fileName], assistantProposal.proposal);
  if (result.status !== "applied") { assistantMessage("Built-in helper", result.message); return; }
  try { VeyraWorkspaceStore.validateSnapshot({ files: { ...p.files, [fileName]: result.code }, entrypoint: p.entrypoint }); }
  catch (error) { assistantMessage("Built-in helper", error.message); return; }
  assistantUndo = { before: p.files[fileName], after: result.code, project: p, fileName, revision: p.revision + 1 };
  p.files[fileName] = result.code;
  $("editor").value = result.code;
  draftChanged();
  $("assistant-proposal").hidden = true;
  $("assistant-undo").hidden = false;
  assistantProposal = null;
  assistantMessage("Built-in helper", "Applied to your draft. Review the Python code, then save a version when you're ready.");
});
$("assistant-undo").addEventListener("click", () => {
  const p = state.project;
  if (!assistantUndo || assistantUndo.project !== p || assistantUndo.fileName !== fileName) return;
  if (p.revision !== assistantUndo.revision || p.files[fileName] !== assistantUndo.after) { assistantMessage("Built-in helper", "The code changed after that edit. Undo would overwrite your work, so it was not applied."); return; }
  p.files[fileName] = assistantUndo.before;
  $("editor").value = assistantUndo.before;
  draftChanged();
  assistantUndo = null;
  $("assistant-undo").hidden = true;
});

function quoteSignature() {
  return JSON.stringify({ project: state.project?.id, version: state.project?.version.id,
    revision: state.project?.revision, quoteRevision: state.quoteRevision, generation: routeGeneration, files: state.project?.files, entrypoint: state.project?.entrypoint,
    fields: ["bt-dataset", "bt-start", "bt-end", "bt-cash", "bt-runtime", "bt-params"].map((id) => $(id).value) });
}

let quoteRequest = null, approvalRequest = null;
const backtestContextCurrent = (request, response = false) => request.project === state.project &&
  request.generation === routeGeneration && request.origin === editorRouteHash(response) &&
  currentProjectRoute(request.project?.id, response) && request.org === state.org && request.user === state.user;
const backtestContext = () => ({ project: state.project, generation: routeGeneration,
  origin: location.hash, org: state.org, user: state.user });

$("quote-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.submitter || $("quote-form").querySelector("button[type=submit]");
  if (button.disabled) return;
  const request = quoteRequest = backtestContext();
  const current = () => quoteRequest === request && backtestContextCurrent(request, true);
  button.disabled = true;
  let signature;
  try {
    if (!state.project || isLocalProject(state.project.id)) throw new Error("Backtests need a connected database workspace.");
    invalidateQuote();
    signature = quoteSignature();
    const inputs = { dataset_id: $("bt-dataset").value, start: $("bt-start").value,
      end: $("bt-end").value, starting_cash: $("bt-cash").value,
      max_runtime_seconds: Number($("bt-runtime").value) };
    const params = VeyraBacktestParams.parse($("bt-params").value);
    if (projectDirty(state.project) || state.project.savePending) throw new Error("Save version before getting a price for your current draft.");
    const v = state.project.version;
    const quote = await api("/v1/quotes", { method: "POST", body: { project_version_id: v.id, ...inputs, params } });
    if (!current() || signature !== quoteSignature()) return;
    state.quote = quote;
    state.quoteSignature = signature;
    $("q-expected").textContent = usd(state.quote.estimate.customer_expected_nano);
    $("q-max").textContent = usd(state.quote.customer_max_nano, 9);
    $("approve").textContent = `Approve up to ${usd(state.quote.customer_max_nano, 9)} and run`;
    $("approve").disabled = false;
    $("quote-box").hidden = false;
    $("approve").focus();
  } catch (error) {
    if (current() && (!signature || signature === quoteSignature())) fail(error);
  } finally {
    if (current()) button.disabled = isLocalProject(state.project.id);
    if (quoteRequest === request) quoteRequest = null;
  }
});

// A quote prices exact inputs; any change means a new quote.
$("quote-form").addEventListener("input", invalidateQuote);

$("approve").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  if (button.disabled) return;
  const q = state.quote;
  if (!q || state.quoteSignature !== quoteSignature()) {
    fail(new Error("The code or backtest settings changed. Get a new price before approving."));
    return;
  }
  const request = approvalRequest = { ...backtestContext(), signature: state.quoteSignature };
  const current = () => approvalRequest === request && backtestContextCurrent(request, true) &&
    state.quote === q && request.signature === quoteSignature();
  button.disabled = true;
  let auth;
  try {
    auth = await api(`/v1/quotes/${q.id}/authorize`, { method: "POST",
      body: { accept_max_nano: q.customer_max_nano } });
    if (request.user !== state.user || request.org !== state.org) return;
    // Navigation does not cancel the approved request or change its immutable identity.
    const job = await api("/v1/jobs", { method: "POST", body: { authorization_id: auth.id },
      headers: { "idempotency-key": `quote-${q.id}` } });
    if (!current()) return;
    say("Run confirmed.");
    const destination = `#run/${job.id}`;
    location.hash = destination;
    refreshBalance(() => state.org === request.org && state.user === request.user && location.hash === destination &&
      (routeGeneration === request.generation || routeGeneration === request.generation + 1));
  } catch (error) {
    if (!current()) return;
    if (error.status === 410) {
      invalidateQuote();
      say("This quote or unused authorization expired. Get a new price before approving again.", true);
    } else if (!auth && error.status === 402) say("Not enough credit. Add credit in Wallet.", true);
    else if (!error.status || error.status >= 500) {
      say(`${auth ? "Run submission" : "Approval"} could not be confirmed. Retry this same quote before getting a new price. ${error.message}`, true);
      button.textContent = `Retry ${auth ? "approved run" : "same quote"} up to ${usd(q.customer_max_nano, 9)}`;
    } else fail(error);
  } finally {
    if (current()) button.disabled = false;
    if (approvalRequest === request) approvalRequest = null;
  }
});

// ---------------------------------------------------------------- approved submission recovery
// Server records are discovered only on this route; nothing is persisted in the browser.
let approvalsView = null, recoveryReview = null;
const recoverySubmissions = new Map();
const approvalsCurrent = (view) => approvalsView === view && view.generation === routeGeneration &&
  view.origin === location.hash && view.org === state.org && view.user === state.user && !$("view-approvals").hidden;
const recoveryCurrent = (review) => recoveryReview === review && approvalsCurrent(review.view) && $("approval-review-dialog").open;
const recoveryKey = (view, item) => JSON.stringify([view.user, view.org, item.id]);
const approvalNow = (view) => view.asOf + Math.max(0, performance.now() - view.observed);
function recoveryState(view, item) {
  if (item.job || recoverySubmissions.get(recoveryKey(view, item))?.job) return "used";
  if (item.recovery_state === "released") return "released";
  return Date.parse(item.claim_expires_at) <= approvalNow(view) ? "expired_pending_release" : item.recovery_state;
}
const approvalWhen = value => new Date(value).toISOString().replace("T", " ").replace("Z", " UTC");
const recoveryLabels = { claimable: "Within claim window at last check · reservation held", used: "Run already exists",
  expired_pending_release: "Expired · reservation still held at last check", released: "Expired · unused reservation released" };
function closeRecoveryReview() {
  const review = recoveryReview;
  recoveryReview = null;
  $("approval-review-details").replaceChildren();
  $("approval-review-status").textContent = "";
  $("approval-review-submit").disabled = true;
  $("approval-review-dialog").close();
  if (review && approvalsCurrent(review.view) && review.opener?.isConnected) review.opener.focus();
}
function checkRecoverableApproval(item, asOf) {
  const request = item?.request, validTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
  if (!item || ![item.id, item.quote_id, item.project_id, item.project_version_id].every(publicationId) ||
      !Number.isInteger(item.version_no) || item.version_no < 1 || typeof item.project_name !== "string" ||
      ![item.content_hash, item.input_hash].every(hash => typeof hash === "string" && hash.length > 0) ||
      !Number.isSafeInteger(item.reserved_nano) || item.reserved_nano < 0 ||
      !validTime(item.created_at) || !validTime(item.claim_expires_at) ||
      Date.parse(item.claim_expires_at) - Date.parse(item.created_at) !== 15 * 60 * 1000 ||
      !["reserved", "settled"].includes(item.status) ||
      !(item.job === null || (publicationId(item.job?.id) && typeof item.job.state === "string")) ||
      !request || request.project_version_id !== item.project_version_id ||
      ![request.dataset_id, request.start, request.end, request.starting_cash, request.resource_class,
        request.taker_fee_bps, request.slippage_bps].every(value => typeof value === "string") ||
      !Number.isSafeInteger(request.max_runtime_seconds) || request.max_runtime_seconds <= 0 ||
      !request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
    throw new Error("Saved approval details are unavailable. Refresh approvals before submitting.");
  }
  const expected = item.job ? "used" : item.status === "settled" ? "released"
    : Date.parse(item.claim_expires_at) <= asOf ? "expired_pending_release" : "claimable";
  if (item.recovery_state !== expected) throw new Error("Saved approval state is inconsistent. Refresh approvals before submitting.");
  return item;
}
async function showApprovals(projectId, more = false) {
  let view = approvalsView;
  if (more && (!view || !approvalsCurrent(view) || view.loading || !view.cursor || view.closed)) return;
  if (!more) {
    const priorNow = view && approvalsCurrent(view) ? approvalNow(view) : 0;
    if (view) clearTimeout(view.timer);
    if ($("approval-review-dialog").open) closeRecoveryReview();
    view = approvalsView = { generation: routeGeneration, origin: location.hash, org: state.org, user: state.user,
      scope: projectId || null, rows: [], cursor: null, asOf: priorNow, observed: performance.now(), cursors: new Set(), load: 0 };
    $("approval-list").replaceChildren();
    $("approvals-back").href = view.scope ? `#runs/${encodeURIComponent(view.scope)}` : "#runs";
    $("approvals-all").hidden = !view.scope;
  }
  if (!approvalsCurrent(view)) return;
  const request = ++view.load, cursor = more ? view.cursor : null;
  const current = () => approvalsCurrent(view) && request === view.load;
  view.loading = true;
  $("approvals-status").textContent = more ? "Loading older approvals…" : "Loading saved approvals…";
  $("approvals-refresh").disabled = true;
  $("load-more-approvals").hidden = true;
  $("load-more-approvals").disabled = true;
  if (!view.org || !view.user || (view.scope && !publicationId(view.scope))) {
    view.loading = false; view.closed = true;
    $("approvals-status").textContent = !view.org || !view.user
      ? "Saved approvals require a connected account. Device-local strategies have no server approvals."
      : "This strategy approval link is invalid.";
    $("approvals-refresh").disabled = false;
    return;
  }
  try {
    const query = new URLSearchParams({ limit: "50" });
    if (view.scope) query.set("project_id", view.scope);
    if (cursor) query.set("cursor", cursor);
    const result = await api(`/v1/orgs/${encodeURIComponent(view.org)}/authorizations?${query}`);
    if (!current()) return;
    const asOf = Date.parse(result.as_of);
    if (!Array.isArray(result.authorizations) || result.authorizations.length > 50 || (typeof result.as_of !== "string" || !Number.isFinite(asOf)) ||
        typeof result.has_more !== "boolean" ||
        !(result.next_cursor === null || (typeof result.next_cursor === "string" && result.next_cursor.length > 0 && result.next_cursor.length <= 512)) ||
        result.has_more !== !!result.next_cursor || (result.next_cursor && (result.next_cursor === cursor || view.cursors.has(result.next_cursor)))) {
      throw new Error("Saved approvals could not be read safely. Refresh approvals to try again.");
    }
    const items = result.authorizations.map(item => checkRecoverableApproval(item, asOf));
    if (view.scope && items.some(item => item.project_id !== view.scope)) throw new Error("Approval strategy did not match this view.");
    const known = new Set(view.rows.map(item => item.id));
    if (result.has_more && !items.some(item => !known.has(item.id))) throw new Error("This approval page made no progress. Refresh approvals to try again.");
    for (const item of items) if (!known.has(item.id)) {
      item.observedAsOf = result.as_of;
      view.rows.push(item); known.add(item.id);
    }
    view.rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id));
    // A delayed page must not move an already-observed claim deadline backward.
    view.asOf = Math.max(approvalNow(view), asOf); view.observed = performance.now(); view.cursor = result.next_cursor;
    if (cursor) view.cursors.add(cursor);
    renderApprovals(view);
    $("approvals-status").textContent = `${view.rows.length} saved approvals loaded${view.cursor ? " · older approvals available" : " · all available approvals"}. Latest page checked ${approvalWhen(result.as_of)}.`;
  } catch (error) {
    if (!current()) return;
    if ([401, 403, 404].includes(error.status)) {
      view.closed = true; view.rows = []; view.cursor = null;
      clearTimeout(view.timer);
      if ($("approval-review-dialog").open) closeRecoveryReview();
      $("approval-list").replaceChildren();
      $("approvals-status").textContent = "Saved approvals are unavailable for this account or workspace. Reconnect with an authorized account before trying again.";
    } else $("approvals-status").textContent = `Could not load ${more ? "older " : ""}approvals. ${error.message} ${more ? "Loaded approvals are unchanged. Try Load older approvals again." : "Use Refresh approvals to try again."}`;
  } finally {
    if (current()) {
      view.loading = false;
      $("approvals-refresh").disabled = false;
      $("load-more-approvals").disabled = false;
      $("load-more-approvals").hidden = !view.cursor || view.closed;
    }
  }
}
function renderApprovals(view) {
  if (!approvalsCurrent(view)) return;
  const focusedId = document.activeElement?.dataset.approvalId;
  $("approval-list").replaceChildren(...view.rows.map(item => {
    const state = recoveryState(view, item), result = recoverySubmissions.get(recoveryKey(view, item));
    const job = item.job || result?.job;
    const content = el("div", {}, el("strong", {}, `${item.project_name} · v${item.version_no}`),
      el("span", { class: "sub" }, "Current strategy name · saved version"),
      el("span", { class: "sub" }, `${item.request.dataset_id} · ${item.request.start} to ${item.request.end}`),
      el("p", { class: "small" }, `${recoveryLabels[state]} · ceiling ${usd(item.reserved_nano, 9)}`),
      el("span", { class: "sub" }, `Approved ${approvalWhen(item.created_at)} · claim deadline ${approvalWhen(item.claim_expires_at)}`),
      el("span", { class: "sub" }, `Server snapshot ${approvalWhen(item.observedAsOf)}`));
    if (job) content.append(el("a", { href: `#run/${job.id}`, class: "approval-job-link" }, `Open existing run · ${job.state || "confirmed"}`));
    else {
      const button = el("button", { type: "button", "aria-haspopup": "dialog", "data-approval-id": item.id }, state === "claimable" ? "Review saved approval" : "View approval details");
      if (recoveryReview?.view === view && recoveryReview.item === item) recoveryReview.opener = button;
      button.addEventListener("click", () => openRecoveryReview(view, item, button));
      content.append(button);
    }
    return el("li", {}, content);
  }));
  if (!view.rows.length) $("approval-list").append(el("li", { class: "muted" }, "No saved approvals for this account in this view."));
  if (focusedId) $("approval-list").querySelector(`[data-approval-id="${focusedId}"]`)?.focus();
  clearTimeout(view.timer);
  const deadlines = view.rows.filter(item => recoveryState(view, item) === "claimable").map(item => Date.parse(item.claim_expires_at));
  if (deadlines.length) view.timer = setTimeout(() => {
    if (!approvalsCurrent(view)) return;
    renderApprovals(view);
    if (recoveryReview && recoveryCurrent(recoveryReview)) updateRecoveryReview(recoveryReview);
  }, Math.min(2147483647, Math.max(1, Math.min(...deadlines) - approvalNow(view) + 1)));
}
function openRecoveryReview(view, item, opener) {
  if (!approvalsCurrent(view) || view.closed || $("approval-review-dialog").open) return;
  const review = recoveryReview = { view, item, opener };
  const request = item.request;
  const pairs = [["Server snapshot (UTC)", item.observedAsOf], ["Current strategy name", item.project_name], ["Saved version", `v${item.version_no}`],
    ["Version ID", item.project_version_id], ["Source hash", item.content_hash], ["Input hash", item.input_hash],
    ["Authorization ID", item.id], ["Original quote ID", item.quote_id], ["Dataset", request.dataset_id],
    ["Dates", `${request.start} to ${request.end}`], ["Starting cash", request.starting_cash],
    ["Parameters", JSON.stringify(request.params, null, 2)], ["Resource class", request.resource_class],
    ["Runtime limit", `${request.max_runtime_seconds} seconds`], ["Taker fee", `${request.taker_fee_bps} bps`],
    ["Slippage", `${request.slippage_bps} bps`], ["Approved ceiling", usd(item.reserved_nano, 9)],
    ["Approved at (UTC)", item.created_at], ["Claim deadline (UTC, 15 minutes from approval)", item.claim_expires_at]];
  $("approval-review-details").replaceChildren(...pairs.map(([label, value]) => el("div", {}, el("dt", {}, label), el("dd", {}, value))));
  $("approval-review-dialog").showModal();
  updateRecoveryReview(review);
  $("close-approval-review").focus();
}
function updateRecoveryReview(review) {
  if (!recoveryCurrent(review)) return;
  const result = recoverySubmissions.get(recoveryKey(review.view, review.item));
  const state = recoveryState(review.view, review.item), button = $("approval-review-submit");
  button.hidden = state !== "claimable" || !!result?.expired || !!result?.job;
  button.disabled = !!result?.pending || !!result?.expired || !!result?.job || state !== "claimable";
  button.textContent = result?.uncertain ? "Retry this same submission" : `Submit approved run up to ${usd(review.item.reserved_nano, 9)}`;
  $("approval-review-status").replaceChildren(result?.pending
    ? "Submission is pending. Closing this review does not cancel it. Refresh approvals to check for its run."
    : result?.job ? "Run confirmed. "
    : result?.expired ? "This unused approval expired. It cannot be submitted again. Refresh approvals to see its reservation status."
    : result?.uncertain ? (state === "claimable"
      ? "Run submission could not be confirmed. It may already exist. Refresh approvals, or explicitly retry this same authorization and original submission key. A retry cannot extend the claim deadline."
      : "Run submission could not be confirmed. It may already exist. The claim deadline passed, so submission is unavailable. Refresh approvals to find an existing run.")
    : result?.error ? `Submission was rejected: ${result.error} Refresh approvals to check whether a run was created elsewhere.`
    : state === "claimable" ? "Review the saved inputs above. Confirming can start billable compute under the exact approved ceiling. The server checks the claim deadline again."
    : state === "released" ? "This unused approval is closed and its reservation was released. It cannot start a run."
    : "The claim deadline passed. The reservation was still held at the last check. Refresh can show a later release; viewing this record does not release it.");
  if (result?.job) $("approval-review-status").append(el("a", { href: `#run/${result.job.id}` }, "Open existing run"));
}
$("approvals-refresh").addEventListener("click", () => {
  if (approvalsView && approvalsCurrent(approvalsView) && !approvalsView.loading) showApprovals(approvalsView.scope);
});
$("load-more-approvals").addEventListener("click", () => showApprovals(approvalsView?.scope, true));
$("approval-review-refresh").addEventListener("click", () => {
  if (recoveryReview && recoveryCurrent(recoveryReview)) showApprovals(recoveryReview.view.scope);
});
$("close-approval-review").addEventListener("click", closeRecoveryReview);
$("approval-review-dialog").addEventListener("cancel", event => { event.preventDefault(); closeRecoveryReview(); });
$("approval-review-dialog").addEventListener("close", () => {
  if (!$("approval-review-dialog").open) { recoveryReview = null; $("approval-review-submit").disabled = true; }
});
$("approval-review-submit").addEventListener("click", async () => {
  const review = recoveryReview;
  if (!review || !recoveryCurrent(review) || review.view.closed) return;
  updateRecoveryReview(review);
  if ($("approval-review-submit").disabled) return;
  const key = recoveryKey(review.view, review.item), result = { pending: true };
  recoverySubmissions.set(key, result);
  updateRecoveryReview(review);
  try {
    const job = await api("/v1/jobs", { method: "POST", body: { authorization_id: review.item.id },
      headers: { "idempotency-key": `quote-${review.item.quote_id}` } });
    if (!publicationId(job?.id) || job.authorization_id !== review.item.id || job.org_id !== review.view.org ||
        job.project_version_id !== review.item.project_version_id ||
        !Number.isSafeInteger(job.budget?.reserved_nano) || job.budget.reserved_nano !== review.item.reserved_nano ||
        typeof job.state !== "string" || !job.state) {
      throw new Error("The run response could not be verified.");
    }
    result.job = { id: job.id, state: job.state };
    if (!recoveryCurrent(review)) return;
    say("Run confirmed.");
    const destination = `#run/${job.id}`;
    closeRecoveryReview();
    location.hash = destination;
    refreshBalance(() => state.org === review.view.org && state.user === review.view.user && location.hash === destination &&
      (routeGeneration === review.view.generation || routeGeneration === review.view.generation + 1));
  } catch (error) {
    if (error.status === 410) result.expired = true;
    else if (!error.status || error.status >= 500) result.uncertain = true;
    else result.error = error.message;
    if (approvalsCurrent(review.view) && [401, 403, 404].includes(error.status)) {
      review.view.closed = true; review.view.rows = []; review.view.cursor = null;
      review.view.load++; review.view.loading = false;
      $("approvals-refresh").disabled = false;
      clearTimeout(review.view.timer);
      closeRecoveryReview();
      $("approval-list").replaceChildren();
      $("load-more-approvals").hidden = true;
      $("approvals-status").textContent = "Submission is unavailable for this account or workspace. Refresh with an authorized account before trying again.";
    }
  } finally {
    result.pending = false;
    if (recoveryCurrent(review)) updateRecoveryReview(review);
  }
});

// ---------------------------------------------------------------- runs
const outcomeClass = { completed: "good", failed: "bad", incomplete: "warn", cancelled: "warn" };

let runRows = [], runCursor = null, runScope = null, runLoad = 0;
const profitable = (v) => v == null ? "Unavailable" : `${Number(v).toFixed(2)}%`;

async function showRuns(projectId, more = false) {
  $("open-approvals").href = projectId ? `#approvals/${encodeURIComponent(projectId)}` : "#approvals";
  if (more && (!runCursor || $("load-more-runs").disabled)) return;
  const request = ++runLoad, generation = routeGeneration, origin = location.hash;
  const current = () => request === runLoad && generation === routeGeneration && origin === location.hash;
  if (!more) {
    runRows = []; runCursor = null; runScope = projectId || null;
    $("run-list").replaceChildren();
    $("runs-scope").textContent = "Loading run history…";
  }
  $("load-more-runs").hidden = true;
  $("load-more-runs").disabled = true;
  if (!state.org) {
    $("runs-scope").textContent = "Backtests require a connected account, database storage and isolated Python compute. Device-local strategies have no server run history.";
    $("run-list").replaceChildren(el("li", { class: "muted" }, "No backtests have been run here."));
    return;
  }
  try {
    const query = new URLSearchParams({ limit: "50" });
    if (runScope) query.set("project_id", runScope);
    if (more && runCursor) query.set("cursor", runCursor);
    const result = await api(`/v1/orgs/${state.org}/jobs?${query}`);
    if (!current()) return;
    const known = new Set(runRows.map((j) => j.id));
    runRows.push(...result.jobs.filter((j) => !known.has(j.id)));
    runCursor = result.next_cursor;
    renderRuns();
    $("load-more-runs").hidden = !runCursor;
    $("runs-scope").replaceChildren(`${runRows.length} runs loaded${runCursor ? " · older runs are available below" : " · all available runs"}. `);
    if (runScope) $("runs-scope").append(el("a", { href: "#runs" }, "Show all strategies"));
  } catch (e) {
    if (current()) {
      fail(e);
      if (!more) $("runs-scope").textContent = "Could not load run history. Reopen this view to try again.";
      $("load-more-runs").hidden = !runCursor;
    }
  }
  finally { if (current()) $("load-more-runs").disabled = false; }
}

function renderRuns() {
  const groups = new Map();
  for (const job of runRows) {
    const id = job.project_id || "unknown";
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(job);
  }
  $("run-list").replaceChildren(...[...groups].map(([id, jobs]) => {
    const newest = jobs[0], total = newest.project_run_count || jobs.length;
    const label = `${jobs.length}${total > jobs.length ? ` of ${total}` : ""} runs · latest ${when(newest.created_at)}`;
    const summary = el("summary", {}, newest.project_name || "Strategy", el("span", { class: "sub" }, label));
    const details = el("details", {}, summary,
      el("ul", { class: "strategy-history" }, ...jobs.map((j) => {
        const a = el("a", { href: `#run/${j.id}`, class: ["failed", "incomplete"].includes(j.outcome) ? "alert" : "" },
          `${when(j.created_at)} · ${j.outcome ?? j.state}`,
          el("span", { class: "sub" }, `v${j.version_no ?? "?"} · ${j.dataset_id} · ${j.start || ""} to ${j.end || ""}`),
          el("span", { class: "run-profit" }, profitable(j.metrics?.percent_profitable)),
          el("span", { class: "sub" }, "Profitable closed trades · after fees"),
          el("span", { class: "sub" }, j.charge_nano == null ? `Up to ${usd(j.reserved_nano)} reserved` : `Charged ${usd(j.charge_nano)}`));
        return el("li", {}, a);
      })));
    if (runScope) details.open = true;
    if (total > jobs.length && id !== "unknown") details.append(el("a", { href: `#runs/${id}`, class: "small" }, "View this strategy’s full history"));
    return el("li", {}, details);
  }));
  if (!runRows.length) $("run-list").append(el("li", { class: "muted" }, "No runs yet. Open a saved strategy to prepare a backtest."));
}
$("load-more-runs").addEventListener("click", () => showRuns(runScope, true));

let runView = null, runCancelPending = null;
const runRouteCurrent = (view) => view && view.user === state.user && view.org === state.org && view.generation === routeGeneration && location.hash === `#run/${view.id}` && !$("view-run").hidden;
const runViewCurrent = (view) => runView === view && runRouteCurrent(view);
function clearRunReport() {
  state.reportId = null;
  state.report = null;
  if (runView) { runView.equityRows = null; runView.equityPage = 0; }
  charts.equity?.setData([]);
  for (const id of ["run-note", "run-tiles", "run-profitability", "run-equity-heading", "equity-chart", "run-evidence", "show-run-chart", "run-report-status"]) $(id).hidden = true;
  for (const id of ["run-note", "run-tiles", "run-profitability-value", "run-profitability-definition", "run-source-details", "run-execution-details", "run-model-limitations", "run-data-details", "run-quality-summary", "run-quality-findings", "run-report-status", "run-equity-rows", "run-equity-page-status"]) $(id).replaceChildren();
  for (const detail of $("run-evidence").querySelectorAll("details")) detail.open = false;
  $("run-equity-table").hidden = true;
  $("run-equity-pages").hidden = true;
  $("run-equity-previous").disabled = true;
  $("run-equity-next").disabled = true;
  $("show-run-chart").disabled = true;
  for (const b of document.querySelectorAll("[data-artifact]")) b.disabled = true;
}

function recordedEquityTime(timestamp) {
  if (timestamp.length === 10) return `${timestamp} (date only)`;
  const iso = new Date(timestamp).toISOString(), fraction = timestamp.match(/\.(\d+)/)?.[1];
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, `${fraction ? `.${iso.slice(-4, -1).slice(0, fraction.length)}` : ""} UTC`);
}

const equityPageSize = 50;
function renderRunEquityPage() {
  const view = runView;
  if (!runViewCurrent(view) || !view.equityRows) return;
  const count = view.equityRows.length, start = view.equityPage * equityPageSize;
  $("run-equity-rows").replaceChildren(...view.equityRows.slice(start, start + equityPageSize).map((row, index) =>
    el("tr", {}, el("th", { scope: "row" }, String(start + index + 1)),
      el("td", {}, recordedEquityTime(row.timestamp)), el("td", {}, row.value))));
  $("run-equity-page-status").textContent = count
    ? `Rows ${start + 1}–${Math.min(start + equityPageSize, count)} of ${count} · Page ${view.equityPage + 1} of ${Math.ceil(count / equityPageSize)}`
    : "No equity values were recorded in this report (0 rows).";
  $("run-equity-table").hidden = !count;
  $("run-equity-pages").hidden = !count;
  $("run-equity-previous").disabled = view.equityPage === 0;
  $("run-equity-next").disabled = start + equityPageSize >= count;
}
for (const [id, step] of [["run-equity-previous", -1], ["run-equity-next", 1]]) {
  $(id).addEventListener("click", () => {
    const view = runView;
    if (!runViewCurrent(view)) { clearRunReport(); return; }
    const page = view.equityPage + step;
    if (!view.equityRows || page < 0 || page * equityPageSize >= view.equityRows.length) return;
    view.equityPage = page;
    renderRunEquityPage();
  });
}
async function showRun(id) {
  const view = { id, user: state.user, org: state.org, generation: routeGeneration, job: null, downloads: new Set() };
  if (!runRouteCurrent(view)) return;
  runView = view;
  clearTimeout(state.pollTimer);
  clearRunReport();
  $("run-state").textContent = "Loading…";
  $("run-budget").textContent = "";
  $("run-progress").value = 0;
  $("run-cancel").hidden = true;
  $("run-cancel").disabled = true;
  $("run-error").hidden = true;
  $("show-run-chart").hidden = true;
  $("run-report").hidden = true;
  $("run-receipt").replaceChildren();
  $("run-receipt-status").hidden = true;
  let job;
  try { job = await api(`/v1/jobs/${id}`); } catch (e) { if (runViewCurrent(view)) fail(e); return; }
  if (!runViewCurrent(view)) return;
  if (job.id !== id || (job.org_id != null && job.org_id !== view.org)) { fail(new Error("Run identity changed. Reopen this run to try again.")); return; }
  view.job = job;
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
  $("run-cancel").disabled = !live || !!job.cancel_requested || (runRouteCurrent(runCancelPending) && runCancelPending.id === id);
  $("run-error").hidden = !job.error;
  $("run-error").textContent = job.error || "";
  $("run-report").hidden = true;
  if (live) {
    state.pollTimer = setTimeout(() => runViewCurrent(view) && showRun(id), 1500);
    return;
  }
  refreshBalance();
  if (job.report_id) {
    try { await showReport(job, view); } catch (e) {
      if (!runViewCurrent(view)) return;
      clearRunReport();
      fillReceipt(job.receipt);
      $("run-report-status").textContent = `Performance report unavailable. ${e.message || "Reopen this run to try again."}`;
      $("run-report-status").hidden = false;
    }
  } else {
    fillReceipt(job.receipt);
    $("run-report-status").textContent = "No performance report was recorded for this run.";
    $("run-report-status").hidden = false;
  }
}

function fillReceipt(r) {
  $("run-report").hidden = false;
  for (const x of ["run-note", "run-tiles", "run-profitability", "run-equity-heading", "equity-chart", "run-evidence"]) $(x).hidden = true;
  $("run-receipt-status").hidden = !!r;
  $("run-receipt-status").textContent = r ? "" : "A receipt is not available for this run.";
  if (!r) { $("run-receipt").replaceChildren(); return; }
  const rows = [["Compute used", usd(r.supplier_cost_nano, 6)],
    [`Platform fee (${r.platform_fee_bps / 100}%)`, usd(r.platform_fee_nano, 6)],
    ["Charged", usd(r.customer_charge_nano, 6)], ["Approved maximum", usd(r.authorized_max_nano, 6)],
    ["Returned to balance", usd(r.released_nano, 6)], ["Tax", r.tax_nano == null ? "not calculated" : usd(r.tax_nano)]];
  if (r.absorbed_by_platform_nano) rows.push(["Covered by Veyra", usd(r.absorbed_by_platform_nano, 6)]);
  $("run-receipt").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}

async function showReport(job, view) {
  const rep = await api(`/v1/reports/${job.report_id}/artifacts/report.json`);
  if (!runViewCurrent(view)) return;
  const evidence = VeyraReportEvidence.read(rep, job, view.id);
  fillReceipt(job.receipt);
  for (const x of ["run-note", "run-tiles", "run-profitability", "run-equity-heading", "equity-chart", "run-evidence"]) $(x).hidden = false;
  const m = rep.metrics;
  $("run-profitability-value").textContent = profitable(m.percent_profitable);
  $("run-profitability-definition").textContent = m.closed_trade_count == null || m.winning_trade_count == null
    ? "This older report does not contain complete closed-trade counts. No missing count has been inferred."
    : `${m.winning_trade_count} profitable / ${m.closed_trade_count} closed trades. A trade runs from flat to long to flat, after all execution fees. Open positions are excluded; breakeven trades are not wins. ${Number(m.closed_trade_count) ? "" : "Unavailable until a trade closes."}`;
  $("run-note").textContent = evidence.note;
  $("run-note").hidden = !$("run-note").textContent;
  fillTiles($("run-tiles"), [["Net return", pct(m.net_return)], ["Annualized", pct(m.cagr)],
    ["Max drawdown", pct(m.max_drawdown)], ["Days below peak", m.max_drawdown_days ?? "n/a"],
    ["Sharpe (rf 0)", num(m.sharpe)], ["Closed trades", m.closed_trade_count ?? "n/a"], ["Fills", m.fill_count ?? (m.version === "metrics-v1" ? m.trade_count : null) ?? "n/a"], ["Fees paid", num(m.total_fees)],
    ["Time in market", pct(m.exposure)]]);
  const chart = makeChart("equity-chart");
  charts.equity ??= chart.addLineSeries({ color: chartColors().ink, lineWidth: 2 });
  charts.equity.setData(evidence.equity);
  chart.timeScale().fitContent();
  view.equityRows = evidence.equityRows;
  view.equityPage = 0;
  renderRunEquityPage();
  for (const [id, rows] of [["run-source-details", evidence.source], ["run-execution-details", evidence.execution], ["run-data-details", evidence.data]]) {
    $(id).replaceChildren(...rows.flatMap(([key, value]) => [el("dt", {}, key), el("dd", {}, value)]));
  }
  $("run-model-limitations").replaceChildren(...evidence.limitations.map((item) => el("li", {}, item)));
  $("run-quality-summary").textContent = evidence.qualitySummary;
  $("run-quality-findings").replaceChildren(...evidence.quality.map((item) => el("li", {}, item)));
  state.reportId = job.report_id;
  state.report = rep;
  $("show-run-chart").hidden = false;
  $("show-run-chart").disabled = false;
  for (const b of document.querySelectorAll("[data-artifact]")) b.disabled = false;
}

$("run-cancel").addEventListener("click", async () => {
  const view = runView;
  if (!runViewCurrent(view) || !view.job || view.job.state === "settled" || view.job.cancel_requested || runRouteCurrent(runCancelPending)) return;
  const attempt = runCancelPending = { id: view.id, user: view.user, org: view.org, generation: view.generation };
  $("run-cancel").disabled = true;
  try {
    await api(`/v1/jobs/${attempt.id}/cancel`, { method: "POST" });
    if (!runRouteCurrent(attempt)) return;
    say("Stop requested. A running job may use compute until its next checkpoint. The final receipt shows measured usage.");
    await showRun(attempt.id);
  } catch (e) { if (runRouteCurrent(attempt)) fail(e); }
  finally {
    if (runCancelPending === attempt) runCancelPending = null;
    if (runRouteCurrent(attempt) && runViewCurrent(runView) && runView.job) {
      $("run-cancel").disabled = runView.job.state === "settled" || !!runView.job.cancel_requested;
    }
  }
});

for (const b of document.querySelectorAll("[data-artifact]")) {
  b.addEventListener("click", async () => {
    const view = runView, id = state.reportId, artifact = b.dataset.artifact;
    if (!runViewCurrent(view) || !id || view.job?.report_id !== id || view.downloads.has(artifact)) return;
    view.downloads.add(artifact);
    b.disabled = true;
    try {
      const res = await api(`/v1/reports/${id}/artifacts/${artifact}?download=true`, { raw: true });
      const blob = await res.blob();
      if (view.user !== state.user || view.org !== state.org) return;
      const url = URL.createObjectURL(blob);
      const a = el("a", { href: url, download: `veyra-${id.slice(0, 8)}-${artifact}` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { if (runViewCurrent(view)) fail(e); }
    finally { view.downloads.delete(artifact); if (runViewCurrent(view)) b.disabled = false; }
  });
}

// ---------------------------------------------------------------- wallet
async function showWallet() {
  const user = state.user, org = state.org;
  const current = () => user === state.user && org === state.org && !$("view-wallet").hidden;
  if (!state.org) {
    $("wallet-balance").replaceChildren();
    $("usage-list").replaceChildren(el("li", { class: "muted" }, "Payments are not available yet."));
    return;
  }
  const b = await refreshBalance(current);
  if (!b || !current()) return;
  fillTiles($("wallet-balance"), [["Available", usd(b.available_nano, 4)],
    ["Reserved for runs", usd(b.reserved_nano, 4)], ["Spent to date", usd(b.settled_usage_nano, 4)]]);
  try {
    const { usage_events } = await api(`/v1/orgs/${org}/billing/usage`);
    if (!current()) return;
    $("usage-list").replaceChildren(...usage_events.map((u) => el("li", {}, el("div", {},
      `${u.meter}: ${u.units} ${u.unit}s · ${usd(u.supplier_cost_nano, 6)} supplier cost`,
      el("span", { class: "sub" }, `${when(u.created_at)} · ${u.detail.vcpus} vCPU / ${u.detail.memory_gb} GB`)))));
    if (!usage_events.length) $("usage-list").append(el("li", { class: "muted" }, "No usage yet."));
  } catch (e) { if (current()) fail(e); }
}

for (const b of document.querySelectorAll("[data-topup]")) {
  b.addEventListener("click", () => busy(b, async () => {
    const user = state.user, org = state.org;
    if (!org) return;
    const pay = await api(`/v1/orgs/${org}/billing/topups`, { method: "POST",
      body: { amount_usd: b.dataset.topup } });
    if (user !== state.user || org !== state.org) return;
    // Real checkout redirects to the payment provider; locally we confirm the test payment.
    await api(`/v1/dev/payments/${pay.id}/complete`, { method: "POST" });
    if (user !== state.user || org !== state.org) return;
    say(`Added ${usd(pay.amount_nano, 2)}`);
    showWallet();
  }).finally(() => { b.disabled = !state.org; }));
}

// ---------------------------------------------------------------- chart research
let studyBars = [], visibleStudyBars = [], rsiByTime = new Map();
let chartRunsView = null, selectedRunDate = null;
let selectedOverlay = null, overlayGroups = [], overlayImport = 0, rsiSync = false, pendingRsiRange = null;

function makeRsiChart() {
  const chart = makeChart("rsi-chart");
  if (charts.rsi) return chart;
  const colors = chartColors();
  charts.rsi = chart.addLineSeries({ color: colors.accent, lineWidth: 1, priceLineVisible: false,
    lastValueVisible: true, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
  // Whitespace-only RSI has no library base index; a hidden anchor aligns time without RSI values.
  charts.rsiTimeAnchor = chart.addLineSeries({ visible: false, priceScaleId: "time-anchor",
    lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
  for (const price of [30, 70]) charts.rsi.createPriceLine({ price, color: colors.line,
    lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
  chart.priceScale("right").applyOptions({ minimumWidth: 84, scaleMargins: { top: 0.15, bottom: 0.1 } });
  const main = charts["market-chart"];
  main.timeScale().subscribeVisibleLogicalRangeChange((range) => syncRsiRange(range));
  chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (!range || rsiSync || $("rsi-pane").hidden) return;
    // The chart library applies ranges on animation frames; ignore intermediate study ranges.
    if (pendingRsiRange) {
      if (sameChartRange(range, pendingRsiRange)) pendingRsiRange = null;
      return;
    }
    if (sameChartRange(range, main.timeScale().getVisibleLogicalRange())) return;
    rsiSync = true;
    try { main.timeScale().setVisibleLogicalRange(range); } finally { rsiSync = false; }
  });
  return chart;
}

function sameChartRange(a, b) {
  return a && b && Math.abs(a.from - b.from) < 1e-8 && Math.abs(a.to - b.to) < 1e-8;
}
function syncRsiRange(range) {
  if (!range || rsiSync || $("rsi-pane").hidden || !charts["rsi-chart"]) return;
  const scale = charts["rsi-chart"].timeScale();
  pendingRsiRange = range;
  if (sameChartRange(range, scale.getVisibleLogicalRange())) { pendingRsiRange = null; return; }
  scale.setVisibleLogicalRange(range);
}

function updateChartResearch(aggregated, visible) {
  replayTimeline = visible.map((bar) => bar.time);
  if (replay.time != null) {
    aggregated = aggregated.filter((bar) => bar.time <= replay.time);
    visible = visible.filter((bar) => bar.time <= replay.time);
  }
  studyBars = aggregated;
  visibleStudyBars = visible;
  const values = VeyraChartResearch.rsi(aggregated.map((bar) => bar.close));
  rsiByTime = new Map(aggregated.map((bar, i) => [bar.time, values[i]]));
  charts["market-chart"].applyOptions({ timeScale: { visible: $("rsi-pane").hidden } });
  if (!$("rsi-pane").hidden) {
    makeRsiChart();
    pendingRsiRange = charts["market-chart"].timeScale().getVisibleLogicalRange();
    charts.rsiTimeAnchor.setData(visible.length ? [{ time: visible.at(-1).time, value: 0 }] : []);
    charts.rsi.setData(visible.map((bar) => rsiByTime.get(bar.time) == null
      ? { time: bar.time } : { time: bar.time, value: rsiByTime.get(bar.time) }));
    syncRsiRange(charts["market-chart"].timeScale().getVisibleLogicalRange());
  }
  updateChartWorkspace(aggregated, visible);
  updateOverlay();
}

function updateOverlay() {
  const dataset = state.datasets.find((d) => d.dataset_id === $("market-dataset").value);
  for (const key of ["candles", "marketLine", "marketBarsSeries", "marketArea"]) charts[key]?.setMarkers([]);
  overlayGroups = [];
  $("overlay-readout").hidden = !selectedOverlay;
  $("overlay-details").hidden = !selectedOverlay;
  activeSeries()?.setMarkers(alertMarkers());
  if (!selectedOverlay) return;
  $("overlay-evidence").textContent = selectedOverlay.note;
  $("overlay-source").textContent = `v${selectedOverlay.version_no} · Run ${selectedOverlay.run_id}${selectedRunDate ? ` · Created ${selectedRunDate}` : ""} · ${selectedOverlay.provider} · ${selectedOverlay.dataset_id} · ${selectedOverlay.range.start} to ${selectedOverlay.range.end} UTC (end exclusive)`;
  if (!dataset || dataset.dataset_id !== selectedOverlay.dataset_id) {
    $("overlay-summary").textContent = "Overlay hidden: select its matching synthetic asset.";
    return;
  }
  try {
    const overlay = VeyraChartResearch.buildOverlay(selectedOverlay, { dataset, candles: visibleStudyBars, interval: marketInterval });
    const colors = chartColors();
    const markers = overlay.markers.map((marker) => ({ ...marker, color: marker.position === "belowBar" ? colors.ink : colors.accent }));
    activeSeries().setMarkers([...markers, ...alertMarkers()].sort((a, b) => a.time - b.time));
    overlayGroups = overlay.groups;
    $("overlay-summary").textContent = `${selectedOverlay.complete ? "Backtest" : "Incomplete backtest"} · ${overlay.summary.displayedFills}/${overlay.summary.totalFills} fills shown · imported claims unverified`;
    $("report-import-status").textContent = `Run ${selectedOverlay.run_id.slice(0, 12)} · source data hashes match · ${selectedOverlay.fills.length} recorded fills`;
  } catch (e) { $("overlay-summary").textContent = e.message; }
}

function showOverlayFills(time = null) {
  if (!selectedOverlay) return;
  const groups = time == null ? overlayGroups : overlayGroups.filter((group) => group.time === time);
  const indices = groups.flatMap((group) => group.fillIndices).sort((a, b) => a - b);
  const fills = indices.slice(0, 100).map((i) => selectedOverlay.fills[i]);
  $("overlay-fill-list").replaceChildren(...fills.map((fill) => el("li", {},
    `${isoDay(new Date(fill.time * 1000))} UTC · ${fill.side === "buy" ? "Buy" : "Sell"} ${fill.qty} @ ${fill.price} · fee ${fill.fee}`)));
  if (!fills.length) $("overlay-fill-list").append(el("li", {}, "No recorded fills in this visible selection."));
  if (indices.length > fills.length) $("overlay-fill-list").append(el("li", {}, `Showing the first ${fills.length} of ${indices.length} fills. Narrow the chart range or select a marked candle.`));
}

async function importReport(text, dataset, sourceBars, request = ++overlayImport, current = () => true) {
  $("report-import-status").textContent = "Checking source data and recorded fills…";
  const report = await VeyraChartResearch.validateReportJSON(text, { dataset, sourceBars });
  if (!current() || request !== overlayImport || !$("report-overlay-dialog").open || $("view-markets").hidden || $("market-dataset").value !== dataset.dataset_id) throw new Error("The import was cancelled or the selected chart changed. Import the report again.");
  selectedOverlay = report;
  selectedRunDate = null;
  updateOverlay();
  showOverlayFills();
  return report;
}

const chartRunsCurrent = (view) => view && view === chartRunsView && view.user === state.user && view.org === state.org &&
  view.generation === routeGeneration && view.origin === location.hash && $("report-overlay-dialog").open && !$("view-markets").hidden;
function closeChartRuns() {
  chartRunsView = null;
  $("chart-run-list").replaceChildren();
  $("chart-runs-more").hidden = true;
  $("chart-runs-refresh").disabled = !state.user || !state.org;
  $("chart-runs-status").textContent = state.user && state.org ? "" : "Connect an account to browse saved backtests. You can still import a report file locally.";
  $("chart-run-selection-status").textContent = "";
}
function renderChartRuns(view) {
  $("chart-run-list").replaceChildren(...VeyraChartResearch.groupSavedRuns(view.rows).map((group) => {
    const details = el("details", { open: "" }, el("summary", {}, group.name));
    for (const { date, runs } of group.dates) {
      details.append(el("h3", {}, `${date} UTC`));
      for (const row of runs) {
        const reason = row.unavailable || (!state.datasets.some((d) => d.dataset_id === row.dataset_id) ? "Dataset unavailable on chart" : null);
        const button = el("button", { type: "button", "data-chart-run": row.id },
          `v${row.version_no} · ${row.outcome || row.state} · ${row.created_at.replace("T", " ")}`,
          el("span", { class: "sub" }, `${row.dataset_id || "Dataset not recorded"} · ${row.start || "?"} to ${row.end || "?"} (end exclusive)`),
          el("span", { class: "sub" }, `Run ${row.id} · ${reason || "Show recorded simulation fills"}`));
        button.disabled = !!reason;
        button.addEventListener("click", () => selectChartRun(view, row));
        details.append(button);
      }
    }
    return el("li", {}, details);
  }));
}
async function loadChartRuns(more = false) {
  if (more && (!chartRunsCurrent(chartRunsView) || chartRunsView.loading || !chartRunsView.cursor)) return;
  if (!more) {
    cancelReportImport();
    closeChartRuns();
    chartRunsView = { user: state.user, org: state.org, generation: routeGeneration, origin: location.hash,
      rows: [], cursors: [], cursor: null, pages: 0, loading: false, selection: 0 };
  }
  const view = chartRunsView;
  if (!chartRunsCurrent(view) || !view.user || !view.org) return;
  view.loading = true;
  $("chart-runs-refresh").disabled = true;
  $("chart-runs-more").disabled = true;
  $("chart-runs-status").textContent = more ? "Loading older runs…" : "Loading saved backtests…";
  try {
    const query = new URLSearchParams({ limit: String(VeyraChartResearch.SAVED_RUN_LIMITS.pageSize) });
    if (more) query.set("cursor", view.cursor);
    const result = await api(`/v1/orgs/${encodeURIComponent(view.org)}/jobs?${query}`);
    if (!chartRunsCurrent(view)) return;
    let page;
    try { page = VeyraChartResearch.readSavedRunPage(result, view.rows, view.cursors); }
    catch (error) { view.cursor = null; throw error; }
    view.rows = page.rows;
    view.pages++;
    if (page.cursor) view.cursors.push(page.cursor);
    view.cursor = view.pages < VeyraChartResearch.SAVED_RUN_LIMITS.pages ? page.cursor : null;
    renderChartRuns(view);
    $("chart-runs-status").textContent = !view.rows.length ? "No saved runs in this workspace. You can import a report file below."
      : `${view.rows.length} runs loaded · newest first. ${view.cursor ? "Load older runs to see more." : page.cursor ? "Chart list limit reached. Use Backtest history for older runs." : "All available runs loaded."}`;
  } catch (error) {
    if (!chartRunsCurrent(view)) return;
    if ([401, 403, 404].includes(error.status)) {
      view.selection++;
      view.rows = []; view.cursor = null; renderChartRuns(view);
      if (/^(Loading|Checking)/.test($("chart-run-selection-status").textContent)) $("chart-run-selection-status").textContent = "Saved selection cancelled because workspace access is unavailable. The existing overlay was left unchanged.";
    }
    $("chart-runs-status").textContent = `Saved backtests unavailable. ${error.message} ${view.rows.length ? "Previously loaded rows are unchanged. " : ""}Refresh to try again.`;
  } finally {
    if (chartRunsCurrent(view)) {
      view.loading = false;
      $("chart-runs-refresh").disabled = false;
      $("chart-runs-more").disabled = false;
      $("chart-runs-more").hidden = !view.cursor;
    }
  }
}
async function selectChartRun(view, row) {
  if (!chartRunsCurrent(view) || row.unavailable || !view.rows.includes(row)) return;
  cancelReportImport();
  const selection = ++view.selection, request = overlayImport, asset = $("market-dataset").value, market = marketRequest;
  const current = () => chartRunsCurrent(view) && selection === view.selection && view.rows.includes(row) && request === overlayImport && asset === $("market-dataset").value && market === marketRequest;
  $("chart-run-selection-status").textContent = "Loading saved run and report…";
  try {
    const job = await api(`/v1/jobs/${row.id}`);
    if (!current()) return;
    VeyraChartResearch.checkSavedRun(job, row, view.org);
    const report = await api(`/v1/reports/${job.report_id}/artifacts/report.json`);
    if (!current()) return;
    VeyraReportEvidence.read(report, job, row.id);
    if (report.provenance?.code?.version_no !== row.version_no || report.provenance?.dataset?.start !== row.start ||
      report.provenance?.dataset?.end !== row.end) throw new Error("Recorded report version or date range does not match this run.");
    const dataset = state.datasets.find((d) => d.dataset_id === row.dataset_id);
    if (!dataset) throw new Error("This report’s dataset is unavailable on the chart.");
    $("chart-run-selection-status").textContent = "Checking source hashes and recorded simulation fills…";
    const bars = await assetBars(dataset);
    if (!current()) return;
    const overlay = await VeyraChartResearch.validateReportJSON(JSON.stringify(report), { dataset, sourceBars: bars });
    if (!current()) return;
    // Commit only the fully validated snapshot, without an intervening asynchronous chart load.
    marketRequest++;
    $("market-dataset").value = dataset.dataset_id;
    selectedOverlay = overlay;
    selectedRunDate = row.created_at;
    if (charts.candles) clearTrends();
    displayMarketBars(dataset, bars);
    showOverlayFills();
    $("chart-run-selection-status").textContent = `Run ${row.id} loaded · recorded simulation fills only. Source data hashes match; fill claims remain unverified.`;
  } catch (error) {
    if (current()) $("chart-run-selection-status").textContent = `Report unavailable on chart. ${error.message} The existing chart and overlay were left unchanged.`;
  }
}
$("chart-runs-refresh").addEventListener("click", () => loadChartRuns());
$("chart-runs-more").addEventListener("click", () => loadChartRuns(true));

function cancelReportImport() {
  overlayImport++;
  $("chart-run-selection-status").textContent = /^(Loading|Checking)/.test($("chart-run-selection-status").textContent)
    ? "Selection cancelled. The existing overlay was left unchanged." : "";
  $("report-file").value = "";
  if (/^(Reading|Checking)/.test($("report-import-status").textContent)) $("report-import-status").textContent = "Import cancelled. The existing overlay was left unchanged.";
}
function openResearchDialog(id) {
  if ($(id).open) return;
  if (id === "report-overlay-dialog") cancelReportImport();
  $(id).showModal();
  if (id === "report-overlay-dialog") loadChartRuns();
}
function closeResearchDialog(id) {
  if (id === "report-overlay-dialog") { cancelReportImport(); closeChartRuns(); }
  $(id).close();
}
for (const [trigger, dialog, close] of [["chart-indicators", "indicator-dialog", "close-indicators"], ["chart-report", "report-overlay-dialog", "close-report-overlay"]]) {
  $(trigger).addEventListener("click", () => { closeSheets(); openResearchDialog(dialog); if (dialog === "report-overlay-dialog") showOverlayFills(); else showIndicators("home"); });
  $(close).addEventListener("click", () => closeResearchDialog(dialog));
  $(dialog).addEventListener("cancel", () => { if (dialog === "report-overlay-dialog") { cancelReportImport(); closeChartRuns(); } });
  $(dialog).addEventListener("close", () => {
    if ($(dialog).open) return;
    if (dialog === "report-overlay-dialog") { cancelReportImport(); closeChartRuns(); }
    if (!$("view-markets").hidden) ($(trigger).isConnected && $(trigger).offsetParent ? $(trigger) : $("open-hub")).focus();
  });
}
$("report-file").addEventListener("change", async () => {
  const file = $("report-file").files?.[0];
  if (!file) return;
  cancelReportImport();
  const request = overlayImport, user = state.user, org = state.org, generation = routeGeneration;
  const current = () => request === overlayImport && user === state.user && org === state.org && generation === routeGeneration;
  $("report-import-status").textContent = "Reading report locally…";
  try {
    if (file.size > VeyraChartResearch.LIMITS.reportBytes) throw new Error("Report JSON exceeds the 4 MiB import limit.");
    const dataset = state.datasets.find((d) => d.dataset_id === $("market-dataset").value);
    if (!dataset || !marketBars.length) throw new Error("Load the report’s asset chart before importing.");
    const sourceBars = marketBars;
    const text = await file.text();
    if (!current() || !$("report-overlay-dialog").open) return;
    await importReport(text, dataset, sourceBars, request, current);
  } catch (e) { if (current()) $("report-import-status").textContent = e.message; }
  finally { if (current()) $("report-file").value = ""; }
});
$("clear-overlay").addEventListener("click", () => {
  cancelReportImport();
  selectedOverlay = null;
  selectedRunDate = null;
  updateOverlay();
  $("report-import-status").textContent = "Overlay cleared. No strategy or backtest was changed.";
  $("overlay-fill-list").replaceChildren();
});
$("show-run-chart").addEventListener("click", async (e) => {
  const report = state.report, view = runView, button = e.currentTarget;
  if (!report || !runViewCurrent(view) || button.disabled) return;
  button.disabled = true;
  try {
    const dataset = state.datasets.find((d) => d.dataset_id === report.provenance?.dataset?.dataset_id);
    if (!dataset) throw new Error("This report's dataset is not available on the chart.");
    const bars = await assetBars(dataset);
    if (!runViewCurrent(view)) return;
    const overlay = await VeyraChartResearch.validateReportJSON(JSON.stringify(report), { dataset, sourceBars: bars });
    if (!runViewCurrent(view)) return;
    selectedOverlay = overlay;
    selectedRunDate = null;
    $("market-dataset").value = dataset.dataset_id;
    location.hash = "#markets";
    await showMarkets();
  } catch (error) { if (runViewCurrent(view)) fail(error); }
  finally { if (runViewCurrent(view)) button.disabled = false; }
});


// ---------------------------------------------------------------- explicit public snapshots
const publicationId = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
function publicationLink(id) {
  if (!publicationId(id)) throw new Error("Invalid publication identity.");
  const url = new URL(location.href);
  url.search = "";
  url.hash = `public/${id}`;
  return url.href;
}
function checkPublicMetadata(item) {
  if (!item || !publicationId(item.id) || typeof item.title !== "string" || typeof item.description !== "string" ||
      typeof item.entrypoint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item.content_hash)) throw new Error("Snapshot metadata is unavailable.");
  return item;
}
function checkSnapshot(item) {
  if (!item || !item.files || typeof item.files !== "object" || Array.isArray(item.files) ||
      !Object.hasOwn(item.files, item.entrypoint) || !Object.keys(item.files).length || Object.keys(item.files).length > 50 ||
      Object.values(item.files).some((source) => typeof source !== "string")) throw new Error("Snapshot source is unavailable.");
  return item;
}
function snapshotIdentity(target, item, owner = false) {
  const pairs = owner ? [["Saved version", `v${item.version_no} · ${item.id}`]] : [["Published", when(item.published_at)]];
  pairs.push(["Entrypoint", item.entrypoint], ["Content hash", item.content_hash]);
  target.replaceChildren(...pairs.flatMap(([name, value]) => [el("dt", {}, name), el("dd", {}, value)]));
}
function sourceSelector(select, source, item) {
  select.replaceChildren(...Object.keys(item.files).map((name) => el("option", { value: name }, name)));
  select.value = item.entrypoint;
  source.textContent = item.files[item.entrypoint];
}

let discoverRequest = 0, discoverOffset = 0, discoverQuery = "", publicSnapshot = null, publicRequest = 0;
const discoverPageSize = 20;
async function showDiscover() {
  const request = ++discoverRequest, generation = routeGeneration, offset = discoverOffset;
  const saved = location.hash === "#discover/saved";
  $("discover-public").hidden = saved;
  $("saved-links-library").hidden = !saved;
  for (const [id, active] of [["discover-public-tab", !saved], ["discover-saved-tab", saved]]) {
    if (active) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current");
  }
  if (saved) { renderSavedLinks(); return; }
  $("discover-list").replaceChildren();
  $("discover-status").textContent = "Loading public snapshots…";
  for (const id of ["discover-prev", "discover-next"]) $(id).disabled = true;
  $("discover-retry").hidden = true;
  try {
    const query = new URLSearchParams({ q: discoverQuery, limit: String(discoverPageSize + 1), offset: String(offset) });
    const result = await api(`/v1/public/strategies?${query}`, { anonymous: true });
    if (request !== discoverRequest || generation !== routeGeneration) return;
    const rows = result.strategies.map(checkPublicMetadata), page = rows.slice(0, discoverPageSize);
    $("discover-list").replaceChildren(...page.map((item) => el("li", {},
      el("a", { href: publicationLink(item.id) }, item.title,
        el("p", { class: "publication-description" }, item.description),
        el("span", { class: "sub" }, `Published ${when(item.published_at)} · read-only source`)))));
    $("discover-status").textContent = page.length
      ? `Showing ${offset + 1}–${offset + page.length} · newest first${offset === 10000 ? " · browse limit reached; narrow your search" : ""}`
      : offset ? "No more public snapshots. Return to the previous page or search again." : discoverQuery ? "No public snapshots match this search." : "No public strategies have been published yet.";
    $("discover-prev").disabled = offset === 0;
    $("discover-next").disabled = rows.length <= discoverPageSize || offset >= 10000;
  } catch (error) {
    if (request !== discoverRequest || generation !== routeGeneration) return;
    $("discover-status").textContent = `Public discovery is unavailable. ${error.message}`;
    $("discover-retry").hidden = false;
    $("discover-prev").disabled = offset === 0;
  }
}
$("discover-form").addEventListener("submit", (event) => {
  event.preventDefault();
  discoverQuery = $("discover-search").value.trim();
  discoverOffset = 0;
  showDiscover();
});
$("discover-prev").addEventListener("click", () => { discoverOffset = Math.max(0, discoverOffset - discoverPageSize); showDiscover(); });
$("discover-next").addEventListener("click", () => { discoverOffset = Math.min(10000, discoverOffset + discoverPageSize); showDiscover(); });
$("discover-retry").addEventListener("click", showDiscover);

async function showPublicStrategy(id) {
  if ($("public-copy-dialog").open) closePublicCopy();
  const request = ++publicRequest, generation = routeGeneration;
  publicSnapshot = null;
  $("public-content").hidden = true;
  $("public-source").textContent = "";
  $("public-title").textContent = "Public strategy";
  $("public-status").textContent = "Loading published source…";
  $("public-retry").hidden = true;
  if (!publicationId(id)) { $("public-status").textContent = "This public link is unavailable or has been revoked."; return; }
  try {
    const item = checkSnapshot(checkPublicMetadata(await api(`/v1/public/strategies/${id}`, { anonymous: true })));
    if (request !== publicRequest || generation !== routeGeneration) return;
    if (item.id !== id) throw new Error("Snapshot identity changed. Open the link again.");
    publicSnapshot = item;
    $("public-title").textContent = item.title;
    $("public-description").textContent = item.description;
    snapshotIdentity($("public-identity"), item);
    sourceSelector($("public-file"), $("public-source"), item);
    $("public-content").hidden = false;
    renderPublicSavedLink();
    $("public-status").textContent = `${Object.keys(item.files).length} published source files · immutable snapshot`;
  } catch (error) {
    if (request !== publicRequest || generation !== routeGeneration) return;
    $("public-status").textContent = error.status === 404 ? "This public link is unavailable or has been revoked." : `Published source is unavailable. ${error.message}`;
    $("public-retry").hidden = error.status === 404;
  }
}
$("public-retry").addEventListener("click", () => showPublicStrategy(location.hash.split("/")[1]));
$("public-file").addEventListener("change", () => { if (publicSnapshot) $("public-source").textContent = publicSnapshot.files[$("public-file").value]; });
$("public-download-file").addEventListener("click", () => {
  const name = $("public-file").value;
  if (publicSnapshot && location.hash === `#public/${publicSnapshot.id}` && Object.hasOwn(publicSnapshot.files, name)) {
    downloadText(publicSnapshot.files[name], name.split(/[\\/]/).pop(), "text/plain");
  }
});
$("public-download-snapshot").addEventListener("click", () => {
  if (publicSnapshot && location.hash === `#public/${publicSnapshot.id}`) downloadText(JSON.stringify({
    files: publicSnapshot.files, entrypoint: publicSnapshot.entrypoint,
  }, null, 2), `veyra-public-${publicSnapshot.id}.json`, "application/json");
});

// Private device bookmarks contain metadata only; opening uses the ordinary live public route.
const localSavedLinks = VeyraSavedLinks.create(browserStorage);
let savedLinkReview = null;
const savedLinkCurrent = (review) => savedLinkReview === review && $("saved-link-dialog").open &&
  routeGeneration === review.generation && location.hash === review.origin && state.user === review.user && state.org === review.org &&
  (review.snapshot ? !$("view-public").hidden && publicSnapshot === review.snapshot && publicRequest === review.request
    : !$("view-discover").hidden && location.hash === "#discover/saved");
function renderPublicSavedLink() {
  if (!publicSnapshot || $("view-public").hidden) return;
  const button = $("public-save-link");
  button.disabled = false;
  try {
    const saved = localSavedLinks.listLinks().links.some((link) => link.publication_id === publicSnapshot.id.toLowerCase());
    button.textContent = saved ? "Saved on device" : "Save link";
    button.setAttribute("aria-pressed", String(saved));
    $("public-save-status").textContent = saved ? "This link is saved on this device. Review to move or remove it."
      : "Save a private bookmark for later. Source is not saved.";
  } catch (error) {
    button.disabled = true;
    $("public-save-status").textContent = error.message;
  }
}
function renderSavedLinks() {
  if (location.hash !== "#discover/saved" || $("view-discover").hidden) return;
  $("saved-links-list").replaceChildren();
  $("saved-links-retry").hidden = true;
  try {
    const links = localSavedLinks.listLinks().links, select = $("saved-links-folder"), chosen = select.value;
    const folders = [...new Set(links.map((link) => link.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    select.replaceChildren(el("option", { value: "" }, "All folders"), el("option", { value: "unfiled" }, "Unfiled"),
      ...folders.map((name) => el("option", { value: `folder:${name}` }, name)));
    select.value = [...select.options].some((option) => option.value === chosen) ? chosen : "";
    const query = $("saved-links-search").value.trim().toLocaleLowerCase(), filter = select.value;
    const rows = links.filter((link) => (!filter || (filter === "unfiled" ? !link.folder : filter === `folder:${link.folder}`)) &&
      `${link.saved_title} ${link.folder}`.toLocaleLowerCase().includes(query));
    $("saved-links-list").replaceChildren(...rows.map((link) => {
      const manage = el("button", { type: "button", "data-saved-link": link.publication_id, "aria-haspopup": "dialog" }, "Move / remove");
      manage.addEventListener("click", () => openSavedLink(link.publication_id));
      return el("li", {}, el("span", { class: "sub" }, "Saved title"),
        el("a", { href: publicationLink(link.publication_id) }, link.saved_title),
        el("p", { class: "small muted" }, `${link.folder || "Unfiled"} · Saved ${when(link.created_at)}`),
        el("p", { class: "small muted" }, "Availability checked when opened."), el("div", { class: "compact-actions" }, manage));
    }));
    $("saved-links-status").textContent = !links.length ? "No links saved on this device. Open a public snapshot and choose Save link."
      : !rows.length ? "No saved links match this search or folder." : `${rows.length} saved link${rows.length === 1 ? "" : "s"} on this device.`;
  } catch (error) {
    $("saved-links-status").textContent = error.message;
    $("saved-links-retry").hidden = false;
  }
}
function restoreSavedLinkFocus(review) {
  if (!review || location.hash !== review.origin || routeGeneration !== review.generation ||
      state.user !== review.user || state.org !== review.org || $("saved-link-dialog").open) return;
  const target = review.snapshot ? $("public-save-link")
    : $("saved-links-list").querySelector(`[data-saved-link="${review.id}"]`) || $("saved-links-search");
  target.focus();
}
function closeSavedLink() {
  const review = savedLinkReview;
  savedLinkReview = null;
  $("saved-link-name").textContent = "";
  $("saved-link-folder").value = "";
  $("saved-link-status").textContent = "";
  $("saved-link-dialog").close();
  restoreSavedLinkFocus(review);
}
function openSavedLink(id, snapshot = null) {
  if ($("saved-link-dialog").open || (snapshot ? snapshot !== publicSnapshot || $("view-public").hidden || location.hash !== `#public/${snapshot.id}`
    : $("view-discover").hidden || location.hash !== "#discover/saved")) return;
  try {
    const links = localSavedLinks.listLinks().links, saved = links.find((link) => link.publication_id === id.toLowerCase());
    if (!saved && !snapshot) { renderSavedLinks(); return; }
    const review = { saved, id, snapshot, request: publicRequest, generation: routeGeneration, origin: location.hash,
      user: state.user, org: state.org, pending: false };
    savedLinkReview = review;
    $("saved-link-title").textContent = saved ? "Manage saved link" : "Save link on this device";
    $("saved-link-name").textContent = saved ? saved.saved_title : snapshot.title;
    $("saved-link-folder").value = saved?.folder || "";
    $("saved-link-folder").disabled = false;
    $("saved-link-folders").replaceChildren(...[...new Set(links.map((link) => link.folder).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b)).map((name) => el("option", { value: name })));
    $("saved-link-confirm").textContent = saved ? "Save private folder" : "Save link on device";
    $("saved-link-confirm").disabled = false;
    $("saved-link-remove").hidden = !saved;
    $("saved-link-remove").disabled = false;
    $("saved-link-status").textContent = saved ? "This title was saved earlier. Opening the public link checks current availability." : "Choose a private folder or leave this link unfiled.";
    $("saved-link-dialog").showModal();
    $("saved-link-folder").focus();
  } catch (error) {
    if (snapshot) $("public-save-status").textContent = error.message;
    else { renderSavedLinks(); $("saved-links-status").textContent = error.message; }
  }
}
async function changeSavedLink(remove = false) {
  const review = savedLinkReview;
  if (!review || review.pending || !savedLinkCurrent(review) || (remove && !review.saved)) return;
  const folder = $("saved-link-folder").value;
  const current = () => savedLinkCurrent(review) && $("saved-link-folder").value === folder;
  review.pending = true;
  for (const id of ["saved-link-confirm", "saved-link-remove", "saved-link-folder"]) $(id).disabled = true;
  $("saved-link-status").textContent = "Waiting to update this device’s saved links…";
  let alreadySaved = false;
  try {
    const result = await localWrite(() => {
      if (!current()) return null;
      if (review.saved) return remove ? localSavedLinks.removeLink(review.id, { expected_updated_at: review.saved.updated_at })
        : localSavedLinks.moveLink(review.id, { folder, expected_updated_at: review.saved.updated_at });
      alreadySaved = localSavedLinks.listLinks().links.some((link) => link.publication_id === review.id.toLowerCase());
      return localSavedLinks.saveLink({ publication_id: review.id, saved_title: review.snapshot.title, folder });
    });
    if (!result || !current()) return;
    closeSavedLink();
    renderPublicSavedLink();
    renderSavedLinks();
    restoreSavedLinkFocus(review);
    say(remove ? "Saved link removed from this device." : alreadySaved ? "This link was already saved. Its existing private folder was kept."
      : review.saved ? "Private folder saved on this device." : "Link saved on this device.");
  } catch (error) { if (current()) $("saved-link-status").textContent = error.message; }
  finally {
    if (savedLinkCurrent(review)) {
      review.pending = false;
      for (const id of ["saved-link-confirm", "saved-link-remove", "saved-link-folder"]) $(id).disabled = false;
    }
  }
}
$("public-save-link").addEventListener("click", () => { if (publicSnapshot) openSavedLink(publicSnapshot.id, publicSnapshot); });
$("saved-link-form").addEventListener("submit", (event) => { event.preventDefault(); changeSavedLink(); });
$("saved-link-remove").addEventListener("click", () => changeSavedLink(true));
for (const id of ["saved-link-close", "saved-link-cancel"]) $(id).addEventListener("click", closeSavedLink);
$("saved-link-dialog").addEventListener("cancel", (event) => { event.preventDefault(); closeSavedLink(); });
$("saved-link-dialog").addEventListener("close", () => { if (!$("saved-link-dialog").open) savedLinkReview = null; });
$("saved-links-search").addEventListener("input", renderSavedLinks);
$("saved-links-folder").addEventListener("change", renderSavedLinks);
$("saved-links-retry").addEventListener("click", renderSavedLinks);
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== "veyra.saved-links.v1") return;
  renderPublicSavedLink();
  renderSavedLinks();
});

// Copy only the reviewed public source; private metadata starts fresh and no cloud write is involved.
let publicCopyReview = null;
const publicCopyCurrent = (review) => publicCopyReview === review && $("public-copy-dialog").open &&
  !$("view-public").hidden && state.user === review.user && state.org === review.org &&
  publicSnapshot === review.snapshot && publicRequest === review.request &&
  routeGeneration === review.generation && location.hash === `#public/${review.snapshot.id}` &&
  $("public-file").value === review.file;
function publicCopyPreview(snapshot, name) {
  return VeyraStrategyBackup.importJSON(JSON.stringify({ format: VeyraStrategyBackup.FORMAT,
    schema_version: VeyraStrategyBackup.SCHEMA_VERSION, name, description: "", folder: "",
    files: snapshot.files, entrypoint: snapshot.entrypoint, has_unsaved_changes: false }));
}
async function recheckPublicCopy(review) {
  const fresh = checkSnapshot(checkPublicMetadata(await api(`/v1/public/strategies/${review.source.id}`, { anonymous: true })));
  const original = review.source, paths = Object.keys(original.files);
  if (["id", "title", "description", "published_at", "entrypoint", "content_hash"].some((key) => fresh[key] !== original[key]) ||
      Object.keys(fresh.files).length !== paths.length || paths.some((path) => !Object.hasOwn(fresh.files, path) || fresh.files[path] !== original.files[path])) {
    throw new Error("Published snapshot changed. Close this review and reopen the public link before copying.");
  }
}
function closePublicCopy() {
  publicCopyReview = null;
  $("public-copy-preview").hidden = true;
  $("public-copy-details").replaceChildren();
  $("public-copy-files").replaceChildren();
  $("public-copy-name").value = "";
  $("public-copy-status").textContent = "";
  $("confirm-public-copy").disabled = true;
  $("public-copy-dialog").close();
}
function publicCopyError(error) {
  return error.status === 404 ? "This public link is unavailable or has been revoked. No copy was created." :
    error.message || "Could not copy this snapshot. Try again.";
}
async function loadPublicCopy(review) {
  if (!publicCopyCurrent(review) || review.pending) return;
  review.pending = true;
  $("public-copy-retry").hidden = true;
  $("public-copy-status").textContent = "Checking the published snapshot…";
  try {
    await recheckPublicCopy(review);
    if (!publicCopyCurrent(review)) return;
    if (typeof review.source.published_at !== "string" || !Number.isFinite(Date.parse(review.source.published_at))) {
      throw new Error("Snapshot publication date is unavailable.");
    }
    // Public titles can exceed local name limits; validate source separately so the user can rename.
    review.preview = publicCopyPreview(review.source, "Private copy");
    $("public-copy-name").value = review.source.title;
    const titleFitsInput = $("public-copy-name").value === review.source.title;
    if (!titleFitsInput) $("public-copy-name").value = "";
    $("public-copy-name").disabled = false;
    snapshotIdentity($("public-copy-details"), review.source);
    $("public-copy-details").prepend(...[
      ["Public title", review.source.title], ["Publication ID", review.source.id],
    ].flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value)]));
    $("public-copy-details").append(el("dt", {}, "Source"),
      el("dd", {}, `${review.preview.file_count} Python files · ${review.preview.source_bytes.toLocaleString()} bytes`));
    $("public-copy-files").replaceChildren(...Object.keys(review.preview.project.files).map((path) => el("li", {}, path)));
    $("public-copy-preview").hidden = false;
    $("confirm-public-copy").disabled = false;
    $("public-copy-status").textContent = titleFitsInput
      ? "Snapshot checked. Review the files and choose a valid private name before creating a copy."
      : "Snapshot checked. The public title cannot be used unchanged in the name field. Choose a new private name.";
    $("public-copy-name").focus();
  } catch (error) {
    if (publicCopyCurrent(review)) {
      $("public-copy-status").textContent = publicCopyError(error);
      $("public-copy-retry").hidden = false;
    }
  } finally { if (publicCopyCurrent(review)) review.pending = false; }
}
$("public-copy").addEventListener("click", () => {
  if ($("public-copy-dialog").open || !publicSnapshot || $("view-public").hidden ||
      location.hash !== `#public/${publicSnapshot.id}` || !Object.hasOwn(publicSnapshot.files, $("public-file").value)) return;
  const review = { snapshot: publicSnapshot, request: publicRequest, generation: routeGeneration, file: $("public-file").value,
    user: state.user, org: state.org,
    source: Object.freeze({ ...publicSnapshot, files: Object.freeze({ ...publicSnapshot.files }) }), preview: null, pending: false };
  publicCopyReview = review;
  $("public-copy-preview").hidden = true;
  $("public-copy-name").disabled = true;
  $("confirm-public-copy").disabled = true;
  $("public-copy-dialog").showModal();
  loadPublicCopy(review);
});
$("public-copy-retry").addEventListener("click", () => { if (publicCopyReview) loadPublicCopy(publicCopyReview); });
$("close-public-copy").addEventListener("click", closePublicCopy);
$("cancel-public-copy").addEventListener("click", closePublicCopy);
$("public-copy-dialog").addEventListener("cancel", (event) => { event.preventDefault(); closePublicCopy(); });
$("public-copy-dialog").addEventListener("close", () => {
  if ($("public-copy-dialog").open) return;
  publicCopyReview = null;
  if (!$("view-public").hidden) $("public-copy").focus();
});
$("public-copy-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const review = publicCopyReview;
  if (!review?.preview || review.pending || !publicCopyCurrent(review)) return;
  const name = $("public-copy-name").value;
  const current = () => publicCopyCurrent(review) && $("public-copy-name").value === name;
  let focusName = false;
  review.pending = true;
  $("public-copy-name").disabled = true;
  $("confirm-public-copy").disabled = true;
  $("public-copy-status").textContent = "Waiting to recheck the publication and create a private device copy…";
  try {
    const project = publicCopyPreview(review.source, name).project;
    if (!current()) return;
    await recheckPublicCopy(review);
    if (!current()) return;
    // No network under the shared lock: availability is as of the successful public read.
    const copy = await localWrite(() => current() ? localWorkspace.createProject(project) : null);
    if (!current() || !copy) return;
    closePublicCopy();
    selectProjectStore("device");
    location.hash = `#project/${copy.id}`;
    say("Created a private device copy as saved v1. No source was uploaded or executed.");
  } catch (error) {
    if (current()) {
      $("public-copy-status").textContent = publicCopyError(error);
      focusName = error.code === "NAME_CONFLICT" || error.code === "INVALID_STRATEGY_BACKUP";
    }
  } finally {
    if (publicCopyCurrent(review)) {
      review.pending = false;
      $("public-copy-name").disabled = false;
      $("confirm-public-copy").disabled = false;
      if (focusName) $("public-copy-name").focus();
    }
  }
});

let shareReview = null;
const shareCurrent = (review, response = false) => shareReview === review && $("share-dialog").open &&
  state.project === review.project && currentProjectRoute(review.project.id, response) && routeGeneration === review.generation &&
  review.user === state.user && review.org === state.org;
function updateShareSubmit() {
  $("share-publish").disabled = !shareReview?.snapshot || shareReview.pending || shareReview.completed ||
    !$("share-consent").checked || !$("share-public-title").value.trim();
}
async function loadShareVersion(review, response = false) {
  if (!shareCurrent(review, response)) return;
  const selection = ++review.selection;
  review.snapshot = null;
  $("share-consent").checked = false;
  $("share-snapshot").hidden = true;
  $("share-source").textContent = "";
  $("share-version-status").textContent = "Loading this saved version…";
  updateShareSubmit();
  try {
    const selected = review.versions.find((version) => version.id === $("share-version").value);
    if (!selected) throw new Error("Choose an existing saved version.");
    const snapshot = checkSnapshot(await projectRequest(review.project.id, "version", selected.version_no));
    if (!shareCurrent(review, true) || selection !== review.selection) return;
    if (snapshot.id !== selected.id || snapshot.version_no !== selected.version_no || snapshot.content_hash !== selected.content_hash ||
        snapshot.entrypoint !== selected.entrypoint) throw new Error("Saved snapshot identity changed. Close Share and review again.");
    review.snapshot = snapshot;
    snapshotIdentity($("share-identity"), snapshot, true);
    sourceSelector($("share-file"), $("share-source"), snapshot);
    $("share-file-list").replaceChildren(...Object.keys(snapshot.files).map((name) => el("li", {}, name)));
    $("share-snapshot").hidden = false;
    $("share-version-status").textContent = `Pinned saved v${snapshot.version_no}. Your editor and unsaved edits are unchanged.`;
    updateShareSubmit();
  } catch (error) {
    if (shareCurrent(review, true) && selection === review.selection) $("share-version-status").textContent = error.message;
  }
}
function checkReceipt(receipt) {
  checkPublicMetadata(receipt);
  if (!publicationId(receipt.project_version_id) || !["published", "revoked"].includes(receipt.status)) throw new Error("Publication receipt is unavailable. Refresh links to check its status.");
  return receipt;
}
function renderShareReceipts(review) {
  $("share-more").disabled = false;
  $("share-receipts").replaceChildren(...review.receipts.map((receipt) => {
    const actions = el("div", { class: "compact-actions" });
    const row = el("div", {}, el("strong", {}, receipt.title),
      el("p", { class: "publication-description" }, receipt.description),
      el("span", { class: "sub" }, `${receipt.status === "revoked" ? "Revoked" : "Public"} · saved v${receipt.version_no} · ${when(receipt.published_at)}`),
      el("span", { class: "sub" }, `Content hash ${receipt.content_hash}`));
    if (receipt.status === "published") {
      row.append(el("a", { class: "publication-link", href: publicationLink(receipt.id) }, "Open public snapshot"));
      const revoke = el("button", { type: "button", "data-revoke": receipt.id }, "Revoke public link");
      revoke.addEventListener("click", () => {
        if (!shareCurrent(review)) return;
        const warning = el("p", {}, "Revoke this link and remove it from discovery? Copies others have saved and responses already in flight cannot be recalled.");
        const confirm = el("button", { type: "button", "data-confirm-revoke": receipt.id }, "Revoke this link");
        const cancel = el("button", { type: "button" }, "Keep public");
        const confirmation = el("div", {}, warning, confirm, cancel);
        actions.replaceChildren(confirmation);
        cancel.addEventListener("click", () => actions.replaceChildren(revoke));
        confirm.addEventListener("click", async () => {
          if (!shareCurrent(review) || confirm.disabled) return;
          confirm.disabled = cancel.disabled = true;
          review.receiptRequest++;
          try {
            const result = checkReceipt(await api(`/v1/publications/${receipt.id}`, { method: "DELETE" }));
            if (!shareCurrent(review, true)) return;
            if (result.id !== receipt.id || result.status !== "revoked") throw new Error("Revocation could not be confirmed. Refresh links to check.");
            review.receiptRequest++;
            review.receipts = review.receipts.map((item) => item.id === result.id ? result : item);
            renderShareReceipts(review);
            $("share-history-status").textContent = "Link revoked. Outside copies cannot be recalled.";
          } catch (error) {
            if (shareCurrent(review, true)) {
              $("share-more").disabled = false;
              warning.textContent = `${error.message} Refresh links or retry revocation. Outside copies cannot be recalled.`;
              $("share-history-status").textContent = warning.textContent;
              confirm.disabled = cancel.disabled = false;
            }
          }
        });
      });
      actions.append(revoke);
    } else row.append(el("p", { class: "small muted" }, `Revoked ${when(receipt.revoked_at)}. Outside copies cannot be recalled.`));
    row.append(actions);
    return el("li", {}, row);
  }));
  if (!review.receipts.length) $("share-receipts").append(el("li", { class: "muted" }, "No snapshots have been published for this strategy."));
}
function mergeReceiptPage(review, result) {
  if (!Array.isArray(result.publications) || typeof result.has_more !== "boolean" ||
      (result.has_more ? typeof result.next_cursor !== "string" || !result.next_cursor || result.next_cursor.length > 512 : result.next_cursor !== null)) {
    throw new Error("Publication pagination is unavailable. Close and reopen Share to retry.");
  }
  const rows = result.publications.map(checkReceipt), incoming = new Set(rows.map((row) => row.id));
  review.receipts = [...rows, ...review.receipts.filter((row) => !incoming.has(row.id))]
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || b.id.localeCompare(a.id));
  review.receiptCursor = result.next_cursor;
  $("share-more").hidden = !result.has_more;
  $("share-more").disabled = false;
  renderShareReceipts(review);
}
async function refreshShareReceipts(review, more = false) {
  if (!shareCurrent(review) || (more && !review.receiptCursor)) return;
  const request = ++review.receiptRequest;
  $("share-history-status").textContent = "Checking publication receipts…";
  $("share-more").disabled = true;
  const query = new URLSearchParams({ limit: "20" });
  if (more) query.set("cursor", review.receiptCursor);
  try {
    const result = await api(`/v1/projects/${review.project.id}/publications?${query}`);
    if (!shareCurrent(review, true) || request !== review.receiptRequest) return;
    mergeReceiptPage(review, result);
    $("share-history-status").textContent = `${review.receipts.length} receipts loaded${review.receiptCursor ? " · older links available" : ""}.`;
  } catch (error) {
    if (shareCurrent(review, true) && request === review.receiptRequest) $("share-history-status").textContent = `Could not refresh links. ${error.message}`;
  } finally {
    if (shareCurrent(review, true) && request === review.receiptRequest) $("share-more").disabled = false;
  }
}
async function openShareReview() {
  const project = state.project;
  if (!project || !currentProjectRoute(project.id)) return;
  if ($("share-dialog").open) return;
  const review = shareReview = { project, generation: routeGeneration, user: state.user, org: state.org, selection: 0, receiptRequest: 0, receiptCursor: null, snapshot: null, receipts: [] };
  $("share-form").reset();
  $("share-fields").disabled = false;
  $("share-form").hidden = $("share-history").hidden = $("share-snapshot").hidden = true;
  $("share-receipts").replaceChildren();
  $("share-more").hidden = true;
  $("share-status").textContent = $("share-history-status").textContent = "";
  $("share-availability").textContent = isLocalProject(project.id) || !state.org
    ? "Private · device-local. This strategy stays in this browser. Publishing requires secure cloud identity and database storage, which are not connected here. Download your code for a backup."
    : "Private · database workspace. Publishing creates a separate public snapshot. Your project name, private description, folder, drafts and later versions remain private.";
  $("share-dialog").showModal();
  updateShareSubmit();
  if (isLocalProject(project.id) || !state.org) return;
  $("share-status").textContent = "Checking owner access and saved versions…";
  try {
    const [saved, history] = await Promise.all([projectRequest(project.id, "get"), api(`/v1/projects/${project.id}/publications?limit=20`)]);
    if (!shareCurrent(review, true)) return;
    review.versions = saved.versions;
    if (!review.versions.length || review.versions.some((version) => !publicationId(version.id) ||
        !Number.isInteger(version.version_no) || version.version_no < 1 || !/^sha256:[0-9a-f]{64}$/.test(version.content_hash))) throw new Error("Saved version identities are unavailable.");
    mergeReceiptPage(review, history);
    $("share-version").replaceChildren(...review.versions.map((version) => el("option", { value: version.id }, `Saved v${version.version_no} · ${when(version.created_at)}`)));
    if (review.versions.some((version) => version.id === project.version.id)) $("share-version").value = project.version.id;
    $("share-form").hidden = $("share-history").hidden = false;
    $("share-status").textContent = "Choose public metadata afresh, inspect the saved files, then confirm publication.";
    await loadShareVersion(review, true);
  } catch (error) {
    if (shareCurrent(review, true)) $("share-status").textContent = error.status === 403 ? "Only a workspace owner can publish or revoke snapshots." : `Sharing is unavailable. ${error.message} Close and reopen Share to retry.`;
  }
}
$("share-project").addEventListener("click", openShareReview);
$("share-close").addEventListener("click", () => $("share-dialog").close());
$("share-dialog").addEventListener("close", () => {
  if ($("share-dialog").open) return;
  shareReview = null;
  $("share-source").textContent = "";
  $("share-form").reset();
  if (!$("view-project").hidden) $("share-project").focus();
});
$("share-version").addEventListener("change", () => { if (shareReview && !shareReview.pending) loadShareVersion(shareReview); });
$("share-file").addEventListener("change", () => { if (shareReview?.snapshot) $("share-source").textContent = shareReview.snapshot.files[$("share-file").value]; });
$("share-refresh").addEventListener("click", () => { if (shareReview) refreshShareReceipts(shareReview); });
$("share-more").addEventListener("click", () => { if (shareReview) refreshShareReceipts(shareReview, true); });
$("share-consent").addEventListener("change", updateShareSubmit);
for (const id of ["share-public-title", "share-description"]) $(id).addEventListener("input", () => { $("share-consent").checked = false; updateShareSubmit(); });
$("share-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const review = shareReview;
  if (!review || !shareCurrent(review) || !review.snapshot || review.pending || review.completed || !$("share-consent").checked ||
      $("share-version").value !== review.snapshot.id) return;
  const body = { project_version_id: review.snapshot.id, title: $("share-public-title").value.trim(),
    description: $("share-description").value.trim(), confirm_public: true };
  if (!body.title || body.title.length > 120 || body.description.length > 4000 || /[\x00-\x1f\x7f]/.test(body.title) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.description)) {
    $("share-status").textContent = "Use a public title (1–120 characters) and description (up to 4,000 characters) without control characters.";
    return;
  }
  const signature = JSON.stringify(body);
  if (review.attempt?.signature !== signature) review.attempt = { signature,
    key: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("") };
  review.pending = true;
  review.receiptRequest++;
  $("share-fields").disabled = true;
  $("share-status").textContent = "Publishing this explicitly selected snapshot… Closing this review does not cancel an already-sent request. Reopen Share and refresh links to check its outcome.";
  updateShareSubmit();
  try {
    const receipt = checkReceipt(await api(`/v1/projects/${review.project.id}/publications`, { method: "POST", body,
      headers: { "Idempotency-Key": review.attempt.key } }));
    if (!shareCurrent(review, true)) return;
    if (receipt.project_version_id !== body.project_version_id || receipt.title !== body.title || receipt.description !== body.description ||
        receipt.content_hash !== review.snapshot.content_hash || receipt.entrypoint !== review.snapshot.entrypoint) throw new Error("Publication identity could not be confirmed.");
    review.receiptRequest++;
    review.receipts = [receipt, ...review.receipts.filter((item) => item.id !== receipt.id)];
    renderShareReceipts(review);
    review.completed = true;
    $("share-consent").checked = false;
    $("share-status").textContent = receipt.status === "revoked"
      ? "This earlier publication was revoked. Retrying did not reactivate it. Close and reopen Share to review a new publication."
      : "Snapshot published. Open its public link below. Your source project remains private. Close and reopen Share to review another publication.";
  } catch (error) {
    if (shareCurrent(review, true)) $("share-status").textContent = `${error.message} Publication was not confirmed. Retry with the same selection to reuse this request, or refresh links to check the outcome.`;
  } finally {
    review.pending = false;
    if (shareCurrent(review, true)) { $("share-fields").disabled = !!review.completed; $("share-more").disabled = false; updateShareSubmit(); }
  }
});


// ---------------------------------------------------------------- start
(async () => {
  try { await boot(); } catch (e) {
    if (e.status === 401) forgetRememberedUser(); else fail(e);
  }
  route();
})();

