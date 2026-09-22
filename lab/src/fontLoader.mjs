// ====================================================================
// Stage 0 — Font loading
// ====================================================================
// Wraps opentype.js. The ONLY module that knows opentype exists as a
// parser; everything downstream sees plain geometry.
//
// Why opentype.js rather than the browser's own font machinery: the
// pipeline needs the glyph's actual vector OUTLINE (contours, control
// points, winding), and no browser API exposes that. FontFace +
// canvas fillText would give pixels only — enough to rasterise, but it
// would throw away the font units, the glyph metrics, and the ability
// to report what the outline actually was. opentype.js parses TTF/OTF/
// WOFF directly and hands back real contours.
// ====================================================================

import * as opentype from '../lib/opentype.mjs';

export class FontLoadError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'FontLoadError';
        this.cause = cause;
    }
}

// Reads whatever the <input type="file"> handed us. opentype.parse works
// on an ArrayBuffer; it throws on anything it cannot make sense of, and
// those errors are genuinely useful ("Unsupported OpenType signature"),
// so they get surfaced rather than swallowed.
export async function loadFontFromFile(file) {
    let buffer;
    try {
        buffer = await file.arrayBuffer();
    } catch (err) {
        throw new FontLoadError('Could not read the file off disk.', err);
    }
    return loadFontFromArrayBuffer(buffer, file.name);
}

// Retries are not defensive padding — they are load-bearing here.
// Measured during development: a plain local static server intermittently
// truncates large responses (Arial is 1.0MB, Gabriola 1.8MB), returning
// 200 OK alongside a connection reset. Gabriola needed three attempts to
// come through intact in one observed run, Arial one. Since a truncated
// buffer fails at PARSE time rather than fetch time, both failure modes
// are retried.
export async function loadFontFromUrl(url, { attempts = 3 } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const resp = await fetch(url, { cache: 'no-store' });
            if (!resp.ok) throw new FontLoadError(`Fetch failed for ${url} (${resp.status}).`);
            return loadFontFromArrayBuffer(await resp.arrayBuffer(), url.split('/').pop());
        } catch (err) {
            lastError = err;
        }
    }
    throw new FontLoadError(
        `Could not load "${url}" after ${attempts} attempts: ${lastError && lastError.message}`,
        lastError,
    );
}

export function loadFontFromArrayBuffer(buffer, sourceName = 'font') {
    let font;
    try {
        font = opentype.parse(buffer);
    } catch (err) {
        throw new FontLoadError(
            `opentype.js could not parse "${sourceName}": ${err && err.message ? err.message : err}`,
            err,
        );
    }
    if (!font) throw new FontLoadError(`opentype.js returned no font for "${sourceName}".`);
    return { font, info: describeFont(font, sourceName) };
}

// Name records are wildly inconsistent across real fonts: some have no
// English entry, some only have a postScriptName, some hand back a bare
// string instead of a locale map. This walks every plausible shape
// rather than assuming `.en` exists, because assuming it does is a very
// common crash in font tooling.
function pickName(nameRecord, fallback = '') {
    if (!nameRecord) return fallback;
    if (typeof nameRecord === 'string') return nameRecord;
    if (nameRecord.en) return nameRecord.en;
    const first = Object.values(nameRecord).find((v) => typeof v === 'string' && v.length);
    return first || fallback;
}

// opentype.js v2 groups the name table BY PLATFORM — font.names.windows
// and font.names.macintosh — rather than exposing fields flat at
// font.names.* the way v1 did. Reading the flat path alone silently
// returned undefined for every real font tested, so the UI showed the
// filename ("comic.ttf") where it should have shown "Comic Sans MS".
// Windows records are preferred because they are the ones that are
// reliably present and UTF-16 clean; macintosh is the fallback; the flat
// shape is kept last for v1 compatibility.
function nameField(names, field) {
    if (!names) return '';
    return pickName(
        (names.windows && names.windows[field])
        || (names.macintosh && names.macintosh[field])
        || names[field],
        '',
    );
}

export function describeFont(font, sourceName) {
    const names = font.names || {};
    const family = nameField(names, 'fontFamily') || nameField(names, 'preferredFamily');
    const style = nameField(names, 'fontSubfamily') || nameField(names, 'preferredSubfamily');
    const full = nameField(names, 'fullName') || [family, style].filter(Boolean).join(' ');

    return {
        sourceName,
        familyName: family || '(no family name in font)',
        styleName: style || '',
        fullName: full || sourceName,
        postScriptName: nameField(names, 'postScriptName'),
        designer: nameField(names, 'designer'),
        version: nameField(names, 'version'),
        unitsPerEm: font.unitsPerEm,
        ascender: font.ascender,
        descender: font.descender,
        numGlyphs: font.numGlyphs,
        // outlinesFormat tells you whether you are looking at quadratic
        // TrueType curves or cubic CFF/PostScript ones. Worth surfacing:
        // it changes the character of the rasterised result slightly and
        // is the first thing to check when a font behaves oddly.
        outlinesFormat: font.outlinesFormat || (font.tables && font.tables.cff ? 'cff' : 'truetype'),
    };
}

// Does this font actually contain a glyph for this character, as opposed
// to silently substituting .notdef? Checked up front so the UI can say
// "this font has no 'ß'" instead of rendering an empty box and letting
// the user wonder whether the pipeline broke.
export function hasGlyphFor(font, char) {
    if (!char) return false;
    const index = font.charToGlyphIndex(char);
    return typeof index === 'number' && index > 0;
}
