import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Find a command: an environment override, then PATH, then common install locations. Returns '' if absent. */
export function findBinary(name: string, envVar: string): string {
  const override = process.env[envVar];
  if (override) return override;
  for (const dir of [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return '';
}
export const ffmpeg = findBinary('ffmpeg', 'FFMPEG_PATH');
export const ffprobe = findBinary('ffprobe', 'FFPROBE_PATH');
/** Run at low priority where `nice` exists, so encoding never takes CPU from recordings and measurements. */
export function lowPriority(command: string, args: string[]): [string, string[]] {
  return existsSync('/usr/bin/nice') ? ['/usr/bin/nice', ['-n', '10', command, ...args]] : [command, args];
}
export const missingFfmpeg = 'ffmpeg and ffprobe are needed for video (macOS: brew install ffmpeg; Debian/Ubuntu: sudo apt install ffmpeg), or set FFMPEG_PATH and FFPROBE_PATH. To capture without video, add --no-video.';
