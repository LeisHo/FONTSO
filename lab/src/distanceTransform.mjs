// ====================================================================
// Euclidean distance transform (mask -> distance-to-background field)
// ====================================================================
// For every foreground pixel, the exact Euclidean distance to the
// nearest background pixel.
//
// WHY THIS EXISTS: it is the local half-thickness of the stroke. At a
// skeleton pixel — which by construction sits in the middle of the
// stroke — the distance to the nearest background pixel IS the radius
// of the largest circle that fits inside the glyph there. That radius
// is precisely how far the centreline has to move to reach the outline,
// which is the whole basis of the centreline→outline tween. Nothing
// else in the pipeline can supply it: the skeleton knows where the
// middle is but not how thick the stroke is around it.
//
// ALGORITHM — Felzenszwalb & Huttenlocher (2012), the exact linear-time
// separable transform. Chosen over the two obvious alternatives:
//
//   * Chamfer / two-pass 3x4 masks are the usual quick answer and are
//     APPROXIMATE — a few percent error, anisotropic, and the error is
//     direction-dependent. Here the result is multiplied by a user's
//     0..1 slider and drawn on screen against the real outline, so a
//     direction-dependent few percent would read as the tween curve
//     drifting off the outline on diagonals but not on stems. Visible,
//     and impossible to tune away.
//   * A brute-force nearest-background search is exact but O(n·m).
//
// This is exact, O(pixels), and about sixty lines. It works by computing
// a 1-D squared-distance transform along each row, then treating each
// column of that result as a 1-D problem again — the lower envelope of
// a set of parabolas, found in one forward scan per line.
// ====================================================================

const INF = 1e20;

// Exact 1-D squared distance transform of a sampled function f.
// Computes, for every q: min over p of ( (q-p)^2 + f[p] ).
// The loop maintains the lower envelope of the parabolas rooted at each
// p as a stack of vertices (v) and the breakpoints between them (z).
function edt1d(f, d, v, z, n) {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;

    for (let q = 1; q < n; q++) {
        // Intersection of the parabola from q with the one currently on
        // top of the envelope; pop until this parabola genuinely wins
        // somewhere.
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
            k--;
            s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
    }

    k = 0;
    for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        const dx = q - v[k];
        d[q] = dx * dx + f[v[k]];
    }
}

// Returns a Float32Array of the same length as `mask`, holding the
// distance in pixels from each FOREGROUND pixel to the nearest
// background pixel. Background pixels are 0.
//
// The border is treated as background. That matters: config.rasterPadding
// guarantees a blank margin, so a stroke touching the image edge cannot
// happen — but if it ever did, treating the edge as background is the
// conservative reading (it reports a thinner stroke, so the tween
// under-shoots rather than flying off the canvas).
export function distanceTransform(mask, width, height) {
    const size = width * height;
    const sq = new Float64Array(size);
    for (let i = 0; i < size; i++) sq[i] = mask[i] ? INF : 0;

    const maxDim = Math.max(width, height);
    const f = new Float64Array(maxDim);
    const d = new Float64Array(maxDim);
    const v = new Int32Array(maxDim);
    const z = new Float64Array(maxDim + 1);

    // Columns first, then rows — order is irrelevant to the result
    // (the transform is separable), this way round just keeps the
    // row pass cache-friendly since rows are contiguous.
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) f[y] = sq[y * width + x];
        edt1d(f, d, v, z, height);
        for (let y = 0; y < height; y++) sq[y * width + x] = d[y];
    }
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) f[x] = sq[row + x];
        edt1d(f, d, v, z, width);
        for (let x = 0; x < width; x++) sq[row + x] = d[x];
    }

    const out = new Float32Array(size);
    for (let i = 0; i < size; i++) out[i] = Math.sqrt(sq[i]);
    return out;
}

// Bilinear sample of the distance field at a fractional position.
//
// Bilinear rather than nearest-neighbour because the skeleton's own
// points are fractional (junction nodes sit at a cluster centroid, and
// the polylines have been simplified and smoothed off the pixel grid).
// Nearest-neighbour sampling of those positions produces a radius that
// steps in visible 1px jumps along a curve, which shows up directly as
// a scalloped edge on the tween curve at high progression values.
export function sampleDistance(field, width, height, x, y) {
    const cx = Math.max(0, Math.min(width - 1.001, x));
    const cy = Math.max(0, Math.min(height - 1.001, y));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const fx = cx - x0;
    const fy = cy - y0;

    const a = field[y0 * width + x0];
    const b = field[y0 * width + x1];
    const c = field[y1 * width + x0];
    const e = field[y1 * width + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
}
