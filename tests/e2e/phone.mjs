// Phone journey against a running stack (API on :8000 + `python -m veyra_scheduler all`).
//   npm i --no-save playwright && node tests/e2e/phone.mjs [light|dark] [screenshot-dir]
// Fails on console errors, horizontal overflow, a stale quote, or a wrong maximum.
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';

const BASE = process.env.VEYRA_URL || 'http://localhost:8000';
const [scheme = 'light', shots] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices['iPhone 13'], colorScheme: scheme,
  locale: 'en-US' })).newPage();
const problems = [];
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(m.text()));
page.on('pageerror', (e) => problems.push(e.message));
const check = async (name) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (overflow > 0) problems.push(`${name}: ${overflow}px horizontal overflow`);
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

try {
  await page.goto(BASE);
  await page.fill('#signin-email', `phone-${Date.now()}@example.test`);
  await page.click('text=Continue');
  await page.waitForSelector('#market-chart canvas');
  await check('markets');

  await page.click('.tabs >> text=Wallet');
  await page.click('[data-topup="10.00"]');
  await page.waitForSelector('text=Added $10.00');
  await check('wallet');

  await page.click('.tabs >> text=Code');
  await page.fill('#new-project-name', 'BTC trend');
  await page.click('#new-project-form button');
  await page.waitForFunction(() => document.getElementById('editor').value.includes('SmaCross'));
  await check('editor');

  const quoteResponse = page.waitForResponse((r) => r.url().endsWith('/v1/quotes'));
  await page.click('text=Get price');
  const quote = await (await quoteResponse).json();
  await page.waitForSelector('#approve:visible');
  // The button must show the same maximum the server formatted.
  assert.ok((await page.textContent('#approve')).includes(quote.estimate.display.maximum));
  // Changing an input invalidates the quote.
  await page.fill('#bt-cash', '20000');
  assert.equal(await page.isVisible('#quote-box'), false, 'stale quote still approvable');
  await page.click('text=Get price');
  await page.waitForSelector('#approve:visible');
  await check('quote');

  await page.click('#approve');
  await page.waitForURL(/#run\//);
  await page.waitForSelector('#run-tiles dd', { timeout: 60000 });
  assert.equal(await page.textContent('#run-state'), 'completed');
  await check('report');

  await page.click('.tabs >> text=Runs');
  await page.reload();
  await page.waitForSelector('#run-list a');
  assert.match(await page.textContent('#run-list'), /charged \$/);
  assert.deepEqual(problems, []);
  console.log(`phone journey ok (${scheme})`);
} finally {
  await browser.close();
}
