// ====================================================================
// Stage 5 — Skeleton cleanup (a SEPARATE, configurable stage)
// ====================================================================
// Kept deliberately separate from both thinning and graph construction,
// per the brief, so it can be tuned — or switched off entirely — without
// touching the algorithms either side of it. Every threshold it uses
// comes from config.mjs; this file contains no magic numbers.
//
// THE GUIDING CONSTRAINT: DO NOT DESTROY THE FONT'S CHARACTER.
// It would be easy to make every skeleton look tidy by pruning hard and
// smoothing hard — and the result would be a generic alphabet, which is
// precisely the failure the brief calls out. So each operation here is
// scoped to a specific, identifiable RASTERISATION artifact:
//
//   pruneSpurs        — whiskers thinning grows at wide terminals and
//                       junctions. Not in the outline; not in the font.
//   dropTinyComponents— specks from anti-aliasing. Guarded so that real
//                       small parts (the dot of an 'i') survive.
//   simplify (RDP)    — the 1px staircase of the pixel grid.
//   smooth (Chaikin)  — pixel-grid chatter, with endpoints pinned.
//
// What is NOT done here, on purpose: no fitting to idealised lines or
// circles, no symmetry enforcement, no snapping to a grid, no stroke
// straightening. A Comic Sans stem that genuinely leans stays leaning.
//
// PRUNING WORKS ON THE BITMAP, NOT THE GRAPH.
// Removing an edge from a graph object leaves the underlying pixels
// behind and the two representations immediately disagree. Instead each
// prune pass erases the spur's pixels from the skeleton bitmap and the
// caller rebuilds the graph from scratch. Slower, and completely immune
// to the incremental-surgery bugs that otherwise plague this step.
// ====================================================================

import { scaleForResolution } from './config.mjs';
import { polylineLength, findComponents, scaleAreaForResolution, sourceArea } from './skeletonGraph.mjs';

// One prune pass. Returns {changed, removedEdges, removedPixels} and
// mutates `pixels` in place. Run repeatedly (config.pruneIterations)
// because removing one spur can expose another underneath it — routine
// at the junction clusters inside 'B', 'R' and '&'.
export function pruneSpurs(graph, config) {
    const threshold = scaleForResolution(config, config.minBranchLengthPx);
    if (threshold <= 0) return { changed: false, removedEdges: 0, removedPixels: 0 };

    const { nodes, edges, pixels } = graph;
    let removedEdges = 0;
    let removedPixels = 0;

    let removedLoops = 0;

    for (const edge of edges) {
        if (edge.lengthPx >= threshold) continue;

        const a = nodes[edge.a];
        const b = nodes[edge.b];
        if (!a || !b) continue;

        // Tiny self-loops are handled by dropTinySelfLoops() further
        // down, NOT here, and specifically WITHOUT erasing their pixels.
        //
        // Erasing them was tried and measurably broke the glyph: on
        // Comic Sans 'H' it took the graph from 4 endpoints / 2
        // junctions / 1 component to 5 / 1 / 2 — the right stem was
        // severed outright. The reason is that a 2px self-loop at a
        // junction is not a little ring hanging off the side; its pixels
        // ARE part of the junction's connective tissue, the place where
        // three strokes physically overlap. The spurious thing is the
        // EDGE (a cycle the tracer reports because it left the merged
        // junction cluster and immediately re-entered it), not the ink.
        // So: drop the edge, keep every pixel.
        if (edge.isLoop) continue;

        // A spur has a FREE TIP at exactly one end. "Free" means degree
        // 1 — one edge and nothing else — regardless of how the node was
        // classified. Testing `kind === 'endpoint'` instead was too
        // narrow and left real artifacts behind: a tiny fragment beside
        // a terminal gets classified 'loop-anchor', not 'endpoint', so
        // the 1px edge joining it to the stem tip failed the test and
        // survived every prune pass (again measured on Comic Sans 'H').
        // Degree is the property that actually matters here; the kind
        // label is a description, not a criterion.
        //
        // Requiring the OTHER end to be non-free is what stops this from
        // eating a short but legitimate standalone stroke (a hyphen, the
        // dot of an 'i', the bar of an '='): those are free at both ends
        // and are dropTinyComponents' business, at its much smaller
        // threshold.
        const aFree = isFreeTip(a);
        const bFree = isFreeTip(b);
        if (aFree === bFree) continue;

        const tip = aFree ? a : b;
        for (const p of edge.pixels) {
            if (pixels[p]) { pixels[p] = 0; removedPixels++; }
        }
        for (const p of tip.pixels) {
            if (pixels[p]) { pixels[p] = 0; removedPixels++; }
        }
        removedEdges++;
    }

    return { changed: removedEdges > 0, removedEdges, removedPixels };
}

// Removes degenerate self-loop EDGES from the graph while leaving the
// bitmap completely untouched — see the note in pruneSpurs for why the
// distinction matters. Run once, after the prune/rebuild loop has
// settled, since rebuilding the graph from pixels would recreate them.
//
// A real closed counter (the bowl of 'o', the loops of 'B') is hundreds
// of pixels around at any usable resolution, so the same length
// threshold separates artifact from feature with a wide margin.
export function dropTinySelfLoops(graph, config) {
    const threshold = scaleForResolution(config, config.minBranchLengthPx);
    if (threshold <= 0) return { removedLoops: 0 };

    const doomed = new Set(
        // isDot is excluded: a dot's self-edge is legitimately
        // zero-length (see skeletonGraph's own note) and would otherwise be
        // caught by this filter and silently delete every full stop,
        // colon and tittle in the alphabet.
        graph.edges.filter((e) => e.isLoop && !e.isDot && e.lengthPx < threshold).map((e) => e.id),
    );
    if (!doomed.size) return { removedLoops: 0 };

    graph.edges = graph.edges.filter((e) => !doomed.has(e.id));
    for (const node of graph.nodes) {
        node.edgeIds = node.edgeIds.filter((id) => !doomed.has(id));
    }
    graph.components = findComponents(graph.nodes, graph.edges);
    graph.stats.edgeCount = graph.edges.length;
    graph.stats.componentCount = graph.components.length;
    return { removedLoops: doomed.size };
}

function isFreeTip(node) {
    return node.kind !== 'junction' && countDistinctEdges(node) === 1;
}

function countDistinctEdges(node) {
    return new Set(node.edgeIds).size;
}

// Erase whole components whose SOURCE MASK REGION is too small to be a
// real glyph part. Distinct from spur pruning: this is about isolated
// specks, not branches.
//
// Measured on the MASK, never on the skeleton length — see
// labelMaskComponents() in rasterize.mjs. A length-based version of this
// function deleted the dot of '?', '!' and ':' on Comic Sans (they
// skeletonise to 2.4-3.8px, below any threshold that also catches
// noise), which is precisely the "destroys the font's character" failure
// the brief warns about. By source area the same dots are hundreds of
// pixels and a speck is single digits, so the two separate cleanly.
export function dropTinyComponents(graph, config) {
    const threshold = scaleAreaForResolution(config, config.minSourceAreaPx);
    if (threshold <= 0 || !graph.maskInfo) {
        return { changed: false, removedComponents: 0, removedPixels: 0 };
    }

    const { components, nodes, edges, pixels, maskInfo } = graph;
    let removedComponents = 0;
    let removedPixels = 0;

    for (const comp of components) {
        // Any pixel of the component identifies its mask region; they
        // are all inside the same one by construction.
        const probe = firstPixelOf(comp, nodes, edges);
        if (probe == null) continue;
        if (sourceArea(maskInfo, probe) >= threshold) continue;

        for (const eid of comp.edgeIds) {
            const edge = edges.find((e) => e.id === eid);
            if (!edge) continue;
            for (const p of edge.pixels) {
                if (pixels[p]) { pixels[p] = 0; removedPixels++; }
            }
        }
        for (const nid of comp.nodeIds) {
            for (const p of nodes[nid].pixels) {
                if (pixels[p]) { pixels[p] = 0; removedPixels++; }
            }
        }
        removedComponents++;
    }
    return { changed: removedComponents > 0, removedComponents, removedPixels };
}

function firstPixelOf(comp, nodes, edges) {
    for (const nid of comp.nodeIds) {
        const n = nodes[nid];
        if (n && n.pixels.length) return n.pixels[0];
    }
    for (const eid of comp.edgeIds) {
        const e = edges.find((x) => x.id === eid);
        if (e && e.pixels.length) return e.pixels[0];
    }
    return null;
}

// ---- Polyline cleanup ------------------------------------------------

// Ramer-Douglas-Peucker. Chosen over uniform decimation because it is
// error-bounded: it removes points only where the polyline is locally
// straight, so a run of collinear staircase pixels collapses while a
// genuinely curved terminal keeps all the points it needs. That
// error-bounded property is exactly what "don't destroy the character"
// requires — the deviation can never exceed the tolerance anywhere.
export function simplifyPolyline(points, tolerance) {
    if (tolerance <= 0 || points.length <= 2) return points.slice();

    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];

    while (stack.length) {
        const [first, last] = stack.pop();
        let maxDist = -1;
        let index = -1;
        for (let i = first + 1; i < last; i++) {
            const d = perpendicularDistance(points[i], points[first], points[last]);
            if (d > maxDist) { maxDist = d; index = i; }
        }
        if (maxDist > tolerance && index !== -1) {
            keep[index] = 1;
            stack.push([first, index], [index, last]);
        }
    }

    const out = [];
    for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
    return out;
}

function perpendicularDistance(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const denom = dx * dx + dy * dy;
    // Degenerate segment (a == b, which happens on a closed loop where
    // both ends are the anchor node): fall back to point distance.
    if (denom === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / denom;
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    return Math.hypot(p.x - cx, p.y - cy);
}

// Chaikin corner cutting, with a strength dial and optional endpoint
// pinning. Chaikin is used instead of a moving average because it is
// interpolation-free and shrinks the curve far less: it replaces each
// segment with its quarter/three-quarter points, which rounds a hard
// pixel corner without pulling the whole polyline toward its own mean.
// A moving average visibly deflates bowls ('O', 'e') and shortens
// terminals; Chaikin at these settings does not.
//
// Endpoints are pinned by default because terminals carry a great deal
// of a typeface's identity, and every unpinned pass walks them inward.
export function smoothPolyline(points, passes, strength, preserveEndpoints) {
    if (passes <= 0 || points.length <= 2 || strength <= 0) return points.slice();
    let cur = points.slice();
    const closed = isClosed(points);

    for (let pass = 0; pass < passes; pass++) {
        const next = [];
        if (!closed) next.push(cur[0]);
        for (let i = 0; i < cur.length - 1; i++) {
            const p = cur[i];
            const q = cur[i + 1];
            const q1 = { x: p.x + (q.x - p.x) * 0.25 * strength, y: p.y + (q.y - p.y) * 0.25 * strength };
            const q3 = { x: p.x + (q.x - p.x) * (1 - 0.25 * strength), y: p.y + (q.y - p.y) * (1 - 0.25 * strength) };
            next.push(q1, q3);
        }
        if (!closed) next.push(cur[cur.length - 1]);
        else next.push(next[0]);
        cur = next;
    }

    if (preserveEndpoints && !closed) {
        cur[0] = points[0];
        cur[cur.length - 1] = points[points.length - 1];
    }
    return cur;
}

function isClosed(points) {
    if (points.length < 3) return false;
    const a = points[0];
    const b = points[points.length - 1];
    return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

// Applies simplify + smooth to every edge of a graph, in raster space,
// and records before/after counts so the debug panel can show exactly
// how much each knob actually removed on this glyph.
export function cleanupEdgeGeometry(graph, config) {
    const tolerance = scaleForResolution(config, config.simplifyTolerancePx);
    let pointsBefore = 0;
    let pointsAfterSimplify = 0;
    let pointsAfter = 0;

    for (const edge of graph.edges) {
        pointsBefore += edge.pointsPx.length;
        const simplified = simplifyPolyline(edge.pointsPx, tolerance);
        pointsAfterSimplify += simplified.length;
        const smoothed = smoothPolyline(
            simplified,
            config.smoothingPasses,
            config.smoothingStrength,
            config.preserveEndpointsWhileSmoothing,
        );
        edge.rawPointsPx = edge.pointsPx;
        edge.pointsPx = smoothed;
        edge.lengthPx = polylineLength(smoothed);
        pointsAfter += smoothed.length;
    }

    return { pointsBefore, pointsAfterSimplify, pointsAfter, tolerance };
}
