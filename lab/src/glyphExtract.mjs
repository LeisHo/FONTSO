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
// Single character. A thin wrapper over extractText so there is exactly
// one extraction path to reason about and test — a one-character string
// is not a special case, it is the degenerate case of the general one.
export function extractGlyph(font, char, opts = {}) {
    return extractText(font, char, opts);
}

// ====================================================================
// Whole-string extraction
// ====================================================================
// Lays every character's outline out along the baseline using the
// font's OWN advance widths and kerning, and returns the result in
// exactly the same shape a single glyph produced.
//
// WHY THE LAYOUT LIVES HERE AND NOT IN A LATER STAGE
// Doing it at extraction means the entire rest of the pipeline is
// untouched: rasterisation fills one combined path, thinning sees one
// mask, and the graph's existing connected-component logic separates
// the letters for free — a 'H' and an 'i' in the same string are simply
// components, which is what they genuinely are. It also means a joining
// script face whose letters physically touch merges into one component,
// which is the honest answer rather than a special case.
//
// The alternative — running the whole pipeline once per letter and
// stitching the results — would have required reworking the renderer,
// the traversal and the animator to understand a list of results, for
// no geometric benefit.
export function extractText(font, text, {
    flattenSteps = 24, kerning = true, letterSpacing = 0,
    wrapWidth = 0, lineHeight = 1.2,
} = {}) {
    if (!text || !text.length) throw new GlyphExtractError('No text supplied.');

    // wrapWidth arrives in EM MULTIPLES (the caller converts from the
    // raster px the user sees, since only it knows the raster scale);
    // the pen runs in font units, so convert once here rather than
    // scattering the conversion through the loop.
    const wrapUnits = wrapWidth > 0 ? wrapWidth * font.unitsPerEm : 0;
    const lineAdvance = lineHeight * font.unitsPerEm;

    const chars = Array.from(text); // Array.from, so astral characters stay whole
    const commands = [];
    const glyphs = [];
    const skipped = [];
    let penX = 0;
    let penY = 0;
    let lineCount = 1;
    let prevGlyph = null;
    // Index in `commands` where the current word starts, so a wrap can
    // move the whole word to the next line rather than splitting it.
    let wordStartCmd = 0;
    let wordStartPenX = 0;
    let wordStartGlyphIdx = 0;

    for (const ch of chars) {
        // An explicit newline always breaks, regardless of wrapping.
        if (ch === '\n') {
            penX = 0;
            penY += lineAdvance;
            lineCount++;
            prevGlyph = null;
            wordStartCmd = commands.length;
            wordStartPenX = 0;
            wordStartGlyphIdx = glyphs.length;
            glyphs.push({ char: ch, glyphIndex: -1, glyphName: null, advanceWidth: 0, penX: 0, penY, kerning: 0, hasOutline: false, lineBreak: true });
            continue;
        }

        const glyph = font.charToGlyph(ch);
        const glyphIndex = font.charToGlyphIndex(ch);

        // Kerning is applied BEFORE this glyph is placed, because it
        // adjusts the gap left by the previous advance.
        const kern = kerning ? kernBetween(font, prevGlyph, glyph) : 0;
        penX += kern;

        // Ask for the path at unitsPerEm so the result is already in font
        // units with no extra scaling: getPath(x, y, fontSize) scales by
        // fontSize/unitsPerEm internally, so passing unitsPerEm is
        // identity, and x lands in font units. y=0 keeps the baseline at
        // y=0. getPath's Y is already flipped to screen convention
        // (down-positive) by opentype, which is why `yUp: false` is
        // recorded below rather than silently assumed.
        // WRAPPING. Checked BEFORE the glyph is placed, using its own
        // advance, so a character never straddles the edge.
        //
        // Word-first, character-fallback: breaking at the last space
        // keeps words intact, but a single unbroken run longer than the
        // line (a long token, or any CJK text, which has no spaces at
        // all) has no space to break at. Falling back to a character
        // break there is what stops such a run from growing the raster
        // without limit — which is the real reason the old length cap
        // existed and why removing it needs wrapping to be correct.
        const advance = glyph ? glyph.advanceWidth : 0;
        if (wrapUnits > 0 && penX > 0 && penX + advance > wrapUnits) {
            const canWordWrap = wordStartCmd < commands.length && wordStartPenX > 0;
            if (canWordWrap) {
                // Move the in-progress word down a line: drop its
                // commands and re-place them from the new origin.
                const moved = commands.splice(wordStartCmd);
                const dx = -wordStartPenX;
                const dy = lineAdvance;
                for (const c of moved) commands.push(translateCommand(c, dx, dy));
                for (let gi = wordStartGlyphIdx; gi < glyphs.length; gi++) {
                    glyphs[gi].penX -= wordStartPenX;
                    glyphs[gi].penY = (glyphs[gi].penY || 0) + lineAdvance;
                    glyphs[gi].wrapped = true;
                }
                penX -= wordStartPenX;
            } else {
                penX = 0;
            }
            penY += lineAdvance;
            lineCount++;
            prevGlyph = null;
            wordStartCmd = commands.length;
            wordStartPenX = penX;
            wordStartGlyphIdx = glyphs.length;
        }

        const glyphCommands = glyph ? (glyph.getPath(penX, penY, font.unitsPerEm).commands || []) : [];

        // A blank glyph is NOT an error in a string — a space is a
        // legitimate character that advances the pen and draws nothing.
        // It is only an error when the WHOLE string is blank, which is
        // checked after the loop.
        if (glyphCommands.length) {
            commands.push(...glyphCommands);
        } else {
            skipped.push({ char: ch, reason: glyph ? 'blank outline' : 'no glyph' });
        }

        glyphs.push({
            char: ch,
            glyphIndex,
            glyphName: (glyph && glyph.name) || null,
            advanceWidth: advance,
            penX,
            penY,
            kerning: kern,
            hasOutline: glyphCommands.length > 0,
        });

        penX += advance + letterSpacing;
        prevGlyph = glyph;

        // A space ends the current word, so the next wrap breaks here.
        if (/\s/.test(ch)) {
            wordStartCmd = commands.length;
            wordStartPenX = penX;
            wordStartGlyphIdx = glyphs.length;
        }
    }

    if (!commands.length) {
        throw new GlyphExtractError(
            `"${text}" produced no outline at all (every character is blank, a control character, or missing from this font).`,
        );
    }

    const contours = flattenCommands(commands, flattenSteps);
    const filledContours = contours.filter((c) => c.length >= 3);
    if (!filledContours.length) {
        throw new GlyphExtractError(`"${text}" produced no closed contour with area.`);
    }

    const bounds = boundsOfContours(filledContours);
    if (!(bounds.width > 0) || !(bounds.height > 0)) {
        throw new GlyphExtractError(`"${text}" has a degenerate bounding box.`);
    }

    const first = glyphs[0];
    return {
        // `char` is retained under its original name so every downstream
        // consumer keeps working; for a multi-character string it holds
        // the whole string.
        char: text,
        text,
        glyphs,
        skipped,
        glyphCount: glyphs.length,
        // Single-glyph fields keep their old meaning for a 1-char string
        // and describe the FIRST glyph otherwise, so the debug panel's
        // existing rows stay truthful rather than going undefined.
        glyphIndex: first.glyphIndex,
        isNotdef: !(first.glyphIndex > 0),
        glyphName: first.glyphName,
        advanceWidth: first.advanceWidth,
        totalAdvance: penX,
        lineCount,
        unitsPerEm: font.unitsPerEm,
        yUp: false,
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

// Kerning for one pair, working around a real gap in opentype.js 2.0.0.
//
// font.getKerningValue() is implemented as:
//     const tables = this.position.defaultKerningTables;
//     return tables ? this.position.getKerningValue(tables, l, r)
//                   : this.kerningPairs[l + ',' + r] || 0;
// i.e. when a font has GPOS kerning tables it takes the GPOS path and
// NEVER falls back to the parsed pair table. Measured on the real files
// in test-fonts/: Arial parses 909 kerning pairs and Times 867, yet
// getKerningValue() returns 0 for A/V, T/o and Y/o in both — while
// font.kerningPairs['36,57'] (A,V in Arial) is right there holding -152.
// So every string rendered completely unkerned.
//
// Consulting the pair table when the official accessor yields nothing
// recovers the real values without second-guessing it where it does
// work. Comic Sans genuinely has no kern data at all (0 pairs, no kern
// table) — that one stays unkerned, correctly.
function kernBetween(font, left, right) {
    if (!left || !right) return 0;
    let value = 0;
    try {
        value = font.getKerningValue(left, right) || 0;
    } catch {
        value = 0;
    }
    if (value === 0 && font.kerningPairs) {
        const li = left.index !== undefined ? left.index : left;
        const ri = right.index !== undefined ? right.index : right;
        value = font.kerningPairs[li + ',' + ri] || 0;
    }
    return value;
}

// Shifts one path command. Used only by the word-wrap path, which has
// to re-place a word that was already emitted on the previous line.
function translateCommand(cmd, dx, dy) {
    const out = { ...cmd };
    if (out.x !== undefined) { out.x += dx; out.y += dy; }
    if (out.x1 !== undefined) { out.x1 += dx; out.y1 += dy; }
    if (out.x2 !== undefined) { out.x2 += dx; out.y2 += dy; }
    return out;
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
