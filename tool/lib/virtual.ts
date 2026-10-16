import type { Page } from 'playwright';
import sharp from 'sharp';

// Pages whose document never scrolls move with some other input. These are tried in order on the first steps;
// the first that visibly changes the screen drives the rest of the capture (and the tour video).
export type Driver = 'wheel' | 'ArrowDown' | 'PageDown' | 'drag';
export const DRIVERS: Driver[] = ['wheel', 'ArrowDown', 'PageDown', 'drag'];
/** Mean colour difference (0–1) that counts as the page moving on, and the level below which nothing happened. */
export const MOVED = 0.08;
export const STILL = 0.02;

/** One step of input. Wheel steps are a quick flick of six events, the way a trackpad gesture arrives. */
export async function drive(page: Page, driver: Driver, distance: number) {
  const size = page.viewportSize() ?? { width: 1440, height: 900 };
  if (driver === 'wheel') {
    await page.mouse.move(size.width / 2, size.height / 2);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, distance / 6); await page.waitForTimeout(16); }
  } else if (driver === 'drag') {
    const x = size.width / 2; const y = size.height * 0.7;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x, y - size.height * 0.45, { steps: 12 }); await page.mouse.up();
  } else {
    // Keep the pointer in a corner so hover effects that follow it stay out of the way.
    await page.mouse.move(2, size.height - 2);
    await page.keyboard.press(driver);
  }
}

/** A 64×40 colour thumbnail of a screenshot, for cheap visual comparison (covers canvas and WebGL too). */
export async function thumbnail(png: Buffer): Promise<Uint8Array> {
  return new Uint8Array(await sharp(png).resize(64, 40, { fit: 'fill' }).removeAlpha().raw().toBuffer());
}
/** Pure. Mean absolute difference of two thumbnails, 0 (identical) to 1. */
export function visualChange(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || !a.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length / 255;
}
