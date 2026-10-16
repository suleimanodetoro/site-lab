import type { CaptureControl } from './interrupt.js';
import type { Page } from 'playwright';
import type { Session } from './browser.js';
import type { CaptureOptions } from './types.js';
import { dismissConsent, type ConsentResult } from './consent.js';
import { clickSelectors, passGate, type GateResult } from './gate.js';

export interface LoadResult { consent: ConsentResult; gate: GateResult }

/**
 * Open the page, refuse optional cookies (never accept) or hide the banner, then click through an "Enter" splash.
 * `slow`: the page's animations run at 0.1× (slowed intro video), so gates take longer to appear and leave.
 */
export async function load(session: Session, options: CaptureOptions, extra: { slow?: boolean; gateShot?: string } = {}): Promise<LoadResult> {
  const page = session.page; const seen = options.seen ??= {};
  await page.goto(options.url, { waitUntil: 'load', timeout: 45000 });
  // The first load waits up to 4s for a banner; when it found none, later loads only check briefly.
  let consent: ConsentResult = options.consent ? await dismissConsent(page, seen.consent === false ? 1500 : 4000) : { action: 'none', detail: 'disabled by --no-consent-dismiss' };
  seen.consent ??= consent.action !== 'none';
  const gate: GateResult = options.click.length ? await clickSelectors(page, options.click, extra)
    : options.gate ? await passGate(page, options, { slow: extra.slow, shot: extra.gateShot }) : { action: 'none', detail: 'disabled by --no-gate' };
  // Some banners only appear once the site has been entered.
  if (gate.action === 'clicked' && options.consent && consent.action === 'none') consent = await dismissConsent(page, 1500);
  await hide(page, options.hide);
  return { consent, gate };
}
export async function hide(page: Page, selectors: string[]) {
  if (selectors.length) await page.addStyleTag({ content: selectors.map(selector => `${selector} { visibility: hidden !important; }`).join('\n') });
}
export async function prepare(session: Session, warnings: string[], control?: CaptureControl) {
  const page = session.page;
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); }
  catch { warnings.push('Network idle timed out after 15 seconds; continued.'); }
  let previousHeight = 0; let previousY = -1; let finished = false;
  for (let step = 0; step < 40; step++) {
    control?.checkpoint();
    const { height, y, viewport } = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, y: scrollY, viewport: innerHeight }));
    if (height === previousHeight && y === previousY) { finished = true; break; }
    previousHeight = height; previousY = y;
    await page.evaluate(y => window.scrollTo(0, y), Math.min(y + viewport, height));
    await page.waitForTimeout(300);
  }
  if (!finished) warnings.push('Lazy-load pass reached its 40-step cap.');
  await page.evaluate(() => {
    // Sites can expose a `lenis` global that is not a scroller (e.g. a config object); only call a real scrollTo.
    const lenis = (window as unknown as { lenis?: { scrollTo?: unknown } }).lenis;
    // Its scroll callbacks can throw (bugs on the page); fall back to a native scroll.
    try { if (typeof lenis?.scrollTo === 'function') (lenis.scrollTo as (y: number, options: { immediate: boolean }) => void)(0, { immediate: true }); else scrollTo(0, 0); } catch { scrollTo(0, 0); }
  });
  await page.waitForTimeout(1000);
  const fontsReady = await page.evaluate(async () => {
    return Promise.race([document.fonts.ready.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 15000))]);
  });
  if (!fontsReady) warnings.push('document.fonts.ready timed out after 15 seconds.');
}
