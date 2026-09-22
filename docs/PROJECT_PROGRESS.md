# FONTSO — Project Progress

**This is a live document, not a log.** It holds only the current picture —
what's being worked on right now, what's recently done, and what's next. The
full history lives in `CHANGELOG.txt` (append-only, authoritative). Rewrite
the sections below in place at each real update; don't append dated blocks.

A brand-new session should be able to read this file alone and know exactly
where the project stands.

--------------------------------------------------------------------------------

## Currently working on

Nothing in progress — see What's next.

## Recently completed

- **Font Path Laboratory (`lab/`)** — the working geometry prototype, and the
  actual point of this project. Answers "can arbitrary font glyphs be turned
  automatically into drawable centreline paths?" with a measured yes. Full
  pipeline: outline → raster mask → thinning → skeleton graph → cleanup →
  vector paths → traversal → visualiser + animator. Verified across 8 fonts ×
  8 characters (64 runs, zero errors). Run it with
  `python scripts/active/serve.py 8420`, open `/lab/index.html`.
- **Dev panel adopted by the laboratory.** Every lab control (7 groups,
  ~30 controls covering all 17 config values, plus layers, animation,
  the pipeline report and the debug JSON) now lives in the
  workspace-standard dev panel. The old bespoke side panel is gone and
  the canvas is full-bleed. This resolves the open question that used to
  sit in this section.
- **Blank HTML scaffold (root)** — still present and verified, still
  unused by the lab. It holds the *other* copy of the dev panel plus the
  UI Layout Engine, which the lab does not need (one layout element).

## What's next

Nothing is required — the feasibility question has been answered. If work
continues, in rough value order:

1. **Distance-transform-weighted centring.** Single highest-value change: it
   fixes both known geometric defects at once (terminals eroded inward by
   thinning, junction nodes displaced to a pixel-clump centroid).
2. **Curvature-based stroke continuation through junctions**, so a bowl reads
   as one stroke instead of several edges. Currently the traversal only
   compares initial headings.
3. **Serif-branch classification**, so a consumer can ask for "the stem"
   rather than receiving all 13 segments of a Times 'H' undifferentiated.
4. **Bézier fitting per polyline** for a compact, resolution-free output.
5. **Real U-turn generation** — turn `backtrack` connectors into moves that
   follow the existing stroke instead of cutting straight across.

## Open questions / blockers

- **Two copies of the dev panel now exist** (`src/devpanel/devPanel.js`
  for the root scaffold, `lab/devpanel.js` for the laboratory). This is
  deliberate — it keeps `lab/` liftable into another project as a whole —
  but both must be re-copied when the shared template changes. If the
  root scaffold is ever deleted, this stops being a consideration.
- No technical blockers.
