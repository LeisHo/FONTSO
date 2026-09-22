# Font Path Laboratory

A feasibility prototype answering one question: **can an arbitrary font
glyph be converted automatically into a usable drawable centreline
path?** Load any `.ttf`/`.otf`, pick a character, and watch the glyph go
through the full pipeline to a traversable, animatable route.

Nothing about any individual letter is hand-authored. There is no stroke
font, no per-character table, no hard-coded path. Every skeleton is
derived from the supplied font's own outline at runtime.

## Run it

```bash
python scripts/active/serve.py 8420
```

Open <http://localhost:8420/lab/index.html>.

`python -m http.server` will **not** work — it serves `.mjs` as
`text/plain` and browsers reject that for ES modules. Same reason
`file://` won't work.

**Every control lives in the workspace-standard dev panel** (`CLAUDE.md`
§12); the canvas is full-bleed underneath it. The panel shows on
`localhost`, `127.0.0.1`, `file://`, or with `?dev=1` — never to a normal
visitor. Press **D** to hide/show, **R** to reset, **Ctrl+Z** to undo; it
is draggable, resizable and collapsible.

Groups: **Font & Character**, **Layers**, **Path**, **Path Tween**, **Animation**,
**Rasterisation**, **Skeletonisation**, **Cleanup**, **Traversal**, plus
the built-in **Dev Panel** (its own styling) and **Debug** (Mouse Log,
Pipeline Report, Path Data JSON). All 17 pipeline parameters are exposed.

## What to look at first

1. **Comic Sans, `H`.** One green centreline per stem — not two lines
   tracing each stem's edges. That distinction is the whole point. Note
   the crossbar centreline *wobbles*: Comic Sans's crossbar isn't
   straight, and neither is its skeleton.
2. **Times New Roman, `H`.** Same code, same character, **13 segments
   instead of 5** — the skeleton branches out into every serif, with an
   endpoint marker on each serif tip. This is the clearest evidence the
   output is derived from the actual glyph rather than an idealised
   letterform.
3. **`O`.** One closed loop, zero endpoints, zero junctions. The graph
   models a ring as a ring.
4. **`?` or `i`.** Two components — the dot is preserved as its own
   piece, with a dashed pen-up connector showing how the route reaches
   it.
5. **Gabriola, `S`.** A decorative face reduced to one elegant spine.
6. Turn on **Raw skeleton (px)** and **Pre-cleanup polylines** to see
   exactly what cleanup removed, then drag **Min branch length** up and
   watch real features start dying.
7. **Path** group: tick *Path Thickness On/Off* to render the centreline
   as a real stroke at a chosen width and colour instead of a 2px line.
   Tick *Progressive Thickness* too and press Play — the path then inks
   in behind the dot, leaving the untravelled remainder thin.
8. **Path Tween** group: tick it on and drag *Tween Progression* from 0
   to 1. At 0 the orange curves sit on the centreline; at 1 they land on
   the glyph outline; in between they morph. Turn the *Cleaned Skeleton*
   layer off at progression 1 to check how closely they track the real
   outline — the gap at the rounded terminals is thinning erosion, and
   *Extend Terminals* is the control for it.

## Architecture

Ten modules, one stage each. `pipeline.mjs` is the only file that knows
the order; no stage imports another stage.

| Stage | Module | Does |
|---|---|---|
| 0 | `fontLoader.mjs` | Parse TTF/OTF, extract names/metrics |
| 1 | `glyphExtract.mjs` | Character → real outline commands + contours |
| 2 | `rasterize.mjs` | Outline → binary mask (+ mask component labelling) |
| 3 | `skeletonize.mjs` | Mask → 1px skeleton (thinning) |
| 4 | `skeletonGraph.mjs` | Skeleton → nodes + edges + components |
| 5 | `cleanup.mjs` | Prune spurs, drop specks, simplify, smooth |
| 6 | `vectorize.mjs` | Graph → path segments in px **and** font units |
| 7 | `traversal.mjs` | Graph → ordered route with explicit connectors |
| — | `distanceTransform.mjs` | Exact Euclidean DT — the local half-thickness |
| — | `tween.mjs` | Centreline → outline morph, and its animation route |
| — | `config.mjs` | Every tunable number, with tuning notes |
| — | `viz/renderer.mjs`, `viz/animator.mjs`, `app.mjs` | Visualisation |

`window.fontLab` is exposed for console work: `fontLab.runPipeline(font,
'S', {...config})` returns the whole result object.

## Libraries

**opentype.js 2.0.0 (MIT), vendored** into `lib/`. It is the only
dependency. No browser API exposes a glyph's vector outline — `fillText`
gives pixels, which would discard the contours, font units and metrics
the pipeline reports. opentype.js parses TTF/OTF/WOFF directly and
returns real contours.

*The minified build is vendored deliberately.* The 494KB unminified one
was intermittently truncated by the local static server (`200 OK` plus
`net::ERR_CONNECTION_RESET`), silently breaking the whole module graph.

**Everything else is hand-written**, because the alternatives don't fit:
image-processing skeletonisation libraries are OpenCV bindings or Node
packages expecting `Buffer`/`Mat`, and thinning is ~60 lines. Canvas
does the rasterising — the browser already implements nonzero winding
correctly, which is what makes counters come out hollow.

## Skeletonisation method

**Iterative morphological thinning**, with two algorithms selectable at
runtime:

- **Zhang-Suen** (default) — the standard reference. Predictable on the
  orthogonal stems and bowls that make up most Latin type.
- **Guo-Hall** — usually thinner and cleaner on diagonals (`A`, `V`,
  `w`, script faces), slightly likelier to erode short features.

A **true medial axis** (Voronoi of the outline) would be the
mathematically "correct" object, and was rejected deliberately: it is
notoriously unstable, spawning a branch for every small bump on the
boundary. Real font outlines are full of overshoots, ink traps and
control-point wobble, so an exact medial axis needs *more* pruning than
a thinned raster, not less. Raster thinning is coarser but inherently
regularised by the pixel grid.

Two non-obvious details matter a great deal, both found by measurement:

- **Pixels are classified by crossing number, not neighbour count.** A
  diagonal staircase corner has three neighbours but is not a junction.
  Counting neighbours reported 23 junctions for an `O` (which has none)
  and 3 endpoints for an `H` (which has four).
- **Redundant pixels are removed by counting connected groups among a
  pixel's neighbours**, not by ring transitions. Ring order says `N` and
  `W` are far apart; in reality they touch.

## The centreline → outline tween

Each skeleton edge produces **two** curves, offset perpendicular to the
path by `progression × local half-thickness`. The half-thickness comes
from an exact Euclidean distance transform of the mask (Felzenszwalb's
linear-time separable algorithm) sampled at each centreline point — that
value *is* the inscribed-circle radius, i.e. exactly how far the
centreline must travel to reach the outline. Measured on Comic Sans `H`
at the 256px default: 12.00px at a stem centre, against a ~24px stem.

An approximate chamfer distance transform was rejected: its error is
direction-dependent, which would read on screen as the tween drifting
off the outline on diagonals but not on stems — visible, and impossible
to tune away.

**Where progression = 1 is not exact**, and which control addresses it:

| Where | Why | Control |
|---|---|---|
| Terminals | Thinning erodes stroke ends inward, so the radius is measured short of the true tip | *Extend Terminals (Px)* |
| Junctions | The medial axis is genuinely ambiguous where strokes meet; the inscribed circle is larger than either stroke's half-width, so the offset overshoots | *Radius Smoothing* |
| Sharp corners | The offset self-intersects on the inner side | *Join Intersecting Curves* welds an unambiguous crossing; genuinely ambiguous ones are left visible |
| Systematically | The skeleton derives from a thresholded raster and sits a fraction inside the true outline | *Radius Scale (X)* — nudge to ~1.05 |

The tween is **render-only**: the distance transform is computed once per
pipeline run (5.2ms) and cached, so dragging any tween control re-offsets
the existing polylines and redraws. It never re-rasterises or re-thins.

**Join Intersecting Curves** welds two offset curves that cross, trimming
the overshoot past the crossing — the mitre an offset needs at a junction.
It fires only when a curve crosses **exactly one** other curve, and the
pairing must be mutual. At a degree-3 junction each curve crosses two
others and there is no single correct weld, so those are declined and
counted (the count is in the debug JSON) rather than silently mangled.
Measured on Comic Sans `H` at progression 1: 2 welds at the stem/crossbar
junctions, 4 crossings declined, 10 polylines reduced to 8. At low
progression there are no crossings yet and nothing is welded.

**Animation Path** (in the Animation group) switches the dot between the
midline and the tween geometry. On Comic Sans `H` that is a 625.6px route
versus 1721px, since the tween has two curves per segment.

## Known limitations

1. **Thinning nibbles stroke ends.** Terminals sit slightly inside the
   true outline. Inherent to morphological thinning; a medial-axis or
   distance-transform approach would not have it.
2. **Junction geometry is approximate.** Where strokes meet, the merged
   node sits at the centroid of a pixel clump. Good enough to be right
   topologically, a pixel or two off geometrically.
3. **Serifs produce many short branches.** Correct — they *are* branches
   — but a future consumer wanting "the stem" will need to classify
   serif branches rather than take the graph at face value.
4. **Very high `rasterEmHeight` is slow.** 512px is several hundred ms.
   Thinning is O(pixels) per pass over many passes.
5. **Traversal is deliberately naive.** Deterministic DFS with a
   straightest-continuation rule. It is *not* handwriting stroke order,
   and does not try to be.
6. **Hairline/very light faces at low resolution** can break a stroke
   into pieces if it thresholds to under ~2px. Raise `rasterEmHeight`.
7. **Not tested on non-Latin scripts**, variable-font instances, or
   colour/bitmap fonts.
8. **`i`'s dot is a zero-length segment.** Honest — a dot has position,
   not a stroke — but a consumer must handle `lengthPx === 0`.

## Next steps

**Skeleton quality**
- Distance-transform-weighted centring to correct the junction
  displacement in (2) and the terminal erosion in (1).
- Extend terminals back out to the outline along their own direction.
- Classify serif branches so a consumer can ask for "the stem" or "the
  full skeleton".
- Fit cubic Béziers to each polyline for a compact, resolution-free
  representation.

**Traversal quality**
- Stroke continuation *through* junctions by curvature, not just initial
  heading, so a bowl reads as one stroke.
- Chinese-postman-style edge covering to minimise retracing.
- Turn `backtrack` connectors into real U-turns that follow the existing
  stroke rather than cutting straight across.
- Script-aware ordering (top-to-bottom, left-to-right stroke priors).

## Test fonts

`test-fonts/` holds OS faces copied in for comparison; they are
gitignored (not redistributable) but `manifest.json` is tracked, so the
dropdown degrades to "none found" elsewhere. The file picker always
works.

Verified across 8 faces × 8 characters (`A H S O B g & ?`) — 64 runs,
zero errors, zero incomplete traversals: Arial, Times New Roman,
Georgia, Courier Std (OTF/CFF cubic outlines), Comic Sans MS, Ink Free,
Segoe Script, Gabriola.
