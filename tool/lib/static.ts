import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureControl } from './interrupt.js';
import type { Page } from 'playwright';
import type { Tokens } from './types.js';
import { writeJson } from './util.js';

export const computedProperties = ['display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content', 'align-self', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform', 'color', 'background-color', 'background-image', 'border', 'border-width', 'border-style', 'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-radius', 'box-shadow', 'opacity', 'transform', 'transform-origin', 'filter', 'backdrop-filter', 'clip-path', 'mix-blend-mode', 'z-index', 'overflow', 'object-fit', 'object-position', 'transition', 'transition-duration', 'transition-timing-function', 'animation', 'animation-duration', 'animation-timing-function', 'will-change', 'cursor'];

export async function captureStatic(page: Page, dir: string, warnings: string[]) {
  await mkdir(join(dir, 'styles'), { recursive: true });
  await mkdir(join(dir, 'screenshots'), { recursive: true });
  await writeFile(join(dir, 'dom.html'), await page.content());
  const styleResult = await page.evaluate(() => {
    const rules: string[] = []; const unreadable: string[] = [];
    for (const sheet of document.styleSheets) {
      try { rules.push(`/* ${sheet.href ?? 'inline'} */\n` + [...sheet.cssRules].map(r => r.cssText).join('\n')); }
      catch { unreadable.push(sheet.href ?? 'inline stylesheet'); }
    }
    return { rules, unreadable };
  });
  await writeFile(join(dir, 'styles', 'inline.css'), styleResult.rules.join('\n\n'));
  warnings.push(...styleResult.unreadable.map(s => `Cross-origin stylesheet unreadable through CSSOM: ${s}`));
  const computed = await page.evaluate(properties => {
    const read = (style: CSSStyleDeclaration) => Object.fromEntries(properties.map(p => [p, style.getPropertyValue(p).slice(0, p === 'background-image' ? 200 : 10000)]));
    const candidates = [...document.querySelectorAll('*')].filter(el => !['script', 'style', 'meta', 'link', 'noscript', 'template'].includes(el.localName));
    const visible = (el: Element) => { const rect = el.getBoundingClientRect(); const cs = getComputedStyle(el); return rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const ordered = [...candidates.filter(visible), ...candidates.filter(el => !visible(el))];
    return { total: candidates.length, elements: ordered.slice(0, 6000).map(el => {
      const rect = el.getBoundingClientRect();
      const pseudos: Record<string, Record<string, string>> = {};
      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(el, pseudo);
        if (style.content !== 'none' && style.content !== 'normal') pseudos[pseudo] = { content: style.content, ...read(style) };
      }
      return { path: window.__siteLabPath(el), tag: el.localName, id: el.id, classes: [...el.classList], text: (el.textContent ?? '').trim().slice(0, 80), box: { x: rect.x + scrollX, y: rect.y + scrollY, w: rect.width, h: rect.height }, visible: visible(el), props: read(getComputedStyle(el)), pseudos };
    }) };
  }, computedProperties);
  if (computed.total > 6000) warnings.push(`Computed capture capped at 6000 of ${computed.total} elements.`);
  await writeJson(join(dir, 'computed.json'), computed.elements);
  const frequencies: Record<string, Map<string, number>> = {};
  const add = (category: string, value: string) => {
    if (!value) return;
    const map = frequencies[category] ??= new Map(); map.set(value, (map.get(value) ?? 0) + 1);
  };
  for (const { props } of computed.elements) {
    add('fonts', ['font-family', 'font-weight', 'font-size', 'line-height', 'letter-spacing'].map(p => props[p]).join(' / '));
    for (const p of ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color']) add('colours', props[p]);
    for (const p of ['margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'row-gap', 'column-gap']) add('spacing', props[p]);
    add('radii', props['border-radius']); add('shadows', props['box-shadow']); add('transitions', props.transition);
    for (const p of ['transition-duration', 'animation-duration']) for (const v of props[p].split(', ')) add('durations', v);
    for (const p of ['transition-timing-function', 'animation-timing-function']) add('easings', props[p]);
  }
  const tokens: Tokens = Object.fromEntries(Object.entries(frequencies).map(([key, map]) => [key, [...map].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count)]));
  await writeJson(join(dir, 'tokens.json'), tokens);
  await writeFile(join(dir, 'aria.yml'), await page.locator('body').ariaSnapshot());
  await page.screenshot({ path: join(dir, 'screenshots', 'full.png'), fullPage: true, animations: 'allow', timeout: 30000 });
  return { elements: computed.elements.length, tokens };
}

export async function hoverTargets(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll('a, button, [role="button"]')].filter(el => {
    const box = el.getBoundingClientRect(); const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }).slice(0, 40).map(el => window.__siteLabPath(el)));
}
export async function captureHover(page: Page, dir: string, warnings: string[], control?: CaptureControl) {
  const targets = await hoverTargets(page);
  await mkdir(join(dir, 'hover'), { recursive: true });
  const results: { path: string; before: string; after: string; diff: Record<string, { from: string; to: string }> }[] = [];
  for (const [index, path] of targets.entries()) {
    if (control?.interrupted) break;
    try {
      const el = page.locator(path).first();
      await el.scrollIntoViewIfNeeded({ timeout: 3000 });
      await page.mouse.move(0, 0); await page.waitForTimeout(350);
      const read = () => el.evaluate((node, properties) => {
        const style = getComputedStyle(node); return Object.fromEntries(properties.map(p => [p, style.getPropertyValue(p)]));
      }, computedProperties);
      const before = await read();
      const beforeFile = `hover/${index + 1}-before.png`; const afterFile = `hover/${index + 1}-after.png`;
      await el.screenshot({ path: join(dir, beforeFile), animations: 'allow' });
      await el.hover(); await page.waitForTimeout(500);
      const after = await read();
      await el.screenshot({ path: join(dir, afterFile), animations: 'allow' });
      const diff = Object.fromEntries(Object.keys(before).filter(p => before[p] !== after[p]).map(p => [p, { from: before[p], to: after[p] }]));
      results.push({ path, before: beforeFile, after: afterFile, diff });
    } catch (error) { warnings.push(`Hover skipped ${path}: ${String(error)}`); }
  }
  await page.mouse.move(0, 0);
  await writeJson(join(dir, 'hover.json'), results);
  return results.length;
}
