import { CaptureInterrupted, type CaptureControl } from './interrupt.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureOptions, Engine } from './types.js';
import { openSession, viewport } from './browser.js';
import { load } from './page-prep.js';
import { hoverTargets } from './static.js';
import { log } from './util.js';
import { ffmpeg, ffprobe, lowPriority } from './binaries.js';
import { acquireSlot } from './slots.js';
import { drive, type Driver } from './virtual.js';

const exec = promisify(execFile);
export { ffmpeg, ffprobe };
export async function duration(file: string) {
  const { stdout } = await exec(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
  return Number(stdout.trim());
}
/**
 * Records the tour, slowed intro and (widest width) pointer videos one at a time, each in a timing slot.
 * Encoding runs afterwards at low priority, in parallel with the next recording.
 * `virtual`: the page does not scroll; the tour drives it with the input the motion stage found, for as long.
 */
export async function captureVideos(options: CaptureOptions, engine: Engine, width: number, widest: boolean, dir: string, recordUrl?: (url: string) => void, control?: CaptureControl, virtual?: { extent: number; driver: string; steps: number }) {
  await mkdir(dir, { recursive: true });
  const kinds = ['tour', 'intro-slow', ...(widest ? ['pointer'] : [])] as const;
  const encodes: Promise<void>[] = [];
  try {
    for (const kind of kinds) {
      control?.checkpoint();
      const raw = join(dir, `.raw-${kind}-${width}`);
      await mkdir(raw, { recursive: true });
      const release = await acquireSlot(`${new URL(options.url).hostname} video ${kind} ${width}px`, control);
      log(`video ${engine} ${width}px ${kind}`);
      let input: string | undefined;
      try {
        const session = await openSession(engine, width, options, { videoDir: raw, slow: kind === 'intro-slow' });
        const page = session.page;
        const video = page.video();
        let recorded = false;
        try {
          await load(session, options, { slow: kind === 'intro-slow' });
          if (kind === 'intro-slow') {
            // A real observation at 0.1× animation speed, not a repeated still or post-hoc slow conversion.
            for (let i = 0; i < options.introSeconds * 10; i++) { control?.checkpoint(); await page.waitForTimeout(100); }
          } else if (kind === 'tour') {
            await page.waitForTimeout(3000);
            const { height } = viewport(width);
            const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
            if (virtual && virtual.driver !== 'wheel') {
              // The document does not scroll: repeat the key press or drag the motion stage found, at a viewing pace.
              for (let step = 0; step < Math.min(60, Math.max(10, virtual.steps)); step++) { control?.checkpoint(); await drive(page, virtual.driver as Driver, height / 3); await page.waitForTimeout(1200); }
            } else if (virtual || max < 40) {
              // The document does not scroll: wheel through the distance the motion stage measured (1–60 seconds).
              await page.mouse.move(width / 2, height / 2);
              const ticks = Math.min(600, Math.max(10, Math.ceil((virtual?.extent ?? height * 10) / (height / 15))));
              for (let tick = 0; tick < ticks; tick++) { control?.checkpoint(); await page.mouse.wheel(0, height / 15); await page.waitForTimeout(100); }
            } else {
              let previous = -1;
              for (let tick = 0; tick < Math.ceil(max / (height / 15)) + 30; tick++) {
                control?.checkpoint();
                await page.mouse.wheel(0, height / 15);
                await page.waitForTimeout(100);
                const y = await page.evaluate(() => scrollY);
                if (y >= max - 1) break;
                if (tick > 15 && y === previous) break;
                previous = y;
              }
            }
            await page.waitForTimeout(1000);
          } else {
            await page.waitForTimeout(1000);
            const { height } = viewport(width);
            for (let i = 0; i <= 120; i++) {
              control?.checkpoint();
              const angle = i / 120 * Math.PI * 2;
              await page.mouse.move(width / 2 + width * 0.35 * Math.sin(angle), height / 2 + height * 0.3 * Math.sin(2 * angle));
              await page.waitForTimeout(50);
            }
            if (options.hover) for (const path of await hoverTargets(page)) {
              control?.checkpoint();
              // A target can move, hide or detach after it was listed; skip it rather than fail the recording.
              try {
                const target = page.locator(path).first();
                await target.scrollIntoViewIfNeeded({ timeout: 3000 });
                const box = await target.boundingBox({ timeout: 3000 });
                if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 }); await page.waitForTimeout(500); }
              } catch (error) {
                if (error instanceof CaptureInterrupted) throw error;
              }
            }
          }
          recorded = true;
        } finally { recordUrl?.(page.url()); await session.close(); }
        if (!recorded || !video) throw new Error(`Video recorder unavailable: ${kind}-${width}`);
        input = await video.path();
      } finally { await release(); }
      encodes.push(encode(input, dir, `${kind}-${width}`, kind === 'intro-slow', raw));
    }
  } finally {
    // Wait for every started encode, even when a later recording failed, so no ffmpeg outlives the capture.
    const results = await Promise.allSettled(encodes);
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }
}

// `nice` keeps encoding from taking CPU away from recordings and samples running at the same time.
async function encode(input: string, dir: string, name: string, frames: boolean, raw: string) {
  const output = join(dir, `${name}.mp4`);
  await exec(...lowPriority(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', input, '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output]), { maxBuffer: 4 * 1024 * 1024 });
  if (frames) {
    // Every frame of the slowed intro, as high-quality JPEG (PNG was ~1 GB per clip).
    const folder = join(dir, `frames-${name}`);
    await mkdir(folder, { recursive: true });
    await exec(...lowPriority(ffmpeg, ['-nostdin', '-loglevel', 'error', '-i', output, '-threads', '2', '-fps_mode', 'passthrough', '-q:v', '2', join(folder, '%06d.jpg')]), { maxBuffer: 4 * 1024 * 1024 });
  }
  await rm(raw, { recursive: true, force: true });
}
