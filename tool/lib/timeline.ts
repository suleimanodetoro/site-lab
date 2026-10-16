import { join } from 'node:path';
import type { Page } from 'playwright';
import type { CaptureControl } from './interrupt.js';
import { writeJson } from './util.js';

export interface TimedRecord { t: number; path: string; kind: string; value: string; scrollY: number }
/** A member of a group (children of one parent) becoming visible: stacked phrases that take turns, slides, tickers. */
export interface TurnRecord { t: number; group: string; index: number; text: string; initial: boolean; scrollY: number }
/** Per group and position: how often a visible member was moving, and the most members visible at once. */
export interface GroupStats { group: string; scrollY: number; ticks: number; moving: number; maxShown: number }
export interface TimedChange {
  path: string; kind: string; values: string[]; changes: number; medianIntervalMs: number | null;
  cycles: boolean; continuous: boolean; firstSeenAtScroll: number;
}

const QUIET_MS = 300;
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null; };
const repeats = (values: string[]) => values.some((value, i) => values.indexOf(value) < i - 1);
const positionsOf = (list: { scrollY: number }[]) => [...new Set(list.map(item => item.scrollY))];

/** Pure. Split per-frame records into bursts separated by at least `quietMs` without a change. */
export function bursts<T extends { t: number }>(records: T[], quietMs = QUIET_MS): T[][] {
  const out: T[][] = [];
  for (const record of records) {
    const last = out.at(-1);
    if (last && record.t - last[last.length - 1].t < quietMs) last.push(record); else out.push([record]);
  }
  return out;
}

/**
 * Pure. Collapse raw observations into one entry per element and kind.
 * - text/content/attributes: each distinct value in order; more than 5 changes a second is a loop (continuous).
 * - style: animation libraries rewrite inline styles every frame, so a tween is one burst and its last value is the
 *   settled state; an element that never rests for 300ms is a loop.
 * - turns: children of one parent becoming visible in turn (e.g. stacked "Posted $… in payments" phrases moved by GSAP).
 */
export function summariseTimedChanges(records: TimedRecord[], windowMs: number, turns: TurnRecord[] = [], stats: GroupStats[] = []): TimedChange[] {
  const result: TimedChange[] = [];
  const groups = new Map<string, TimedRecord[]>();
  for (const record of records) {
    const key = `${record.path}\u0000${record.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  // Turn groups: values are the texts that became visible, in order.
  const turnGroups = new Map<string, TurnRecord[]>();
  for (const turn of turns) turnGroups.set(turn.group, [...(turnGroups.get(turn.group) ?? []), turn]);
  const reportedGroups: string[] = [];
  for (const [group, list] of turnGroups) {
    const groupStats = stats.filter(s => s.group === group);
    const ticks = groupStats.reduce((sum, s) => sum + s.ticks, 0); const moving = groupStats.reduce((sum, s) => sum + s.moving, 0);
    // A marquee shows many members at once, or its visible members are always moving.
    if (groupStats.some(s => s.maxShown > 2) || (ticks > 0 && moving / ticks > 0.6)) continue;
    const sorted = [...list].sort((a, b) => a.scrollY - b.scrollY || Number(b.initial) - Number(a.initial) || a.t - b.t).filter(turn => turn.text);
    const changes = sorted.filter(turn => !turn.initial);
    // Taking turns means changing at least twice while standing still, not everything appearing at once (a reveal).
    if (!positionsOf(changes).some(y => changes.filter(turn => turn.scrollY === y).length >= 2)) continue;
    const values = sorted.map(turn => turn.text).filter((text, i, all) => i === 0 || text !== all[i - 1]);
    if (new Set(values).size < 2) continue;
    const intervals: number[] = [];
    for (let i = 1; i < changes.length; i++) if (changes[i].scrollY === changes[i - 1].scrollY) intervals.push(changes[i].t - changes[i - 1].t);
    if ((median(intervals) ?? 0) < 300) continue;
    result.push({ path: group, kind: 'turns', values: [...new Set(values)].slice(0, 12), changes: changes.length, medianIntervalMs: median(intervals), cycles: repeats(values), continuous: false, firstSeenAtScroll: Math.min(...list.map(t => t.scrollY)) });
    reportedGroups.push(group);
  }
  for (const group of groups.values()) {
    const { path, kind } = group[0];
    // Members of a reported turn group are already described by it.
    if (['style', 'class'].includes(kind) && reportedGroups.some(parent => path.startsWith(`${parent} > `))) continue;
    if (kind === 'style') {
      const positions = [...new Set(group.map(r => r.scrollY))];
      const segments = positions.map(y => bursts(group.filter(r => r.scrollY === y)));
      const settled = segments.flat().map(burst => burst[burst.length - 1].value);
      const longest = Math.max(...segments.flat().map(burst => burst[burst.length - 1].t - burst[0].t));
      // Never resting for most of a window is a loop (marquee, spinner); its sample values are first and last seen.
      const continuous = longest >= windowMs * 0.75;
      // A one-off change at each position (a scrubbed animation catching up after the scroll) is not a timed change.
      if (!continuous && !segments.some(list => list.length >= 2)) continue;
      const distinct = [...new Set(continuous ? [group[0].value, group[group.length - 1].value] : settled)];
      if (distinct.length < 2) continue;
      const intervals = segments.flatMap(list => list.slice(1).map((burst, i) => burst[0].t - list[i][0].t));
      result.push({ path, kind, values: distinct.slice(0, 12), changes: segments.flat().length, medianIntervalMs: continuous ? null : median(intervals), cycles: repeats(settled), continuous, firstSeenAtScroll: Math.min(...positions) });
      continue;
    }
    // Consecutive duplicates are re-renders of the same value, not changes.
    const sequence = group.filter((record, i) => i === 0 || record.value !== group[i - 1].value || record.scrollY !== group[i - 1].scrollY);
    const distinct = [...new Set(sequence.map(r => r.value))];
    if (distinct.length < 2) continue;
    const intervals: number[] = [];
    for (let i = 1; i < sequence.length; i++) if (sequence[i].scrollY === sequence[i - 1].scrollY) intervals.push(sequence[i].t - sequence[i - 1].t);
    const interval = median(intervals);
    result.push({
      path, kind, values: distinct.slice(0, 12), changes: sequence.length - 1, medianIntervalMs: interval,
      cycles: repeats(sequence.map(r => r.value)),
      // More than ~5 changes a second is an animation loop, not discrete states.
      continuous: interval !== null && interval < 200,
      firstSeenAtScroll: Math.min(...group.map(r => r.scrollY))
    });
  }
  const rank = (c: TimedChange) => (c.continuous ? 1 : 0) * 10 + (['turns', 'text', 'content'].includes(c.kind) ? 0 : 1);
  return result.sort((a, b) => rank(a) - rank(b) || b.values.length - a.values.length);
}

interface Observed { records: Omit<TimedRecord, 'scrollY'>[]; turns: Omit<TurnRecord, 'scrollY'>[]; stats: Omit<GroupStats, 'scrollY'>[] }
// Runs in the page: watches what changes with no scrolling. Mutations cover text swaps and attribute/inline-style
// animation; a 100ms sampler records which children of an animating parent are visible, which also covers CSS
// keyframe tickers that never touch the DOM. Groups persist on window across windows at the same position.
function watchWindow(windowMs: number, includeInitial: boolean): Promise<Observed> {
  return new Promise(resolve => {
    const start = performance.now();
    const records: Observed['records'] = []; const turns: Observed['turns'] = [];
    const win = window as unknown as { __siteLabPath: (el: Element) => string; __siteLabTurnGroups?: Map<Element, { path: string; members: Element[] }> };
    const pathOf = win.__siteLabPath;
    const known = win.__siteLabTurnGroups ??= new Map();
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
    const text = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    // A member's full text, even while its letters are still fading in one by one (split-text reveals hide letters from innerText).
    const label = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) || el.getAttribute('aria-label') || el.querySelector('img')?.getAttribute('alt') || (el.querySelector('img')?.getAttribute('src') ?? '').split('/').pop() || '';
    // Visible to a person: on screen, mostly opaque, and not clipped away by an overflow-hidden ancestor.
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return false;
      if (getComputedStyle(el).visibility === 'hidden') return false;
      const cx = r.left + r.width / 2; const cy = r.top + r.height / 2; let opacity = 1;
      for (let e: Element | null = el, depth = 0; e && depth < 8; e = e.parentElement, depth++) {
        const style = getComputedStyle(e); opacity *= Number(style.opacity);
        // Clipped by overflow, a clip-path or a mask on an ancestor (approximated by that ancestor's box).
        if (depth > 0 && (style.overflowX !== 'visible' || style.overflowY !== 'visible' || style.clipPath !== 'none' || (style.maskImage || 'none') !== 'none')) {
          const clip = e.getBoundingClientRect();
          if (cx < clip.left || cx > clip.right || cy < clip.top || cy > clip.bottom) return false;
        }
      }
      return opacity >= 0.5;
    };
    const active = new Map<Element, { path: string; members: Element[]; shown: boolean[]; boxes: string[]; ticks: number; moving: number; maxShown: number }>();
    const watch = (parent: Element | null) => {
      // At most 24 groups, so measuring never slows the page it measures.
      if (!parent || active.has(parent) || active.size >= 24 || parent === document.body || parent === document.documentElement || !visible(parent)) return;
      const members: Element[] = known.get(parent)?.members ?? [...parent.children].filter(child => !['script', 'style', 'template'].includes(child.localName));
      if (members.length < 2 || members.length > 30) return;
      const entry = { path: known.get(parent)?.path ?? pathOf(parent), members, shown: members.map(shown), boxes: members.map(m => JSON.stringify(m.getBoundingClientRect())), ticks: 0, moving: 0, maxShown: 0 };
      active.set(parent, entry); known.set(parent, { path: entry.path, members });
      if (includeInitial) entry.members.forEach((member, index) => { if (entry.shown[index]) turns.push({ t: performance.now() - start, group: entry.path, index, text: label(member), initial: true }); });
    };
    for (const parent of known.keys()) if (parent.isConnected) watch(parent);
    for (const animation of document.getAnimations()) {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (target instanceof Element && animation.effect?.getTiming().iterations === Infinity && visible(target)) { watch(target.parentElement); watch(target); }
    }
    const observer = new MutationObserver(list => {
      const t = performance.now() - start;
      for (const record of list) {
        const el = record.type === 'characterData' ? record.target.parentElement : record.target as Element;
        // Changes recorded on <body> or <html> themselves are too coarse to describe anything.
        if (!(el instanceof Element) || el === document.body || el === document.documentElement || !visible(el)) continue;
        if (record.type === 'attributes') {
          const name = record.attributeName ?? '';
          records.push({ t, path: pathOf(el), kind: name, value: (el.getAttribute(name) ?? '').slice(0, 200) });
          if (name === 'style' || name === 'class') { watch(el.parentElement); watch(el); }
        } else records.push({ t, path: pathOf(el), kind: record.type === 'characterData' ? 'text' : 'content', value: text(el) });
        if (records.length > 20000) records.splice(0, 10000);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'srcset', 'class', 'style', 'hidden', 'aria-hidden', 'data-state', 'aria-label'] });
    const sampler = setInterval(() => {
      const t = performance.now() - start;
      for (const entry of active.values()) {
        let count = 0; let moved = false;
        entry.members.forEach((member, index) => {
          const now = shown(member); const box = JSON.stringify(member.getBoundingClientRect());
          if (now) { count++; if (box !== entry.boxes[index]) moved = true; }
          if (now && !entry.shown[index]) turns.push({ t, group: entry.path, index, text: label(member), initial: false });
          entry.shown[index] = now; entry.boxes[index] = box;
        });
        entry.ticks++; if (moved) entry.moving++; entry.maxShown = Math.max(entry.maxShown, count);
      }
    }, 100);
    setTimeout(() => {
      observer.disconnect(); clearInterval(sampler);
      resolve({ records, turns: turns.slice(0, 5000), stats: [...active.values()].map(({ path, ticks, moving, maxShown }) => ({ group: path, ticks, moving, maxShown })) });
    }, windowMs);
  });
}

/**
 * Stand still at each screen-height position and record what changes on its own. Where something new changes in
 * discrete steps, keep watching for 3 more windows so a whole cycle (all phrases, its period) is seen.
 */
export async function recordTimedChanges(page: Page, width: number, motionDir: string, windowMs: number, control?: CaptureControl) {
  const { maxScroll, viewport } = await page.evaluate(() => ({ maxScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight), viewport: innerHeight }));
  const positions: number[] = [];
  for (let y = 0; y < maxScroll && positions.length < 30; y += viewport) positions.push(y);
  if (!positions.includes(maxScroll) && positions.length < 30) positions.push(maxScroll);
  const records: TimedRecord[] = []; const turns: TurnRecord[] = []; const stats: GroupStats[] = [];
  const resolved = new Set<string>(); let extended = 0;
  const observe = async (y: number, ms: number, includeInitial: boolean, offset: number) => {
    const observed = await page.evaluate(`(${watchWindow.toString()})(${ms}, ${includeInitial})`) as Observed;
    records.push(...observed.records.map(record => ({ ...record, t: record.t + offset, scrollY: y })));
    turns.push(...observed.turns.map(turn => ({ ...turn, t: turn.t + offset, scrollY: y })));
    return observed;
  };
  for (const y of positions) {
    if (control?.interrupted) break;
    await page.evaluate(y => {
      const lenis = (window as unknown as { lenis?: { scrollTo?: unknown } }).lenis;
      try { if (typeof lenis?.scrollTo === 'function') (lenis.scrollTo as (y: number, o: { immediate: boolean }) => void)(y, { immediate: true }); else scrollTo(0, y); } catch { scrollTo(0, y); }
    }, y);
    // Scrubbed animations keep moving briefly after a jump; start once inline styles have been quiet for 300ms (max 1.5s).
    await page.evaluate(() => new Promise<void>(resolve => {
      const start = performance.now(); let last = start;
      const observer = new MutationObserver(() => { last = performance.now(); });
      observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      const timer = setInterval(() => {
        const now = performance.now();
        if ((now - start >= 400 && now - last >= 300) || now - start >= 1500) { clearInterval(timer); observer.disconnect(); resolve(); }
      }, 50);
    }));
    const first = await observe(y, windowMs, true, 0);
    let groupStats = first.stats;
    const here = () => summariseTimedChanges(records.filter(r => r.scrollY === y), windowMs, turns.filter(t => t.scrollY === y), groupStats.map(s => ({ ...s, scrollY: y }))).filter(c => !c.continuous);
    const fresh = here().filter(c => !resolved.has(c.path));
    if (fresh.length && extended < 6 && !control?.interrupted) {
      extended++;
      const more = await observe(y, windowMs * 3, false, windowMs + 50);
      groupStats = [...first.stats, ...more.stats];
    }
    stats.push(...groupStats.map(s => ({ ...s, scrollY: y })));
    for (const change of here()) resolved.add(change.path);
  }
  const elements = summariseTimedChanges(records, windowMs, turns, stats);
  await writeJson(join(motionDir, `timed-changes-${width}.json`), { width, windowMs, positions, elements });
  return elements;
}
