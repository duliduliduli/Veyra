// Phone chart workspace: header, sheets, drawings, indicators, hub panels, layouts, replay.
// Self-contained (fixture API, no database):
//   NODE_PATH=/tmp/veyra-test-tools/node_modules node --test tests/e2e/chart-workspace-ui.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const web = resolve(fileURLToPath(new URL('../../apps/web/', import.meta.url)));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const day = 864e5, start = Date.UTC(2023, 0, 1);
const series = (base, drift) => Array.from({ length: 400 }, (_, i) => {
  const close = base * (1 + drift * i + 0.08 * Math.sin(i / 9)), open = close * (1 - 0.01 * Math.cos(i / 4));
  return { ts: new Date(start + i * day).toISOString().replace('.000', ''), open: open.toFixed(2), high: (Math.max(open, close) * 1.01).toFixed(2),
    low: (Math.min(open, close) * 0.99).toFixed(2), close: close.toFixed(2), volume: String(1000 + (i * 37) % 900) };
});
const bars = { 'synth-btcusd-1d-v1': series(20000, 0.001), 'synth-ethusd-1d-v1': series(1500, -0.0005) };
const datasets = Object.entries(bars).map(([id, rows]) => ({ dataset_id: id, provider: 'veyra-synthetic',
  instrument_id: id.includes('btc') ? 'SYNTH:BTC-USD' : 'SYNTH:ETH-USD', quote_currency: 'USD', resolution: '1d',
  price_basis: 'synthetic last', coverage_start: rows[0].ts, coverage_end: rows.at(-1).ts, bars: rows.length,
  license: 'synthetic; test fixture', allowed_uses: ['display'], export_policy: 'allowed', price_nano: 0, manifest_hash: 'sha256:fixture', quality_findings: 0 }));

const server = createServer(async (req, res) => {
  const path = normalize(new URL(req.url, 'http://x').pathname === '/' ? '/index.html' : new URL(req.url, 'http://x').pathname);
  const file = join(web, path);
  if (!file.startsWith(web) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': types[extname(file)] || 'text/plain' }).end(await readFile(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
test.after(async () => { await browser.close(); server.close(); });

async function open(scheme = 'light') {
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'en-US', colorScheme: scheme });
  const errors = [];
  await context.route('**/v1/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/v1/catalog/datasets') return route.fulfill({ json: { datasets } });
    const id = url.pathname.match(/datasets\/([^/]+)\/bars$/)?.[1];
    if (bars[id]) return route.fulfill({ json: { dataset_id: id, bars: bars[id] } });
    if (url.pathname === '/v1/public/strategies') return route.fulfill({ json: { strategies: [
      { id: '11111111-2222-4333-8444-555555555555', title: 'Fixture breakout', description: 'test', content_hash: 'sha256:x', entrypoint: 'strategy.py', published_at: '2026-10-01T00:00:00Z' }] } });
    errors.push(`Unexpected API request ${url.pathname}`);
    return route.fulfill({ status: 500, json: { detail: 'unexpected' } });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${base}/#markets`);
  await page.waitForSelector('#market-chart canvas');
  await page.waitForFunction(() => document.querySelector('#market-meta').textContent.startsWith('As of'));
  const box = await page.locator('#market-chart').boundingBox();
  const tap = async (fx, fy) => { await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy); await page.waitForTimeout(80); };
  const hub = async (key) => { await page.click('#open-hub'); await page.click(`[data-hub="${key}"]`); };
  const objects = async () => { await hub('objects'); const names = await page.locator('#panel-body .grow strong').allTextContents(); await page.click('#panel-sheet [data-close]'); return names; };
  const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'No horizontal overflow');
  return { context, page, errors, tap, hub, objects, noOverflow };
}

for (const scheme of ['light', 'dark']) {
  test(`header, toolbar and timeframe sheet (${scheme})`, async () => {
    const { context, page, errors, noOverflow } = await open(scheme);
    assert.equal(await page.textContent('#market-symbol'), 'BTC-USD');
    assert.match(await page.textContent('#market-source'), /^BTC \/ USD · veyra-synthetic/);
    assert.match(await page.textContent('#market-change'), /^[▲▼] [+−][\d,.]+ \([+-][\d.]+% · last day\)$/);
    for (const id of ['open-intervals', 'open-drawings', 'chart-indicators', 'open-broker', 'open-hub', 'chart-undo', 'chart-fullscreen']) {
      assert.ok(await page.isVisible(`#${id}`), id);
    }
    assert.equal(await page.isDisabled('#chart-undo'), true, 'Nothing to undo yet');
    await page.click('#open-intervals');
    assert.equal(await page.isDisabled('[data-interval="15m"]'), true, 'Intraday is honest about daily-only data');
    await page.click('[data-interval="1w"]');
    assert.equal(await page.isVisible('#intervals-sheet'), false);
    assert.match(await page.textContent('#open-intervals'), /^1W/);
    await page.click('#chart-fullscreen');
    assert.ok(await page.evaluate(() => document.body.classList.contains('chart-fullscreen')));
    await page.keyboard.press('Escape');
    assert.equal(await page.getAttribute('#chart-fullscreen', 'aria-pressed'), 'false');
    await noOverflow();
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('drawing tools: search, categories, placement, object tree and undo', async () => {
  const { context, page, errors, tap, objects } = await open();
  await page.click('#open-drawings');
  assert.deepEqual(await page.locator('#draw-categories [role="tab"]').allTextContents(), ['Lines', 'Forecasting & measurement', 'Geometric shapes']);
  await page.fill('#draw-search', 'volume');
  assert.deepEqual(await page.locator('#draw-tiles .tile').allTextContents(), ['▤Fixed range volume profile', '⫣Anchored volume profile']);
  await page.fill('#draw-search', '');
  await page.click('text=Forecasting & measurement');
  assert.equal(await page.locator('#draw-tiles .tile').count(), 12);
  await page.click('[data-tool="long"]');
  assert.equal(await page.isVisible('#draw-bar'), true);
  await tap(0.3, 0.5); await tap(0.5, 0.3); await tap(0.5, 0.7);
  assert.equal(await page.isVisible('#draw-bar'), false);
  assert.match(await page.textContent('#status'), /^Long · target \+[\d.]+% · stop −[\d.]+% · reward\/risk [\d.]+$/);
  await page.click('#open-drawings'); await page.fill('#draw-search', 'price range'); await page.click('[data-tool="price-range"]');
  await tap(0.2, 0.4); await tap(0.4, 0.6);
  assert.deepEqual((await objects()).filter((n) => !/Volume/.test(n)), ['Long position', 'Price range']);
  assert.equal(await page.getAttribute('#chart-undo', 'aria-label'), 'Undo: Add Price range');
  await page.click('#chart-undo');
  assert.deepEqual((await objects()).filter((n) => !/Volume/.test(n)), ['Long position']);
  await page.click('#open-drawings'); await page.fill('#draw-search', 'long'); await page.click('[data-tool="long"]');
  await tap(0.3, 0.5); await tap(0.5, 0.7); await tap(0.5, 0.2);
  assert.match(await page.textContent('#status'), /target must be above the entry/);
  await page.click('#draw-cancel');
  // Remove all, switch interval, undo: old drawings must not come back onto new bars.
  await page.click('#open-hub'); await page.click('[data-hub="objects"]'); await page.click('#chart-clear');
  await page.click('#panel-sheet [data-close]');
  await page.click('#open-intervals'); await page.click('[data-interval="3d"]');
  if (!(await page.isDisabled('#chart-undo'))) await page.click('#chart-undo');
  assert.deepEqual((await objects()).filter((n) => !/Volume/.test(n)), [], 'Undo never restores drawings onto different bars');
  assert.deepEqual(errors, []);
  await context.close();
});

test('indicators browser: built-ins, panes, favorites filters, community and honest gaps', async () => {
  const { context, page, errors } = await open();
  await page.click('#chart-indicators');
  for (const id of ['chart-ind-ema20', 'chart-ind-macd', 'chart-rsi']) await page.click(`#${id}`);
  assert.equal(await page.isVisible('#macd-pane'), true);
  assert.equal(await page.isVisible('#rsi-pane'), true);
  assert.match(await page.textContent('#indicator-body'), /Not available: crypto assets have no company fundamentals/);
  await page.locator('#chart-ind-ema20 ~ .star').click();
  await page.click('text=★ Favorites');
  assert.deepEqual(await page.locator('#indicator-body .grow strong').allTextContents(), ['EMA 20']);
  await page.click('#indicator-body >> text=Strategies');
  assert.match(await page.textContent('#indicator-body'), /No favorites match/);
  await page.click('#indicator-back');
  await page.click('text=Editors’ picks');
  assert.match(await page.textContent('#indicator-body'), /No editors’ picks yet/);
  await page.click('#indicator-body >> text=See trending');
  await page.waitForSelector('#indicator-body a.doc');
  assert.match(await page.textContent('#indicator-body'), /Fixture breakout/);
  await page.locator('#indicator-body .star').first().click();
  await page.click('#indicator-back'); await page.click('text=★ Favorites');
  assert.deepEqual(await page.locator('#indicator-body .grow strong').allTextContents(), ['EMA 20', 'Fixture breakout']);
  assert.deepEqual(errors, []);
  await context.close();
});

test('analysis hub: every panel opens, disabled tiles explain why, layouts round-trip', async () => {
  const { context, page, errors, hub, noOverflow } = await open();
  await page.click('#open-hub');
  for (const key of ['financials', 'forecast']) assert.equal(await page.isDisabled(`[data-hub="${key}"]`), true);
  await page.click('#hub-sheet [data-close]');
  for (const [key, title] of [['panes', 'Layout setup'], ['open', 'Open layout'], ['settings', 'Chart settings'], ['templates', 'Indicator templates'],
    ['compare', 'Compare symbols'], ['alerts', 'Alerts'], ['objects', 'Object tree'], ['details', 'Symbol details'], ['technicals', 'Technicals'], ['broker', 'Trade with a broker']]) {
    await hub(key);
    assert.equal(await page.textContent('#panel-title'), title);
    await noOverflow();
    await page.click('#panel-back');
    await page.click('#hub-sheet [data-close]');
  }
  await hub('technicals');
  assert.doesNotMatch(await page.textContent('#panel-body'), /\b(buy|sell)\b/i, 'Readings are not ratings');
  await page.click('#panel-sheet [data-close]');
  await page.click('#open-intervals'); await page.click('[data-interval="1w"]');
  await hub('save');
  assert.equal(await page.textContent('#panel-title'), 'Manage “Unnamed”', 'Unnamed layouts ask for a name first');
  await page.fill('#layout-name', 'Swing');
  await page.click('#panel-body >> text=Save');
  await page.click('#panel-sheet [data-close]');
  await hub('new');
  assert.match(await page.textContent('#open-intervals'), /^1D/);
  await page.click('#open-hub');
  assert.equal(await page.textContent('#hub-layout-name'), 'Unnamed');
  await page.click('[data-hub="open"]');
  await page.click('#panel-body >> text=Open');
  assert.match(await page.textContent('#open-intervals'), /^1W/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('compare, alerts with event markers, replay and watchlist', async () => {
  const { context, page, errors, hub, tap, objects } = await open();
  await hub('compare');
  await page.click('#panel-body >> text=Add');
  await page.click('#panel-sheet [data-close]');
  await hub('alerts');
  await page.fill('#alert-level', '21000');
  await page.click('text=Add alert');
  assert.match(await page.textContent('#panel-body'), /BTC-USD crosses 21,000\d+ crossings? in the visible range/);
  await page.click('#panel-sheet [data-close]');
  const names = await objects();
  assert.ok(names.includes('ETH-USD') && names.includes('Alert at 21,000'), names.join());
  await hub('replay');
  await tap(0.5, 0.5);
  const first = await page.textContent('#replay-label');
  await page.click('#replay-step'); await page.click('#replay-step');
  const [a, b] = [first, await page.textContent('#replay-label')].map((t) => Number(t.match(/bar (\d+) of/)[1]));
  assert.equal(b, a + 2);
  await page.click('#open-intervals'); await page.click('[data-interval="1w"]');
  assert.equal(await page.isVisible('#replay-bar'), false, 'Changing the interval ends a replay');
  await hub('replay'); await tap(0.5, 0.5);
  await page.click('#replay-exit');
  assert.equal(await page.isVisible('#replay-bar'), false);
  await page.click('#browse-assets');
  await page.locator('#browse-list .star').first().click();
  await page.click('#browse-tab-watch');
  assert.equal(await page.locator('#browse-list > li').count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});
