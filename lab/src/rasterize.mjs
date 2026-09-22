// ====================================================================
// Stage 2 — Rasterisation (outline -> binary mask)
// ====================================================================
// Fills the glyph's ACTUAL outline commands (curves included, never the
// flattened approximation) onto an OffscreenCanvas, then thresholds the
// alpha channel into a flat Uint8Array of 0/1.
//
// KEY DECISION — why canvas fill rather than a hand-written scanline
// polygon filler:
//   1. The browser's rasteriser already handles the nonzero winding
//      rule correctly, which is exactly what makes a counter (the hole
//      in 'O', 'B', 'g') come out as a hole instead of a solid blob.
//      Getting winding right by hand is the classic place a font
//      rasteriser goes wrong, and there is no reason to re-derive it.
//   2. It consumes the curve commands directly, so no flattening error
//      enters the mask.
//   3. It is hardware-accelerated and far faster than JS scanlines.
//
// The anti-aliased edge canvas produces is then hard-thresholded. That
// threshold is the one real information loss in this stage, and it is
// exposed as config.alphaThreshold rather than buried.
// ====================================================================

export class RasterizeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RasterizeError';
    }
}

function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
}

// Scale is derived from the EM SQUARE, not from the glyph's own bounding
// box. This matters more than it looks: box-relative scaling would make
// every character come out the same physical size, so a lowercase 'o'
// would be rasterised at the same pixel height as a capital 'H' and its
// strokes would land ~40% thicker in the mask. Em-relative scaling keeps
// the font's real proportions, which keeps relative stroke weights — and
// therefore the pruning thresholds — consistent across characters.
export function rasterizeGlyph(glyphData, config) {
    const { commands, bounds, unitsPerEm } = glyphData;
    const scale = config.rasterEmHeight / unitsPerEm;
    const pad = config.rasterPadding;

    const width = Math.max(1, Math.ceil(bounds.width * scale) + pad * 2);
    const height = Math.max(1, Math.ceil(bounds.height * scale) + pad * 2);

    if (width * height > 16e6) {
        throw new RasterizeError(
            `Mask would be ${width}x${height} (${(width * height / 1e6).toFixed(1)}M px). Lower rasterEmHeight.`,
        );
    }

    // font unit -> raster px. Y needs no flip here: glyphExtract already
    // emits screen-convention Y (see its yUp flag), so this is a plain
    // translate + uniform scale.
    const offsetX = -bounds.minX * scale + pad;
    const offsetY = -bounds.minY * scale + pad;

    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new RasterizeError('Could not acquire a 2D context for rasterisation.');

    ctx.clearRect(0, 0, width, height);
    ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    replayCommands(ctx, commands);
    ctx.fill('nonzero'); // <- the winding rule that makes counters hollow
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const image = ctx.getImageData(0, 0, width, height);
    const data = image.data;
    const mask = new Uint8Array(width * height);
    let filled = 0;
    for (let i = 0, p = 3; i < mask.length; i++, p += 4) {
        if (data[p] >= config.alphaThreshold) {
            mask[i] = 1;
            filled++;
        }
    }

    if (filled === 0) {
        throw new RasterizeError(
            'Rasterised mask is empty. The glyph may be blank, or alphaThreshold may be too high.',
        );
    }

    const toRaster = (x, y) => ({ x: x * scale + offsetX, y: y * scale + offsetY });
    const toFont = (x, y) => ({ x: (x - offsetX) / scale, y: (y - offsetY) / scale });

    return {
        mask,
        width,
        height,
        filledPixels: filled,
        // Fill ratio is a cheap sanity signal. A glyph that rasterises
        // to >70% coverage is probably a solid block (a bad threshold,
        // or a glyph with inverted winding); <1% suggests the scale
        // collapsed. The UI surfaces this rather than acting on it.
        fillRatio: filled / (width * height),
        transform: { scale, offsetX, offsetY, toRaster, toFont },
    };
}

function replayCommands(ctx, commands) {
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

// Labels 8-connected components of the FILLED MASK and measures each
// one's area in pixels.
//
// WHY THIS EXISTS: to tell a dot from a speck. Both produce a tiny
// skeleton — measured on Comic Sans at 256px, the dot of '?' skeletonises
// to 3.4px of centreline, '!' to 3.8px, the two dots of ':' to 2.4px and
// 5.8px, and the dot of 'i' collapses to a SINGLE pixel. Anti-aliasing
// specks are the same size. So any filter based on skeleton length either
// keeps the noise or destroys the punctuation — there is no threshold
// that separates them, because in that measure they are not different.
//
// Source area separates them immediately and by orders of magnitude: a
// real dot is a few hundred mask pixels, a speck is one to four. Every
// "is this real?" decision in the pipeline is therefore made against the
// area of the mask region a skeleton component came from, never against
// the length of the skeleton itself.
export function labelMaskComponents(mask, width, height) {
    const labels = new Int32Array(mask.length).fill(-1);
    const areas = [];
    const stack = [];
    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || labels[start] !== -1) continue;
        const label = areas.length;
        let area = 0;
        stack.length = 0;
        stack.push(start);
        labels[start] = label;
        while (stack.length) {
            const i = stack.pop();
            area++;
            const x = i % width;
            const y = (i / width) | 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    const ni = ny * width + nx;
                    if (!mask[ni] || labels[ni] !== -1) continue;
                    labels[ni] = label;
                    stack.push(ni);
                }
            }
        }
        areas.push(area);
    }
    return { labels, areas };
}

// Debug helper — turns any mask into an ImageData for on-screen display.
export function maskToImageData(mask, width, height, rgb = [90, 110, 140], alpha = 255) {
    const img = new ImageData(width, height);
    const d = img.data;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
        if (mask[i]) {
            d[p] = rgb[0];
            d[p + 1] = rgb[1];
            d[p + 2] = rgb[2];
            d[p + 3] = alpha;
        }
    }
    return img;
}
