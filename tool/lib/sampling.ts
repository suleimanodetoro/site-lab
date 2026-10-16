import type { SampleValue } from './types.js';

// Pure classifier, also installed in the page for frame-by-frame idle observations.
export function classifyAmbient(samples: Record<string, unknown>[], always: string[] = []): string[] {
  const ambient = new Set(always); const previous = new Map<string, string>();
  for (const sample of samples) for (const [path, value] of Object.entries(sample)) {
    const encoded = JSON.stringify(value);
    if (previous.has(path) && previous.get(path) !== encoded) ambient.add(path);
    previous.set(path, encoded);
  }
  return [...ambient];
}
// Pure and self-contained (it is also injected into the page). Separates an element's own idle
// motion (its transform/opacity/clip/filter change) from being carried by something else (only its box moves).
export function classifyIdle(samples: Record<string, { transform?: string; opacity?: number; clipPath?: string; filter?: string; box?: unknown }>[]): { own: string[]; moved: string[] } {
  const own = new Set<string>(); const moved = new Set<string>(); const last = new Map<string, (typeof samples)[number][string]>();
  for (const sample of samples) for (const [path, value] of Object.entries(sample)) {
    const previous = last.get(path);
    if (previous) {
      if (['transform', 'opacity', 'clipPath', 'filter'].some(key => JSON.stringify(previous[key as 'opacity']) !== JSON.stringify(value[key as 'opacity']))) own.add(path);
      else if (JSON.stringify(previous.box) !== JSON.stringify(value.box)) moved.add(path);
    }
    last.set(path, value);
  }
  for (const path of own) moved.delete(path);
  return { own: [...own], moved: [...moved] };
}
interface TweenTargets { targets?: () => unknown[]; getChildren?: (nested: boolean, tweens: boolean, timelines: boolean) => TweenTargets[] }
interface Trigger { trigger?: unknown; pin?: unknown; animation?: TweenTargets }
interface ScrollTriggerGlobal { update?: () => void; getAll?: () => Trigger[] }
export interface SamplingWindow {
  lenis?: { scrollTo?: (y: number, options: { immediate: boolean }) => void };
  ScrollTrigger?: ScrollTriggerGlobal;
  gsap?: { core?: { globals?: () => { ScrollTrigger?: ScrollTriggerGlobal } } };
  __siteLabTracked: { el: Element; path: string; ambient: boolean; ambientAncestor: boolean }[];
  __siteLabRead: typeof readTracked;
  __siteLabClassify: typeof classifyAmbient;
  __siteLabClassifyIdle: typeof classifyIdle;
}
export function readTracked(): Record<string, SampleValue> {
  const win = window as unknown as SamplingWindow;
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return Object.fromEntries(win.__siteLabTracked.map(({ el, path }) => {
    const cs = getComputedStyle(el); const rect = el.getBoundingClientRect();
    let matrix = new DOMMatrixReadOnly();
    try { if (cs.transform !== 'none') matrix = new DOMMatrixReadOnly(cs.transform); } catch { /* retain raw transform */ }
    const sx = Math.hypot(matrix.m11, matrix.m12, matrix.m13);
    const sy = matrix.is2D && sx ? (matrix.a * matrix.d - matrix.b * matrix.c) / sx : Math.hypot(matrix.m21, matrix.m22, matrix.m23);
    return [path, { transform: cs.transform === 'none' ? 'matrix(1, 0, 0, 1, 0, 0)' : cs.transform,
      translateX: round(matrix.m41), translateY: round(matrix.m42), scaleX: round(sx), scaleY: round(sy), rotate: round(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI),
      opacity: Number(cs.opacity), clipPath: cs.clipPath, filter: cs.filter,
      box: { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) }, position: cs.position }];
  }));
}
