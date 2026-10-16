# Site Lab

**Capture any web page in enough detail to rebuild it 1:1, then let your coding agent do the rebuilding.**

Point it at a URL. It loads the page in a real browser and records:
- the layout at every breakpoint the CSS defines;
- computed styles and design tokens;
- scroll-driven motion, measured step by step, with eases and pins;
- things that change on their own: rotating text, tickers and counters;
- hover states;
- videos of the intro (slowed to 0.1×) and a scroll tour;
- every asset.

Then hand the capture to Claude Code, Codex or any coding agent to rebuild the page, or to pull out the one effect you loved, and compare the result back against the original, pixel by pixel.

```sh
npm ci && npx playwright install chromium webkit     # plus ffmpeg for video
npm run capture -- https://example.com/
```

## What it handles
- **Breakpoints:** discovered from CSS (including cross-origin stylesheets), `<link media>` and `matchMedia` calls, with one layout per breakpoint.
- **Smooth scroll and GSAP:** Lenis, Locomotive and GSAP ScrollTrigger are driven properly, so the motion measurements are real.
- **Cookie banners:** refused (never accepted), or hidden if there's no option to refuse.
- **Enter screens:** "Enter" splash gates are clicked through, and the gate itself is screenshotted.
- **Pages that don't scroll:** WebGL scenes and full-screen reels are driven by wheel, keys or drag, whichever moves the page.
- **Timed changes:** text swaps, stacked phrases that take turns, CSS keyframe tickers and continuous loops are detected, with their values and periods.
- **Parallel captures:** several captures can run at once without spoiling each other's measurements.
- **Fault tolerance:** bugs in the page's own scripts never stop a capture.

## Use it with your agent
- **[AGENTS.md](AGENTS.md):** the operating manual. Codex, Cursor and others read it automatically, and Claude Code reads it through `CLAUDE.md`.
- **Claude Code skills** in `.claude/skills/`:
  - `capture-site`: capture and summarise a page.
  - `rebuild-site`: rebuild a captured page 1:1 and prove it with a comparison.
  - `extract-inspiration`: turn a captured effect into your own reusable component.
- **Workflows** to paste into any agent:
  - [docs/workflows/rebuild.md](docs/workflows/rebuild.md)
  - [docs/workflows/inspiration.md](docs/workflows/inspiration.md)

An example prompt:

> Capture https://example.com/ with Site Lab, then rebuild it in `rebuilds/example.com` following docs/workflows/rebuild.md, and report the comparison numbers for every width.

## Commands

| Command | What it does |
|---|---|
| `npm run capture -- <url> [options]` | Capture into `captures/<host>/<date>/`. |
| `npm run compare -- <captureA> <captureB>` | Pixel and motion comparison, written to `<captureB>/compare/REPORT.md`. |
| `npm run fix-names -- <captureDir>` | Fix asset file types in old captures. |
| `npm test` | Typecheck, the unit tests, and the end-to-end suite against a local fixture page. |

The main options:
- `--widths auto|390,1440`
- `--no-video`, `--no-hover`, `--no-timeline`, `--no-assets`
- `--click "<css>"`
- `--no-gate`
- `--no-consent-dismiss`
- `--hide "<css>"`
- `--engines chromium,webkit`
- `--out <dir>`

[docs/specs/capture-tool.md](docs/specs/capture-tool.md) lists every option, and [docs/reading-a-capture.md](docs/reading-a-capture.md) explains every output file.

## Requirements
- **Node 20+.**
- **Playwright's Chromium and WebKit:** `npx playwright install chromium webkit`.
- **ffmpeg and ffprobe, for video:**
  - macOS: `brew install ffmpeg`.
  - Debian/Ubuntu: `sudo apt install ffmpeg`.
  - Or set `FFMPEG_PATH` and `FFPROBE_PATH`.
  - Or skip video with `--no-video`.
- Tested on macOS. Linux should work. Windows is untested.

## Layout

| Folder | Contents |
|---|---|
| `tool/` | The capture, compare and analysis code, plus tests and local fixtures. |
| `captures/` | Captures; git-ignored. |
| `rebuilds/` | Your study rebuilds; git-ignored. |
| `kit/` | Original, reusable components you make from what you learn. |
| `docs/` | The capture format, workflows and tool spec. |
| `.claude/skills/` | Claude Code skills. |

## Responsible use
Study copies stay private. Borrow techniques, not identity. Never ship other people's assets or copy. See [RESPONSIBLE-USE.md](RESPONSIBLE-USE.md).

## Licence
MIT. See [LICENSE](LICENSE).
