import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureOptions, Engine, MotionInventory, RunReport } from './lib/types.js';
import { preflight, source } from './lib/preflight.js';
import { openSession, ResponseCollector, viewport } from './lib/browser.js';
import { load, prepare } from './lib/page-prep.js';
import { captureHover, captureStatic } from './lib/static.js';
import { inventory, saveInventory, scrollSample } from './lib/motion.js';
import { captureVideos } from './lib/video.js';
import { writeReport } from './lib/report.js';
import { captureControl, CaptureInterrupted } from './lib/interrupt.js';
import { scrollPositions, formatDuration } from './lib/progress.js';
import { errorMessage, isMain, log, writeJson } from './lib/util.js';
import { chooseWidths, discoverBreakpoints, watchMatchMedia } from './lib/breakpoints.js';
import { acquireSlot } from './lib/slots.js';
import { ffmpeg, ffprobe, missingFfmpeg } from './lib/binaries.js';
import { recordTimedChanges } from './lib/timeline.js';

export function parseCaptureArgs(args: string[]): CaptureOptions {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    widths: { type: 'string', default: 'auto' }, 'timeline-ms': { type: 'string', default: '4000' }, 'no-timeline': { type: 'boolean' }, engines: { type: 'string', default: 'chromium' },
    'terms-ok': { type: 'boolean', default: false }, reason: { type: 'string', default: 'Page study' }, hide: { type: 'string', multiple: true }, 'no-consent-dismiss': { type: 'boolean', default: false },
    'scroll-step': { type: 'string', default: 'auto' }, 'settle-max': { type: 'string', default: '800' }, 'max-elements': { type: 'string', default: '1500' },
    'no-video': { type: 'boolean' }, 'no-assets': { type: 'boolean' }, 'no-hover': { type: 'boolean' }, out: { type: 'string' },
    'no-gate': { type: 'boolean', default: false }, click: { type: 'string', multiple: true }, 'intro-seconds': { type: 'string', default: '40' },
    'motion-all-engines': { type: 'boolean' }, 'robots-unknown-ok': { type: 'boolean' }
  } });
  if (positionals.length !== 1) throw new Error('Usage: npm run capture -- <url> [options]; one page URL only.');
  const url = new URL(positionals[0]);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP(S) URL.');
  // `auto` starts from phone and desktop, then adds every CSS breakpoint found on the page (see runCapture).
  const autoWidths = values.widths === 'auto';
  const widths = autoWidths ? [390, 1440] : [...new Set(values.widths.split(',').map(Number))].sort((a, b) => a - b);
  const timelineMs = values['no-timeline'] ? 0 : Number(values['timeline-ms']);
  if (!Number.isInteger(timelineMs) || timelineMs < 0) throw new Error('--timeline-ms must be a non-negative integer.');
  if (!widths.length || widths.some(w => !Number.isInteger(w) || w < 1 || w > 16384)) throw new Error('--widths must contain positive integer viewport widths, at most 16384.');
  const engines = [...new Set(values.engines.split(','))];
  if (!engines.length || engines.some(e => e !== 'chromium' && e !== 'webkit')) throw new Error('--engines supports chromium,webkit.');
  const introSeconds = Number(values['intro-seconds']);
  if (!Number.isInteger(introSeconds) || introSeconds < 1) throw new Error('--intro-seconds must be a positive integer.');
  const scrollStep = values['scroll-step'] === 'auto' ? 'auto' : Number(values['scroll-step']); const maxElements = Number(values['max-elements']); const settleMax = Number(values['settle-max']);
  if ((scrollStep !== 'auto' && (!Number.isInteger(scrollStep) || scrollStep < 1)) || !Number.isInteger(maxElements) || maxElements < 1 || !Number.isInteger(settleMax) || settleMax < 1) throw new Error('--scroll-step must be auto or a positive integer; --max-elements and --settle-max must be positive integers.');
  return { url: url.href, widths, autoWidths, timelineMs, engines: engines as Engine[], termsOk: values['terms-ok'], reason: values.reason.trim() || 'Page study', hide: values.hide ?? [], scrollStep, settleMax, maxElements, video: !values['no-video'], assets: !values['no-assets'], hover: !values['no-hover'], consent: !values['no-consent-dismiss'], out: values.out, motionAllEngines: Boolean(values['motion-all-engines']), robotsUnknownOk: Boolean(values['robots-unknown-ok']), gate: !values['no-gate'], click: values.click ?? [], introSeconds };
}

function mergeInventory(early: MotionInventory, later: MotionInventory) {
  later.waapi = [...later.waapi, ...early.waapi].filter((a: any, i, all: any[]) => all.findIndex(b => b.target === a.target && b.animationName === a.animationName) === i);
  return later;
}
export async function runCapture(options: CaptureOptions): Promise<RunReport> {
  const control = captureControl();
  let runningStage = 'preflight';
  let interruptedStage: string | undefined;
  const onInterrupt = () => {
    if (control.interrupted) process.exit(130);
    control.interrupted = true;
    interruptedStage = runningStage;
    log(`interrupt requested during ${runningStage}; finishing current step`);
  };
  if (options.video && (!ffmpeg || !ffprobe)) throw new Error(missingFfmpeg);
  process.on('SIGINT', onInterrupt);
  let pre: Awaited<ReturnType<typeof preflight>>;
  try { pre = await preflight(options); }
  catch (error) { process.off('SIGINT', onInterrupt); if (control.interrupted) process.exitCode = 130; throw error; }
  log(`output ${pre.out}`);
  for (const warning of pre.warnings) log(`warning: ${warning}`);
  const recordUrl = (url: string) => { if (url !== 'about:blank' && !pre.resolvedUrls.includes(url)) pre.resolvedUrls.push(url); };
  const report: RunReport = { url: options.url, out: pre.out, ethics: `robots ${pre.robots}; ${pre.terms}`, status: 'in progress', libraries: [], assets: [], passes: [], warnings: [...pre.warnings], resolvedUrls: pre.resolvedUrls };
  if (!options.video) report.warnings.push('Video stage skipped (--no-video).');
  if (!options.assets) report.warnings.push('Asset stage skipped (--no-assets); HAR response bodies omitted.');
  if (!options.hover) report.warnings.push('Hover stage skipped (--no-hover).');
  if (!options.engines.includes('chromium')) report.warnings.push('Chromium omitted; network.har unavailable. Motion/video require --motion-all-engines for WebKit.');
  const collector = new ResponseCollector(pre.out, options.assets, report.warnings);
  report.timings = [];
  const stage = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    control.checkpoint(); runningStage = name; const started = performance.now();
    log(`${name} start`);
    try { return await action(); }
    finally {
      const durationMs = performance.now() - started;
      report.timings?.push({ stage: name, durationMs });
      log(`${name} end · ${formatDuration(durationMs)}`);
    }
  };
  if (options.autoWidths) {
    // One extra load at desktop width to read the site's own breakpoints, then capture each layout.
    const found = await stage('breakpoints', async () => {
      const session = await openSession('chromium', 1440, options);
      try {
        await watchMatchMedia(session.page);
        const loaded = await load(session, options);
        if (loaded.gate.action !== 'none') { report.gate = loaded.gate; log(`entry gate: ${loaded.gate.action} (${loaded.gate.detail})`); }
        await session.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
        return await discoverBreakpoints(session.page);
      } finally { await session.close(); }
    });
    options.widths = chooseWidths(found.breakpoints);
    report.breakpoints = { found: found.breakpoints, widths: options.widths, fetchedSheets: found.fetchedSheets, scriptQueries: found.scriptQueries };
    if (found.unreadableSheets) report.warnings.push(`${found.unreadableSheets} stylesheet(s) could not be read or fetched; their breakpoints may be missing.`);
    log(`breakpoints: ${found.breakpoints.map(b => `${b.kind}-${b.px}`).join(', ') || 'none'} → capturing ${options.widths.join(', ')}px`);
  }
  // Motion, video and the timeline run at phone and desktop; every other width gets layout and screenshots.
  const motionWidths = options.autoWidths ? [390, 1440] : options.widths.filter((_, i) => i === 0 || i === options.widths.length - 1);
  // In-between widths are layout-only and run first; the motion widths take a timing slot (see lib/slots.ts).
  const order = options.engines.flatMap(engine => [...options.widths.filter(w => !motionWidths.includes(w)), ...options.widths.filter(w => motionWidths.includes(w))].map(width => ({ engine, width })));
  let har = false; let planned = false;
  try {
    for (const { engine, width } of order) {
      control.checkpoint();
      log(`capture ${engine} ${width}px`);
      const dir = join(pre.out, `${engine}-${width}`);
      await mkdir(dir, { recursive: true });
      const withMotion = (engine === 'chromium' || options.motionAllEngines) && motionWidths.includes(width);
      const layoutOnly = !motionWidths.includes(width);
      const motionDir = join(pre.out, 'motion', ...(engine === 'webkit' ? ['webkit'] : []));
      runningStage = `waiting for a slot ${engine} ${width}px`;
      const release = layoutOnly ? undefined : await acquireSlot(`${new URL(options.url).hostname} ${engine} ${width}px`, control);
      const session = await openSession(engine, width, options, !har && engine === 'chromium' ? { har: join(pre.out, 'network.har') } : {}).catch(async error => { await release?.(); throw error; });
      if (engine === 'chromium') har = true;
      const detachCollector = collector.attach(session.page, dir);
      try {
        runningStage = `preparation ${engine} ${width}px`;
        await mkdir(join(dir, 'screenshots'), { recursive: true });
        const { consent, gate } = await load(session, options, { gateShot: join(dir, 'screenshots', 'gate.png') }); control.checkpoint();
        report.consent ??= consent;
        if (!report.gate || report.gate.action === 'none') report.gate = gate;
        if (consent.action !== 'none') log(`consent: ${consent.action} (${consent.detail})`);
        if (gate.action !== 'none') log(`entry gate: ${gate.action} (${gate.detail})`);
        const early = await inventory(session.page);
        await prepare(session, report.warnings, control);
        control.checkpoint();
        const pageHeight = await session.page.evaluate(() => document.documentElement.scrollHeight);
        if (!planned) {
          log(`plan: ${order.map(({ engine: e, width: w }) => `${e} ${w}px ~${scrollPositions(Math.max(0, pageHeight - viewport(w).height), !motionWidths.includes(w) && options.scrollStep === 'auto' ? Math.round(viewport(w).height / 2) : options.scrollStep).length} steps`).join(' → ')} (estimates from first prepared page; each pass remeasures)`);
          planned = true;
        }
        recordUrl(session.page.url());
        const data = mergeInventory(early, await inventory(session.page));
        await collector.flush();
        for (const [name, evidence] of collector.signatures) {
          const lib = data.libraries.find(l => l.name === name);
          if (lib) lib.evidence = [...new Set([...lib.evidence, ...evidence])];
          else data.libraries.push({ name, evidence, reachable: false });
        }
        if (!data.gsap.reachable && data.libraries.some(l => l.name === 'gsap')) data.gsap.note = 'GSAP detected in bundles but its global is not reachable.';
        for (const lib of data.libraries) {
          const existing = report.libraries.find(l => l.name === lib.name);
          if (!existing) report.libraries.push(lib);
          else { existing.reachable ||= lib.reachable; existing.evidence = [...new Set([...existing.evidence, ...lib.evidence])]; }
        }
        const stats = await stage(`static ${engine} ${width}px`, () => captureStatic(session.page, dir, report.warnings));
        // Keep each pass's exact inventory and a canonical widest-width inventory.
        await saveInventory(join(dir, 'motion'), data);
        if (withMotion) await saveInventory(motionDir, data);
        if (data.gsap.note) report.warnings.push(data.gsap.note);
        const pass: RunReport['passes'][number] = { engine, width, ...stats, hover: 0, waapi: data.waapi.length, scrollTriggers: data.gsap.scrollTriggers.length, pinned: 0, effects: [], steps: 0, timedOutSteps: 0, ...(layoutOnly ? { layoutOnly } : {}) };
        report.passes.push(pass);
        const motion = await stage(`${layoutOnly ? 'layout' : 'motion'} ${engine} ${width}px`, () => scrollSample(session, options, width, dir, withMotion ? motionDir : join(dir, 'motion'), report.warnings, control, layoutOnly));
        Object.assign(pass, { pinned: withMotion ? motion.pinned.length : 0, effects: withMotion ? [...motion.effects, ...motion.pinned] : [], steps: motion.steps, timedOutSteps: motion.timedOutSteps, scrollStep: motion.scrollStep, ...(motion.virtualExtent !== undefined ? { virtualExtent: motion.virtualExtent, virtualDriver: motion.virtualDriver } : {}) });
        control.checkpoint();
        // After wheel sampling, reload so hover and the timeline start from the opening state.
        if (motion.virtualExtent !== undefined && !layoutOnly) { await load(session, options); await prepare(session, report.warnings, control); }
        // Hover states rarely change with width; in-between widths skip them.
        if (options.hover && !layoutOnly) pass.hover = await stage(`hover ${engine} ${width}px`, () => captureHover(session.page, dir, report.warnings, control));
        control.checkpoint();
        if (withMotion && options.timelineMs > 0) {
          const timed = await stage(`timeline ${engine} ${width}px`, () => recordTimedChanges(session.page, width, motionDir, options.timelineMs, control));
          (report.timedChanges ??= {})[`${engine}-${width}`] = timed;
          control.checkpoint();
        }
      } finally {
        recordUrl(session.page.url());
        detachCollector();
        runningStage = `assets ${engine} ${width}px`;
        // Clean-up is time-bounded; log any part that is slow so hangs are visible, not silent.
        const cleanupStarted = performance.now();
        try { await collector.finishPass(session.context); }
        finally {
          const savedMs = performance.now() - cleanupStarted;
          if (savedMs > 3000) log(`asset saving took ${formatDuration(savedMs)}`);
          const closeStarted = performance.now();
          try { await session.close(); } finally { await release?.(); }
          const closeMs = performance.now() - closeStarted;
          if (closeMs > 3000) log(`closing the browser took ${formatDuration(closeMs)}`);
        }
      }
    }
    if (options.video) for (const engine of options.engines.filter(e => e === 'chromium' || options.motionAllEngines)) for (const width of motionWidths) {
      const pass = report.passes.find(p => p.engine === engine && p.width === width);
      const virtual = pass?.virtualExtent !== undefined ? { extent: pass.virtualExtent, driver: pass.virtualDriver ?? 'wheel', steps: pass.steps ?? 10 } : undefined;
      await stage(`video ${engine} ${width}px`, () => captureVideos(options, engine, width, width === Math.max(...motionWidths), join(pre.out, 'video', ...(engine === 'webkit' ? ['webkit'] : [])), recordUrl, control, virtual));
    }
    control.checkpoint();
    report.status = 'complete';
  } catch (error) {
    if (error instanceof CaptureInterrupted || control.interrupted) {
      report.status = 'interrupted'; process.exitCode = 130;
    } else {
      report.status = `failed: ${errorMessage(error)}`;
      report.warnings.push(report.status);
      throw error;
    }
  } finally {
    try {
      await collector.flush(); report.assets = collector.assets;
      runningStage = 'report';
      report.passes.sort((a, b) => options.engines.indexOf(a.engine) - options.engines.indexOf(b.engine) || a.width - b.width);
      await writeJson(join(pre.out, 'assets', 'manifest.json'), collector.assets);
      do {
        if (control.interrupted) { report.status = 'interrupted'; report.interruptedStage = interruptedStage; process.exitCode = 130; }
        await source(options, pre, report.status);
        await writeReport(report);
      } while (control.interrupted && report.status !== 'interrupted');
      log(`${report.status}; ${report.passes.length} passes; ${report.assets.length} assets`);
    } finally { process.off('SIGINT', onInterrupt); }
  }
  return report;
}
if (isMain(import.meta)) {
  (async () => runCapture(parseCaptureArgs(process.argv.slice(2))))().catch(error => { console.error(errorMessage(error)); process.exitCode ??= 1; });
}
