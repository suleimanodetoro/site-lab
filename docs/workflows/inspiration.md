# Workflow: take inspiration, and turn an effect into your own component

Use this when you love one thing about a site (a scroll reveal, a pinned story, a rotating headline, a marquee, an intro) and want it in your own work, rebuilt as an original, reusable component.

## 1. Capture
- **A whole page:** `npm run capture -- <url>`.
- **A quicker look:** `npm run capture -- <url> --widths 390,1440 --no-assets`.

## 2. Find the effect and measure it
1. **See it:** watch `video/tour-*.mp4`, and step through `video/frames-intro-slow-*/` (slowed 10×) for intros. The step screenshots show the state at each scroll position.
2. **Find its element:** the top effects in `SUMMARY.md`, `computed.json` (search by text or class) or `dom.html`.
3. **Read its numbers:**
   - Scroll-driven: `motion/effects-<w>.json` gives the scroll range, from → to, ease and pins. For the full curve, expand `scroll-curves-<w>.json`.
   - Library config: `gsap.json` for ScrollTrigger start, end, scrub and pin, and the tween vars; `smooth-scroll.json` for Lenis settings.
   - CSS/WAAPI loops and keyframes: `waapi.json`.
   - Things that change by themselves: `timed-changes-<w>.json` gives the values, order, period and kind (`turns` = stacked items taking turns).
   - Hover: `hover.json` gives the property differences and the before and after images.

## 3. Write a technique card
Create `kit/<technique-name>/TECHNIQUE.md` covering:
- what it looks like, in a sentence;
- the measured numbers, with the source file and the capture path;
- how it's built: the structure, library and key settings;
- the parameters worth exposing: duration, distance, ease, stagger, period.

Describe the technique. Don't paste the site's code.

## 4. Build it as your own component
- Put it in `kit/<technique-name>/`, as a framework component (React or similar) with props for the parameters, plus a small demo page.
- Use **your own content and assets**: no images, fonts, logos or copy from the source site.
- Respect `prefers-reduced-motion`, and keep animation to transform and opacity where you can.

## 5. Check it against the measurements
Serve the demo, capture it (`npm run capture -- http://localhost:<port>/ --widths 1440`), and compare the motion numbers. `npm run compare -- <original> <demo> --map map.json` pairs elements, for example `{ "<original selector>": "<your selector>" }`, and reports the RMS error per property. Tune the component until the curves match.
