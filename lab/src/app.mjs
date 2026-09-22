// ====================================================================
// App wiring — UI only
// ====================================================================
// Contains no geometry. Its job: get a font in, get a character in, call
// runPipeline(), hand the result to the renderer and the animator, and
// publish the report. Any algorithmic change belongs in the stage module
// that owns it, never here.
//
// EVERY CONTROL LIVES IN THE WORKSPACE-STANDARD DEV PANEL (CLAUDE.md
// §12), built from .claude/TEMPLATE_DEV_PANEL.html and loaded as
// ../devpanel.js. This file registers the laboratory's own groups into
// it via window.renderFontLabDevGroups, which devpanel.js calls at the
// template's documented splice point inside ensureDevPanelBuilt().
//
// Control ids follow the template's device-split naming convention
// ([JS-5] in devpanel.js): a `slider|color|select|checkbox` prefix
// followed by a PascalCase name. That prefix is not decoration — it is
// what lets the panel derive a control's Mobile/Landscape twin id
// generically. Ids that don't follow it silently lose that feature.
// ====================================================================

import { loadFontFromFile, loadFontFromUrl, loadFontFromArrayBuffer, hasGlyphFor } from './fontLoader.mjs';
import { DEFAULT_CONFIG, CONFIG_META } from './config.mjs';
import { runPipeline, toDebugJSON } from './pipeline.mjs';
import { Renderer, DEFAULT_LAYERS, DEFAULT_VIEW, LAYER_COLORS } from './viz/renderer.mjs';
import { PathAnimator } from './viz/animator.mjs';
import { ViewportController, DEFAULT_VIEWPORT } from './viz/viewport.mjs';
import { DEFAULT_TWEEN, buildTween, tweenAnimationRoute } from './tween.mjs';
import {
    rememberFont, getFont, listFonts, unsavedFonts, markSaved,
    bytesToBase64, base64ToBytes, adoptSavedFont, keyForFileName,
} from './fontStore.mjs';

// The brief's own test set. Chosen to cover the structural cases that
// break naive skeletonisers: a junction-free ring (O), a pure-curve
// spine (S), stacked loops with a shared stem (B), a descender with a
// closed bowl (g), the highest-degree junction in common use (&), a
// disconnected component (? — the dot), an apex (A), and a plain
// two-stem-plus-crossbar case (H).
const TEST_CHARS = ['A', 'H', 'S', 'O', 'B', 'g', '&', '?'];

const state = {
    font: null,
    fontInfo: null,
    config: { ...DEFAULT_CONFIG },
    layers: { ...DEFAULT_LAYERS },
    view: { ...DEFAULT_VIEW },
    tween: { ...DEFAULT_TWEEN },
    // 'midline' | 'tween' - which geometry the animated dot follows.
    animationPath: 'midline',
    // The string to render. A single character is just the one-character
    // case; the pipeline does not distinguish them.
    text: 'A',
    result: null,
    debug: null,
};

const canvas = document.getElementById('view');
const renderer = new Renderer(canvas);
// Zoom/pan. Owns no geometry - it mutates the renderer's existing view
// transform and asks for a redraw. See viewport.mjs for the gesture map
// and why zoom is anchored to the pointer.
const viewport = new ViewportController(canvas, renderer, () => renderer.draw());
const animator = new PathAnimator(onAnimationFrame);

// Elements created inside dev-panel groups; populated by the builders.
const ui = {
    fontName: null,
    status: null,
    report: null,
    json: null,
    animInfo: null,
    playBtn: null,
    scrub: null,
    charInput: null,
    textInput: null,
    localFontSelect: null,
    charButtons: [],
};

// ---- Dev-panel group definitions ------------------------------------
// Decomposed per §12n: one named control per real value, units inline in
// the label, nothing bundled into a composite "quality" or "cleanup"
// dial. Every field in config.mjs is exposed — the earlier side panel
// surfaced only six of them, which meant the other ten could only be
// changed by editing source.
const GROUPS = {
    FONT: 'Font & Character',
    TEXT: 'Text',
    VIEW: 'View',
    LAYERS: 'Layers',
    PATH: 'Path',
    TWEEN: 'Path Tween',
    ANIM: 'Animation',
    RASTER: 'Rasterisation',
    SKEL: 'Skeletonisation',
    CLEANUP: 'Cleanup',
    TRAVERSAL: 'Traversal',
};

// Maps a dev-panel control id -> the config.mjs key it drives. Kept as
// data so validateDevControlMappings() (the template's own safety net)
// can verify every registered control is actually wired to something.
const CONFIG_BY_CONTROL_ID = {};

const LAYER_LABELS = {
    glyphFill: 'Glyph Fill',
    glyphOutline: 'Glyph Outline',
    mask: 'Raster Mask',
    rawSkeleton: 'Raw Skeleton (Px)',
    rawPolyline: 'Pre-Cleanup Polylines',
    cleanSkeleton: 'Cleaned Skeleton',
    nodes: 'Graph Nodes',
    traversal: 'Traversal Route',
    connectors: 'Connectors (Pen-Up)',
    order: 'Segment Order Numbers',
    dot: 'Animated Dot',
    tween: 'Tween Curves',
};

// Config keys grouped for display, with the unit suffix §12n requires in
// every label. Order within a group is pipeline order, not alphabetical.
const CONFIG_GROUPS = [
    [GROUPS.RASTER, ['rasterPadding', 'alphaThreshold']],
    [GROUPS.SKEL, ['thinningAlgorithm', 'removeRedundantPixels', 'maxThinningIterations']],
    [GROUPS.CLEANUP, [
        'removeIsolatedPixels', 'minSourceAreaPx', 'minBranchLengthPx', 'pruneIterations',
        'mergeAdjacentJunctions', 'simplifyTolerancePx', 'smoothingPasses', 'smoothingStrength',
        'preserveEndpointsWhileSmoothing',
    ]],
    [GROUPS.TRAVERSAL, ['nearestRouting', 'tweenEntryAtEndpoints', 'emitConnectors', 'traversalResampleSpacingPx']],
];

const LAB_CONTROLS = [];

// Single choke point for every control, closing the two silent-failure
// traps the shared template documents:
//   * ctrl.tab MUST be 'desktop', or buildUniformControlRow() attaches
//     the WRONG per-row device checkbox.
//   * every control MUST reach registerDevControlArray(), or
//     ensureDynamicTargetRow() cannot find it and its "Show in Mobile/
//     Landscape" checkbox silently does nothing — no error, no warning.
function addRow(group, ctrl) {
    ctrl.group = group;
    ctrl.tab = 'desktop';
    LAB_CONTROLS.push(ctrl);
    return ctrl;
}

function controlIdFor(key, type) {
    return type + key.charAt(0).toUpperCase() + key.slice(1);
}

function labelFor(key) {
    const meta = CONFIG_META[key] || {};
    const base = meta.label || key;
    const unit = meta.unit;
    if (!unit || unit === 'bool' || unit === 'enum') return base;
    // Title-case the unit so labels read "…(Px)" / "(Ms)" per §12n's
    // inline-unit convention rather than mixing cases across the panel.
    const u = unit.charAt(0).toUpperCase() + unit.slice(1);
    return `${base} (${u})`;
}

// ---- Group construction ----------------------------------------------

function makeGroup(name) {
    const tabContent = document.getElementById('desktopTabContent');
    const section = window.createDevGroupElement(name, 'desktop');
    tabContent.appendChild(section);
    return section.querySelector(':scope > .dev-section-content');
}

// A hand-built row: not a slider/colour/select/checkbox, so it cannot go
// through the template's row builders or the registration system. Marked
// data-skip-device-checkbox for the same reason the built-in Mouse Log
// widget is — these are single-instance widgets with no meaningful
// Mobile/Landscape counterpart, and injectRowDeviceCheckboxes() would
// otherwise bolt an inert checkbox onto each one.
function customRow(content, build) {
    const row = document.createElement('div');
    row.className = 'dev-row';
    row.dataset.skipDeviceCheckbox = 'true';
    build(row);
    content.appendChild(row);
    return row;
}

function buildFontGroup() {
    const content = makeGroup(GROUPS.FONT);

    customRow(content, (row) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.className = 'lab-file-input';
        input.accept = '.ttf,.otf,.woff,.ttc,font/ttf,font/otf';
        input.addEventListener('change', onFontFileChosen);
        row.appendChild(input);
    });

    // Local test fonts. Populated asynchronously; degrades to a disabled
    // single option when the folder is absent (the files are gitignored,
    // so that is the normal state on another machine).
    const localSelect = document.createElement('select');
    localSelect.className = 'dev-select';
    localSelect.style.width = '100%';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'local test fonts…';
    localSelect.appendChild(placeholder);
    localSelect.addEventListener('change', onLocalFontChosen);
    customRow(content, (row) => row.appendChild(localSelect));
    ui.localFontSelect = localSelect;
    populateLocalFonts(localSelect, placeholder).then(() => restoreSavedFonts(localSelect));

    customRow(content, (row) => {
        const label = document.createElement('span');
        label.className = 'dev-label';
        label.textContent = 'Character:';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'dev-text-input';
        input.value = state.text.length === 1 ? state.text : '';
        input.style.width = '48px';
        input.style.textAlign = 'center';
        input.addEventListener('change', () => setText(input.value, input));
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') setText(input.value, input); });
        ui.charInput = input;
        row.append(label, input);
    });

    customRow(content, (row) => {
        const wrap = document.createElement('div');
        wrap.className = 'lab-charbtns';
        for (const ch of TEST_CHARS) {
            const b = document.createElement('button');
            b.textContent = ch;
            b.addEventListener('click', () => setText(ch, null));
            ui.charButtons.push(b);
            wrap.appendChild(b);
        }
        row.appendChild(wrap);
    });

    customRow(content, (row) => {
        ui.fontName = document.createElement('div');
        ui.fontName.className = 'lab-status';
        ui.fontName.textContent = 'no font loaded';
        row.appendChild(ui.fontName);
    });

    customRow(content, (row) => {
        ui.status = document.createElement('div');
        ui.status.className = 'lab-status';
        row.appendChild(ui.status);
    });
}

function buildLayersGroup() {
    const content = makeGroup(GROUPS.LAYERS);
    const controls = [];
    for (const key of Object.keys(DEFAULT_LAYERS)) {
        controls.push(addRow(GROUPS.LAYERS, {
            id: controlIdFor('layer' + key.charAt(0).toUpperCase() + key.slice(1), 'checkbox'),
            type: 'checkbox',
            label: LAYER_LABELS[key] || key,
            value: state.layers[key],
        }));
    }
    window.renderControlArray(controls, 'buildLayersGroup');
    // Wire after render: the DOM elements only exist now.
    for (const key of Object.keys(DEFAULT_LAYERS)) {
        const id = controlIdFor('layer' + key.charAt(0).toUpperCase() + key.slice(1), 'checkbox');
        const el = document.getElementById(id);
        if (!el) continue;
        el.addEventListener('change', () => {
            state.layers[key] = el.checked;
            renderer.setLayers(state.layers);
            renderer.draw();
        });
    }
    return content;
}

function buildAnimationGroup() {
    const content = makeGroup(GROUPS.ANIM);

    customRow(content, (row) => {
        ui.playBtn = document.createElement('button');
        ui.playBtn.textContent = 'Play';
        ui.playBtn.addEventListener('click', () => {
            animator.toggle();
            ui.playBtn.textContent = animator.playing ? 'Pause' : 'Play';
        });
        const restart = document.createElement('button');
        restart.textContent = 'Restart';
        restart.addEventListener('click', () => {
            animator.restart();
            ui.playBtn.textContent = animator.playing ? 'Pause' : 'Play';
        });
        row.append(ui.playBtn, restart);
    });

    const controls = [
        addRow(GROUPS.ANIM, {
            id: 'selectAnimationPath', type: 'select', label: 'Animation Path',
            options: [
                { value: 'midline', text: 'Midline (skeleton)' },
                { value: 'tween', text: 'Tween path' },
            ],
            value: state.animationPath,
        }),
        addRow(GROUPS.ANIM, { id: 'checkboxAnimLoop', type: 'checkbox', label: 'Loop', value: true }),
        addRow(GROUPS.ANIM, { id: 'sliderAnimSpeed', type: 'slider', label: 'Speed (Px/S)', min: 20, max: 1200, step: 10, value: animator.speedPxPerSecond }),
        addRow(GROUPS.ANIM, { id: 'sliderAnimScrub', type: 'slider', label: 'Scrub (%)', min: 0, max: 1000, step: 1, value: 0 }),
    ];
    window.renderControlArray(controls, 'buildAnimationGroup');

    document.getElementById('selectAnimationPath').addEventListener('change', (e) => {
        state.animationPath = e.target.value;
        applyAnimationRoute();
        renderer.draw();
    });
    document.getElementById('checkboxAnimLoop').addEventListener('change', (e) => {
        animator.loop = e.target.checked;
    });
    document.getElementById('sliderAnimSpeed').addEventListener('input', (e) => {
        animator.speedPxPerSecond = parseFloat(e.target.value);
    });
    ui.scrub = document.getElementById('sliderAnimScrub');
    ui.scrub.addEventListener('input', (e) => {
        animator.pause();
        if (ui.playBtn) ui.playBtn.textContent = 'Play';
        animator.seekToFraction(parseFloat(e.target.value) / 1000);
    });

    customRow(content, (row) => {
        ui.animInfo = document.createElement('div');
        ui.animInfo.className = 'lab-status';
        row.appendChild(ui.animInfo);
    });
}

function buildConfigGroups() {
    for (const [groupName, keys] of CONFIG_GROUPS) {
        makeGroup(groupName);
        const controls = [];
        for (const key of keys) {
            const meta = CONFIG_META[key] || {};
            const value = state.config[key];
            let ctrl;
            if (meta.options) {
                ctrl = {
                    id: controlIdFor(key, 'select'),
                    type: 'select',
                    label: labelFor(key),
                    options: meta.options.map((o) => ({ value: o, text: o })),
                    value,
                };
            } else if (typeof value === 'boolean') {
                ctrl = { id: controlIdFor(key, 'checkbox'), type: 'checkbox', label: labelFor(key), value };
            } else {
                ctrl = {
                    id: controlIdFor(key, 'slider'),
                    type: 'slider',
                    label: labelFor(key),
                    min: meta.min ?? 0,
                    max: meta.max ?? 100,
                    step: meta.step ?? 1,
                    value,
                };
            }
            CONFIG_BY_CONTROL_ID[ctrl.id] = key;
            controls.push(addRow(groupName, ctrl));
        }
        window.renderControlArray(controls, 'buildConfigGroups');
    }
}

// ONE delegated listener on the whole panel, rather than a listener per
// control element.
//
// This is not a tidiness preference — it is what makes the Mobile and
// Landscape twins actually work. The panel creates a twin control
// (sliderMobileRasterEmHeight, …) the moment its "Show in Mobile/
// Landscape" box is ticked, and those elements do not exist at wire-up
// time. Attaching listeners per element therefore wires Desktop only,
// and a twin would move, show a new value, and drive nothing at all —
// silently, with no error. Delegation plus the template's own
// resolveDevControlId() (which strips the Mobile/Landscape infix back to
// the Desktop id) means every twin, present or future, is wired for free.
//
// All three tabs deliberately drive the SAME config value. Pipeline
// parameters are not device-specific: a glyph's skeleton does not depend
// on the viewport it is being inspected in. §12f's per-device
// independence is for an app's spatial styling, which this is not.
function setupDelegatedConfigWiring() {
    const panel = document.getElementById('devPanel');
    if (!panel) return;

    const apply = (el) => {
        const raw = el.id || '';
        if (!raw) return;
        const resolved = window.resolveDevControlId(raw);

        // Tween settings: re-offset against the cached distance field and
        // redraw. Like the view settings, never a pipeline re-run.
        const tweenKey = TWEEN_BY_CONTROL_ID[resolved.desktopId];
        if (tweenKey) {
            state.tween[tweenKey] = el.type === 'checkbox' ? el.checked
                : (el.tagName === 'SELECT' ? el.value : parseFloat(el.value));
            recomputeTween();
            renderer.draw();
            return;
        }

        // Render-only settings redraw; they never re-run the pipeline.
        const viewKey = VIEW_BY_CONTROL_ID[resolved.desktopId];
        if (viewKey) {
            state.view[viewKey] = el.type === 'checkbox' ? el.checked
                : (el.type === 'color' ? el.value : parseFloat(el.value));
            renderer.setViewSettings(state.view);
            renderer.draw();
            return;
        }

        const key = CONFIG_BY_CONTROL_ID[resolved.desktopId];
        if (!key) return;
        const meta = CONFIG_META[key] || {};
        let value;
        if (el.type === 'checkbox') value = el.checked;
        else if (meta.options) value = el.value;
        else value = parseFloat(el.value);
        if (value === state.config[key]) return;
        state.config[key] = value;
        syncConfigControlsFromState(raw);
        rerun();
    };

    // WHY BOTH 'change' AND 'input' ARE HANDLED, and why a pointer gate
    // sits between them.
    //
    // 'change' alone is not sufficient. The template's click-to-edit
    // readout (§12h: click a slider's number, type a value) commits with
    //     slider.dispatchEvent(new Event('input', { bubbles: true }))
    // and NEVER dispatches 'change'. A listener bound only to 'change'
    // therefore misses every typed value: the handle moves, the readout
    // updates, and the underlying state silently keeps its previous
    // value. Reported as "I set Tween Progression to 1 but it only goes
    // halfway" — halfway being precisely that control's 0.5 default,
    // which is what it was still sitting on. This affected EVERY typed
    // slider edit in the panel, not just the tween.
    //
    // 'input' alone is not acceptable either: a range drag emits one per
    // pixel, and a full pipeline pass at 512px raster cannot run at that
    // rate.
    //
    // So: 'change' always commits, and 'input' commits only when no
    // pointer is down inside the panel. A drag is pointer-down, so it
    // stays on the release-only path; a typed commit and any synthetic
    // dispatch are pointer-up, so they apply immediately. Exact, rather
    // than a debounce that would guess at the difference.
    let pointerDownInPanel = false;
    panel.addEventListener('pointerdown', () => { pointerDownInPanel = true; });
    // Three independent release paths, for the same reason the template's
    // own undo-gesture gate needs them: a native colour picker never
    // delivers pointerup back to the page (the OS dialog eats it), which
    // would otherwise strand the gate closed and silently kill typed
    // edits for the rest of the session.
    const releasePointer = () => { pointerDownInPanel = false; };
    window.addEventListener('pointerup', releasePointer);
    window.addEventListener('pointercancel', releasePointer);
    window.addEventListener('focus', releasePointer);

    panel.addEventListener('change', (e) => {
        if (e.target && e.target.matches('input, select')) apply(e.target);
    });
    panel.addEventListener('input', (e) => {
        if (!e.target || !e.target.matches('input, select')) return;
        // A colour picker emits 'input' continuously while open and is
        // cheap to apply (no pipeline re-run), so it is always live.
        if (e.target.type === 'color') { apply(e.target); return; }
        if (pointerDownInPanel) return; // mid-drag: wait for 'change'
        apply(e.target);
    });
}

// Keeps a control's twins showing the same number after an edit, since
// all three drive one shared value. Skips the element that was just
// edited so a user's in-progress interaction is never fought.
function syncConfigControlsFromState(editedId) {
    for (const [id, key] of Object.entries(CONFIG_BY_CONTROL_ID)) {
        for (const variant of [id, twinId(id, 'Mobile'), twinId(id, 'Landscape')]) {
            if (!variant || variant === editedId) continue;
            const el = document.getElementById(variant);
            if (!el) continue;
            const value = state.config[key];
            if (el.type === 'checkbox') el.checked = !!value;
            else if (String(el.value) !== String(value)) el.value = value;
        }
    }
}

function twinId(id, device) {
    const m = id.match(/^(slider|color|select|checkbox)(.+)$/);
    return m ? m[1] + device + m[2] : null;
}


// "Path" (requested via §12g shorthand). Render-only settings, so every
// handler redraws rather than calling rerun() — re-running the whole
// glyph→skeleton pipeline to change a colour would be pure waste, and at
// 512px raster it would be a visible stall on every slider tick.
function buildPathGroup() {
    makeGroup(GROUPS.PATH);
    const controls = [
        addRow(GROUPS.PATH, {
            id: 'checkboxPathThicknessEnabled', type: 'checkbox',
            label: 'Path Thickness On/Off', value: state.view.pathThicknessEnabled,
        }),
        addRow(GROUPS.PATH, {
            id: 'sliderPathThickness', type: 'slider', label: 'Path Thickness (Px)',
            // Range chosen, not specified: 1px is the thinnest visible
            // stroke and ~40px is roughly a Comic Sans stem at the 256px
            // default raster, i.e. the point past which the path stops
            // reading as a path and starts covering the glyph. Click the
            // readout to type a value outside it if needed.
            min: 1, max: 40, step: 0.5, value: state.view.pathThicknessPx,
        }),
        addRow(GROUPS.PATH, {
            id: 'colorPathColor', type: 'color', label: 'Path Color',
            value: state.view.pathColor,
        }),
        addRow(GROUPS.PATH, {
            id: 'checkboxProgressiveThickness', type: 'checkbox',
            label: 'Progressive Thickness On/Off', value: state.view.progressiveThickness,
        }),
    ];
    window.renderControlArray(controls, 'buildPathGroup');
}

// Maps a Path control id -> the view-settings key it drives. Same data
// shape as CONFIG_BY_CONTROL_ID so the delegated listener can handle
// both without a second mechanism.
const VIEW_BY_CONTROL_ID = {
    checkboxPathThicknessEnabled: 'pathThicknessEnabled',
    sliderPathThickness: 'pathThicknessPx',
    colorPathColor: 'pathColor',
    checkboxProgressiveThickness: 'progressiveThickness',
};


// "Path Tween" (requested via §12g shorthand). Morphs the centreline out
// to the glyph outline; see tween.mjs for the mechanism and for an
// honest account of where progression=1 is and is not exact.
//
// Every control here is RENDER-ONLY in the same sense as the Path group:
// the expensive part (the distance transform) is computed once per
// pipeline run and reused, so dragging Tween Progression re-offsets the
// existing polylines and redraws. It never re-rasterises or re-thins.
function buildTweenGroup() {
    makeGroup(GROUPS.TWEEN);
    const controls = [
        addRow(GROUPS.TWEEN, {
            id: 'checkboxPathTweenEnabled', type: 'checkbox',
            label: 'Path Tween On/Off', value: state.tween.enabled,
        }),
        addRow(GROUPS.TWEEN, {
            id: 'sliderTweenProgression', type: 'slider', label: 'Tween Progression (0-1)',
            min: 0, max: 1, step: 0.01, value: state.tween.progression,
        }),
        // ---- fine tuning ------------------------------------------------
        addRow(GROUPS.TWEEN, {
            id: 'sliderTweenRadiusScale', type: 'slider', label: 'Radius Scale (X)',
            min: 0.5, max: 2, step: 0.01, value: state.tween.radiusScale,
        }),
        addRow(GROUPS.TWEEN, {
            id: 'sliderTweenRadiusSmoothing', type: 'slider', label: 'Radius Smoothing (Passes)',
            min: 0, max: 12, step: 1, value: state.tween.radiusSmoothing,
        }),
        addRow(GROUPS.TWEEN, {
            id: 'sliderTweenNormalSmoothing', type: 'slider', label: 'Normal Smoothing (Passes)',
            min: 0, max: 12, step: 1, value: state.tween.normalSmoothing,
        }),
        addRow(GROUPS.TWEEN, {
            id: 'sliderTweenResampleSpacing', type: 'slider', label: 'Resample Spacing (Px)',
            min: 0, max: 10, step: 0.5, value: state.tween.resampleSpacingPx,
        }),
        addRow(GROUPS.TWEEN, {
            id: 'sliderTweenExtendTerminals', type: 'slider', label: 'Extend Terminals (Px)',
            min: 0, max: 40, step: 0.5, value: state.tween.extendTerminalsPx,
        }),
        addRow(GROUPS.TWEEN, {
            id: 'checkboxTweenBothSides', type: 'checkbox',
            label: 'Both Sides On/Off', value: state.tween.bothSides,
        }),
        addRow(GROUPS.TWEEN, {
            id: 'checkboxTweenJoinIntersections', type: 'checkbox',
            label: 'Join Intersecting Curves On/Off', value: state.tween.joinIntersections,
        }),
        addRow(GROUPS.TWEEN, {
            id: 'selectTweenJoinStyle', type: 'select', label: 'Join Style',
            options: [
                { value: 'auto', text: 'auto (by measured angle)' },
                { value: 'sharp', text: 'sharp' },
                { value: 'round', text: 'round' },
                { value: 'bevel', text: 'bevel' },
            ],
            value: state.tween.joinStyle,
        }),
        addRow(GROUPS.TWEEN, {
            id: 'sliderTweenJoinSharpAngle', type: 'slider', label: 'Join Sharp Angle Threshold (Deg)',
            min: 0, max: 180, step: 1, value: state.tween.joinSharpAngleDeg,
        }),
        addRow(GROUPS.TWEEN, {
            id: 'sliderTweenJoinCornerRadius', type: 'slider', label: 'Join Corner Radius (Px)',
            min: 0, max: 30, step: 0.5, value: state.tween.joinCornerRadiusPx,
        }),
        addRow(GROUPS.TWEEN, {
            id: 'sliderTweenJoinMiterLimit', type: 'slider', label: 'Join Miter Limit (X)',
            // step 0.1, not 0.5: the whole interesting range sits between
            // 1.0 and ~2.0 (a 90deg corner has a miter of 1.41), so a
            // coarser step would skip straight past it.
            min: 1, max: 20, step: 0.1, value: state.tween.joinMiterLimit,
        }),
    ];
    window.renderControlArray(controls, 'buildTweenGroup');
}

// Tween control id -> tween-settings key. Same data shape as the other
// two maps so the single delegated listener handles all three.
const TWEEN_BY_CONTROL_ID = {
    checkboxPathTweenEnabled: 'enabled',
    sliderTweenProgression: 'progression',
    sliderTweenRadiusScale: 'radiusScale',
    sliderTweenRadiusSmoothing: 'radiusSmoothing',
    sliderTweenNormalSmoothing: 'normalSmoothing',
    sliderTweenResampleSpacing: 'resampleSpacingPx',
    sliderTweenExtendTerminals: 'extendTerminalsPx',
    checkboxTweenBothSides: 'bothSides',
    checkboxTweenJoinIntersections: 'joinIntersections',
    selectTweenJoinStyle: 'joinStyle',
    sliderTweenJoinSharpAngle: 'joinSharpAngleDeg',
    sliderTweenJoinCornerRadius: 'joinCornerRadiusPx',
    sliderTweenJoinMiterLimit: 'joinMiterLimit',
};

// Re-offsets the existing centrelines against the cached distance field.
// Cheap: O(points), no rasterisation, no thinning. Also re-points the
// animator when the dot is following the tween, so changing progression
// while it is playing moves the dot onto the new geometry rather than
// leaving it tracing a path that is no longer on screen.
function recomputeTween() {
    const r = state.result;
    if (!r || !r.ok || !r.distanceField) {
        state.tweenResult = null;
        renderer.setTween(null);
        return;
    }
    state.tweenResult = state.tween.enabled
        ? buildTween(r.vector, r.raster, r.distanceField, state.tween)
        : null;
    renderer.setTween(state.tweenResult);
    applyAnimationRoute();
}

// Chooses which geometry the dot follows. Falls back to the midline
// whenever the tween is off or empty, rather than leaving the animator
// with no route at all — a dropdown set to "Tween" with the tween
// disabled would otherwise silently stop the animation dead.
function applyAnimationRoute() {
    const r = state.result;
    if (!r || !r.ok) return;
    const fraction = animator.totalLength > 0 ? animator.progress : 0;
    const useTween = state.animationPath === 'tween'
        && state.tweenResult && state.tweenResult.curves.length;
    // Midline endpoints (free tips of the skeleton graph) are where a
    // tween LOOP should start, per the entry rule in routing.mjs.
    const midlineEndpoints = (r.vector.nodes || [])
        .filter((n) => n.kind === 'endpoint')
        .map((n) => ({ x: n.xPx, y: n.yPx }));
    animator.setRoute(useTween
        ? tweenAnimationRoute(state.tweenResult, {
            nearestRouting: state.config.nearestRouting,
            entryMode: state.config.tweenEntryAtEndpoints === false ? 'nearest' : 'endpoints',
            loopAnchors: midlineEndpoints,
        })
        : r.traversal.animation);
    // Preserve position proportionally so switching source mid-run does
    // not snap the dot back to the start.
    animator.seekToFraction(fraction);
}


// "Text" — type a whole string instead of picking one letter. The
// pipeline treats a single character as the one-character case of a
// string, so nothing here is a separate code path (see extractText).
//
// The text box is the SINGLE SOURCE OF TRUTH for what gets rendered.
// The Character field and the test-character buttons in the Font group
// are quick setters that write into it, so there are never two
// competing values for "what am I looking at".
function buildTextGroup() {
    const content = makeGroup(GROUPS.TEXT);

    customRow(content, (row) => {
        const label = document.createElement('span');
        label.className = 'dev-label';
        label.textContent = 'Display Text:';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'dev-text-input';
        input.value = state.text;
        input.style.width = '100%';
        const commit = () => { setText(input.value, input); };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
        ui.textInput = input;
        row.append(label, input);
    });

    const controls = [
        addRow(GROUPS.TEXT, {
            id: 'sliderRasterEmHeight', type: 'slider', label: 'Font Size (Px)',
            min: 64, max: 512, step: 16, value: state.config.rasterEmHeight,
        }),
        addRow(GROUPS.TEXT, {
            id: 'sliderWrapWidthPx', type: 'slider', label: 'Wrap Width (Px)',
            min: 0, max: 4000, step: 50, value: state.config.wrapWidthPx,
        }),
        addRow(GROUPS.TEXT, {
            id: 'sliderLineHeightEm', type: 'slider', label: 'Line Height (Em)',
            min: 0.6, max: 3, step: 0.05, value: state.config.lineHeightEm,
        }),
        addRow(GROUPS.TEXT, {
            id: 'checkboxUseKerning', type: 'checkbox',
            label: 'Use Kerning', value: state.config.useKerning,
        }),
        addRow(GROUPS.TEXT, {
            id: 'sliderLetterSpacingUnits', type: 'slider', label: 'Letter Spacing (Font Units)',
            min: -400, max: 800, step: 10, value: state.config.letterSpacingUnits,
        }),
    ];
    CONFIG_BY_CONTROL_ID.sliderRasterEmHeight = 'rasterEmHeight';
    CONFIG_BY_CONTROL_ID.sliderWrapWidthPx = 'wrapWidthPx';
    CONFIG_BY_CONTROL_ID.sliderLineHeightEm = 'lineHeightEm';
    CONFIG_BY_CONTROL_ID.checkboxUseKerning = 'useKerning';
    CONFIG_BY_CONTROL_ID.sliderLetterSpacingUnits = 'letterSpacingUnits';
    window.renderControlArray(controls, 'buildTextGroup');
}

// One place that changes what is rendered, so every entry point (the
// text box, the Character field, the test buttons) stays in agreement.
function setText(value, origin) {
    state.text = value;
    if (ui.textInput && ui.textInput !== origin) ui.textInput.value = value;
    if (ui.charInput && ui.charInput !== origin) ui.charInput.value = value.length === 1 ? value : '';
    rerun();
}


// "View" — zoom/pan behaviour. The gestures themselves need no controls
// (scroll and right-drag on desktop, pinch and two-finger drag on
// touch); these are the two things that genuinely have a value worth
// tuning, plus an explicit way back to the default framing.
function buildViewGroup() {
    const content = makeGroup(GROUPS.VIEW);

    customRow(content, (row) => {
        const reset = document.createElement('button');
        reset.textContent = 'Reset View';
        reset.addEventListener('click', () => viewport.resetView());
        const hint = document.createElement('span');
        hint.className = 'lab-status';
        hint.textContent = 'scroll = zoom · right-drag = pan · double-click = reset';
        row.append(reset, hint);
    });

    const controls = [
        addRow(GROUPS.VIEW, {
            id: 'checkboxAutoFit', type: 'checkbox',
            label: 'Auto-Fit On New Glyph', value: DEFAULT_VIEWPORT.autoFit,
        }),
        addRow(GROUPS.VIEW, {
            id: 'sliderZoomSpeed', type: 'slider', label: 'Zoom Speed (Per Wheel Unit)',
            min: 1.0002, max: 1.006, step: 0.0002, value: DEFAULT_VIEWPORT.zoomSpeed,
        }),
    ];
    window.renderControlArray(controls, 'buildViewGroup');

    document.getElementById('checkboxAutoFit').addEventListener('change', (e) => {
        viewport.setSettings({ autoFit: e.target.checked });
        renderer.autoFit = e.target.checked;
    });
    document.getElementById('sliderZoomSpeed').addEventListener('input', (e) => {
        viewport.setSettings({ zoomSpeed: parseFloat(e.target.value) });
    });
}

// The pipeline report and the debug JSON go into the mandatory built-in
// "Debug" group (§12i-1) as nested subgroups, rather than inventing a
// top-level group for them — that group exists precisely for this.
function buildDebugWidgets() {
    const debugContent = window.findGroupContent('desktop', 'Debug', 'buildDebugWidgets', 'labReport');
    if (!debugContent) return;

    const reportSection = window.createDevGroupElement('Pipeline Report', 'desktop');
    debugContent.appendChild(reportSection);
    const reportContent = reportSection.querySelector(':scope > .dev-section-content');
    customRow(reportContent, (row) => {
        ui.report = document.createElement('div');
        ui.report.className = 'lab-report';
        row.appendChild(ui.report);
    });

    const jsonSection = window.createDevGroupElement('Path Data (JSON)', 'desktop');
    debugContent.appendChild(jsonSection);
    const jsonContent = jsonSection.querySelector(':scope > .dev-section-content');
    customRow(jsonContent, (row) => {
        const copy = document.createElement('button');
        copy.textContent = 'Copy';
        copy.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(JSON.stringify(state.debug, null, 2));
                setStatus('Debug JSON copied.', 'ok');
            } catch {
                setStatus('Clipboard blocked — use Download.', 'warn');
            }
        });
        const dl = document.createElement('button');
        dl.textContent = 'Download';
        dl.addEventListener('click', () => {
            const blob = new Blob([JSON.stringify(state.debug, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `fontpath-${(state.fontInfo && state.fontInfo.familyName) || 'font'}-${(state.text || 'x').slice(0, 12)}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
        });
        row.append(copy, dl);
    });
    customRow(jsonContent, (row) => {
        ui.json = document.createElement('pre');
        ui.json.className = 'lab-json';
        row.appendChild(ui.json);
    });
}

// Called by devpanel.js at the template's splice point. Defined on
// window because devpanel.js is a classic script and this file is a
// module (module top-level declarations never reach global scope).
window.renderFontLabDevGroups = function renderFontLabDevGroups() {
    buildFontGroup();
    buildTextGroup();
    buildViewGroup();
    buildLayersGroup();
    buildPathGroup();
    buildTweenGroup();
    buildAnimationGroup();
    buildConfigGroups();
    buildDebugWidgets();
    // After every group exists, and once only: see the function's own
    // note on why this is delegated rather than per-element.
    setupDelegatedConfigWiring();

    // NOT optional cleanup — see addRow's comment. Without this the
    // per-control "Show in Mobile/Landscape" checkbox is inert.
    window.registerDevControlArray('LAB_CONTROLS', LAB_CONTROLS);

    // The template's own safety net: flags any registered control whose
    // id isn't actually wired to something. Layer and animation controls
    // are wired directly rather than through the config map, so they are
    // accepted explicitly instead of being reported as unmapped.
    window.registerDevControlIdValidator((ctrl) => (
        ctrl.id in CONFIG_BY_CONTROL_ID
        || ctrl.id in VIEW_BY_CONTROL_ID
        || ctrl.id in TWEEN_BY_CONTROL_ID
        || ctrl.id === 'selectAnimationPath'
        || ctrl.id.startsWith('checkboxLayer')
        || ctrl.id.startsWith('checkboxAnim')
        || ctrl.id.startsWith('sliderAnim')
        || ctrl.id === 'checkboxAutoFit'
        || ctrl.id === 'sliderZoomSpeed'
        || `unwired control id: ${ctrl.id}`
    ));

    // Sync: the template's own saveDevPanelSettings() already wrote to
    // localStorage by the time this runs, so a failed remote save can
    // never cost a local one. Extra listeners on the EXISTING buttons,
    // so devpanel.js stays a verbatim copy.
    const syncButtons = [
        document.getElementById('devHeaderSyncBtn'),
        ...Array.from(document.querySelectorAll('.dev-buttons button'))
            .filter((b) => (b.getAttribute('onclick') || '').includes('saveDevPanelSettings')),
    ].filter(Boolean);
    syncButtons.forEach((btn) => btn.addEventListener('click', () => { syncToRemote(); }));

    buildLegend();
    renderer.setViewSettings(state.view);
    renderer.resizeToDisplaySize();
    renderer.draw();
    setStatus('Load a .ttf / .otf to begin.');
};


// ====================================================================
// Persistence (CLAUDE.md §12l) -- settings AND imported fonts
// ====================================================================
// Sync writes the dev panel's state to the git-tracked settings file
// AND commits every imported font that is not already there, so the
// fonts come back on another machine or after a reload.
//
// Fonts are committed as their OWN files under data/processed/fonts/,
// never embedded in the settings JSON -- see fontStore.mjs for the
// reasoning (a 1.8MB face is ~2.4MB of base64, and Sync rewrites the
// whole settings document every time).
//
// Everything here degrades to localStorage silently when the endpoint
// is absent, which is the normal case on a plain static server and the
// documented default rather than a failure.
const SETTINGS_ENDPOINT = '/api/save-settings';
const FONT_DIR = 'data/processed/fonts/';

// Client half of §12l's shared secret. Empty means "no remote writes
// from this build"; the local server only enforces it when it has one
// set in its own environment.
const DEV_PANEL_SAVE_SECRET = '';

async function remoteGetSettings() {
    try {
        const resp = await fetch(SETTINGS_ENDPOINT, { cache: 'no-store' });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data && data.ok ? data.settings : null;
    } catch {
        return null; // no endpoint behind this page
    }
}

// GET -> merge -> POST, never a blind POST: the settings document holds
// several independent top-level keys written by different code paths,
// and a blind overwrite from any one of them erases the others.
async function remoteSave({ patch = {}, files = [] } = {}) {
    try {
        const current = (await remoteGetSettings()) || {};
        const headers = { 'Content-Type': 'application/json' };
        if (DEV_PANEL_SAVE_SECRET) headers['x-dev-panel-secret'] = DEV_PANEL_SAVE_SECRET;
        const resp = await fetch(SETTINGS_ENDPOINT, {
            method: 'POST',
            headers,
            body: JSON.stringify({ settings: { ...current, ...patch }, files }),
        });
        const data = await resp.json().catch(() => ({}));
        return { ok: resp.ok && data.ok !== false, error: data.error, written: data.written || [] };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e), written: [] };
    }
}

// Called on every Sync. Uploads any font not yet committed, then writes
// the settings document including the font manifest.
async function syncToRemote() {
    const pending = unsavedFonts();
    const files = pending.map((f) => ({
        path: FONT_DIR + f.fileName,
        contentBase64: bytesToBase64(f.bytes),
        message: `Add imported font ${f.fileName} via Font Path Laboratory`,
    }));

    const manifest = listFonts().map((f) => ({
        key: f.key,
        fileName: f.fileName,
        size: f.size,
        path: f.savedPath || (FONT_DIR + f.fileName),
    }));

    const patch = { importedFonts: manifest };
    if (typeof window.captureFullDevPanelState === 'function') {
        patch.devPanel = window.captureFullDevPanelState();
    }

    setStatus(pending.length ? `Saving ${pending.length} font(s) + settings…` : 'Saving settings…');
    const res = await remoteSave({ patch, files });
    if (!res.ok) {
        // Not an error the user needs to act on: localStorage already
        // holds the panel state, so nothing was lost.
        setStatus(`Saved locally only — remote save unavailable (${res.error || 'no endpoint'}).`, 'warn');
        return;
    }
    for (const f of pending) markSaved(f.key, FONT_DIR + f.fileName);
    setStatus(`Saved ${res.written.length} file(s) to the repo: ${res.written.join(', ')}`, 'ok');
    refreshFontList();
}

// On startup, pull the manifest and fetch each saved font back so it is
// selectable again without re-picking the file.
async function restoreSavedFonts(select) {
    const settings = await remoteGetSettings();
    const manifest = (settings && settings.importedFonts) || [];
    if (!manifest.length) return;
    for (const entry of manifest) {
        try {
            const resp = await fetch('/' + entry.path, { cache: 'no-store' });
            if (!resp.ok) continue;
            const bytes = new Uint8Array(await resp.arrayBuffer());
            adoptSavedFont(entry.key, entry.fileName, bytes, entry.path);
        } catch {
            // A font listed in the manifest but missing from the repo is
            // skipped rather than failing the whole restore.
        }
    }
    refreshFontList(select);
}

// Adds every stored font to the font dropdown under a "saved" group, so
// imported fonts sit alongside the local test faces.
function refreshFontList(select) {
    const sel = select || ui.localFontSelect;
    if (!sel) return;
    let group = sel.querySelector('optgroup[data-saved]');
    const fonts = listFonts();
    if (!fonts.length) { if (group) group.remove(); return; }
    if (!group) {
        group = document.createElement('optgroup');
        group.label = 'imported (saved)';
        group.setAttribute('data-saved', '1');
        sel.appendChild(group);
    }
    group.innerHTML = '';
    for (const f of fonts) {
        const opt = document.createElement('option');
        opt.value = 'stored:' + f.key;
        opt.textContent = `${f.fileName}${f.savedPath ? '' : ' (unsaved)'}`;
        group.appendChild(opt);
    }
}

// ---- Runtime ---------------------------------------------------------

function buildLegend() {
    const legend = document.getElementById('legend');
    if (!legend) return;
    legend.innerHTML = '';
    for (const [key, text] of [
        ['endpoint', 'endpoint'],
        ['junction', 'junction'],
        ['loopAnchor', 'loop anchor'],
        ['dotNode', 'dot'],
        ['cleanSkeleton', 'skeleton'],
        ['connector', 'pen-up'],
    ]) {
        const s = document.createElement('span');
        const i = document.createElement('i');
        i.style.background = LAYER_COLORS[key];
        s.append(i, document.createTextNode(text));
        legend.appendChild(s);
    }
}

function onAnimationFrame(frame) {
    if (!frame) return;
    renderer.dot = frame.point;
    renderer.trail = frame.trail;
    if (ui.scrub) ui.scrub.value = String(Math.round(frame.fraction * 1000));
    if (ui.animInfo) {
        ui.animInfo.textContent =
            `${frame.distance.toFixed(0)} / ${animator.totalLength.toFixed(0)} px · `
            + `${(frame.fraction * 100).toFixed(1)}% · on: ${frame.kind}`
            + (frame.edgeId != null ? ` (edge ${frame.edgeId})` : '');
    }
    renderer.draw();
}

async function onFontFileChosen(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setStatus('Parsing font…');
    try {
        const buf = await file.arrayBuffer();
        rememberFont(file.name, buf);
        const { font, info } = await loadFontFromFile(file);
        adoptFont(font, info);
        refreshFontList();
    } catch (err) {
        state.font = null;
        if (ui.fontName) { ui.fontName.textContent = 'load failed'; ui.fontName.className = 'lab-status error'; }
        setStatus(err.message || String(err), 'error');
    }
}

async function onLocalFontChosen(e) {
    const url = e.target.value;
    if (!url) return;

    // A font restored from the repo is already in memory; parse from the
    // stored bytes rather than re-fetching it.
    if (url.startsWith('stored:')) {
        const entry = getFont(url.slice(7));
        if (!entry) { setStatus('That saved font is no longer in memory.', 'warn'); return; }
        try {
            const { font, info } = loadFontFromArrayBuffer(entry.bytes.buffer, entry.fileName);
            adoptFont(font, info);
        } catch (err) {
            setStatus(err.message || String(err), 'error');
        }
        return;
    }
    setStatus('Loading ' + url + '…');
    try {
        const { font, info } = await loadFontFromUrl(url);
        // Remembered too: from the app's point of view a face picked from
        // the local list is just as "imported" as one picked from disk,
        // and Sync should be able to persist whichever one is in use.
        try {
            const resp = await fetch(url, { cache: 'no-store' });
            if (resp.ok) rememberFont(url.split('/').pop(), await resp.arrayBuffer());
        } catch { /* the font already loaded; caching it is best-effort */ }
        adoptFont(font, info);
        refreshFontList();
    } catch (err) {
        setStatus(err.message || String(err), 'error');
    }
}

function adoptFont(font, info) {
    state.font = font;
    state.fontInfo = info;
    if (ui.fontName) {
        ui.fontName.textContent = `${info.fullName} · ${info.unitsPerEm} upm · ${info.numGlyphs} glyphs · ${info.outlinesFormat}`;
        ui.fontName.className = 'lab-status ok';
    }
    rerun();
}

// Populates the font picker from every font folder the server can see.
//
// PREFERS AUTO-DISCOVERY (/api/fonts, implemented in serve.py) over a
// checked-in manifest, because a hand-maintained list is exactly the
// thing that goes stale the first time a font is dropped into the folder
// and nobody updates it. The static manifests remain as a fallback for
// a deployment where serve.py is not the server.
//
// Degrades quietly to the file picker, which is always the real entry
// point: the font binaries are not committed, so an empty list is the
// normal state on another machine rather than a failure.
async function populateLocalFonts(select, placeholder) {
    const groups = new Map();
    const add = (groupLabel, value, text) => {
        if (!groups.has(groupLabel)) groups.set(groupLabel, []);
        groups.get(groupLabel).push({ value, text });
    };

    let discovered = false;
    try {
        const resp = await fetch('/api/fonts', { cache: 'no-store' });
        if (resp.ok) {
            const data = await resp.json();
            for (const f of (data && data.fonts) || []) {
                add(f.group, '/' + f.path, `${f.fileName}  (${Math.round(f.size / 1024)}KB)`);
                discovered = true;
            }
        }
    } catch {
        // No discovery endpoint (a plain static host) — fall through.
    }

    if (!discovered) {
        try {
            const resp = await fetch('test-fonts/manifest.json', { cache: 'no-store' });
            if (resp.ok) {
                const data = await resp.json();
                for (const f of data.fonts || []) add('test-fonts', 'test-fonts/' + f.file, f.label);
                discovered = true;
            }
        } catch { /* nothing to fall back to */ }
    }

    if (!discovered) {
        placeholder.textContent = 'local fonts: none found';
        select.disabled = true;
        return;
    }

    for (const [label, entries] of groups) {
        const og = document.createElement('optgroup');
        og.label = label;
        for (const e of entries) {
            const opt = document.createElement('option');
            opt.value = e.value;
            opt.textContent = e.text;
            og.appendChild(opt);
        }
        select.appendChild(og);
    }
}

function setStatus(text, kind = '') {
    if (!ui.status) return;
    ui.status.textContent = text;
    ui.status.className = 'lab-status' + (kind ? ' ' + kind : '');
}

function markActiveTestChar(ch) {
    for (const b of ui.charButtons) b.classList.toggle('active', b.textContent === ch);
}

function rerun() {
    const text = state.text || '';
    markActiveTestChar(text);
    if (!state.font) { setStatus('Load a font file first.', 'warn'); return; }
    if (!text.trim()) { setStatus('Enter some text.', 'warn'); return; }

    // Report missing glyphs up front rather than letting them silently
    // render as blanks. Only a string with NO renderable glyph at all is
    // a hard failure -- a space, or one unsupported character among
    // several, is not.
    const chars = Array.from(text);
    const missing = chars.filter((c) => c.trim() && !hasGlyphFor(state.font, c));
    if (missing.length === chars.filter((c) => c.trim()).length) {
        const msg = `This font has no glyph for ${missing.map((c) => `"${c}"`).join(', ')}.`;
        setStatus(msg, 'error');
        state.result = { ok: false, stage: 'glyph lookup', error: msg };
        renderer.setResult(state.result);
        renderer.draw();
        if (ui.report) ui.report.innerHTML = '';
        if (ui.json) ui.json.textContent = '';
        return;
    }

    const t0 = performance.now();
    const result = runPipeline(state.font, text, state.config);
    const wall = performance.now() - t0;
    state.result = result;
    state.debug = toDebugJSON(result);

    renderer.setResult(result);
    renderer.setLayers(state.layers);

    if (result.ok) {
        animator.setRoute(result.traversal.animation);
        animator.seekToFraction(0);
        // New glyph -> new distance field -> the tween must be rebuilt
        // before the first draw, or the previous character's curves would
        // be painted over this one.
        recomputeTween();
        const warnCount = result.warnings.length;
        setStatus(
            `${text} — ${result.vector.segments.length} segments, `
            + `${result.graph.stats.componentCount} component(s), ${wall.toFixed(0)}ms`
            + (warnCount ? `  (${warnCount} warning${warnCount > 1 ? 's' : ''})` : ''),
            warnCount || missing.length ? 'warn' : 'ok',
        );
        if (missing.length) {
            setStatus(`${text} — rendered without ${missing.map((c) => `"${c}"`).join(', ')} (no glyph in this font)`, 'warn');
        }
    } else {
        animator.pause();
        animator.setRoute(null);
        state.tweenResult = null;
        renderer.setTween(null);
        setStatus(`${result.stage}: ${result.error}`, 'error');
    }

    renderer.draw();
    renderReport(result);
    if (ui.json) ui.json.textContent = JSON.stringify(state.debug, null, 1);
}

function renderReport(result) {
    if (!ui.report) return;
    if (!result) { ui.report.innerHTML = ''; return; }
    if (!result.ok) {
        ui.report.innerHTML = `<div class="lab-line-err">FAILED at stage: ${escapeHtml(result.stage)}</div>`
            + `<div class="lab-line-err">${escapeHtml(result.error)}</div>`;
        return;
    }
    const r = result;
    const rows = [
        ['text', `"${r.glyph.text.length > 24 ? r.glyph.text.slice(0, 24) + '…' : r.glyph.text}" · ${r.glyph.glyphCount} glyph(s) · ${r.glyph.lineCount} line(s) · ${r.glyph.contourCount} contour(s)`],
        ['raster', `${r.raster.width}x${r.raster.height} px · ${r.raster.filledPixels} filled (${(r.raster.fillRatio * 100).toFixed(1)}%)`],
        ['thinning', `${r.thin.algorithm} · ${r.thin.iterations} iters · ${r.thin.converged ? 'converged' : 'CAPPED'} · ${r.thin.skeletonPixels} px`],
        ['graph raw', `${r.graphBeforeCleanup.nodeCount} nodes, ${r.graphBeforeCleanup.edgeCount} edges, ${r.graphBeforeCleanup.componentCount} comp`],
        ['graph clean', `${r.graph.stats.nodeCount} nodes, ${r.graph.stats.edgeCount} edges, ${r.graph.stats.componentCount} comp`],
        ['node kinds', `${r.graph.stats.endpointCount} end · ${r.graph.stats.junctionCount} junc · ${r.graph.stats.loopAnchorCount} loop · ${r.graph.stats.dotCount || 0} dot`],
        ['pruned', `${sum(r.cleanup.log, 'removedEdges')} spur, ${sum(r.cleanup.log, 'removedComponents')} tiny comp, ${sum(r.cleanup.log, 'removedLoops')} self-loop`],
        ['polyline pts', `${r.cleanup.geometry.pointsBefore} → ${r.cleanup.geometry.pointsAfterSimplify} (RDP) → ${r.cleanup.geometry.pointsAfter} (smooth)`],
        ['traversal', `${r.traversal.stats.drawCount} draw, ${r.traversal.stats.connectorCount} conn (${r.traversal.stats.componentJumps} jump / ${r.traversal.stats.backtracks} back)`],
        ['coverage', `${r.traversal.stats.edgesCovered}/${r.traversal.stats.edgesTotal} edges ${r.traversal.stats.complete ? 'OK' : 'INCOMPLETE'}`],
        ['route length', `${r.traversal.animation.totalLength.toFixed(0)} px`],
        ['timings ms', Object.entries(r.timings).map(([k, v]) => `${k} ${v}`).join(' · ')],
    ];
    let html = '';
    for (const [k, v] of rows) html += `<b>${escapeHtml(k)}</b><span>${escapeHtml(v)}</span>`;
    ui.report.innerHTML = html;
    if (!r.traversal.stats.complete) {
        ui.report.insertAdjacentHTML('afterend', '<div class="lab-line-err">Some edges were never traversed.</div>');
    }
    for (const w of r.warnings) {
        ui.report.insertAdjacentHTML('afterend', `<div class="lab-line-warn">! ${escapeHtml(w)}</div>`);
    }
}

function sum(list, key) {
    return list.reduce((s, x) => s + (x[key] || 0), 0);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const resizeObserver = new ResizeObserver(() => {
    renderer.resizeToDisplaySize();
    renderer.draw();
});
resizeObserver.observe(canvas);

renderer.resizeToDisplaySize();
renderer.draw();

// Exposed deliberately: this is a laboratory. Being able to poke the
// pipeline from the console — re-run with different config, dump a
// result, diff two fonts — is a feature, not a leak.
window.fontLab = { state, renderer, animator, viewport, rerun, runPipeline, toDebugJSON, loadFontFromUrl };
