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
//   'outward' — for a TWEEN curve. That curve has already been pushed
//               off the centreline toward one side, so it is no longer
//               equidistant: the outline it is near is the ADJACENT
//               one. The ribbon therefore grows from the curve outward
//               only, by d, and the curve itself is the inner edge.
//               Animate it and the travelled portion paints the glyph
//               out to its real boundary one stroke-side at a time.
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

    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const d = Math.max(minHalfPx, halves[i] * scale);

        if (mode === 'outward') {
            const o = outwardAt(field, width, height, p.x, p.y) || normals[i];
            outer.push({ x: p.x + o.x * d, y: p.y + o.y * d });
            // The path is its own inner edge: the ribbon reaches the
            // adjacent side only, which is the whole point of this mode.
            inner.push({ x: p.x, y: p.y });
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
