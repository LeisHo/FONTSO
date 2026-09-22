// ====================================================================
// Stage 3 — Skeletonisation / thinning (binary mask -> 1px skeleton)
// ====================================================================
// This is the stage the whole prototype exists to test: does iterative
// morphological thinning of a real glyph's filled mask produce a
// centreline that still looks like THAT font's letter?
//
// WHY THINNING AND NOT A TRUE MEDIAL AXIS
// A mathematically exact medial axis (from the Voronoi diagram of the
// outline) is the "correct" object here, and it is beautiful on clean
// input — but it is famously unstable: every tiny bump on the boundary
// spawns a whole medial branch. On real font outlines, which are full
// of small overshoots, ink traps and control-point wobble, an exact
// medial axis produces a hairball that needs MORE pruning than a
// thinned raster does, not less. Iterative thinning on a raster is
// coarser but inherently regularised by the pixel grid, and it is
// trivially browser-portable with no geometry library. For a
// feasibility prototype that is the right trade. (A Voronoi medial axis
// is the obvious "next step" if raster artifacts ever become the
// limiting factor — see the README.)
//
// TWO ALGORITHMS ARE PROVIDED, because the brief explicitly says not to
// assume the first algorithm found is the best one, and because they
// genuinely differ on glyph input:
//
//   zhang-suen — the classic. Very well behaved on thick, roughly
//                orthogonal strokes (stems, bars, bowls), which is most
//                Latin type. Its known weaknesses: it nibbles the ends
//                of strokes slightly, and on near-45-degree runs it can
//                leave a visible staircase.
//
//   guo-hall   — usually yields a thinner, better-centred result with
//                fewer staircase artifacts on diagonals, which shows up
//                on 'A', 'V', 'w', and on script faces. It is slightly
//                more prone to eroding very short features.
//
// Default is zhang-suen (predictable, the reference everyone knows);
// guo-hall is one dropdown away for comparison on a given face.
// ====================================================================

export const THINNING_ALGORITHMS = ['zhang-suen', 'guo-hall'];

// Neighbour order used by both algorithms:
//   p9 p2 p3
//   p8 P1 p4
//   p7 p6 p5
// Offsets are resolved against the row stride once per call.
function neighbourOffsets(width) {
    return [
        -width,      // p2  N
        -width + 1,  // p3  NE
        1,           // p4  E
        width + 1,   // p5  SE
        width,       // p6  S
        width - 1,   // p7  SW
        -1,          // p8  W
        -width - 1,  // p9  NW
    ];
}

// A(P1): number of 0 -> 1 transitions walking the ring p2..p9,p2.
// Equal to 1 exactly when the pixel is "simple" — i.e. removing it
// cannot disconnect its own neighbourhood. This single test is what
// keeps thinning from breaking a stroke in half.
function transitions(n) {
    let count = 0;
    for (let i = 0; i < 8; i++) {
        if (n[i] === 0 && n[(i + 1) & 7] === 1) count++;
    }
    return count;
}

function neighbourCount(n) {
    let c = 0;
    for (let i = 0; i < 8; i++) c += n[i];
    return c;
}

export function skeletonize(mask, width, height, config) {
    const algorithm = config.thinningAlgorithm || 'zhang-suen';
    const work = Uint8Array.from(mask);
    const offsets = neighbourOffsets(width);
    const n = new Uint8Array(8);
    const doomed = [];

    let iterations = 0;
    let removedTotal = 0;
    let converged = false;

    // Border pixels are never candidates: config.rasterPadding guarantees
    // no foreground can reach them, so skipping the range check inside
    // the hot loop is safe as well as fast.
    for (; iterations < config.maxThinningIterations; iterations++) {
        let removedThisIteration = 0;

        for (let step = 0; step < 2; step++) {
            doomed.length = 0;

            for (let y = 1; y < height - 1; y++) {
                const row = y * width;
                for (let x = 1; x < width - 1; x++) {
                    const i = row + x;
                    if (!work[i]) continue;

                    for (let k = 0; k < 8; k++) n[k] = work[i + offsets[k]];

                    const b = neighbourCount(n);
                    // b < 2 -> an endpoint or isolated pixel; never
                    // remove, or strokes would evaporate from the tips
                    // inward. b > 6 -> deep interior, not yet a boundary.
                    if (b < 2 || b > 6) continue;
                    if (transitions(n) !== 1) continue;

                    const [p2, p3, p4, p5, p6, p7, p8, p9] = n;
                    let remove;
                    if (algorithm === 'guo-hall') {
                        remove = guoHallCondition(step, p2, p3, p4, p5, p6, p7, p8, p9);
                    } else {
                        remove = step === 0
                            ? (p2 * p4 * p6) === 0 && (p4 * p6 * p8) === 0
                            : (p2 * p4 * p8) === 0 && (p2 * p6 * p8) === 0;
                    }
                    if (remove) doomed.push(i);
                }
            }

            // Deletions are applied only AFTER the whole sub-iteration
            // has been evaluated. Deleting in-place mid-scan would let
            // one removal change its neighbour's test result, which
            // breaks the algorithm's connectivity guarantee and is the
            // most common way a hand-rolled thinner ends up severing
            // strokes.
            for (let k = 0; k < doomed.length; k++) work[doomed[k]] = 0;
            removedThisIteration += doomed.length;
        }

        removedTotal += removedThisIteration;
        if (removedThisIteration === 0) {
            converged = true;
            break;
        }
    }

    // Post-pass: both algorithms can leave the odd redundant pixel where
    // strokes meet (a 2x2 clump, or a pixel padding out a corner). Each
    // such pixel would otherwise register as a spurious junction in the
    // graph, manufacturing meaningless zero-length edges at exactly the
    // places that matter most. Only "simple" pixels (A==1) with 3+
    // neighbours are removed, so connectivity and endpoints are safe.
    const redundantRemoved = config.removeRedundantPixels === false
        ? 0
        : removeRedundantPixels(work, width, height, offsets);

    let skeletonPixels = 0;
    for (let i = 0; i < work.length; i++) if (work[i]) skeletonPixels++;

    return {
        skeleton: work,
        width,
        height,
        algorithm,
        iterations,
        converged,
        removedTotal,
        redundantRemoved,
        skeletonPixels,
    };
}

// Guo-Hall's two sub-iteration conditions, in the same p2..p9 ring.
// Expressed with the paper's own C/N1/N2/N terms so it can be checked
// against the source rather than taken on trust.
function guoHallCondition(step, p2, p3, p4, p5, p6, p7, p8, p9) {
    const C = ((!p2) & (p3 | p4)) + ((!p4) & (p5 | p6)) + ((!p6) & (p7 | p8)) + ((!p8) & (p9 | p2));
    if (C !== 1) return false;
    const N1 = (p9 | p2) + (p3 | p4) + (p5 | p6) + (p7 | p8);
    const N2 = (p2 | p3) + (p4 | p5) + (p6 | p7) + (p8 | p9);
    const N = Math.min(N1, N2);
    if (N < 2 || N > 3) return false;
    const m = step === 0
        ? ((p6 | p7 | (!p9)) & p8)
        : ((p2 | p3 | (!p5)) & p4);
    return m === 0;
}

// True 8-adjacency between two ring positions, precomputed from the
// offsets rather than assumed from ring order. This distinction is the
// whole point of the function below, and it is easy to get wrong:
// N and W are TWO apart in ring order yet genuinely touch, while NE and
// SE are also two apart and do not.
const RING_DELTAS = [
    [0, -1], [1, -1], [1, 0], [1, 1],
    [0, 1], [-1, 1], [-1, 0], [-1, -1],
];
const RING_ADJACENT = RING_DELTAS.map(([ax, ay]) =>
    RING_DELTAS.map(([bx, by]) =>
        (ax !== bx || ay !== by) && Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1 ? 1 : 0,
    ),
);

// Removes REDUNDANT pixels: ones whose neighbours are all still
// mutually connected without them, so deleting them cannot change the
// skeleton's topology — only its thickness at corners.
//
// THE TEST IS "how many connected groups do my neighbours form", NOT
// the ring-transition count. An earlier version used transitions()==1
// and it measurably missed the common case. Concretely, from Comic Sans
// 'H' at 256px, pixel (156,20) near the top-right terminal:
//
//       . # .        neighbours are N, W and SW. N touches W
//       # P .        (they are diagonal to each other), W touches SW,
//       # . .        so all three form ONE group -> P is redundant.
//
// Its ring-transition count is 2, because N and W are not ADJACENT
// POSITIONS IN THE RING even though they are adjacent pixels — so the
// old test kept it. The tracer, meanwhile, correctly walked straight
// past it (W and N connect directly), leaving it orphaned, which then
// spawned a phantom 'loop-anchor' node and a bogus 1px edge at the tip
// of the stem. Every glyph tested showed exactly one of these.
//
// Counting real connected groups fixes it, and is also strictly safer:
//   - straight run (W,E)          -> 2 groups -> kept
//   - diagonal run (NW,SE)        -> 2 groups -> kept
//   - real 3-way junction         -> 3 groups -> kept
//   - endpoint (1 neighbour)      -> excluded by the count >= 2 guard
//   - corner / 2x2 clump          -> 1 group  -> removed
function removeRedundantPixels(work, width, height, offsets) {
    const n = new Uint8Array(8);
    let removed = 0;

    // Iterate: removing one corner pixel can expose the next along a
    // staircase. Converges in very few passes; the cap is a safety net.
    for (let pass = 0; pass < 8; pass++) {
        let removedThisPass = 0;
        for (let y = 1; y < height - 1; y++) {
            const row = y * width;
            for (let x = 1; x < width - 1; x++) {
                const i = row + x;
                if (!work[i]) continue;
                for (let k = 0; k < 8; k++) n[k] = work[i + offsets[k]];
                // Never touch an endpoint or an isolated pixel: removing
                // one shortens a real stroke instead of thinning it.
                if (neighbourCount(n) < 2) continue;
                if (neighbourGroupCount(n) !== 1) continue;
                // Applied immediately, not batched: each decision must
                // see the previous removal, so a 2x2 clump loses exactly
                // one pixel rather than all four independently deciding
                // they are individually removable and erasing the lot.
                work[i] = 0;
                removedThisPass++;
            }
        }
        removed += removedThisPass;
        if (removedThisPass === 0) break;
    }
    return removed;
}

// Connected groups among the present ring cells, using RING_ADJACENT.
function neighbourGroupCount(n) {
    const seen = new Uint8Array(8);
    let groups = 0;
    const stack = [];
    for (let s = 0; s < 8; s++) {
        if (!n[s] || seen[s]) continue;
        groups++;
        seen[s] = 1;
        stack.length = 0;
        stack.push(s);
        while (stack.length) {
            const k = stack.pop();
            for (let m = 0; m < 8; m++) {
                if (n[m] && !seen[m] && RING_ADJACENT[k][m]) {
                    seen[m] = 1;
                    stack.push(m);
                }
            }
        }
    }
    return groups;
}
