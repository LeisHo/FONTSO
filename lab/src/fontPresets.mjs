// ====================================================================
// Per-font settings and named presets
// ====================================================================
// Two things a font remembers, which are related but not the same:
//
//   MEMORY   - the settings that were on screen last time this font was
//              used, restored automatically when it is selected again.
//              No naming, no management; it just persists what you were
//              doing so switching fonts does not lose your place.
//
//   PRESETS  - named snapshots you save, list, rename and delete. These
//              are deliberate, and they survive being overwritten by
//              ordinary tweaking, which memory does not.
//
// WHAT IS IN SCOPE. Text, Rasterisation, Skeletonisation, Cleanup, Path
// and Path Tween. NOT Traversal, View, Layers or Animation: the first
// group describes how a glyph is turned into geometry, which genuinely
// differs per typeface, while the rest describe how you are looking at
// it, which does not - a zoom level or a visible layer following the
// font around would be a nuisance rather than a feature.
//
// WHY KEYS ARE LISTED EXPLICITLY rather than captured wholesale from the
// config object: a new config key must be classified deliberately. A
// blanket capture would silently start carrying anything added later,
// including keys that should stay global, and the failure would be
// invisible until a font switch moved something unexpected.
// ====================================================================

// Config keys (config.mjs) that belong to a font, by dev-panel group.
export const FONT_CONFIG_KEYS = [
    // Text
    'rasterEmHeight', 'wrapWidthPx', 'lineHeightEm', 'useKerning', 'letterSpacingUnits',
    // Rasterisation
    'rasterPadding', 'alphaThreshold',
    // Skeletonisation
    'thinningAlgorithm', 'removeRedundantPixels', 'maxThinningIterations',
    // Cleanup
    'removeIsolatedPixels', 'minSourceAreaPx', 'minBranchLengthPx', 'pruneIterations',
    'mergeAdjacentJunctions', 'simplifyTolerancePx', 'smoothingPasses', 'smoothingStrength',
    'preserveEndpointsWhileSmoothing',
];

// View keys driven by the Path group.
export const FONT_VIEW_KEYS = [
    'pathThicknessEnabled', 'pathThicknessPx', 'pathColor',
    'progressiveThickness', 'adaptiveThickness', 'strokeRoundCap',
];

const pick = (src, keys) => {
    const out = {};
    for (const k of keys) if (src && src[k] !== undefined) out[k] = src[k];
    return out;
};

// A snapshot of everything a font owns. Tween is taken wholesale because
// every one of its keys is a Path Tween control - there is no global
// tween setting to accidentally capture.
export function captureSettings(state) {
    return {
        config: pick(state.config, FONT_CONFIG_KEYS),
        view: pick(state.view, FONT_VIEW_KEYS),
        tween: { ...state.tween },
    };
}

// Merge a snapshot back over live state. Merged rather than replaced so
// a snapshot saved before a key existed does not wipe that key's current
// value - which is what makes an old preset still usable after the
// pipeline gains a setting.
export function applySettings(state, snap) {
    if (!snap) return false;
    Object.assign(state.config, pick(snap.config, FONT_CONFIG_KEYS));
    Object.assign(state.view, pick(snap.view, FONT_VIEW_KEYS));
    if (snap.tween) Object.assign(state.tween, snap.tween);
    return true;
}

// ---- Naming --------------------------------------------------------

// The default name offered for a new preset, derived from the last one
// saved: increment a number if the name has one, otherwise add one.
//
//   (nothing yet)   -> 'Preset'
//   'Preset'        -> 'Preset - 2'
//   'Preset - 2'    -> 'Preset - 3'
//   'Bold 3 Pass'   -> 'Bold 4 Pass'
//
// The LAST number in the name is the one incremented, and it is
// incremented IN PLACE so the format chosen is preserved rather than
// normalised into some canonical shape. Padding is kept too, so
// 'Run 09' becomes 'Run 10' rather than 'Run 10' losing its width.
export function nextPresetName(lastName) {
    const base = String(lastName || '').trim();
    if (!base) return 'Preset';
    const m = base.match(/(\d+)(\D*)$/);
    if (!m) return `${base} - 2`;
    const digits = m[1];
    const next = String(Number(digits) + 1).padStart(digits.length, '0');
    return base.slice(0, base.length - m[0].length) + next + m[2];
}

// Names must be unique within a font, so Use/Rename/Delete can identify
// a preset by what the list shows.
export function uniqueName(existingNames, wanted) {
    const taken = new Set(existingNames.map((n) => String(n)));
    let name = String(wanted || '').trim() || 'Preset';
    while (taken.has(name)) name = nextPresetName(name);
    return name;
}

// ---- Store ---------------------------------------------------------
// { [fontKey]: { memory: <snapshot>, presets: [{name, settings}] } }

export function fontKey(fontInfo) {
    return (fontInfo && (fontInfo.postScriptName || fontInfo.fullName || fontInfo.sourceName)) || 'unknown';
}

const entryFor = (store, key) => (store && store[key]) || { memory: null, presets: [] };

export function readEntry(store, fontInfo) {
    return entryFor(store, fontKey(fontInfo));
}

export function listPresets(store, fontInfo) {
    return readEntry(store, fontInfo).presets || [];
}

export function writeMemory(store, fontInfo, snapshot) {
    const key = fontKey(fontInfo);
    const e = entryFor(store, key);
    return { ...(store || {}), [key]: { ...e, memory: snapshot } };
}

export function addPreset(store, fontInfo, name, snapshot) {
    const key = fontKey(fontInfo);
    const e = entryFor(store, key);
    const presets = [...(e.presets || []), { name, settings: snapshot }];
    return { ...(store || {}), [key]: { ...e, presets } };
}

export function renamePreset(store, fontInfo, oldName, newName) {
    const key = fontKey(fontInfo);
    const e = entryFor(store, key);
    const presets = (e.presets || []).map((p) => (p.name === oldName ? { ...p, name: newName } : p));
    return { ...(store || {}), [key]: { ...e, presets } };
}

export function deletePresets(store, fontInfo, names) {
    const key = fontKey(fontInfo);
    const e = entryFor(store, key);
    const drop = new Set(names.map(String));
    const presets = (e.presets || []).filter((p) => !drop.has(String(p.name)));
    return { ...(store || {}), [key]: { ...e, presets } };
}
