import type { Page } from 'playwright';
import { browserInit } from './util.js';

export interface Breakpoint { px: number; kind: 'min' | 'max'; count: number }

/** Pure. Width conditions in one media query text: min-/max-width and range syntax (`width >= 48rem`). */
export function parseMediaWidths(condition: string, rootPx = 16): { px: number; kind: 'min' | 'max' }[] {
  const toPx = (value: string, unit: string) => Number(value) * (unit === 'px' ? 1 : rootPx);
  const found: { px: number; kind: 'min' | 'max' }[] = [];
  for (const [, side, value, unit] of condition.matchAll(/\b(min|max)-width\s*:\s*([\d.]+)(px|rem|em)\b/gi)) {
    found.push({ px: Math.round(toPx(value, unit.toLowerCase())), kind: side.toLowerCase() as 'min' | 'max' });
  }
  for (const [, op, value, unit] of condition.matchAll(/\bwidth\s*(>=|>|<=|<)\s*([\d.]+)(px|rem|em)\b/gi)) {
    const px = toPx(value, unit.toLowerCase());
    if (op.startsWith('>')) found.push({ px: Math.round(op === '>' ? px + 1 : px), kind: 'min' });
    else found.push({ px: Math.round(op === '<' ? px - 1 : px), kind: 'max' });
  }
  // Reversed range syntax: `48rem <= width`.
  for (const [, value, unit, op] of condition.matchAll(/([\d.]+)(px|rem|em)\s*(<=|<|>=|>)\s*width\b/gi)) {
    const px = toPx(value, unit.toLowerCase());
    if (op.startsWith('<')) found.push({ px: Math.round(op === '<' ? px + 1 : px), kind: 'min' });
    else found.push({ px: Math.round(op === '>' ? px - 1 : px), kind: 'max' });
  }
  return found;
}

/**
 * Pure. Viewports that show every layout: the base widths, plus each breakpoint's first width
 * (min-width B → B; max-width B → B + 1). Clamped to 320–1920, near-duplicates (<24px) merged,
 * capped by keeping the most-used breakpoints.
 */
export function chooseWidths(breakpoints: Breakpoint[], base = [390, 1440], cap = 8): number[] {
  const candidates = new Map<number, number>();
  for (const bp of breakpoints) {
    const width = bp.kind === 'min' ? bp.px : bp.px + 1;
    if (width < 320 || width > 1920) continue;
    candidates.set(width, (candidates.get(width) ?? 0) + bp.count);
  }
  const chosen = [...base];
  for (const [width] of [...candidates].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    if (chosen.length >= cap) break;
    if (chosen.every(existing => Math.abs(existing - width) >= 24)) chosen.push(width);
  }
  return [...new Set(chosen)].sort((a, b) => a - b);
}

/** Pure. Media conditions in raw CSS text: `@media` preludes and the media list after `@import`. */
export function mediaConditionsFromCss(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: string[] = [];
  for (const [, condition] of text.matchAll(/@media\s+([^{;]+)\{/gi)) found.push(condition.trim());
  for (const [, condition] of text.matchAll(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')\s*([^;]*);/gi)) if (condition.trim()) found.push(condition.trim());
  return found;
}

/** Records every query the page's scripts pass to matchMedia (GSAP matchMedia, JS breakpoints). Install before load. */
export async function watchMatchMedia(page: Page) {
  await browserInit(page, () => {
    const queries = new Set<string>();
    (window as unknown as { __siteLabMediaQueries: Set<string> }).__siteLabMediaQueries = queries;
    const original = window.matchMedia;
    if (typeof original !== 'function') return;
    window.matchMedia = function matchMedia(this: Window, query: string) {
      if (queries.size < 500) queries.add(String(query));
      return original.call(this, query);
    } as typeof window.matchMedia;
  });
}

export interface BreakpointDiscovery { breakpoints: Breakpoint[]; unreadableSheets: number; fetchedSheets: number; scriptQueries: number }
/**
 * Every width condition the page uses: readable stylesheets, cross-origin stylesheets (fetched again as text,
 * since the browser hides their rules), `<link media>` attributes and matchMedia calls from scripts.
 */
export async function discoverBreakpoints(page: Page): Promise<BreakpointDiscovery> {
  const found = await page.evaluate(() => {
    const conditions: string[] = []; const crossOrigin: string[] = []; let inlineUnreadable = 0;
    const walk = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) conditions.push(rule.conditionText ?? rule.media.mediaText);
        if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      if (sheet.media?.mediaText) conditions.push(sheet.media.mediaText);
      try { walk(sheet.cssRules); } catch { if (sheet.href) crossOrigin.push(sheet.href); else inlineUnreadable++; }
    }
    const scripts = [...((window as unknown as { __siteLabMediaQueries?: Set<string> }).__siteLabMediaQueries ?? [])].map(String);
    return { conditions, crossOrigin: [...new Set(crossOrigin)], inlineUnreadable, scripts, rootPx: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16 };
  });
  const conditions = [...found.conditions, ...found.scripts];
  let unreadable = found.inlineUnreadable; let fetched = 0;
  for (const href of found.crossOrigin) {
    try {
      const response = await page.context().request.get(href, { timeout: 15000 });
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      conditions.push(...mediaConditionsFromCss(await response.text()));
      fetched++;
    } catch { unreadable++; }
  }
  const counts = new Map<string, Breakpoint>();
  for (const condition of conditions) for (const { px, kind } of parseMediaWidths(condition, found.rootPx)) {
    const key = `${kind}:${px}`;
    const existing = counts.get(key);
    if (existing) existing.count++; else counts.set(key, { px, kind, count: 1 });
  }
  return { breakpoints: [...counts.values()].sort((a, b) => a.px - b.px), unreadableSheets: unreadable, fetchedSheets: fetched, scriptQueries: found.scripts.length };
}
