import { chromium, webkit, type Browser, type BrowserContext, type Page, type Response } from 'playwright';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserInit, installHelpers, sha256, errorMessage, log, timeLimit, writeJson } from './util.js';
import { assetType, assetName, headerMime, isPartial, MAX_ASSET_BYTES } from './assets.js';
import type { Asset, CaptureOptions, Engine } from './types.js';

export const viewport = (width: number) => ({ width, height: width < 768 ? 844 : width === 768 ? 1024 : 900 });
export interface Session {
  browser: Browser; context: BrowserContext; page: Page;
  close: () => Promise<void>;
}
export async function openSession(engine: Engine, width: number, options: CaptureOptions, config: { har?: string; videoDir?: string; slow?: boolean } = {}): Promise<Session> {
  // Our SIGINT handler finishes the current step and saves; Playwright must not close the browser first.
  const browser = await (engine === 'chromium' ? chromium : webkit).launch({ handleSIGINT: false });
  let context: BrowserContext;
  try {
    context = await browser.newContext({ viewport: viewport(width),
      ...(config.har ? { recordHar: { path: config.har, mode: 'full' as const, content: options.assets ? 'embed' as const : 'omit' as const } } : {}),
      ...(config.videoDir ? { recordVideo: { dir: config.videoDir, size: viewport(width) } } : {}) });
  } catch (error) { await browser.close(); throw error; }
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  // Surface what real sites do behind our back: crashes, self-closing pages and popups.
  page.on('crash', () => log(`page crashed (${engine} ${width}px): ${page.url()}`));
  page.on('close', () => log(`page closed (${engine} ${width}px)`));
  context.on('page', extra => { if (extra !== page) log(`site opened another page: ${extra.url() || '(blank)'}`); });
  const session: Session = { browser, context, page,
    close: async () => {
      // A crashed page can leave context.close() hanging; never wait more than 15s before killing the browser.
      try { await Promise.race([context.close(), timeLimit(15000)]); }
      finally { await browser.close().catch(() => undefined); }
    } };
  await installHelpers(page);
  // Remember short CSS animations even when they finish before the lazy-load pass.
  await browserInit(page, () => {
    const history: unknown[] = [];
    (window as unknown as { __siteLabAnimationHistory: unknown[] }).__siteLabAnimationHistory = history;
    document.addEventListener('animationstart', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      for (const animation of target.getAnimations()) {
        const effect = animation.effect;
        if (!(effect instanceof KeyframeEffect)) continue;
        if (history.length < 6000) history.push({ target: window.__siteLabPath(target), animationName: (animation as CSSAnimation).animationName || animation.id || 'WAAPI', keyframes: effect.getKeyframes(), timing: effect.getTiming(), timeline: { type: animation.timeline?.constructor.name ?? 'none' }, observed: 'animationstart' });
      }
    }, true);
  });
  if (config.slow) {
    await browserInit(page, (fallback: boolean) => {
      let scaled = false;
      const slow = () => {
        const gsap = (window as unknown as { gsap?: { globalTimeline: { timeScale: (n: number) => void } } }).gsap;
        if (gsap && !scaled) { gsap.globalTimeline.timeScale(0.1); scaled = true; }
        // CDP covers Chromium's browser animations. WebKit has no Animation CDP;
        // use the standards-based playback rate for its optional motion pass.
        if (fallback) for (const animation of document.getAnimations()) if (animation.playbackRate !== 0.1) animation.updatePlaybackRate(0.1);
        requestAnimationFrame(slow);
      };
      requestAnimationFrame(slow);
    }, engine === 'webkit');
    if (engine === 'chromium') {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Animation.enable');
      await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
    }
  }
  return session;
}

export class ResponseCollector {
  readonly assets: Asset[] = [];
  readonly signatures = new Map<string, string[]>();
  private pending = new Set<Promise<void>>();
  private seen = new Set<string>();
  private stored = new Map<string, Promise<string>>();
  private origins = new Map<Asset, BrowserContext>();
  private partialBodies = new Map<string, string>();
  private fullDownloads = new Map<string, Awaited<ReturnType<ResponseCollector['store']>>>();
  private async store(body: Buffer, url: string, header: string) {
    const real = assetType(body, header); const hash = sha256(body);
    let saved = this.stored.get(hash);
    if (!saved) {
      saved = (async () => {
        const path = `assets/${real.type}/${assetName(url, hash, real.ext)}`;
        await mkdir(join(this.out, 'assets', real.type), { recursive: true });
        await writeFile(join(this.out, path), body);
        return path;
      })();
      this.stored.set(hash, saved);
    }
    return { ...real, sha256: hash, bytes: body.length, path: await saved };
  }
  constructor(private out: string, private enabled: boolean, private warnings: string[]) {}
  attach(page: Page, passDir?: string) {
    const listener = (response: Response) => {
      const task = (async () => {
        const type = response.request().resourceType();
        const css = type === 'stylesheet';
        if (!this.enabled && !(css && passDir) && type !== 'script') return;
        if (!/^https?:/.test(response.url())) return;
        try {
          const body = await response.body();
          if (type === 'script') {
            const text = body.toString('utf8');
            for (const [name, pattern] of [['gsap', /(?:GSAP|GreenSock|gsap\.registerPlugin)/], ['ScrollTrigger', /ScrollTrigger/], ['lenis', /(?:class Lenis|lenisVersion|lenis\/|Lenis smooth)/i], ['locomotive', /LocomotiveScroll|locomotive-scroll/]] as const) {
              if (pattern.test(text)) this.signatures.set(name, [...new Set([...(this.signatures.get(name) ?? []), `response signature: ${response.url()}`])]);
            }
          }
          const hash = sha256(body);
          if (css && passDir) {
            await mkdir(join(passDir, 'styles'), { recursive: true });
            await writeFile(join(passDir, 'styles', assetName(response.url(), hash, 'css')), body);
          }
          const key = `${response.url()} ${hash}`;
          if (!this.enabled || this.seen.has(key)) return;
          this.seen.add(key);
          const headers = response.headers();
          const saved = await this.store(body, response.url(), headers['content-type'] ?? '');
          const partial = isPartial(response.status(), headers, body.length);
          if (partial) this.partialBodies.set(saved.path, saved.sha256);
          const asset: Asset = { url: response.url(), ...saved, mime: headers['content-type'] ?? '', status: response.status(),
            partial, contentRange: headers['content-range'] ?? null, refetched: false };
          this.assets.push(asset); this.origins.set(asset, page.context());
        } catch (error) {
          this.warnings.push(`Response body unavailable: ${response.url()}: ${String(error)}`);
          const key = `${response.url()} unavailable ${response.status()}`;
          if (this.enabled && !this.seen.has(key)) {
            this.seen.add(key);
            const headers = response.headers();
            const asset: Asset = { url: response.url(), type, mime: headers['content-type'] ?? '', status: response.status(), bytes: 0, sha256: '', path: '',
              headerMime: headerMime(headers['content-type'] ?? ''), sniffedMime: null, ext: 'bin', partial: isPartial(response.status(), headers, 0), contentRange: headers['content-range'] ?? null, refetched: false };
            this.assets.push(asset); this.origins.set(asset, page.context());
          }
        }
      })();
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    };
    page.on('response', listener);
    return () => page.off('response', listener);
  }
  /** Waits for in-flight response saves, but never forever: bodies from a closed or crashed page never settle. */
  async flush(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.warnings.push(`Abandoned ${this.pending.size} response save(s) that did not finish within ${timeoutMs / 1000}s.`);
        this.pending.clear(); return;
      }
      await Promise.race([Promise.all([...this.pending]), timeLimit(remaining)]);
    }
  }
  private async fetchFull(context: BrowserContext, url: string, fallbackMime: string) {
    // APIRequestContext buffers bodies. Reject advertised oversize files before the GET,
    // and also validate the actual body size before saving it.
    const head = await context.request.head(url, { timeout: 30000 });
    try {
      if (Number(head.headers()['content-length']) > MAX_ASSET_BYTES) throw new Error('Full response exceeds the 200 MB cap');
    } finally { await head.dispose(); }
    const response = await context.request.get(url, { headers: { 'Accept-Encoding': 'identity' }, timeout: 60000 });
    try {
      if (!response.ok()) throw new Error(`Full GET returned HTTP ${response.status()}`);
      const headers = response.headers();
      if (Number(headers['content-length']) > MAX_ASSET_BYTES) throw new Error('Full response exceeds the 200 MB cap');
      const body = await response.body();
      if (body.length > MAX_ASSET_BYTES) throw new Error('Full response exceeds the 200 MB cap');
      if (isPartial(response.status(), headers, body.length)) throw new Error('Full GET returned another partial response');
      return await this.store(body, url, headers['content-type'] ?? fallbackMime);
    } finally { await response.dispose(); }
  }
  async finishPass(context: BrowserContext) {
    await this.flush();
    // One full download per URL, however many range chunks the page requested.
    const groups = new Map<string, Asset[]>();
    for (const asset of this.assets) {
      if (!asset.partial || asset.refetched || this.origins.get(asset) !== context) continue;
      groups.set(asset.url, [...(groups.get(asset.url) ?? []), asset]);
    }
    for (const [url, entries] of groups) {
      let saved = this.fullDownloads.get(url);
      let failure: string | undefined;
      if (!saved) {
        try { saved = await this.fetchFull(context, url, entries[0].mime); this.fullDownloads.set(url, saved); }
        catch (error) { failure = errorMessage(error); }
      }
      for (const asset of entries) {
        asset.refetched = true;
        // Preserve the original response status, header and partial provenance.
        if (saved) Object.assign(asset, { type: saved.type, ext: saved.ext, sniffedMime: saved.sniffedMime, bytes: saved.bytes, sha256: saved.sha256, path: saved.path });
        else asset.refetchError = failure;
      }
      if (failure) this.warnings.push(`Partial asset retained: ${url}: ${failure}`);
    }
    await this.flush();
    // Partial bodies superseded by a full download are no longer referenced; remove only those.
    const referenced = new Set(this.assets.map(asset => asset.path).filter(Boolean));
    for (const [path, hash] of this.partialBodies) {
      if (referenced.has(path)) continue;
      await rm(join(this.out, path), { force: true });
      this.partialBodies.delete(path); this.stored.delete(hash);
      this.warnings.push(`Removed partial body ${path} (superseded by full download)`);
    }
    await writeJson(join(this.out, 'assets', 'manifest.json'), this.assets);
  }
}
