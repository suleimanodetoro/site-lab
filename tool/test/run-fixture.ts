import assert from 'node:assert/strict';
import './run-unit.js';
import { readFile, readdir, stat, mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { join, basename, resolve, dirname } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256, writeJson } from '../lib/util.js';
import { performance } from 'node:perf_hooks';
import { parseCaptureArgs, runCapture } from '../capture.js';
import { runCompare } from '../compare.js';
import { startFixture } from '../fixtures/serve.js';
import { robotsAllows } from '../lib/preflight.js';
import { duration } from '../lib/video.js';
import type { Curves, Effects, Library, RunReport, Asset } from '../lib/types.js';
import { openSession } from '../lib/browser.js';
import { load } from '../lib/page-prep.js';
import { discoverBreakpoints, watchMatchMedia } from '../lib/breakpoints.js';
import { MAX_WHEEL_STEPS } from '../lib/motion.js';

const json = async <T = any>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
let checks = 0;
function check(name: string, action: () => void) { action(); checks++; console.log(`PASS ${name}`); }
async function captureChild(args: string[], interrupt: boolean | RegExp = false): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null; signalledAt?: number; closedAt: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tool/capture.ts', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let sent = false; let signalledAt: number | undefined;
    const trigger = interrupt === true ? /scroll \d+\/\d+ .* left/ : interrupt || null;
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Capture child timed out: ${stdout}\n${stderr}`)); }, 20 * 60 * 1000);
    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString(); stdout += text; process.stdout.write(text);
      if (trigger && !sent && trigger.test(stdout)) { sent = true; signalledAt = performance.now(); child.kill('SIGINT'); }
    });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ stdout, stderr, code, signal, signalledAt, closedAt: performance.now() }); });
  });
}
const start = performance.now();
const fixture = await startFixture();
try {
  console.log(`Fixture: ${fixture.url}`);
  check('robots longest match, Allow tie, wildcards, end anchors, groups, missing rules', () => {
    const rules = 'User-agent: other\nDisallow: /\nUser-agent: *\nDisallow: /private*\nAllow: /private/public\nDisallow: /*.pdf$\nAllow: /tie\nDisallow: /tie\nUser-agent: *\nDisallow: /merged';
    for (const [path, allowed] of [['/private', false], ['/private/public/a', true], ['/a.pdf', false], ['/a.pdf?x', true], ['/tie', true], ['/merged', false], ['/hello', true]] as const) assert.equal(robotsAllows(rules, new URL(path, fixture.url)), allowed);
    assert.equal(robotsAllows('', new URL(fixture.url)), true);
    assert.equal(robotsAllows('User-agent: *\nDisallow: /%70rivate', new URL('/private', fixture.url)), false);
  });
  check('CLI accepts an optional reason and validates dimensions and sampling options', () => {
    assert.equal(parseCaptureArgs([fixture.url]).reason, 'Page study');
    for (const args of [[], [fixture.url, fixture.url, '--reason', 'fixture'], [fixture.url, '--reason', 'fixture', '--engines', 'firefox'], [fixture.url, '--reason', 'fixture', '--scroll-step', '0'], [fixture.url, '--reason', 'fixture', '--max-elements', '-1'], [fixture.url, '--reason', 'fixture', '--widths', 'NaN']]) assert.throws(() => parseCaptureArgs(args));
  });
  // The main capture runs as a child process while the small single-purpose captures run here; timing slots
  // (lib/slots.ts) keep at most two timing-sensitive stages running at once.
  const runSide = async () => {
    const at = (path: string) => new URL(path, fixture.url).href;
    const quick = ['--widths', '390', '--engines', 'chromium', '--no-video', '--no-hover'];
    const auto = await runCapture(parseCaptureArgs([fixture.url, '--widths', 'auto', '--no-video', '--no-hover', '--no-timeline']));
    const acceptOnly = await runCapture(parseCaptureArgs([at('accept-only'), ...quick]));
    const fakeLenis = await runCapture(parseCaptureArgs([at('fake-lenis'), ...quick]));
    const reloadOnReject = await runCapture(parseCaptureArgs([at('reload-on-reject'), ...quick]));
    const walls: Record<string, RunReport> = {};
    for (const endpoint of ['blocked', 'challenge']) walls[endpoint] = await runCapture(parseCaptureArgs([at(endpoint), ...quick]));
    const gate = await runCapture(parseCaptureArgs([at('gate'), ...quick, '--no-timeline']));
    const throwing = await runCapture(parseCaptureArgs([at('throwing-scroll'), ...quick]));
    const wheel = await runCapture(parseCaptureArgs([at('wheel'), '--widths', '390', '--no-hover', '--no-timeline', '--intro-seconds', '3']));
    const cssOptions = parseCaptureArgs([at('cross-origin-css'), '--widths', '1440']);
    const session = await openSession('chromium', 1440, cssOptions);
    let breakpoints: Awaited<ReturnType<typeof discoverBreakpoints>>;
    try { await watchMatchMedia(session.page); await load(session, cssOptions); breakpoints = await discoverBreakpoints(session.page); } finally { await session.close(); }
    return { auto, acceptOnly, fakeLenis, reloadOnReject, walls, gate, wheel, breakpoints, throwing };
  };
  const [child, side] = await Promise.all([
    captureChild([fixture.url, '--widths', '390,1280', '--engines', 'chromium,webkit', '--scroll-step', 'auto', '--intro-seconds', '15', '--reason', 'fixture']),
    runSide()
  ]);
  assert.equal(child.code, 0, child.stderr); assert.equal(child.signal, null);
  const root = /\[site-lab\] output (.+)/.exec(child.stdout)?.[1]; assert(root);
  const report = await json<RunReport>(join(root, 'summary.json'));
  check('progress: ordered plan and scroll ETA on stdout', () => {
    assert.match(child.stdout, /plan: chromium 390px ~\d+ steps → chromium 1280px ~\d+ steps → webkit 390px ~\d+ steps → webkit 1280px ~\d+ steps/);
    assert.match(child.stdout, /scroll \d+\/\d+ .* left/);
    for (const stage of ['static', 'hover', 'motion', 'video']) {
      assert.match(child.stdout, new RegExp(`${stage} chromium 390px start`));
      assert.match(child.stdout, new RegExp(`${stage} chromium 390px end`));
    }
  });
  const manifest = await json<Asset[]>(join(root, 'assets/manifest.json'));
  const originalVideoHash = sha256(await readFile(fixture.videoPath));
  for (const [endpoint, ext, folder] of [['/img/hero', 'webp', 'image'], ['/img/wrong', 'avif', 'image'], ['/video/loop', 'webm', 'media']]) {
    const entries = manifest.filter(a => new URL(a.url).pathname === endpoint);
    check(`real asset type: ${endpoint} → ${folder}/*.${ext}`, () => {
      assert(entries.length > 0); assert(entries.every(a => a.path.startsWith(`assets/${folder}/`) && a.path.endsWith(`.${ext}`)));
    });
  }
  const partialVideos = manifest.filter(a => new URL(a.url).pathname === '/video/loop' && a.partial);
  check('video exercised HTTP ranges and full refetch', () => {
    assert(partialVideos.length > 0); assert(partialVideos.some(a => a.status === 206));
    assert(partialVideos.every(a => a.refetched === true && !a.refetchError && a.sha256 === originalVideoHash));
  });
  for (const entry of partialVideos) assert.equal(sha256(await readFile(join(root, entry.path))), originalVideoHash);
  check('identical response bodies share a single path', () => {
    for (const entry of manifest.filter(a => a.sha256)) assert(manifest.filter(a => a.sha256 === entry.sha256).every(a => a.path === entry.path));
  });
  console.log(`Capture: ${root}`);
  const libraries = await json<Library[]>(join(root, 'motion/libraries.json'));
  check('libraries: gsap, ScrollTrigger and lenis', () => {
    for (const name of ['gsap', 'ScrollTrigger', 'lenis']) assert(libraries.some(l => l.name === name && l.reachable), `${name} missing`);
  });
  const gsap = await json(join(root, 'motion/gsap.json'));
  check('GSAP: 3 ScrollTriggers, pinned scrub tween x=-600', () => {
    assert.equal(gsap.scrollTriggers.length, 3);
    const pinned = gsap.scrollTriggers.find((t: any) => t.pin);
    assert(pinned); assert.equal(pinned.animation.vars.x, -600); assert(pinned.scrub);
    assert(Math.abs(pinned.end - pinned.start - 1000) <= 1);
  });
  const waapi = await json<any[]>(join(root, 'motion/waapi.json'));
  check('WAAPI: CSS fade-up keyframes and 2s infinite pulse', () => {
    const fade = waapi.find(a => a.animationName === 'fade-up');
    assert(fade?.keyframes.length >= 2); assert(fade.keyframes.some((k: any) => k.opacity === '0' || k.opacity === 0));
    const pulse = waapi.find(a => a.animationName === 'pulse');
    assert(pulse?.keyframes.length >= 2); assert.equal(pulse.timing.duration, 2000);
    assert(['Infinity', null].includes(pulse.timing.iterations));
  });
  const css = await json<any[]>(join(root, 'motion/css-scroll-timelines.json'));
  check('CSS scroll timeline: progress bar view()', () => assert(css.some(t => t.path === '#progress-bar' && t['animation-timeline'].includes('view'))));
  const effects = await json<Effects>(join(root, 'motion/effects-1280.json'));
  const pin = effects.pinned.find(e => e.path === '#pin-section');
  const x = effects.effects.filter(e => e.path === '#scrub-panel' && e.property === 'translateX');
  check('effects: pin 1000px ±15%, translateX -600 ±5%, translateY parallax', () => {
    assert(pin && Math.abs(pin.end - pin.start - 1000) <= 150, JSON.stringify(pin));
    assert(x.some(e => typeof e.to === 'number' && Math.abs(e.to + 600) <= 30), JSON.stringify(x));
    assert(effects.effects.some(e => e.path === '#parallax-image' && e.property === 'translateY' && Number(e.to) > Number(e.from)));
  });
  console.log(`MEASURED pin=${pin ? pin.end - pin.start : 'missing'}px; scrub translateX=${x.map(e => e.to).join(',')}px`);
  for (const engine of ['chromium', 'webkit']) for (const width of [390, 1280]) {
    const dir = join(root, `${engine}-${width}`);
    const passCurves = await json<Curves>(join(root, engine === 'chromium' ? 'motion' : `${engine}-${width}/motion`, `scroll-curves-${width}.json`));
    const passEffects = await json<Effects>(join(root, engine === 'chromium' ? 'motion' : `${engine}-${width}/motion`, `effects-${width}.json`));
    check(`${engine}-${width}: looping video and marquee dropped; carried marquee child has no effects`, () => {
      for (const path of ['#ambient-video', '#marquee']) {
        assert(passCurves.elements?.some(e => e.path === path && e.ambient), path);
        assert(passEffects.elements?.some(e => e.path === path && e.ambient), path);
        assert(![...passEffects.effects, ...passEffects.pinned].some(e => e.path === path), path);
        assert(passCurves.steps.some(step => step.changes[path]?.ambient === true), path);
      }
      assert(passCurves.elements?.some(e => e.path === '#marquee-child' && !e.ambient && e.ambientAncestor));
      assert(![...passEffects.effects, ...passEffects.pinned].some(e => e.path === '#marquee-child'));
    });
    check(`${engine}-${width}: scroll effect inside a looping wrapper is kept and flagged`, () => {
      assert(passCurves.elements?.some(e => e.path === '#glow-wrap' && e.ambient));
      const inside = passEffects.effects.filter(e => e.path === '#inside-loop' && e.property === 'translateY');
      assert(inside.length && inside.every(e => e.insideAmbient === true), JSON.stringify(inside));
      assert(inside.some(e => Number(e.to) < Number(e.from)));
    });
    check(`${engine}-${width}: auto ≤155 steps; ≤5% timed out; per-step settling metadata`, () => {
      assert(passCurves.steps.length > 0 && passCurves.steps.length <= 155);
      assert(passCurves.steps.every(s => typeof s.settleMs === 'number' && s.settleMs >= 0 && typeof s.timedOut === 'boolean'));
      assert(passCurves.steps.filter(s => s.timedOut).length / passCurves.steps.length <= 0.05);
      if (width === 1280) assert(passCurves.maxScroll + 900 >= 8000);
    });
    const stepScreens = (await readdir(join(dir, 'screenshots'))).filter(s => s.startsWith('step-'));
    check(`${engine}-${width}: screenshot cadence`, () => {
      const expected = passCurves.steps.filter((_, i) => engine === 'chromium' || i % 3 === 0 || i === passCurves.steps.length - 1).map(s => `step-${s.y}.png`);
      assert.deepEqual(stepScreens.sort(), expected.sort());
    });
    const hover = await json<any[]>(join(dir, 'hover.json'));
    check(`${engine}-${width}: 5 hover entries, each with computed-style differences`, () => { assert.equal(hover.length, 5); assert(hover.every(h => Object.keys(h.diff).length > 0)); });
    check(`${engine}-${width}: a hover target that detached was skipped with a warning, not a failure`, () => {
      assert(report.warnings.some(w => w.startsWith('Hover skipped') && w.includes('vanishing-link')), JSON.stringify(report.warnings));
    });
    const computed = await json<any[]>(join(dir, 'computed.json'));
    check(`${engine}-${width}: DOM, computed values, fonts/colours, ARIA and readable styles`, () => {
      assert(computed.length > 15); assert(computed.every(e => e.path && e.box && e.props));
      assert(report.passes.find(p => p.engine === engine && p.width === width)!.tokens.fonts.length > 0);
    });
    for (const file of ['dom.html', 'aria.yml', 'styles/inline.css', 'screenshots/full.png']) assert((await stat(join(dir, file))).size > 0);
  }
  for (const width of [390, 1280]) {
    const curves: Curves = await json<Curves>(join(root, `motion/scroll-curves-${width}.json`));
    check(`${width}px: delta-encoded curves reach maxScroll; all Chromium sample screenshots`, () => {
      assert.equal(curves.steps.at(-1)?.y, curves.maxScroll); assert(curves.steps.length > 20);
      assert(JSON.stringify(curves.steps[1].changes).length < JSON.stringify(curves.steps[0].changes).length);
    });
    const screens: string[] = await readdir(join(root, `chromium-${width}/screenshots`));
    assert.equal(screens.filter(s => s.startsWith('step-')).length, curves.steps.length);
    for (const kind of ['tour', 'intro-slow', ...(width === 1280 ? ['pointer'] : [])]) {
      const file = join(root, 'video', `${kind}-${width}.mp4`);
      const seconds = await duration(file);
      check(`video ${basename(file)}: ${seconds.toFixed(2)}s (>1s)`, () => assert(seconds > 1));
      if (kind === 'intro-slow') {
        const frames = (await readdir(join(root, 'video', `frames-${kind}-${width}`))).filter(f => f.endsWith('.jpg')).length;
        check(`${width}px slowed intro: ${frames} extracted JPEG frames (>100), real duration ≥15s (--intro-seconds 15)`, () => { assert(frames > 100); assert(seconds >= 15); });
      }
    }
  }
  const source = await readFile(join(root, 'SOURCE.md'), 'utf8');
  const summary = await readFile(join(root, 'SUMMARY.md'), 'utf8');
  check('provenance, assets, HAR and summary under 150 lines', () => {
    assert(source.includes('local host; robots check skipped')); assert(source.includes('Reason: fixture'));
    assert(summary.trimEnd().split('\n').length < 150); assert(report.assets.length >= 7);
    assert(summary.includes('## Timing')); assert(summary.includes('## Settling'));
    assert(report.timings?.every(t => t.durationMs >= 0));
  });
  assert((await stat(join(root, 'network.har'))).size > 0);
  const comparison = await runCompare(root, root);
  check(`self-compare: ${comparison.images.length} images, all 0% mismatch`, () => { assert(comparison.images.length > 100); assert(comparison.images.every(i => i.mismatchPercent === 0 && !i.sizeDifference)); assert(comparison.motion.every(m => m.rms === 0 && m.approximate)); });
  const mapped = await runCompare(root, root, { map: { '#scrub-panel': '#scrub-panel', '#parallax-image': '#parallax-image' } });
  check(`mapped self-compare: ${mapped.motion.length} properties, all RMS/max error=0`, () => { assert(mapped.motion.length > 10); assert(mapped.motion.every(m => m.rms === 0 && m.maxError === 0 && !m.approximate)); });
  const timed = await json<{ elements: { path: string; kind: string; values: string[]; medianIntervalMs: number | null; cycles: boolean }[] }>(join(root, 'motion/timed-changes-1280.json'));
  check('timeline: the rotating phrase is recorded with all three values, its ~1s period and that it cycles', () => {
    const rotator = timed.elements.find(e => e.path.includes('rotator') && ['content', 'text'].includes(e.kind)); assert(rotator, JSON.stringify(timed.elements.slice(0, 5)));
    for (const phrase of ['Posted $1,408 in payments', 'Reconciled $13,201 in claims', 'Filed 42 claims today']) assert(rotator.values.includes(phrase), phrase);
    assert(rotator.medianIntervalMs !== null && Math.abs(rotator.medianIntervalMs - 1000) <= 250, String(rotator.medianIntervalMs));
    assert(rotator.cycles);
    assert(report.timedChanges && Object.keys(report.timedChanges).length === 2);
  });
  check('timeline: stacked phrases moved by per-frame inline styles and a CSS keyframe ticker are recorded as turns, in order', () => {
    const order = (values: string[], expected: string[]) => { const start = expected.indexOf(values[0]); return values.every((value, i) => value === expected[(start + i) % expected.length]); };
    const stack = timed.elements.find(e => e.path === '#task-stack' && e.kind === 'turns'); assert(stack, JSON.stringify(timed.elements.slice(0, 6)));
    assert.equal(stack.values.length, 4); assert(order(stack.values, ['Task one', 'Task two', 'Task three', 'Task four']), stack.values.join(', '));
    assert(stack.medianIntervalMs !== null && Math.abs(stack.medianIntervalMs - 1200) <= 250, String(stack.medianIntervalMs)); assert(stack.cycles);
    const ticker = timed.elements.find(e => e.path === '#ticker' && e.kind === 'turns'); assert(ticker, JSON.stringify(timed.elements.slice(0, 6)));
    assert(order(ticker.values, ['Ticker one', 'Ticker two', 'Ticker three']) && ticker.values.length === 3, ticker.values.join(', '));
    assert(ticker.medianIntervalMs !== null && Math.abs(ticker.medianIntervalMs - 1200) <= 250, String(ticker.medianIntervalMs));
    assert(!timed.elements.some(e => e.path.startsWith('#task-stack > ')), 'stack members listed separately');
  });
  check('cross-origin stylesheets are read as text; <link media> and script matchMedia queries count too; CSS comments do not', () => {
    const found = side.breakpoints.breakpoints.map(b => `${b.kind}-${b.px}`);
    for (const expected of ['min-900', 'max-767', 'min-1200', 'max-599']) assert(found.includes(expected), `${expected} missing from ${found.join(', ')}`);
    assert(!found.includes('min-5000')); assert.equal(side.breakpoints.unreadableSheets, 0); assert.equal(side.breakpoints.fetchedSheets, 2); assert.equal(side.breakpoints.scriptQueries, 1);
  });
  {
    const gate = side.gate;
    const dom = await readFile(join(gate.out, 'chromium-390', 'dom.html'), 'utf8');
    const gateShot = await stat(join(gate.out, 'chromium-390', 'screenshots', 'gate.png'));
    check('entry gate: the fading-in ENTER splash is clicked (not the ENTER link hidden behind it), screenshotted, and the page scrolls after', () => {
      assert.equal(gate.status, 'complete', gate.status);
      assert.equal(gate.gate?.action, 'clicked', JSON.stringify(gate.gate)); assert(gate.gate?.detail.includes('#gate'));
      assert(!fixture.requests.some(r => r.path === '/elsewhere'), 'followed the hidden link');
      assert(gateShot.size > 0); assert(!dom.includes('id="gate"'));
      assert((gate.passes[0].steps ?? 0) > 20, String(gate.passes[0].steps));
    });
    check('pages without a gate report none and do not wait for one', () => assert.equal(report.gate?.action, 'none', JSON.stringify(report.gate)));
  }
  check('a page whose own scroll animation throws (seen on a real site) is still captured', () => assert.equal(side.throwing.status, 'complete', side.throwing.status));
  {
    const wheel = side.wheel;
    const curves = await json<Curves>(join(wheel.out, 'motion', 'scroll-curves-390.json'));
    const shots = (await readdir(join(wheel.out, 'chromium-390', 'screenshots'))).filter(name => name.startsWith('step-'));
    const tour = await duration(join(wheel.out, 'video', 'tour-390.mp4'));
    check('a page that never scrolls is sampled with the wheel, stops when the page stops changing, and the tour video wheels through it', () => {
      assert.equal(wheel.status, 'complete', wheel.status);
      assert(curves.virtual && curves.virtual.extent > 0, JSON.stringify(curves.virtual));
      assert(curves.steps.length >= 6 && curves.steps.length < MAX_WHEEL_STEPS, String(curves.steps.length));
      assert.equal(shots.length, curves.steps.length);
      assert.equal(wheel.passes[0].virtualExtent, curves.virtual.extent);
      assert(tour > 4, String(tour));
    });
  }
  {
    const auto = side.auto;
    check('--widths auto finds the 768px and 64rem breakpoints and captures a layout at each', () => {
      assert(auto.breakpoints, 'no breakpoint report');
      assert(auto.breakpoints.found.some(b => b.px === 768 && b.kind === 'min')); assert(auto.breakpoints.found.some(b => b.px === 1024 && b.kind === 'min'));
      assert.deepEqual(auto.breakpoints.widths, [390, 768, 1024, 1440]);
      assert.deepEqual(auto.passes.map(p => p.width), [390, 768, 1024, 1440]);
    });
  }
  check('fixture receives all capture passes', () => assert(fixture.requests.filter(r => r.path === '/').length >= 4));
  check('consent: the reject button was clicked on every page load and accept never was', () => {
    assert.equal(report.consent?.action, 'rejected', JSON.stringify(report.consent)); assert(report.consent?.detail.includes('Reject non-essential'));
    assert(fixture.requests.filter(r => r.path === '/consent/reject').length >= fixture.requests.filter(r => r.path === '/').length - 2);
    assert(!fixture.requests.some(r => r.path === '/consent/accept'));
  });
  const dom1280 = await readFile(join(root, 'chromium-1280', 'dom.html'), 'utf8');
  check('consent: the dismissed banner is gone from the captured DOM', () => assert(!dom1280.includes('id="consent"')));
  {
    const captured = side.acceptOnly;
    check('consent: a banner with only "Accept" is hidden, never accepted', () => {
      assert.equal(captured.consent?.action, 'hidden', JSON.stringify(captured.consent));
      assert(!fixture.requests.some(r => r.path === '/consent/accept'));
    });
  }
  {
    const captured = side.fakeLenis;
    check('a lenis global without scrollTo (seen on a real site) does not break the capture', () => {
      assert.equal(captured.status, 'complete', captured.status); assert.equal(captured.passes.length, 1);
    });
  }
  {
    const captured = side.reloadOnReject;
    check('a site that reloads after "decline" (as some sites do) is waited out, not a crash', () => {
      assert.equal(captured.status, 'complete', captured.status);
      assert(captured.consent?.detail.includes('reloaded'), JSON.stringify(captured.consent));
    });
  }
  for (const endpoint of ['blocked', 'challenge']) {
    const captured = side.walls[endpoint];
    const dom = await readFile(join(captured.out, 'chromium-390', 'dom.html'), 'utf8');
    check(`local /${endpoint}: captures the returned page without an automatic stop`, () => {
      assert.equal(captured.status, 'complete'); assert.equal(captured.passes.length, 1);
      assert(dom.includes(endpoint === 'blocked' ? 'Access blocked' : 'Local bot-wall test'));
    });
  }
  const interrupted = await captureChild([fixture.url, '--widths', '390', '--no-video', '--no-hover', '--reason', 'fixture SIGINT'], true);
  const interruptedRoot = /\[site-lab\] output (.+)/.exec(interrupted.stdout)?.[1]; assert(interruptedRoot);
  const interruptedSummary = await readFile(join(interruptedRoot, 'SUMMARY.md'), 'utf8');
  const interruptedManifest = await json<Asset[]>(join(interruptedRoot, 'assets/manifest.json'));
  const interruptedCurves = await json<Curves>(join(interruptedRoot, 'motion/scroll-curves-390.json'));
  check('SIGINT saves completed steps and valid manifest, reports interrupted stage, exits 130', () => {
    assert.equal(interrupted.code, 130, interrupted.stderr); assert.equal(interrupted.signal, null);
    assert(interruptedSummary.includes('Status: interrupted')); assert(interruptedSummary.includes('Interrupted stage: motion'));
    assert(Array.isArray(interruptedManifest) && interruptedManifest.length > 0);
    assert(interruptedCurves.steps.length >= 25);
  });
  const hoverStop = await captureChild([fixture.url, '--widths', '390', '--no-video', '--reason', 'fixture hover SIGINT'], /hover chromium 390px start/);
  const hoverRoot = /\[site-lab\] output (.+)/.exec(hoverStop.stdout)?.[1]; assert(hoverRoot);
  const hoverSummary = await readFile(join(hoverRoot, 'SUMMARY.md'), 'utf8');
  const hoverJson = await json<unknown[]>(join(hoverRoot, 'chromium-390/hover.json'));
  check('SIGINT during hover exits 130 within 5s, reports the hover stage and keeps valid hover.json', () => {
    assert.equal(hoverStop.code, 130, hoverStop.stderr); assert(hoverStop.signalledAt !== undefined);
    assert(hoverStop.closedAt - hoverStop.signalledAt <= 5000, `took ${Math.round(hoverStop.closedAt - hoverStop.signalledAt)}ms`);
    assert(hoverSummary.includes('Status: interrupted')); assert(hoverSummary.includes('Interrupted stage: hover'));
    assert(Array.isArray(hoverJson) && hoverJson.length < 5);
  });
  const legacyRoot = await mkdtemp(resolve('captures/fixture-v1-'));
  const legacy: Asset[] = [];
  for (const [index, asset] of manifest.entries()) {
    if (!asset.path) continue;
    const oldPath = `assets/other/${index}-${basename(new URL(asset.url).pathname) || 'index'}`;
    await mkdir(dirname(join(legacyRoot, oldPath)), { recursive: true });
    await copyFile(join(root, asset.path), join(legacyRoot, oldPath));
    legacy.push({ url: asset.url, type: 'other', mime: asset.mime, status: asset.status, bytes: asset.bytes, sha256: asset.sha256, path: oldPath });
  }
  await writeJson(join(legacyRoot, 'assets/manifest.json'), legacy);
  const exec = promisify(execFile);
  await exec('npm', ['run', 'fix-names', '--', legacyRoot]);
  const fixed = await json<Asset[]>(join(legacyRoot, 'assets/manifest.json'));
  const firstManifest = await readFile(join(legacyRoot, 'assets/manifest.json'), 'utf8');
  const secondFix = await exec('npm', ['run', 'fix-names', '--', legacyRoot]);
  check('fix-names migrates a v1 capture and second run reports zero changes', () => {
    assert(fixed.filter(a => new URL(a.url).pathname === '/img/hero').every(a => a.path.startsWith('assets/image/') && a.path.endsWith('.webp')));
    assert.match(secondFix.stdout, /0 changes; 0 renamed, 0 moved/); assert.match(secondFix.stdout, /no changes/);
  });
  assert.equal(await readFile(join(legacyRoot, 'assets/manifest.json'), 'utf8'), firstManifest);
  console.log(`\nPASS ${checks} checks in ${((performance.now() - start) / 1000).toFixed(1)}s`);
  console.log(`Warnings (${report.warnings.length}): ${report.warnings.length ? report.warnings.join('\n') : 'none'}`);
  console.log(`Capture retained privately: ${root}`);
} finally { await fixture.close(); }
