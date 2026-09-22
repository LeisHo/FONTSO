// ====================================================================
// Nearest-curve routing
// ====================================================================
// Decides, repeatedly: given where the pen currently is and a set of
// curves not yet drawn, which curve to go to next and where to enter it.
//
// THE RULE (as specified): find the curve closest to the pen, then enter
// it at whichever of its points is closest. Greedy nearest-neighbour —
// not a global optimum (that is the travelling-salesman problem), but it
// removes the obviously silly hops that a fixed reading order produces,
// such as crossing the whole glyph to reach a component that happened to
// sort first.
//
// ENTERING AT AN INTERIOR POINT is the part that needs a decision rather
// than just an implementation:
//
//   * A CLOSED curve can genuinely start anywhere. It is rotated so the
//     nearest point becomes both its start and its end. Nothing is lost,
//     and this is the case where "the closest point" is exactly right.
//
//   * An OPEN curve entered in the middle leaves a tail behind. Three
//     options were possible: silently restrict entry to the two
//     endpoints (ignores the instruction), drop the short tail (loses
//     geometry), or cover both halves. This does the third: it runs
//     entry -> nearer end, emits a backtrack connector to the entry
//     point, then runs entry -> farther end. The whole curve is drawn,
//     the initial hop is still the shortest available, and the extra
//     move is an explicit connector rather than a hidden teleport.
//     When the nearest point IS an endpoint (common), there is no tail
//     and it degenerates to a single run with no extra connector.
// ====================================================================

function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

// Closest point on a polyline to `from`, by vertex. Vertex-level rather
// than true perpendicular projection onto each segment: the polylines
// here are already resampled to a couple of pixels, so the difference is
// below the width of the drawn line, and vertex indices are what the
// split below needs anyway.
export function closestPointOnPolyline(pts, from) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
        const d = dist(pts[i], from);
        if (d < bestD) { bestD = d; best = i; }
    }
    return { index: best, distance: bestD, point: pts[best] };
}

export function isClosedPolyline(pts) {
    if (!pts || pts.length < 3) return false;
    return dist(pts[0], pts[pts.length - 1]) < 1e-6;
}

// Splits a curve into the run(s) to draw, given the entry vertex index.
// Returns an array of point arrays; more than one means the caller must
// emit a backtrack connector between them (see the header).
export function runsFromEntry(pts, entryIndex) {
    if (isClosedPolyline(pts)) {
        // Rotate so the entry point is first, and close the ring again.
        // The duplicated last vertex is dropped before rotating so it
        // does not end up stranded in the middle of the run.
        const ring = pts.slice(0, -1);
        const n = ring.length;
        if (n === 0) return [pts.slice()];
        const k = entryIndex % n;
        const rotated = ring.slice(k).concat(ring.slice(0, k));
        rotated.push({ ...rotated[0] });
        return [rotated];
    }

    const last = pts.length - 1;
    if (entryIndex <= 0) return [pts.slice()];
    if (entryIndex >= last) return [pts.slice().reverse()];

    // Interior entry: the shorter side first, so the pen commits to the
    // long stroke after the backtrack rather than before it.
    const back = pts.slice(0, entryIndex + 1).reverse(); // entry -> start
    const fwd = pts.slice(entryIndex);                   // entry -> end
    return polyLength(back) <= polyLength(fwd) ? [back, fwd] : [fwd, back];
}

export function polyLength(pts) {
    let t = 0;
    for (let i = 1; i < pts.length; i++) t += dist(pts[i - 1], pts[i]);
    return t;
}

// Greedy nearest-neighbour ordering over a set of {id, pts} curves.
// Returns [{id, runs, entryDistance}] in draw order. `from` is where the
// pen starts; null means "start at the first curve's own first point",
// which keeps output deterministic for the very first pick.
export function routeNearest(curves, from = null) {
    const remaining = curves.map((c, i) => ({ ...c, _i: i })).filter((c) => c.pts && c.pts.length > 1);
    const out = [];
    let pen = from;

    while (remaining.length) {
        let pick = 0;
        let pickHit = null;

        if (pen) {
            let bestD = Infinity;
            for (let i = 0; i < remaining.length; i++) {
                const hit = closestPointOnPolyline(remaining[i].pts, pen);
                if (hit.distance < bestD) { bestD = hit.distance; pick = i; pickHit = hit; }
            }
        } else {
            // Deterministic cold start: topmost-leftmost first point, so
            // a run is reproducible rather than depending on array order.
            let bestKey = Infinity;
            for (let i = 0; i < remaining.length; i++) {
                const p = remaining[i].pts[0];
                const key = p.y * 10000 + p.x;
                if (key < bestKey) { bestKey = key; pick = i; }
            }
            pickHit = { index: 0, distance: 0, point: remaining[pick].pts[0] };
        }

        const chosen = remaining.splice(pick, 1)[0];
        const runs = runsFromEntry(chosen.pts, pickHit.index);
        out.push({ id: chosen.id, runs, entryDistance: pickHit.distance });
        const lastRun = runs[runs.length - 1];
        pen = lastRun[lastRun.length - 1];
    }

    return out;
}
