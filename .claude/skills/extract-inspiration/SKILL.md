---
name: extract-inspiration
description: Turn an effect from a captured site (scroll reveal, pinned story, rotating text, marquee, intro, hover) into an original, reusable component with a technique card, measured against the original. Use when the user wants to borrow a technique rather than clone a whole page.
---

# Extract a technique as your own component

1. Capture the page if it hasn't been captured, using the `capture-site` skill.
2. Follow `docs/workflows/inspiration.md`:
   1. find the effect in the videos and screenshots;
   2. measure it in `motion/effects-*.json`, `gsap.json`, `waapi.json`, `timed-changes-*.json` and `hover.json`;
   3. write `kit/<technique>/TECHNIQUE.md`;
   4. build an original component with props and a demo page, using your own content and assets only;
   5. check its motion numbers against the original with a capture and `npm run compare -- … --map`.
3. Report the technique card, the component's API and the measured match.
