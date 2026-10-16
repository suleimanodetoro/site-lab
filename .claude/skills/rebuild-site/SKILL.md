---
name: rebuild-site
description: Rebuild a captured web page 1:1 as a private study copy, at every breakpoint and with its motion and timed changes, and prove the match with Site Lab's compare. Use when the user wants a clone or a faithful rebuild of a page.
---

# Rebuild a captured page

1. Make sure there's a capture. If there isn't, use the `capture-site` skill first. Write down the exact capture path.
2. Follow `docs/workflows/rebuild.md` step by step:
   1. read SUMMARY.md;
   2. build in `rebuilds/<host>/` with local assets only;
   3. match every width and every effect;
   4. serve the build on one fixed port;
   5. capture it at the reference's widths;
   6. compare;
   7. iterate on the worst steps first.
3. Report the measured numbers from `compare/REPORT.md` for each width, the in-between width checks, and each timed change, recreated or skipped. Stop your server.

Rebuilds stay private: never deploy or publish them (see `RESPONSIBLE-USE.md`).
