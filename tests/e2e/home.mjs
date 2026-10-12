// Isolated, read-only home QA; no running API, sign-in, billing, or database is used.
// npm i --no-save playwright && node tests/e2e/home.mjs [screenshot-dir]
// Pure fixture/aggregation checks without a browser: node tests/e2e/home.mjs --logic-only
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const logicOnly = process.argv.includes('--logic-only');
const shots = logicOnly ? null : process.argv[2];
if (shots) await mkdir(shots, { recursive: true });

// Generate the real deterministic fixtures without importing the API or database.
const fixtures = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c', `
import json
from dataclasses import asdict
from veyra_sim import data
datasets, series = [], {}
for spec in data.CATALOG.values():
    bars = data.generate_bars(spec)
    series[spec.dataset_id] = [asdict(bar) for bar in bars]
    datasets.append({
        'dataset_id': spec.dataset_id, 'provider': spec.provider,
        'instrument_id': spec.instrument.instrument_id,
        'quote_currency': spec.instrument.quote_currency, 'resolution': '1d',
        'price_basis': 'synthetic last', 'coverage_start': bars[0].ts,
        'coverage_end': bars[-1].ts, 'bars': len(bars), 'license': spec.license,
        'allowed_uses': ['display', 'backtest', 'report'], 'export_policy': 'allowed',
        'price_nano': 0, 'manifest_hash': data.manifest_hash(bars),
        'quality_findings': len(data.quality_findings(bars)),
    })
print(json.dumps({'datasets': datasets, 'series': series}, default=str))
`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, PYTHONPATH: [join(root, 'packages/python-sdk/src'),
    join(root, 'runtimes/simulator/src'), process.env.PYTHONPATH].filter(Boolean).join(':') },
}));

if (logicOnly) {
  const source = await readFile(join(root, 'apps/web/app.js'), 'utf8');
  const start = source.indexOf('function aggregateBars('), end = source.indexOf('\nfunction clearTrends(');
  assert.ok(start > 0 && end > start, 'Aggregation function must be found in the app');
  const aggregate = runInNewContext(`${source.slice(start, end)}; aggregateBars`, {
    toTime: (ts) => Date.parse(ts) / 1000, isoDay: (date) => date.toISOString().slice(0, 10),
  });
  for (const { dataset_id: id } of fixtures.datasets) {
    for (const days of [90, 365, 0]) {
      const cutoff = Date.parse(fixtures.series[id].at(-1).ts) - days * 864e5;
      const bars = fixtures.series[id].filter((bar) => !days || Date.parse(bar.ts) >= cutoff);
      for (const interval of ['day', 'week', 'month']) {
        assert.deepEqual(JSON.parse(JSON.stringify(aggregate(bars, interval))), expectedBars(id, days, interval));
      }
    }
  }
  assert.deepEqual(JSON.parse(JSON.stringify(aggregate([], 'month'))), []);
  console.log('Aggregation passed for both synthetic assets, all 3 ranges and all 3 intervals, plus empty input.');
  process.exit(0);
}

const { chromium, devices } = createRequire(import.meta.url)('playwright');

const assets = {
  '/': ['index.html', 'text/html'],
  '/index.html': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/app.css': ['app.css', 'text/css'],
  '/vendor/lightweight-charts.standalone.production.js':
    ['vendor/lightweight-charts.standalone.production.js', 'text/javascript'],
};
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/favicon.ico') { response.writeHead(204).end(); return; }
  const asset = assets[path];
  if (request.method !== 'GET' || !asset) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': asset[1] });
  response.end(await readFile(join(root, 'apps/web', asset[0])));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
  args: ['--no-sandbox'],
});

async function openPage(options, { datasets = fixtures.datasets, respond, waitReady = true } = {}) {
  const context = await browser.newContext({ ...options, locale: 'en-US' });
  const errors = [], requests = [];
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET' || url.origin !== base) {
      errors.push(`Blocked unexpected request: ${request.method()} ${request.url()}`);
      return route.abort();
    }
    if (!url.pathname.startsWith('/v1/')) return route.continue();
    requests.push(url.pathname + url.search);
    if (url.pathname === '/v1/catalog/datasets') {
      return route.fulfill({ json: { datasets } });
    }
    const datasetId = url.pathname.match(/^\/v1\/catalog\/datasets\/([^/]+)\/bars$/)?.[1];
    if (!fixtures.series[datasetId]) {
      errors.push(`Blocked unexpected API request: ${request.url()}`);
      return route.abort();
    }
    const start = url.searchParams.get('start'), end = url.searchParams.get('end');
    const bars = fixtures.series[datasetId].filter((bar) =>
      (!start || bar.ts.slice(0, 10) >= start) && (!end || bar.ts.slice(0, 10) < end));
    return route.fulfill(respond ? await respond(datasetId, bars) : { json: { dataset_id: datasetId, bars } });
  });
  const page = await context.newPage();
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && errors.push(message.text()));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  if (waitReady) {
    await page.waitForSelector('#market-chart canvas');
    await page.waitForFunction(() => document.querySelector('#market-meta').textContent.startsWith('As of'));
  }
  return { context, page, errors, requests };
}

async function chartData(page) {
  return page.evaluate(() => ({ candles: charts.candles.data(), line: charts.marketLine.data(),
    volume: charts.volume.data(), sma: charts.sma.data(),
    range: charts['market-chart'].timeScale().getVisibleLogicalRange() }));
}

function expectedBars(id, days, interval = 'day') {
  const source = fixtures.series[id], end = Date.parse(source.at(-1).ts), groups = new Map();
  for (const bar of source.filter((bar) => !days || Date.parse(bar.ts) >= end - days * 864e5)) {
    const timestamp = Date.parse(bar.ts), date = new Date(timestamp);
    const weekStart = timestamp - ((date.getUTCDay() + 6) % 7) * 864e5;
    const key = interval === 'month' ? bar.ts.slice(0, 7) : interval === 'week' ? weekStart : timestamp;
    const group = groups.get(key);
    if (group) {
      group.high = Math.max(group.high, +bar.high);
      group.low = Math.min(group.low, +bar.low);
      group.close = +bar.close;
      group.volume += +bar.volume;
    } else groups.set(key, { time: timestamp / 1000, open: +bar.open, high: +bar.high,
      low: +bar.low, close: +bar.close, volume: +bar.volume });
  }
  return [...groups.values()];
}

async function checkChartData(page, days, interval = 'day', id = fixtures.datasets[0].dataset_id) {
  const actual = await chartData(page), expected = expectedBars(id, days, interval);
  assert.deepEqual(actual.candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })),
    expected.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
  assert.deepEqual(actual.line, expected.map((bar) => ({ time: bar.time, value: bar.close })));
  assert.deepEqual(actual.volume.map(({ time, value }) => ({ time, value })),
    expected.map((bar) => ({ time: bar.time, value: bar.volume })));
  assert.deepEqual(actual.sma, expected.slice(19).map((bar, index) => ({ time: bar.time,
    value: expected.slice(index, index + 20).reduce((sum, item) => sum + item.close, 0) / 20 })));
}

async function checkLayout(page, name) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `${name}: ${overflow}px horizontal overflow`);
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

try {
  for (const [device, settings] of Object.entries({
    desktop: { viewport: { width: 1440, height: 1000 } },
    mobile: { ...devices['iPhone 13'] },
  })) {
    for (const colorScheme of ['light', 'dark']) {
      const { context, page, errors, requests } = await openPage({ ...settings, colorScheme });
      const name = `${device}-${colorScheme}`;
      const initialURL = page.url();
      assert.match(await page.textContent('#market-symbol'), /BTC/);
      assert.match(await page.textContent('#market-meta'), /synthetic/i);
      await checkChartData(page, 365);
      await checkLayout(page, `${name}-home`);

      // Search, no-match recovery, selecting a result, and dismissal.
      await page.fill('#asset-search', 'eth');
      await page.locator('#asset-results button').waitFor();
      assert.equal(await page.locator('#asset-results button').count(), 1);
      await page.locator('#asset-results button').click();
      await page.waitForFunction(() => document.querySelector('#market-symbol').textContent.includes('ETH'));
      await page.waitForFunction(() => document.querySelector('#market-meta').textContent.startsWith('As of'));
      await checkChartData(page, 365, 'day', fixtures.datasets[1].dataset_id);
      assert.equal(await page.isVisible('#asset-results'), false);
      await page.fill('#asset-search', 'no-such-market');
      assert.equal(await page.locator('#asset-results button').count(), 0);
      await page.fill('#asset-search', 'btc');
      await page.keyboard.press('Escape');
      assert.equal(await page.isVisible('#asset-results'), false);

      // Modal reopening, repeated activation, Escape and explicit close.
      await page.click('#browse-assets');
      assert.equal(await page.inputValue('#browse-provider'), '');
      assert.equal(await page.inputValue('#browse-sort'), 'name');
      await page.locator('#asset-browser[open]').waitFor();
      await page.evaluate(() => document.querySelector('#browse-assets').click());
      assert.equal(await page.locator('#asset-browser[open]').count(), 1);
      assert.equal(await page.locator('#browse-list button').count(), 2);
      await checkLayout(page, `${name}-browse`);
      await page.goBack();
      await page.waitForSelector('#asset-browser', { state: 'hidden' });
      await page.goForward();
      await page.locator('#asset-browser[open]').waitFor();
      await page.keyboard.press('Escape');
      await page.waitForSelector('#asset-browser', { state: 'hidden' });
      await page.waitForURL(initialURL);
      await page.click('#browse-assets');
      await page.selectOption('#browse-provider', 'veyra-synthetic');
      await page.selectOption('#browse-sort', 'name-desc');
      assert.match(await page.locator('#browse-list button').first().textContent(), /ETH/);
      await page.fill('#browse-search', 'btc');
      assert.equal(await page.locator('#browse-list button').count(), 1);
      await page.click('#close-browse');
      await page.waitForSelector('#asset-browser', { state: 'hidden' });
      await page.waitForURL(initialURL);
      await page.click('#browse-assets');
      assert.equal(await page.inputValue('#browse-provider'), 'veyra-synthetic');
      assert.equal(await page.inputValue('#browse-sort'), 'name-desc');
      await page.fill('#browse-search', 'btc');
      await page.locator('#browse-list button').click();
      await page.waitForFunction(() => document.querySelector('#market-symbol').textContent.includes('BTC'));
      await page.waitForSelector('#asset-browser', { state: 'hidden' });
      await page.waitForURL(initialURL);
      await page.waitForFunction(() => document.querySelector('#market-meta').textContent.startsWith('As of'));

      // Date-range controls remain below the chart and filter the cached real fixtures.
      const chartBox = await page.locator('#market-chart').boundingBox();
      const filterBox = await page.locator('.market-filters').boundingBox();
      assert.ok(filterBox.y > chartBox.y + chartBox.height, 'Date filters should stay below the chart');
      for (const range of ['90', '0', '365']) {
        await page.click(`[data-range="${range}"]`);
        await page.waitForFunction((value) => document.querySelector(`[data-range="${value}"]`).getAttribute('aria-pressed') === 'true', range);
        await checkChartData(page, Number(range));
      }

      for (const interval of ['week', 'month', 'day']) {
        await page.click(`[data-interval="${interval}"]`);
        assert.equal(await page.getAttribute(`[data-interval="${interval}"]`, 'aria-pressed'), 'true');
        await checkChartData(page, 365, interval);
      }
      await page.selectOption('#chart-type', 'line');
      assert.deepEqual(await page.evaluate(() => [charts.candles.options().visible, charts.marketLine.options().visible]), [false, true]);
      await checkChartData(page, 365);
      for (const [id, series, initial] of [['chart-volume', 'volume', true], ['chart-sma', 'sma', false]]) {
        await page.click(`#${id}`);
        assert.equal(await page.evaluate((series) => charts[series].options().visible, series), !initial);
        await page.click(`#${id}`);
        assert.equal(await page.evaluate((series) => charts[series].options().visible, series), initial);
      }
      await page.click('#chart-log');
      assert.equal(await page.evaluate(() => charts['market-chart'].priceScale('right').options().mode), 1);
      await page.click('#chart-log');
      assert.equal(await page.evaluate(() => charts['market-chart'].priceScale('right').options().mode), 0);
      await page.click('#chart-crosshair');
      assert.equal(await page.evaluate(() => charts['market-chart'].options().crosshair.mode), 2);
      await page.click('#chart-crosshair');
      assert.equal(await page.evaluate(() => charts['market-chart'].options().crosshair.mode), 1);
      await page.selectOption('#chart-type', 'candles');
      assert.deepEqual(await page.evaluate(() => [charts.candles.options().visible, charts.marketLine.options().visible]), [true, false]);

      const width = async () => { const { range } = await chartData(page); return range.to - range.from; };
      const initialWidth = await width();
      await page.click('#chart-zoom-in');
      assert.ok(await width() < initialWidth, 'Zoom in should decrease the visible logical range');
      const zoomedWidth = await width();
      await page.click('#chart-zoom-out');
      assert.ok(await width() > zoomedWidth, 'Zoom out should increase the visible logical range');
      await page.click('#chart-reset');
      assert.ok(Math.abs(await width() - initialWidth) < 1, 'Reset should restore the full data range');

      await page.click('#chart-trend');
      await page.locator('#market-chart').scrollIntoViewIfNeeded();
      const canvas = await page.locator('#market-chart').boundingBox();
      await page.mouse.click(canvas.x + canvas.width * 0.3, canvas.y + canvas.height * 0.4);
      assert.equal(await page.evaluate(() => trendStart !== null), true);
      await page.mouse.click(canvas.x + canvas.width * 0.6, canvas.y + canvas.height * 0.6);
      assert.equal(await page.evaluate(() => trendLines.length), 1);
      await page.click('#chart-zoom-in');
      const browseWidth = await width();
      await page.click('#browse-assets');
      await page.keyboard.press('Escape');
      await page.waitForURL(initialURL);
      assert.equal(await page.evaluate(() => trendLines.length), 1, 'Browsing without selecting must preserve drawings');
      assert.ok(Math.abs(await width() - browseWidth) < 1, 'Browsing without selecting must preserve zoom');
      await page.click('#chart-clear');
      assert.equal(await page.evaluate(() => trendLines.length), 0);
      await page.click('#chart-trend');
      await page.mouse.click(canvas.x + canvas.width * 0.3, canvas.y + canvas.height * 0.4);
      await page.mouse.click(canvas.x + canvas.width * 0.6, canvas.y + canvas.height * 0.6);
      assert.equal(await page.evaluate(() => trendLines.length), 1);
      await page.click('[data-range="90"]');
      assert.equal(await page.evaluate(() => trendLines.length), 0, 'Range changes must clear out-of-range drawings');
      await checkChartData(page, 90);
      await page.click('[data-range="365"]');

      // Navigating away and Back restores the home without unexpected API calls.
      await page.click('.tabs [data-tab="code"]');
      await page.waitForSelector('#view-code:visible');
      await page.goBack();
      await page.waitForSelector('#view-markets:visible');
      await page.waitForFunction(() => document.querySelector('#market-meta').textContent.startsWith('As of'));
      await checkChartData(page, 365);

      await checkLayout(page, `${name}-tested`);
      assert.deepEqual(errors, [], `${name}: browser errors`);
      assert.equal(requests.filter((url) => url.endsWith('/bars')).length, 2, 'Asset data should be reused across chart controls');
      console.log(`Home search, browse, chart controls, drawing, navigation, and layout passed (${name})`);
      await context.close();
    }
  }

  // Resolve an older request last; it must never replace the newer asset or range.
  let releaseBTC;
  const pendingBTC = new Promise((resolve) => { releaseBTC = resolve; });
  const race = await openPage({ viewport: { width: 1100, height: 800 } }, {
    waitReady: false,
    respond: async (id, bars) => {
      if (id === fixtures.datasets[0].dataset_id) await pendingBTC;
      return { json: { dataset_id: id, bars } };
    },
  });
  await race.page.waitForFunction(() => document.querySelector('#market-symbol').textContent.includes('BTC'));
  await race.page.click('[data-range="90"]');
  assert.equal(await race.page.evaluate(() => marketBars.length), 0);
  await race.page.fill('#asset-search', 'eth');
  await race.page.keyboard.press('Enter');
  await race.page.waitForFunction(() => document.querySelector('#market-meta').textContent.startsWith('As of'));
  await checkChartData(race.page, 90, 'day', fixtures.datasets[1].dataset_id);
  releaseBTC();
  await race.page.evaluate(() => marketCache.get('synth-btcusd-1d-v1').then(() => undefined));
  await checkChartData(race.page, 90, 'day', fixtures.datasets[1].dataset_id);
  assert.match(await race.page.textContent('#market-symbol'), /ETH/);
  assert.deepEqual(race.errors, []);
  await race.context.close();

  // Empty catalog and empty series remain useful, without stale chart content.
  const emptyCatalog = await openPage({ viewport: { width: 390, height: 844 } }, {
    datasets: [], waitReady: false,
  });
  await emptyCatalog.page.waitForFunction(() => document.querySelector('#chart-empty').textContent === 'No datasets available.');
  await emptyCatalog.page.click('#browse-assets');
  assert.equal(await emptyCatalog.page.locator('#browse-list button').count(), 0);
  await emptyCatalog.page.keyboard.press('Escape');
  await emptyCatalog.page.waitForURL(base + '/');
  assert.deepEqual(emptyCatalog.errors, []);
  await emptyCatalog.context.close();
  const emptyBars = await openPage({ viewport: { width: 390, height: 844 } }, {
    waitReady: false, respond: async (id) => ({ json: { dataset_id: id, bars: [] } }),
  });
  await emptyBars.page.waitForFunction(() => document.querySelector('#market-meta').textContent === 'No bars in this dataset.');
  assert.equal((await chartData(emptyBars.page)).candles.length, 0);
  for (const selector of ['[data-range="0"]', '[data-interval="month"]', '#chart-volume', '#chart-sma', '#chart-log']) {
    await emptyBars.page.click(selector);
  }
  assert.equal(await emptyBars.page.isVisible('#chart-empty'), true);
  assert.deepEqual(emptyBars.errors, []);
  await emptyBars.context.close();

  // A failed request is evicted from the cache and selecting again retries it.
  let attempts = 0;
  const retry = await openPage({ viewport: { width: 1100, height: 800 } }, {
    waitReady: false,
    respond: async (id, bars) => ++attempts === 1
      ? { status: 503, json: { detail: 'Synthetic fixture failure' } }
      : { json: { dataset_id: id, bars } },
  });
  await retry.page.waitForFunction(() => document.querySelector('#chart-empty').textContent.includes('Chart unavailable'));
  await retry.page.fill('#asset-search', 'btc');
  await retry.page.keyboard.press('ArrowDown');
  await retry.page.keyboard.press('Enter');
  await retry.page.waitForFunction(() => document.querySelector('#market-meta').textContent.startsWith('As of'));
  await checkChartData(retry.page, 365);
  assert.equal(attempts, 2);
  assert.deepEqual(retry.errors.filter((error) => !error.startsWith('Failed to load resource: the server responded with a status of 503')), []);
  await retry.context.close();

  for (const colorScheme of ['light', 'dark']) {
    const narrow = await openPage({ viewport: { width: 320, height: 568 }, colorScheme });
    await checkLayout(narrow.page, `narrow-${colorScheme}-home`);
    await narrow.page.click('#browse-assets');
    await checkLayout(narrow.page, `narrow-${colorScheme}-browse`);
    assert.deepEqual(narrow.errors, []);
    await narrow.context.close();
  }
  console.log('Rapid selection, empty data/catalog, retry, and narrow-screen checks passed.');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
