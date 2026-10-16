---
name: capture-site
description: Capture a web page with Site Lab (layout at every breakpoint, computed styles, scroll motion, timed changes, hover, video, assets) and summarise what it found. Use when the user gives a URL to study, clone or take inspiration from.
---

# Capture a site

1. If `node_modules/` is missing, run `npm ci && npx playwright install chromium webkit`. Check `ffmpeg -version`; without ffmpeg, add `--no-video`.
2. Run `npm run capture -- <url>` in the background, redirecting the log to a file. Add options the user asked for:
   - `--widths 390,1440` for a faster capture;
   - `--no-video`, `--no-hover`, `--no-timeline`;
   - `--click "<css>"` to click something specific.
3. While it runs, follow the log. Stages print `start` and `end · <duration>`, and scroll stages print progress with time left. A full capture takes about 10–25 minutes.
4. Take the capture path from the log line `[site-lab] output <path>`, then read its `SUMMARY.md`.
5. Report to the user:
   - the result;
   - the consent and gate handling;
   - the breakpoints and widths captured;
   - the libraries;
   - notable scroll effects (the top effects) and timed changes;
   - whether the page doesn't scroll, and which input drove it;
   - any warnings that matter;
   - the capture path.

See `AGENTS.md` and `docs/reading-a-capture.md`. Never edit `tool/` while a capture runs.
