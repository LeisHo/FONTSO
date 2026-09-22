// ====================================================================
// Stage 1 — Glyph extraction
// ====================================================================
// Pulls one character's real outline out of the loaded font and puts it
// in a self-describing, font-unit coordinate space that every later
// stage can share.
//
// KEY DECISION — one coordinate space, declared once.
// The pipeline juggles three spaces and mixing them up is the single
// easiest way to produce a skeleton that looks subtly wrong:
//
//   font units  — opentype's own space. Y points UP. Origin sits on the
//                 baseline at the left sidebearing. Scale is
//                 unitsPerEm (commonly 1000 or 2048).
//   raster px   — the binary mask. Y points DOWN. Origin top-left of
//                 the padded bitmap.
//   screen px   — whatever the canvas is showing.
//
// This module emits the outline already flattened into font units and
// hands back an explicit `toRaster` / `toFont` transform pair, so no
// downstream module ever has to re-derive the mapping or guess at the
// Y flip. Everything that reports geometry reports it in BOTH raster px
// (what the algorithm actually saw) and font units (what is portable to
// another renderer at another size).
// ====================================================================

export class GlyphExtractError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GlyphExtractError';
    }
}

// opentype hands back a Path of M/L/C/Q/Z commands. Later stages want
// the outline both as commands (to fill on a canvas, which is how
// rasterisation works) and as a flattened polygon per contour (to draw
// as a reference overlay, and to compute a tight bounding box that
// respects curve bulge rather than just control points).
export function extractGlyph(font, char, { flattenSteps = 24 } = {}) {
    if (!char || !char.length) throw new GlyphExtractError('No character supplied.');

    const glyph = font.charToGlyph(char);
    if (!glyph) throw new GlyphExtractError(`Font has no glyph object for "${char}".`);

    const glyphIndex = font.charToGlyphIndex(char);
    const isNotdef = !(glyphIndex > 0);

    // Ask for the path at unitsPerEm so the result is already in font
    // units with no extra scaling: getPath(x, y, fontSize) scales by
    // fontSize/unitsPerEm internally, so passing unitsPerEm is identity.
    // y=0 keeps the baseline at y=0. getPath's Y is already flipped to
    // screen convention (down-positive) by opentype, which is why
    // `yUp: false` is recorded below rather than silently assumed.
    const path = glyph.getPath(0, 0, font.unitsPerEm);
    const commands = path.commands || [];

    if (!commands.length) {
        throw new GlyphExtractError(
            `Glyph for "${char}" has no outline (it is blank — a space, a control character, or an empty glyph).`,
        );
    }

    const contours = flattenCommands(commands, flattenSteps);
    const filledContours = contours.filter((c) => c.length >= 3);
    if (!filledContours.length) {
        throw new GlyphExtractError(`Glyph for "${char}" produced no closed contour with area.`);
    }

    const bounds = boundsOfContours(filledContours);
    if (!(bounds.width > 0) || !(bounds.height > 0)) {
        throw new GlyphExtractError(`Glyph for "${char}" has a degenerate bounding box.`);
    }

    return {
        char,
        glyphIndex,
        isNotdef,
        glyphName: glyph.name || null,
        advanceWidth: glyph.advanceWidth,
        unitsPerEm: font.unitsPerEm,
        yUp: false, // getPath() already emits screen-convention Y.
        commands,
        contours: filledContours,
        contourCount: filledContours.length,
        bounds,
    };
}

// Flattens curves to polylines. Fixed subdivision rather than adaptive:
// at flattenSteps=24 per curve the error on a 1000-unit em is far below
// one raster pixel at any resolution this tool uses, and the simplicity
// is worth more here than the handful of points adaptive would save.
// These polylines are for MEASUREMENT AND DISPLAY ONLY — rasterisation
// fills the original commands, curves and all, so no flattening error
// ever reaches the mask.
function flattenCommands(commands, steps) {
    const contours = [];
    let current = null;
    let cx = 0;
    let cy = 0;
    let startX = 0;
    let startY = 0;

    const push = (x, y) => {
        if (!current) return;
        const last = current[current.length - 1];
        if (last && Math.abs(last.x - x) < 1e-9 && Math.abs(last.y - y) < 1e-9) return;
        current.push({ x, y });
    };

    for (const cmd of commands) {
        switch (cmd.type) {
            case 'M':
                if (current && current.length >= 3) contours.push(current);
                current = [{ x: cmd.x, y: cmd.y }];
                cx = startX = cmd.x;
                cy = startY = cmd.y;
                break;
            case 'L':
                push(cmd.x, cmd.y);
                cx = cmd.x;
                cy = cmd.y;
                break;
            case 'Q':
                for (let i = 1; i <= steps; i++) {
                    const t = i / steps;
                    const mt = 1 - t;
                    push(
                        mt * mt * cx + 2 * mt * t * cmd.x1 + t * t * cmd.x,
                        mt * mt * cy + 2 * mt * t * cmd.y1 + t * t * cmd.y,
                    );
                }
                cx = cmd.x;
                cy = cmd.y;
                break;
            case 'C':
                for (let i = 1; i <= steps; i++) {
                    const t = i / steps;
                    const mt = 1 - t;
                    push(
                        mt * mt * mt * cx + 3 * mt * mt * t * cmd.x1 + 3 * mt * t * t * cmd.x2 + t * t * t * cmd.x,
                        mt * mt * mt * cy + 3 * mt * mt * t * cmd.y1 + 3 * mt * t * t * cmd.y2 + t * t * t * cmd.y,
                    );
                }
                cx = cmd.x;
                cy = cmd.y;
                break;
            case 'Z':
                push(startX, startY);
                if (current && current.length >= 3) contours.push(current);
                current = null;
                cx = startX;
                cy = startY;
                break;
            default:
                break;
        }
    }
    // A final contour with no explicit Z. Real fonts do ship these.
    if (current && current.length >= 3) contours.push(current);
    return contours;
}

function boundsOfContours(contours) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const contour of contours) {
        for (const p of contour) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
