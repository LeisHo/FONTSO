// ====================================================================
// Pipeline orchestration
// ====================================================================
// The one place the stage order lives:
//
//   glyph -> raster mask -> thinning -> graph -> cleanup -> (rebuild)
//         -> vectorise -> traverse
//
// Nothing here implements geometry. It wires stages together, times
// each one, and keeps every intermediate artifact so the visualiser can
// show any layer and the debug panel can explain what each stage did.
// Keeping the intermediates is a deliberate memory-for-insight trade:
// this is a laboratory, and a pipeline that discards its own working is
// one you cannot diagnose.
//
// THE PRUNE LOOP IS WHY GRAPH CONSTRUCTION APPEARS TWICE.
// Cleanup prunes by erasing pixels from the skeleton bitmap (see
// cleanup.mjs's own note on why), so the graph must be rebuilt from the
// modified bitmap afterwards. Rebuilding is cheap relative to thinning
// and completely sidesteps incremental graph surgery.
// ====================================================================

import { makeConfig } from './config.mjs';
import { extractText } from './glyphExtract.mjs';
import { rasterizeGlyph, labelMaskComponents } from './rasterize.mjs';
import { distanceTransform } from './distanceTransform.mjs';
import { skeletonize } from './skeletonize.mjs';
import { buildSkeletonGraph } from './skeletonGraph.mjs';
import { pruneSpurs, dropTinyComponents, dropTinySelfLoops, cleanupEdgeGeometry } from './cleanup.mjs';
import { vectorizeGraph } from './vectorize.mjs';
import { buildTraversal } from './traversal.mjs';

// `text` may be a single character or a whole string -- extractText
// handles both, and everything downstream is identical either way (see
// that function's own note on why the layout happens at extraction).
export function runPipeline(font, text, configOverrides = {}) {
    const config = makeConfig(configOverrides);
    const timings = {};
    const warnings = [];
    const t = (name, fn) => {
        const t0 = performance.now();
        const result = fn();
        timings[name] = +(performance.now() - t0).toFixed(2);
        return result;
    };

    // Stage failures are returned, not thrown. A laboratory tool should
    // report "this glyph is blank" or "the mask came out empty" with
    // whatever partial artifacts it did manage to produce, rather than
    // going white-screen — the brief asks explicitly for graceful
    // failure on problematic geometry.
    try {
        const glyph = t('extract', () => extractText(font, text, {
            kerning: config.useKerning,
            letterSpacing: config.letterSpacingUnits,
        }));
        const raster = t('rasterize', () => rasterizeGlyph(glyph, config));

        if (raster.fillRatio > 0.7) {
            warnings.push(
                `Mask coverage is ${(raster.fillRatio * 100).toFixed(0)}% — unusually solid. The glyph may have inverted winding, or alphaThreshold may be too low.`,
            );
        }

        // Labelled ONCE, from the original mask, and reused by every
        // graph rebuild: this is what lets cleanup tell a real dot from
        // an anti-aliasing speck (see labelMaskComponents' own note).
        const maskInfo = t('labelMask', () => labelMaskComponents(raster.mask, raster.width, raster.height));

        const thin = t('skeletonize', () => skeletonize(raster.mask, raster.width, raster.height, config));
        if (!thin.converged) {
            warnings.push(`Thinning hit the ${config.maxThinningIterations}-iteration cap without converging. The skeleton may still be thicker than 1px.`);
        }
        if (thin.skeletonPixels === 0) {
            return failure('skeletonize', 'Thinning removed every pixel — the mask was probably 1px thin already, or empty.', { config, glyph, raster, thin, timings, warnings });
        }

        // ---- Cleanup: prune -> rebuild, to a fixed point -------------
        const cleanupLog = [];
        let graph = t('graph', () => buildSkeletonGraph(thin.skeleton, raster.width, raster.height, config, maskInfo));
        const graphBeforeCleanup = summariseGraph(graph);

        const tClean0 = performance.now();
        for (let pass = 0; pass < config.pruneIterations; pass++) {
            const spur = pruneSpurs(graph, config);
            const tiny = dropTinyComponents(graph, config);
            cleanupLog.push({ pass, ...spur, ...tiny });
            if (!spur.changed && !tiny.changed) break;
            graph = buildSkeletonGraph(graph.pixels, raster.width, raster.height, config, maskInfo);
        }
        // One final tiny-component sweep for anything a late prune
        // orphaned (pruning a spur can isolate the stub it hung off).
        const finalTiny = dropTinyComponents(graph, config);
        if (finalTiny.changed) {
            cleanupLog.push({ pass: 'final', ...finalTiny });
            graph = buildSkeletonGraph(graph.pixels, raster.width, raster.height, config, maskInfo);
        }
        // Must run AFTER the last rebuild: rebuilding from pixels would
        // recreate these edges, since their pixels are deliberately left in
        // place (see dropTinySelfLoops' own note).
        const loopDrop = dropTinySelfLoops(graph, config);
        if (loopDrop.removedLoops) cleanupLog.push({ pass: 'self-loops', ...loopDrop });
        const geometry = cleanupEdgeGeometry(graph, config);
        timings.cleanup = +(performance.now() - tClean0).toFixed(2);

        if (!graph.edges.length) {
            return failure('cleanup', 'Cleanup removed every edge. Lower minBranchLengthPx / minSourceAreaPx, or raise rasterEmHeight.', { config, glyph, raster, thin, graph, timings, warnings });
        }

        const vector = t('vectorize', () => vectorizeGraph(graph, raster, glyph));

        // Computed ONCE per pipeline run and handed out with the result.
        // The centreline->outline tween needs the local half-thickness at
        // every skeleton point, which is exactly this field sampled there
        // (see distanceTransform.mjs). Kept here rather than in the tween
        // module because it depends only on the mask: the tween's own
        // settings can then be re-applied on every slider tick without
        // re-rasterising or re-thinning anything.
        const distanceField = t('distanceField', () => distanceTransform(raster.mask, raster.width, raster.height));
        const traversal = t('traverse', () => buildTraversal(vector, config));

        if (!traversal.stats.complete) {
            warnings.push(`Traversal covered ${traversal.stats.edgesCovered}/${traversal.stats.edgesTotal} edges — some edges were unreachable from their component's start node.`);
        }

        timings.total = +Object.values(timings).reduce((a, b) => a + b, 0).toFixed(2);

        return {
            ok: true,
            char: text,
            text,
            config,
            glyph,
            raster,
            thin,
            graph,
            graphBeforeCleanup,
            distanceField,
            cleanup: { log: cleanupLog, geometry },
            vector,
            traversal,
            timings,
            warnings,
        };
    } catch (err) {
        return failure(err.name || 'pipeline', err.message || String(err), { config, timings, warnings });
    }
}

function failure(stage, message, partial) {
    return { ok: false, stage, error: message, warnings: partial.warnings || [], ...partial };
}

function summariseGraph(graph) {
    return {
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        componentCount: graph.components.length,
        totalLengthPx: graph.edges.reduce((s, e) => s + e.lengthPx, 0),
    };
}

// Trimmed, JSON-safe view of a run for the debug panel. Typed arrays,
// the full pixel list of every edge and the flattened animation table
// are all omitted — they are megabytes and unreadable — while keeping
// everything the brief asks to be inspectable: skeleton points, nodes,
// edges, segments, traversal order, components, and the parameters that
// produced them.
export function toDebugJSON(result, { maxPointsPerSegment = 80 } = {}) {
    if (!result || !result.ok) {
        return { ok: false, stage: result && result.stage, error: result && result.error, config: result && result.config };
    }
    const clip = (pts) => {
        if (!pts) return [];
        const r = (p) => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) });
        if (pts.length <= maxPointsPerSegment) return pts.map(r);
        const step = pts.length / maxPointsPerSegment;
        const out = [];
        for (let i = 0; i < maxPointsPerSegment; i++) out.push(r(pts[Math.floor(i * step)]));
        out.push(r(pts[pts.length - 1]));
        return out;
    };

    return {
        ok: true,
        character: result.char,
        cleanupParameters: result.config,
        timingsMs: result.timings,
        warnings: result.warnings,
        glyph: {
            text: result.glyph.text,
            glyphCount: result.glyph.glyphCount,
            glyphs: result.glyph.glyphs,
            skipped: result.glyph.skipped,
            totalAdvance: result.glyph.totalAdvance,
            glyphIndex: result.glyph.glyphIndex,
            glyphName: result.glyph.glyphName,
            unitsPerEm: result.glyph.unitsPerEm,
            advanceWidth: result.glyph.advanceWidth,
            contourCount: result.glyph.contourCount,
            boundsFontUnits: result.glyph.bounds,
        },
        raster: {
            width: result.raster.width,
            height: result.raster.height,
            filledPixels: result.raster.filledPixels,
            fillRatio: +result.raster.fillRatio.toFixed(4),
            transform: {
                scale: result.raster.transform.scale,
                offsetX: +result.raster.transform.offsetX.toFixed(3),
                offsetY: +result.raster.transform.offsetY.toFixed(3),
            },
        },
        skeleton: {
            algorithm: result.thin.algorithm,
            iterations: result.thin.iterations,
            converged: result.thin.converged,
            pixelsRemovedByThinning: result.thin.removedTotal,
            redundantPixelsRemoved: result.thin.redundantRemoved,
            skeletonPixelCount: result.thin.skeletonPixels,
        },
        cleanupEffect: {
            beforePruning: result.graphBeforeCleanup,
            afterPruning: summariseGraph(result.graph),
            passes: result.cleanup.log,
            polylinePoints: result.cleanup.geometry,
        },
        graph: {
            stats: result.graph.stats,
            nodes: result.vector.nodes.map((n) => ({
                id: n.id,
                kind: n.kind,
                degree: n.degree,
                rasterPx: { x: +n.xPx.toFixed(2), y: +n.yPx.toFixed(2) },
                fontUnits: { x: +n.x.toFixed(1), y: +n.y.toFixed(1) },
                edgeIds: n.edgeIds,
            })),
            edges: result.vector.segments.map((s) => ({
                id: s.id,
                nodeA: s.nodeA,
                nodeB: s.nodeB,
                isLoop: s.isLoop,
                pointCount: s.pointCount,
                lengthPx: +s.lengthPx.toFixed(2),
                lengthFontUnits: +s.lengthFontUnits.toFixed(1),
            })),
            components: result.vector.components.map((c) => ({
                id: c.id,
                nodes: c.nodeIds.length,
                edges: c.edgeIds.length,
                lengthPx: +c.lengthPx.toFixed(2),
            })),
        },
        pathSegments: result.vector.segments.map((s) => ({
            id: s.id,
            lengthPx: +s.lengthPx.toFixed(2),
            pointsFontUnits: clip(s.points),
        })),
        traversal: {
            stats: result.traversal.stats,
            order: result.traversal.order.map((o) => ({ ...o, lengthPx: +o.lengthPx.toFixed(2) })),
            junctionDecisions: result.traversal.decisions.map((d) => ({
                ...d,
                turnDegrees: +d.turnDegrees.toFixed(1),
            })),
            totalRouteLengthPx: +result.traversal.animation.totalLength.toFixed(2),
        },
        coordinateSpace: result.vector.space,
    };
}
