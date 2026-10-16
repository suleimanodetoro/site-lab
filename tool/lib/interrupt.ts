export class CaptureInterrupted extends Error {
  constructor() { super('Capture interrupted'); }
}
export interface CaptureControl { interrupted: boolean; checkpoint: () => void }
export function captureControl(): CaptureControl {
  return { interrupted: false, checkpoint() { if (this.interrupted) throw new CaptureInterrupted(); } };
}
