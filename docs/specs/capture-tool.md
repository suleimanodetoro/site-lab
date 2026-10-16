# Spec: capture tool (v1)

Status: implemented capture and comparison tool. Updated 2026-10-16 to remove project policy gates at the user's direction.

## Goal

`npm run capture -- <url> [options]` writes the rendered content, assets and measurements used to study and reconstruct one web page. The tool does not generate the reconstructed page. `npm run compare -- <dirA> <dirB>` measures how close two captures are, for example the original against our rebuild.

Stack: TypeScript run with `tsx`, Playwright 1.64 (already installed, with Chromium, WebKit and ffmpeg), `pixelmatch`, `pngjs`, `sharp`, and system `ffmpeg`/`ffprobe` (found on PATH or via `FFMPEG_PATH`/`FFPROBE_PATH`). Node 22.

## Layout

```
tool/
  capture.ts          CLI entry: parses args, runs the stages, writes SUMMARY.md
  compare.ts          CLI entry for the comparison
  lib/preflight.ts    advisory robots.txt check, output directory, SOURCE.md
  lib/browser.ts      launching engines and contexts
  lib/page-prep.ts    loading, hiding selectors, lazy-load scroll, stabilising
  lib/static.ts       DOM, styles, assets, computed styles, tokens, accessibility, hover states
  lib/motion.ts       library detection, GSAP/WAAPI/CSS timeline extraction, scroll sampling, slowed intro
  lib/video.ts        recorded tours, ffmpeg conversion, frame extraction
  lib/report.ts       SUMMARY.md and JSON writers
  lib/util.ts         CSS-path selectors, hashing, filenames, logging
  fixtures/demo/      local test page (see Acceptance)
  fixtures/serve.ts   tiny static server for the fixtures (node:http, no dependencies)
  test/run-fixture.ts end-to-end check against the fixture, with assertions
```

## CLI

`npm run capture -- <url>` with these options:

| Option | Default | Meaning |
|---|---|---|
| `--widths` | `auto` | `auto`: 390 and 1440 plus one width per breakpoint the page uses (at most 8). Breakpoints come from readable stylesheets, cross-origin stylesheets fetched as text, `<link media>` attributes and scripts' `matchMedia` calls. A list such as `390,1280` sets the widths. Height is 844 for widths under 768, 1024 for 768, and 900 otherwise. |
| `--engines` | `chromium` | `chromium,webkit` adds WebKit. Motion sampling and video use Chromium only unless `--motion-all-engines` is set. |
| `--scroll-step` | `auto` | Motion widths: `max(40, ceil(maxScroll / 150))`. In-between (layout) widths: half a screen. A number sets both. |
| `--settle-max` | `800` | Longest wait, in ms, for a scroll step to settle (2000 for wheel steps). |
| `--max-elements` | `1500` | Cap on elements tracked during scroll sampling (300 at layout widths). |
| `--timeline-ms`, `--no-timeline` | `4000` | How long to watch each screen-height position for things that change on their own. Positions where something new changes in steps are watched for 3 more windows. |
| `--click "<css>"` | none | Repeatable. Click these elements, in order, after the consent banner, instead of the automatic entry-gate check. |
| `--no-gate` | off | Don't click through "Enter" splash screens. |
| `--intro-seconds` | `40` | Length of the slowed-intro recording. |
| `--no-consent-dismiss` | off | Leave consent banners alone. By default the tool rejects optional cookies (never accepts) or hides the banner. |
| `--hide "<css>"` | none | Repeatable. Elements to hide with injected CSS (`visibility:hidden`). This does not redact network responses or assets. |
| `--no-video`, `--no-assets`, `--no-hover` | off | Skip stages. |
| `--out` | `captures/<host>/<UTC-date>` | Any output directory. If it exists, a numeric suffix one above the highest existing one is added, so the newest capture always has the highest number. |
| `--motion-all-engines` | off | Include motion sampling and video for WebKit. |
| `--reason "<text>"` | `Page study` | Optional description recorded in SOURCE.md. |
| `--terms-ok`, `--robots-unknown-ok` | off | Legacy flags accepted for compatibility; no effect on capture behaviour. |

Environment: `SITE_LAB_SLOTS` (default 2) is how many timing-sensitive stages (motion-width passes and video recordings) run at once across all captures on the machine; `SITE_LAB_SLOT_DIR` moves the shared lock folder.

`npm run compare -- <dirA> <dirB>` measures how close two captures are, for example the original against our rebuild.

Stack: TypeScript run with `tsx`, Playwright 1.64 (already installed, with Chromium, WebKit and ffmpeg), `pixelmatch`, `pngjs`, `sharp`, and system `ffmpeg`/`ffprobe` (found on PATH or via `FFMPEG_PATH`/`FFPROBE_PATH`). Node 22.

## Layout

```
tool/
  capture.ts          CLI entry: parses args, runs the stages, writes SUMMARY.md
  compare.ts          CLI entry for the comparison
  lib/preflight.ts    advisory robots.txt check, output directory, SOURCE.md
  lib/browser.ts      launching engines and contexts
  lib/page-prep.ts    loading, hiding selectors, lazy-load scroll, stabilising
  lib/static.ts       DOM, styles, assets, computed styles, tokens, accessibility, hover states
  lib/motion.ts       library detection, GSAP/WAAPI/CSS timeline extraction, scroll sampling, slowed intro
  lib/video.ts        recorded tours, ffmpeg conversion, frame extraction
  lib/report.ts       SUMMARY.md and JSON writers
  lib/util.ts         CSS-path selectors, hashing, filenames, logging
  fixtures/demo/      local test page (see Acceptance)
  fixtures/serve.ts   tiny static server for the fixtures (node:http, no dependencies)
  test/run-fixture.ts end-to-end check against the fixture, with assertions
```

## CLI

`npm run capture -- <url>` with these options:

| Option | Default | Meaning |
|---|---|---|
| `--widths` | `375,768,1280,1440` | Viewport widths. Height is 844 for widths under 768, 1024 for 768, and 900 otherwise. |
| `--engines` | `chromium,webkit` | Which engines to capture with. Motion sampling and video use Chromium only unless `--motion-all-engines` is set. |
| `--terms-ok`, `--robots-unknown-ok` | off | Legacy flags accepted for compatibility; no effect on capture behaviour. |
| `--reason "<text>"` | `Page study` | Optional description recorded in SOURCE.md. |
| `--hide "<css>"` | none | Repeatable. Elements to hide with injected CSS (`visibility:hidden`). This does not redact network responses or assets. |
| `--scroll-step` | `40` | Scroll sampling step, in px. |
| `--max-elements` | `1500` | Cap on elements tracked during scroll sampling. |
| `--no-video`, `--no-assets`, `--no-hover` | off | Skip stages. |
| `--out` | `captures/<host>/<UTC-date>` | Any output directory. If it exists, append `-2`, `-3` and so on to preserve earlier output. |
| `--motion-all-engines` | off | Include motion sampling and video for WebKit. |

`npm run compare -- <dirA> <dirB> [--map map.json] [--threshold 0.1]`.

## Preflight and browser behaviour

The CLI accepts a valid HTTP(S) URL. `--reason` is optional and defaults to `Page study`. Viewport widths, engine names and numeric sampling options are validated before capture.

Preflight reserves the output directory and fetches `<origin>/robots.txt`. The parser evaluates rules for user agent `*`, using longest-match Allow/Disallow rules with `*` and `$` wildcards. A 404 is recorded as missing. Disallowed or unknown results produce advisory warnings and the capture continues. Local hosts skip the robots request. Terms are recorded as unverified; neither legacy acknowledgement flag changes the result.

`--out` accepts any directory. An output location outside `captures/` produces an advisory warning. If the requested directory exists, the tool selects a numbered sibling directory. Comparison inputs can be in any readable directory.

Browser contexts use normal Playwright request, redirect, popup and service-worker behaviour. There is no request-method filter, redirect restriction, bot-marker stop, HTTP 403/429 stop or fixed pause between page loads. Engines and widths run sequentially as part of the current implementation. Page-preparation and motion-measurement waits remain in place. Capture records the content returned by the browser, including challenge and error pages.

`SOURCE.md` records the requested URL, final URLs, UTC timestamp, reason, robots result, unverified terms status, engines, widths, output directory, warnings and tool version. The final URLs also appear in `summary.json`. Captured scripts are saved as data and are not imported into the Node process.

## Output structure

```
<out>/
  SOURCE.md
  SUMMARY.md
  network.har                     one HAR, from the first chromium pass
  assets/manifest.json            [{url, type, mime, status, bytes, sha256, path}]
  assets/<type>/<sha256-prefix>-<basename>
  <engine>-<width>/
    dom.html                      rendered DOM after preparation (page.content())
    styles/                       saved stylesheet responses + inline.css (all readable document.styleSheets rules, including <style> and CSS-in-JS)
    computed.json                 per element: path, tag, id, classes, text (first 80 chars), box {x,y,w,h} in page coordinates, visible flag, chosen computed props, plus ::before/::after when content isn't 'none'
    tokens.json                   frequency-ranked fonts (family+weight+size+line-height+letter-spacing), colours (text, background, border), spacing values, radii, shadows, transitions, durations, easings
    aria.yml                      aria snapshot of body
    screenshots/full.png          full-page screenshot
    screenshots/step-<y>.png      viewport screenshot at each scroll sample step (chromium); every 5th step on webkit
    hover/<n>.png + hover.json    up to 40 visible links/buttons: element screenshot before and after hover, and the computed-style diff
  motion/                         chromium, at the widest and narrowest widths
    libraries.json                detected libraries + evidence (globals, script URLs, data attributes, version if exposed)
    gsap.json                     if a gsap global is reachable: ScrollTrigger.getAll() → {trigger path, start, end, scrub, pin, pinSpacing, snap, toggleActions, animation: {targets paths, vars (serialisable), duration, ease name, stagger}}; plus globalTimeline children tweens (targets, vars, duration, delay, ease). If GSAP is detected in bundles but not reachable, record that.
    waapi.json                    document.getAnimations(): target path, animationName, keyframes, timing, timeline type, and for scroll/view timelines the axis/source/range
    css-scroll-timelines.json     elements with animation-timeline / view-timeline / scroll-timeline set
    scroll-curves-<width>.json    see Scroll sampling
    effects-<width>.json          derived list: element path, property, scroll start → end, value from → to, shape (linear, eased or step), plus pinned ranges (element whose viewport position stays fixed while the page scrolls)
    smooth-scroll.json            Lenis/Locomotive settings if reachable (lerp, duration, easing as string, wheelMultiplier, smoothWheel)
  video/
    tour-<width>.mp4              load, wait 3 s, then smooth scroll to the bottom at about 1 viewport per 1.5 s using mouse wheel ticks; chromium
    intro-slow-<width>.mp4        first 4 s after load, slowed 10x (CDP Animation.setPlaybackRate 0.1 plus gsap.globalTimeline.timeScale(0.1) if reachable), recorded for 40 s of real time
    pointer-<width>.mp4           mouse moving in a slow figure-eight over the first viewport, then over each hover target; widest width only
    frames-<name>/                every frame of intro-slow as PNG (ffmpeg), for frame-by-frame study
```

## Page preparation (both engines, every width)

1. Load with `waitUntil: 'load'`, then wait for network idle with a 15-second cap. Never fail on idle timeout.
2. Inject `--hide` CSS.
3. Lazy-load pass: scroll down in viewport-height steps with 300 ms waits until the scroll height stops growing (cap 40 steps), then return to the top and wait 1 second.
4. Freeze nothing during static capture, but wait for fonts with `document.fonts.ready`.

## Computed-style capture

Walk every element, skipping script, style, meta, link, noscript and template. Cap at 6,000 elements, prioritising visible ones. Record: display, position, top/right/bottom/left, width, height, margin, padding, gap, grid-template-columns/rows, flex-direction/wrap/justify/align, font-family, font-size, font-weight, font-style, line-height, letter-spacing, text-transform, color, background-color, background-image (truncated to 200 chars), border (width/style/colour), border-radius, box-shadow, opacity, transform, transform-origin, filter, backdrop-filter, clip-path, mix-blend-mode, z-index, overflow, object-fit, object-position, transition, animation, will-change, cursor. Use a stable CSS path for each element (`util.cssPath`): ids if unique, otherwise `tag:nth-of-type` chains, max depth 12.

## Scroll sampling (the core of motion capture)

Run in chromium at the widest and narrowest widths:

1. **Choose tracked elements.** At scroll 0, gather candidates: elements with a non-identity transform, opacity < 1, a clip-path, a filter, `will-change`, a `data-scroll`/`data-speed`/`data-lag` attribute, ScrollTrigger targets, pinned elements, or position sticky/fixed, plus their children up to depth 2. Top up with visible elements in document order until `--max-elements`.
2. **Step.** For y = 0 up to maxScroll in `--scroll-step` increments, plus maxScroll itself:
   - Use `window.scrollTo(0, y)`. If a Lenis instance is reachable, use `lenis.scrollTo(y, {immediate: true})` instead.
   - Then wait for stability: sample tracked values every animation frame until 3 consecutive frames match, or 1,500 ms pass. Record the frame count waited.
   - For each tracked element, record: transform (as a matrix, decomposed into translateX/Y, scaleX/Y, rotate), opacity, clip-path, filter, bounding rect relative to the viewport, and computed `position`.
   - Store only changes from the previous step (delta encoding) to keep files small.
   - Save a viewport screenshot at every step in chromium.
3. **Derive effects.** For each element and property that changes, emit segments where it changes monotonically. Report start and end scroll, start and end values, and a shape estimate: compare normalised progress against linear, power2.inOut, power3.out and expo.out and pick the closest by squared error, reporting the error. Pinned ranges are where the element's viewport top changes by under 1 px across 3 or more steps while scroll advances.

## SUMMARY.md

Human-readable, under 150 lines:
- requested and final URLs, robots result and unverified terms status
- libraries detected
- counts: elements, assets by type, WAAPI animations, ScrollTriggers, pinned ranges
- top 25 scroll effects by visual magnitude, as a table
- type and colour tokens: top 10 each
- warnings: skipped stages, timeouts, advisory robots/output messages, GSAP not reachable, cross-origin stylesheets unreadable
- the paths to the key files

## compare.ts

Input: two capture roots at any location, A (original) and B (rebuild).
1. **Screenshots.** For each `<engine>-<width>` present in both, compare `full.png` and every matching `step-<y>.png`. Crop both images to the common size and record any size difference. Use pixelmatch with `--threshold`. Output `compare/<engine>-<width>/diff-*.png`, plus `compare/report.json` with the mismatch percentage per image.
2. **Motion.** If `--map map.json` is given (`{ "<pathA>": "<pathB>" }`), compare scroll curves for the mapped elements and properties: resample both onto a shared scroll grid and report RMS error and maximum error per property. Without a map, compare `effects-*.json` by order and property type, and mark the result as approximate.
3. Write `compare/REPORT.md`, a short table summary. Exit code 0 always; the output and report contain the comparison result.

## Acceptance: fixture and end-to-end test

Build `tool/fixtures/demo/index.html` (plus local CSS and JS, using GSAP, ScrollTrigger and Lenis from `node_modules`, copied in at fixture-serve time or served from `/node_modules/`). It must contain:
1. A CSS `@keyframes` fade-up on the hero heading at load (0.8 s, ease-out).
2. A Web Animations API pulse on a badge (infinite, 2 s).
3. A ScrollTrigger-pinned section (pin for 1,000 px of scroll) whose inner panel scrubs `x` from 0 to -600.
4. A ScrollTrigger scrubbed parallax image: `yPercent` from -20 to 20 across its viewport passage.
5. A CSS scroll-driven `animation-timeline: view()` progress bar (Chromium supports it).
6. Lenis smooth scrolling, exposed as `window.lenis`, with `gsap`/`ScrollTrigger` exposed on `window`.
7. Five buttons with distinct hover styles.

`npm run test:fixture` starts `fixtures/serve.ts` on a free port, runs capture against it (`--widths 390,1280 --reason fixture`), then asserts:
- `libraries.json` lists gsap, ScrollTrigger and lenis
- `gsap.json` has 2 ScrollTriggers, one with `pin: true`, and its scrub tween targets `x` with end value -600
- `waapi.json` includes the fade-up keyframes and the pulse
- `css-scroll-timelines.json` includes the progress bar
- `effects-1280.json` includes a pinned range of roughly 1,000 px (±15%), a translateX effect reaching about -600 (±5%), and a translateY parallax effect
- `hover.json` has 5 entries with non-empty style diffs
- the videos exist and are longer than 1 second; `frames-intro-slow` has more than 100 frames
- `compare` of the capture against itself reports 0% mismatch on every image

`npm run typecheck` is `tsc --noEmit` with strict mode on.

## Validation reports

Report the changed behaviour and actual check results, including incomplete stages or failures. Reconstruction accuracy is measured through the comparison output.
