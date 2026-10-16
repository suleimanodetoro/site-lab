import { basename } from 'node:path';

export interface AssetType { mime: string; ext: string; type: string }
const types: Record<string, [string, string]> = {
  'image/webp': ['webp', 'image'], 'image/avif': ['avif', 'image'], 'image/png': ['png', 'image'],
  'image/jpeg': ['jpg', 'image'], 'image/gif': ['gif', 'image'], 'image/svg+xml': ['svg', 'image'],
  'video/mp4': ['mp4', 'media'], 'video/quicktime': ['mov', 'media'], 'video/webm': ['webm', 'media'],
  'video/x-matroska': ['mkv', 'media'], 'audio/webm': ['webm', 'media'], 'audio/mpeg': ['mp3', 'media'],
  'font/woff2': ['woff2', 'font'], 'font/woff': ['woff', 'font'], 'font/ttf': ['ttf', 'font'], 'font/otf': ['otf', 'font'],
  'application/json': ['json', 'fetch'], 'text/javascript': ['js', 'script'], 'text/css': ['css', 'stylesheet'],
  'text/html': ['html', 'document'], 'text/plain': ['txt', 'other']
};
const aliases: Record<string, string> = { 'application/javascript': 'text/javascript', 'application/x-javascript': 'text/javascript', 'application/font-woff': 'font/woff', 'application/x-font-ttf': 'font/ttf', 'application/x-font-opentype': 'font/otf' };
export const headerMime = (header: string) => header.split(';')[0].trim().toLowerCase();
export function sniffMime(body: Buffer): string | null {
  const ascii = (start: number, end: number) => body.toString('ascii', start, end);
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    const compatible: string[] = [];
    const boxLength = body.length >= 4 ? Math.min(body.readUInt32BE(0), body.length) : 0;
    for (let i = 16; i + 4 <= boxLength; i += 4) compatible.push(ascii(i, i + 4));
    if ([brand, ...compatible].some(b => b === 'avif' || b === 'avis')) return 'image/avif';
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return body.subarray(0, 4096).includes(Buffer.from('matroska')) ? 'video/x-matroska' : 'video/webm';
  }
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (body[0] === 255 && body[1] === 216 && body[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (ascii(0, 4) === 'wOF2') return 'font/woff2';
  if (ascii(0, 4) === 'wOFF') return 'font/woff';
  if (ascii(0, 4) === 'OTTO') return 'font/otf';
  if (body.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) || ascii(0, 4) === 'true') return 'font/ttf';
  if (isText(body) && /<svg(?:\s|>)/i.test(body.toString('utf8'))) return 'image/svg+xml';
  return null;
}
export function isText(body: Buffer): boolean {
  // Decode the complete body so an incomplete multibyte prefix cannot reject valid text.
  try { const text = new TextDecoder('utf-8', { fatal: true }).decode(body); return !/[\x00-\x08\x0e-\x1f]/.test(text); }
  catch { return false; }
}
export function assetType(body: Buffer, header: string): AssetType & { headerMime: string; sniffedMime: string | null } {
  const declared = headerMime(header); const sniffedMime = sniffMime(body);
  let mime = sniffedMime ?? aliases[declared] ?? declared;
  if ((mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+json')) && !isText(body)) mime = 'application/octet-stream';
  if (mime.endsWith('+json') && isText(body)) mime = 'application/json';
  // Unlisted text responses (e.g. Next.js text/x-component payloads) are still readable text.
  const text = !types[mime] && mime.startsWith('text/') && isText(body);
  const [ext, type] = types[mime] ?? (text ? ['txt', 'fetch'] : ['bin', 'other']);
  return { mime: types[mime] || text ? mime : 'application/octet-stream', ext, type, headerMime: declared, sniffedMime };
}
export function assetName(url: string, hash: string, ext: string): string {
  let stem = 'asset';
  try {
    const path = new URL(url).pathname;
    if (!path.endsWith('/')) stem = basename(decodeURIComponent(path)) || 'asset';
  } catch { /* malformed legacy URLs use the fallback */ }
  // Strip URL extensions, including already doubled extensions, before sanitising.
  stem = stem.replace(/(?:\.[a-zA-Z0-9_-]+)+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'asset';
  return `${hash.slice(0, 16)}-${stem.slice(0, 120 - 18 - ext.length)}.${ext}`;
}
export function isPartial(status: number, headers: Record<string, string>, bytes: number): boolean {
  return status === 206 || headers['content-range'] !== undefined || (headers['content-length'] !== undefined && bytes < Number(headers['content-length']));
}
export const MAX_ASSET_BYTES = 200 * 1024 * 1024;
