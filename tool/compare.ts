import { parseArgs } from 'node:util';
import { readFile, readdir, mkdir, writeFile, realpath, lstat, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import type { Curves, Effects } from './lib/types.js';
import { expandCurves, numericProperties } from './lib/motion.js';
import { errorMessage, isMain, writeJson } from './lib/util.js';

interface ImageResult {
  pass: string; image: string; width: number; height: number;
  sizeA: { width: number; height: number }; sizeB: { width: number; height: number };
  sizeDifference: boolean; mismatchPixels: number; mismatchPercent: number;
}
interface MotionResult {
  width: string; pathA: string; pathB: string; property: string; rms: number; maxError: number;
  samples: number; approximate: boolean; metric: string;
}
export interface Comparison { images: ImageResult[]; motion: MotionResult[]; approximate: boolean; warnings: string[]; out: string }
async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T; }
async function files(path: string) { try { return await readdir(path); } catch { return []; } }
async function captureRoot(path: string) {
  const target = await realpath(resolve(path));
  if (!(await stat(target)).isDirectory()) throw new Error(`Compare input must be a directory: ${path}`);
  return target;
}
const rms = (errors: number[]) => Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length);
async function noSymlink(file: string) {
  try { if ((await lstat(file)).isSymbolicLink()) throw new Error(`Comparison output cannot be a symlink: ${file}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function runCompare(a: string, b: string, options: { threshold?: number; map?: Record<string, string> } = {}): Promise<Comparison> {
  const rootA = await captureRoot(a); const rootB = await captureRoot(b);
  const threshold = options.threshold ?? 0.1;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('--threshold must be between 0 and 1.');
  const out = join(rootB, 'compare');
  await mkdir(out, { recursive: true });
  if (await realpath(out) !== out) throw new Error('Comparison output cannot be a symlink.');
  const report: Comparison = { images: [], motion: [], approximate: !options.map, warnings: [], out };
  const dirsB = new Set(await files(rootB));
  const dirsA = (await files(rootA)).filter(name => /^(chromium|webkit)-\d+$/.test(name));
  for (const pass of dirsA) {
    if (!dirsB.has(pass)) { report.warnings.push(`Missing B pass: ${pass}`); continue; }
    const screenA = join(rootA, pass, 'screenshots'); const screenB = join(rootB, pass, 'screenshots');
    const namesB = new Set(await files(screenB));
    const namesA = (await files(screenA)).filter(name => name === 'full.png' || /^step-[\d.]+\.png$/.test(name));
    await mkdir(join(out, pass), { recursive: true });
    if (await realpath(join(out, pass)) !== join(out, pass)) throw new Error('Comparison pass output cannot traverse a symlink.');
    for (const name of namesA) {
      if (!namesB.has(name)) { report.warnings.push(`Missing B screenshot: ${pass}/${name}`); continue; }
      const dataA = await readFile(join(screenA, name)); const dataB = await readFile(join(screenB, name));
      const imageA = PNG.sync.read(dataA); const imageB = PNG.sync.read(dataB);
      const width = Math.min(imageA.width, imageB.width); const height = Math.min(imageA.height, imageB.height);
      const crop = (buffer: Buffer) => sharp(buffer).extract({ left: 0, top: 0, width, height }).ensureAlpha().raw().toBuffer();
      const rawA = await crop(dataA); const rawB = await crop(dataB);
      const diff = new PNG({ width, height });
      const mismatchPixels = pixelmatch(rawA, rawB, diff.data, width, height, { threshold });
      await noSymlink(join(out, pass, `diff-${name}`));
      await writeFile(join(out, pass, `diff-${name}`), PNG.sync.write(diff));
      report.images.push({ pass, image: name, width, height, sizeA: { width: imageA.width, height: imageA.height }, sizeB: { width: imageB.width, height: imageB.height }, sizeDifference: imageA.width !== imageB.width || imageA.height !== imageB.height, mismatchPixels, mismatchPercent: 100 * mismatchPixels / (width * height) });
    }
    for (const name of namesB) if (!namesA.includes(name)) report.warnings.push(`Missing A screenshot: ${pass}/${name}`);
  }
  for (const pass of dirsB) if (/^(chromium|webkit)-\d+$/.test(pass) && !dirsA.includes(pass)) report.warnings.push(`Missing A pass: ${pass}`);
  for (const engine of ['', 'webkit']) {
    const motionA = join(rootA, 'motion', engine); const motionB = join(rootB, 'motion', engine);
    const namesB = new Set(await files(motionB));
    const prefix = options.map ? 'scroll-curves-' : 'effects-';
    for (const file of (await files(motionA)).filter(f => f.startsWith(prefix) && f.endsWith('.json'))) {
      if (!namesB.has(file)) { report.warnings.push(`Missing B motion: ${engine}/${file}`); continue; }
      const width = `${engine || 'chromium'}-${file.slice(prefix.length, -5)}`;
      if (options.map) {
        const curveA = expandCurves(await json<Curves>(join(motionA, file)));
        const curveB = expandCurves(await json<Curves>(join(motionB, file)));
        if (!curveA.length || !curveB.length) { report.warnings.push(`Empty curves: ${width}`); continue; }
        const low = Math.max(curveA[0].y, curveB[0].y); const high = Math.min(curveA.at(-1)!.y, curveB.at(-1)!.y);
        const grid = [...new Set([...curveA, ...curveB].map(s => s.y).filter(y => y >= low && y <= high))].sort((a, b) => a - b);
        for (const [pathA, pathB] of Object.entries(options.map)) {
          const firstA = curveA.find(s => s.values[pathA])?.values[pathA]; const firstB = curveB.find(s => s.values[pathB])?.values[pathB];
          if (!firstA || !firstB || !grid.length) { report.warnings.push(`Unmapped/missing curves: ${width} ${pathA} → ${pathB}`); continue; }
          const numeric = new Set<string>();
          for (const [curve, path] of [[curveA, pathA], [curveB, pathB]] as const) for (const sample of curve) {
            if (sample.values[path]) for (const property of Object.keys(numericProperties(sample.values[path]))) numeric.add(property);
          }
          const properties = [...numeric, 'clipPath', 'filter', 'position'];
          const at = (curve: typeof curveA, path: string, y: number, property: string): number | string => {
            let left = curve[0]; let right = curve.at(-1)!;
            for (const s of curve) { if (s.y <= y) left = s; if (s.y >= y) { right = s; break; } }
            const lv = left.values[path]; const rv = right.values[path];
            if (['clipPath', 'filter', 'position'].includes(property)) return lv[property as 'filter'];
            const from = numericProperties(lv)[property]; const to = numericProperties(rv)[property];
            return right.y === left.y ? from : from + (to - from) * (y - left.y) / (right.y - left.y);
          };
          for (const property of properties) {
            const errors = grid.map(y => {
              const va = at(curveA, pathA, y, property); const vb = at(curveB, pathB, y, property);
              return typeof va === 'number' && typeof vb === 'number' ? va - vb : va === vb ? 0 : 1;
            }).filter(Number.isFinite);
            if (!errors.length) { report.warnings.push(`${width} ${pathA} → ${pathB}: no comparable numeric values for ${property}.`); continue; }
            report.motion.push({ width, pathA, pathB, property, rms: rms(errors), maxError: Math.max(...errors.map(Math.abs)), samples: errors.length, approximate: false, metric: ['clipPath', 'filter', 'position'].includes(property) ? 'categorical mismatch (0/1)' : 'absolute scroll grid; computed units' });
          }
        }
      } else {
        const ea = await json<Effects>(join(motionA, file)); const eb = await json<Effects>(join(motionB, file));
        const allA = [...ea.effects, ...ea.pinned]; const allB = [...eb.effects, ...eb.pinned];
        for (const property of new Set(allA.map(e => e.property))) {
          const aa = allA.filter(e => e.property === property); const bb = allB.filter(e => e.property === property);
          if (aa.length !== bb.length) report.warnings.push(`${width} ${property}: ${aa.length} vs ${bb.length} effect segments; compared ${Math.min(aa.length, bb.length)}.`);
          for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
            const av = aa[i]; const bv = bb[i];
            const errors = [typeof av.from === 'number' && typeof bv.from === 'number' ? av.from - bv.from : av.from === bv.from ? 0 : 1, typeof av.to === 'number' && typeof bv.to === 'number' ? av.to - bv.to : av.to === bv.to ? 0 : 1];
            report.motion.push({ width, pathA: av.path, pathB: bv.path, property, rms: rms(errors), maxError: Math.max(...errors.map(Math.abs)), samples: 2, approximate: true, metric: `ordered effect endpoints; scroll ranges A ${av.start}–${av.end}, B ${bv.start}–${bv.end}` });
          }
        }
      }
    }
  }
  if (!report.images.length) report.warnings.push('No matching screenshots.');
  if (!report.motion.length) report.warnings.push('No matching motion data.');
  await noSymlink(join(out, 'report.json'));
  await noSymlink(join(out, 'REPORT.md'));
  await writeJson(join(out, 'report.json'), report);
  const escape = (v: unknown) => String(v).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const passes = [...new Set(report.images.map(i => i.pass))];
  const lines = ['# Capture comparison', '', `A: ${rootA}`, `B: ${rootB}`, `Pixelmatch threshold: ${threshold}. Images cropped to common dimensions; size differences are reported separately.`, '', '| Pass | Images | Mean mismatch % | Maximum mismatch % | Size differences |', '| --- | ---: | ---: | ---: | ---: |', ...passes.map(pass => {
    const images = report.images.filter(i => i.pass === pass);
    return `| ${pass} | ${images.length} | ${(images.reduce((sum, i) => sum + i.mismatchPercent, 0) / images.length).toFixed(6)} | ${Math.max(...images.map(i => i.mismatchPercent)).toFixed(6)} | ${images.filter(i => i.sizeDifference).length} |`;
  }), '', `Motion: ${options.map ? 'mapped elements; interpolated on a shared absolute scroll grid' : 'APPROXIMATE: effect endpoints paired by property and order'}. ${report.motion.length} property comparisons.`, '', '| Width | Property | RMS | Max error |', '| --- | --- | ---: | ---: |', ...report.motion.slice(0, 25).map(m => `| ${m.width} | ${escape(m.property)} | ${m.rms.toFixed(6)} | ${m.maxError.toFixed(6)} |`), '', 'Complete per-image and per-property measurements: report.json. Differences: <engine>-<width>/diff-*.png.', '', 'Warnings:', ...report.warnings.slice(0, 20).map(w => `- ${escape(w)}`)];
  await writeFile(join(out, 'REPORT.md'), lines.join('\n') + '\n');
  return report;
}
if (isMain(import.meta)) {
  (async () => {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { map: { type: 'string' }, threshold: { type: 'string', default: '0.1' } } });
    if (positionals.length !== 2) throw new Error('Usage: npm run compare -- <dirA> <dirB> [--map map.json] [--threshold 0.1]');
    const map = values.map ? await json<Record<string, string>>(values.map) : undefined;
    if (values.map && (!map || Array.isArray(map) || typeof map !== 'object' || Object.values(map).some(v => typeof v !== 'string'))) throw new Error('--map must be an object mapping CSS paths to CSS paths.');
    const report = await runCompare(positionals[0], positionals[1], { threshold: Number(values.threshold), map });
    console.log(`Compared ${report.images.length} images and ${report.motion.length} motion properties. Report: ${join(report.out, 'REPORT.md')}`);
  })().catch(error => { console.error(`Comparison could not complete: ${errorMessage(error)}`); process.exitCode = 0; });
}
