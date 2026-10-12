(function (root, factory) {
  "use strict";
  const tools = factory();
  if (typeof module === "object" && module.exports) module.exports = tools;
  else root.VeyraChartTools = tools;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  // Pure chart math, drawing geometry and saved-setting validation. No DOM, no chart library.

  const finite = Number.isFinite;
  const round = (v, places = 2) => Number(v).toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
  const signed = (v, places = 2) => `${v >= 0 ? "+" : "−"}${round(Math.abs(v), places)}`;
  const percent = (from, to) => from !== 0 ? (to / from - 1) * 100 : null;
  const signedPct = (v) => v == null ? "n/a" : `${signed(v)}%`;

  // ---------------------------------------------------------------- indicators
  // Every series is aligned with its input: null during warmup, never a fake value.
  function sma(values, n) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function ema(values, n) {
    const out = new Array(values.length).fill(null), k = 2 / (n + 1);
    if (values.length < n) return out;
    let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n; // seeded with the first SMA
    out[n - 1] = prev;
    for (let i = n; i < values.length; i++) out[i] = prev = values[i] * k + prev * (1 - k);
    return out;
  }

  function bollinger(values, n = 20, k = 2) {
    const middle = sma(values, n), upper = [], lower = [];
    for (let i = 0; i < values.length; i++) {
      if (middle[i] == null) { upper.push(null); lower.push(null); continue; }
      const window = values.slice(i - n + 1, i + 1);
      const sd = Math.sqrt(window.reduce((s, v) => s + (v - middle[i]) ** 2, 0) / n); // population, like most charting tools
      upper.push(middle[i] + k * sd);
      lower.push(middle[i] - k * sd);
    }
    return { middle, upper, lower };
  }

  function macd(values, fast = 12, slow = 26, signalN = 9) {
    const f = ema(values, fast), s = ema(values, slow);
    const line = values.map((_, i) => f[i] == null || s[i] == null ? null : f[i] - s[i]);
    const first = line.findIndex((v) => v != null);
    const signal = new Array(values.length).fill(null);
    if (first >= 0) ema(line.slice(first), signalN).forEach((v, i) => { signal[first + i] = v; });
    const histogram = line.map((v, i) => v == null || signal[i] == null ? null : v - signal[i]);
    return { macd: line, signal, histogram };
  }

  function heikinAshi(bars) {
    const out = [];
    for (const b of bars) {
      const close = (b.open + b.high + b.low + b.close) / 4;
      const prev = out.at(-1);
      const open = prev ? (prev.open + prev.close) / 2 : (b.open + b.close) / 2;
      out.push({ ...b, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close) });
    }
    return out;
  }

  function anchoredVwap(bars, anchor) {
    const out = new Array(bars.length).fill(null);
    let pv = 0, vol = 0;
    for (let i = Math.max(0, anchor); i < bars.length; i++) {
      const b = bars[i], typical = (b.high + b.low + b.close) / 3;
      pv += typical * b.volume; vol += b.volume;
      out[i] = vol > 0 ? pv / vol : null;
    }
    return out;
  }

  // Bars carry no intrabar volume detail, so each bar's volume is spread evenly over its range.
  function volumeProfile(bars, from, to, rows = 24) {
    const slice = bars.slice(Math.max(0, Math.min(from, to)), Math.max(from, to) + 1);
    if (!slice.length) throw new Error("Select a range that contains bars.");
    const low = Math.min(...slice.map((b) => b.low)), high = Math.max(...slice.map((b) => b.high));
    const step = (high - low) / rows || 1;
    const buckets = Array.from({ length: rows }, (_, i) => ({ low: low + i * step, high: low + (i + 1) * step, volume: 0 }));
    for (const b of slice) {
      const span = b.high - b.low;
      for (const bucket of buckets) {
        const overlap = span > 0 ? Math.max(0, Math.min(b.high, bucket.high) - Math.max(b.low, bucket.low)) / span
          : (b.close >= bucket.low && b.close <= bucket.high ? 1 : 0);
        bucket.volume += b.volume * overlap;
      }
    }
    const poc = buckets.reduce((best, bucket, i) => bucket.volume > buckets[best].volume ? i : best, 0);
    return { low, high, buckets, poc, total: slice.reduce((s, b) => s + b.volume, 0), bars: slice.length };
  }

  // ---------------------------------------------------------------- catalogs
  const INDICATORS = Object.freeze([
    { id: "volume", name: "Volume", about: "Traded volume per candle." },
    { id: "sma20", name: "SMA 20", about: "Simple moving average of 20 closes." },
    { id: "sma50", name: "SMA 50", about: "Simple moving average of 50 closes." },
    { id: "sma200", name: "SMA 200", about: "Simple moving average of 200 closes." },
    { id: "ema20", name: "EMA 20", about: "Exponential moving average of 20 closes, seeded with an SMA." },
    { id: "ema50", name: "EMA 50", about: "Exponential moving average of 50 closes, seeded with an SMA." },
    { id: "bb", name: "Bollinger Bands 20, 2", about: "SMA 20 ± 2 population standard deviations." },
    { id: "rsi", name: "RSI 14", about: "Relative strength index, Wilder smoothing, in its own pane." },
    { id: "macd", name: "MACD 12 26 9", about: "MACD line, signal and histogram in their own pane." },
  ].map(Object.freeze));
  const INDICATOR_IDS = new Set(INDICATORS.map((i) => i.id));

  const CATEGORIES = Object.freeze([
    { id: "lines", name: "Lines" },
    { id: "forecast", name: "Forecasting & measurement" },
    { id: "shapes", name: "Geometric shapes" },
  ]);
  const tool = (id, name, category, points, help, extra = {}) => Object.freeze({ id, name, category, points, help, ...extra });
  const TOOLS = Object.freeze([
    tool("trend", "Trend line", "lines", 2, "Tap two points."),
    tool("horizontal", "Horizontal line", "lines", 1, "Tap a price."),
    tool("long", "Long position", "forecast", 3, "Tap the entry, then the target above it, then the stop below it."),
    tool("short", "Short position", "forecast", 3, "Tap the entry, then the target below it, then the stop above it."),
    tool("forecast", "Position forecast", "forecast", 2, "Tap the start, then the projected point."),
    tool("bars-pattern", "Bars pattern", "forecast", 2, "Tap the first and last bar to copy. The pattern is projected after the last bar."),
    tool("ghost-feed", "Ghost feed", "forecast", 8, "Tap 2–8 points to sketch a projected path, then Finish.", { minPoints: 2 }),
    tool("sector", "Sector", "forecast", 3, "Tap the center, then two edge points."),
    tool("avwap", "Anchored VWAP", "forecast", 1, "Tap the bar to anchor from."),
    tool("fixed-vp", "Fixed range volume profile", "forecast", 2, "Tap the first and last bar of the range."),
    tool("anchored-vp", "Anchored volume profile", "forecast", 1, "Tap the bar to anchor from; the profile runs to the latest bar."),
    tool("price-range", "Price range", "forecast", 2, "Tap two prices."),
    tool("date-range", "Date range", "forecast", 2, "Tap two bars."),
    tool("date-price-range", "Date and price range", "forecast", 2, "Tap two points."),
    tool("rectangle", "Rectangle", "shapes", 2, "Tap two opposite corners."),
    tool("triangle", "Triangle", "shapes", 3, "Tap three corners."),
    tool("circle", "Circle", "shapes", 2, "Tap the center, then a point on the edge."),
  ]);
  const toolById = (id) => TOOLS.find((t) => t.id === id) || null;

  function searchTools(query, category = "") {
    const needle = String(query || "").trim().toLowerCase();
    return TOOLS.filter((t) => (!category || needle || t.category === category) &&
      (!needle || `${t.name} ${CATEGORIES.find((c) => c.id === t.category).name}`.toLowerCase().includes(needle)));
  }

  // ---------------------------------------------------------------- drawing geometry
  // Points are { logical, price }: logical is the bar index in the displayed series, so
  // projections can extend past the last bar. Shapes use the same coordinates.
  function buildDrawing(id, points, ctx) {
    const t = toolById(id);
    if (!t) throw new Error("Unknown drawing tool.");
    const need = t.minPoints || t.points;
    if (points.length < need || points.length > t.points) throw new Error(`${t.name} needs ${need} point${need > 1 ? "s" : ""}.`);
    for (const p of points) if (!finite(p.logical) || !finite(p.price)) throw new Error("Point is outside the chart.");
    const bars = ctx.bars, last = bars.length - 1, interval = ctx.intervalDays || 1;
    const barAt = (logical) => Math.max(0, Math.min(last, Math.round(logical)));
    const [a, b, c] = points;
    const shapes = [];
    let label = "", series = null;
    switch (id) {
      case "trend":
        shapes.push({ type: "line", a, b, color: "accent", width: 2 });
        label = `${signedPct(percent(a.price, b.price))} · ${Math.abs(Math.round(b.logical - a.logical))} bars`;
        break;
      case "horizontal":
        shapes.push({ type: "hline", price: a.price, color: "accent" });
        label = `Level ${round(a.price)}`;
        break;
      case "long": case "short": {
        const long = id === "long";
        if (long ? !(b.price > a.price && c.price < a.price) : !(b.price < a.price && c.price > a.price)) {
          throw new Error(long ? "For a long position the target must be above the entry and the stop below it."
            : "For a short position the target must be below the entry and the stop above it.");
        }
        const right = Math.max(a.logical, b.logical, c.logical, a.logical + 10);
        shapes.push({ type: "rect", a, b: { logical: right, price: b.price }, fill: "up", alpha: 0.18, stroke: "up" });
        shapes.push({ type: "rect", a, b: { logical: right, price: c.price }, fill: "down", alpha: 0.18, stroke: "down" });
        shapes.push({ type: "line", a, b: { logical: right, price: a.price }, color: "ink", width: 1 });
        const reward = Math.abs(b.price - a.price), risk = Math.abs(a.price - c.price);
        label = `${long ? "Long" : "Short"} · target ${signedPct(percent(a.price, b.price))} · stop ${signedPct(percent(a.price, c.price))} · reward/risk ${round(reward / risk)}`;
        break;
      }
      case "forecast":
        shapes.push({ type: "line", a, b, color: b.price >= a.price ? "up" : "down", width: 2, arrow: true });
        label = `Forecast ${signedPct(percent(a.price, b.price))} over ${Math.abs(Math.round(b.logical - a.logical))} bars`;
        break;
      case "bars-pattern": {
        const from = barAt(Math.min(a.logical, b.logical)), to = barAt(Math.max(a.logical, b.logical));
        if (to <= from) throw new Error("Select at least two different bars.");
        const base = bars[from].close, anchor = bars[last].close;
        bars.slice(from, to + 1).forEach((bar, i) => {
          const scale = (v) => anchor * (v / base); // relative moves replayed from the latest close
          shapes.push({ type: "candle", logical: last + 1 + i, open: scale(bar.open), high: scale(bar.high),
            low: scale(bar.low), close: scale(bar.close), ghost: true });
        });
        shapes.push({ type: "rect", a: { logical: from, price: Math.min(...bars.slice(from, to + 1).map((x) => x.low)) },
          b: { logical: to, price: Math.max(...bars.slice(from, to + 1).map((x) => x.high)) }, stroke: "muted", dash: true });
        label = `Bars pattern · ${to - from + 1} bars copied and projected from the latest close · illustration, not a prediction`;
        break;
      }
      case "ghost-feed": {
        const sorted = [...points].sort((x, y) => x.logical - y.logical);
        for (let i = 1; i < sorted.length; i++) {
          const p = sorted[i - 1], q = sorted[i];
          shapes.push({ type: "candle", logical: q.logical, open: p.price, close: q.price,
            high: Math.max(p.price, q.price), low: Math.min(p.price, q.price), ghost: true });
        }
        shapes.push({ type: "path", points: sorted, color: "muted", dash: true });
        label = `Ghost feed · ${sorted.length} points · sketch, not a prediction`;
        break;
      }
      case "sector": case "triangle":
        shapes.push({ type: "poly", points: [a, b, c], fill: "accent", alpha: 0.12, stroke: "accent" });
        label = id === "sector" ? `Sector · ${signedPct(percent(a.price, b.price))} to ${signedPct(percent(a.price, c.price))}` : "Triangle";
        break;
      case "avwap": {
        const anchor = barAt(a.logical);
        series = anchoredVwap(bars, anchor);
        label = `Anchored VWAP from ${ctx.timeLabel ? ctx.timeLabel(anchor) : `bar ${anchor}`} · typical price × volume`;
        break;
      }
      case "fixed-vp": case "anchored-vp": {
        const from = barAt(a.logical), to = id === "fixed-vp" ? barAt(b.logical) : last;
        const vp = volumeProfile(bars, from, to);
        const left = Math.min(from, to), width = Math.max(4, Math.abs(to - from) * 0.6);
        const max = Math.max(...vp.buckets.map((x) => x.volume)) || 1;
        vp.buckets.forEach((bucket, i) => shapes.push({ type: "rect",
          a: { logical: left, price: bucket.low }, b: { logical: left + width * bucket.volume / max, price: bucket.high },
          fill: i === vp.poc ? "accent" : "muted", alpha: i === vp.poc ? 0.55 : 0.28 }));
        const pocPrice = (vp.buckets[vp.poc].low + vp.buckets[vp.poc].high) / 2;
        shapes.push({ type: "line", a: { logical: left, price: pocPrice }, b: { logical: Math.max(from, to), price: pocPrice }, color: "accent", width: 1, dash: true });
        label = `Volume profile · ${vp.bars} bars · point of control ${round(pocPrice)} · volume spread evenly across each bar's range`;
        break;
      }
      case "price-range": case "date-range": case "date-price-range": case "rectangle": {
        shapes.push({ type: "rect", a, b, fill: id === "rectangle" ? "accent" : "ink", alpha: 0.08, stroke: id === "rectangle" ? "accent" : "ink" });
        const barsBetween = Math.abs(Math.round(b.logical - a.logical));
        const price = `${signed(b.price - a.price)} (${signedPct(percent(a.price, b.price))})`;
        const time = `${barsBetween} bars · ${round(barsBetween * interval, 0)} days`;
        label = { "price-range": `Price range ${price}`, "date-range": `Date range ${time}`,
          "date-price-range": `${price} · ${time}`, rectangle: "Rectangle" }[id];
        break;
      }
      case "circle":
        shapes.push({ type: "circle", center: a, edge: b, fill: "accent", alpha: 0.08, stroke: "accent" });
        label = "Circle";
        break;
    }
    // Short on-chart tag; the full label goes to the readout and the object tree.
    const tag = { long: () => `Long · R/R ${label.split("reward/risk ")[1]}`, short: () => `Short · R/R ${label.split("reward/risk ")[1]}`,
      "fixed-vp": () => `POC ${label.split("point of control ")[1].split(" ·")[0]}`, "anchored-vp": () => `POC ${label.split("point of control ")[1].split(" ·")[0]}`,
      avwap: () => "AVWAP", "bars-pattern": () => "Pattern", "ghost-feed": () => "Ghost feed", sector: () => "Sector",
      "price-range": () => label.replace("Price range ", ""), "date-range": () => label.replace("Date range ", "") }[id]?.() ?? label.split(" · ")[0];
    return { tool: id, name: t.name, points: points.map((p) => ({ logical: p.logical, price: p.price })), shapes, label, tag, series };
  }

  // ---------------------------------------------------------------- readings
  // Factual readings only. No buy/sell rating: the platform does not give advice.
  function technicals(bars, rsiValues) {
    if (!bars.length) return [];
    const closes = bars.map((b) => b.close), price = closes.at(-1), rows = [];
    for (const [name, values] of [["SMA 20", sma(closes, 20)], ["SMA 50", sma(closes, 50)], ["SMA 200", sma(closes, 200)],
      ["EMA 20", ema(closes, 20)], ["EMA 50", ema(closes, 50)]]) {
      const v = values.at(-1);
      rows.push({ name, value: v == null ? "Needs more bars" : round(v),
        reading: v == null ? "—" : `Price ${price >= v ? "above" : "below"} (${signedPct(percent(v, price))})` });
    }
    const rsi = rsiValues?.at(-1);
    rows.push({ name: "RSI 14", value: rsi == null ? "Needs more bars" : round(rsi),
      reading: rsi == null ? "—" : rsi >= 70 ? "Above 70" : rsi <= 30 ? "Below 30" : "Between 30 and 70" });
    const m = macd(closes), line = m.macd.at(-1), sig = m.signal.at(-1);
    rows.push({ name: "MACD 12 26 9", value: line == null || sig == null ? "Needs more bars" : `${round(line)} / ${round(sig)}`,
      reading: line == null || sig == null ? "—" : `MACD ${line >= sig ? "above" : "below"} signal` });
    const bb = bollinger(closes), up = bb.upper.at(-1), low = bb.lower.at(-1);
    rows.push({ name: "Bollinger %B", value: up == null ? "Needs more bars" : round(up === low ? 0.5 : (price - low) / (up - low)),
      reading: up == null ? "—" : price > up ? "Above upper band" : price < low ? "Below lower band" : "Inside the bands" });
    return rows;
  }

  // Bars where the close crossed the level: the previous close on one side, this close on or past it.
  function crossings(bars, level) {
    const out = [];
    for (let i = 1; i < bars.length; i++) {
      const p = bars[i - 1].close, c = bars[i].close;
      if ((p < level && c >= level) || (p > level && c <= level)) out.push({ index: i, time: bars[i].time, direction: c >= p ? "up" : "down" });
    }
    return out;
  }

  // ---------------------------------------------------------------- saved settings (device storage is untrusted input)
  const INTERVALS = Object.freeze(["1d", "3d", "1w", "1M", "30w"]);
  const CHART_TYPES = Object.freeze(["candles", "bars", "hollow", "heikin", "line", "area"]);
  const RANGES = Object.freeze([90, 365, 0]);
  const name = (v, fallback) => typeof v === "string" && v.trim() && v.length <= 60 && !/[\x00-\x1f\x7f]/.test(v) ? v.trim() : fallback;
  const ids = (v, allowed, max) => Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && allowed(x)))].slice(0, max) : [];
  const SETTINGS = Object.freeze({ grid: true, priceLine: true, symbolLabel: true, colors: "classic", crosshair: true, log: false });

  function layout(value, datasetIds) {
    const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const known = (id) => datasetIds.includes(id);
    const s = v.settings && typeof v.settings === "object" ? v.settings : {};
    return {
      name: name(v.name, "Unnamed"),
      dataset: known(v.dataset) ? v.dataset : datasetIds[0] || null,
      interval: INTERVALS.includes(v.interval) ? v.interval : "1d",
      range: RANGES.includes(v.range) ? v.range : 365,
      chartType: CHART_TYPES.includes(v.chartType) ? v.chartType : "candles",
      indicators: ids(v.indicators, (id) => INDICATOR_IDS.has(id), INDICATORS.length),
      compare: ids(v.compare, known, 3),
      settings: Object.fromEntries(Object.entries(SETTINGS).map(([k, d]) =>
        [k, k === "colors" ? (["classic", "mono"].includes(s[k]) ? s[k] : d) : typeof s[k] === "boolean" ? s[k] : d])),
    };
  }

  const list = (value, read, max) => Array.isArray(value) ? value.slice(0, max).flatMap((item) => {
    try { const r = read(item); return r ? [r] : []; } catch { return []; }
  }) : [];
  const layouts = (value, datasetIds) => list(value, (item) => layout(item, datasetIds), 50);
  const templates = (value) => list(value, (item) => ({ name: name(item?.name, null),
    indicators: ids(item?.indicators, (id) => INDICATOR_IDS.has(id), INDICATORS.length) }), 50).filter((t) => t.name);
  const favorites = (value) => list(value, (item) => {
    if (!["indicator", "strategy"].includes(item?.kind) || typeof item.id !== "string" || item.id.length > 200) return null;
    if (!["builtin", "mine", "community"].includes(item.source)) return null;
    if (item.kind === "indicator" && item.source === "builtin" && !INDICATOR_IDS.has(item.id)) return null;
    return { kind: item.kind, source: item.source, id: item.id, name: name(item.name, item.id) };
  }, 200);
  const alerts = (value, datasetIds) => list(value, (item) => datasetIds.includes(item?.dataset) && finite(item.level) && item.level > 0
    ? { id: typeof item.id === "string" ? item.id.slice(0, 40) : String(Math.random()), dataset: item.dataset, level: item.level } : null, 50);
  const watchlist = (value, datasetIds) => ids(value, (id) => datasetIds.includes(id), 100);

  return Object.freeze({ sma, ema, bollinger, macd, heikinAshi, anchoredVwap, volumeProfile,
    INDICATORS, CATEGORIES, TOOLS, toolById, searchTools, buildDrawing, technicals, crossings,
    INTERVALS, CHART_TYPES, SETTINGS, layout, layouts, templates, favorites, alerts, watchlist, percent, signed });
});
