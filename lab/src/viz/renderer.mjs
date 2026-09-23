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
        // Set by the app whenever the tween is (re)computed. Held rather
        // than derived here so a slider tick costs one recompute, not one
        // per frame of the animation loop.
        this.tween = null;
        // 'midline' | 'tween'. Drives adaptiveMode(); pushed in by the
        // host so the renderer never has to guess which path the dot is
        // actually walking.
        this.animationPath = 'midline';
        // Owned by the viewport controller; see setResult().
        this.autoFit = true;
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
            ctx.save();
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            if (adaptive) {
                // The travelled portion, painted out to the outline. On
                // the midline that fills the stroke from both sides; on a
                // tween curve it reaches the adjacent side only, so the
                // glyph is revealed one stroke-edge at a time.
                ctx.fillStyle = v.pathColor;
                this.fillAdaptiveRibbon(this.trail, { closed: false, mode: this.trailMode() });
            } else {
                ctx.strokeStyle = v.pathColor;
                ctx.lineWidth = Math.max(1, v.pathThicknessPx * this.view.scale);
                this.strokePolyline(this.trail);
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

    // Which side the ribbon grows toward. The MIDLINE is equidistant from
    // both outlines, so it always grows both ways — including while the
    // dot is walking a tween curve. A TWEEN curve has already been pushed
    // toward one outline, so it grows only to that adjacent side.
    trailMode() {
        return this.animationPath === 'tween' ? 'outward' : 'both';
    }

    // The polylines the adaptive ink is painted along, matching whatever
    // the animation is set to follow.
    inkSources() {
        const r = this.result;
        if (this.animationPath === 'tween' && this.tween && this.tween.curves) {
            const out = [];
            for (const c of this.tween.curves) {
                if (c.left && c.left.length > 1) out.push({ pts: c.left, closed: !!c.isLoop, mode: 'outward' });
                if (c.right && c.right.length > 1) out.push({ pts: c.right, closed: !!c.isLoop, mode: 'outward' });
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
            // Half a raster pixel, so a hairline stroke never vanishes
            // where the distance field rounds to zero at a terminal.
            minHalfPx: 0.5,
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
        } else {
            this.tracePolygon(ribbon.outer.concat(ribbon.inner.slice().reverse()), true);
            ctx.fill();
        }
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
    drawConnectors() {
        const r = this.result;
        if (!r.traversal) return;
        const { ctx } = this;
        ctx.save();
        ctx.strokeStyle = LAYER_COLORS.connector;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([4, 4]);
        for (const seg of r.traversal.segments) {
            if (seg.kind !== 'connector') continue;
            this.strokePolyline(seg.pointsPx);
        }
        ctx.setLineDash([]);
        ctx.restore();
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
