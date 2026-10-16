import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { isMain } from '../lib/util.js';
import { ffmpeg, missingFfmpeg } from '../lib/binaries.js';

// An "ENTER" splash that fades in after a preloader, with a link labelled ENTER hidden behind it at the same spot.
const gatePage = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body { margin: 0; font: 16px sans-serif; } html.locked, html.locked body { overflow: hidden; height: 100%; }
section { height: 900px; padding: 40px; border-bottom: 1px solid #ccc; box-sizing: border-box; }
.spot { position: fixed; left: 50%; top: 60%; transform: translate(-50%, -50%); }
#gate { position: fixed; inset: 0; z-index: 1000; background: #111; color: #fff; opacity: 0; transition: opacity 0.4s; }
#gate.ready { opacity: 1; } #gate .enter { padding: 12px 32px; border: 1px solid #fff; }
</style><main><section><h1>Gate fixture home</h1><a id="decoy" class="spot" href="/elsewhere">ENTER</a></section><section>Two</section><section>Three</section><section>Four</section></main>
<div id="gate"><div class="spot"><div class="enter">ENTER</div></div></div>
<script>
document.documentElement.classList.add('locked');
setTimeout(() => document.querySelector('#gate').classList.add('ready'), 1200);
document.querySelector('#gate .enter').addEventListener('click', () => { const gate = document.querySelector('#gate'); gate.style.opacity = '0'; setTimeout(() => { gate.remove(); document.documentElement.classList.remove('locked'); }, 500); });
</script>`;
// A page whose document never scrolls: the wheel moves through six full-screen slides, ignoring input mid-transition.
const wheelPage = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>
html, body { margin: 0; height: 100%; overflow: hidden; font: 24px sans-serif; } #track { transition: transform 0.6s ease; }
.slide { height: 100vh; display: flex; align-items: center; justify-content: center; } #label { position: fixed; bottom: 10px; left: 10px; margin: 0; }
</style><div id="track">${['#f39', '#39f', '#3c6', '#f93', '#93f', '#fd3'].map((colour, i) => `<section class="slide" style="background:${colour}"><h1>Slide ${i + 1}</h1></section>`).join('')}</div><p id="label">Slide 1 of 6</p>
<script>
let index = 0; let busy = false;
addEventListener('wheel', event => {
  if (busy || Math.abs(event.deltaY) < 20) return;
  const next = Math.max(0, Math.min(5, index + Math.sign(event.deltaY)));
  if (next === index) return;
  index = next; busy = true;
  document.querySelector('#track').style.transform = 'translateY(-' + index * 100 + 'vh)';
  document.querySelector('#label').textContent = 'Slide ' + (index + 1) + ' of 6';
  setTimeout(() => { busy = false; }, 700);
}, { passive: true });
</script>`;

export async function startFixture(port = 0) {
  const generated = await mkdtemp(resolve('.test-fixture-'));
  const videoPath = join(generated, 'loop.webm');
  try {
    if (!ffmpeg) throw new Error(missingFfmpeg);
    await promisify(execFile)(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24', '-t', '2', '-an', '-c:v', 'libvpx', '-threads', '2', '-pix_fmt', 'yuv420p', videoPath]);
    await sharp({ create: { width: 120, height: 80, channels: 3, background: '#304568' } }).webp().toFile(join(generated, 'hero.webp'));
    await sharp({ create: { width: 120, height: 80, channels: 3, background: '#c3d9fa' } }).avif().toFile(join(generated, 'wrong.avif'));
  } catch (error) { await rm(generated, { recursive: true, force: true }); throw error; }
  const demo = fileURLToPath(new URL('./demo/', import.meta.url));
  const libraries: Record<string, string> = {
    '/node_modules/gsap/dist/gsap.min.js': resolve('node_modules/gsap/dist/gsap.min.js'),
    '/node_modules/gsap/dist/ScrollTrigger.min.js': resolve('node_modules/gsap/dist/ScrollTrigger.min.js'),
    '/node_modules/lenis/dist/lenis.min.js': resolve('node_modules/lenis/dist/lenis.min.js')
  };
  const assets: Record<string, [string, string]> = {
    '/video/loop': [videoPath, 'video/webm'],
    '/img/hero': [join(generated, 'hero.webp'), 'image/webp'],
    '/img/wrong': [join(generated, 'wrong.avif'), 'application/octet-stream'],
    '/': [demo + 'index.html', 'text/html; charset=utf-8'],
    '/demo/style.css': [demo + 'style.css', 'text/css'],
    '/demo/demo.js': [demo + 'demo.js', 'text/javascript'],
    '/demo/landscape.svg': [demo + 'landscape.svg', 'image/svg+xml']
  };
  const requests: { path: string; method: string; at: number; range?: string }[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push({ path, method: request.method ?? '', at: Date.now(), range: request.headers.range });
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    if (path === '/blocked') { response.writeHead(403, { 'Content-Type': 'text/html' }).end('<h1>Access blocked</h1>'); return; }
    if (path === '/consent/accept' || path === '/consent/reject') { response.writeHead(204).end(); return; }
    if (path === '/accept-only') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<main><h1>Accept-only banner</h1><p>Content</p></main><div id="cookie-bar" style="position:fixed;bottom:0;left:0;right:0;padding:12px;background:#eee">This site uses cookies. <button onclick="fetch(\'/consent/accept\')">Accept all</button></div>'); return; }
    if (path === '/reload-on-reject') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<main style="height:2500px"><h1>Reloads after a consent choice</h1></main><div id="cookie-dialog" style="position:fixed;bottom:0;left:0;padding:12px;background:#eee" hidden>This website uses cookies. <button id="accept">ACCEPT ALL</button><button id="decline">DECLINE ALL</button></div><script>if (!localStorage.getItem("choice")) document.querySelector("#cookie-dialog").hidden = false; document.querySelector("#decline").onclick = () => { localStorage.setItem("choice", "declined"); document.querySelector("#cookie-dialog").remove(); setTimeout(() => location.reload(), 1200); }; document.querySelector("#accept").onclick = () => fetch("/consent/accept");</script>'); return; }
    if (path === '/fake-lenis') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<script>window.lenis = { options: {} };</script><main style="height:3000px"><h1>Page with a non-scroller lenis global</h1></main>'); return; }
    if (path === '/gate') { response.writeHead(200, { 'Content-Type': 'text/html' }).end(gatePage); return; }
    if (path === '/wheel') { response.writeHead(200, { 'Content-Type': 'text/html' }).end(wheelPage); return; }
    if (path === '/cross-origin-css') {
      // Served from 127.0.0.1, its stylesheets from localhost: a different origin, so the browser hides their rules.
      const port = (server.address() as { port: number }).port;
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="http://localhost:${port}/cross.css"><link rel="stylesheet" media="(min-width: 1200px)" href="http://localhost:${port}/wide.css"><main style="height:2000px"><h1>Cross-origin stylesheets</h1></main><script>matchMedia('(max-width: 599px)');</script>`); return;
    }
    if (path === '/cross.css') { response.writeHead(200, { 'Content-Type': 'text/css' }).end('h1 { color: #333 } /* @media (min-width: 5000px) is a comment */ @media (min-width: 900px) { h1 { color: #000 } } @media screen and (max-width: 47.9375rem) { h1 { font-size: 20px } }'); return; }
    if (path === '/wide.css') { response.writeHead(200, { 'Content-Type': 'text/css' }).end('body { background: #fafafa }'); return; }
    if (path === '/elsewhere') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Navigated away</h1>'); return; }
    if (path === '/throwing-scroll') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<script src="/node_modules/gsap/dist/gsap.min.js"></script><script src="/node_modules/gsap/dist/ScrollTrigger.min.js"></script><main style="height:4000px"><h1 id="heading" style="margin-top:1500px">A tween that throws</h1></main><script>gsap.registerPlugin(ScrollTrigger); gsap.to("#heading", { x: 200, scrollTrigger: { trigger: "#heading", start: "top bottom", scrub: true }, onStart: () => document.querySelector("#missing-video").play() });</script>'); return; }
    if (path === '/challenge') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<div class="cf-challenge">Local bot-wall test</div>'); return; }
    const asset = assets[path] ?? (libraries[path] ? [libraries[path], 'text/javascript'] : undefined);
    if (!asset) { response.writeHead(404).end('Not found'); return; }
    try {
      const body = await readFile(asset[0]);
      const headers = { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
      const range = request.headers.range;
      if (range && request.method === 'GET') {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) { response.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end(); return; }
        const start = match[1] ? Number(match[1]) : Math.max(0, body.length - Number(match[2]));
        const end = match[1] && match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
        if (start > end || start >= body.length) { response.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end(); return; }
        response.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${body.length}` }).end(body.subarray(start, end + 1));
      } else response.writeHead(200, { ...headers, 'Content-Length': body.length }).end(request.method === 'HEAD' ? undefined : body);
    }
    catch { response.writeHead(500).end('Fixture resource unavailable'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind a port');
  return { server, videoPath, url: `http://127.0.0.1:${address.port}/`, requests,
    close: async () => { try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } finally { await rm(generated, { recursive: true, force: true }); } } };
}
if (isMain(import.meta)) {
  startFixture(Number(process.argv[2] ?? 0)).then(({ url }) => console.log(`Local fixture: ${url}`)).catch(error => { console.error(error); process.exitCode = 1; });
}
