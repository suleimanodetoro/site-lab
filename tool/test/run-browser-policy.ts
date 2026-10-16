import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseCaptureArgs, runCapture } from '../capture.js';
import { openSession } from '../lib/browser.js';
import { load } from '../lib/page-prep.js';
import type { RunReport } from '../lib/types.js';

const requests: { path: string; method: string; body: string }[] = [];
let port = 0;
let checks = 0;
function check(name: string, action: () => void) { action(); checks++; console.log(`PASS ${name}`); }
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push({ path, method: request.method ?? '', body: Buffer.concat(chunks).toString('utf8') });
  if (path === '/start') { response.writeHead(302, { Location: `http://localhost:${port}/final` }).end(); return; }
  if (path === '/post') { response.writeHead(200, { 'Content-Type': 'text/plain' }).end('post accepted'); return; }
  if (path === '/worker.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    response.end("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));"); return;
  }
  const status = path === '/403' ? 403 : path === '/429' ? 429 : 200;
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  if (path === '/final') {
    response.end(`<h1>Redirect arrived</h1><a id="popup" href="/popup" target="_blank">Open popup</a><script>fetch('/post', {method:'POST', body:'fixture payload'}).then(response => response.text()).then(text => { document.body.dataset.result = text; });</script>`);
  } else if (path === '/challenge') {
    response.end('<h1>Challenge fixture</h1><div class="cf-challenge g-recaptcha cf-turnstile">Local marker only</div>');
  } else response.end(`<h1>${path === '/popup' ? 'Popup fixture' : `HTTP ${status} fixture`}</h1>`);
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Fixture did not bind a port');
port = address.port;
try {
  for (const engine of ['chromium', 'webkit'] as const) {
    const options = parseCaptureArgs([`http://127.0.0.1:${port}/start`, '--engines', engine, '--widths', '390', '--no-video']);
    const session = await openSession(engine, 390, options);
    try {
      await load(session, options);
      check(`${engine}: HTTP redirect between different hostnames loads normally`, () => assert.equal(session.page.url(), `http://localhost:${port}/final`));
      await session.page.waitForFunction(() => document.body.dataset.result === 'post accepted');
      check(`${engine}: page POST requests reach the server`, () => assert(requests.some(request => request.path === '/post' && request.method === 'POST' && request.body === 'fixture payload')));

      const popupReady = session.page.waitForEvent('popup');
      await session.page.locator('#popup').click();
      const popup = await popupReady;
      await popup.waitForLoadState('load');
      check(`${engine}: page popups remain open`, () => assert.equal(popup.isClosed(), false));
      assert.equal(await popup.locator('h1').textContent(), 'Popup fixture');
      await popup.close();

      if (engine === 'chromium') {
        const active = await session.page.evaluate(async () => {
          await navigator.serviceWorker.register('/worker.js');
          return Boolean((await navigator.serviceWorker.ready).active);
        });
        check('chromium: service worker registration is not blocked', () => assert(active));
      }
      for (const path of ['/403', '/429', '/challenge']) {
        await load(session, { ...options, url: `http://127.0.0.1:${port}${path}` });
        const heading = await session.page.locator('h1').textContent();
        const screenshot = await session.page.screenshot();
        check(`${engine}: ${path} stays open and can be captured`, () => {
          assert.equal(heading, path === '/challenge' ? 'Challenge fixture' : `HTTP ${path.slice(1)} fixture`);
          assert(screenshot.length > 0); assert.equal(session.page.isClosed(), false);
        });
      }
    } finally { await session.close(); }
  }
  const captureRoot = await mkdtemp(resolve('.test-browser-'));
  try {
    const originalUrl = `http://127.0.0.1:${port}/start`;
    const finalUrl = `http://localhost:${port}/final`;
    const captured = await runCapture(parseCaptureArgs([originalUrl, '--engines', 'chromium', '--widths', '390', '--no-video', '--no-hover', '--out', join(captureRoot, 'capture')]));
    const provenance = await readFile(join(captured.out, 'SOURCE.md'), 'utf8');
    const summary = JSON.parse(await readFile(join(captured.out, 'summary.json'), 'utf8')) as RunReport;
    check('redirected capture records its destination and custom output warning in provenance and summary', () => {
      assert.equal(captured.status, 'complete');
      assert(provenance.includes(`- URL: ${originalUrl}`));
      assert(provenance.includes(`- Captured URL: ${finalUrl}`));
      assert(provenance.includes('Custom output outside captures/'));
      assert.equal(summary.url, originalUrl);
      assert.deepEqual(summary.resolvedUrls, [finalUrl]);
      assert(summary.warnings.some(warning => warning.includes('Custom output outside captures/')));
    });
  } finally { await rm(captureRoot, { recursive: true, force: true }); }
  console.log(`\nPASS ${checks} local browser behavior checks`);
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
