import type { Page } from 'playwright';
import type { CaptureOptions } from './types.js';

export interface GateResult { action: 'clicked' | 'none' | 'failed'; detail: string }

/** Pure. Labels of controls that open a site from a splash or intro screen ("ENTER", "Enter site →", "Skip intro"). */
export function isGateLabel(label: string): boolean {
  const text = label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/^[\s→›»>↗↘]+|[\s→›»>↗↘]+$/gu, '');
  if (!text || text.length > 40) return false;
  return /^(?:(?:click|tap|press) (?:here )?to )?(?:enter|enter (?:the )?(?:site|website|experience|now)|enter (?:with|without) (?:sound|audio)|explore|start|start (?:the )?experience|begin|let'?s go|skip|skip intro|view (?:the )?site|go to (?:the )?site|continue to (?:the )?site|sound on|sound off|with sound|without sound)$/.test(text);
}

interface GateCandidate { x: number; y: number; label: string; overlay: string }
// Runs in the page. A gate control is a labelled element that is on top at its own centre and sits inside a
// fixed layer covering most of the viewport. Buttons in normal page content, or hidden behind the layer, never qualify.
function findGate(isGate: (label: string) => boolean): GateCandidate | null {
  const area = innerWidth * innerHeight;
  const scrollable = document.documentElement.scrollHeight > innerHeight + 2;
  const label = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim() || el.getAttribute('aria-label') || '';
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return false;
    if (getComputedStyle(el).visibility === 'hidden') return false;
    let opacity = 1;
    for (let e: Element | null = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
    return opacity >= 0.3;
  };
  const layerOf = (el: Element) => {
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const style = getComputedStyle(e); const r = e.getBoundingClientRect();
      if ((style.position === 'fixed' || (style.position === 'absolute' && !scrollable)) && r.width * r.height >= area * 0.85) return e;
    }
    return null;
  };
  // Only elements holding a short text node (or an aria-label) can carry a gate label; this avoids reading every element's text.
  const elements = new Set<Element>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue?.trim();
    if (value && value.length <= 40 && node.parentElement && !['script', 'style', 'noscript', 'template'].includes(node.parentElement.localName)) elements.add(node.parentElement);
  }
  for (const el of document.querySelectorAll('[aria-label]')) elements.add(el);
  const found: (GateCandidate & { exact: boolean })[] = [];
  for (const el of elements) {
    const text = label(el);
    if (!isGate(text) || !shown(el)) continue;
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    if (!top || !(el.contains(top) || top.contains(el))) continue;
    const layer = layerOf(top);
    if (!layer) continue;
    found.push({ x, y, label: text.slice(0, 60), overlay: window.__siteLabPath(layer), exact: /^enter$/i.test(text) });
  }
  found.sort((a, b) => Number(b.exact) - Number(a.exact));
  return found[0] ?? null;
}

// Runs in the page: has the layer that held the gate gone (removed, hidden, faded or moved away)?
function layerGone(path: string): boolean {
  const el = document.querySelector(path);
  if (!el) return true;
  const style = getComputedStyle(el); const r = el.getBoundingClientRect();
  return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05 || r.width * r.height < innerWidth * innerHeight * 0.5 || r.bottom <= 0 || r.top >= innerHeight;
}

/**
 * Click through an "Enter" splash once per page load. The first load waits up to 20s for one when the page is
 * locked (no scrolling) or covered; later loads only wait when the first one had a gate. Slowed (0.1×) intros wait longer.
 */
export async function passGate(page: Page, options: CaptureOptions, extra: { slow?: boolean; shot?: string } = {}): Promise<GateResult> {
  const seen = options.seen ??= {};
  const find = () => page.evaluate(`(${findGate.toString()})(${isGateLabel.toString()})`) as Promise<GateCandidate | null>;
  let candidate = await find().catch(() => null);
  if (!candidate && seen.gate !== false) {
    // Locked: the page can't scroll, scrolling is switched off, or a full-screen layer sits on top (it may still be fading in).
    const locked = await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 2
      || [document.documentElement, document.body].some(el => getComputedStyle(el).overflowY === 'hidden')
      || [...document.querySelectorAll('body *')].some(el => {
        const style = getComputedStyle(el); const r = el.getBoundingClientRect();
        return style.position === 'fixed' && r.width * r.height >= innerWidth * innerHeight * 0.85 && style.visibility !== 'hidden' && style.display !== 'none' && (Number(style.opacity) > 0.5 || Number(style.zIndex) >= 100);
      })).catch(() => false);
    const waitMs = seen.gate ? (extra.slow ? 60000 : 20000) : locked ? (extra.slow ? 40000 : 20000) : 0;
    const deadline = Date.now() + waitMs;
    while (!candidate && Date.now() < deadline) { await page.waitForTimeout(250); candidate = await find().catch(() => null); }
  }
  seen.gate ??= Boolean(candidate);
  if (!candidate) return { action: 'none', detail: 'no entry gate found' };
  if (extra.shot) await page.screenshot({ path: extra.shot, animations: 'allow' }).catch(() => undefined);
  const before = new URL(page.url());
  await page.mouse.click(candidate.x, candidate.y);
  const deadline = Date.now() + (extra.slow ? 60000 : 10000);
  let gone = false;
  while (!gone && Date.now() < deadline) {
    await page.waitForTimeout(250);
    gone = await page.evaluate(`(${layerGone.toString()})(${JSON.stringify(candidate.overlay)})`).catch(() => true) as boolean;
  }
  await page.waitForTimeout(500);
  const after = new URL(page.url());
  if (after.origin + after.pathname !== before.origin + before.pathname) return { action: 'failed', detail: `clicked "${candidate.label}" but the page went to ${after.href}` };
  return { action: 'clicked', detail: `clicked "${candidate.label}" in ${candidate.overlay}${gone ? '' : '; the layer was still showing after the wait'}` };
}

/** --click: click each selector in order (waiting for it to appear), instead of the automatic gate check. */
export async function clickSelectors(page: Page, selectors: string[], extra: { slow?: boolean } = {}): Promise<GateResult> {
  const done: string[] = [];
  for (const selector of selectors) {
    try {
      const target = page.locator(selector).first();
      await target.waitFor({ state: 'visible', timeout: extra.slow ? 60000 : 20000 });
      const box = await target.boundingBox();
      if (!box) throw new Error('no box');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(1500);
      done.push(selector);
    } catch (error) {
      return { action: 'failed', detail: `--click ${selector}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}${done.length ? ` (after ${done.join(', ')})` : ''}` };
    }
  }
  return { action: 'clicked', detail: `--click ${done.join(', ')}` };
}
