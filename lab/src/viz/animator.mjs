// ====================================================================
// Visualisation — path animator
// ====================================================================
// Walks a dot along the traversal route at constant SPEED (px/second),
// not constant "fraction per second". Constant fraction would make a
// dense glyph animate slower than a sparse one and would hide exactly
// the thing worth watching: whether the route's ordering and its
// connectors make physical sense.
//
// Position is found by binary search into the cumulative-length table
// the traversal stage precomputed, so a frame costs O(log n) regardless
// of route length. The dot also reports whether it is currently on a
// DRAWN segment or crossing a CONNECTOR, which is what lets the
// visualiser dim the trail during pen-up moves.
// ====================================================================

export class PathAnimator {
    constructor(onFrame) {
        this.onFrame = onFrame;
        this.route = null;
        this.speedPxPerSecond = 220;
        this.distance = 0;
        this.playing = false;
        this.loop = true;
        this.rafId = null;
        this.lastTime = 0;
        this._tick = this._tick.bind(this);
    }

    setRoute(animation) {
        this.route = animation && animation.flat && animation.flat.length >= 2 ? animation : null;
        this.distance = 0;
    }

    get totalLength() {
        return this.route ? this.route.totalLength : 0;
    }

    get progress() {
        const total = this.totalLength;
        return total > 0 ? this.distance / total : 0;
    }

    play() {
        if (!this.route || this.playing) return;
        this.playing = true;
        this.lastTime = performance.now();
        this.rafId = requestAnimationFrame(this._tick);
    }

    pause() {
        this.playing = false;
        if (this.rafId != null) cancelAnimationFrame(this.rafId);
        this.rafId = null;
    }

    toggle() {
        if (this.playing) this.pause();
        else this.play();
    }

    restart() {
        this.distance = 0;
        this.emit();
        if (!this.playing) this.play();
    }

    seekToFraction(f) {
        this.distance = Math.max(0, Math.min(1, f)) * this.totalLength;
        this.emit();
    }

    _tick(now) {
        if (!this.playing) return;
        // Frame delta is clamped: a tab that was backgrounded returns a
        // delta of several seconds, which would teleport the dot most of
        // the way through the route on the first frame back.
        const dt = Math.min(0.1, (now - this.lastTime) / 1000);
        this.lastTime = now;
        this.distance += this.speedPxPerSecond * dt;

        if (this.distance >= this.totalLength) {
            if (this.loop) {
                this.distance = this.distance % Math.max(1e-6, this.totalLength);
            } else {
                this.distance = this.totalLength;
                this.playing = false;
            }
        }
        this.emit();
        if (this.playing) this.rafId = requestAnimationFrame(this._tick);
    }

    emit() {
        const state = this.sample(this.distance);
        if (this.onFrame) this.onFrame(state);
    }

    // Returns {point, kind, edgeId, trail} for a distance along the
    // route. `trail` is every route point already passed, which the
    // renderer draws as the dot's wake.
    sample(dist) {
        if (!this.route) return null;
        const { flat, cumulative, totalLength } = this.route;
        const d = Math.max(0, Math.min(totalLength, dist));

        let lo = 0;
        let hi = cumulative.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cumulative[mid] < d) lo = mid + 1;
            else hi = mid;
        }
        const i = Math.max(1, lo);
        const segStart = cumulative[i - 1];
        const segLen = cumulative[i] - segStart;
        const t = segLen > 1e-9 ? (d - segStart) / segLen : 0;
        const a = flat[i - 1].p;
        const b = flat[i].p;

        return {
            point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
            kind: flat[i].kind,
            edgeId: flat[i].edgeId,
            index: i,
            distance: d,
            fraction: totalLength > 0 ? d / totalLength : 0,
            trail: flat.slice(0, i).map((f) => f.p),
        };
    }
}
