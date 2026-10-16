# Workflow: rebuild a page 1:1 (a private study copy)

Give this file to your agent along with: the URL (or an existing capture folder), the folder to build in, and a port. Rebuilds are for learning. Keep them private (see `RESPONSIBLE-USE.md`).

## 0. Capture
`npm run capture -- <url>` writes `captures/<host>/<date>[-n]/`. Use that exact path from here on. Read its `SUMMARY.md` before writing any code:
- **Breakpoints:** the widths you must match.
- **Scroll steps:** the step per width. In-between widths are layout-only.
- **Timed changes:** rotating text and similar, with values, order and period.
- **Entry gate:** if there was one, its screen is in `screenshots/gate.png`.
- **Libraries:** match what the original uses (GSAP, Lenis and so on).

## 1. Build
- **Stack:** any modern stack. Next.js App Router + TypeScript works well.
- **Structure:** one component per section, written as your own clean code. Use `computed.json`, `tokens.json` and the readable CSS as the spec.
- **Assets:** copy what you need from `assets/` (look files up in `assets/manifest.json`) into your project. Never load anything from the original site at runtime.
- **Motion:**
  - Reproduce every effect in `motion/effects-<w>.json` at its measured scroll range, including the pins.
  - Use the configs in `gsap.json`, `waapi.json` and `smooth-scroll.json`.
  - Match the intro frame by frame against `video/frames-intro-slow-*` (slowed 10×).
  - Copy the hover states from `hover.json`.
  - Reproduce every timed change: the same values, order and period (±15%).
  - Match the speed of every continuous loop.
- **Every captured width must match its own screenshots**, using the original's breakpoints at the same pixel values.
- **Nothing breaks between breakpoints:** check 800px and the midpoint between each pair of captured widths for:
  - no overlapping text;
  - no horizontal overflow (`document.documentElement.scrollWidth === innerWidth`);
  - marquees staying on one row.

## 2. Prove it
1. **Serve** your build on your port, for example `npx next build && npx next start -p <port>`.
2. **Capture your build** at the reference's widths: `npm run capture -- http://localhost:<port>/ --widths <the reference's captured list> --out captures/localhost/<name>`. If a width's step in your SUMMARY.md differs from the reference, capture that width again on its own with `--scroll-step <reference step>`.
3. **Compare:** `npm run compare -- <reference capture> <your capture>`, then read `compare/REPORT.md`.
4. **Iterate section by section,** using the worst steps first. Aim for under 10% mismatch on most step screenshots. Frames of real video never reach 0.

## 3. Report
- For each width: the full-page mismatch, and the median and worst step mismatch, taken from `compare/REPORT.md`.
- The in-between width checks: pass or fail.
- Each timed change: recreated, or skipped with the reason.
- What still differs, and why.

Only report what you measured. Stop your server when you finish.
