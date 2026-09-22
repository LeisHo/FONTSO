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
export function routeNearest(curves, from = null, {
    entryMode = 'nearest', loopAnchors = [], rightwardBias = 0, groupByLetter = true,
} = {}) {
    // LETTER GROUPING comes first, because it is what actually produces a
    // left-to-right reading order. Nearest-neighbour alone is free to
    // hop between letters and come back, which looks wrong for text even
    // when every individual hop is genuinely the shortest one.
    //
    // Curves are bucketed by the glyph they belong to, buckets are
    // ordered by line and then by left edge, and the pen finishes a
    // letter before moving on. Within a letter, nearest-neighbour still
    // decides the order, so the travel optimisation is kept exactly
    // where it helps and dropped exactly where it hurts.
    if (groupByLetter && curves.some((c) => c.letter !== undefined && c.letter !== null)) {
        const buckets = new Map();
        for (const c of curves) {
            const key = c.letter === undefined || c.letter === null ? '~' : c.letter;
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(c);
        }
        // Ordered by the glyph's own READING-ORDER INDEX, not by
        // geometry. The layout stage already placed the glyphs in
        // reading order, including line breaks, so that index is the
        // exact answer; deriving it back from coordinates is both
        // redundant and fragile.
        //
        // It also fixes a real bug. The previous version sorted by
        // position with a per-letter vertical tolerance, which made the
        // comparator INCONSISTENT: comparing A to B used A's tolerance
        // and B to A used B's, so a tall letter and a short one could
        // each claim to come first. Array.sort on an inconsistent
        // comparator gives an arbitrary order, and it did - on wrapped
        // text 'the quick brown fox' the letters came out
        // 0,1,2,3,4,7,5,6,8..., drawing 'k' before 'i' and 'c'.
        //
        // Curves with no letter (the '~' bucket) sort last, since there
        // is nothing to place them relative to.
        const ordered = [...buckets.entries()].sort((a, b) => {
            const A = a[0] === '~' ? Infinity : Number(a[0]);
            const B = b[0] === '~' ? Infinity : Number(b[0]);
            if (A !== B) return A - B;
            return letterOrigin(a[1]).x - letterOrigin(b[1]).x;
        });
        const out = [];
        let pen = from;
        for (const [, group] of ordered) {
            const sub = routeNearest(group, pen, {
                entryMode, loopAnchors, rightwardBias, groupByLetter: false,
            });
            for (const e of sub) out.push(e);
            if (sub.length) {
                const lastRuns = sub[sub.length - 1].runs;
                const lastRun = lastRuns[lastRuns.length - 1];
                pen = lastRun[lastRun.length - 1];
            }
        }
        return out;
    }
    return routeWithin(curves, from, { entryMode, loopAnchors, rightwardBias });
}

// Top-left corner of a letter's curves, plus a vertical tolerance for
// deciding whether two letters share a line.
function letterOrigin(group) {
    let x = Infinity;
    let y = Infinity;
    let maxY = -Infinity;
    for (const c of group) {
        for (const p of c.pts) {
            if (p.x < x) x = p.x;
            if (p.y < y) y = p.y;
            if (p.y > maxY) maxY = p.y;
        }
    }
    return { x, y, lineTol: Math.max(8, (maxY - y) * 0.6) };
}

function routeWithin(curves, from = null, { entryMode = 'nearest', loopAnchors = [], rightwardBias = 0 } = {}) {
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
            // COST, not raw distance. Pure nearest-neighbour is free to
            // zig-zag backwards; the penalty applies ONLY to leftward
            // movement and scales with how far left the hop goes. A
            // rightward or vertical hop is never penalised, so this does
            // not inflate travel where direction does not matter.
            //   bias 0    -> pure nearest (previous behaviour)
            //   bias high -> approaches a strict left-to-right sweep
            let bestCost = Infinity;
            for (let i = 0; i < remaining.length; i++) {
                for (const cand of candidatesFor(remaining[i])) {
                    const travel = dist(pen, cand.point);
                    const leftward = Math.max(0, pen.x - cand.point.x);
                    const cost = travel + rightwardBias * leftward;
                    if (cost < bestCost) { bestCost = cost; pick = i; pickHit = { ...cand, travel }; }
                }
            }
        } else {
            // Cold start: the LEFTMOST admissible entry, tie-broken
            // topmost. Text is written left to right, so that is where
            // the pen starts.
            //
            // Ranked over every ADMISSIBLE ENTRY rather than each curve's
            // pts[0]. pts[0] is an arbitrary vertex - for a welded or
            // reversed curve it can sit at the right-hand end - so
            // ranking by it chose a start that was neither leftmost nor
            // a legal entry point. Loops therefore still honour their
            // own rule here, since their candidates are the only ones
            // offered.
            let bestKey = Infinity;
            let bestCand = null;
            for (let i = 0; i < remaining.length; i++) {
                for (const cand of candidatesFor(remaining[i])) {
                    const key = cand.point.x * 10000 + cand.point.y;
                    if (key < bestKey) { bestKey = key; pick = i; bestCand = cand; }
                }
            }
            pickHit = bestCand
                ? { ...bestCand, travel: 0 }
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
