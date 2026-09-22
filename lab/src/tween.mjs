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
import { routeNearest } from './routing.mjs';

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

    // Where two offset curves cross, weld them into one and discard the
    // overshoot past the crossing — the mitre an offset needs at a
    // junction. ALL crossings are welded (the earlier "only if a curve
    // crosses exactly one other" restriction was lifted on request);
    // welding is iterative, so a curve produced by one weld can be
    // welded again, which is what handles a multi-way junction.
    joinIntersections: true,

    // How sharp the resulting corner is. 'auto' decides per corner from
    // its measured angle; the other three force one treatment.
    //   auto   — sharp when the corner is open, softened when it is acute
    //   sharp  — always meet at the crossing point (subject to miter limit)
    //   round  — always arc through the corner
    //   bevel  — always chamfer straight across
    joinStyle: 'auto',

    // In 'auto', a corner whose measured angle is at or above this stays
    // SHARP; below it gets softened. 180deg is a straight join (no corner
    // at all), small values are acute spikes. Two nearly-collinear offset
    // curves meeting head-on sit near 180 and should stay crisp; a
    // stroke doubling back on itself sits near 0 and would otherwise
    // throw a long spike.
    joinSharpAngleDeg: 60,

    // Cut-back distance along each leg when a corner is rounded or
    // bevelled, in raster px. Larger = blunter corner.
    joinCornerRadiusPx: 4,

    // Safety cap on a SHARP corner, as a multiple of the offset width
    // (the standard miter-limit idea). A corner approaching 0deg has an
    // unbounded mitre; past this ratio it falls back to a bevel instead
    // of shooting off across the glyph.
    joinMiterLimit: 4,
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

    const joined = s.joinIntersections ? joinIntersectingCurves(curves, s) : { welds: [], skipped: 0 };
    return { curves, settings: s, joins: joined };
}

// ====================================================================
// Welding crossed offset curves
// ====================================================================
// Where two strokes meet, their offset curves cross and each overshoots
// past the crossing into the other stroke's interior. Those overshoots
// are the visual mess at every junction.
//
// EVERY crossing is welded. An earlier version only welded a pair that
// crossed exactly one other curve, leaving multi-way junctions alone;
// that restriction was lifted on request. Multi-way is handled by
// welding ITERATIVELY — a polyline produced by one weld is a normal
// candidate for the next, so a three-curve junction resolves as two
// successive two-curve welds rather than needing a special case.
//
// TRIMMING: the crossing splits each curve in two. The shorter piece is
// the overshoot and is discarded; the longer is the real stroke and is
// kept. The survivors meet head-to-tail at the crossing.
//
// CORNER SHARPNESS IS MEASURED, NOT ASSUMED. At each weld the angle
// between the incoming and outgoing directions is computed:
//   180deg  the curves run straight through each other — no real corner
//    90deg  a square corner
//     0deg  the stroke doubles back on itself
// A sharp mitre is right for an open corner and catastrophic for an
// acute one, where the mitre point shoots away from the glyph. So
// 'auto' keeps corners at or above joinSharpAngleDeg sharp and softens
// the rest, and even a sharp corner is capped by joinMiterLimit — the
// same reasoning any stroke renderer applies to line joins.
function joinIntersectingCurves(curves, settings) {
    const style = settings.joinStyle || 'auto';
    const sharpAngle = settings.joinSharpAngleDeg ?? 60;
    const radius = settings.joinCornerRadiusPx ?? 4;
    const miterLimit = settings.joinMiterLimit ?? 4;

    // Flatten to individually addressable polylines. A curve's two sides
    // are independent: the left side of one edge can weld to the right
    // side of another.
    const items = [];
    for (let ci = 0; ci < curves.length; ci++) {
        if (curves[ci].left && curves[ci].left.length > 1) items.push({ ci, side: 'left', pts: curves[ci].left, alive: true });
        if (curves[ci].right && curves[ci].right.length > 1) items.push({ ci, side: 'right', pts: curves[ci].right, alive: true });
    }

    const welds = [];
    let guard = items.length * 6 + 16; // iteration cap; see below

    // Greedy: weld the first crossing found, then rescan. Rescanning is
    // what lets a freshly welded polyline participate in the next weld.
    // The guard exists because a pathological arrangement could in
    // principle keep producing crossings; it bounds the work rather than
    // trusting the geometry to terminate.
    while (guard-- > 0) {
        let found = null;
        for (let i = 0; i < items.length && !found; i++) {
            if (!items[i].alive) continue;
            for (let j = i + 1; j < items.length && !found; j++) {
                if (!items[j].alive) continue;
                const hit = firstIntersection(items[i].pts, items[j].pts);
                if (hit) found = { i, j, ...hit };
            }
        }
        if (!found) break;

        const { i, j, p, si, sj } = found;
        const a = keepLongerSide(items[i].pts, si, p);
        const b = keepLongerSide(items[j].pts, sj, p);
        if (!a || !b) { items[j].alive = false; continue; }

        // Orient: A runs INTO the crossing, B runs OUT of it.
        const aPts = a.endsAtCrossing ? a.pts : a.pts.slice().reverse();
        const bPts = b.endsAtCrossing ? b.pts.slice().reverse() : b.pts;
        const corner = buildCorner(aPts, bPts, p, { style, sharpAngle, radius, miterLimit });

        welds.push({
            from: { curve: items[i].ci, side: items[i].side },
            to: { curve: items[j].ci, side: items[j].side },
            at: p,
            angleDeg: +corner.angleDeg.toFixed(1),
            treatment: corner.treatment,
            points: corner.pts.length,
        });

        // The weld result replaces item i and retires item j, so the
        // next scan sees one longer polyline where there were two.
        items[i].pts = corner.pts;
        items[j].alive = false;
    }

    // Push the surviving polylines back onto the curves. A curve whose
    // side was absorbed into another weld is blanked so the renderer
    // draws one continuous curve rather than overlapping stubs.
    for (const it of items) {
        curves[it.ci][it.side] = it.alive ? it.pts : null;
    }

    return {
        welds,
        skipped: 0,
        unresolved: guard <= 0 ? 'iteration cap reached' : null,
    };
}

// Joins A (ending at the corner) to B (starting at it), applying the
// corner treatment. Returns the combined points plus the measured angle
// and which treatment was actually used, so the debug panel can show
// what the geometry decided rather than only what was configured.
function buildCorner(aPts, bPts, corner, { style, sharpAngle, radius, miterLimit }) {
    const dirIn = unit(aPts[aPts.length - 2] || aPts[0], corner);
    const dirOut = unit(corner, bPts[1] || bPts[bPts.length - 1]);

    // Angle BETWEEN the two directions, measured as the corner a pen
    // would turn through: 180 = straight on, 0 = fully doubled back.
    let angleDeg = 180;
    if (dirIn && dirOut) {
        const dot = Math.max(-1, Math.min(1, dirIn.x * dirOut.x + dirIn.y * dirOut.y));
        angleDeg = 180 - (Math.acos(dot) * 180) / Math.PI;
    }

    let treatment = style;
    if (style === 'auto') treatment = angleDeg >= sharpAngle ? 'sharp' : 'round';

    if (treatment === 'sharp') {
        // Standard miter limit: the mitre extends by 1/sin(theta/2) of
        // the offset width, which is unbounded as the corner closes.
        const half = (angleDeg / 2) * (Math.PI / 180);
        const miter = Math.sin(half) > 1e-6 ? 1 / Math.sin(half) : Infinity;
        if (miter > miterLimit) treatment = 'bevel';
    }

    if (treatment === 'sharp' || radius <= 0 || !dirIn || !dirOut) {
        return { pts: aPts.concat(bPts.slice(1)), angleDeg, treatment: 'sharp' };
    }

    // Cut back along each leg, never past the available length, so a
    // short stub cannot be consumed entirely by its own corner.
    const backA = Math.min(radius, polyLen(aPts) * 0.45);
    const backB = Math.min(radius, polyLen(bPts) * 0.45);
    const cutA = trimFromEnd(aPts, backA);
    const cutB = trimFromStart(bPts, backB);
    const pA = cutA[cutA.length - 1];
    const pB = cutB[0];

    if (treatment === 'bevel') {
        return { pts: cutA.concat(cutB), angleDeg, treatment: 'bevel' };
    }

    // Round: a quadratic through the corner point. The corner is the
    // control point, so the curve passes near it without reaching it —
    // exactly the shape a rounded join has, and cheaper and more stable
    // than constructing a true circular arc between two tangents.
    const arc = [];
    const steps = 8;
    for (let k = 1; k < steps; k++) {
        const t = k / steps;
        const mt = 1 - t;
        arc.push({
            x: mt * mt * pA.x + 2 * mt * t * corner.x + t * t * pB.x,
            y: mt * mt * pA.y + 2 * mt * t * corner.y + t * t * pB.y,
        });
    }
    return { pts: cutA.concat(arc, cutB), angleDeg, treatment: 'round' };
}

// Drops `amount` of length from the end of a polyline, interpolating the
// final point so the cut lands exactly at that distance.
function trimFromEnd(pts, amount) {
    if (amount <= 0) return pts.slice();
    const out = pts.slice();
    let remaining = amount;
    while (out.length > 2) {
        const last = out[out.length - 1];
        const prev = out[out.length - 2];
        const segLen = Math.hypot(last.x - prev.x, last.y - prev.y);
        if (segLen > remaining) {
            const t = (segLen - remaining) / segLen;
            out[out.length - 1] = { x: prev.x + (last.x - prev.x) * t, y: prev.y + (last.y - prev.y) * t };
            return out;
        }
        remaining -= segLen;
        out.pop();
    }
    return out;
}

function trimFromStart(pts, amount) {
    return trimFromEnd(pts.slice().reverse(), amount).reverse();
}

// Splits `pts` at crossing point p (which lies on segment index si) and
// returns the longer piece, flagging whether that piece ENDS at the
// crossing (true) or STARTS at it (false).
function keepLongerSide(pts, si, p) {
    const head = pts.slice(0, si + 1);
    head.push({ x: p.x, y: p.y });
    const tail = [{ x: p.x, y: p.y }].concat(pts.slice(si + 1));
    const lenHead = polyLen(head);
    const lenTail = polyLen(tail);
    if (lenHead < 1e-9 && lenTail < 1e-9) return null;
    return lenHead >= lenTail
        ? { pts: head, endsAtCrossing: true }
        : { pts: tail, endsAtCrossing: false };
}

function polyLen(pts) {
    let t = 0;
    for (let i = 1; i < pts.length; i++) t += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return t;
}

// First true crossing between two polylines, or null.
//
// Adjacent-in-space endpoints are NOT treated as crossings: offset
// curves belonging to edges that share a junction already touch at their
// ends, and welding those would fire on essentially every pair at low
// progression values, where nothing has actually crossed yet.
function firstIntersection(A, B) {
    for (let i = 0; i < A.length - 1; i++) {
        for (let j = 0; j < B.length - 1; j++) {
            const p = segmentIntersection(A[i], A[i + 1], B[j], B[j + 1]);
            if (!p) continue;
            const nearAEnd = i === 0 || i === A.length - 2;
            const nearBEnd = j === 0 || j === B.length - 2;
            if (nearAEnd && nearBEnd) continue; // shared junction, not a crossing
            return { p, si: i, sj: j };
        }
    }
    return null;
}

// Proper segment intersection. Strictly interior on both segments
// (0 < t < 1) so a shared endpoint does not register.
function segmentIntersection(p1, p2, p3, p4) {
    const d1x = p2.x - p1.x;
    const d1y = p2.y - p1.y;
    const d2x = p4.x - p3.x;
    const d2y = p4.y - p3.y;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-12) return null; // parallel or degenerate
    const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
    const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
    if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null;
    return { x: p1.x + t * d1x, y: p1.y + t * d1y };
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
export function tweenAnimationRoute(tween, {
    nearestRouting = true, entryMode = 'endpoints', loopAnchors = [],
    rightwardBias = 0, groupByLetter = true, letterOf = null,
} = {}) {
    const items = [];
    for (const c of tween.curves) {
        // `closed` comes from the skeleton edge, not from comparing the
        // curve's own endpoints - see isClosedPolyline's note on why a
        // coordinate test gets this wrong after smoothing.
        // `letter` lets the router finish one glyph before the next;
        // `closed` comes from the skeleton edge, not from comparing the
        // curve's own endpoints - see isClosedPolyline's note on why a
        // coordinate test gets that wrong after smoothing.
        const letter = letterOf ? letterOf(c.edgeId) : null;
        if (c.left && c.left.length > 1) items.push({ id: `${c.edgeId}:left`, pts: c.left, closed: !!c.isLoop, letter });
        if (c.right && c.right.length > 1) items.push({ id: `${c.edgeId}:right`, pts: c.right, closed: !!c.isLoop, letter });
    }

    // Two orderings, so the nearest-neighbour result can be compared
    // against the naive one rather than taken on faith.
    const ordered = nearestRouting
        ? routeNearest(items, null, { entryMode, loopAnchors, rightwardBias, groupByLetter })
        : items.map((it) => ({ id: it.id, runs: [it.pts], entryDistance: 0 }));

    const flat = [];
    let penUpTravel = 0;
    const pushRun = (pointsArr, edgeId) => {
        if (flat.length) {
            const prev = flat[flat.length - 1].p;
            const gap = Math.hypot(prev.x - pointsArr[0].x, prev.y - pointsArr[0].y);
            if (gap > 1e-6) {
                // The hop to this run is an explicit pen-up, exactly as
                // the midline traversal marks one, so the animator's
                // on:draw / on:connector readout stays meaningful.
                flat.push({ p: pointsArr[0], kind: 'connector', edgeId: null });
                penUpTravel += gap;
            }
        }
        for (let i = 0; i < pointsArr.length; i++) {
            const p = pointsArr[i];
            if (flat.length) {
                const prev = flat[flat.length - 1].p;
                if (Math.hypot(prev.x - p.x, prev.y - p.y) < 1e-6) continue;
            }
            flat.push({ p, kind: 'draw', edgeId });
        }
    };

    for (const entry of ordered) {
        const edgeId = parseInt(String(entry.id).split(':')[0], 10);
        for (const run of entry.runs) pushRun(run, Number.isNaN(edgeId) ? null : edgeId);
    }

    const cumulative = [0];
    for (let i = 1; i < flat.length; i++) {
        cumulative.push(cumulative[i - 1] + Math.hypot(flat[i].p.x - flat[i - 1].p.x, flat[i].p.y - flat[i - 1].p.y));
    }
    return {
        flat,
        cumulative,
        totalLength: cumulative[cumulative.length - 1] || 0,
        penUpTravel,
        curveCount: items.length,
        runCount: ordered.reduce((n, e) => n + e.runs.length, 0),
        // Which rule placed each entry, so the debug data shows whether
        // a loop used a midline endpoint or fell back to the pen.
        entryRules: ordered.reduce((acc, e) => {
            const k = e.entryRule || 'unknown';
            acc[k] = (acc[k] || 0) + 1;
            return acc;
        }, {}),
    };
}
