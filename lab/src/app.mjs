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
    applyOrderOverride, flattenOrdered, swapStops, stopNearest,
    rasterBounds, toLearnedOrder, bestLearnedOrder, readLearned, writeLearned,
} from './routeOrder.mjs';
import {
    captureSettings, applySettings, nextPresetName, uniqueName,
    listPresets, readEntry, writeMemory, addPreset, renamePreset, deletePresets,
} from './fontPresets.mjs';
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
    // Manual stroke-order edits for the CURRENT geometry, as an explicit
    // id sequence. Cleared whenever the text or font changes, because
    // the ids belong to that run's skeleton. What survives a change is
    // `learnedOrders` below, which is keyed on position instead.
    routeOrderOverride: null,
    // Whether a canvas click swaps two route points instead of panning.
    switchPointOrderMode: false,
    // font+character -> ordered normalised anchors. Persisted by Sync.
    learnedOrders: {},
    // Result of the last learned-order match, for the status line.
    learnedMatch: null,
    // { [fontKey]: { memory, presets[] } }. Persisted by Sync.
    fontSettings: {},
    // The font whose settings are currently on screen, so a switch can
    // bank the OUTGOING font's state before loading the incoming one.
    activeFontKey: null,
    // Name of the last preset saved, for the next default name.
    lastPresetName: '',
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

// CAPTURING, and on pointerdown rather than click: the viewport
// controller starts a pan on pointerdown, so a listener that waited for
// click would fire only after a pan had already begun and moved the
// view out from under the cursor.
canvas.addEventListener('pointerdown', (e) => onCanvasClickForSwitch(e), true);
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
    routePoints: 'Animation Route Points',
    routeOrder: 'Route Point Order Numbers',
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
    [GROUPS.TRAVERSAL, ['nearestRouting', 'groupByLetter', 'rightwardBias', 'tweenEntryAtEndpoints', 'emitConnectors', 'traversalResampleSpacingPx']],
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
        // Multi-select: comparing how several faces skeletonise is the
        // core activity here, and picking them one at a time made that
        // needlessly slow. Every file in the batch is parsed and kept, so
        // they all appear in the dropdown to switch between.
        input.multiple = true;
        input.addEventListener('change', onFontFileChosen);
        row.appendChild(input);
    });

    // Saved Fonts Presets. A native multi-select: it gives shift-click
    // range selection and ctrl-click for free, and CSS `resize` makes it
    // draggable - a hand-rolled list would have to reimplement both and
    // would get keyboard navigation wrong.
    customRow(content, (row) => {
        const label = document.createElement('span');
        label.className = 'dev-label';
        label.textContent = 'Saved Fonts Presets:';
        const list = document.createElement('select');
        list.multiple = true;
        list.size = 6;
        list.className = 'dev-select lab-preset-list';
        ui.presetList = list;
        row.append(label, list);
        // Populate immediately: refreshPresetList otherwise runs only on
        // a font load, leaving an empty box with no explanation before
        // one is picked.
        refreshPresetList();
    });

    customRow(content, (row) => {
        const mk = (text, fn, title) => {
            const b = document.createElement('button');
            b.textContent = text;
            b.title = title;
            b.addEventListener('click', fn);
            return b;
        };
        row.append(
            mk('Use', () => usePreset(), 'Apply the selected preset'),
            mk('Save', () => savePreset(), 'Save the current settings as a new preset'),
            mk('Rename', () => renameSelectedPreset(), 'Rename the selected preset'),
            mk('Delete', () => deleteSelectedPresets(), 'Delete the selected preset(s)'),
        );
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
        ui.switchOrderBtn = document.createElement('button');
        ui.switchOrderBtn.textContent = 'Switch Point Order';
        // A MODE, not an action: it stays on until clicked again, so a
        // run of swaps does not need the button re-armed each time.
        ui.switchOrderBtn.addEventListener('click', () => {
            setSwitchPointOrderMode(!state.switchPointOrderMode);
        });
        row.appendChild(ui.switchOrderBtn);

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

// syncConfigControlsFromState covers config keys only, which is all the
// delegated listener needs. Applying a whole snapshot also has to push
// view and tween values back into their controls, or the panel would
// show the old numbers while the render used the new ones.
function syncAllControlsFromState() {
    syncConfigControlsFromState(null);
    const push = (id, value) => {
        for (const variant of [id, twinId(id, 'Mobile'), twinId(id, 'Landscape')]) {
            if (!variant) continue;
            const el = document.getElementById(variant);
            if (!el) continue;
            if (el.type === 'checkbox') el.checked = !!value;
            else if (String(el.value) !== String(value)) el.value = value;
        }
    };
    for (const [id, key] of Object.entries(VIEW_BY_CONTROL_ID)) push(id, state.view[key]);
    for (const [id, key] of Object.entries(TWEEN_BY_CONTROL_ID)) push(id, state.tween[key]);
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
        addRow(GROUPS.PATH, {
            id: 'checkboxAdaptiveThickness', type: 'checkbox',
            label: 'Path Adaptive Thickness On/Off', value: state.view.adaptiveThickness,
        }),
        addRow(GROUPS.PATH, {
            id: 'checkboxStrokeRoundCap', type: 'checkbox',
            label: 'Stroke Round Cap On/Off', value: state.view.strokeRoundCap,
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
    checkboxAdaptiveThickness: 'adaptiveThickness',
    checkboxStrokeRoundCap: 'strokeRoundCap',
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
            id: 'sliderTweenJoinProximity', type: 'slider', label: 'Join Proximity (Px)',
            // 0 disables proximity welding entirely. The top of the
            // range is about a Comic Sans stem at the default raster -
            // past that, ends that are genuinely unrelated start getting
            // welded to each other.
            min: 0, max: 30, step: 0.5, value: state.tween.joinProximityPx,
        }),
        addRow(GROUPS.TWEEN, {
            id: 'checkboxTweenLoopSingleCurves', type: 'checkbox',
            label: 'Loop Single Curves On/Off', value: state.tween.loopSingleCurves,
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
    checkboxTweenLoopSingleCurves: 'loopSingleCurves',
    sliderTweenJoinProximity: 'joinProximityPx',
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
    // The renderer needs the RESOLVED choice, not the dropdown: with the
    // tween off, "Tween" falls back to the midline above, and adaptive
    // width would otherwise grow one-sided along a centreline.
    renderer.setAnimationPath(useTween ? 'tween' : 'midline');
    // Midline endpoints (free tips of the skeleton graph) are where a
    // tween LOOP should start, per the entry rule in routing.mjs.
    const midlineEndpoints = (r.vector.nodes || [])
        .filter((n) => n.kind === 'endpoint')
        .map((n) => ({ x: n.xPx, y: n.yPx }));
    // Resolve the stroke order. A manual edit for this exact geometry
    // wins over a learned order: the user is looking at this route right
    // now, and a direct instruction beats a stored one matched by
    // proximity.
    let route = buildRoute(useTween, state.routeOrderOverride, midlineEndpoints, r);
    state.learnedMatch = null;

    // Only single characters are learned. A whole string's stops span
    // several glyphs, and anchors normalised against the whole line
    // would not transfer to that letter on its own - which is the entire
    // point of storing them.
    if (!state.routeOrderOverride && route.stops && state.text && state.text.length === 1) {
        const box = rasterBounds(r);
        const variants = readLearned(state.learnedOrders, state.fontInfo, state.text);
        if (variants && box) {
            // Every order ever taught for this character is considered;
            // the one that explains the most of THIS route wins. A serif
            // variant is therefore still useful on a serif-less run.
            const res = bestLearnedOrder(route.stops, variants, box);
            state.learnedMatch = {
                matched: res.matched, total: res.total,
                variantCount: res.variantCount, chosen: res.chosen,
                chosenAnchorCount: res.chosenAnchorCount,
            };
            if (res.ids && res.matched > 0) {
                // Rebuilt rather than renumbered. Renumbering the labels
                // without re-flattening would show a new order while the
                // animation still walked the old one.
                route = buildRoute(useTween, res.ids, midlineEndpoints, r);
            }
        }
    }

    animator.setRoute(route);
    renderer.setRoute(route);
    // Preserve position proportionally so switching source mid-run does
    // not snap the dot back to the start.
    animator.seekToFraction(fraction);
    renderer.draw();
}

// One route, from either source, with an optional explicit order.
//
// The midline branch re-flattens through the shared flattenOrdered()
// rather than reusing the precomputed traversal.animation, because that
// one was flattened in the traversal's own order and cannot express a
// reorder. With no override it returns the precomputed route untouched,
// so the ordinary path is unchanged.
function buildRoute(useTween, override, midlineEndpoints, r) {
    if (useTween) {
        return tweenAnimationRoute(state.tweenResult, {
            nearestRouting: state.config.nearestRouting,
            entryMode: state.config.tweenEntryAtEndpoints === false ? 'nearest' : 'endpoints',
            loopAnchors: midlineEndpoints,
            rightwardBias: state.config.rightwardBias,
            groupByLetter: state.config.groupByLetter !== false,
            // Tween curves inherit their letter from the skeleton edge
            // they were offset from.
            letterOf: (edgeId) => {
                const seg = r.vector.segments.find((x) => x.id === edgeId);
                return seg ? seg.letterIndex : null;
            },
            orderOverride: override,
        });
    }
    if (!override) return r.traversal.animation;

    // Ids must match traversal.mjs's own stop ids exactly, or an
    // override captured from the drawn stops would match nothing.
    const draws = r.traversal.segments.filter((sg) => sg.kind === 'draw');
    const ordered = draws.map((sg, i) => ({
        id: `seg:${sg.edgeId ?? i}:${i}`,
        runs: [sg.pointsPx],
        edgeId: sg.edgeId ?? null,
        letter: sg.letterIndex ?? null,
    }));
    return flattenOrdered(applyOrderOverride(ordered, override));
}

// ---- Switch Point Order --------------------------------------------

function setSwitchPointOrderMode(on) {
    state.switchPointOrderMode = !!on;
    renderer.setPendingStop(null);
    if (ui.switchOrderBtn) {
        ui.switchOrderBtn.textContent = state.switchPointOrderMode
            ? 'Switch Point Order: ON' : 'Switch Point Order';
        ui.switchOrderBtn.classList.toggle('active', state.switchPointOrderMode);
    }
    // Turning the mode on is useless if the targets are invisible, so it
    // turns their layers on rather than leaving the user to find them.
    if (state.switchPointOrderMode) {
        state.layers.routePoints = true;
        state.layers.routeOrder = true;
        syncLayerCheckboxes();
        renderer.setLayers(state.layers);
    }
    canvas.style.cursor = state.switchPointOrderMode ? 'crosshair' : '';
    setStatus(state.switchPointOrderMode
        ? 'Switch Point Order: click two route points to swap them. Click the button again to exit.'
        : 'Switch Point Order off.');
    renderer.draw();
}

function syncLayerCheckboxes() {
    for (const key of ['routePoints', 'routeOrder']) {
        const el = document.getElementById(controlIdFor('layer' + key.charAt(0).toUpperCase() + key.slice(1), 'checkbox'));
        if (el) el.checked = !!state.layers[key];
    }
}

function onCanvasClickForSwitch(e) {
    if (!state.switchPointOrderMode) return;
    const stops = renderer.stops();
    if (!stops.length) return;

    // Screen -> raster, the inverse of the renderer's own transform.
    const rect = canvas.getBoundingClientRect();
    const sx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const sy = (e.clientY - rect.top) * (canvas.height / rect.height);
    const scale = renderer.view.scale || 1;
    const x = (sx - renderer.view.offsetX) / scale;
    const y = (sy - renderer.view.offsetY) / scale;

    // A fixed SCREEN radius converted to raster units, so the target
    // stays the same size under the cursor at any zoom.
    const hit = stopNearest(stops, x, y, 14 / scale);
    if (!hit) { setStatus('No route point there — click closer to a marker.', 'warn'); return; }

    // The click is ours: stop it reaching the viewport controller, which
    // would otherwise treat it as the start of a pan.
    e.preventDefault();
    e.stopPropagation();

    const pending = renderer.pendingStopId;
    if (!pending) {
        renderer.setPendingStop(hit.id);
        setStatus(`Point ${hit.order} selected — now click the point to swap it with.`);
        renderer.draw();
        return;
    }
    if (String(pending) === String(hit.id)) {
        renderer.setPendingStop(null);
        setStatus('Selection cleared.');
        renderer.draw();
        return;
    }

    const first = stops.find((st) => String(st.id) === String(pending));
    const ids = first ? swapStops(stops, first.order, hit.order) : null;
    renderer.setPendingStop(null);
    if (!ids) { setStatus('Could not swap those two points.', 'warn'); return; }

    state.routeOrderOverride = ids;
    applyAnimationRoute();
    setStatus(`Swapped points ${first.order} and ${hit.order}.`, 'ok');
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
// Bumped alongside the ?v= query on the script tags, so "what build is
// that tab running?" is answerable in one line instead of inferred from
// behaviour.
const BUILD = 21;

const SETTINGS_ENDPOINT = '/api/save-settings';
const FONT_DIR = 'data/processed/fonts/';

// Client half of §12l's shared secret. Same mechanism as every other
// project in this workspace (HANDYSET/src/main.js, HANDY DANDIES/src/
// main.js): a plain constant, filled in by hand, never read from a file
// at runtime.
//
// This is NOT the GitHub token. The token can read and write repositories
// and lives only in Vercel's environment; it never enters this file, never
// reaches the browser, and cannot be extracted from the deployed page.
// This value is a doorbell password for /api/save-settings alone. The
// browser has to send it, so the browser has to know it, so on a public
// repo it is readable by anyone who looks - and the deliberate design
// consequence is that the capability behind it is narrow: it can write to
// one file path in one repository and nothing else. It is not a route to
// the token or to any other repo.
//
// Empty means "no remote writes from this build", which is a supported
// mode, not a failure: Save falls back to localStorage and everything
// else works. A save attempted with the wrong value returns 401.
const DEV_PANEL_SAVE_SECRET = 'PkrbMti03M6xm3FEThYXa8gGW_08BOGj';

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
//
// SERIALISED through one queue, ported from LENTICULOSO/src/main.js,
// which documents the failure this prevents: two overlapping GET->POST
// cycles each merge onto the same stale GET, so the later POST silently
// drops the earlier one's key. This document now has five independent
// top-level fields - importedFonts, learnedOrders, fontSettings,
// devPanel, lastSaveStamp - written from more than one path, so the
// window for that is real rather than theoretical. Queueing makes a
// second Sync wait for the first instead of racing it.
let remoteQueue = Promise.resolve();

function remoteSave(args) {
    const run = () => remoteSaveNow(args);
    const p = remoteQueue.then(run, run);
    // The queue must survive a rejection, or one failed save would wedge
    // every later one behind a permanently rejected promise.
    remoteQueue = p.catch(() => ({ ok: false }));
    return p;
}

// Turn a failed save into something actionable.
//
// The old message was "remote save unavailable (no endpoint)", which
// named neither the status nor the URL and so could not distinguish a
// missing function from a rejected key from an unreachable host. That
// vagueness cost real time: a reported "no endpoint" was read as a stale
// build, when a stale build would in fact have produced "(Unauthorized)"
// - the server answers a missing key with a 401 AND a JSON body, so
// res.error would have been set. "no endpoint" specifically means the
// response carried NO parseable JSON error, which on this host is a 404
// (Vercel serves text/plain for an unknown path, so resp.json() throws
// and data ends up {}).
function describeSaveFailure(res) {
    const where = `${location.origin}${SETTINGS_ENDPOINT}`;
    if (res.status === 404) {
        return `${where} returned 404 - there is no save endpoint at this origin. `
            + 'A Vercel deployment serves it from api/save-settings.js; a plain static server does not.';
    }
    if (res.status === 0) {
        return `could not reach ${where} at all (${res.error || 'network error'}).`;
    }
    return `${where} returned HTTP ${res.status}${res.error ? ` - ${res.error}` : ' with no error message'}.`;
}

async function remoteSaveNow({ patch = {}, files = [] } = {}) {
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
        return {
            ok: resp.ok && data.ok !== false,
            status: resp.status,
            sentSecret: !!DEV_PANEL_SAVE_SECRET,
            error: data.error,
            written: data.written || [],
        };
    } catch (e) {
        return { ok: false, status: 0, sentSecret: !!DEV_PANEL_SAVE_SECRET, error: String((e && e.message) || e), written: [] };
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

    // Learn the order currently on screen for this font+character before
    // writing. Stored as normalised anchors, not ids - see routeOrder.mjs.
    const stops = renderer.stops();
    if (stops.length && state.text && state.text.length === 1 && state.result && state.result.ok) {
        const box = rasterBounds(state.result);
        const anchors = toLearnedOrder(stops, box);
        if (anchors) state.learnedOrders = writeLearned(state.learnedOrders, state.fontInfo, state.text, anchors);
    }

    // A unique stamp per save attempt. This is what makes a lost
    // response distinguishable from a failed write: if the document
    // comes back carrying this exact value, the commit happened no
    // matter what the POST appeared to do.
    const saveStamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    // Bank the live font's settings first, so Sync stores what is on
    // screen rather than whatever was last banked at a font switch.
    bankCurrentFontSettings();

    const patch = {
        importedFonts: manifest,
        learnedOrders: state.learnedOrders,
        fontSettings: state.fontSettings,
        lastSaveStamp: saveStamp,
    };
    if (typeof window.captureFullDevPanelState === 'function') {
        patch.devPanel = window.captureFullDevPanelState();
    }

    setStatus(pending.length ? `Saving ${pending.length} font(s) + settings…` : 'Saving settings…');
    const res = await remoteSave({ patch, files });
    if (!res.ok) {
        // A POST can COMMIT and still report failure: the write reaches
        // GitHub, then the response is lost to a dropped connection or a
        // serverless timeout, and remoteSave's catch reports an error for
        // a save that actually succeeded. Reported as a plain failure
        // that was exactly the false negative behind "it said saved
        // locally but it did save".
        //
        // So an apparent failure is checked, not believed: re-read the
        // document and look for this attempt's own stamp.
        const after = await remoteGetSettings();
        if (after && after.lastSaveStamp === saveStamp) {
            for (const f of pending) markSaved(f.key, FONT_DIR + f.fileName);
            refreshFontList();
            setStatus('Saved to the repo — the confirmation was lost in transit, but the write landed.', 'ok');
            return;
        }
        // Not a bare transport error: on the local dev server the cause
        // is always the same missing environment variable, and "Failed to
        // fetch" sends the reader hunting for a bug that is not there.
        // localStorage already holds the panel state either way, so
        // nothing was lost.
        // A 401 means the SERVER has a save key and this page did not
        // send a matching one. When the page sent NONE at all, it is
        // running a build from before the key was added - almost always
        // a tab left open across a deploy, since the page itself is
        // never re-fetched until it is reloaded.
        //
        // Worth singling out because the generic fallback below reads as
        // success: settings still persist to localStorage, so the only
        // visible symptom is that imported FONTS vanish on reload, fonts
        // being the one thing localStorage deliberately does not hold.
        // That is a long way from "your tab is out of date".
        if (res.status === 401 && !res.sentSecret) {
            setStatus('Saved to localStorage only. This tab is running an older build of the page with no save key, '
                + 'so the repo rejected the write. Hard-reload (Ctrl+Shift+R / Cmd+Shift+R) and Sync again.', 'error');
            return;
        }
        if (res.status === 401) {
            setStatus('Saved to localStorage only. The repo rejected the save key this page sent (401). '
                + 'It no longer matches DEV_PANEL_SAVE_SECRET on the server.', 'error');
            return;
        }

        const onLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === 'file:';
        setStatus(onLocal
            ? `Saved to localStorage. The local dev server cannot commit to the repo — it needs GITHUB_TOKEN in its own environment. Restart it with that variable set, or use the deployed site. (${res.error || 'no endpoint'})`
            : `Saved to localStorage only. The repo save failed: ${describeSaveFailure(res)}`, 'error');
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
    // Learned stroke orders ride along with the same document. Restored
    // before the fonts, so the first pipeline run after a font loads can
    // already apply them.
    if (settings && settings.learnedOrders && typeof settings.learnedOrders === 'object') {
        state.learnedOrders = { ...state.learnedOrders, ...settings.learnedOrders };
    }
    if (settings && settings.fontSettings && typeof settings.fontSettings === 'object') {
        state.fontSettings = { ...state.fontSettings, ...settings.fontSettings };
        refreshPresetList();
    }
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
    renderer.trailRuns = frame.trailRuns || null;
    if (ui.scrub) ui.scrub.value = String(Math.round(frame.fraction * 1000));
    if (ui.animInfo) {
        ui.animInfo.textContent =
            `${frame.distance.toFixed(0)} / ${animator.totalLength.toFixed(0)} px · `
            + `${(frame.fraction * 100).toFixed(1)}% · on: ${frame.kind}`
            + (frame.edgeId != null ? ` (edge ${frame.edgeId})` : '');
    }
    renderer.draw();
}

// Accepts a BATCH. One bad file does not abort the rest: a folder of
// fonts routinely contains something opentype.js will not parse, and
// losing the other nine to it would be the wrong trade. Failures are
// collected and reported by name at the end.
//
// The FIRST file that parses becomes the active one, not the last:
// selection order in the dialog is what the user just expressed, and
// ending up on whichever font happened to sort last is surprising. The
// rest are kept in the store and reachable from the dropdown.
async function onFontFileChosen(e) {
    const files = [...(e.target.files || [])];
    if (!files.length) return;

    const failures = [];
    let adopted = null;
    let loaded = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setStatus(files.length > 1
            ? `Parsing ${i + 1} of ${files.length}: ${file.name}…`
            : 'Parsing font…');
        try {
            const buf = await file.arrayBuffer();
            const { font, info } = await loadFontFromFile(file);
            // Only remembered once it has actually PARSED. Storing bytes
            // first would put a file that cannot be read into the store
            // and, from there, into a Sync commit.
            rememberFont(file.name, buf);
            loaded++;
            if (!adopted) {
                adoptFont(font, info);
                adopted = file.name;
            }
        } catch (err) {
            failures.push(`${file.name}: ${(err && err.message) || err}`);
        }
    }

    refreshFontList();

    if (!loaded) {
        state.font = null;
        if (ui.fontName) { ui.fontName.textContent = 'load failed'; ui.fontName.className = 'lab-status error'; }
        setStatus(failures.length === 1 ? failures[0] : `No fonts could be parsed — ${failures.join('; ')}`, 'error');
        return;
    }

    if (failures.length) {
        setStatus(`Loaded ${loaded} of ${files.length} — showing ${adopted}. Failed: ${failures.join('; ')}`, 'warn');
    } else if (loaded > 1) {
        setStatus(`Loaded ${loaded} fonts — showing ${adopted}; the rest are in the dropdown.`);
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
    // Bank the OUTGOING font's settings before anything changes, so
    // switching away and back returns you to where you were. Done here
    // rather than on every edit: capturing on each slider tick would
    // write constantly for no benefit, and the only moment the value is
    // actually needed is the moment it is about to be replaced.
    bankCurrentFontSettings();

    state.font = font;
    state.fontInfo = info;
    state.activeFontKey = fontKeyOf(info);

    // Restore this font's own settings, if it has any. A font seen for
    // the first time keeps whatever is on screen, which then becomes its
    // memory - a sane starting point rather than a reset to defaults.
    const entry = readEntry(state.fontSettings, info);
    if (entry.memory) {
        applySettings(state, entry.memory);
        syncAllControlsFromState();
        renderer.setViewSettings(state.view);
    }
    refreshPresetList();

    if (ui.fontName) {
        ui.fontName.textContent = `${info.fullName} · ${info.unitsPerEm} upm · ${info.numGlyphs} glyphs · ${info.outlinesFormat}`;
        ui.fontName.className = 'lab-status ok';
    }
    rerun();
}

function fontKeyOf(info) {
    return (info && (info.postScriptName || info.fullName || info.sourceName)) || null;
}

function bankCurrentFontSettings() {
    if (!state.fontInfo || !state.activeFontKey) return;
    state.fontSettings = writeMemory(state.fontSettings, state.fontInfo, captureSettings(state));
}

// ---- Font presets ---------------------------------------------------

function selectedPresetNames() {
    const list = ui.presetList;
    if (!list) return [];
    return [...list.selectedOptions].map((o) => o.value);
}

function refreshPresetList() {
    const list = ui.presetList;
    if (!list) return;
    const keep = new Set(selectedPresetNames());
    const presets = state.fontInfo ? listPresets(state.fontSettings, state.fontInfo) : [];
    list.innerHTML = '';
    for (const p of presets) {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        if (keep.has(p.name)) opt.selected = true;
        list.appendChild(opt);
    }
    if (!presets.length) {
        const opt = document.createElement('option');
        opt.disabled = true;
        opt.textContent = state.fontInfo ? 'no presets for this font yet' : 'load a font first';
        list.appendChild(opt);
    }
}

function usePreset() {
    const names = selectedPresetNames();
    if (names.length !== 1) {
        setStatus('Select exactly one preset to use.', 'warn');
        return;
    }
    const preset = listPresets(state.fontSettings, state.fontInfo).find((p) => p.name === names[0]);
    if (!preset) { setStatus('That preset no longer exists.', 'warn'); return; }
    applySettings(state, preset.settings);
    syncAllControlsFromState();
    renderer.setViewSettings(state.view);
    bankCurrentFontSettings();
    rerun();
    setStatus(`Using preset "${preset.name}".`, 'ok');
}

function savePreset() {
    if (!state.fontInfo) { setStatus('Load a font before saving a preset.', 'warn'); return; }
    const existing = listPresets(state.fontSettings, state.fontInfo).map((p) => p.name);
    // Default offered from the last preset SAVED, per the naming rule;
    // falling back to the last in this font's list when this is a fresh
    // session and nothing has been saved yet.
    const seed = state.lastPresetName || existing[existing.length - 1] || '';
    const suggested = uniqueName(existing, nextPresetName(seed));
    const name = window.prompt('Name this preset:', suggested);
    if (name === null) return;             // cancelled
    const finalName = uniqueName(existing, name);
    state.fontSettings = addPreset(state.fontSettings, state.fontInfo, finalName, captureSettings(state));
    state.lastPresetName = finalName;
    refreshPresetList();
    setStatus(`Saved preset "${finalName}".`, 'ok');
}

function renameSelectedPreset() {
    const names = selectedPresetNames();
    if (names.length !== 1) { setStatus('Select exactly one preset to rename.', 'warn'); return; }
    const existing = listPresets(state.fontSettings, state.fontInfo).map((p) => p.name);
    const name = window.prompt('Rename preset:', names[0]);
    if (name === null) return;
    const trimmed = String(name).trim();
    if (!trimmed || trimmed === names[0]) return;
    // Uniqueness is checked against the OTHER names, so renaming a
    // preset to something it already nearly was does not get a number
    // appended because of a clash with itself.
    const finalName = uniqueName(existing.filter((n) => n !== names[0]), trimmed);
    state.fontSettings = renamePreset(state.fontSettings, state.fontInfo, names[0], finalName);
    if (state.lastPresetName === names[0]) state.lastPresetName = finalName;
    refreshPresetList();
    setStatus(`Renamed to "${finalName}".`, 'ok');
}

function deleteSelectedPresets() {
    const names = selectedPresetNames();
    if (!names.length) { setStatus('Select one or more presets to delete.', 'warn'); return; }
    if (!window.confirm(`Delete ${names.length} preset(s)?\n\n${names.join('\n')}`)) return;
    state.fontSettings = deletePresets(state.fontSettings, state.fontInfo, names);
    refreshPresetList();
    setStatus(`Deleted ${names.length} preset(s).`, 'ok');
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
                // EACH ENTRY IS PROBED before being offered. The manifest
                // is tracked in git but the font binaries are not, so on
                // a deployment every one of them 404s. Listing fonts that
                // cannot load is worse than listing none: the picker
                // looks functional and then fails on selection, which
                // reads as a broken app rather than as absent files.
                const probes = await Promise.all((data.fonts || []).map(async (f) => {
                    const url = 'test-fonts/' + f.file;
                    try {
                        const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
                        return head.ok ? { url, label: f.label } : null;
                    } catch {
                        return null;
                    }
                }));
                for (const hit of probes.filter(Boolean)) add('test-fonts', hit.url, hit.label);
                discovered = probes.some(Boolean);
            }
        } catch { /* nothing to fall back to */ }
    }

    if (!discovered) {
        // Not an error: font binaries are intentionally not committed
        // (licensing + repo weight), so a deployment legitimately has
        // none. Say what to do instead of just going blank.
        placeholder.textContent = 'no bundled fonts — use “Load .ttf / .otf” above';
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
window.fontLab = {
    build: BUILD,
    hasSaveSecret: () => !!DEV_PANEL_SAVE_SECRET, state, renderer, animator, viewport, rerun, runPipeline, toDebugJSON, loadFontFromUrl };
