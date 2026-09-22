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

Groups: **Font & Character**, **Text**, **Layers**, **Path**, **Path Tween**, **Animation**,
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

## Whole strings, not just single letters

The **Text** group's *Display Text* box takes any string. A single
character is not a special case — it is the one-character case of the
same path.

The layout happens at **extraction**: every glyph's outline is placed
along the baseline using the font's own advance widths and kerning, and
the combined path is handed to rasterisation as one shape. Everything
downstream is untouched — thinning, the graph, cleanup, traversal and
the animator all behave exactly as they do for one letter, and separate
letters simply fall out as separate graph components, which is what they
are. A joining script face whose letters physically touch merges into
one component, which is the honest answer rather than a special case.

*Use Kerning* and *Letter Spacing (Font Units)* are the two real knobs
that layout has, so they are controls rather than buried constants.

**A kerning bug in opentype.js 2.0.0 is worked around here.**
`font.getKerningValue()` is implemented so that a font with GPOS kerning
tables takes the GPOS path and never falls back to the parsed pair
table. Measured on the real files in `test-fonts/`: Arial parses **909**
kerning pairs and Times **867**, yet `getKerningValue()` returns 0 for
A/V, T/o and Y/o in both — while `font.kerningPairs['36,57']` (A,V in
Arial) holds **-152**. Every string rendered completely unkerned.
`kernBetween()` in `glyphExtract.mjs` consults the pair table when the
official accessor yields nothing. With it, `AVAVAV` in Arial tightens by
-152 per pair (-760 total advance, 1031px → 936px raster). Comic Sans
genuinely has no kern data at all and correctly stays unkerned.

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

**Join Intersecting Curves** welds offset curves that cross, trimming
the overshoot past the crossing. **Every** crossing is welded; welding is
iterative, so a polyline produced by one weld is a candidate for the
next, which is how multi-way junctions resolve without a special case.
Measured on Comic Sans `H` at progression 1: **6 welds, 0 declined, 10
polylines reduced to 4**. At low progression nothing has crossed yet and
nothing is welded.

**Corner sharpness is measured, not assumed.** At each weld the angle
between the incoming and outgoing directions is computed — 180° means
the curves run straight through each other, 90° a square corner, 0° a
stroke doubling back. A sharp mitre is right for an open corner and
catastrophic for an acute one, where the mitre point shoots away from
the glyph.

| Control | Does |
|---|---|
| *Join Style* | `auto` decides per corner from its angle; `sharp`/`round`/`bevel` force one |
| *Join Sharp Angle Threshold (Deg)* | in `auto`, at or above this stays sharp; below is softened |
| *Join Corner Radius (Px)* | cut-back along each leg when rounding or bevelling |
| *Join Miter Limit (X)* | caps a sharp corner; past it, falls back to bevel |

On Comic Sans `H` the six corners measure 91.5°, 95.7°, 102.4°, 105.4°,
167.4° and 177.9°. At threshold 60 all stay sharp; at 120 the four
square-ish ones round while the two near-straight ones stay sharp — the
threshold does exactly what the measured angles predict.

**Nearest-Curve Routing** (Traversal group, on by default) decides which
piece to draw next by proximity to the pen rather than by a fixed
reading order, and enters it at its closest point. Greedy
nearest-neighbour — not a global optimum, but it removes the long
pointless hops a fixed order produces. Measured on Comic Sans `Hello`:
midline pen-up travel **1022.1px → 658.6px** (-36%); tween route
**1923.2px → 785.5px** (-59%, from 38.8% of the route down to 20.6%).

A closed curve is simply rotated to start at the nearest point. An
**open** curve entered in the middle would leave a tail, so it is drawn
as two runs joined by a backtrack connector (entry → near end, back,
→ far end): the whole curve is covered and the hop is still the shortest
available. That is why the tween route's run count rises from 19 to 27
on `Hello` while the curve count stays at 19.

**Animation Path** (in the Animation group) switches the dot between the
midline and the tween geometry. On Comic Sans `H` that is a 625.6px route
versus 1721px, since the tween has two curves per segment.

## Saving imported fonts (CLAUDE.md §12l)

Sync writes the dev panel's state to the git-tracked settings file **and
commits every imported font that is not already there**, so a font comes
back after a reload or on another machine. Fonts are committed as their
own files under `data/processed/fonts/`, never embedded in the settings
JSON: a 1.8MB face is ~2.4MB of base64, and Sync rewrites the whole
settings document each time, so embedding would mean a fresh
multi-megabyte git object per save.

A second Sync uploads nothing — fonts already committed are skipped,
which matters because each upload is a commit.

`serve.py` now implements `/api/save-settings` itself. It previously
404'd on localhost, because that file is a static server and
`api/save-settings.js` is a Vercel function — so Save could only ever
reach the endpoint on a deployment, not where the work happens.

**The token is read from the environment only** — never from a file,
never logged, never echoed in a response:

```bash
GITHUB_TOKEN=... GITHUB_REPO=owner/repo python scripts/active/serve.py 8420
```

Without it the endpoint returns a clear 503 and the browser falls back
to localStorage, which is the documented default rather than a failure.

**Licensing:** imported faces are often OS fonts that are not
redistributable. The repo is private, so this is a personal backup —
prune `data/processed/fonts/` before making it public.

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
