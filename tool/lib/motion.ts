import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { CaptureOptions, Curves, Effects, Effect, MotionInventory, SampleValue, SampleDelta } from './types.js';
import type { Session } from './browser.js';
import { writeJson } from './util.js';
import { classifyAmbient, classifyIdle, readTracked, type SamplingWindow } from './sampling.js';
import { scrollPositions, scrollStep, ScrollProgress } from './progress.js';
import { DRIVERS, drive, MOVED, STILL, thumbnail, visualChange, type Driver } from './virtual.js';
import type { CaptureControl } from './interrupt.js';

// These adapters inspect optional, untyped page globals only inside Playwright's browser.
// They never load captured JavaScript into the tool process.
export async function inventory(page: Page): Promise<MotionInventory> {
  return page.evaluate(() => {
    const win = window as unknown as Record<string, any>;
    const path = window.__siteLabPath;
    const clean = (value: any, depth = 0, seen = new WeakSet<object>()): any => {
      if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
      if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
      if (typeof value === 'function') return value.toString().slice(0, 2000);
      if (value instanceof Element) return path(value);
      if (typeof value !== 'object') return String(value);
      if (typeof value.value === 'number' && typeof value.unit === 'string') return { value: value.value, unit: value.unit };
      if (depth > 5 || seen.has(value)) return '[circular or depth limit]';
      seen.add(value);
      if (Array.isArray(value)) return value.slice(0, 6000).map(v => clean(v, depth + 1, seen));
      return Object.fromEntries(Object.entries(value).filter(([key]) => !['_gsap', 'parent'].includes(key)).slice(0, 100).map(([key, v]) => [key, clean(v, depth + 1, seen)]));
    };
    const scripts = [...document.scripts];
    const definitions = [
      { name: 'gsap', global: win.gsap, pattern: /gsap|greensock/i },
      { name: 'ScrollTrigger', global: win.ScrollTrigger ?? win.gsap?.core?.globals?.().ScrollTrigger ?? win.gsap?.plugins?.ScrollTrigger, pattern: /ScrollTrigger/i },
      { name: 'lenis', global: win.lenis ?? win.Lenis, pattern: /lenis/i },
      { name: 'locomotive', global: win.locomotive ?? win.locomotiveScroll ?? win.LocomotiveScroll, pattern: /locomotive/i },
      { name: 'anime', global: win.anime, pattern: /anime(?:js|\.js)/i },
      { name: 'three', global: win.THREE, pattern: /three(?:\.module)?(?:\.min)?\.js/i },
      { name: 'framer-motion', global: win.Motion ?? win.FramerMotion, pattern: /framer-motion|motion\.js/i }
    ];
    const libraries = definitions.map(def => {
      const evidence: string[] = [];
      if (def.global) evidence.push(`global: ${def.name}`);
      for (const script of scripts) {
        if (def.pattern.test(script.src)) evidence.push(`script: ${script.src}`);
        else if (def.pattern.test(script.textContent ?? '')) evidence.push('inline script signature');
      }
      if (def.name === 'lenis' && document.querySelector('.lenis, [data-lenis-prevent]')) evidence.push('Lenis class/data attribute');
      if (def.name === 'locomotive' && document.querySelector('[data-scroll-container], .has-scroll-smooth')) evidence.push('Locomotive data/class attribute');
      return { name: def.name, version: def.global?.version ?? def.global?.VERSION, reachable: Boolean(def.global), evidence };
    }).filter(lib => lib.evidence.length);
    const tween = (animation: any): any => ({
      targets: (animation.targets?.() ?? []).filter((t: unknown) => t instanceof Element).map(path),
      vars: clean(animation.vars), duration: animation.duration?.(), delay: animation.delay?.(),
      ease: typeof animation.vars?.ease === 'string' ? animation.vars.ease : animation.vars?.ease?.name || animation.vars?.ease?.toString() || 'default',
      stagger: clean(animation.vars?.stagger),
      ...(animation.getChildren ? { children: animation.getChildren(true, true, false).map(tween) } : {})
    });
    const st = win.ScrollTrigger ?? win.gsap?.core?.globals?.().ScrollTrigger;
    const triggers = (st?.getAll?.() ?? []).map((trigger: any) => ({
      trigger: trigger.trigger instanceof Element ? path(trigger.trigger) : null,
      start: trigger.start, end: trigger.end, scrub: clean(trigger.vars.scrub ?? false), pin: Boolean(trigger.pin),
      pinPath: trigger.pin instanceof Element ? path(trigger.pin) : null,
      pinSpacing: trigger.vars.pinSpacing ?? true, snap: clean(trigger.vars.snap ?? null),
      toggleActions: trigger.vars.toggleActions ?? 'play none none none', animation: trigger.animation ? tween(trigger.animation) : null
    }));
    const gsap = { reachable: Boolean(win.gsap), scrollTriggers: triggers, tweens: (win.gsap?.globalTimeline?.getChildren(true, true, false) ?? []).map(tween),
      ...(!win.gsap && libraries.some(lib => lib.name === 'gsap') ? { note: 'GSAP detected in script evidence but its global is not reachable.' } : {}) };
    const waapi = document.getAnimations().map(animation => {
      const effect = animation.effect;
      const timeline = animation.timeline as any;
      return { target: effect instanceof KeyframeEffect && effect.target instanceof Element ? path(effect.target) : null,
        animationName: (animation as CSSAnimation).animationName || animation.id || 'WAAPI',
        keyframes: effect instanceof KeyframeEffect ? clean(effect.getKeyframes()) : [], timing: clean(effect?.getTiming()),
        timeline: { type: timeline?.constructor.name ?? 'none', axis: timeline?.axis ?? null,
          source: timeline?.source instanceof Element ? path(timeline.source) : null,
          subject: timeline?.subject instanceof Element ? path(timeline.subject) : null,
          rangeStart: clean((animation as any).rangeStart ?? null), rangeEnd: clean((animation as any).rangeEnd ?? null) } };
    });
    const history = clean(win.__siteLabAnimationHistory ?? []) as typeof waapi;
    const allAnimations = [...waapi, ...history].filter((a, index, all) => all.findIndex(b => b.target === a.target && b.animationName === a.animationName) === index);
    const cssTimelines = [...document.querySelectorAll('*')].flatMap(el => {
      const style = getComputedStyle(el);
      const props = Object.fromEntries(['animation-timeline', 'view-timeline', 'view-timeline-name', 'view-timeline-axis', 'scroll-timeline', 'scroll-timeline-name', 'scroll-timeline-axis', 'animation-range-start', 'animation-range-end'].map(key => [key, style.getPropertyValue(key)]));
      return (props['animation-timeline'] && props['animation-timeline'] !== 'auto' && props['animation-timeline'] !== 'none') || (props['view-timeline-name'] && props['view-timeline-name'] !== 'none') || (props['scroll-timeline-name'] && props['scroll-timeline-name'] !== 'none') ? [{ path: path(el), ...props }] : [];
    });
    const smoothScroll = ['lenis', 'locomotive', 'locomotiveScroll'].flatMap(name => {
      const instance = win[name]; if (!instance) return [];
      const options = instance.options ?? instance;
      return [{ name, reachable: true, settings: Object.fromEntries(['lerp', 'duration', 'easing', 'wheelMultiplier', 'smoothWheel'].map(key => [key, clean(options[key] ?? null)])) }];
    });
    return { libraries, gsap, waapi: allAnimations, cssTimelines, smoothScroll };
  });
}

export async function saveInventory(dir: string, data: MotionInventory) {
  for (const [file, value] of Object.entries({ 'libraries.json': data.libraries, 'gsap.json': data.gsap, 'waapi.json': data.waapi, 'css-scroll-timelines.json': data.cssTimelines, 'smooth-scroll.json': data.smoothScroll })) await writeJson(join(dir, file), value);
}

/** Cap on wheel steps for pages whose document does not scroll. */
export const MAX_WHEEL_STEPS = 80;
/**
 * `layout`: an in-between width, captured for its layout only. Steps are half a screen apart (unless --scroll-step is set)
 * and fewer elements are tracked; the motion widths keep full sampling.
 */
export async function scrollSample(session: Session, options: CaptureOptions, width: number, passDir: string, motionDir: string, warnings: string[], control?: CaptureControl, layout = false): Promise<Effects> {
  const page = session.page;
  const cap = layout ? Math.min(300, options.maxElements) : options.maxElements;
  const requestedStep = layout && options.scrollStep === 'auto' ? Math.round((page.viewportSize()?.height ?? 900) / 2) : options.scrollStep;
  await page.evaluate(`window.__siteLabRead = (${readTracked.toString()}); window.__siteLabClassify = (${classifyAmbient.toString()}); window.__siteLabClassifyIdle = (${classifyIdle.toString()}); window.__siteLabTracked = [];`);
  await page.evaluate(async () => {
    const win = window as unknown as SamplingWindow;
    // The site's own scroll callbacks can throw (bugs on the page); that must never stop the capture.
    try { if (typeof win.lenis?.scrollTo === 'function') win.lenis.scrollTo(0, { immediate: true }); else scrollTo(0, 0); } catch { scrollTo(0, 0); }
    try { (win.ScrollTrigger ?? win.gsap?.core?.globals?.().ScrollTrigger)?.update?.(); } catch { /* page error */ }
    for (let i = 0; i < 2; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  const select = () => page.evaluate(cap => {
    const win = window as unknown as SamplingWindow;
    const all = [...document.querySelectorAll('*')].filter(el => !['script', 'style', 'meta', 'link', 'noscript', 'template', 'head'].includes(el.localName));
    const candidates = new Set<Element>();
    const add = (el: Element) => {
      candidates.add(el);
      for (const child of el.children) { candidates.add(child); for (const grandchild of child.children) candidates.add(grandchild); }
    };
    const st = win.ScrollTrigger ?? win.gsap?.core?.globals?.().ScrollTrigger;
    for (const trigger of st?.getAll?.() ?? []) {
      for (const el of [trigger.trigger, trigger.pin, ...(trigger.animation?.targets?.() ?? [])]) if (el instanceof Element) add(el);
      for (const tween of trigger.animation?.getChildren?.(true, true, false) ?? []) for (const el of tween.targets?.() ?? []) if (el instanceof Element) add(el);
    }
    for (const el of all) {
      const style = getComputedStyle(el); let identity = true;
      try { identity = style.transform === 'none' || new DOMMatrixReadOnly(style.transform).isIdentity; } catch { identity = false; }
      if (['video', 'canvas', 'iframe'].includes(el.localName) || el.getAnimations().some(a => a.effect?.getTiming().iterations === Infinity) || !identity || Number(style.opacity) < 1 || style.clipPath !== 'none' || style.filter !== 'none' || style.willChange !== 'auto' || ['sticky', 'fixed'].includes(style.position) || ['data-scroll', 'data-speed', 'data-lag'].some(a => el.hasAttribute(a))) add(el);
    }
    const priorityCount = candidates.size;
    for (const el of all) {
      if (candidates.size >= cap) break;
      const rect = el.getBoundingClientRect(); const style = getComputedStyle(el);
      if (rect.width && rect.height && style.visibility !== 'hidden' && style.display !== 'none') candidates.add(el);
    }
    const tracked = win.__siteLabTracked;
    for (const el of candidates) {
      if (tracked.length >= cap) break;
      if (!tracked.some(t => t.el === el)) tracked.push({ el, path: window.__siteLabPath(el), ambient: false, ambientAncestor: false });
    }
    return { paths: tracked.map(t => t.path), priorityCount, maxScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight) };
  }, cap);
  const idle = async (duration: number) => {
    const result = await page.evaluate(async duration => {
      const win = window as unknown as SamplingWindow;
      const start = performance.now();
      const structural = (el: Element) => ['video', 'canvas', 'iframe'].includes(el.localName) || el.getAnimations().some(a => a.effect?.getTiming().iterations === Infinity);
      // Structural flags are read at the start and end of the window only; frames just compare values.
      for (const tracked of win.__siteLabTracked) if (structural(tracked.el)) tracked.ambient = true;
      const byPath = new Map(win.__siteLabTracked.map(tracked => [tracked.path, tracked]));
      const moved = new Set<string>();
      let previous = win.__siteLabRead();
      do {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const values = win.__siteLabRead();
        const changed = win.__siteLabClassifyIdle([previous, values]);
        for (const path of changed.own) { const tracked = byPath.get(path); if (tracked) tracked.ambient = true; }
        for (const path of changed.moved) moved.add(path);
        previous = values;
      } while (performance.now() - start < duration);
      for (const tracked of win.__siteLabTracked) if (!tracked.ambient && structural(tracked.el)) tracked.ambient = true;
      // Each element's ancestor chain is walked at most once per window.
      const ambientElements = new Set(win.__siteLabTracked.filter(t => t.ambient).map(t => t.el));
      const memo = new WeakMap<Element, boolean>();
      const ambientOrInside = (el: Element | null): boolean => {
        if (!el) return false;
        const known = memo.get(el); if (known !== undefined) return known;
        const value = ambientElements.has(el) || structural(el) || ambientOrInside(el.parentElement);
        memo.set(el, value); return value;
      };
      for (const tracked of win.__siteLabTracked) {
        tracked.ambientAncestor = !tracked.ambient && (tracked.ambientAncestor || moved.has(tracked.path) || ambientOrInside(tracked.el.parentElement));
      }
      return { elements: win.__siteLabTracked.map(({ path, ambient, ambientAncestor }) => ({ path, ambient, ambientAncestor })), elapsed: performance.now() - start };
    }, duration);
    if (result.elapsed > duration * 1.5) warnings.push(`${width}px: idle motion check took ${Math.round(result.elapsed)}ms (requested ${duration}ms).`);
    return result.elements;
  };
  const selected = await select();
  if (!layout && selected.priorityCount > options.maxElements) warnings.push(`Motion candidates capped at ${options.maxElements} of ${selected.priorityCount}.`);
  // A document that does not scroll (WebGL scenes, full-screen carousels, drag reels) is driven by other input: the
  // wheel, then the down-arrow key, PageDown, then a drag are tried, and the first that visibly changes the screen is
  // used for every step. y is then the input distance (a third of a screen per key press or drag). Sampling stops when
  // 4 steps in a row change nothing, when the page comes round to a screen it showed before, or after MAX_WHEEL_STEPS. If only
  // the wheel works but changes little, its flicks double (up to 3 screens): many pages snap back below a threshold.
  const virtual = selected.maxScroll < 40;
  const screen = page.viewportSize()?.height ?? 900;
  const delta = Math.round(screen / 3);
  let flick = delta; let travelled = 0; let driver: Driver | undefined; let probe = 0; let used: Driver = 'wheel';
  const seen: Uint8Array[] = [];
  const curves: Curves = { width, maxScroll: selected.maxScroll, paths: selected.paths, steps: [], elements: [] };
  await mkdir(join(passDir, 'screenshots'), { recursive: true });
  let previous: Record<string, SampleValue> = {};
  const steps = virtual ? Array.from({ length: MAX_WHEEL_STEPS }, () => 0) : scrollPositions(selected.maxScroll, requestedStep);
  const engine = passDir.split('/').at(-1)?.split('-')[0];
  const progress = new ScrollProgress(`${engine} ${width}px${virtual ? ' (page does not scroll: driving it with wheel, keys or drag)' : ''}`, steps.length);
  let unstable = 0; let quiet = 0;
  try {
    curves.elements = await idle(1000);
    for (const [index, planned] of steps.entries()) {
      if (control?.interrupted) break;
      const started = performance.now();
      if (index > 0 && index % 25 === 0) {
        const selection = await select(); curves.paths = selection.paths;
        curves.elements = await idle(500);
        if (control?.interrupted) break;
      }
      if (virtual && index > 0) {
        used = driver ?? DRIVERS[probe];
        await drive(page, used, flick);
        travelled += used === 'wheel' ? flick : delta;
      }
      const y = virtual ? travelled : planned;
      const sample = await page.evaluate(async ({ y, settleMax, virtual }) => {
        const win = window as unknown as SamplingWindow;
        if (!virtual) {
          try { if (typeof win.lenis?.scrollTo === 'function') win.lenis.scrollTo(y, { immediate: true }); else window.scrollTo(0, y); } catch { window.scrollTo(0, y); }
          try { (win.ScrollTrigger ?? win.gsap?.core?.globals?.().ScrollTrigger)?.update?.(); } catch { /* page error */ }
        }
        // Let Lenis/ScrollTrigger and the rendering pipeline apply the immediate jump.
        for (let i = 0; i < 2; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        // Wheel input is smoothed, and many pages ignore the wheel mid-transition: a wheel step is never settled before 900ms.
        const minimum = virtual ? 900 : 0;
        const start = performance.now(); let frames = 0; let equal = 0; let last = ''; let values: Record<string, SampleValue> = {};
        do {
          // A timer bounds the wait even when the page stops delivering animation frames.
          const remaining = settleMax - (performance.now() - start);
          if (remaining <= 0) break;
          const frameArrived = await new Promise<boolean>(resolve => {
            const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(false); }, remaining);
            const frame = requestAnimationFrame(() => { clearTimeout(timer); resolve(true); });
          });
          if (!frameArrived) break;
          frames++; values = win.__siteLabRead();
          // Wheel-driven pages often animate text (scrambles, counters) between states: wait for that too.
          const serialised = JSON.stringify(Object.fromEntries(win.__siteLabTracked.filter(t => !t.ambient && !t.ambientAncestor).map(t => [t.path, values[t.path]]))) + (virtual ? document.body.innerText : '');
          equal = serialised === last ? equal + 1 : 1; last = serialised;
        } while ((equal < 2 || performance.now() - start < minimum) && performance.now() - start < settleMax);
        if (!Object.keys(values).length) values = win.__siteLabRead();
        for (const tracked of win.__siteLabTracked) Object.assign(values[tracked.path], { ambient: tracked.ambient, ambientAncestor: tracked.ambientAncestor });
        return { values, frames, stable: equal >= 2, settleMs: performance.now() - start, timedOut: equal < 2, y: scrollY };
      }, { y, settleMax: virtual ? Math.max(options.settleMax, 2000) : options.settleMax, virtual });
      if (sample.timedOut) unstable++;
      const changes = encodeChanges(previous, sample.values);
      curves.steps.push({ y: virtual ? y : sample.y, frames: sample.frames, stable: sample.stable, settleMs: sample.settleMs, timedOut: sample.timedOut, changes });
      previous = sample.values;
      const save = engine === 'chromium' || index % 3 === 0 || index === steps.length - 1;
      const shot = save || virtual ? await page.screenshot({ ...(save ? { path: join(passDir, 'screenshots', `step-${y}.png`) } : {}), animations: 'allow', timeout: 30000 }) : undefined;
      progress.step(index + 1, performance.now() - started);
      if (virtual && shot) {
        const current = await thumbnail(shot);
        const previousThumb = seen.at(-1);
        if (previousThumb) {
          const change = visualChange(previousThumb, current);
          if (!driver) {
            if (change >= MOVED) driver = used;
            else if (probe < DRIVERS.length - 1) probe++;
            else driver = 'wheel';
          } else if (driver === 'wheel' && change < MOVED) flick = Math.min(flick * 2, screen * 3);
          quiet = change < STILL ? quiet + 1 : 0;
          // Infinite reels come round again: stop once two screens in a row match two in a row from at least 6 steps earlier.
          const looped = driver !== undefined && change >= STILL && seen.some((earlier, j) => j >= 1 && j <= seen.length - 6 && visualChange(earlier, current) < 0.03 && visualChange(seen[j - 1], previousThumb) < 0.03);
          if (looped || (driver && quiet >= 4)) break;
        }
        seen.push(current);
      }
    }
  } finally {
    progress.end();
    if (unstable) warnings.push(`${engine} ${width}px: ${unstable}/${curves.steps.length} scroll samples reached the ${virtual ? Math.max(options.settleMax, 2000) : options.settleMax}ms stability cap.`);
    if (virtual) curves.virtual = { delta, extent: curves.steps.at(-1)?.y ?? 0, driver: driver ?? used, steps: curves.steps.length };
    await writeJson(join(motionDir, `scroll-curves-${width}.json`), curves);
    await writeJson(join(motionDir, `effects-${width}.json`), deriveEffects(curves));
  }
  const effects = deriveEffects(curves);
  // A wheel-driven page cannot be reliably wheeled back (many lock input during transitions); the caller reloads it.
  if (!virtual) await page.evaluate(() => { const win = window as unknown as SamplingWindow; try { if (typeof win.lenis?.scrollTo === 'function') win.lenis.scrollTo(0, { immediate: true }); else scrollTo(0, 0); } catch { scrollTo(0, 0); } });
  return { ...effects, steps: curves.steps.length, timedOutSteps: unstable, scrollStep: virtual ? delta : scrollStep(selected.maxScroll, requestedStep), ...(virtual ? { virtualExtent: curves.virtual?.extent ?? 0, virtualDriver: driver ?? used } : {}) };
}

export function expandCurves(curves: Curves) {
  let state: Record<string, SampleValue> = {};
  return curves.steps.map(step => {
    state = { ...state };
    for (const [path, delta] of Object.entries(step.changes)) {
      state[path] = { ...state[path], ...delta, box: { ...state[path]?.box, ...delta.box } } as SampleValue;
    }
    return { y: step.y, values: state };
  });
}
export function encodeChanges(previous: Record<string, SampleValue>, current: Record<string, SampleValue>) {
  const changes: Record<string, SampleDelta> = {};
  for (const [path, value] of Object.entries(current)) {
    const old = previous[path];
    if (!old) { changes[path] = value; continue; }
    const delta = Object.fromEntries(Object.entries(value).filter(([key, v]) => key !== 'box' && v !== old[key as keyof SampleValue])) as SampleDelta;
    const box = Object.fromEntries(Object.entries(value.box).filter(([key, v]) => v !== old.box[key as keyof typeof old.box]));
    if (Object.keys(box).length) delta.box = box;
    if (Object.keys(delta).length) changes[path] = delta;
  }
  return changes;
}
export function numericProperties(v: SampleValue): Record<string, number> {
  const result: Record<string, number> = { translateX: v.translateX, translateY: v.translateY, scaleX: v.scaleX, scaleY: v.scaleY, rotate: v.rotate, opacity: v.opacity, 'box.x': v.box.x, 'box.y': v.box.y, 'box.w': v.box.w, 'box.h': v.box.h };
  // Preserve the raw CSS strings in curves; measure their numeric components too.
  // URL-backed filters/clips have no meaningful numeric interpolation here.
  for (const property of ['clipPath', 'filter'] as const) {
    if (v[property] === 'none' || /url\(/i.test(v[property])) continue;
    const values = [...v[property].matchAll(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)];
    values.forEach((match, index) => { result[`${property}[${index}]`] = Number(match[0]); });
  }
  return result;
}
const easings: Record<string, (t: number) => number> = {
  linear: t => t,
  'power2.inOut': t => t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2,
  'power3.out': t => 1 - (1 - t) ** 4,
  'expo.out': t => t === 1 ? 1 : 1 - 2 ** (-10 * t)
};
export function deriveEffects(curves: Curves): Effects {
  const expanded = expandCurves(curves);
  const effects: Effect[] = []; const pinned: Effect[] = [];
  const flags = new Map((curves.elements ?? []).map(element => [element.path, element]));
  for (const path of curves.paths) {
    // Elements that move by themselves while idle are skipped; elements carried by them keep their effects.
    if (flags.get(path)?.ambient || expanded.some(step => step.values[path]?.ambient)) continue;
    const insideAmbient = Boolean(flags.get(path)?.ambientAncestor || expanded.some(step => step.values[path]?.ambientAncestor));
    const effectsBefore = effects.length; const pinnedBefore = pinned.length;
    const samples = expanded.flatMap(step => step.values[path] ? [{ y: step.y, value: step.values[path] }] : []);
    if (samples.length < 2) continue;
    // A carried element's box moves with its looping ancestor, so only its own properties are scroll evidence.
    const properties = [...new Set(samples.flatMap(s => Object.keys(numericProperties(s.value))))].filter(property => !insideAmbient || !property.startsWith('box.'));
    for (const property of properties) {
      const points = samples.map(s => ({ y: s.y, value: numericProperties(s.value)[property] }));
      const emit = (start: number, end: number) => {
        const from = points[start]; const to = points[end]; const magnitude = Math.abs(to.value - from.value);
        if (end <= start || magnitude < 0.001 || to.y === from.y) return;
        const fits = Object.entries(easings).map(([name, ease]) => ({ name, error: points.slice(start, end + 1).reduce((sum, p) => sum + ((p.value - from.value) / (to.value - from.value) - ease((p.y - from.y) / (to.y - from.y))) ** 2, 0) / (end - start + 1) })).sort((a, b) => a.error - b.error);
        effects.push({ path, property, start: from.y, end: to.y, from: from.value, to: to.value, shape: end - start === 1 ? 'step' : fits[0].name === 'linear' ? 'linear' : 'eased', ease: fits[0].name, error: fits[0].error, magnitude });
      };
      let start = -1; let direction = 0;
      for (let i = 1; i < points.length; i++) {
        if (!Number.isFinite(points[i].value) || !Number.isFinite(points[i - 1].value)) {
          if (start >= 0) emit(start, i - 1);
          start = -1; direction = 0; continue;
        }
        const delta = points[i].value - points[i - 1].value;
        const sign = Math.abs(delta) < 1e-8 ? 0 : Math.sign(delta);
        if (sign === 0) { if (start >= 0) emit(start, i - 1); start = -1; direction = 0; }
        else if (start < 0) { start = i - 1; direction = sign; }
        else if (sign !== direction) { emit(start, i - 1); start = i - 1; direction = sign; }
      }
      if (start >= 0) emit(start, points.length - 1);
    }
    for (const property of ['clipPath', 'filter', 'position'] as const) {
      let start = 0;
      for (let i = 1; i < samples.length; i++) if (samples[i].value[property] !== samples[start].value[property]) {
        effects.push({ path, property, start: samples[i - 1].y, end: samples[i].y, from: samples[start].value[property], to: samples[i].value[property], shape: 'step', ease: 'unverified (non-numeric)', error: 0, magnitude: 1 }); start = i;
      }
    }
    let start = 0;
    const emitPin = (end: number) => {
      if (insideAmbient) return;
      // Three scroll intervals, not just three observations, reduce accidental plateaus.
      if (end - start >= 3 && samples[end].y > samples[start].y) pinned.push({ path, property: 'pin', start: samples[start].y, end: samples[end].y, from: samples[start].value.box.y, to: samples[end].value.box.y, shape: 'pinned', ease: 'measured viewport plateau', error: Math.abs(samples[end].value.box.y - samples[start].value.box.y), magnitude: samples[end].y - samples[start].y });
    };
    for (let i = 1; i < samples.length; i++) {
      if (Math.abs(samples[i].value.box.y - samples[start].value.box.y) >= 1) { emitPin(i - 1); start = i; }
    }
    emitPin(samples.length - 1);
    if (insideAmbient) for (const effect of [...effects.slice(effectsBefore), ...pinned.slice(pinnedBefore)]) effect.insideAmbient = true;
  }
  return { width: curves.width, effects, pinned, ...(curves.elements ? { elements: curves.elements } : {}) };
}
