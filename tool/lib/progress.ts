import { log } from './util.js';

export function scrollStep(maxScroll: number, requested: number | 'auto'): number {
  return requested === 'auto' ? Math.max(40, Math.ceil(maxScroll / 150)) : requested;
}
export function scrollPositions(maxScroll: number, requested: number | 'auto'): number[] {
  const positions: number[] = []; const step = scrollStep(maxScroll, requested);
  for (let y = 0; y < maxScroll; y += step) positions.push(y);
  positions.push(maxScroll);
  return positions;
}
export function estimateRemaining(durations: number[], remaining: number): number {
  const recent = durations.slice(-20);
  return recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length * Math.max(0, remaining) : 0;
}
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}
export class ScrollProgress {
  private started = performance.now();
  private last = this.started;
  private durations: number[] = [];
  constructor(private label: string, private total: number) { log(`${label} · scroll sampling started · ${total} steps`); }
  step(completed: number, duration: number) {
    this.durations.push(duration); this.durations = this.durations.slice(-20);
    // Plain lines only: in-place (\r) updates render as fragments in some terminal panes.
    const now = performance.now();
    if (completed !== this.total && completed % 25 !== 0 && now - this.last < 5000) return;
    log(`${this.label} · scroll ${completed}/${this.total} · ${formatDuration(now - this.started)} · ~${formatDuration(estimateRemaining(this.durations, this.total - completed))} left`);
    this.last = now;
  }
  end() { /* nothing to close: every progress update is a complete line */ }
}
