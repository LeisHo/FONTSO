// ====================================================================
// Stage 6 — Vectorisation (graph edges -> portable path segments)
// ====================================================================
// Converts the raster-space graph into path segments carrying BOTH
// coordinate spaces:
//
//   pointsPx   — raster pixels. What the algorithm actually saw. Keep
//                it: every debugging question ("why is there a kink
//                here?") is answered in this space, and throwing it
//                away makes the pipeline opaque.
//   points     — font units. Resolution-independent and portable. A
//                consumer can re-render these at any size, or at a
//                different rasterEmHeight, and get the same shape.
//
// Emitting only font units would quietly couple every downstream
// consumer to whatever rasterEmHeight happened to be set when the data
// was generated. Emitting only pixels would make the output useless to
// an animation engine working in glyph space. So: both, always, with
// the transform that relates them included in the output.
// ====================================================================

import { polylineLength } from './skeletonGraph.mjs';

export function vectorizeGraph(graph, rasterResult, glyphData) {
    const { toFont } = rasterResult.transform;

    const segments = graph.edges.map((edge) => {
        const pointsPx = edge.pointsPx;
        const points = pointsPx.map((p) => toFont(p.x, p.y));
        return {
            id: edge.id,
            edgeId: edge.id,
            nodeA: edge.a,
            nodeB: edge.b,
            isLoop: !!edge.isLoop,
            isDangling: !!edge.isDangling,
            pointCount: pointsPx.length,
            lengthPx: polylineLength(pointsPx),
            lengthFontUnits: polylineLength(points),
            pointsPx,
            points,
            // Raw (pre-simplify, pre-smooth) geometry is retained so the
            // visualiser can show exactly what cleanup changed. This is
            // a laboratory tool; hiding the before-state would defeat
            // the point of having a tunable cleanup stage at all.
            rawPointsPx: edge.rawPointsPx || pointsPx,
        };
    });

    const nodes = graph.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        xPx: node.x,
        yPx: node.y,
        ...toFont(node.x, node.y),
        degree: new Set(node.edgeIds).size,
        edgeIds: [...new Set(node.edgeIds)],
    }));

    const components = graph.components.map((c) => ({
        id: c.id,
        nodeIds: c.nodeIds,
        edgeIds: c.edgeIds,
        lengthPx: c.lengthPx,
        boundsPx: c.bounds,
    }));

    return {
        segments,
        nodes,
        components,
        space: {
            unitsPerEm: glyphData.unitsPerEm,
            rasterWidth: rasterResult.width,
            rasterHeight: rasterResult.height,
            scale: rasterResult.transform.scale,
            offsetX: rasterResult.transform.offsetX,
            offsetY: rasterResult.transform.offsetY,
            note: 'pointsPx = points * scale + offset; y is screen-convention (down-positive) in both spaces.',
        },
        totals: {
            segmentCount: segments.length,
            totalLengthPx: segments.reduce((s, x) => s + x.lengthPx, 0),
            totalPoints: segments.reduce((s, x) => s + x.pointCount, 0),
        },
    };
}
