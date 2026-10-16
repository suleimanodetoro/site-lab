import { mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, basename } from 'node:path';
import type { Asset } from './lib/types.js';
import { assetName, assetType, isPartial } from './lib/assets.js';
import { errorMessage, isMain, log, sha256, writeJson } from './lib/util.js';

export async function fixNames(captureDir: string) {
  const root = resolve(captureDir); const manifest = resolve(root, 'assets/manifest.json');
  const assets = JSON.parse(await readFile(manifest, 'utf8')) as Asset[];
  const before = JSON.stringify(assets);
  const summary = { renamed: 0, moved: 0, unchanged: 0, unknown: 0, changes: 0 };
  const stored = new Map<string, string>(); const processed = new Map<string, Asset>();
  const inside = (path: string) => {
    const file = resolve(root, path); const rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Asset outside capture: ${path}`);
    return file;
  };
  for (const asset of assets) {
    if (!asset.path) {
      asset.headerMime ??= assetType(Buffer.alloc(0), asset.mime).headerMime;
      asset.sniffedMime ??= null; asset.ext ??= 'bin'; asset.partial ??= isPartial(asset.status, {}, asset.bytes);
      asset.contentRange ??= null; asset.refetched ??= false;
      summary.unknown++; summary.unchanged++; continue;
    }
    const oldPath = asset.path; const prior = processed.get(oldPath);
    if (prior) {
      Object.assign(asset, { path: prior.path, type: prior.type, ext: prior.ext, sniffedMime: prior.sniffedMime, sha256: prior.sha256, bytes: prior.bytes });
    } else {
      const body = await readFile(inside(oldPath)); const hash = sha256(body);
      const real = assetType(body, asset.headerMime ?? asset.mime);
      const path = stored.get(hash) ?? `assets/${real.type}/${assetName(asset.url, hash, real.ext)}`;
      if (path !== oldPath && !stored.has(hash)) {
        const target = inside(path); await mkdir(dirname(target), { recursive: true });
        let existing: Buffer | undefined;
        try { existing = await readFile(target); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        if (existing) {
          if (sha256(existing) !== hash) throw new Error(`Refusing to overwrite different content: ${path}`);
          // Keep the old file when deduplicating; this command never deletes files.
        } else await rename(inside(oldPath), target);
      }
      Object.assign(asset, { type: real.type, headerMime: real.headerMime, sniffedMime: real.sniffedMime, ext: real.ext, sha256: hash, bytes: body.length, path });
      stored.set(hash, path); processed.set(oldPath, asset);
    }
    asset.headerMime ??= assetType(Buffer.alloc(0), asset.mime).headerMime;
    asset.partial ??= isPartial(asset.status, {}, asset.bytes);
    asset.contentRange ??= null; asset.refetched ??= false;
    if (asset.ext === 'bin') summary.unknown++;
    if (basename(oldPath) !== basename(asset.path)) summary.renamed++;
    if (dirname(oldPath) !== dirname(asset.path)) summary.moved++;
    if (oldPath === asset.path) summary.unchanged++; else summary.changes++;
  }
  if (JSON.stringify(assets) !== before) await writeJson(manifest, assets);
  log(`fix-names: ${summary.changes} changes; ${summary.renamed} renamed, ${summary.moved} moved, ${summary.unchanged} unchanged, ${summary.unknown} unknown${JSON.stringify(assets) === before ? '; no changes' : ''}`);
  return summary;
}
if (isMain(import.meta)) {
  const dir = process.argv[2];
  if (!dir || process.argv.length !== 3) { console.error('Usage: npm run fix-names -- <captureDir>'); process.exitCode = 1; }
  else fixNames(dir).catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
}
