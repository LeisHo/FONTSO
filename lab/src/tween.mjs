// ====================================================================
// Centreline -> outline tween
// ====================================================================
// Produces, for each skeleton edge, a pair of curves that morph from
// the centreline (progression 0) out to the glyph outline
// (progression 1).
//
// THE MECHANISM
// At every point along a centreline polyline:
//   r = distance transform sampled there   (the local half-thickness —
//                                           see distanceTransform.mjs)
//   n = unit normal to the local tangent
//   offset point = p ± progression * r * radiusScale * n
//
// At progression 0 both sides collapse onto the centreline. At 1 they
// land on the boundary. That is the whole idea; everything else in this
// file exists to stop the result looking like it was computed on a
// pixel grid, because it was.
//
// HOW EXACT IS progression = 1?
// Exact wherever the normal actually points at the nearest boundary
// point, which is true along any ordinary stroke — that is what the
// medial axis means. It is NOT exact in three places, and the
// fine-tuning controls exist because of them:
//   * Terminals. Thinning erodes stroke ends inward (a known, documented
//     limitation of the skeleton itself), so r is measured slightly
//     short of the real tip. `extendTerminalsPx` pushes the ends back
//     out along their own tangent.
//   * Junctions. The medial axis is genuinely ambiguous where strokes
//     meet; the inscribed circle there is larger than either stroke's
//     half-width, so the offset over-shoots. `radiusSmoothing` damps the
//     spike rather than pretending it isn't there.
//   * Sharp corners. The offset of a polyline through a tight corner
//     self-intersects on the inner side. Not repaired: this is a
//     laboratory, and a visible self-intersection is more informative
//     than a silently clipped curve.
// None of this is hidden — it is what the user is looking at when they
// drag the slider to 1 and compare against the outline layer.
// ====================================================================

import { sampleDistance } from './distanceTransform.mjs';

export const DEFAULT_TWEEN = {
    enabled: false,
    // The headline control: 0 = centreline, 1 = outline.
    progression: 0.5,

    // ---- Fine tuning -------------------------------------------------
    // Multiplies the sampled half-thickness. Exists because the skeleton
    // is derived from a thresholded raster and sits a fraction inside
    // the true outline, so progression 1 tends to land marginally short.
    // Nudge to ~1.05 to sit exactly on the outline for a given face.
    radiusScale: 1.0,

    // Moving-average passes over r(s) along each polyline. The raw
    // sampled radius spikes at junctions (the inscribed circle there is
    // bigger than either stroke) and jitters by a fraction of a pixel
    // elsewhere. Both show up as bulges in the offset curve.
    radiusSmoothing: 2,

    // Moving-average passes over the computed normals. A normal derived
    // from neighbouring polyline points inherits every kink the
    // rasterisation left behind; unsmoothed, the offset curve visibly
    // wobbles even where the centreline looks clean.
    normalSmoothing: 2,

    // Resample the centreline to even spacing before offsetting.
    // RDP simplification leaves long straight runs with only two points,
    // and a two-point run cannot follow a changing radius — the offset
    // would linearly interpolate across a thickness change instead of
    // tracking it. 0 disables.
    resampleSpacingPx: 2,

    // Pushes each free endpoint outward along its own tangent, in raster
    // px, to compensate for the terminal erosion described above.
    extendTerminalsPx: 0,

    // Draw both offset sides, or just one. Both is the honest default —
    // together they ARE the outline at progression 1. One side is
    // occasionally clearer when inspecting a single stroke.
    bothSides: true,
};

// Builds tween geometry for every segment. Cheap enough to re-run on
// every slider tick: it is O(points), with no rasterisation or thinning,
// which is exactly why the tween settings live outside config.mjs and
// never trigger a pipeline re-run.
export function buildTween(vector, raster, distanceField, settings) {
    const s = { ...DEFAULT_TWEEN, ...settings };
    const { width, height } = raster;
    const curves = [];

    for (const seg of vector.segments) {
        let pts = seg.pointsPx;
        if (!pts || pts.length < 2) continue;

        if (s.resampleSpacingPx > 0) pts = resample(pts, s.resampleSpacingPx);
        if (pts.length < 2) continue;

        if (s.extendTerminalsPx > 0) pts = extendEnds(pts, s.extendTerminalsPx, seg.isLoop);

        const radii = smoothScalars(
            pts.map((p) => sampleDistance(distanceField, width, height, p.x, p.y) * s.radiusScale),
            s.radiusSmoothing,
        );
        const normals = smoothVectors(computeNormals(pts, seg.isLoop), s.normalSmoothing, seg.isLoop);

        const left = [];
        const right = [];
        for (let i = 0; i < pts.length; i++) {
            const d = s.progression * radii[i];
            const n = normals[i];
            left.push({ x: pts[i].x + n.x * d, y: pts[i].y + n.y * d });
            right.push({ x: pts[i].x - n.x * d, y: pts[i].y - n.y * d });
        }

        curves.push({
            edgeId: seg.id,
            isLoop: !!seg.isLoop,
            centre: pts,
            radii,
            left,
            right: s.bothSides ? right : null,
        });
    }

    return { curves, settings: s };
}

// Unit normal at each point, from the local tangent. Central difference
// in the interior (less biased than a forward difference), one-sided at
// the ends, wrapping on a closed loop so the seam does not get a
// spurious kink.
function computeNormals(pts, isLoop) {
    const n = pts.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        let a;
        let b;
        if (isLoop) {
            a = pts[(i - 1 + n) % n];
            b = pts[(i + 1) % n];
        } else {
            a = pts[Math.max(0, i - 1)];
            b = pts[Math.min(n - 1, i + 1)];
        }
        let tx = b.x - a.x;
        let ty = b.y - a.y;
        const len = Math.hypot(tx, ty);
        if (len < 1e-9) {
            out[i] = i > 0 ? out[i - 1] : { x: 0, y: -1 };
            continue;
        }
        tx /= len;
        ty /= len;
        out[i] = { x: -ty, y: tx }; // rotate tangent 90 degrees
    }
    return out;
}

function smoothScalars(values, passes) {
    if (passes <= 0 || values.length < 3) return values.slice();
    let cur = values.slice();
    for (let p = 0; p < passes; p++) {
        const next = cur.slice();
        for (let i = 1; i < cur.length - 1; i++) {
            next[i] = (cur[i - 1] + cur[i] * 2 + cur[i + 1]) / 4;
        }
        cur = next;
    }
    return cur;
}

// Smooths direction, then re-normalises. Averaging the components and
// skipping the re-normalisation would shorten the vector wherever
// neighbouring normals disagree, which would quietly reduce the offset
// exactly at the corners where it matters most.
function smoothVectors(vecs, passes, isLoop) {
    if (passes <= 0 || vecs.length < 3) return vecs.slice();
    const n = vecs.length;
    let cur = vecs.slice();
    for (let p = 0; p < passes; p++) {
        const next = cur.slice();
        for (let i = 0; i < n; i++) {
            const prev = isLoop ? cur[(i - 1 + n) % n] : cur[Math.max(0, i - 1)];
            const nxt = isLoop ? cur[(i + 1) % n] : cur[Math.min(n - 1, i + 1)];
            let x = prev.x + cur[i].x * 2 + nxt.x;
            let y = prev.y + cur[i].y * 2 + nxt.y;
            const len = Math.hypot(x, y);
            next[i] = len < 1e-9 ? cur[i] : { x: x / len, y: y / len };
        }
        cur = next;
    }
    return cur;
}

function resample(points, spacing) {
    if (!points || points.length < 2 || spacing <= 0) return points ? points.slice() : [];
    const out = [points[0]];
    let carry = 0;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        if (segLen < 1e-9) continue;
        let t = carry;
        while (t + spacing <= segLen) {
            t += spacing;
            const u = t / segLen;
            out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
        }
        carry = t - segLen;
    }
    const last = points[points.length - 1];
    if (Math.hypot(out[out.length - 1].x - last.x, out[out.length - 1].y - last.y) > 1e-6) out.push(last);
    return out;
}

// A closed loop has no free end to extend, so it is left alone.
function extendEnds(pts, amount, isLoop) {
    if (isLoop || pts.length < 2) return pts;
    const out = pts.slice();
    const dirStart = unit(pts[0], pts[Math.min(1, pts.length - 1)]);
    const dirEnd = unit(pts[pts.length - 1], pts[Math.max(0, pts.length - 2)]);
    if (dirStart) out.unshift({ x: pts[0].x - dirStart.x * amount, y: pts[0].y - dirStart.y * amount });
    if (dirEnd) out.push({ x: pts[pts.length - 1].x - dirEnd.x * amount, y: pts[pts.length - 1].y - dirEnd.y * amount });
    return out;
}

function unit(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    return len < 1e-9 ? null : { x: dx / len, y: dy / len };
}

// Flattens the tween curves into the {flat, cumulative, totalLength}
// shape the animator consumes, so "Animation Path: Tween" can drive the
// dot along the tweened geometry instead of the midline.
//
// Order is: for each segment, the left curve then the right curve. The
// jump between them is marked 'connector' exactly as the real traversal
// marks a pen-up, so the animator's own on:draw / on:connector readout
// stays meaningful and the dot does not appear to teleport unexplained.
export function tweenAnimationRoute(tween) {
    const flat = [];
    const pushRun = (pointsArr, kind, edgeId) => {
        for (let i = 0; i < pointsArr.length; i++) {
            const p = pointsArr[i];
            if (flat.length) {
                const prev = flat[flat.length - 1].p;
                if (Math.hypot(prev.x - p.x, prev.y - p.y) < 1e-6) continue;
                if (i === 0) flat.push({ p, kind: 'connector', edgeId: null });
            }
            flat.push({ p, kind, edgeId });
        }
    };

    for (const c of tween.curves) {
        if (c.left && c.left.length > 1) pushRun(c.left, 'draw', c.edgeId);
        if (c.right && c.right.length > 1) pushRun(c.right, 'draw', c.edgeId);
    }

    const cumulative = [0];
    for (let i = 1; i < flat.length; i++) {
        cumulative.push(cumulative[i - 1] + Math.hypot(flat[i].p.x - flat[i - 1].p.x, flat[i].p.y - flat[i - 1].p.y));
    }
    return { flat, cumulative, totalLength: cumulative[cumulative.length - 1] || 0 };
}
