// ====================================================================
// Stage 7 — Traversal (graph -> ordered, drawable, animatable route)
// ====================================================================
// SCOPE, STATED UP FRONT: this is deliberately NOT a handwriting
// stroke-order solver. The brief asks for a deterministic prototype
// traversal that exposes enough geometry and connectivity for a future
// algorithm to do that properly — not a guess at how a human writes.
// So this produces a defensible, repeatable route and, crucially,
// leaves every decision point visible in the output.
//
// THE ALGORITHM
// A depth-first walk of each connected component, which is an ordinary
// graph traversal with three type-specific choices:
//
//   1. Components are ordered left-to-right, then top-to-bottom, by
//      their bounding box. Reading order, and stable across runs.
//   2. Within a component the walk starts at the topmost-leftmost
//      ENDPOINT where one exists — a free tip is where a pen naturally
//      lands. A component with no endpoints at all (a closed ring like
//      'O') has no such tip, so it starts at its topmost point, which
//      is where most writers begin a bowl.
//   3. At a junction, the unvisited edge whose initial direction turns
//      LEAST from the current heading is taken first. This is the one
//      genuinely shape-aware choice here, and it is what makes the
//      route follow a stroke through a crossing instead of taking a
//      hard turn at every branch. On an 'H' it keeps the pen running
//      down a stem rather than veering into the crossbar mid-stroke.
//
// Every edge is emitted exactly once. Where the walk must jump — across
// a component, or back to an unfinished branch — an explicit CONNECTOR
// segment is emitted rather than silently teleporting.
//
// WHY CONNECTORS ARE EXPLICIT AND FIRST-CLASS
// They are the hook the brief asks for. A connector records where the
// pen was, where it must get to, and whether the gap is a real break in
// the glyph (`componentJump`) or a retrace within one connected piece
// (`backtrack`). A later algorithm can turn a backtrack into a U-turn
// along the existing stroke, and a componentJump into a pen-lift —
// without re-deriving any of the topology. Nothing about the 'H' route
// in the brief is encoded here; it falls out of rules 1-3 or it doesn't.
// ====================================================================

import { polylineLength } from './skeletonGraph.mjs';

export function buildTraversal(vector, config) {
    const { segments, nodes, components } = vector;

    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const segById = new Map(segments.map((s) => [s.id, s]));

    // Component order. Reading order (left-to-right, then top-to-bottom)
    // is deterministic but can send the pen back across the whole glyph;
    // nearest-first picks whichever unvisited component is closest to
    // where the pen actually is, which is what minimises travel. The
    // first pick has no pen position yet, so it falls back to reading
    // order and the run stays reproducible.
    const readingOrder = [...components].sort((a, b) => {
        const ab = a.boundsPx;
        const bb = b.boundsPx;
        if (Math.abs(ab.minX - bb.minX) > 1) return ab.minX - bb.minX;
        return ab.minY - bb.minY;
    });

    const visitedEdges = new Set();
    const out = [];
    let cursor = null;
    const decisions = [];

    const pending = readingOrder.slice();
    while (pending.length) {
        // Nearest-first selection among the components still to draw.
        let pickIdx = 0;
        if (config.nearestRouting !== false && cursor) {
            let bestD = Infinity;
            // Same directional cost as the tween router: only leftward
            // movement is penalised, so the pen sweeps rightwards across
            // a word instead of doubling back between letters.
            const bias = config.rightwardBias || 0;
            for (let i = 0; i < pending.length; i++) {
                const n = nearestNodeInComponent(pending[i], nodeById, segById, cursor);
                if (!n) continue;
                const node = nodeById.get(n.nodeId);
                const leftward = node ? Math.max(0, cursor.x - node.xPx) : 0;
                const cost = n.distance + bias * leftward;
                if (cost < bestD) { bestD = cost; pickIdx = i; }
            }
        }
        const comp = pending.splice(pickIdx, 1)[0];

        const compEdges = comp.edgeIds.filter((id) => segById.has(id));
        if (!compEdges.length) continue;

        // Enter the component at the node closest to the pen, rather
        // than always at its topmost-leftmost free tip.
        const nearest = (config.nearestRouting !== false && cursor)
            ? nearestNodeInComponent(comp, nodeById, segById, cursor)
            : null;
        const start = nearest ? nearest.nodeId : chooseStartNode(comp, nodeById, segById);
        if (start == null) continue;

        if (cursor && config.emitConnectors) {
            out.push(makeConnector(cursor, pointOf(nodeById.get(start)), 'componentJump', comp.id));
        }
        cursor = pointOf(nodeById.get(start));

        // Iterative DFS with an explicit stack so a large glyph cannot
        // blow the call stack, and so the "where do I resume" decision
        // is inspectable rather than hidden in recursion.
        const stack = [start];
        while (stack.length) {
            const nodeId = stack[stack.length - 1];
            const node = nodeById.get(nodeId);
            const candidates = (node ? node.edgeIds : [])
                .filter((eid) => !visitedEdges.has(eid) && segById.has(eid));

            if (!candidates.length) {
                stack.pop();
                continue;
            }

            const heading = currentHeading(out);
            const chosen = pickStraightest(candidates, node, segById, nodeById, heading);
            decisions.push({
                atNode: nodeId,
                options: candidates.length,
                chosenEdge: chosen.edgeId,
                turnDegrees: chosen.turnDegrees,
                rule: candidates.length > 1 ? 'straightest-continuation' : 'only-option',
            });

            const seg = segById.get(chosen.edgeId);
            visitedEdges.add(chosen.edgeId);

            const pts = chosen.reversed ? [...seg.points].reverse() : seg.points;
            const ptsPx = chosen.reversed ? [...seg.pointsPx].reverse() : seg.pointsPx;

            // The walk may have popped back to an earlier node; if the
            // pen is not already there, that gap is a real backtrack and
            // is recorded as one.
            const head = ptsPx[0];
            if (cursor && distance(cursor, head) > 1e-6 && config.emitConnectors) {
                out.push(makeConnector(cursor, head, 'backtrack', comp.id));
            }

            out.push({
                kind: 'draw',
                edgeId: seg.id,
                componentId: comp.id,
                reversed: chosen.reversed,
                fromNode: chosen.fromNode,
                toNode: chosen.toNode,
                isLoop: seg.isLoop,
                pointsPx: ptsPx,
                points: pts,
                lengthPx: seg.lengthPx,
            });

            cursor = ptsPx[ptsPx.length - 1];
            const nextNode = chosen.toNode;
            if (nextNode != null && nextNode !== nodeId) stack.push(nextNode);
        }
    }

    const resampled = config.traversalResampleSpacingPx > 0
        ? out.map((s) => ({ ...s, pointsPx: resample(s.pointsPx, config.traversalResampleSpacingPx) }))
        : out;

    // One flattened polyline for the animator, plus a cumulative length
    // table so a dot can be placed at any normalised distance in O(log n)
    // without re-walking the route every frame.
    const flat = [];
    for (const seg of resampled) {
        for (let i = 0; i < seg.pointsPx.length; i++) {
            if (i === 0 && flat.length && distance(flat[flat.length - 1].p, seg.pointsPx[0]) < 1e-6) continue;
            flat.push({ p: seg.pointsPx[i], kind: seg.kind, edgeId: seg.edgeId ?? null });
        }
    }
    const cumulative = [0];
    for (let i = 1; i < flat.length; i++) {
        cumulative.push(cumulative[i - 1] + distance(flat[i - 1].p, flat[i].p));
    }

    const drawSegments = resampled.filter((s) => s.kind === 'draw');
    const connectors = resampled.filter((s) => s.kind === 'connector');

    return {
        segments: resampled,
        order: resampled.map((s, i) => ({
            index: i,
            kind: s.kind,
            edgeId: s.edgeId ?? null,
            componentId: s.componentId,
            connectorType: s.connectorType || null,
            lengthPx: s.kind === 'draw' ? s.lengthPx : polylineLength(s.pointsPx),
        })),
        decisions,
        animation: { flat, cumulative, totalLength: cumulative[cumulative.length - 1] || 0 },
        stats: {
            drawCount: drawSegments.length,
            connectorCount: connectors.length,
            componentJumps: connectors.filter((c) => c.connectorType === 'componentJump').length,
            backtracks: connectors.filter((c) => c.connectorType === 'backtrack').length,
            edgesCovered: visitedEdges.size,
            edgesTotal: segments.length,
            // If these two ever disagree, an edge was unreachable — a
            // real bug worth surfacing, not silently tolerating.
            complete: visitedEdges.size === segments.length,
        },
    };
}

// Closest node of a component to `from`, used for both "which component
// next" and "where to enter it".
function nearestNodeInComponent(comp, nodeById, segById, from) {
    let best = null;
    for (const nid of comp.nodeIds) {
        const n = nodeById.get(nid);
        if (!n || !n.edgeIds.some((eid) => segById.has(eid))) continue;
        const d = Math.hypot(n.xPx - from.x, n.yPx - from.y);
        if (!best || d < best.distance) best = { nodeId: nid, distance: d };
    }
    return best;
}

function pointOf(node) {
    return node ? { x: node.xPx, y: node.yPx } : null;
}

function makeConnector(from, to, type, componentId) {
    return {
        kind: 'connector',
        connectorType: type,
        componentId,
        pointsPx: [from, to],
        points: null, // filled by the caller's space if needed; px is enough to animate
        lengthPx: distance(from, to),
    };
}

// Start at the topmost-leftmost free tip. Falling back to the topmost
// node of any kind is what lets a pure ring ('O', 'o') start somewhere
// sensible instead of at whatever pixel index happened to come first.
function chooseStartNode(comp, nodeById, segById) {
    const compNodes = comp.nodeIds
        .map((id) => nodeById.get(id))
        .filter(Boolean)
        .filter((n) => n.edgeIds.some((eid) => segById.has(eid)));
    if (!compNodes.length) return null;

    const endpoints = compNodes.filter((n) => n.kind === 'endpoint');
    const pool = endpoints.length ? endpoints : compNodes;
    let best = pool[0];
    for (const n of pool) {
        // Leftmost, tie-broken topmost: text is written left to right.
        if (n.xPx < best.xPx - 1 || (Math.abs(n.xPx - best.xPx) <= 1 && n.yPx < best.yPx)) best = n;
    }
    return best.id;
}

function currentHeading(out) {
    for (let i = out.length - 1; i >= 0; i--) {
        const s = out[i];
        if (s.kind !== 'draw') continue;
        const pts = s.pointsPx;
        if (pts.length < 2) continue;
        const a = pts[pts.length - 2];
        const b = pts[pts.length - 1];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d < 1e-9) continue;
        return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
    }
    return null;
}

// Among the unvisited edges at this node, take the one that continues
// the current heading most closely. With no heading yet (first stroke)
// the tie-break is a stable geometric one so runs stay deterministic.
function pickStraightest(candidateIds, node, segById, nodeById, heading) {
    let best = null;
    for (const eid of candidateIds) {
        const seg = segById.get(eid);
        const reversed = seg.nodeB === node.id && seg.nodeA !== node.id
            ? true
            : (seg.nodeA === node.id ? false : true);
        const ptsPx = reversed ? [...seg.pointsPx].reverse() : seg.pointsPx;
        const dir = initialDirection(ptsPx);
        let turn = 0;
        if (heading && dir) {
            const dot = Math.max(-1, Math.min(1, heading.x * dir.x + heading.y * dir.y));
            turn = (Math.acos(dot) * 180) / Math.PI;
        } else if (dir) {
            // No heading: prefer downward, then rightward. Matches how
            // most Latin strokes begin and keeps output reproducible.
            turn = (Math.atan2(-dir.y, dir.x) * 180) / Math.PI;
            turn = (turn + 360) % 360;
        }
        const toNode = reversed ? seg.nodeA : seg.nodeB;
        const cand = { edgeId: eid, reversed, turnDegrees: turn, fromNode: node.id, toNode };
        if (!best || cand.turnDegrees < best.turnDegrees) best = cand;
    }
    return best;
}

function initialDirection(pts) {
    for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[0].x;
        const dy = pts[i].y - pts[0].y;
        const d = Math.hypot(dx, dy);
        if (d > 1e-9) return { x: dx / d, y: dy / d };
    }
    return null;
}

function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

// Even point spacing so the animated dot travels at constant speed.
// Without it the dot sprints across long straight runs (which RDP has
// reduced to two points) and crawls through curves.
function resample(points, spacing) {
    if (!points || points.length < 2 || spacing <= 0) return points ? points.slice() : [];
    const out = [points[0]];
    let carry = 0;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const segLen = distance(a, b);
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
    if (distance(out[out.length - 1], last) > 1e-6) out.push(last);
    return out;
}
