import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptureControl } from './interrupt.js';
import { log, sleep } from './util.js';

// Scroll sampling at the motion widths, the timeline and video recording measure timing. Captures running in
// parallel share a machine-wide pool of slots for those stages, so they don't slow each other's pages down,
// distort settle times or drop video frames. Everything else (layout widths, assets, encoding) runs freely.
const directory = () => process.env.SITE_LAB_SLOT_DIR ?? join(tmpdir(), 'site-lab-slots');
export const slotCount = () => Math.max(1, Math.floor(Number(process.env.SITE_LAB_SLOTS)) || 2);
const held = new Set<string>();
// A second Ctrl+C exits at once; don't leave this process's slots behind.
process.on('exit', () => { for (const file of held) { try { unlinkSync(file); } catch { /* already gone */ } } });

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Wait for a free slot. Returns its release function. Slots left by processes that no longer exist are reclaimed. */
export async function acquireSlot(label: string, control?: CaptureControl): Promise<() => Promise<void>> {
  const dir = directory();
  await mkdir(dir, { recursive: true });
  let announced = false;
  for (;;) {
    for (let i = 0; i < slotCount(); i++) {
      const file = join(dir, `slot-${i}.lock`);
      try {
        const handle = await open(file, 'wx');
        try { await handle.writeFile(`${process.pid}\n${label}\n`); } finally { await handle.close(); }
        held.add(file);
        if (announced) log(`${label}: got a slot`);
        return async () => { held.delete(file); await unlink(file).catch(() => undefined); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const pid = Number((await readFile(file, 'utf8').catch(() => '')).split('\n')[0]);
        if (pid > 0 && !alive(pid)) await unlink(file).catch(() => undefined);
      }
    }
    if (!announced) { log(`${label}: waiting for a free slot (${slotCount()} timing-sensitive stages run at once across all captures)`); announced = true; }
    control?.checkpoint();
    await sleep(1000);
  }
}
