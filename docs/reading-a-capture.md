# Reading a capture

A capture folder is `captures/<host>/<UTC-date>[-n]/`. Read `SUMMARY.md` first; it points to everything else.

## Top level
| File | Contents |
|---|---|
| `SUMMARY.md` | Result, consent and gate handling, breakpoints, the **scroll step per width**, timed changes, libraries, per-pass counts, settling, timings, the top 25 scroll effects, type and colour tokens, warnings. |
| `summary.json` | The full report. `passes[]` has, for each width: `elements`, `tokens`, `hover`, `waapi`, `scrollTriggers`, `pinned`, `effects`, `steps`, `scrollStep`, `layoutOnly`, and for pages that don't scroll, `virtualExtent` and `virtualDriver`. There is also `breakpoints`, `timedChanges`, `consent`, `gate`, `timings` and every warning. |
| `SOURCE.md` | Provenance: the URL, final URLs, timestamp, robots result (advisory), widths and tool version. |
| `network.har` | Every request from the first Chromium pass. |

## Each width: `<engine>-<width>/`
| File | Contents |
|---|---|
| `screenshots/full.png` | A full-page screenshot after lazy-loading. |
| `screenshots/step-<y>.png` | The viewport at each scroll position y (or input distance, for pages that don't scroll). |
| `screenshots/gate.png` | The "Enter" screen, if there was one. |
| `dom.html`, `aria.yml` | The rendered DOM and its accessibility tree. |
| `styles/inline.css` | Every readable stylesheet rule. |
| `computed.json` | Up to 6000 elements, each with `path`, `tag`, `classes`, `text`, `box` (document coordinates), `visible`, and ~70 computed properties including `::before`/`::after`. |
| `tokens.json` | Frequency-ranked fonts, colours, spacing, radii, shadows, transitions, durations and easings. |
| `hover.json`, `hover/` | At the motion widths: for each link or button, the before and after screenshots and the computed-style differences. |

**Motion widths and layout widths:**
- The **motion widths** are 390 and 1440 by default. They get full scroll sampling, hover, the timeline and video.
- In-between widths are **layout only**: screenshots every half screen, plus DOM and computed styles.

## `motion/`
| File | Contents |
|---|---|
| `libraries.json` | The libraries detected, their versions, whether their global is reachable, and the evidence. |
| `gsap.json` | ScrollTrigger configs (`trigger`, `start`, `end`, `scrub`, `pin`, `snap`) and tween vars, when GSAP's global is reachable. |
| `waapi.json` | CSS and Web Animations: target, keyframes and timing (duration, delay, iterations, easing). Short animations are kept after they finish. |
| `css-scroll-timelines.json` | Elements using `animation-timeline`, `view-timeline` and `scroll-timeline`. |
| `smooth-scroll.json` | Lenis and Locomotive settings (`lerp`, `duration`, `easing`, `wheelMultiplier`). |
| `scroll-curves-<w>.json` | The raw samples. They are **delta-encoded**: each step lists only what changed. Use `expandCurves()` from `tool/lib/motion.ts` to get absolute values per step. For each element the values are `translateX`, `translateY`, `scaleX`, `scaleY`, `rotate`, `opacity`, `clipPath`, `filter`, `box` and `position`. |
| `effects-<w>.json` | Derived effects: `{ path, property, start, end, from, to, shape, ease, error }`, plus `pinned[]` plateaus. `insideAmbient` marks an effect on an element that is carried by a looping animation. The eases are best fits from a small set: linear, power2.inOut, power3.out, expo.out. |
| `timed-changes-<w>.json` | Things that change while the page is still. See the next section. |

## Timed changes
For each entry:
- `path`: the element.
- `kind`:
  - `text` or `content`: swapped text.
  - an attribute name: for example a `src` swap or a `class` toggle.
  - `style`: an inline style animated in bursts; the values are the settled states.
  - `turns`: the element's children take turns being visible. Stacked phrases, slides and tickers report like this, and the values are the texts in the order they appeared.
- `values`
- `medianIntervalMs`: the period.
- `cycles`
- `continuous`: true for loops that never rest, such as marquees and spinners.

## `video/`
- `tour-<w>.mp4`: a scroll through the page, with the wheel or the page's own input.
- `intro-slow-<w>.mp4`: the first `--intro-seconds` (default 40) with every animation slowed to 0.1×. `frames-intro-slow-<w>/` holds every frame as a JPEG, for frame-accurate timing.
- `pointer-<w>.mp4`: a cursor tour over the widest motion width, hovering each link.

## `assets/`
- Files are stored by their real type: `image/`, `font/`, `media/`, `script/`, `style/`, `fetch/`, `other/`.
- `manifest.json` maps each URL to `{ path, mime, bytes, sha256, status }`.
- Partial (HTTP 206) video responses are re-fetched whole.

## After a comparison: `<captureB>/compare/`
`REPORT.md` lists the per-image mismatch percentage and size differences, and motion RMS and maximum error (approximate without `--map`). `report.json` has everything. The diff images are in `<pass>/diff-*.png`.
