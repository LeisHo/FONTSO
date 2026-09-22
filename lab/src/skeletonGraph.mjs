// ====================================================================
// Stage 4 — Skeleton graph construction (1px skeleton -> nodes + edges)
// ====================================================================
// The brief is explicit that the skeleton must be treated as a GRAPH,
// not assumed to be one continuous line — because it genuinely isn't.
// An 'i' is two components. An 'O' is a single closed loop with no
// endpoints at all. A 'B' has junctions with degree 3 and two loops.
// An '&' has a junction of degree 4 and a crossing. All of that has to
// be represented explicitly for any later traversal algorithm to have
// something to reason about.
//
// CONSTRUCTION
//   1. Classify each pixel by its CROSSING NUMBER T — the count of
//      0->1 transitions around its 8-neighbour ring:
//        T == 1  -> endpoint   (a terminal: the tip of a stem, a serif)
//        T == 2  -> path pixel (interior of an edge; not a node)
//        T >= 3  -> junction   (strokes genuinely meet)
//
//      *** NOT a raw neighbour count. *** This was originally written
//      as "count the 8-neighbours" and it was badly wrong — measured on
//      Comic Sans, it reported 23 junctions for 'O' (which has none at
//      all) and 3 endpoints for 'H' (which has four). The reason is
//      that a 1px diagonal staircase has corner pixels with three
//      neighbours that are not junctions in any meaningful sense:
//
//          X X .          the centre pixel touches NW, N and SE,
//          . P .          so count == 3 -> "junction" (wrong),
//          . . X          but T == 2 -> "path pixel" (right).
//
//      Crossing number asks the question that actually matters — how
//      many distinct strokes arrive here — instead of how many pixels
//      happen to be adjacent. Since a glyph skeleton is mostly curves,
//      almost every pixel on every diagonal hit the miscount, which is
//      why the symptom was so widespread rather than a rare edge case.
//   2. Adjacent junction pixels are MERGED into one node (see below).
//   3. Edges are traced by walking degree-2 chains between nodes.
//   4. Any leftover pixels form node-free closed rings ('O', 'o', the
//      bowl of a 'b'); each gets a synthetic anchor node so it can be
//      represented as a normal self-edge rather than a special case.
//
// WHY JUNCTIONS ARE MERGED
// Thinning almost never leaves a single clean pixel where three strokes
// meet — it leaves a 2-4 pixel clump, each member of which has degree
// 3+. Treating each as its own node manufactures a knot of zero-length
// edges exactly where the graph's topology matters most, and any
// traversal built on it would emit a burst of meaningless micro-moves.
// Merging by connected component of junction pixels collapses that
// clump to one node at its centroid, which is both topologically right
// and geometrically closer to where a human would say the strokes meet.
// ====================================================================

// Area thresholds scale with the SQUARE of the resolution change, since
// they are areas; the linear helper in config.mjs is for lengths.
export function scaleAreaForResolution(config, valuePx) {
    const k = config.rasterEmHeight / 256;
    return valuePx * k * k;
}

export function sourceArea(maskInfo, pixelIndex) {
    if (!maskInfo) return Infinity;
    const label = maskInfo.labels[pixelIndex];
    return label >= 0 ? maskInfo.areas[label] : 0;
}

const NEIGHBOUR_DELTAS = [
    [0, -1], [1, -1], [1, 0], [1, 1],
    [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

export function buildSkeletonGraph(skeleton, width, height, config, maskInfo = null) {
    const px = Uint8Array.from(skeleton);
    const stats = { isolatedRemoved: 0 };

    // crossing[i] = T (see header). neighbourCount[i] is kept only to
    // detect genuinely isolated pixels, which have T == 0 as well.
    const crossing = new Int8Array(px.length);
    const nCount = new Int8Array(px.length);
    const ring = new Uint8Array(8);

    const classify = () => {
        crossing.fill(0);
        nCount.fill(0);
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const i = y * width + x;
                if (!px[i]) continue;
                let count = 0;
                for (let k = 0; k < 8; k++) {
                    const [dx, dy] = NEIGHBOUR_DELTAS[k];
                    const v = px[i + dy * width + dx] ? 1 : 0;
                    ring[k] = v;
                    count += v;
                }
                let t = 0;
                for (let k = 0; k < 8; k++) {
                    if (ring[k] === 0 && ring[(k + 1) & 7] === 1) t++;
                }
                crossing[i] = t;
                nCount[i] = count;
            }
        }
    };
    classify();

    if (config.removeIsolatedPixels) {
        // Area-aware: an isolated skeleton pixel sitting inside a large
        // mask region is a real feature that simply thinned to a point
        // (the dot of an 'i' does exactly this). Only genuinely tiny
        // source regions are noise.
        const minArea = scaleAreaForResolution(config, config.minSourceAreaPx);
        let removed = 0;
        for (let i = 0; i < px.length; i++) {
            if (px[i] && nCount[i] === 0) {
                if (maskInfo && sourceArea(maskInfo, i) >= minArea) continue;
                px[i] = 0;
                removed++;
            }
        }
        if (removed) {
            stats.isolatedRemoved = removed;
            classify();
        }
    }

    const nodes = [];
    const pixelToNode = new Map();

    const addNode = (pixels, kind) => {
        let sx = 0;
        let sy = 0;
        for (const i of pixels) {
            sx += i % width;
            sy += Math.floor(i / width);
        }
        const node = {
            id: nodes.length,
            kind,
            x: sx / pixels.length,
            y: sy / pixels.length,
            pixels: pixels.slice(),
            edgeIds: [],
        };
        nodes.push(node);
        for (const i of pixels) pixelToNode.set(i, node.id);
        return node;
    };

    // Junction clusters first, so that an endpoint sitting right next to
    // a junction resolves against an already-merged node.
    const seenJunction = new Set();
    for (let i = 0; i < px.length; i++) {
        if (!px[i] || crossing[i] < 3 || seenJunction.has(i)) continue;
        const cluster = [];
        const stack = [i];
        seenJunction.add(i);
        while (stack.length) {
            const cur = stack.pop();
            cluster.push(cur);
            const cx = cur % width;
            const cy = Math.floor(cur / width);
            for (const [dx, dy] of NEIGHBOUR_DELTAS) {
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const ni = ny * width + nx;
                if (!px[ni] || crossing[ni] < 3 || seenJunction.has(ni)) continue;
                if (!config.mergeAdjacentJunctions) continue;
                seenJunction.add(ni);
                stack.push(ni);
            }
        }
        addNode(cluster, 'junction');
    }

    for (let i = 0; i < px.length; i++) {
        if (px[i] && crossing[i] === 1 && !pixelToNode.has(i)) addNode([i], 'endpoint');
    }

    // ---- Edge tracing -------------------------------------------------
    const edges = [];
    const usedHalfEdge = new Set();
    const key = (a, b) => a * px.length + b;

    const neighboursOf = (i) => {
        const out = [];
        const cx = i % width;
        const cy = Math.floor(i / width);
        for (const [dx, dy] of NEIGHBOUR_DELTAS) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const ni = ny * width + nx;
            if (px[ni]) out.push(ni);
        }
        return out;
    };

    const areAdjacent = (a, b) => {
        const ax = a % width;
        const ay = Math.floor(a / width);
        const bx = b % width;
        const by = Math.floor(b / width);
        return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1 && a !== b;
    };

    const isOrthogonal = (a, b) => {
        const ax = a % width;
        const ay = Math.floor(a / width);
        const bx = b % width;
        const by = Math.floor(b / width);
        return (ax === bx) !== (ay === by);
    };

    // See the long comment at the call site for why this is not simply
    // "the neighbour that isn't prev".
    const chooseNext = (cur, prev, walked) => {
        const ns = neighboursOf(cur).filter((n) => n !== prev);
        if (!ns.length) return -1;

        // 1. A node always wins: reaching one ends the edge cleanly.
        const node = ns.find((n) => pixelToNode.has(n));
        if (node !== undefined) return node;

        // 2. Genuine continuations: not behind us, not already walked.
        const forward = ns.filter((n) => !areAdjacent(n, prev) && !walked.has(n));
        if (forward.length) {
            const ortho = forward.find((n) => isOrthogonal(cur, n));
            return ortho !== undefined ? ortho : forward[0];
        }

        // 3. Nothing clean left. Accept any unwalked neighbour rather
        //    than stalling — this is the corner case where a corridor
        //    is only one pixel wide and doubles back on itself.
        const unwalked = ns.filter((n) => !walked.has(n));
        return unwalked.length ? unwalked[0] : -1;
    };

    const traceFrom = (startNode, firstPixelOfNode, firstStep) => {
        if (usedHalfEdge.has(key(firstPixelOfNode, firstStep))) return null;
        const chain = [];
        let prev = firstPixelOfNode;
        let cur = firstStep;

        // Walk the corridor until another node is reached. The guard on
        // chain length is a cycle safety net; a well-formed skeleton
        // always terminates at a node or back at the start.
        //
        // CHOOSING THE NEXT PIXEL IS NOT "any neighbour that isn't the
        // previous one". A path pixel on a diagonal staircase has THREE
        // neighbours (see the header's crossing-number note), two of
        // which sit behind the walk:
        //
        //     X X .     arriving at P from NW, both N and SE are
        //     . P .     candidates — but N is part of the corner we
        //     . . X     just came through, not the way forward.
        //
        // Stepping to N would double back and re-walk the corridor.
        // The fix is to prefer a neighbour that is NOT itself 8-adjacent
        // to `prev`: the corner pixel always is, the genuine
        // continuation never is. Orthogonal candidates are preferred
        // over diagonal ones to keep the traced polyline on the pixel
        // centres rather than cutting corners.
        const walked = new Set([firstPixelOfNode]);
        while (!pixelToNode.has(cur) && chain.length <= px.length) {
            chain.push(cur);
            walked.add(cur);
            const next = chooseNext(cur, prev, walked);
            if (next === -1) break; // degenerate dead end
            prev = cur;
            cur = next;
        }

        const endNodeId = pixelToNode.has(cur) ? pixelToNode.get(cur) : null;
        usedHalfEdge.add(key(firstPixelOfNode, firstStep));
        if (endNodeId !== null) usedHalfEdge.add(key(cur, prev));

        const endNode = endNodeId !== null ? nodes[endNodeId] : null;
        const pointsPx = [{ x: startNode.x, y: startNode.y }];
        for (const i of chain) pointsPx.push({ x: i % width, y: Math.floor(i / width) });
        if (endNode) pointsPx.push({ x: endNode.x, y: endNode.y });

        const edge = {
            id: edges.length,
            a: startNode.id,
            b: endNodeId !== null ? endNodeId : startNode.id,
            isLoop: endNodeId === startNode.id,
            isDangling: endNodeId === null,
            pixels: chain,
            pointsPx,
            lengthPx: polylineLength(pointsPx),
        };
        edges.push(edge);
        startNode.edgeIds.push(edge.id);
        if (endNode && endNode !== startNode) endNode.edgeIds.push(edge.id);
        else if (endNode === startNode) startNode.edgeIds.push(edge.id); // self-loop uses both ends
        return edge;
    };

    for (const node of nodes) {
        for (const p of node.pixels) {
            for (const n of neighboursOf(p)) {
                if (pixelToNode.get(n) === node.id) continue; // inside the same merged cluster
                traceFrom(node, p, n);
            }
        }
    }

    // ---- Node-free closed rings ---------------------------------------
    // An 'O' has no endpoints and no junctions: every pixel has degree 2,
    // so the loop above found nothing to start from. Anchor each such
    // ring at an arbitrary pixel and trace it as a self-edge. Without
    // this, the most common letter shape in any alphabet would silently
    // produce an empty graph.
    const visitedRingPixel = new Set();
    for (const e of edges) for (const p of e.pixels) visitedRingPixel.add(p);
    for (let i = 0; i < px.length; i++) {
        if (!px[i] || pixelToNode.has(i) || visitedRingPixel.has(i)) continue;
        const ns = neighboursOf(i);

        // A surviving pixel with NO neighbours is a dot — the tittle of
        // an 'i' or 'j', a full stop, one half of a colon. It reached
        // this point instead of being deleted because its source mask
        // region was large enough to be real (see the area test above).
        //
        // It gets a zero-length self-edge rather than being left as a
        // bare node. The brief requires disconnected parts to be
        // represented as segments, and every downstream stage
        // (vectorise, traverse, animate) already handles edges
        // uniformly — whereas a node with no edge silently drops out of
        // the traversal entirely, which is exactly what happened to the
        // dot of Comic Sans 'i' before this. Length stays honestly 0: a
        // dot has position, not a stroke, and inventing a few pixels of
        // travel for it would be fabricating geometry the glyph does
        // not contain.
        if (!ns.length) {
            const dotNode = addNode([i], 'dot');
            const p = { x: i % width, y: Math.floor(i / width) };
            const edge = {
                id: edges.length,
                a: dotNode.id,
                b: dotNode.id,
                isLoop: true,
                isDot: true,
                isDangling: false,
                pixels: [i],
                pointsPx: [p, { ...p }],
                lengthPx: 0,
            };
            edges.push(edge);
            dotNode.edgeIds.push(edge.id);
            visitedRingPixel.add(i);
            continue;
        }

        const anchor = addNode([i], 'loop-anchor');
        const edge = traceFrom(anchor, i, ns[0]);
        if (edge) for (const p of edge.pixels) visitedRingPixel.add(p);
        // Mark the whole ring visited even if tracing bailed, so a
        // malformed ring cannot spawn an anchor per pixel.
        const stack = [i];
        const seen = new Set([i]);
        while (stack.length) {
            const cur = stack.pop();
            visitedRingPixel.add(cur);
            for (const n of neighboursOf(cur)) {
                if (seen.has(n)) continue;
                seen.add(n);
                stack.push(n);
            }
        }
    }

    const components = findComponents(nodes, edges);
    return {
        nodes,
        edges,
        components,
        width,
        height,
        pixels: px,
        maskInfo,
        stats: {
            ...stats,
            nodeCount: nodes.length,
            edgeCount: edges.length,
            endpointCount: nodes.filter((n) => n.kind === 'endpoint').length,
            junctionCount: nodes.filter((n) => n.kind === 'junction').length,
            loopAnchorCount: nodes.filter((n) => n.kind === 'loop-anchor').length,
            dotCount: nodes.filter((n) => n.kind === 'dot').length,
            componentCount: components.length,
        },
    };
}

// Connected components over the node/edge graph. The eventual traversal
// planner needs these: each one is a piece the "pen" must reach
// separately, and the connectors between them are exactly where a
// future algorithm inserts travel moves.
export function findComponents(nodes, edges) {
    const parent = nodes.map((_, i) => i);
    const find = (a) => {
        while (parent[a] !== a) {
            parent[a] = parent[parent[a]];
            a = parent[a];
        }
        return a;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
    };
    for (const e of edges) union(e.a, e.b);

    const byRoot = new Map();
    for (const node of nodes) {
        const r = find(node.id);
        if (!byRoot.has(r)) byRoot.set(r, { id: byRoot.size, nodeIds: [], edgeIds: [], lengthPx: 0 });
        byRoot.get(r).nodeIds.push(node.id);
    }
    for (const e of edges) {
        const c = byRoot.get(find(e.a));
        if (!c) continue;
        c.edgeIds.push(e.id);
        c.lengthPx += e.lengthPx;
    }
    for (const c of byRoot.values()) {
        const ns = c.nodeIds.map((id) => nodes[id]);
        c.bounds = {
            minX: Math.min(...ns.map((n) => n.x)),
            minY: Math.min(...ns.map((n) => n.y)),
            maxX: Math.max(...ns.map((n) => n.x)),
            maxY: Math.max(...ns.map((n) => n.y)),
        };
    }
    return [...byRoot.values()];
}

export function polylineLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return total;
}
