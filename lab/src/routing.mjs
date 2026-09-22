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

// Geometric fallback ONLY. Prefer an authoritative `closed` flag from
// the caller when one exists.
//
// A coordinate test is unreliable here and was measurably wrong: a tween
// curve derived from a closed skeleton edge is genuinely a loop, but
// resampling and normal/radius smoothing nudge its seam apart — measured
// at 0.2162px on Comic Sans 'O', which is far outside any sane epsilon
// yet unmistakably a ring. Loosening the tolerance would only trade one
// wrong answer for another, since a real open curve can easily have ends
// closer than that. The graph already knows; ask it.
export function isClosedPolyline(pts) {
    if (!pts || pts.length < 3) return false;
    return dist(pts[0], pts[pts.length - 1]) < 1e-6;
}

function isClosed(item, pts) {
    if (item && typeof item.closed === 'boolean') return item.closed;
    return isClosedPolyline(pts);
}

// Splits a curve into the run(s) to draw, given the entry vertex index.
// Returns an array of point arrays; more than one means the caller must
// emit a backtrack connector between them (see the header).
export function runsFromEntry(pts, entryIndex, closed) {
    if (closed === undefined ? isClosedPolyline(pts) : closed) {
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

// Entry restricted to the two ENDS of an open curve. Returns whichever
// end is nearer to `from`.
//
// Why this exists alongside the free-point search: entering a stroke in
// the middle is geometrically the shortest hop but visually wrong for
// an animation — the pen appears to start drawing from nowhere, and the
// curve has to be covered in two runs with a retrace between them. For
// a tween curve, which is a stroke edge, the ends are where a pen
// actually starts and finishes.
export function closestEndEntry(pts, from) {
    const lastIdx = pts.length - 1;
    const dFirst = dist(pts[0], from);
    const dLast = dist(pts[lastIdx], from);
    return dFirst <= dLast
        ? { index: 0, distance: dFirst, point: pts[0] }
        : { index: lastIdx, distance: dLast, point: pts[lastIdx] };
}

// A closed curve has no ends, so "enter at an endpoint" is undefined for
// it. The rule used instead: enter at a point on the loop closest to a
// MIDLINE endpoint — a free tip of the skeleton graph — so a tween loop
// starts where the letter's own strokes actually terminate.
//
// ONE CANDIDATE PER ANCHOR, not a single global best. This matters: a
// glyph has several midline endpoints, and pinning the loop to whichever
// one happens to be closest to the loop can place its entry right across
// the glyph from where the pen currently is. Offering the loop point
// nearest EACH anchor and letting the router pick the candidate closest
// to the pen satisfies both requirements at once — the entry still sits
// at a midline endpoint, and the hop to reach it is the shortest one
// available.
//
// FALLBACK: a glyph with no midline endpoints anywhere (an 'O' is a
// single ring with none) has nothing to be near, so every vertex is
// admissible and the nearest to the pen wins.
export function loopEntryCandidates(pts, anchors) {
    if (!anchors || !anchors.length) {
        return pts.map((p, index) => ({ index, point: p, rule: 'nearest-to-pen' }));
    }
    const out = [];
    const seen = new Set();
    for (const a of anchors) {
        let best = null;
        for (let i = 0; i < pts.length; i++) {
            const d = dist(pts[i], a);
            if (!best || d < best.d) best = { d, index: i };
        }
        if (best && !seen.has(best.index)) {
            seen.add(best.index);
            out.push({ index: best.index, point: pts[best.index], rule: 'midline-endpoint' });
        }
    }
    return out;
}

// Greedy nearest-neighbour ordering over a set of {id, pts} curves.
// Returns [{id, runs, entryDistance}] in draw order. `from` is where the
// pen starts; null means "start at the first curve's own first point",
// which keeps output deterministic for the very first pick.
//
// entryMode 'endpoints' restricts an open curve's entry to its two ends
// (see closestEndEntry); 'nearest' allows any point, splitting the curve
// into two runs when that point is interior. loopAnchors supplies the
// midline endpoints used to place a closed curve's start.
export function routeNearest(curves, from = null, { entryMode = 'nearest', loopAnchors = [] } = {}) {
    const remaining = curves.map((c, i) => ({ ...c, _i: i })).filter((c) => c.pts && c.pts.length > 1);
    const out = [];
    let pen = from;

    while (remaining.length) {
        let pick = 0;
        let pickHit = null;

        // TWO SEPARATE QUESTIONS, and conflating them was a real bug.
        //
        // "Where do I enter this curve?" is answered by a per-kind rule:
        // an open curve at its nearer END, a closed one at the point
        // nearest a MIDLINE endpoint. Those rules measure different
        // things - the loop rule's distance is to an anchor, not to the
        // pen.
        //
        // "Which curve do I go to next?" must therefore NOT reuse that
        // number. It is always the pen-to-entry-point travel distance.
        // Comparing an anchor distance against a pen distance let a loop
        // that happened to sit a couple of pixels from some midline
        // endpoint win the "nearest" contest from clear across the
        // glyph, which is exactly the long jumps this produced.
        // Each curve offers a SET of admissible entry points; the router
        // then picks the (curve, entry) pair with the shortest hop from
        // the pen. Selection is therefore always genuinely nearest,
        // while the per-kind rules still control WHICH points are
        // admissible in the first place.
        const candidatesFor = (item) => {
            const pts = item.pts;
            if (isClosed(item, pts)) return loopEntryCandidates(pts, loopAnchors);
            if (entryMode === 'endpoints') {
                return [
                    { index: 0, point: pts[0], rule: 'endpoint' },
                    { index: pts.length - 1, point: pts[pts.length - 1], rule: 'endpoint' },
                ];
            }
            return pts.map((p, index) => ({ index, point: p, rule: 'nearest-point' }));
        };

        if (pen) {
            let bestD = Infinity;
            for (let i = 0; i < remaining.length; i++) {
                for (const cand of candidatesFor(remaining[i])) {
                    const travel = dist(pen, cand.point);
                    if (travel < bestD) { bestD = travel; pick = i; pickHit = { ...cand, travel }; }
                }
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
            // Cold start still honours the loop rule, so a glyph whose
            // first curve is a ring does not begin at an arbitrary vertex.
            // Cold start still honours the loop rule, so a glyph whose
            // first curve is a ring does not begin at an arbitrary vertex.
            const cands = candidatesFor(remaining[pick]);
            pickHit = isClosed(remaining[pick], remaining[pick].pts) && cands.length
                ? { ...cands[0], travel: 0 }
                : { index: 0, travel: 0, point: remaining[pick].pts[0], rule: 'cold-start' };
        }

        const chosen = remaining.splice(pick, 1)[0];
        const runs = runsFromEntry(chosen.pts, pickHit.index, isClosed(chosen, chosen.pts));
        out.push({ id: chosen.id, runs, entryDistance: pickHit.travel, entryRule: pickHit.rule });
        const lastRun = runs[runs.length - 1];
        pen = lastRun[lastRun.length - 1];
    }

    return out;
}
