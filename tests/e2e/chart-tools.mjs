// Pure chart math and drawing geometry: node --test tests/e2e/chart-tools.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const T = createRequire(import.meta.url)('../../apps/web/chart-tools.js');
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const bar = (i, close, extra = {}) => ({ time: 86400 * i, open: close, high: close + 1, low: close - 1, close, volume: 10, ...extra });

test('moving averages warm up with null and match hand values', () => {
  assert.deepEqual(T.sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const e = T.ema([1, 2, 3, 4, 5], 3); // seed SMA(1,2,3)=2, k=0.5
  assert.deepEqual(e.slice(0, 2), [null, null]);
  near(e[2], 2); near(e[3], 3); near(e[4], 4);
  assert.deepEqual(T.ema([1, 2], 3), [null, null]);
});

test('bollinger uses population deviation and MACD aligns its signal', () => {
  const bb = T.bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2); // mean 5, population sd 2
  near(bb.middle[7], 5); near(bb.upper[7], 9); near(bb.lower[7], 1);
  const values = Array.from({ length: 40 }, (_, i) => 100 + i);
  const m = T.macd(values);
  assert.equal(m.macd.findIndex((v) => v != null), 25);
  assert.equal(m.signal.findIndex((v) => v != null), 33);
  near(m.histogram[39], m.macd[39] - m.signal[39]);
});

test('heikin ashi and anchored VWAP follow their definitions', () => {
  const ha = T.heikinAshi([{ time: 1, open: 10, high: 14, low: 8, close: 12 }, { time: 2, open: 12, high: 16, low: 11, close: 15 }]);
  near(ha[0].close, 11); near(ha[0].open, 11);
  near(ha[1].open, 11); near(ha[1].close, 13.5); near(ha[1].high, 16); near(ha[1].low, 11);
  const v = T.anchoredVwap([bar(0, 10), bar(1, 20, { volume: 30 }), bar(2, 40, { volume: 10 })], 1);
  assert.equal(v[0], null);
  near(v[1], 20); near(v[2], (20 * 30 + 40 * 10) / 40);
});

test('volume profile conserves volume and finds the point of control', () => {
  const bars = [bar(0, 10, { volume: 100 }), bar(1, 10, { volume: 50 }), bar(2, 20, { volume: 5 })];
  const vp = T.volumeProfile(bars, 0, 2, 10);
  near(vp.buckets.reduce((s, b) => s + b.volume, 0), 155, 1e-6);
  assert.ok(vp.buckets[vp.poc].low <= 10 && vp.buckets[vp.poc].high >= 10);
  assert.throws(() => T.volumeProfile([], 0, 0), /contains bars/);
});

test('drawing tools validate their points and label measurements', () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(i, 100 + i));
  const ctx = { bars, intervalDays: 1 };
  assert.throws(() => T.buildDrawing('long', [{ logical: 1, price: 100 }, { logical: 5, price: 90 }, { logical: 5, price: 95 }], ctx), /target must be above/);
  const long = T.buildDrawing('long', [{ logical: 1, price: 100 }, { logical: 5, price: 120 }, { logical: 5, price: 90 }], ctx);
  assert.match(long.label, /target \+20\.00% · stop −10\.00% · reward\/risk 2\.00/);
  assert.equal(long.shapes.filter((s) => s.type === 'rect').length, 2);
  const range = T.buildDrawing('date-price-range', [{ logical: 2, price: 100 }, { logical: 9, price: 110 }], { bars, intervalDays: 7 });
  assert.equal(range.label, '+10.00 (+10.00%) · 7 bars · 49 days');
  const pattern = T.buildDrawing('bars-pattern', [{ logical: 0, price: 1 }, { logical: 2, price: 1 }], ctx);
  const ghosts = pattern.shapes.filter((s) => s.type === 'candle');
  assert.equal(ghosts.length, 3);
  assert.equal(ghosts[0].logical, 30);
  near(ghosts[0].close, 129); // replayed from the latest close (129)
  const vwap = T.buildDrawing('avwap', [{ logical: 3.4, price: 1 }], ctx);
  assert.equal(vwap.series[2], null); assert.ok(vwap.series[3] > 0);
  assert.throws(() => T.buildDrawing('trend', [{ logical: 1, price: 1 }], ctx), /needs 2 points/);
  assert.throws(() => T.buildDrawing('trend', [{ logical: NaN, price: 1 }, { logical: 2, price: 1 }], ctx), /outside/);
  assert.equal(T.buildDrawing('ghost-feed', [{ logical: 30, price: 1 }, { logical: 31, price: 2 }], ctx).shapes.length, 2);
  for (const t of T.TOOLS) assert.ok(T.CATEGORIES.some((c) => c.id === t.category), t.id);
  assert.deepEqual(T.searchTools('volume').map((t) => t.id), ['fixed-vp', 'anchored-vp']);
  assert.ok(T.searchTools('', 'shapes').every((t) => t.category === 'shapes'));
});

test('technicals are readings, never ratings, and alerts find crossings', () => {
  const bars = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i));
  const rows = T.technicals(bars, [55]);
  assert.ok(rows.every((r) => !/buy|sell/i.test(`${r.value} ${r.reading}`)));
  assert.match(rows.find((r) => r.name === 'SMA 20').reading, /above/);
  assert.equal(rows.find((r) => r.name === 'SMA 200').value, 'Needs more bars');
  const c = T.crossings([bar(0, 9), bar(1, 11), bar(2, 12), bar(3, 8)], 10);
  assert.deepEqual(c.map((x) => [x.index, x.direction]), [[1, 'up'], [3, 'down']]);
});

test('saved settings from device storage are validated, never trusted', () => {
  const ids = ['a', 'b'];
  const l = T.layout({ name: 'x'.repeat(61), dataset: 'evil', interval: '1m', range: 7, chartType: 'svg',
    indicators: ['sma20', 'sma20', 'eval'], compare: ['b', 'z'], settings: { grid: 'yes', colors: 'mono' } }, ids);
  assert.deepEqual(l, { name: 'Unnamed', dataset: 'a', interval: '1d', range: 365, chartType: 'candles',
    indicators: ['sma20'], compare: ['b'], settings: { ...T.SETTINGS, colors: 'mono' } });
  assert.deepEqual(T.layouts('nope', ids), []);
  assert.deepEqual(T.templates([{ name: 'Trend', indicators: ['ema20', 'x'] }, { name: '' }]), [{ name: 'Trend', indicators: ['ema20'] }]);
  assert.deepEqual(T.favorites([{ kind: 'indicator', source: 'builtin', id: 'rsi', name: 'RSI 14' },
    { kind: 'indicator', source: 'builtin', id: 'nope' }, { kind: 'script', source: 'mine', id: '1' }]).map((f) => f.id), ['rsi']);
  assert.deepEqual(T.alerts([{ dataset: 'a', level: 5, id: 'k' }, { dataset: 'a', level: -1 }, { dataset: 'q', level: 2 }], ids), [{ id: 'k', dataset: 'a', level: 5 }]);
  assert.deepEqual(T.watchlist(['b', 'b', 'x', 3], ids), ['b']);
});

test('drawings carry a short on-chart tag', () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(i, 100 + i));
  const ctx = { bars, intervalDays: 1 };
  assert.equal(T.buildDrawing('long', [{ logical: 1, price: 100 }, { logical: 5, price: 120 }, { logical: 5, price: 90 }], ctx).tag, 'Long · R/R 2.00');
  assert.equal(T.buildDrawing('price-range', [{ logical: 1, price: 100 }, { logical: 5, price: 110 }], ctx).tag, '+10.00 (+10.00%)');
  assert.match(T.buildDrawing('fixed-vp', [{ logical: 1, price: 1 }, { logical: 9, price: 1 }], ctx).tag, /^POC [\d,.]+$/);
  for (const t of T.TOOLS) if (t.points <= 2 && !['bars-pattern', 'ghost-feed'].includes(t.id)) {
    const pts = [{ logical: 2, price: 100 }, { logical: 6, price: 108 }].slice(0, t.points);
    assert.ok(T.buildDrawing(t.id, pts, ctx).tag.length <= 40, t.id);
  }
});
