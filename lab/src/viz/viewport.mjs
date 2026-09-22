// ====================================================================
// Viewport interaction — zoom and pan
// ====================================================================
// Desktop:  scroll wheel = zoom, right-click-drag = pan.
// Mobile:   pinch        = zoom, two-finger drag  = pan.
//
// The mobile gestures are not an extra: the workspace convention
// (CLAUDE.md §12o) is that asking for a desktop pan/zoom implies its
// touch equivalent in the same pass, so the two never drift apart.
// Single-finger drag is deliberately left alone — there is no camera to
// orbit here, and claiming it would break ordinary scrolling on a phone.
//
// ZOOM IS ABOUT THE POINTER, NOT THE CANVAS CENTRE. Centre-zoom is
// easier to write and much worse to use: inspecting a particular
// junction means it slides away from you every time you zoom in. Fixing
// the point under the cursor is the behaviour every map and drawing
// tool has, and it is three lines of algebra:
//     world  = (screen - offset) / scale
//     offset = screen - world * newScale
//
// This module owns no geometry. It mutates the renderer's existing
// {scale, offsetX, offsetY} view and asks for a redraw, so the rest of
// the pipeline is unaware it exists.
// ====================================================================

export const DEFAULT_VIEWPORT = {
    // Multiplier applied per wheel notch. 1.0015 raised to the wheel's
    // own deltaY, so a trackpad's many small deltas and a mouse's few
    // large ones both feel proportional rather than one being unusable.
    zoomSpeed: 1.0015,
    minZoom: 0.05,
    maxZoom: 60,
    // Re-fit the view when a new glyph is rendered. Off keeps whatever
    // you were looking at, which is what you want while comparing the
    // same region across fonts; on is what you want while browsing.
    autoFit: true,
};

export class ViewportController {
    constructor(canvas, renderer, onChange) {
        this.canvas = canvas;
        this.renderer = renderer;
        this.onChange = onChange || (() => {});
        this.settings = { ...DEFAULT_VIEWPORT };
        this.panning = false;
        this.last = null;
        this.touches = new Map();
        this.pinch = null;
        this.attach();
    }

    setSettings(patch) {
        this.settings = { ...this.settings, ...patch };
    }

    // Canvas-internal pixel coords for an event. The canvas backing
    // store is DPR-scaled while the event reports CSS pixels, so the
    // ratio has to be applied or zoom drifts away from the cursor on any
    // non-1x display — which is most of them.
    toCanvas(clientX, clientY) {
        const r = this.canvas.getBoundingClientRect();
        return {
            x: (clientX - r.left) * (this.canvas.width / r.width),
            y: (clientY - r.top) * (this.canvas.height / r.height),
        };
    }

    zoomAt(canvasPt, factor) {
        const v = this.renderer.view;
        const next = Math.max(this.settings.minZoom,
            Math.min(this.settings.maxZoom, v.scale * factor));
        if (next === v.scale) return;
        // Keep the world point under the cursor pinned.
        const worldX = (canvasPt.x - v.offsetX) / v.scale;
        const worldY = (canvasPt.y - v.offsetY) / v.scale;
        v.scale = next;
        v.offsetX = canvasPt.x - worldX * next;
        v.offsetY = canvasPt.y - worldY * next;
        this.onChange();
    }

    panBy(dx, dy) {
        const v = this.renderer.view;
        v.offsetX += dx;
        v.offsetY += dy;
        this.onChange();
    }

    resetView() {
        this.renderer.recomputeView();
        this.onChange();
    }

    attach() {
        const c = this.canvas;

        // passive:false because the handler calls preventDefault to stop
        // the browser's own page zoom / scroll taking the gesture first.
        c.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = Math.pow(this.settings.zoomSpeed, -e.deltaY);
            this.zoomAt(this.toCanvas(e.clientX, e.clientY), factor);
        }, { passive: false });

        // Right-drag to pan. The context menu has to be suppressed on the
        // canvas or the press that starts the pan also opens it.
        c.addEventListener('contextmenu', (e) => e.preventDefault());

        c.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'touch') {
                this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
                return;
            }
            // button 2 = right, 1 = middle. Middle is included because it
            // is the other conventional pan button and costs nothing.
            if (e.button !== 2 && e.button !== 1) return;
            e.preventDefault();
            this.panning = true;
            this.last = this.toCanvas(e.clientX, e.clientY);
            c.setPointerCapture(e.pointerId);
        });

        c.addEventListener('pointermove', (e) => {
            if (e.pointerType === 'touch') return this.onTouchMove(e);
            if (!this.panning) return;
            const p = this.toCanvas(e.clientX, e.clientY);
            this.panBy(p.x - this.last.x, p.y - this.last.y);
            this.last = p;
        });

        const endPointer = (e) => {
            if (e.pointerType === 'touch') {
                this.touches.delete(e.pointerId);
                if (this.touches.size < 2) this.pinch = null;
                return;
            }
            this.panning = false;
            this.last = null;
        };
        c.addEventListener('pointerup', endPointer);
        c.addEventListener('pointercancel', endPointer);
        // A right-drag released outside the canvas would otherwise leave
        // the pan latched on, so the window gets the same release.
        window.addEventListener('pointerup', endPointer);

        // Double-click restores the fit. Cheap, discoverable, and the
        // usual escape hatch once a view has been zoomed somewhere odd.
        c.addEventListener('dblclick', () => this.resetView());
    }

    // Two fingers: the midpoint drives pan, the spread drives zoom. Both
    // are applied from the SAME gesture, which is what makes a pinch feel
    // right — separating them makes the content slide out from under the
    // fingers.
    onTouchMove(e) {
        if (!this.touches.has(e.pointerId)) return;
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.touches.size !== 2) return;
        e.preventDefault();

        const [a, b] = [...this.touches.values()];
        const mid = this.toCanvas((a.x + b.x) / 2, (a.y + b.y) / 2);
        const spread = Math.hypot(a.x - b.x, a.y - b.y);

        if (this.pinch) {
            if (this.pinch.spread > 0 && spread > 0) {
                this.zoomAt(mid, spread / this.pinch.spread);
            }
            this.panBy(mid.x - this.pinch.mid.x, mid.y - this.pinch.mid.y);
        }
        this.pinch = { mid, spread };
    }
}
