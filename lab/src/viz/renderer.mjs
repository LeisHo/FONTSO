// ====================================================================
// Visualisation — layered canvas renderer
// ====================================================================
// One canvas, independently toggleable layers, drawn in raster-pixel
// space through a single fit transform. Overlay rather than side-by-
// side because the question this tool exists to answer — "does the
// skeleton actually correspond to THIS font's glyph?" — is answered by
// superimposing them, not by comparing two panels by eye.
//
// Layer order is deliberate: reference material (fill, outline, mask)
// underneath, derived geometry (skeleton, graph, route) on top, the
// animated dot last. Every layer keeps a fixed colour so a screenshot
// is self-describing.
// ====================================================================

import { buildRibbon } from '../adaptiveWidth.mjs';

export const LAYER_COLORS = {
    routePoint: '#4fc3f7',
    glyphFill: 'rgba(120, 130, 150, 0.22)',
    glyphOutline: 'rgba(150, 165, 195, 0.85)',
    mask: 'rgba(70, 95, 135, 0.45)',
    rawSkeleton: 'rgba(255, 170, 60, 0.75)',
    cleanSkeleton: '#31d67a',
    rawPolyline: 'rgba(255, 90, 90, 0.55)',
    endpoint: '#ff4d6d',
    junction: '#ffd230',
    loopAnchor: '#8b5cf6',
    tween: '#f59e0b',
    dotNode: '#38bdf8',
    connector: 'rgba(120, 200, 255, 0.85)',
    traversal: 'rgba(60, 200, 255, 0.95)',
    dot: '#ffffff',
    dotTrail: 'rgba(255, 255, 255, 0.35)',
};

// Render-only settings. Deliberately NOT in config.mjs: that file is the
// pipeline's parameter set, and every change to it re-runs the whole
// glyph→skeleton pass. These four only affect how the already-computed
// path is painted, so they belong here and cost a redraw, not a re-run.
export const DEFAULT_VIEW = {
    // Off by default so the laboratory still opens showing the honest
    // 2px centreline — thickness is a presentation effect, and the
    // default view should be the geometry, not a styled version of it.
    pathThicknessEnabled: false,
    pathThicknessPx: 8,
    pathColor: '#31d67a',
    // When true the thickness/colour applies ONLY to the portion the
    // animated dot has already travelled, leaving the rest at the plain
    // centreline width — so the path visibly "inks in" as the dot moves.
    progressiveThickness: false,
    // Width comes from the glyph's own distance field instead of the
    // Path Thickness slider. See adaptiveWidth.mjs for the two modes.
    adaptiveThickness: false,
    // How a drawn stroke ends where it meets a pen-up move: flat (off)
    // or rounded by the stroke's own half-width (on).
    strokeRoundCap: false,
};

export const DEFAULT_LAYERS = {
    glyphFill: true,
    glyphOutline: true,
    mask: false,
    rawSkeleton: false,
    rawPolyline: false,
    cleanSkeleton: true,
    nodes: true,
    traversal: false,
    connectors: true,
    order: false,
    // The ANIMATION route's stops - where the pen arrives for each
    // curve, in visit order. Distinct from `traversal`/`order` above,
    // which describe the midline traversal's segments regardless of
    // which route the animation is actually following.
    routePoints: false,
    routeOrder: false,
    dot: true,
    tween: true,
};

export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.result = null;
        this.layers = { ...DEFAULT_LAYERS };
        this.viewSettings = { ...DEFAULT_VIEW };
        this.view = { scale: 1, offsetX: 0, offsetY: 0 };
        this.dot = null; // {x, y} in raster px
        this.trail = [];
        // The trail split at pen-up moves; see animator.drawnRuns.
        this.trailRuns = null;
        // Set by the app whenever the tween is (re)computed. Held rather
        // than derived here so a slider tick costs one recompute, not one
        // per frame of the animation loop.
        this.tween = null;
        // 'midline' | 'tween'. Drives adaptiveMode(); pushed in by the
        // host so the renderer never has to guess which path the dot is
        // actually walking.
        this.animationPath = 'midline';
        // The live animation route, held so the Route Points layer draws
        // the same stops the animator is actually walking rather than a
        // separately recomputed guess.
        this.route = null;
        // Switch Point Order mode: the first stop clicked, awaiting a
        // second. Purely transient UI state - never saved.
        this.pendingStopId = null;
        // Owned by the viewport controller; see setResult().
        this.autoFit = true;
    }

    setRoute(route) {
        this.route = route || null;
    }

    setPendingStop(id) {
        this.pendingStopId = id == null ? null : String(id);
    }

    stops() {
        return (this.route && this.route.stops) || [];
    }

    setAnimationPath(kind) {
        this.animationPath = kind === 'tween' ? 'tween' : 'midline';
    }

    setTween(tween) {
        this.tween = tween;
    }

    setViewSettings(settings) {
        this.viewSettings = { ...this.viewSettings, ...settings };
    }

    setResult(result) {
        this.result = result;
        this.dot = null;
        this.trail = [];
        this.trailRuns = null;
        // Only re-frame when auto-fit is on. With it off the user's own
        // zoom/pan survives a glyph change, which is the whole point of
        // the setting: comparing the same region across several fonts.
        if (this.autoFit !== false) this.recomputeView();
    }

    setLayers(layers) {
        this.layers = { ...this.layers, ...layers };
    }

    // Fits the padded raster bounds into the canvas with a margin,
    // preserving aspect. Recomputed on resize so the glyph stays framed.
    recomputeView() {
        const c = this.canvas;
        const r = this.result;
        if (!r || !r.raster) {
            this.view = { scale: 1, offsetX: 0, offsetY: 0 };
            return;
        }
        const margin = 28;
        const availW = Math.max(1, c.width - margin * 2);
        const availH = Math.max(1, c.height - margin * 2);
        const scale = Math.min(availW / r.raster.width, availH / r.raster.height);
        this.view = {
            scale,
            offsetX: (c.width - r.raster.width * scale) / 2,
            offsetY: (c.height - r.raster.height * scale) / 2,
        };
    }

    toScreen(x, y) {
        return {
            x: x * this.view.scale + this.view.offsetX,
            y: y * this.view.scale + this.view.offsetY,
        };
    }

    resizeToDisplaySize() {
        const c = this.canvas;
        const dpr = window.devicePixelRatio || 1;
        const rect = c.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width * dpr));
        const h = Math.max(1, Math.round(rect.height * dpr));
        if (c.width !== w || c.height !== h) {
            c.width = w;
            c.height = h;
            // Re-fit only when the user has not taken manual control.
            // Refitting unconditionally would throw away a zoomed view
            // on every incidental resize, including the one the browser
            // fires while a panel is being dragged.
            if (this.autoFit !== false) this.recomputeView();
            return true;
        }
        return false;
    }

    draw() {
        const { ctx, canvas } = this;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const r = this.result;
        if (!r) {
            this.drawPlaceholder('Load a font and pick a character.');
            return;
        }
        if (!r.ok) {
            // Even a failed run usually has SOMETHING worth showing (the
            // mask, the raw skeleton). Draw whatever survived, then the
            // error, rather than a blank panel.
            if (r.raster) this.drawMask();
            this.drawPlaceholder(`${r.stage}: ${r.error}`, '#ff6b81');
            return;
        }

        if (this.layers.glyphFill) this.drawGlyphFill();
        if (this.layers.glyphOutline) this.drawGlyphOutline();
        if (this.layers.mask) this.drawMask();
        if (this.layers.rawSkeleton) this.drawRawSkeleton();
        if (this.layers.rawPolyline) this.drawRawPolylines();
        if (this.layers.cleanSkeleton) this.drawCleanSkeleton();
        if (this.layers.tween) this.drawTween();
        if (this.layers.traversal) this.drawTraversal();
        if (this.layers.connectors) this.drawConnectors();
        if (this.layers.nodes) this.drawNodes();
        if (this.layers.order) this.drawOrderLabels();
        // Above the geometry: these are clickable targets in Switch
        // Point Order mode, so they must never be hidden under a stroke.
        if (this.layers.routePoints) this.drawRoutePoints();
        if (this.layers.routeOrder) this.drawRouteOrderLabels();
        if (this.layers.dot) this.drawDot();
    }

    drawPlaceholder(text, color = '#5b6675') {
        const { ctx, canvas } = this;
        ctx.save();
        ctx.fillStyle = color;
        ctx.font = '13px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        wrapText(ctx, text, canvas.width / 2, canvas.height / 2, canvas.width - 60, 18);
        ctx.restore();
    }

    // The original outline, filled with the same nonzero winding the
    // rasteriser used — this is the ground truth every other layer is
    // judged against.
    drawGlyphFill() {
        const r = this.result;
        const { ctx } = this;
        const t = r.raster.transform;
        ctx.save();
        ctx.translate(this.view.offsetX, this.view.offsetY);
        ctx.scale(this.view.scale, this.view.scale);
        ctx.translate(t.offsetX, t.offsetY);
        ctx.scale(t.scale, t.scale);
        ctx.beginPath();
        replay(ctx, r.glyph.commands);
        ctx.fillStyle = LAYER_COLORS.glyphFill;
        ctx.fill('nonzero');
        ctx.restore();
    }

    drawGlyphOutline() {
        const r = this.result;
        const { ctx } = this;
        ctx.save();
        ctx.strokeStyle = LAYER_COLORS.glyphOutline;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const contour of r.glyph.contours) {
            for (let i = 0; i < contour.length; i++) {
                const p = r.raster.transform.toRaster(contour[i].x, contour[i].y);
                const s = this.toScreen(p.x, p.y);
                if (i === 0) ctx.moveTo(s.x, s.y);
                else ctx.lineTo(s.x, s.y);
            }
            ctx.closePath();
        }
        ctx.stroke();
        ctx.restore();
    }

    drawMask() {
        const r = this.result;
        if (!r.raster) return;
        const { ctx } = this;
        const px = Math.max(1, this.view.scale);
        ctx.save();
        ctx.fillStyle = LAYER_COLORS.mask;
        const { mask, width, height } = r.raster;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (!mask[y * width + x]) continue;
                const s = this.toScreen(x, y);
                ctx.fillRect(s.x, s.y, px, px);
            }
        }
        ctx.restore();
    }

    // The thinned bitmap BEFORE any pruning or polyline cleanup —
    // the honest, unretouched algorithm output, spurs and all.
    drawRawSkeleton() {
        const r = this.result;
        if (!r.thin) return;
        const { ctx } = this;
        const px = Math.max(1, this.view.scale);
        ctx.save();
        ctx.fillStyle = LAYER_COLORS.rawSkeleton;
        const { skeleton, width, height } = r.thin;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (!skeleton[y * width + x]) continue;
                const s = this.toScreen(x, y);
                ctx.fillRect(s.x, s.y, px, px);
            }
        }
        ctx.restore();
    }

    // Pre-simplify / pre-smooth polylines, so the effect of the cleanup
    // dials is directly visible against the cleaned version.
    drawRawPolylines() {
        const r = this.result;
        if (!r.vector) return;
        const { ctx } = this;
        ctx.save();
        ctx.strokeStyle = LAYER_COLORS.rawPolyline;
        ctx.lineWidth = 1;
        for (const seg of r.vector.segments) this.strokePolyline(seg.rawPointsPx);
        ctx.restore();
    }

    // Three cases, in one place so they cannot drift apart:
    //   thickness off              -> plain 2px centreline (the default;
    //                                 the honest view of the geometry)
    //   thickness on, progressive off -> whole path thick + coloured
    //   thickness on, progressive on  -> plain centreline underneath,
    //                                 with the travelled portion inked
    //                                 over it at full thickness
    //
    // The progressive case draws the trail HERE rather than in drawDot()
    // so that it survives turning the "Animated Dot" layer off: the
    // inked path is a property of the path, not of the dot marker.
    drawCleanSkeleton() {
        const r = this.result;
        if (!r.vector) return;
        const { ctx } = this;
        const v = this.viewSettings;
        const thick = v.pathThicknessEnabled;
        const inkWholePath = thick && !v.progressiveThickness;

        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = inkWholePath ? v.pathColor : LAYER_COLORS.cleanSkeleton;
        // Thickness is in RASTER pixels, so it has to go through the same
        // view scale as the geometry — otherwise the stroke would stay a
        // constant screen width while the glyph zoomed underneath it, and
        // the number in the panel would mean nothing.
        ctx.lineWidth = inkWholePath ? Math.max(1, v.pathThicknessPx * this.view.scale) : 2;

        // Adaptive replaces the stroke entirely rather than adjusting its
        // width: canvas lineWidth is a property of the whole path, so a
        // width that varies vertex by vertex has to be a filled ribbon.
        const adaptive = thick && v.adaptiveThickness && this.canMeasureWidth();
        if (adaptive && inkWholePath) {
            ctx.fillStyle = v.pathColor;
            // Ink whichever geometry the animation is actually set to
            // follow, so "adaptive" means the same thing whether or not
            // the dot is moving. Only the adaptive branch does this; the
            // plain-thickness branch below still inks the midline, which
            // is what it has always done.
            for (const src of this.inkSources()) {
                this.fillAdaptiveRibbon(src.pts, { closed: src.closed, mode: src.mode });
            }
        } else {
            for (const seg of r.vector.segments) this.strokePolyline(seg.pointsPx);
        }
        ctx.restore();

        if (thick && v.progressiveThickness && this.trail && this.trail.length > 1) {
            // PER RUN, not over the whole trail. The trail is continuous
            // across pen-up moves, so inking it as one path paints the
            // connectors too - and because a connector runs outside the
            // stroke where distance-to-outline is ~0, an adaptive ribbon
            // collapsed to its minimum width there. That read as "the
            // transitions are thinner" when the real fault was that the
            // transitions were being drawn at all.
            //
            // Drawing runs separately also makes the round cap mean
            // something: each stroke now genuinely ends where the pen
            // lifts, instead of being joined to the next one.
            const runs = (this.trailRuns && this.trailRuns.length)
                ? this.trailRuns
                : [this.trail];
            ctx.save();
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            if (adaptive) {
                // The travelled portion, painted out to the outline. On
                // the midline that fills the stroke from both sides; on a
                // tween curve it reaches the adjacent side only, so the
                // glyph is revealed one stroke-edge at a time.
                ctx.fillStyle = v.pathColor;
                for (const run of runs) {
                    this.fillAdaptiveRibbon(run, { closed: false, mode: this.trailMode() });
                }
            } else {
                ctx.strokeStyle = v.pathColor;
                ctx.lineCap = v.strokeRoundCap ? 'round' : 'butt';
                ctx.lineWidth = Math.max(1, v.pathThicknessPx * this.view.scale);
                for (const run of runs) this.strokePolyline(run);
            }
            ctx.restore();
        }
    }

    // Adaptive width needs the distance field the pipeline produced. It
    // is absent on a failed run, so callers check before relying on it
    // rather than silently drawing a zero-width ribbon.
    canMeasureWidth() {
        const r = this.result;
        return !!(r && r.distanceField && r.raster && r.raster.width && r.raster.height);
    }

    // How wide the ribbon grows. The MIDLINE is equidistant from both
    // outlines, so ±d covers the stroke. A TWEEN curve is off-centre, so
    // ±d would not: it spans instead, outward by d to the near outline
    // and inward to the far one, covering the full local stroke width
    // from a single curve.
    trailMode() {
        return this.animationPath === 'tween' ? 'span' : 'both';
    }

    // The polylines the adaptive ink is painted along, matching whatever
    // the animation is set to follow.
    inkSources() {
        const r = this.result;
        if (this.animationPath === 'tween' && this.tween && this.tween.curves) {
            const out = [];
            for (const c of this.tween.curves) {
                if (c.left && c.left.length > 1) out.push({ pts: c.left, closed: !!c.isLoop, mode: 'span' });
                if (c.right && c.right.length > 1) out.push({ pts: c.right, closed: !!c.isLoop, mode: 'span' });
            }
            if (out.length) return out;
        }
        return (r.vector.segments || []).map((seg) => ({
            pts: seg.pointsPx, closed: !!seg.isLoop, mode: 'both',
        }));
    }

    fillAdaptiveRibbon(pts, { closed = false, mode = 'both' } = {}) {
        if (!pts || pts.length < 2 || !this.canMeasureWidth()) return;
        const r = this.result;
        const ribbon = buildRibbon(pts, r.distanceField, r.raster.width, r.raster.height, {
            mode,
            closed,
            // Never thinner than the Path Thickness slider. Adaptive
            // width is a FLOOR-PLUS-GLYPH rule, not a pure glyph rule:
            // the distance field goes to zero at every terminal and
            // pinches at thin joins, so without a floor the stroke
            // vanishes exactly where the eye expects a stroke end. The
            // slider stays meaningful with adaptive on - it sets the
            // minimum rather than the width.
            minHalfPx: Math.max(0.5, (this.viewSettings.pathThicknessPx || 0) / 2),
        });
        if (!ribbon) return;
        const { ctx } = this;
        ctx.beginPath();
        if (closed) {
            // Two rings, even-odd: the inner edge stays a hole, so the
            // counter of an 'o' does not get filled in.
            this.tracePolygon(ribbon.outer, true);
            this.tracePolygon(ribbon.inner, true);
            ctx.fill('evenodd');
        } else if (this.viewSettings.strokeRoundCap) {
            // Round cap: the ribbon's end is a straight edge between its
            // outer and inner boundary, so a cap is a half-disc centred
            // on the path with that edge as its diameter. Drawn as
            // separate arcs on the same path so the fill merges them
            // with the body rather than seaming.
            const o = ribbon.outer;
            const n = ribbon.inner;
            this.tracePolygon(o.concat(n.slice().reverse()), true);
            this.traceEndCap(o[o.length - 1], n[n.length - 1]);
            this.traceEndCap(n[0], o[0]);
            ctx.fill();
        } else {
            this.tracePolygon(ribbon.outer.concat(ribbon.inner.slice().reverse()), true);
            ctx.fill();
        }
    }

    // A half-disc spanning a-to-b, bulging away from the path. Added as
    // its own sub-path; the caller fills everything at once.
    traceEndCap(a, b) {
        if (!a || !b) return;
        const { ctx } = this;
        const sa = this.toScreen(a.x, a.y);
        const sb = this.toScreen(b.x, b.y);
        const cx = (sa.x + sb.x) / 2;
        const cy = (sa.y + sb.y) / 2;
        const rr = Math.hypot(sb.x - sa.x, sb.y - sa.y) / 2;
        if (!(rr > 0.25)) return;
        const ang = Math.atan2(sb.y - sa.y, sb.x - sa.x);
        ctx.moveTo(sa.x, sa.y);
        ctx.arc(cx, cy, rr, ang, ang + Math.PI);
        ctx.closePath();
    }

    tracePolygon(points, closePath) {
        const { ctx } = this;
        for (let i = 0; i < points.length; i++) {
            const s = this.toScreen(points[i].x, points[i].y);
            if (i === 0) ctx.moveTo(s.x, s.y);
            else ctx.lineTo(s.x, s.y);
        }
        if (closePath) ctx.closePath();
    }

    // The tween curves. Drawn ABOVE the skeleton and BELOW the graph
    // nodes: the whole point is comparing them against the glyph outline
    // underneath, and burying them under the node markers would hide
    // exactly the junction behaviour that is most worth inspecting.
    drawTween() {
        const t = this.tween;
        if (!t || !t.curves || !t.curves.length) return;
        const { ctx } = this;
        ctx.save();
        ctx.strokeStyle = LAYER_COLORS.tween;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (const c of t.curves) {
            if (c.left) this.strokePolyline(c.left);
            if (c.right) this.strokePolyline(c.right);
        }
        ctx.restore();
    }

    drawTraversal() {
        const r = this.result;
        if (!r.traversal) return;
        const { ctx } = this;
        ctx.save();
        ctx.strokeStyle = LAYER_COLORS.traversal;
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.8;
        for (const seg of r.traversal.segments) {
            if (seg.kind !== 'draw') continue;
            this.strokePolyline(seg.pointsPx);
        }
        ctx.restore();
    }

    // Pen-up moves, dashed so they are unmistakably not part of the
    // glyph. These are the hooks a future traversal planner turns into
    // real U-turns and travel moves.
    // Pen-up moves for the route the animation is ACTUALLY following.
    //
    // Derived from the live route rather than result.traversal, which is
    // always the midline traversal: with the Animation Path set to Tween
    // the dot crosses completely different gaps, so drawing the midline's
    // connectors showed pen-up lines that did not correspond to anything
    // the dot was doing. Falls back to the traversal only when no route
    // has been set yet.
    drawConnectors() {
        const runs = this.connectorRuns();
        if (!runs.length) return;
        const { ctx } = this;
        ctx.save();
        ctx.strokeStyle = LAYER_COLORS.connector;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([4, 4]);
        for (const run of runs) this.strokePolyline(run);
        ctx.setLineDash([]);
        ctx.restore();
    }

    // Every pen-up move in the current route, as its own polyline.
    //
    // The two route builders mark connectors differently and this handles
    // both without caring which produced the route: the midline emits a
    // RUN of connector points (its connector segments are real geometry),
    // while the tween emits a SINGLE connector point at the start of each
    // run. Bridging to the drawn point on either side of a connector run
    // turns both into the same thing - a line from where the pen lifted
    // to where it landed.
    connectorRuns() {
        const flat = this.route && this.route.flat;
        if (!flat || !flat.length) {
            const r = this.result;
            if (!r || !r.traversal) return [];
            return r.traversal.segments
                .filter((seg) => seg.kind === 'connector')
                .map((seg) => seg.pointsPx);
        }
        const runs = [];
        let i = 0;
        while (i < flat.length) {
            if (flat[i].kind !== 'connector') { i++; continue; }
            const start = i;
            while (i < flat.length && flat[i].kind === 'connector') i++;
            const run = [];
            if (start > 0) run.push(flat[start - 1].p);
            for (let k = start; k < i; k++) run.push(flat[k].p);
            if (i < flat.length) run.push(flat[i].p);
            if (run.length > 1) runs.push(run);
        }
        return runs;
    }

    drawNodes() {
        const r = this.result;
        if (!r.vector) return;
        const { ctx } = this;
        ctx.save();
        for (const n of r.vector.nodes) {
            const s = this.toScreen(n.xPx, n.yPx);
            const color = n.kind === 'endpoint'
                ? LAYER_COLORS.endpoint
                : n.kind === 'junction' ? LAYER_COLORS.junction
                : n.kind === 'dot' ? LAYER_COLORS.dotNode : LAYER_COLORS.loopAnchor;
            ctx.beginPath();
            ctx.arc(s.x, s.y, n.kind === 'junction' ? 5 : 4, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = 'rgba(0,0,0,0.6)';
            ctx.stroke();
        }
        ctx.restore();
    }

    // Numbers the drawn segments in traversal order, at each segment's
    // midpoint — the quickest way to check whether a route is sane.
    drawOrderLabels() {
        const r = this.result;
        if (!r.traversal) return;
        const { ctx } = this;
        ctx.save();
        ctx.font = 'bold 11px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let n = 0;
        for (const seg of r.traversal.segments) {
            if (seg.kind !== 'draw') continue;
            n++;
            const pts = seg.pointsPx;
            const mid = pts[Math.floor(pts.length / 2)];
            if (!mid) continue;
            const s = this.toScreen(mid.x, mid.y);
            ctx.fillStyle = 'rgba(0,0,0,0.75)';
            ctx.beginPath();
            ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.fillText(String(n), s.x, s.y);
        }
        ctx.restore();
    }

    // Animation route stops. A stop selected as the first half of a swap
    // is drawn distinctly - without that, a click that registered and a
    // click that missed look identical, which makes the mode feel broken
    // whenever a click lands just outside a marker.
    drawRoutePoints() {
        const stops = this.stops();
        if (!stops.length) return;
        const { ctx } = this;
        ctx.save();
        for (const st of stops) {
            const selected = this.pendingStopId === String(st.id);
            const colour = selected ? '#ffd166' : LAYER_COLORS.routePoint;
            const ring = selected ? '#ff7b00' : 'rgba(0,0,0,0.65)';

            // ENTRY: filled. Where the pen lands.
            const a = this.toScreen(st.point.x, st.point.y);
            ctx.beginPath();
            ctx.arc(a.x, a.y, selected ? 8 : 5.5, 0, Math.PI * 2);
            ctx.fillStyle = colour;
            ctx.fill();
            ctx.lineWidth = selected ? 2.5 : 1.25;
            ctx.strokeStyle = ring;
            ctx.stroke();

            // EXIT: hollow, same colour. Where the pen lifts. Drawn only
            // when it is far enough from the entry to be a separate
            // marker - on a closed loop the two coincide, and stacking a
            // ring on the disc there would just look like a halo.
            if (!st.exit) continue;
            const b = this.toScreen(st.exit.x, st.exit.y);
            if (Math.hypot(b.x - a.x, b.y - a.y) < 6) continue;
            ctx.beginPath();
            ctx.arc(b.x, b.y, selected ? 7.5 : 5, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(12,16,22,0.85)';
            ctx.fill();
            ctx.lineWidth = selected ? 2.5 : 2;
            ctx.strokeStyle = colour;
            ctx.stroke();
        }
        ctx.restore();
    }

    // The visit number, offset off the marker so it never covers the
    // thing being clicked.
    drawRouteOrderLabels() {
        const stops = this.stops();
        if (!stops.length) return;
        const { ctx } = this;
        ctx.save();
        ctx.font = 'bold 11px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Both ends carry the SAME number - it identifies the stroke, not
        // the endpoint. The entry's badge is solid-filled and the exit's
        // is outlined, matching their markers, so a glance tells you
        // which end of stroke N you are looking at.
        const badge = (px, py, text, filled) => {
            ctx.beginPath();
            ctx.arc(px, py, 9, 0, Math.PI * 2);
            ctx.fillStyle = filled ? 'rgba(12,16,22,0.88)' : 'rgba(12,16,22,0.6)';
            ctx.fill();
            ctx.lineWidth = filled ? 1 : 1.75;
            ctx.setLineDash(filled ? [] : [3, 2]);
            ctx.strokeStyle = LAYER_COLORS.routePoint;
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = filled ? '#fff' : LAYER_COLORS.routePoint;
            ctx.fillText(text, px, py);
        };

        for (const st of stops) {
            const a = this.toScreen(st.point.x, st.point.y);
            badge(a.x + 11, a.y - 11, String(st.order), true);
            if (!st.exit) continue;
            const b = this.toScreen(st.exit.x, st.exit.y);
            if (Math.hypot(b.x - a.x, b.y - a.y) < 6) continue;
            badge(b.x + 11, b.y + 11, String(st.order), false);
        }
        ctx.restore();
    }

    drawDot() {
        if (!this.dot) return;
        const { ctx } = this;
        const v = this.viewSettings;
        ctx.save();
        // Suppressed when progressive inking is on: that already draws the
        // travelled portion, and stacking this faint wake on top of it just
        // muddies the colour the user picked.
        const progressiveInking = v.pathThicknessEnabled && v.progressiveThickness;
        if (this.trail.length > 1 && !progressiveInking) {
            ctx.strokeStyle = LAYER_COLORS.dotTrail;
            ctx.lineWidth = 4;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            this.strokePolyline(this.trail);
        }
        const s = this.toScreen(this.dot.x, this.dot.y);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = LAYER_COLORS.dot;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#0d1117';
        ctx.stroke();
        ctx.restore();
    }

    strokePolyline(points) {
        if (!points || points.length < 2) return;
        const { ctx } = this;
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
            const s = this.toScreen(points[i].x, points[i].y);
            if (i === 0) ctx.moveTo(s.x, s.y);
            else ctx.lineTo(s.x, s.y);
        }
        ctx.stroke();
    }
}

function replay(ctx, commands) {
    for (const cmd of commands) {
        switch (cmd.type) {
            case 'M': ctx.moveTo(cmd.x, cmd.y); break;
            case 'L': ctx.lineTo(cmd.x, cmd.y); break;
            case 'Q': ctx.quadraticCurveTo(cmd.x1, cmd.y1, cmd.x, cmd.y); break;
            case 'C': ctx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); break;
            case 'Z': ctx.closePath(); break;
            default: break;
        }
    }
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = String(text).split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (ctx.measureText(test).width > maxWidth && line) {
            lines.push(line);
            line = w;
        } else {
            line = test;
        }
    }
    if (line) lines.push(line);
    const startY = y - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((l, i) => ctx.fillText(l, x, startY + i * lineHeight));
}
