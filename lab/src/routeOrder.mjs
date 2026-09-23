// ====================================================================
// Animation route order — stops, manual overrides, learned stroke order
// ====================================================================
// Three related jobs, kept in one module because they all turn on the
// same question: what identifies a route stop?
//
//   1. STOPS. The route is an ordered list of drawable items, each
//      entered at one point. Those entry points are what the user sees
//      numbered on the canvas and what they click to reorder.
//
//   2. OVERRIDES. A manual swap is stored as an explicit sequence of
//      item ids, applied after routing. It is NOT stored as "swap 3 and
//      5", because the nearest-neighbour router can produce a different
//      ordering the moment anything upstream changes, and a positional
//      instruction would then swap two unrelated strokes.
//
//   3. LEARNED ORDER. The point of the feature: a stroke order taught
//      once should survive a settings change. It cannot be stored by
//      item id or index — `edgeId:left` is assigned by the skeleton
//      graph, and raster height, thinning or pruning changes renumber
//      everything. So an order is stored as a sequence of positions in
//      NORMALISED GLYPH SPACE and matched back by proximity.
//
// NORMALISED GLYPH SPACE. Each stop is recorded as (x, y) in the
// glyph's own bounding box, 0..1, y down. That is independent of raster
// resolution, of font size, and of where the glyph sits on the line, so
// the same 'H' at 128px and at 512px produces the same anchors. It is
// NOT independent of the glyph's shape, which is the point: this is
// per-font, per-character data, and a different font's 'H' legitimately
// has different anchors.
//
// WHAT THIS CANNOT DO, stated plainly because it will happen. If a
// settings change alters the skeleton's TOPOLOGY - a serif branch
// appearing under a lower prune threshold, a junction splitting in two -
// then some new stops have no counterpart in the saved order. Those are
// left in their computed position rather than forced somewhere by a bad
// match, and the match count is reported so a partial match is visible
// rather than silent.
// ====================================================================

// A stop further than this from its nearest saved anchor is treated as
// having no counterpart at all. In normalised units, so it is a
// proportion of the glyph's own size: 0.18 is roughly a fifth of the
// glyph box, wide enough to absorb the drift a raster-size change causes
// in a skeleton, tight enough that the two arms of an 'H' cannot be
// confused with each other.
const MATCH_RADIUS = 0.18;

// ---- Stops ---------------------------------------------------------

// One stop per ordered item: where the pen arrives, and in what order.
export function buildStops(ordered) {
    const stops = [];
    for (let i = 0; i < ordered.length; i++) {
        const entry = ordered[i];
        const run = entry.runs && entry.runs[0];
        const point = run && run[0];
        if (!point) continue;
        stops.push({
            id: entry.id,
            order: stops.length + 1,
            point: { x: point.x, y: point.y },
            letter: entry.letter ?? null,
        });
    }
    return stops;
}

// ---- Manual overrides ----------------------------------------------

// Reorder `ordered` to follow `ids`. Anything named in `ids` but absent
// from this route is skipped; anything present but unnamed keeps its
// computed position relative to the items around it, appended in order.
// Both cases are normal after a settings change, not errors.
export function applyOrderOverride(ordered, ids) {
    if (!Array.isArray(ids) || !ids.length) return ordered;
    const byId = new Map(ordered.map((e) => [String(e.id), e]));
    const out = [];
    const used = new Set();
    for (const id of ids) {
        const key = String(id);
        if (byId.has(key) && !used.has(key)) { out.push(byId.get(key)); used.add(key); }
    }
    for (const e of ordered) {
        if (!used.has(String(e.id))) out.push(e);
    }
    return out;
}

// Swap two stops by their 1-based order numbers, returning the full id
// sequence to store as the new override. Returns null if either number
// is out of range, so a mis-click cannot silently produce a no-op that
// looks like a successful edit.
export function swapStops(stops, orderA, orderB) {
    const a = orderA - 1;
    const b = orderB - 1;
    if (a < 0 || b < 0 || a >= stops.length || b >= stops.length || a === b) return null;
    const ids = stops.map((s) => String(s.id));
    const t = ids[a]; ids[a] = ids[b]; ids[b] = t;
    return ids;
}

// The stop nearest a click, in raster pixels, or null if none is within
// `radiusPx`. Hit-testing on the raw point rather than a drawn marker
// keeps this correct at any zoom, since the caller converts first.
export function stopNearest(stops, x, y, radiusPx) {
    let best = null;
    for (const s of stops) {
        const d = Math.hypot(s.point.x - x, s.point.y - y);
        if (d <= radiusPx && (!best || d < best.d)) best = { d, stop: s };
    }
    return best ? best.stop : null;
}

// ---- Learned order: normalised anchors ------------------------------

// The glyph box a stop is normalised against. Taken from the RASTER
// bounds of the whole run rather than the font's own bounding box: the
// raster is what the stop's coordinates are in, and deriving the box
// from the same space avoids a unit conversion that would have to track
// padding and scale to stay correct.
export function rasterBounds(result) {
    const segs = (result && result.vector && result.vector.segments) || [];
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const seg of segs) {
        for (const p of seg.pointsPx) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY, w: Math.max(1e-6, maxX - minX), h: Math.max(1e-6, maxY - minY) };
}

export function normalisePoint(p, box) {
    return { x: (p.x - box.minX) / box.w, y: (p.y - box.minY) / box.h };
}

// The saved shape for one font+character: an ordered list of normalised
// anchors. Deliberately not the ids - see this file's header.
export function toLearnedOrder(stops, box) {
    if (!box) return null;
    return stops.map((s) => {
        const n = normalisePoint(s.point, box);
        return { x: +n.x.toFixed(4), y: +n.y.toFixed(4), letter: s.letter ?? null };
    });
}

// Match this route's stops against a saved anchor sequence and return
// the id order to apply, plus how well it matched.
//
// Greedy nearest-first over (anchor, stop) pairs rather than walking the
// anchors in order: a greedy in-order walk lets one bad early match
// cascade, whereas taking the most confident pairs first leaves only the
// genuinely ambiguous ones to the end.
export function orderFromLearned(stops, anchors, box) {
    if (!box || !Array.isArray(anchors) || !anchors.length || !stops.length) {
        return { ids: null, matched: 0, total: stops.length };
    }
    const norm = stops.map((s) => ({ s, n: normalisePoint(s.point, box) }));

    const pairs = [];
    for (let ai = 0; ai < anchors.length; ai++) {
        for (let si = 0; si < norm.length; si++) {
            const d = Math.hypot(anchors[ai].x - norm[si].n.x, anchors[ai].y - norm[si].n.y);
            if (d <= MATCH_RADIUS) pairs.push({ ai, si, d });
        }
    }
    pairs.sort((p, q) => p.d - q.d);

    const anchorTaken = new Set();
    const stopTaken = new Set();
    const bySlot = new Map(); // anchor index -> stop
    for (const p of pairs) {
        if (anchorTaken.has(p.ai) || stopTaken.has(p.si)) continue;
        anchorTaken.add(p.ai);
        stopTaken.add(p.si);
        bySlot.set(p.ai, norm[p.si].s);
    }

    const ids = [];
    for (let ai = 0; ai < anchors.length; ai++) {
        const s = bySlot.get(ai);
        if (s) ids.push(String(s.id));
    }
    // Unmatched stops keep their computed position, appended after the
    // learned run rather than dropped or guessed at.
    for (let si = 0; si < norm.length; si++) {
        if (!stopTaken.has(si)) ids.push(String(norm[si].s.id));
    }
    return { ids, matched: bySlot.size, total: stops.length };
}

// ---- Store ----------------------------------------------------------

// Keyed by the font's PostScript name plus the character, so the same
// letter in a different face keeps its own order. The key is built here
// rather than at each call site so the two halves (save and load) cannot
// drift apart.
export function learnedKey(fontInfo, char) {
    const face = (fontInfo && (fontInfo.postScriptName || fontInfo.fullName || fontInfo.sourceName)) || 'unknown';
    return `${face}\u0000${char}`;
}

export function readLearned(store, fontInfo, char) {
    if (!store || !char) return null;
    return store[learnedKey(fontInfo, char)] || null;
}

export function writeLearned(store, fontInfo, char, anchors) {
    if (!char || !anchors || !anchors.length) return store;
    return { ...(store || {}), [learnedKey(fontInfo, char)]: anchors };
}

// ---- Flattening -----------------------------------------------------

// Ordered items -> the point stream the animator walks, with an explicit
// pen-up marker wherever consecutive runs do not already touch.
//
// This exists so the MIDLINE route can be re-flattened after a reorder.
// The tween route has its own copy of this logic inline; the two are
// deliberately equivalent, and this one is the reference. A reorder that
// renumbered the labels without re-flattening would show a new order
// while the animation still walked the old one, which is worse than not
// offering the feature.
export function flattenOrdered(ordered) {
    const flat = [];
    let penUpTravel = 0;

    for (const entry of ordered) {
        for (const run of entry.runs) {
            if (!run || !run.length) continue;
            if (flat.length) {
                const prev = flat[flat.length - 1].p;
                const gap = Math.hypot(prev.x - run[0].x, prev.y - run[0].y);
                if (gap > 1e-6) {
                    flat.push({ p: run[0], kind: 'connector', edgeId: null });
                    penUpTravel += gap;
                }
            }
            for (const p of run) {
                if (flat.length) {
                    const prev = flat[flat.length - 1].p;
                    if (Math.hypot(prev.x - p.x, prev.y - p.y) < 1e-6) continue;
                }
                flat.push({ p, kind: 'draw', edgeId: entry.edgeId ?? null });
            }
        }
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
        stops: buildStops(ordered),
    };
}
