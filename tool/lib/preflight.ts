import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename, join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CaptureOptions } from './types.js';

export const isLocal = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname.toLowerCase());
export type RobotsResult = 'allowed' | 'disallowed' | 'missing' | 'unknown';
export interface Preflight { out: string; robots: RobotsResult; terms: string; timestamp: string; version: string; note: string; warnings: string[]; resolvedUrls: string[] }

export function robotsAllows(source: string, url: URL): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let group: typeof groups[number] = { agents: [], rules: [] };
  let hadRules = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (hadRules) { groups.push(group); group = { agents: [], rules: [] }; hadRules = false; }
      group.agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      hadRules = true;
      if (value) group.rules.push({ allow: key === 'allow', pattern: value });
    } else if (group.agents.length) hadRules = true;
  }
  groups.push(group);
  // URI paths are compared in their percent-encoded form; decode only unreserved octets.
  const normalise = (s: string) => s.replace(/[^\x00-\x7f]/gu, ch => encodeURIComponent(ch)).replace(/%([a-f\d]{2})/gi, (all, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9._~-]/.test(ch) ? ch : all.toUpperCase();
  });
  const path = normalise(url.pathname + url.search);
  let best = -1; let allowed = true;
  for (const g of groups.filter(g => g.agents.includes('*'))) for (const rule of g.rules) {
    const pattern = normalise(rule.pattern);
    const end = pattern.endsWith('$');
    const body = end ? pattern.slice(0, -1) : pattern;
    const regex = '^' + body.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (end ? '$' : '');
    const length = Buffer.byteLength(body.replaceAll('*', '').replace(/%[A-F\d]{2}/gi, 'x'));
    if (new RegExp(regex).test(path) && (length > best || (length === best && rule.allow))) {
      best = length; allowed = rule.allow;
    }
  }
  return allowed;
}

async function reserveOutput(options: CaptureOptions) {
  const url = new URL(options.url);
  const wanted = resolve(options.out ?? join('captures', url.hostname, new Date().toISOString().slice(0, 10)));
  await mkdir(dirname(wanted), { recursive: true });
  // Resolve parent aliases (including macOS /tmp) before reserving a fresh leaf.
  const parent = await realpath(dirname(wanted));
  const canonical = join(parent, basename(wanted));
  // Never reuse a freed name: start one above the highest existing suffix, so the newest capture has the highest number.
  const leaf = new RegExp(`^${basename(wanted).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-(\\d+))?$`);
  const taken = (await readdir(parent)).flatMap(name => { const match = leaf.exec(name); return match ? [match[1] ? Number(match[1]) : 1] : []; });
  for (let i = Math.max(0, ...taken) + 1; ; i++) {
    const out = i === 1 ? canonical : `${canonical}-${i}`;
    try { await mkdir(out); return out; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}

export async function source(options: CaptureOptions, pre: Preflight, status: string) {
  const lines = [
    '# Capture provenance', '',
    `- URL: ${options.url}`,
    ...pre.resolvedUrls.map(url => `- Captured URL: ${url}`),
    `- UTC timestamp: ${pre.timestamp}`,
    '- Requested by: CLI operator',
    `- Reason: ${options.reason.replaceAll('\n', ' ')}`,
    `- Robots (advisory): ${pre.robots}${pre.note ? ` (${pre.note})` : ''}`,
    `- Terms result: ${pre.terms}`,
    '- Decision: operator requested capture; advisory results do not block execution.',
    `- Output: ${pre.out}`,
    `- Engines: ${options.engines.join(', ')}`,
    `- Widths: ${options.widths.join(', ')}`,
    `- Tool version: ${pre.version}`,
    `- Result: ${status}`, '',
    '## Advisory notes',
    ...(pre.warnings.length ? pre.warnings.map(warning => `- ${warning.replaceAll('\n', ' ')}`) : ['- None.']), ''
  ];
  await writeFile(join(pre.out, 'SOURCE.md'), lines.join('\n'));
}

export async function preflight(options: CaptureOptions): Promise<Preflight> {
  const url = new URL(options.url);
  const local = isLocal(url.hostname);
  const pre: Preflight = { out: await reserveOutput(options), robots: 'unknown', terms: 'unverified; the tool does not assess site terms', timestamp: new Date().toISOString(), version: 'unversioned', note: '', warnings: [], resolvedUrls: [] };
  try { pre.version = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* no Git history */ }
  const captures = await realpath(resolve('captures')).catch(() => resolve('captures'));
  const outputRelative = relative(captures, pre.out);
  if (outputRelative === '..' || outputRelative.startsWith(`..${sep}`)) pre.warnings.push(`Custom output outside captures/: ${pre.out}`);
  if (options.termsOk) pre.warnings.push('--terms-ok is deprecated and has no effect; terms remain unverified.');
  if (options.robotsUnknownOk) pre.warnings.push('--robots-unknown-ok is deprecated and has no effect; robots results are advisory.');
  if (local) { pre.robots = 'allowed'; pre.note = 'local host; robots check skipped'; }
  else {
    try {
      let endpoint = new URL('/robots.txt', url.origin);
      let response: Response | undefined;
      const signal = AbortSignal.timeout(15000);
      for (let redirects = 0; redirects <= 5; redirects++) {
        response = await fetch(endpoint, { redirect: 'manual', signal });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw new Error('robots redirect limit or missing location');
        endpoint = new URL(location, endpoint);
        if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('unsupported robots redirect');
      }
      if (!response) throw new Error('no robots response');
      if (response.status === 404) pre.robots = 'missing';
      else if (response.ok) pre.robots = robotsAllows(await response.text(), url) ? 'allowed' : 'disallowed';
      else { pre.note = `HTTP ${response.status}`; pre.robots = 'unknown'; }
    } catch (error) { pre.note = String(error); }
    pre.warnings.push('Site terms are unverified; capture continues at the operator’s request.');
    if (pre.robots === 'disallowed') pre.warnings.push('robots.txt disallows this URL; recorded as advisory, capture continues.');
    if (pre.robots === 'unknown') pre.warnings.push(`robots.txt result unknown${pre.note ? ` (${pre.note})` : ''}; capture continues.`);
  }
  await source(options, pre, 'preflight complete');
  return pre;
}
