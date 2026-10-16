export type Engine = 'chromium' | 'webkit';
export interface CaptureOptions {
  url: string; widths: number[]; autoWidths: boolean; timelineMs: number; engines: Engine[]; termsOk: boolean; reason: string;
  hide: string[]; scrollStep: number | 'auto'; settleMax: number; maxElements: number; video: boolean; assets: boolean;
  hover: boolean; consent: boolean; motionAllEngines: boolean; robotsUnknownOk: boolean; out?: string;
  gate: boolean; click: string[]; introSeconds: number;
  /** What earlier page loads in this capture found, so later loads don't wait for things that never appear. */
  seen?: { consent?: boolean; gate?: boolean };
}
export interface Box { x: number; y: number; w: number; h: number }
export interface SampleValue {
  transform: string; translateX: number; translateY: number; scaleX: number; scaleY: number;
  rotate: number; opacity: number; clipPath: string; filter: string; box: Box; position: string; ambient?: boolean; ambientAncestor?: boolean;
}
export type SampleDelta = Partial<Omit<SampleValue, 'box'>> & { box?: Partial<Box> };
export interface CurveStep { y: number; frames: number; stable: boolean; settleMs?: number; timedOut?: boolean; changes: Record<string, SampleDelta> }
export interface ElementFlags { path: string; ambient: boolean; ambientAncestor?: boolean }
/** `virtual`: the document does not scroll; steps were made with `driver` input and y is the input distance. */
export interface Curves { width: number; maxScroll: number; paths: string[]; elements?: ElementFlags[]; steps: CurveStep[]; virtual?: { delta: number; extent: number; driver: string; steps: number } }
export interface Effect {
  path: string; property: string; start: number; end: number; from: number | string;
  to: number | string; shape: 'linear' | 'eased' | 'step' | 'pinned'; ease: string;
  error: number; magnitude: number; insideAmbient?: boolean;
}
export interface Effects { width: number; effects: Effect[]; pinned: Effect[]; elements?: ElementFlags[]; steps?: number; timedOutSteps?: number; scrollStep?: number; virtualExtent?: number; virtualDriver?: string }
export interface TokenEntry { value: string; count: number }
export type Tokens = Record<string, TokenEntry[]>;
export interface Asset {
  url: string; type: string; mime: string; status: number; bytes: number; sha256: string; path: string;
  headerMime?: string; sniffedMime?: string | null; ext?: string; partial?: boolean;
  contentRange?: string | null; refetched?: boolean; refetchError?: string;
}
export interface Library { name: string; version?: string; reachable: boolean; evidence: string[] }
export interface MotionInventory {
  libraries: Library[]; gsap: { reachable: boolean; scrollTriggers: unknown[]; tweens: unknown[]; note?: string };
  waapi: unknown[]; cssTimelines: unknown[]; smoothScroll: unknown;
}
export interface PassReport {
  engine: Engine; width: number; elements: number; tokens: Tokens; hover: number;
  waapi: number; scrollTriggers: number; pinned: number; effects: Effect[]; steps?: number; timedOutSteps?: number;
  scrollStep?: number; virtualExtent?: number; virtualDriver?: string; layoutOnly?: boolean;
}
export interface RunReport {
  url: string; resolvedUrls?: string[]; out: string; ethics: string; status: string; libraries: Library[];
  consent?: { action: string; detail: string }; gate?: { action: string; detail: string };
  breakpoints?: { found: { px: number; kind: string; count: number }[]; widths: number[]; fetchedSheets?: number; scriptQueries?: number };
  timedChanges?: Record<string, { path: string; kind: string; values: string[]; changes: number; medianIntervalMs: number | null; cycles: boolean; continuous: boolean; firstSeenAtScroll: number }[]>;
  interruptedStage?: string; timings?: { stage: string; durationMs: number }[];
  assets: Asset[]; passes: PassReport[]; warnings: string[];
}
