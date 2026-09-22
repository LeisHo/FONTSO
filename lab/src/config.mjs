// ====================================================================
// Font Path Laboratory — config.mjs
// ====================================================================
// EVERY tunable number in the pipeline lives here, in one object. No
// stage hard-codes a threshold of its own. This exists so the whole
// pipeline can later be re-tuned (or driven from a real settings UI)
// without hunting constants across nine modules.
//
// DEFAULTS ARE DELIBERATELY CONSERVATIVE ABOUT CLEANUP. The brief is
// explicit that a font's distinctive wobble/terminal/irregularity must
// survive into the skeleton, so simplification and smoothing default to
// values that remove rasterisation staircase and little else. Turning
// these up makes output prettier and less faithful — that trade is the
// user's to make, not the pipeline's.
// ====================================================================

export const DEFAULT_CONFIG = {
    // ---- Rasterisation ---------------------------------------------
    // Height, in raster pixels, allotted to the font's full em square.
    // This is the single biggest quality/CPU lever in the pipeline.
    //   ~128  — fast, loses hairlines and fine serifs
    //   ~256  — good default; a normal stem is ~20-30px wide, which
    //           thins cleanly and keeps terminal shape
    //   ~512  — slow (thinning is O(pixels) per pass and needs many
    //           passes), noticeably better on decorative/script faces
    rasterEmHeight: 256,

    // Blank border kept around the glyph in the mask. Zhang-Suen reads
    // a 3x3 neighbourhood, so foreground pixels must never sit on the
    // array edge. 4px also gives pruning room to work.
    rasterPadding: 4,

    // Canvas is anti-aliased; the mask is not. A pixel is foreground
    // when its coverage (alpha) is at least this, 0-255. 128 = "at
    // least half covered", which tracks the true outline closely.
    // Lower = fatter mask (keeps hairlines, adds fuzz on edges).
    alphaThreshold: 128,

    // ---- Skeletonisation -------------------------------------------
    // 'zhang-suen' | 'guo-hall'. See skeletonize.mjs for the trade-off:
    // Zhang-Suen is the predictable reference and behaves well on the
    // orthogonal stems and bowls that make up most Latin type; Guo-Hall
    // is usually thinner and cleaner on diagonals ('A', 'V', 'w',
    // script faces) at slightly higher risk of eroding short features.
    // Both are offered because the brief is explicit that the first
    // algorithm found should not be assumed to be the best one.
    thinningAlgorithm: 'zhang-suen',

    // Post-thinning removal of leftover "simple" pixels with 3+
    // neighbours (2x2 clumps and padded corners). These would otherwise
    // register as spurious junctions and manufacture micro-edges at
    // exactly the places the graph's topology matters most.
    removeRedundantPixels: true,

    // Safety valve only. Zhang-Suen terminates on its own when a full
    // iteration removes nothing; this just stops a pathological mask
    // from hanging the tab. A 256px glyph converges in well under 100.
    maxThinningIterations: 400,

    // ---- Cleanup ----------------------------------------------------
    // Drop skeleton pixels with zero 8-neighbours before graph
    // construction — but ONLY when their source mask region is also
    // below minSourceAreaPx. An unconditional version of this silently
    // deleted the dot of a Comic Sans 'i', which thins to exactly one
    // pixel; being isolated is not by itself evidence of being noise.
    removeIsolatedPixels: true,

    // A branch (edge with a degree-1 endpoint) shorter than this, in
    // raster pixels, is a spur — the classic thinning artifact where a
    // wide stroke terminal or a junction throws off a short whisker.
    // Scaled against rasterEmHeight so changing resolution doesn't
    // silently change how aggressive pruning is: the real threshold is
    // minBranchLengthPx * (rasterEmHeight / 256).
    //
    // TUNING WARNING: raise this past ~20 and real features start
    // dying — the crossbar stub on a lowercase 'f', the spur on a 'G',
    // the tail of a 'Q'. 12 removes staircase whiskers and keeps those.
    minBranchLengthPx: 12,

    // How many prune→rebuild rounds to run. One pass can expose a new
    // short spur underneath the one it removed (common at the junction
    // clusters inside 'B' and '&'), so this iterates to a fixed point.
    pruneIterations: 3,

    // Ramer-Douglas-Peucker tolerance, raster pixels, applied per
    // polyline. 0 disables. ~0.8 collapses the 1px staircase of a
    // diagonal run without touching real curvature.
    simplifyTolerancePx: 0.8,

    // Chaikin-style corner-cutting passes over each polyline. Each pass
    // is strongly shape-preserving but they compound.
    //   0 — raw, visibly jagged, maximally faithful
    //   1 — default; removes pixel-grid chatter, keeps wobble
    //   3+ — starts rounding off genuine sharp corners (the apex of
    //        'A', the spine junction of 'S')
    smoothingPasses: 1,

    // Per-pass blend toward the Chaikin quarter-points, 0..1.
    // 1.0 is textbook Chaikin; lower values move points less.
    smoothingStrength: 0.6,

    // Endpoints are never moved by smoothing when true. Terminals carry
    // a lot of a typeface's identity, and Chaikin otherwise erodes them
    // inward on every pass.
    preserveEndpointsWhileSmoothing: true,

    // ---- Graph ------------------------------------------------------
    // Junction pixels that touch each other are one conceptual node.
    // Thinning routinely leaves a 2-4 pixel clump where three strokes
    // meet; treating each pixel as its own node would manufacture a
    // handful of meaningless zero-length edges right where the graph
    // matters most.
    mergeAdjacentJunctions: true,

    // Discard a component whose SOURCE MASK REGION is smaller than this,
    // in mask pixels (area, not length). See labelMaskComponents() in
    // rasterize.mjs for why this is measured on the mask and not on the
    // skeleton: measured on Comic Sans at 256px, the dot of '?' leaves
    // 3.4px of centreline, '!' 3.8px, ':' 2.4px and 5.8px, and 'i' a
    // single pixel — indistinguishable from anti-aliasing noise by
    // length, but 2-3 orders of magnitude apart by area.
    //
    // 24 px^2 is ~a 5x5 blob: comfortably below any real dot at any
    // usable resolution, comfortably above any threshold artifact.
    // Scaled by resolution like the other pixel thresholds, quadratically
    // since it is an area.
    minSourceAreaPx: 24,

    // ---- Traversal ---------------------------------------------------
    // Emit explicit pen-up connector segments between the end of one
    // drawn segment and the start of the next. These are the hooks a
    // future traversal algorithm turns into real U-turns / travel moves.
    emitConnectors: true,

    // Resample every emitted polyline to roughly this spacing (raster
    // px) so the animator advances at constant speed instead of
    // sprinting through sparse straight runs. 0 disables resampling.
    traversalResampleSpacingPx: 2,
};

// Metadata for the debug panel and any future settings UI: label, unit,
// sane range, and — the part that actually matters — what goes wrong at
// each extreme. Kept beside the values so the two can't drift.
export const CONFIG_META = {
    rasterEmHeight: { label: 'Raster em height', unit: 'px', min: 64, max: 512, step: 32, note: 'Higher = more faithful, much slower.' },
    rasterPadding: { label: 'Raster padding', unit: 'px', min: 2, max: 16, step: 1, note: 'Must be >= 2 for the 3x3 thinning kernel.' },
    alphaThreshold: { label: 'Alpha threshold', unit: '0-255', min: 16, max: 240, step: 8, note: 'Lower = fatter mask.' },
    thinningAlgorithm: { label: 'Thinning algorithm', unit: 'enum', options: ['zhang-suen', 'guo-hall'], note: 'Guo-Hall is thinner on diagonals; Zhang-Suen is the predictable reference.' },
    removeRedundantPixels: { label: 'Remove redundant pixels', unit: 'bool', note: 'Off = spurious junctions from 2x2 clumps.' },
    maxThinningIterations: { label: 'Max thinning iterations', unit: 'passes', min: 20, max: 2000, step: 20, note: 'Safety valve; convergence is automatic.' },
    removeIsolatedPixels: { label: 'Remove isolated pixels', unit: 'bool', note: 'Pure noise removal.' },
    minBranchLengthPx: { label: 'Min branch length', unit: 'px @256', min: 0, max: 40, step: 1, note: 'Past ~20 real features start dying.' },
    pruneIterations: { label: 'Prune iterations', unit: 'rounds', min: 0, max: 8, step: 1, note: 'Spurs can hide under spurs.' },
    simplifyTolerancePx: { label: 'Simplify tolerance (RDP)', unit: 'px', min: 0, max: 4, step: 0.1, note: '0 = raw staircase.' },
    smoothingPasses: { label: 'Smoothing passes', unit: 'passes', min: 0, max: 6, step: 1, note: '3+ rounds off genuine corners.' },
    smoothingStrength: { label: 'Smoothing strength', unit: '0-1', min: 0, max: 1, step: 0.05, note: '1.0 = textbook Chaikin.' },
    preserveEndpointsWhileSmoothing: { label: 'Preserve endpoints', unit: 'bool', note: 'Protects terminals from erosion.' },
    mergeAdjacentJunctions: { label: 'Merge adjacent junctions', unit: 'bool', note: 'Off = spurious micro-edges at every crossing.' },
    minSourceAreaPx: { label: 'Min source area', unit: 'px^2', min: 0, max: 200, step: 4, note: 'Measured on the MASK, not the skeleton - that is what separates a dot from a speck.' },
    emitConnectors: { label: 'Emit connectors', unit: 'bool', note: 'Pen-up moves between segments.' },
    traversalResampleSpacingPx: { label: 'Traversal resample spacing', unit: 'px', min: 0, max: 10, step: 0.5, note: '0 = uneven animation speed.' },
};

export function makeConfig(overrides = {}) {
    return { ...DEFAULT_CONFIG, ...overrides };
}

// Pruning and component thresholds are authored at a 256px reference so
// that changing rasterEmHeight rescales the glyph WITHOUT also silently
// changing how much of it gets pruned away.
export function scaleForResolution(config, valuePx) {
    return valuePx * (config.rasterEmHeight / 256);
}
