import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BrowserContext, Page, Response as BrowserResponse } from 'playwright';
import { ResponseCollector } from '../lib/browser.js';
import { PNG } from 'pngjs';
import { runCompare } from '../compare.js';
import { parseCaptureArgs } from '../capture.js';
import { preflight, robotsAllows } from '../lib/preflight.js';
import { deriveEffects, encodeChanges, expandCurves } from '../lib/motion.js';
import { assetType, assetName, isPartial, MAX_ASSET_BYTES } from '../lib/assets.js';
import { scrollPositions, scrollStep, estimateRemaining } from '../lib/progress.js';
import { classifyAmbient, classifyIdle } from '../lib/sampling.js';
import { fixNames } from '../fix-names.js';
import { isRejectLabel } from '../lib/consent.js';
import { chooseWidths, mediaConditionsFromCss, parseMediaWidths } from '../lib/breakpoints.js';
import { bursts, summariseTimedChanges } from '../lib/timeline.js';
import { isGateLabel } from '../lib/gate.js';
import { acquireSlot } from '../lib/slots.js';
import { MOVED, STILL, visualChange } from '../lib/virtual.js';
import { writeJson, sha256 } from '../lib/util.js';
import { writeReport } from '../lib/report.js';
import type { Curves, SampleValue } from '../lib/types.js';
const exists = (path: string) => access(path).then(() => true, () => false);

let checks = 0;
function check(name: string, fn: () => void) { fn(); checks++; console.log(`PASS ${name}`); }
const state = (y: number, offset = 0): SampleValue => ({
  transform: `matrix(1, 0, 0, 1, ${Math.min(600, y / 2) + offset}, 0)`, translateX: Math.min(600, y / 2) + offset, translateY: y / 10,
  scaleX: 1, scaleY: 1, rotate: 0, opacity: 1, clipPath: 'none', filter: 'none', position: y >= 200 && y <= 1200 ? 'fixed' : 'relative',
  box: { x: Math.min(600, y / 2) + offset, y: y < 200 ? 200 - y : y <= 1200 ? 0 : 1200 - y, w: 100, h: 100 }
});
const curves = (offset = 0, step = 40): Curves => ({ width: 1280, maxScroll: 1600, paths: ['#panel'], steps: Array.from({ length: 1600 / step + 1 }, (_, i) => ({ y: i * step, frames: 4, stable: true, changes: { '#panel': state(i * step, offset) } })) });

check('robots groups, longest match, Allow tie, wildcards, anchors, URL escaping', () => {
  const rules = 'User-agent: Ignore\nDisallow: /\nUser-agent: *\nDisallow: /private*\nAllow: /private/public\nDisallow: /*.pdf$\nDisallow: /tie\nAllow: /tie\nUser-agent: *\nDisallow: /merged\nDisallow: /café\nDisallow: /%70rivate';
  for (const [path, allowed] of [['/', true], ['/private', false], ['/private/public/a', true], ['/a.pdf', false], ['/a.pdf?x', true], ['/tie', true], ['/merged', false], ['/caf%C3%A9', false]] as const) assert.equal(robotsAllows(rules, new URL(path, 'http://localhost')), allowed, path);
  assert(robotsAllows('User-agent: *\nDisallow:', new URL('http://localhost/')));
  assert(robotsAllows('User-agent: *\nCrawl-delay: 1\nUser-agent: Specific\nDisallow: /', new URL('http://localhost/')));
});
check('CLI defaults, optional reason, legacy flags and positive option validation', () => {
  const opts = parseCaptureArgs(['http://127.0.0.1/', '--reason', 'fixture', '--hide', '.one', '--hide', '.two']);
  assert.deepEqual(opts.widths, [390, 1440]); assert.deepEqual(opts.hide, ['.one', '.two']);
  assert.deepEqual(opts.engines, ['chromium']);
  assert.equal(opts.scrollStep, 'auto'); assert.equal(opts.settleMax, 800);
  assert.equal(parseCaptureArgs(['http://localhost/', '--scroll-step', '45', '--settle-max', '123']).scrollStep, 45);
  for (const value of ['0', '-2', 'NaN', '1.5']) assert.throws(() => parseCaptureArgs(['http://localhost/', '--settle-max', value]));
  assert.equal(parseCaptureArgs(['https://example.test/']).reason, 'Page study');
  assert.equal(parseCaptureArgs(['https://example.test/', '--reason', '   ']).reason, 'Page study');
  assert.doesNotThrow(() => parseCaptureArgs(['https://example.test/', '--terms-ok', '--robots-unknown-ok']));
  for (const args of [[], ['file:///tmp/a', '--reason', 'fixture'], ['http://localhost/', 'http://localhost/b', '--reason', 'fixture'], ['http://localhost/', '--reason', 'fixture', '--scroll-step', '0'], ['http://localhost/', '--reason', 'fixture', '--widths', '390,no'], ['http://localhost/', '--reason', 'fixture', '--engines', 'firefox']]) assert.throws(() => parseCaptureArgs(args));
});
check('delta expansion carries unchanged values without mutating previous samples', () => {
  const c = curves(); c.steps[1].changes = {};
  const result = expandCurves(c);
  assert.equal(result[1].values['#panel'].translateX, 0);
  assert.equal(result[2].values['#panel'].translateX, 40);
  assert.equal(result[0].values['#panel'].translateX, 0);
});
check('motion derives 1000px pin plateau, monotonic segments, linear shape and parallax', () => {
  const data = deriveEffects(curves());
  const pin = data.pinned.find(e => e.path === '#panel'); assert(pin); assert.equal(pin.end - pin.start, 1000);
  const x = data.effects.find(e => e.property === 'translateX'); assert(x); assert.equal(x.from, 0); assert.equal(x.to, 600); assert.equal(x.shape, 'linear'); assert.equal(x.error, 0);
  assert(data.effects.some(e => e.property === 'translateY'));
});
check('easing estimation selects power3.out with zero fit error', () => {
  const c = curves();
  for (const step of c.steps) step.changes['#panel'].opacity = 1 - (1 - step.y / 1600) ** 4;
  const effect = deriveEffects(c).effects.find(e => e.property === 'opacity');
  assert(effect); assert.equal(effect.ease, 'power3.out'); assert(effect.error < 1e-12);
});
check('delta encoding stores only changed properties and box coordinates', () => {
  const previous = { '#panel': state(0) }; const current = { '#panel': state(40) };
  const delta = encodeChanges(previous, current);
  assert.equal(delta['#panel'].opacity, undefined); assert.equal(delta['#panel'].box?.w, undefined);
  assert.equal(delta['#panel'].box?.y, 160);
  assert.deepEqual(expandCurves({ width: 1280, maxScroll: 40, paths: ['#panel'], steps: [{ y: 0, frames: 4, stable: true, changes: previous }, { y: 40, frames: 4, stable: true, changes: delta }] })[1].values, current);
});
check('clip-path and filter numeric components receive measured easing segments', () => {
  const c = curves();
  for (const step of c.steps) { step.changes['#panel'].clipPath = `inset(${100 - step.y / 16}% 0px)`; step.changes['#panel'].filter = `blur(${step.y / 160}px)`; }
  const effects = deriveEffects(c).effects;
  assert(effects.some(e => e.property === 'clipPath[0]' && e.from === 100 && e.to === 0 && e.shape === 'linear'));
  assert(effects.some(e => e.property === 'filter[0]' && e.from === 0 && e.to === 10 && e.shape === 'linear'));
});

check('sniffing table: binary signatures override conflicting headers and URL extensions', () => {
  const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from(`ftyp${brand}`), Buffer.alloc(4), Buffer.from('isom')]);
  const table: [Buffer, string, string][] = [
    [Buffer.from('RIFF1234WEBPdata'), 'image/webp', 'webp'],
    [ftyp('avif'), 'image/avif', 'avif'], [ftyp('avis'), 'image/avif', 'avif'],
    [ftyp('isom'), 'video/mp4', 'mp4'], [ftyp('qt  '), 'video/quicktime', 'mov'],
    [Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 'video/webm', 'webm'],
    [Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('matroska')]), 'video/x-matroska', 'mkv'],
    [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png', 'png'],
    [Buffer.from([255, 216, 255, 224]), 'image/jpeg', 'jpg'],
    [Buffer.from('GIF89atest'), 'image/gif', 'gif'], [Buffer.from('GIF87atest'), 'image/gif', 'gif'],
    [Buffer.from('wOF2font'), 'font/woff2', 'woff2'], [Buffer.from('wOFFfont'), 'font/woff', 'woff'],
    [Buffer.from([0, 1, 0, 0]), 'font/ttf', 'ttf'], [Buffer.from('truefont'), 'font/ttf', 'ttf'], [Buffer.from('OTTOfont'), 'font/otf', 'otf'],
    [Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml', 'svg']
  ];
  for (const [body, mime, ext] of table) for (const header of ['application/octet-stream', 'text/html; charset=UTF-8', 'image/jpeg']) {
    const real = assetType(body, header);
    assert.equal(real.mime, mime); assert.equal(real.sniffedMime, mime); assert.equal(real.ext, ext);
    assert.equal(real.headerMime, header.split(';')[0]);
    assert(assetName('https://example.test/wrong.css', 'a'.repeat(64), real.ext).endsWith(`-wrong.${ext}`));
  }
  const compatible = ftyp('mif1'); compatible.write('avif', 16); assert.equal(assetType(compatible, '').ext, 'avif');
});
check('text types require matching headers and textual content; unknown bytes stay unknown', () => {
  for (const [header, ext, type] of [['application/json; charset=utf-8', 'json', 'fetch'], ['application/ld+json', 'json', 'fetch'], ['application/javascript', 'js', 'script'], ['text/javascript', 'js', 'script'], ['text/css', 'css', 'stylesheet'], ['text/html', 'html', 'document']]) {
    const real = assetType(Buffer.from('text café'), header);
    assert.equal(real.ext, ext); assert.equal(real.type, type); assert.equal(real.sniffedMime, null);
    assert.equal(assetType(Buffer.from([0, 255, 2]), header).ext, 'bin');
  }
  assert.equal(assetType(Buffer.from('{"json":true}'), 'application/octet-stream').ext, 'bin');
  assert.equal(assetType(Buffer.from([1, 2, 3]), '').type, 'other');
  assert.equal(assetType(Buffer.from('<svg>text</svg>'), 'text/html').type, 'image');
});
check('asset names: 16-char hash, sanitising, length cap, fallback and no double extension', () => {
  const hash = 'abcdef0123456789'.repeat(4);
  assert.equal(assetName('https://example.test/a%20b.jpg.webp?x=1', hash, 'avif'), 'abcdef0123456789-a_b.avif');
  assert.equal(assetName('https://example.test/', hash, 'png'), 'abcdef0123456789-asset.png');
  assert.equal(assetName('https://example.test/folder/', hash, 'png'), 'abcdef0123456789-asset.png');
  assert.equal(assetName('https://example.test/.png', hash, 'png'), 'abcdef0123456789-asset.png');
  const name = assetName(`https://example.test/${'x'.repeat(300)}.jpg`, hash, 'woff2');
  assert.equal(name.length, 120); assert.equal(name.split('.').length, 2);
  assert.match(assetName('https://example.test/a%2Fb%3Ac.png', hash, 'png'), /^[a-z0-9_-]+\.png$/);
});
check('partial detection covers status, range and short length; cap is 200 MB', () => {
  assert(isPartial(206, {}, 10)); assert(isPartial(200, { 'content-range': 'bytes 0-9/20' }, 10));
  assert(isPartial(200, { 'content-length': '20' }, 10)); assert(!isPartial(200, { 'content-length': '10' }, 10));
  assert(!isPartial(200, {}, 10)); assert.equal(MAX_ASSET_BYTES, 200 * 1024 * 1024);
});
check('auto steps: minimum 40px, ceil(maxScroll/150), explicit override, endpoint once', () => {
  for (const max of [0, 1, 39, 40, 6000, 6001, 15345, 100000]) {
    assert.equal(scrollStep(max, 'auto'), Math.max(40, Math.ceil(max / 150)));
    const positions = scrollPositions(max, 'auto'); assert(positions.length <= 151);
    assert.equal(positions[0], 0); assert.equal(positions.at(-1), max); assert.equal(new Set(positions).size, positions.length);
  }
  assert.deepEqual(scrollPositions(95, 40), [0, 40, 80, 95]); assert.equal(scrollStep(20000, 10), 10);
});
check('ETA uses only the last 20 durations and remaining steps', () => {
  assert.equal(estimateRemaining([], 100), 0); assert.equal(estimateRemaining([100, 300], 10), 2000);
  assert.equal(estimateRemaining([99999, ...Array.from({ length: 20 }, (_, i) => (i + 1) * 10)], 3), 315);
  assert.equal(estimateRemaining([500], 0), 0); assert.equal(estimateRemaining([500], -1), 0);
});
check('ambient classification: idle changes, forced media/descendants, new samples and stationary elements', () => {
  const samples = [{ still: state(0), moving: state(0) }, { still: state(0), moving: state(40), revealed: state(0) }, { still: state(0), moving: state(0), revealed: state(40) }];
  assert.deepEqual(classifyAmbient(samples, ['video', 'video-child', 'infinite']), ['video', 'video-child', 'infinite', 'moving', 'revealed']);
  assert.deepEqual(classifyAmbient([{ new: 1 }]), []);
  check('unlisted text types such as text/x-component are saved as .txt', () => {
    const rsc = assetType(Buffer.from('1:"$Sreact.fragment"'), 'text/x-component');
    assert.equal(rsc.ext, 'txt'); assert.equal(rsc.type, 'fetch'); assert.equal(rsc.mime, 'text/x-component');
    assert.equal(assetType(Buffer.from([0, 1, 2, 3]), 'text/x-component').ext, 'bin');
  });
  check('consent labels: refusals match, anything that accepts everything never does', () => {
    for (const label of ['Reject non-essential', 'Decline all', 'DECLINE ALL', 'Reject all', 'Deny', 'Necessary only', 'Only necessary cookies', 'Accept only essential cookies', 'Allow necessary cookies only', 'Continue without accepting', 'Opt out'])
      assert.equal(isRejectLabel(label), true, label);
    for (const label of ['Accept all', 'Accept', 'Allow all cookies', 'I agree', 'OK', 'Got it', 'Customize', 'Cookie settings', 'Accept all necessary and optional', 'Privacy policy', ''])
      assert.equal(isRejectLabel(label), false, label);
  });
  check('media queries: min/max-width and range syntax, in px and rem', () => {
    assert.deepEqual(parseMediaWidths('(min-width: 768px)'), [{ px: 768, kind: 'min' }]);
    assert.deepEqual(parseMediaWidths('(max-width: 47.9375rem)'), [{ px: 767, kind: 'max' }]);
    assert.deepEqual(parseMediaWidths('(width >= 64rem)'), [{ px: 1024, kind: 'min' }]);
    assert.deepEqual(parseMediaWidths('(width < 40rem)'), [{ px: 639, kind: 'max' }]);
    assert.deepEqual(parseMediaWidths('(48rem <= width)'), [{ px: 768, kind: 'min' }]);
    assert.deepEqual(parseMediaWidths('(prefers-reduced-motion: reduce)'), []);
    assert.deepEqual(parseMediaWidths('(min-width: 40em)', 10), [{ px: 400, kind: 'min' }]);
  });
  check('widths: base plus each breakpoint, clamped, near-duplicates merged, most-used first under the cap', () => {
    assert.deepEqual(chooseWidths([{ px: 768, kind: 'min', count: 3 }, { px: 767, kind: 'max', count: 1 }, { px: 1024, kind: 'min', count: 9 }, { px: 1440, kind: 'min', count: 2 }, { px: 2560, kind: 'min', count: 5 }]), [390, 768, 1024, 1440]);
    assert.deepEqual(chooseWidths([{ px: 400, kind: 'min', count: 1 }]), [390, 1440]);
    assert.equal(chooseWidths(Array.from({ length: 20 }, (_, i) => ({ px: 420 + i * 60, kind: 'min' as const, count: 20 - i }))).length, 8);
  });
  check('timed changes: rotating text becomes one cycling entry with its period; loops are flagged continuous', () => {
    const phrases = ['A', 'B', 'C'];
    const rotating = Array.from({ length: 7 }, (_, i) => ({ t: i * 1000, path: '#rotator', kind: 'content', value: phrases[i % 3], scrollY: 0 }));
    const loop = Array.from({ length: 200 }, (_, i) => ({ t: i * 20, path: '#spinner', kind: 'class', value: String(i % 2), scrollY: 0 }));
    const once = [{ t: 0, path: '#static', kind: 'content', value: 'same', scrollY: 0 }, { t: 500, path: '#static', kind: 'content', value: 'same', scrollY: 0 }];
    const summary = summariseTimedChanges([...rotating, ...loop, ...once], 4000);
    const rotator = summary.find(c => c.path === '#rotator'); assert(rotator);
    assert.deepEqual(rotator.values, ['A', 'B', 'C']); assert.equal(rotator.medianIntervalMs, 1000); assert(rotator.cycles); assert(!rotator.continuous);
    assert(summary.find(c => c.path === '#spinner')?.continuous);
    assert(!summary.some(c => c.path === '#static'));
    assert.equal(summary[0].path, '#rotator');
  });
  check('idle split: own style changes are ambient; box-only movement means carried by something ambient', () => {
    const box = (x: number) => ({ x, y: 0, w: 10, h: 10 });
    const idle = classifyIdle([
      { marquee: { transform: 'matrix(1, 0, 0, 1, 0, 0)', box: box(0) }, child: { transform: 'none', box: box(5) }, still: { opacity: 1, box: box(9) } },
      { marquee: { transform: 'matrix(1, 0, 0, 1, -3, 0)', box: box(-3) }, child: { transform: 'none', box: box(2) }, still: { opacity: 1, box: box(9) } },
    ]);
    assert.deepEqual(idle, { own: ['marquee'], moved: ['child'] });
  });
  check('deriveEffects keeps effects inside a looping animation (flagged) and drops the looping element itself', () => {
    const value = (y: number): SampleValue => ({ transform: '', translateX: 0, translateY: y, scaleX: 1, scaleY: 1, rotate: 0, opacity: 1, clipPath: 'none', filter: 'none', box: { x: 0, y: 0, w: 10, h: 10 }, position: 'static' });
    const steps = [0, 40, 80, 120].map(y => ({ y, frames: 1, stable: true, changes: { '#loop': value(y), '#inside': value(-y) } }));
    const derived = deriveEffects({ width: 1280, maxScroll: 120, paths: ['#loop', '#inside'], steps, elements: [{ path: '#loop', ambient: true, ambientAncestor: false }, { path: '#inside', ambient: false, ambientAncestor: true }] });
    assert(!derived.effects.some(e => e.path === '#loop'));
    const inside = derived.effects.filter(e => e.path === '#inside' && e.property === 'translateY');
    assert(inside.length && inside.every(e => e.insideAmbient === true));
  });
  const c = curves(); c.elements = [{ path: '#panel', ambient: true }];
  const effects = deriveEffects(c); assert.equal(effects.effects.length, 0); assert.equal(effects.pinned.length, 0);
  assert.deepEqual(effects.elements, c.elements); assert.equal(expandCurves(c).length, c.steps.length);
});

check('cross-origin CSS text: @media and @import media lists, ignoring comments', () => {
  assert.deepEqual(mediaConditionsFromCss('a{} /* @media (min-width: 5000px) */ @media (min-width: 900px) { a{} } @media screen and (max-width:47.9375rem){a{}} @import url("x.css") (min-width: 1200px); @import "y.css";'),
    ['(min-width: 900px)', 'screen and (max-width:47.9375rem)', '(min-width: 1200px)']);
});
check('visual change: identical screens are still, a different screen counts as moving on', () => {
  const grey = new Uint8Array(64 * 40 * 3).fill(128); const slightly = grey.map((v, i) => i % 50 === 0 ? v + 40 : v); const other = grey.map((_, i) => i % 3 === 0 ? 240 : 30);
  assert.equal(visualChange(grey, grey), 0); assert(visualChange(grey, slightly) < STILL); assert(visualChange(grey, other) >= MOVED); assert.equal(visualChange(grey, new Uint8Array(3)), 1);
});
check('entry gate labels: enter/explore/skip intro variants; never consent, navigation or age answers', () => {
  for (const label of ['ENTER', 'Enter site →', 'enter the experience', 'Click to enter', 'Skip intro', 'EXPLORE', 'Enter with sound', 'Sound off']) assert(isGateLabel(label), label);
  for (const label of ['Accept all', 'Continue', 'Enter your email', 'Menu', 'I am over 18', 'Yes', 'Enter the competition today and win']) assert(!isGateLabel(label), label);
});
check('timeline: per-frame style bursts become settled values; turns give the phrases in order with their period; a marquee is not a rotator', () => {
  assert.deepEqual(bursts([0, 16, 32, 600, 616, 1500].map(t => ({ t }))).map(b => b.length), [3, 2, 1]);
  const style: { t: number; path: string; kind: string; value: string; scrollY: number }[] = [];
  for (let cycle = 0; cycle < 4; cycle++) for (let f = 0; f <= 18; f++) style.push({ t: cycle * 1200 + f * 16, path: '#badge', kind: 'style', value: `opacity: ${f === 18 ? cycle % 2 : 0.5}`, scrollY: 0 });
  const loop = Array.from({ length: 250 }, (_, i) => ({ t: i * 16, path: '#marquee', kind: 'style', value: `transform: translateX(-${i}px)`, scrollY: 0 }));
  const turns = [
    { t: 0, group: '#stack', index: 0, text: 'One', initial: true, scrollY: 0 },
    ...[1, 2, 3, 0, 1].map((index, i) => ({ t: 1200 * (i + 1), group: '#stack', index, text: ['One', 'Two', 'Three', 'Four'][index], initial: false, scrollY: 0 })),
    ...[1, 2, 3].map(i => ({ t: i * 300, group: '#logos', index: i, text: `Logo ${i}`, initial: false, scrollY: 0 }))
  ];
  const stats = [{ group: '#stack', scrollY: 0, ticks: 60, moving: 12, maxShown: 2 }, { group: '#logos', scrollY: 0, ticks: 60, moving: 60, maxShown: 6 }];
  const memberStyle = [0, 16, 32].map(t => ({ t, path: '#stack > p:nth-of-type(1)', kind: 'style', value: `transform: translateY(-${t}%)`, scrollY: 0 }));
  // Noise seen on real sites: one scrub catch-up per position, and members revealed together.
  const settle = [0, 900].flatMap(scrollY => [0, 16, 32].map(t => ({ t, path: '#heading', kind: 'style', value: `transform: translateY(${scrollY + t}px)`, scrollY })));
  turns.push(...[1, 2].map(index => ({ t: 400, group: '#reveal', index, text: `Card ${index}`, initial: false, scrollY: 0 })), { t: 0, group: '#reveal', index: 0, text: 'Card 0', initial: true, scrollY: 0 });
  const summary = summariseTimedChanges([...style, ...loop, ...memberStyle, ...settle], 4000, turns, stats);
  assert(!summary.some(c => c.path === '#heading'), 'scroll catch-up listed'); assert(!summary.some(c => c.path === '#reveal'), 'reveal listed as turns');
  const stack = summary.find(c => c.path === '#stack'); assert(stack, JSON.stringify(summary));
  assert.deepEqual(stack.values, ['One', 'Two', 'Three', 'Four']); assert.equal(stack.kind, 'turns'); assert.equal(stack.medianIntervalMs, 1200); assert(stack.cycles);
  assert(!summary.some(c => c.path === '#logos'), 'marquee listed as turns');
  assert(!summary.some(c => c.path.startsWith('#stack > ')), 'members repeated');
  const badge = summary.find(c => c.path === '#badge'); assert(badge && !badge.continuous && badge.medianIntervalMs === 1200, JSON.stringify(badge));
  assert.deepEqual(badge.values, ['opacity: 0', 'opacity: 1']);
  assert(summary.find(c => c.path === '#marquee')?.continuous);
  assert.equal(summary[0].path, '#stack');
});
{
  const previous = { dir: process.env.SITE_LAB_SLOT_DIR, slots: process.env.SITE_LAB_SLOTS };
  const slotDir = await mkdtemp(resolve('.test-slots-'));
  process.env.SITE_LAB_SLOT_DIR = slotDir; process.env.SITE_LAB_SLOTS = '2';
  try {
    await writeFile(join(slotDir, 'slot-0.lock'), '999999\nexited capture\n');
    const first = await acquireSlot('first'); const second = await acquireSlot('second');
    let third = false; const waiting = acquireSlot('third').then(release => { third = true; return release; });
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert(!third, 'a third stage ran while both slots were taken');
    await first(); const release = await waiting; assert(third);
    await second(); await release();
    checks++; console.log('PASS timing slots: two at once across captures, the third waits, slots left by exited processes are reclaimed');
  } finally {
    await rm(slotDir, { recursive: true, force: true });
    if (previous.dir === undefined) delete process.env.SITE_LAB_SLOT_DIR; else process.env.SITE_LAB_SLOT_DIR = previous.dir;
    if (previous.slots === undefined) delete process.env.SITE_LAB_SLOTS; else process.env.SITE_LAB_SLOTS = previous.slots;
  }
}

// Exercise arbitrary output directories, using only synthetic local test data.
const root = await mkdtemp(resolve('.test-unit-'));
try {
  const legacy = join(root, 'legacy'); await mkdir(join(legacy, 'assets/other'), { recursive: true });
  const webp = Buffer.from('RIFF1234WEBPbody'); const hash = sha256(webp);
  await writeFile(join(legacy, 'assets/other/hero.jpg'), webp);
  await writeFile(join(legacy, 'assets/other/copy.jpg'), webp);
  await writeJson(join(legacy, 'assets/manifest.json'), ['hero.jpg', 'copy.jpg'].map(name => ({ url: `https://example.test/${name}`, type: 'other', mime: 'image/jpeg', status: 200, bytes: webp.length, sha256: hash, path: `assets/other/${name}` })));
  const migrated = await fixNames(legacy);
  const first = await readFile(join(legacy, 'assets/manifest.json'), 'utf8');
  const entries = JSON.parse(first) as { path: string; ext: string }[];
  const againFixed = await fixNames(legacy);
  check('fix-names moves real types, deduplicates paths, preserves duplicate files and is byte-idempotent', () => {
    assert.equal(migrated.changes, 2); assert.equal(migrated.moved, 2); assert.equal(againFixed.changes, 0);
    assert.equal(entries[0].path, entries[1].path); assert(entries[0].path.endsWith('.webp')); assert(entries[0].path.startsWith('assets/image/'));
  });
  assert.equal(await readFile(join(legacy, 'assets/manifest.json'), 'utf8'), first);
  assert.deepEqual(await readFile(join(legacy, entries[0].path)), webp);
  assert.deepEqual(await readFile(join(legacy, 'assets/other/copy.jpg')), webp);
  const collectedDir = join(root, 'collector'); const collectorWarnings: string[] = [];
  const collector = new ResponseCollector(collectedDir, true, collectorWarnings);
  const partial = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]); const complete = Buffer.concat([partial, Buffer.from('webm complete video')]);
  let active = 0; let peakActive = 0; const gets: string[] = [];
  const context = { request: {
    head: async (url: string) => ({ headers: () => ({ 'content-length': String(url.endsWith('/oversize') ? MAX_ASSET_BYTES + 1 : complete.length) }), dispose: async () => {} }),
    get: async (url: string) => {
      gets.push(url); active++; peakActive = Math.max(peakActive, active);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      const failed = url.endsWith('/failure');
      return { ok: () => true, status: () => failed ? 206 : 200,
        headers: () => ({ 'content-type': 'video/webm', 'content-length': String(complete.length) }),
        body: async () => complete, dispose: async () => {} };
    }
  } } as unknown as BrowserContext;
  let responseListener: ((response: BrowserResponse) => void) | undefined;
  collector.attach({ on: (_event: string, listener: (response: BrowserResponse) => void) => { responseListener = listener; }, context: () => context } as unknown as Page);
  const emit = (path: string, body: Buffer, status: number) => {
    if (!responseListener) throw new Error('Collector did not subscribe to responses');
    responseListener({ url: () => `https://example.test/${path}`, body: async () => body, status: () => status,
      headers: () => ({ 'content-type': 'application/octet-stream', 'content-length': String(body.length), ...(status === 206 ? { 'content-range': `bytes 0-${body.length - 1}/${complete.length}` } : {}) }),
      request: () => ({ resourceType: () => 'fetch' }) } as unknown as BrowserResponse);
  };
  emit('one', partial, 206); emit('two', partial, 206); emit('failure', partial, 206); emit('oversize', partial, 206);
  emit('hero', webp, 200); emit('hero-copy.jpg', webp, 200);
  await collector.finishPass(context);
  await collector.finishPass(context);
  check('collector refetches sequentially once with the page context and preserves partial provenance', () => {
    assert.equal(peakActive, 1); assert.deepEqual(gets, ['https://example.test/one', 'https://example.test/two', 'https://example.test/failure']);
    for (const path of ['one', 'two']) {
      const entry = collector.assets.find(a => a.url.endsWith(`/${path}`)); assert(entry);
      assert.equal(entry.partial, true); assert.equal(entry.status, 206); assert(entry.contentRange);
      assert.equal(entry.refetched, true); assert.equal(entry.sha256, sha256(complete)); assert(entry.path.endsWith('.webm'));
    }
  });
  check('collector keeps partials and warnings on failed or oversized full responses', () => {
    for (const path of ['failure', 'oversize']) {
      const entry = collector.assets.find(a => a.url.endsWith(`/${path}`)); assert(entry);
      assert(entry.refetched && entry.refetchError); assert.equal(entry.sha256, sha256(partial));
    }
    assert.equal(collectorWarnings.length, 2);
  });
  check('collector saves identical hashes once, ignores request type and writes valid manifest JSON', () => {
    for (const asset of collector.assets) assert(collector.assets.filter(a => a.sha256 === asset.sha256).every(a => a.path === asset.path));
    assert(collector.assets.filter(a => a.url.includes('hero')).every(a => a.type === 'image' && a.path.startsWith('assets/image/') && a.ext === 'webp'));
  });
  const collected = JSON.parse(await readFile(join(collectedDir, 'assets/manifest.json'), 'utf8')) as { path: string; sha256: string }[];
  assert.equal(collected.length, 6);
  const chunkedDir = join(root, 'chunked'); const chunkedWarnings: string[] = [];
  const chunked = new ResponseCollector(chunkedDir, true, chunkedWarnings);
  const full = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('a complete chunked video')]);
  const chunkGets: string[] = [];
  const chunkContext = { request: {
    head: async () => ({ headers: () => ({ 'content-length': String(full.length) }), dispose: async () => {} }),
    get: async (url: string) => {
      chunkGets.push(url); const stuck = url.endsWith('/stuck');
      return { ok: () => true, status: () => stuck ? 206 : 200, headers: () => ({ 'content-type': 'video/webm', 'content-length': String(full.length) }), body: async () => full, dispose: async () => {} };
    }
  } } as unknown as BrowserContext;
  let chunkListener: ((response: BrowserResponse) => void) | undefined;
  chunked.attach({ on: (_event: string, listener: (response: BrowserResponse) => void) => { chunkListener = listener; }, context: () => chunkContext } as unknown as Page);
  const chunk = (path: string, from: number, to: number) => {
    if (!chunkListener) throw new Error('Collector did not subscribe to responses');
    const body = full.subarray(from, to);
    chunkListener({ url: () => `https://example.test/${path}`, body: async () => body, status: () => 206,
      headers: () => ({ 'content-type': 'video/mp4', 'content-length': String(body.length), 'content-range': `bytes ${from}-${to - 1}/${full.length}` }),
      request: () => ({ resourceType: () => 'media' }) } as unknown as BrowserResponse);
  };
  chunk('video', 0, 6); chunk('video', 6, 14); chunk('video', 14, full.length); chunk('stuck', 0, 5);
  await chunked.finishPass(chunkContext);
  const videoEntries = chunked.assets.filter(a => a.url.endsWith('/video'));
  check('three range chunks of one URL cause exactly one full download shared by all entries', () => {
    assert.deepEqual(chunkGets.filter(url => url.endsWith('/video')), ['https://example.test/video']);
    assert.equal(videoEntries.length, 3);
    assert(videoEntries.every(a => a.refetched && a.path === videoEntries[0].path && a.sha256 === sha256(full) && a.path.endsWith('.webm')));
  });
  const stuckEntry = chunked.assets.find(a => a.url.endsWith('/stuck')); assert(stuckEntry);
  const removals = chunkedWarnings.filter(w => w.startsWith('Removed partial body'));
  const chunkFiles = [[0, 6], [6, 14], [14, full.length]].map(([from, to]) => {
    const body = full.subarray(from, to); const real = assetType(body, 'video/mp4');
    return join(chunkedDir, 'assets', real.type, assetName('https://example.test/video', sha256(body), real.ext));
  });
  const superseded = await Promise.all(chunkFiles.map(exists));
  const stuckKept = await exists(join(chunkedDir, stuckEntry.path));
  check('superseded partial bodies are deleted; a partial still referenced is kept', () => {
    assert.equal(removals.length, 3); assert(superseded.every(present => !present));
    assert(removals.every(warning => chunkFiles.some(file => file.endsWith(warning.split(' ')[3]))), 'removal warnings name the chunk files');
    assert(stuckEntry.refetchError); assert(stuckKept);
  });
  for (const asset of collected) assert.equal(sha256(await readFile(join(collectedDir, asset.path))), asset.sha256);
  const a = join(root, 'a'); const b = join(root, 'b');
  for (const dir of [a, b]) {
    await mkdir(join(dir, 'chromium-1280/screenshots'), { recursive: true });
    const png = new PNG({ width: dir === a ? 10 : 12, height: 10 }); png.data.fill(255);
    if (dir === b) for (let y = 0; y < 10; y++) for (let x = 0; x < 5; x++) { const i = (y * png.width + x) * 4; png.data[i] = 0; png.data[i + 1] = 0; png.data[i + 2] = 0; }
    await writeFile(join(dir, 'chromium-1280/screenshots/full.png'), PNG.sync.write(png));
    const c = curves(dir === a ? 0 : 10, dir === a ? 40 : 80);
    await writeJson(join(dir, 'motion/scroll-curves-1280.json'), c);
    await writeJson(join(dir, 'motion/effects-1280.json'), deriveEffects(c));
  }
  const compared = await runCompare(a, b, { map: { '#panel': '#panel' } });
  check('pixel comparison crops to common size and measures 50% changed pixels', () => {
    assert.equal(compared.images.length, 1); assert.equal(compared.images[0].mismatchPercent, 50);
    assert.equal(compared.images[0].width, 10); assert(compared.images[0].sizeDifference);
  });
  check('mapped motion interpolates unequal grids; RMS and maximum error are 10px', () => {
    const x = compared.motion.find(m => m.property === 'translateX'); assert(x);
    assert.equal(x.rms, 10); assert.equal(x.maxError, 10); assert.equal(x.samples, 41); assert(!x.approximate);
  });
  const self = await runCompare(a, a);
  check('self-comparison produces zero pixel and motion errors; no-map result approximate', () => {
    assert(self.images.every(i => i.mismatchPercent === 0)); assert(self.motion.length);
    assert(self.motion.every(m => m.rms === 0 && m.maxError === 0 && m.approximate));
  });
  check('comparison accepts capture directories outside captures and rebuilds', () => assert.equal(compared.out, join(b, 'compare')));
  const options = parseCaptureArgs(['http://localhost/', '--reason', 'offline local preflight', '--out', join(root, 'preflight')]);
  const pre = await preflight(options); const again = await preflight(options);
  check('local preflight skips robots/terms, records provenance and never overwrites', () => {
    assert.equal(pre.robots, 'allowed'); assert.equal(again.out, `${pre.out}-2`);
  });
  assert((await readFile(join(pre.out, 'SOURCE.md'), 'utf8')).includes('offline local preflight'));
  check('custom output outside captures records a warning', () => {
    assert.equal(pre.out, join(root, 'preflight'));
    assert(pre.warnings.some(warning => /output|outside|custom/i.test(warning)));
  });
  const originalSource = await readFile(join(pre.out, 'SOURCE.md'), 'utf8');
  await writeFile(join(pre.out, 'keep.txt'), 'existing data');
  const third = await preflight(options);
  check('output collisions preserve every existing file', () => assert.equal(third.out, `${pre.out}-3`));
  assert.equal(await readFile(join(pre.out, 'SOURCE.md'), 'utf8'), originalSource);
  assert.equal(await readFile(join(pre.out, 'keep.txt'), 'utf8'), 'existing data');
  await rm(`${pre.out}-2`, { recursive: true });
  const fourth = await preflight(options);
  check('a freed capture name is never reused: the newest capture always has the highest number', () => assert.equal(fourth.out, `${pre.out}-4`));
  const link = join(root, 'existing-output-link'); await symlink(a, link);
  try {
    // Existing output symlinks are treated as occupied, never followed or overwritten.
    const redirected = await preflight({ ...options, out: link });
    check('existing output symlink is never followed', () => assert.equal(redirected.out, `${link}-2`));
  } finally { await rm(link); }
  const parentLink = join(root, 'parent-link'); await symlink(a, parentLink);
  const canonical = await preflight({ ...options, out: join(parentLink, 'new-capture') });
  check('custom output resolves an ancestor symlink to its canonical directory', () => assert.equal(canonical.out, join(a, 'new-capture')));
  const guard = join(root, 'comparison-guard'); await mkdir(guard);
  await symlink(a, join(guard, 'compare'));
  await assert.rejects(runCompare(a, guard), /symlink/i); checks++; console.log('PASS comparison does not overwrite through an output symlink');

  const originalFetch = globalThis.fetch;
  try {
    for (const scenario of ['disallowed', 'unknown', 'missing', 'http403', 'http429', 'legacy-flags'] as const) {
      let calls = 0;
      globalThis.fetch = async input => {
        assert.equal(String(input), 'https://example.test/robots.txt'); calls++;
        if (scenario === 'unknown') throw new Error('offline robots failure');
        if (scenario === 'missing') return new Response('', { status: 404 });
        if (scenario === 'http403') return new Response('', { status: 403 });
        if (scenario === 'http429') return new Response('', { status: 429 });
        return new Response('User-agent: *\nDisallow: /', { status: 200 });
      };
      const publicOptions = parseCaptureArgs(['https://example.test/', '--out', join(root, `public-${scenario}`), ...(scenario === 'legacy-flags' ? ['--terms-ok', '--robots-unknown-ok'] : [])]);
      const publicPre = await preflight(publicOptions);
      const provenance = await readFile(join(publicPre.out, 'SOURCE.md'), 'utf8');
      check(`public preflight ${scenario}: proceeds without approval and records facts`, () => {
        assert.equal(calls, 1);
        assert.equal(publicPre.robots, ['unknown', 'http403', 'http429'].includes(scenario) ? 'unknown' : scenario === 'missing' ? 'missing' : 'disallowed');
        assert.match(publicPre.terms, /unverified|not (?:checked|verified)/i);
        assert(!/operator confirms terms allow automation|Terms confirmed/i.test(provenance));
        assert(provenance.includes('Reason: Page study'));
        if (scenario !== 'missing') assert(publicPre.warnings.some(warning => /robots/i.test(warning)));
      });
    }
  } finally { globalThis.fetch = originalFetch; }
  await writeReport({ url: 'http://localhost/', out: root, ethics: 'local', status: 'offline test', assets: [], libraries: [], passes: [], warnings: Array.from({ length: 100 }, (_, i) => `Warning ${i}`) });
  const summary = await readFile(join(root, 'SUMMARY.md'), 'utf8');
  const summaryData = JSON.parse(await readFile(join(root, 'summary.json'), 'utf8'));
  check('summary stays under 150 lines and retains complete warnings in JSON', () => {
    assert(summary.trimEnd().split('\n').length < 150); assert.equal(summaryData.warnings.length, 100);
  });
  console.log(`\nPASS ${checks} offline checks`);
} finally { await rm(root, { recursive: true, force: true }); }
