const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = new Set(['index.html', 'manifest.json', 'sw.js', 'tarot16.png',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']);
const types = { '.html': 'text/html', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png' };
let server, browser, base, failedAsset;

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const name = url.pathname === '/tarot/' ? 'index.html' : url.pathname.slice('/tarot/'.length);
    if (!url.pathname.startsWith('/tarot/') || !files.has(name) || name === failedAsset) {
      res.writeHead(404, { 'Content-Type': 'text/html' }).end('<h1>Not found</h1>');
      return;
    }
    if (url.searchParams.has('failure')) {
      res.writeHead(503, { 'Content-Type': 'text/html' }).end('<h1>Unavailable</h1>');
      return;
    }
    if (url.searchParams.has('json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"maintenance":true}');
      return;
    }
    try {
      res.writeHead(200, { 'Content-Type': types[path.extname(name)], 'Cache-Control': 'no-store' });
      res.end(await readFile(path.join(root, name)));
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/tarot/`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox'] });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function app(t, options = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  if (options.blockStorage) await context.addInitScript(() => {
    Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new Error('Storage blocked'); };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'no browser exceptions'));
  await page.goto(base);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve =>
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  return { context, page };
}

async function reveal(page, count) {
  await page.click('#reveal-all');
  await page.waitForFunction(n => document.querySelectorAll('.card-copy.visible:not([hidden])').length === n, count);
}

test('SW upgrades its cache and preserves other applications on the same origin', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(base + 'manifest.json');
  await page.evaluate(async () => {
    await (await caches.open('another-app-cache')).put('/other-data', new Response('keep me'));
    await (await caches.open('pixel-tarot-v4')).put('./index.html', new Response('old broken HTML'));
  });
  await page.goto(base);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve =>
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  assert.deepEqual((await page.evaluate(() => caches.keys())).sort(), ['another-app-cache', 'pixel-tarot-v5']);
  assert.equal(await page.evaluate(async () =>
    (await (await caches.open('another-app-cache')).match('/other-data')).text()), 'keep me');
});

test('404, 503 and non-HTML navigation cannot poison offline HTML', async t => {
  const { context, page } = await app(t);
  for (const target of ['missing.html', 'index.html?failure=1', 'index.html?json=1']) {
    await page.goto(base + target);
    assert(await page.evaluate(async () => {
      const response = await (await caches.open('pixel-tarot-v5')).match('./index.html');
      return response.status === 200 && (await response.text()).includes('reading-form');
    }));
  }
  await context.setOffline(true);
  await page.goto(base + 'index.html?offline-test=1');
  await page.click('button[type=submit]');
  await reveal(page, 1);
  assert(await page.evaluate(async () => {
    const image = new Image();
    image.src = './tarot16.png';
    await image.decode();
    return image.naturalWidth > 0;
  }));
});

test('HTTP asset errors are not cached and a subsequent retry succeeds', async t => {
  const { page } = await app(t);
  await page.evaluate(async () => (await caches.open('pixel-tarot-v5')).delete('./icon-192.png'));
  failedAsset = 'icon-192.png';
  try {
    assert.equal(await page.evaluate(async () => (await fetch('./icon-192.png')).status), 404);
    assert.equal(await page.evaluate(async () =>
      Boolean(await (await caches.open('pixel-tarot-v5')).match('./icon-192.png'))), false);
  } finally { failedAsset = undefined; }
  assert.equal(await page.evaluate(async () => (await fetch('./icon-192.png')).status), 200);
});

test('clearing an animation cancels all pending status changes', async t => {
  const { page } = await app(t);
  await page.evaluate(() => {
    document.querySelector('button[type=submit]').click();
    document.querySelector('.card-reveal').click();
    document.querySelector('#clear-reading').click();
  });
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('.card-block').count(), 0);
  assert.equal(await page.locator('#status').textContent(), '');
});

test('redrawing cancels pending reveal-all callbacks', async t => {
  const { page } = await app(t);
  await page.selectOption('#spread', 'past-present-future');
  await page.evaluate(async () => {
    document.querySelector('button[type=submit]').click();
    document.querySelector('#reveal-all').click();
    await new Promise(resolve => setTimeout(resolve, 70));
    document.querySelector('button[type=submit]').click();
  });
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('.card-copy.visible').count(), 0);
  assert.equal(await page.locator('.card-copy[hidden]').count(), 3);
  assert((await page.locator('#status').textContent()).includes('1枚ずつ'));
  await reveal(page, 3);
});

test('unrevealed card contents stay outside the accessibility tree', async t => {
  const { page } = await app(t);
  await page.click('button[type=submit]');
  const title = await page.locator('.card-title').textContent();
  assert(!(await page.locator('#reading-area').ariaSnapshot()).includes(title));
  await page.click('.card-reveal');
  await page.waitForSelector('.card-copy.visible');
  assert((await page.locator('#reading-area').ariaSnapshot()).includes(title));
});

test('both preference states survive reload, reopening and offline use', async t => {
  const { context, page } = await app(t);
  assert(await page.isChecked('#use-reversed'));
  for (const checked of [false, true]) {
    await page.locator('#use-reversed').setChecked(checked);
    await page.reload();
    assert.equal(await page.isChecked('#use-reversed'), checked);
    const reopened = await context.newPage();
    await reopened.goto(base);
    assert.equal(await reopened.isChecked('#use-reversed'), checked);
    await reopened.close();
  }
  await page.uncheck('#use-reversed');
  await context.setOffline(true);
  await page.reload();
  assert.equal(await page.isChecked('#use-reversed'), false);
  await page.click('button[type=submit]');
  await reveal(page, 1);
  assert((await page.locator('.direction').textContent()).includes('正位置'));
});

test('unavailable local storage does not break drawing or changing the setting', async t => {
  const { page } = await app(t, { blockStorage: true });
  assert(await page.isChecked('#use-reversed'));
  await page.uncheck('#use-reversed');
  await page.click('button[type=submit]');
  await reveal(page, 1);
  assert((await page.locator('.direction').textContent()).includes('正位置'));
});

test('all spreads, reversed results, gallery and mobile layout still work', async t => {
  const { page } = await app(t);
  await page.evaluate(() => { Math.random = () => 0.9; });
  for (const [spread, count] of [['one', 1], ['past-present-future', 3],
    ['situation-obstacle-advice', 3], ['self-other-relationship', 3]]) {
    await page.selectOption('#spread', spread);
    await page.click('button[type=submit]');
    assert.equal(await page.locator('.card-block').count(), count);
    await reveal(page, count);
    assert.equal(new Set(await page.locator('.card-title').allTextContents()).size, count);
    for (const direction of await page.locator('.direction').allTextContents()) assert(direction.includes('逆位置'));
    assert.equal(await page.locator('.card-sprite.reversed').count(), count);
  }
  await page.click('#tab-gallery-btn');
  assert.equal(await page.locator('.gallery-thumb').count(), 22);
  for (let i = 0; i < 22; i++) {
    const thumb = page.locator('.gallery-thumb').nth(i);
    const label = await thumb.getAttribute('aria-label');
    await thumb.click();
    assert.equal(await page.locator('#g-title').textContent(), label.replace('の詳細を表示', ''));
  }
  await page.click('#next-card');
  assert.equal(await page.locator('.gallery-thumb').first().getAttribute('aria-current'), 'true');
  await page.click('#prev-card');
  assert.equal(await page.locator('.gallery-thumb').last().getAttribute('aria-current'), 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
