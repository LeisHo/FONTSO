// ====================================================================
// Adaptive stroke width — thickness taken from the glyph, not a slider
// ====================================================================
// Turns a polyline into a variable-width RIBBON whose edges sit on the
// glyph's own outline, using the distance transform that the pipeline
// already computes. The distance field holds, at every pixel, the
// distance to the nearest outline — which is exactly the half-width a
// stroke would need there to touch it.
//
// TWO MODES, because the two paths sit in different places:
//
//   'both'    — for the MIDLINE. The centreline runs down the middle of
//               the stroke, so the nearest outline is the same distance
//               away on either side: offset by ±d along the normal and
//               both edges land on the glyph. Full width = 2d, which is
//               the local stroke thickness by definition.
//
//   'span'    — for a TWEEN curve. That curve has been pushed off the
//               centreline toward one side, so it is not equidistant and
//               d only reaches the NEAR outline. The ribbon therefore
//               grows outward by d AND inward to the far outline, so one
//               travelled curve inks the full local stroke width.
//
//               It reached outward only until 2026-09-23. That matched
//               the original "reach the adjacent side" wording, but left
//               the core between a stroke's left and right curves never
//               inked - a dark seam down every stroke, widening into
//               notches at junctions where the two curves diverge. That
//               seam was what read as "thinner at the transitions".
//
// WHY THE OUTWARD DIRECTION COMES FROM THE FIELD GRADIENT, NOT FROM
// WHICHEVER SIDE THE TWEEN USED. The gradient of a distance field points
// directly away from the nearest boundary, so -grad is the shortest way
// to it — true regardless of how the point got there, which keeps this
// module independent of tween.mjs and correct for a welded curve whose
// vertices came from two different parents and no longer share a side.
// It is only ill-conditioned ON the medial axis, where the nearest
// boundary is genuinely ambiguous (the ridge), and that is exactly the
// case 'both' handles instead. Below GRADIENT_FLOOR the point is treated
// as being on the ridge and falls back to the tangent normal, which at
// least keeps the ribbon continuous rather than letting it flip sides.
// ====================================================================

import { sampleDistance } from './distanceTransform.mjs';

// |grad| of a true Euclidean distance field is 1 almost everywhere. A
// measured magnitude well under that means the sample straddles a ridge
// where two boundaries are equidistant and the direction is meaningless.
const GRADIENT_FLOOR = 0.35;

// Half a pixel each side. Smaller than this and the two samples land in
// the same cell and the difference is pure quantisation noise; larger
// and the gradient stops being local and smears across a junction.
const GRADIENT_STEP = 0.5;

// How far inward, along -o, the far outline lies.
//
// Walking inward from a point on an offset curve, distance-to-outline
// RISES to a maximum at the medial axis and then FALLS to zero at the
// far edge. So the far edge is found by walking until the value falls
// below a small threshold, with no need to know how far the curve was
// offset in the first place - which matters because a welded curve's
// vertices came from two different parents and do not share a
// progression.
//
// Capped at MAX_INWARD_STEPS so a sample that starts outside the glyph,
// where the field is flat zero and the loop would otherwise find no
// edge, cannot walk away across the canvas.
const MAX_INWARD_STEPS = 24;
const EDGE_THRESHOLD = 0.75;

function inwardReach(field, width, height, x, y, ox, oy, step) {
    const h = Math.max(0.5, step);
    let travelled = 0;
    let rising = false;
    let prevT = 0;
    let prevD = sampleDistance(field, width, height, x, y);
    for (let i = 1; i <= MAX_INWARD_STEPS; i++) {
        const t = i * h;
        const d = sampleDistance(field, width, height, x - ox * t, y - oy * t);
        if (d > EDGE_THRESHOLD) rising = true;
        // Only stop on a FALL, and only after the value has been above
        // the threshold at least once: starting near an outline means
        // the first samples are legitimately small, and stopping there
        // would return a ribbon of nearly no width.
        if (rising && d <= EDGE_THRESHOLD) {
            // INTERPOLATE to the crossing rather than returning t. The
            // fall is detected one whole step past the edge, so taking t
            // as the answer overshoots the outline by up to `h` at every
            // point - measured as 10.4% of the glyph's area spilling
            // outside it, against 3% before this mode existed.
            const span = prevD - d;
            const frac = span > 1e-6 ? (prevD - EDGE_THRESHOLD) / span : 1;
            return prevT + h * Math.max(0, Math.min(1, frac));
        }
        prevT = t;
        prevD = d;
        travelled = t;
    }
    return travelled;
}

export function sampleHalfWidths(pts, field, width, height, smoothing = 2) {
    const raw = pts.map((p) => sampleDistance(field, width, height, p.x, p.y));
    return smoothScalars(raw, smoothing);
}

// Unit vector pointing at the nearest outline, or null on the ridge.
function outwardAt(field, width, height, x, y) {
    const h = GRADIENT_STEP;
    const gx = (sampleDistance(field, width, height, x + h, y)
        - sampleDistance(field, width, height, x - h, y)) / (2 * h);
    const gy = (sampleDistance(field, width, height, x, y + h)
        - sampleDistance(field, width, height, x, y - h)) / (2 * h);
    const mag = Math.hypot(gx, gy);
    if (!(mag > GRADIENT_FLOOR)) return null;
    // Downhill: toward the boundary.
    return { x: -gx / mag, y: -gy / mag };
}

// The two edges of the ribbon, in raster pixels.
//
// `inner` is the edge the path itself lies on in 'outward' mode, and is
// the mirrored offset in 'both' mode. Returning both edges rather than a
// ready-made polygon lets the caller decide how to close it — an open
// path wants one loop, a closed path wants two rings filled even-odd so
// the counter stays a hole.
export function buildRibbon(pts, field, width, height, options = {}) {
    const {
        mode = 'both',
        closed = false,
        smoothing = 2,
        normalSmoothing = 2,
        scale = 1,
        minHalfPx = 0,
    } = options;

    if (!pts || pts.length < 2) return null;

    const halves = sampleHalfWidths(pts, field, width, height, smoothing);
    const normals = smoothVectors(computeNormals(pts, closed), normalSmoothing, closed);

    const outer = [];
    const inner = [];
    const spanning = mode === 'span';

    // The outward unit vector at each point, reused below rather than
    // recomputed: it costs four field samples each time.
    const outs = (spanning || mode === 'outward')
        ? pts.map((p, i) => outwardAt(field, width, height, p.x, p.y) || normals[i])
        : null;

    // Inward reaches are SMOOTHED, like the half-widths above and for the
    // same reason. Each is found by an independent march, so neighbouring
    // points can land a pixel or two apart and the inner edge comes out
    // visibly ragged - which is exactly what this mode introduced when it
    // was first written without this pass.
    let backs = null;
    if (spanning) {
        const raw = pts.map((p, i) => {
            const d = Math.max(minHalfPx, halves[i] * scale);
            return Math.max(d, inwardReach(field, width, height, p.x, p.y, outs[i].x, outs[i].y, Math.max(1, d / 2)));
        });
        const smoothed = smoothScalars(raw, smoothing);
        // Smoothing may only SHORTEN a reach, never lengthen it. A plain
        // average overshoots wherever the true reach changes sharply -
        // around a junction - and pushes the inner edge outside the
        // glyph. Measured: plain smoothing took spill from 3.8% of the
        // glyph's area to 8.4% and IoU from 0.859 down to 0.824, so it
        // bought a tidier edge by making the shape less correct.
        // Clamping keeps the jitter reduction without the overshoot.
        backs = raw.map((v, i) => Math.min(v, smoothed[i]));
    }

    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const d = Math.max(minHalfPx, halves[i] * scale);

        if (outs) {
            const o = outs[i];
            outer.push({ x: p.x + o.x * d, y: p.y + o.y * d });
            if (!spanning) {
                // Legacy reach-one-side behaviour, kept so the mode can
                // be asked for explicitly; nothing selects it by default.
                inner.push({ x: p.x, y: p.y });
            } else {
                const back = backs[i];
                inner.push({ x: p.x - o.x * back, y: p.y - o.y * back });
            }
        } else {
            const n = normals[i];
            outer.push({ x: p.x + n.x * d, y: p.y + n.y * d });
            inner.push({ x: p.x - n.x * d, y: p.y - n.y * d });
        }
    }

    return { outer, inner, halves, closed };
}

// ====================================================================
// Local geometry helpers
// ====================================================================
// Deliberately duplicated from tween.mjs rather than imported from it.
// `lab/` is meant to be liftable into another project as a geometry
// engine, and a width module that drags the whole tween/welding stage in
// behind it would defeat that. These are a dozen lines each.

function computeNormals(pts, closed) {
    const n = pts.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        let a;
        let b;
        if (closed) {
            a = pts[(i - 1 + n) % n];
            b = pts[(i + 1) % n];
        } else {
            a = pts[Math.max(0, i - 1)];
            b = pts[Math.min(n - 1, i + 1)];
        }
        let tx = b.x - a.x;
        let ty = b.y - a.y;
        const len = Math.hypot(tx, ty) || 1;
        tx /= len;
        ty /= len;
        out[i] = { x: -ty, y: tx };
    }
    return out;
}

function smoothScalars(values, passes) {
    let cur = values.slice();
    for (let p = 0; p < passes; p++) {
        const next = cur.slice();
        for (let i = 1; i < cur.length - 1; i++) {
            next[i] = (cur[i - 1] + cur[i] + cur[i + 1]) / 3;
        }
        cur = next;
    }
    return cur;
}

// Averages direction then RE-NORMALISES. Averaging the components alone
// shortens the vector wherever neighbours disagree, which would quietly
// thin the ribbon at exactly the curved places it should stay full.
function smoothVectors(vecs, passes, closed) {
    let cur = vecs.slice();
    const n = cur.length;
    for (let p = 0; p < passes; p++) {
        const next = cur.slice();
        for (let i = 0; i < n; i++) {
            if (!closed && (i === 0 || i === n - 1)) continue;
            const a = cur[(i - 1 + n) % n];
            const b = cur[i];
            const c = cur[(i + 1) % n];
            let x = a.x + b.x + c.x;
            let y = a.y + b.y + c.y;
            const len = Math.hypot(x, y) || 1;
            next[i] = { x: x / len, y: y / len };
        }
        cur = next;
    }
    return cur;
}
