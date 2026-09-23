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
// TOPOLOGY CHANGES AND WHY SEVERAL VARIANTS ARE KEPT. If a settings
// change alters the skeleton's topology - a serif branch appearing under
// a lower prune threshold, a junction splitting in two - the stop count
// itself changes. Matching already handles that in one direction: a
// RICHER saved order still orders a SPARSER route correctly, because
// anchors with no stop near them are simply skipped, and stops with no
// anchor keep their computed position rather than being forced somewhere
// by a bad match.
//
// What that does not survive is OVERWRITING. With one saved order per
// font+character, teaching the serif variant and then teaching the plain
// one destroys the serif knowledge, and vice versa - even though each is
// the better guide for its own topology and the richer one is a
// perfectly good guide for both.
//
// So a character keeps a LIST of recorded orders, and the one that best
// fits the route in front of us is used: the highest proportion of the
// current route's stops matched, ties broken by recency. Not merged into
// a single canonical sequence - merging two orderings needs a topological
// merge, and it is genuinely ambiguous the moment two saved orders
// disagree about the relative order of a pair they share. Picking the
// best-fitting whole order has no such ambiguity and is explainable:
// "this is the order you taught me for a shape like this one".
//
// A variant whose anchors are effectively the same as an existing one
// REPLACES it rather than accumulating a near-duplicate, so re-teaching
// the same topology does not grow the list without bound.
// ====================================================================

// A stop further than this from its nearest saved anchor is treated as
// having no counterpart at all. In normalised units, so it is a
// proportion of the glyph's own size: 0.18 is roughly a fifth of the
// glyph box, wide enough to absorb the drift a raster-size change causes
// in a skeleton, tight enough that the two arms of an 'H' cannot be
// confused with each other.
const MATCH_RADIUS = 0.18;

// ---- Stops ---------------------------------------------------------

// One stop per ordered item: where the pen ARRIVES, where it LIFTS, and
// in what order.
//
// Both ends are recorded but the pair shares ONE order number, because
// the number identifies a stroke, not a loose endpoint - Switch Point
// Order swaps whole curves, and numbering the two ends separately would
// invite clicking two halves of different strokes and expecting
// something coherent. The renderer distinguishes them by marker shape
// instead: filled where the pen lands, hollow where it lifts.
export function buildStops(ordered) {
    const stops = [];
    for (let i = 0; i < ordered.length; i++) {
        const entry = ordered[i];
        const runs = entry.runs || [];
        const firstRun = runs[0];
        const lastRun = runs[runs.length - 1];
        const point = firstRun && firstRun[0];
        if (!point) continue;
        // The exit is the last point of the LAST run, not of the first:
        // an entry whose curve was split into several runs leaves the pen
        // at the end of the final one.
        const exit = lastRun && lastRun[lastRun.length - 1];
        stops.push({
            id: entry.id,
            order: stops.length + 1,
            point: { x: point.x, y: point.y },
            exit: exit ? { x: exit.x, y: exit.y } : { x: point.x, y: point.y },
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
// Considers BOTH ends of every stop: clicking where a stroke finishes
// selects that stroke just as clicking where it starts does. Without
// this the hollow exit markers would be visible but dead to the touch,
// which reads as a broken control rather than a deliberate one.
export function stopNearest(stops, x, y, radiusPx) {
    let best = null;
    for (const s of stops) {
        for (const p of [s.point, s.exit]) {
            if (!p) continue;
            const d = Math.hypot(p.x - x, p.y - y);
            if (d <= radiusPx && (!best || d < best.d)) best = { d, stop: s };
        }
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

// Pick the recorded order that best fits the route in front of us.
//
// Scored on the proportion of the CURRENT route's stops that matched,
// not on raw match count: a variant with more anchors would otherwise
// win automatically, when what actually matters is how much of this
// route it can explain. Ties go to the most recently taught, which is
// the closest thing to an expression of current intent.
export function bestLearnedOrder(stops, variants, box) {
    if (!box || !Array.isArray(variants) || !variants.length || !stops.length) {
        return { ids: null, matched: 0, total: stops.length, variantCount: 0, chosen: -1 };
    }
    let best = null;
    for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        const res = orderFromLearned(stops, v.anchors, box);
        const score = res.total ? res.matched / res.total : 0;
        const savedAt = v.savedAt || 0;
        if (!best || score > best.score || (score === best.score && savedAt > best.savedAt)) {
            best = { score, savedAt, res, index: i, anchorCount: v.anchors.length };
        }
    }
    return {
        ids: best.res.ids,
        matched: best.res.matched,
        total: best.res.total,
        variantCount: variants.length,
        chosen: best.index,
        chosenAnchorCount: best.anchorCount,
    };
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

// At most this many recorded orders per character. Well above the number
// of distinct topologies a single glyph realistically produces across a
// settings range, and low enough that the settings document stays small.
const MAX_VARIANTS = 8;

// Two variants count as the same topology when they have the same number
// of anchors and every anchor is within this distance of its counterpart.
// Same units as MATCH_RADIUS; tighter, because this asks "is this the
// same thing again?" rather than "could this correspond?".
const SAME_VARIANT_RADIUS = 0.05;

// Old format was a bare anchor array per character. Reading through this
// means a settings document written before variants existed still loads,
// without a migration step that could fail halfway.
function variantsOf(entry) {
    if (!entry) return [];
    if (Array.isArray(entry) && entry.length && entry[0] && typeof entry[0].x === 'number') {
        return [{ anchors: entry, savedAt: 0 }];
    }
    if (Array.isArray(entry)) return entry.filter((v) => v && Array.isArray(v.anchors));
    return [];
}

export function readLearned(store, fontInfo, char) {
    if (!store || !char) return null;
    const list = variantsOf(store[learnedKey(fontInfo, char)]);
    return list.length ? list : null;
}

function sameVariant(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y) > SAME_VARIANT_RADIUS) return false;
    }
    return true;
}

export function writeLearned(store, fontInfo, char, anchors) {
    if (!char || !anchors || !anchors.length) return store;
    const key = learnedKey(fontInfo, char);
    const existing = variantsOf((store || {})[key]);
    // Re-teaching the same topology replaces that variant instead of
    // stacking a near-duplicate beside it.
    const kept = existing.filter((v) => !sameVariant(v.anchors, anchors));
    const next = [{ anchors, savedAt: Date.now() }, ...kept].slice(0, MAX_VARIANTS);
    return { ...(store || {}), [key]: next };
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
