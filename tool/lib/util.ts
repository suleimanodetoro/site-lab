import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** A delay for time limits in races: unref'd, so a limit that never fires cannot keep the process alive. */
export const timeLimit = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref(); });
export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export const log = (message: string) => console.log(`[site-lab] ${message}`);
export async function writeJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}
export function filename(url: string) {
  try { return (basename(decodeURIComponent(new URL(url).pathname)) || 'index').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100); }
  catch { return 'resource'; }
}
// Authored browser helper. Installed in the capture browser; captured code is never executed in Node.
export function cssPath(element: Element): string {
  const parts: string[] = [];
  let el: Element | null = element;
  for (let depth = 0; el && depth < 12; depth++, el = el.parentElement) {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(el.id)}`); break;
    }
    const tag = el.localName;
    const siblings = el.parentElement ? [...el.parentElement.children].filter(s => s.localName === tag) : [el];
    parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(el) + 1})`);
  }
  return parts.join(' > ');
}
declare global { interface Window { __siteLabPath: typeof cssPath } }
export async function installHelpers(page: Page) {
  await page.addInitScript(`globalThis.__name ??= (target) => target; window.__siteLabPath = (${cssPath.toString()});`);
}
// tsx retains function names with esbuild's __name helper. Serialized browser functions
// need that helper in their own realm as well as in Node's module scope.
export async function browserInit(page: Page, fn: Function, argument?: unknown) {
  await page.addInitScript(`globalThis.__name ??= (target) => target; (${fn.toString()})(${JSON.stringify(argument) ?? 'undefined'});`);
}
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
export function isMain(meta: ImportMeta) {
  return process.argv[1] !== undefined && fileURLToPath(meta.url) === resolve(process.argv[1]);
}
