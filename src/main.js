// ====================================================================
// FONTSO — src/main.js
// ====================================================================
// The HOST half of this project (docs/ENGINE_API.md's Host<->Engine
// split): it owns the DOM, owns non-layout styling, owns application
// behaviour, and calls into the UI Layout Engine only for position/size/
// constraints/responsive overrides. It also owns every dev-panel setting
// this project adds — src/devpanel/devPanel.js is a verbatim copy of the
// shared engine (.claude/TEMPLATE_DEV_PANEL.html) and must stay that way.
//
// This file is a MODULE, and deliberately runs BEFORE devPanel.js — see
// index.html's <head> comment for the exact ordering contract.
//
// Structure:
//   1. Engine imports + tokens
//   2. Element registration      (§13 — layout intent lives in
//                                data/processed/ui-layout-config.json)
//   3. Active-context + resize wiring
//   4. Dev panel groups          (§12 — window.renderFontsoDevGroups,
//                                called from devPanel.js's splice point)
//   5. Persistence               (§12l — localStorage by default, with an
//                                optional git-tracked write-through)
// ====================================================================

// ---- 1. Engine imports ---------------------------------------------
// JSON import attributes (`with { type: 'json' }`) are what the engine's
// own canonical reference integration uses (HTML UI ENGINE/demo/main.mjs)
// — kept identical here on purpose. They need a reasonably current browser
// and a server that sends `application/json`; scripts/active/serve.py does.
import {
    createUIElement,
    setTokens,
    resolveAndApplyAll,
    registerStorageBackend,
    setActiveContextOverride,
    captureAllLayoutConfigs,
    resetLayoutConfig,
    loadLayoutConfig,
} from '../lib/ui-engine/registry.mjs';
import { watchBreakpointChanges } from '../lib/ui-engine/engine.mjs';
import { mountInspector, refreshInspector } from '../lib/ui-engine/inspector.mjs';
import tokens from '../lib/ui-engine/tokens.json' with { type: 'json' };
import uiLayoutConfig from '../data/processed/ui-layout-config.json' with { type: 'json' };

setTokens(tokens);

// Bump this whenever a dev-panel GROUP or ROW changes structurally (a
// rename, split, merge, or id change). A stale localStorage save otherwise
// restores the OLD layout on top of the new one — applySectionOrder()
// APPENDS an unmatched old group rather than replacing it, producing
// literal duplicate groups and rows with dead ids. (Learned the hard way
// on a sibling project; see docs/CODE_SUMMARY.txt.)
const FONTSO_SETTINGS_SCHEMA_VERSION = 1;

// ---- 2. Element registration ---------------------------------------
// One createUIElement() call per managed element, id matching
// ui-layout-config.json's own keys 1:1. The host builds the DOM (here:
// index.html already did); the engine never creates or moves a node.
function registerUIElement(id, role, domNode) {
    const entry = uiLayoutConfig[id];
    if (!entry) {
        console.error('registerUIElement: no layout config for "' + id + '" in data/processed/ui-layout-config.json');
        return;
    }
    createUIElement({
        id,
        role,
        layout: entry.layout,
        contexts: entry.contexts,
        domNode,
        // Optional presentation metadata (engine v0.2.5) — makes the
        // Inspector's element picker a 2-level Object -> Property cascade
        // instead of one flat list. Never read by resolution.
        group: entry.group,
        propertyLabel: entry.propertyLabel,
    });
}

registerUIElement('appStage', 'container', document.getElementById('appStage'));

// ---- 3. Active context + resize ------------------------------------
// The engine's own getActiveBreakpoint() uses matchMedia; the dev panel
// uses the Desktop/Mobile/Landscape rule every project in this workspace
// shares. Left to themselves the two can disagree about which context is
// active for the same viewport (the exact mismatch DEV_PANEL_ADAPTER.md
// §13.1 documents), so the host pushes ITS determination into the engine
// via setActiveContextOverride() and the two can never drift apart.
function detectDeviceTab() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (Math.min(w, h) >= 768) return 'desktop';
    return w > h ? 'landscape' : 'mobile';
}
const ENGINE_CONTEXT_BY_TAB = {
    desktop: 'base',
    mobile: 'mobilePortrait',
    landscape: 'mobileLandscape',
};
let activeDeviceTab = null;
function syncActiveContext() {
    const tab = detectDeviceTab();
    if (tab === activeDeviceTab) return;
    activeDeviceTab = tab;
    // setActiveContextOverride() re-resolves every element itself.
    setActiveContextOverride(ENGINE_CONTEXT_BY_TAB[tab]);
}
syncActiveContext();

// Both mechanisms, deliberately — copied from the engine's own reference
// integration, which documents why (matchMedia 'change' is the precise
// boundary signal; a plain 'resize' covers paths where it doesn't fire).
watchBreakpointChanges(() => { syncActiveContext(); resolveAndApplyAll(); refreshInspector(); });
window.addEventListener('resize', () => { syncActiveContext(); resolveAndApplyAll(); refreshInspector(); });

// ---- 4. Dev panel groups -------------------------------------------
// Every control this project adds goes through addRow(), which exists to
// close two silent-failure traps documented in the shared template:
//   * ctrl.tab MUST be 'desktop' on a Desktop control, or
//     buildUniformControlRow() attaches the WRONG per-row device checkbox
//     ("Independent from Desktop" instead of "Show in Mobile/Landscape").
//   * every control MUST reach registerDevControlArray(), or
//     ensureDynamicTargetRow() cannot find it and the "Show in Mobile/
//     Landscape" checkbox silently does nothing at all — no error, no
//     warning. Collecting here means the first control added is registered
//     automatically instead of relying on anyone remembering.
const FONTSO_CONTROLS = [];
function addRow(group, ctrl) {
    ctrl.group = group;
    ctrl.tab = 'desktop';
    FONTSO_CONTROLS.push(ctrl);
    return ctrl;
}
// Exposed so a feature module added later can reach it without this file
// having to grow every control declaration itself.
window.fontsoAddDevRow = addRow;

// PROJECT: add a render<Feature>Group() function per feature, following
// global CLAUDE.md §12n (decompose — one named control per real value;
// units inline in the label; timings in raw ms; no bundled "transform" or
// "speed" dials) and §12p (any text element gets the full 13-control
// Standard Text Settings battery, via the template's own
// buildStandardTextSettingsControls()). Each one:
//   1. the state it drives,
//   2. a group created with createDevGroupElement(name, 'desktop') and
//      appended to #desktopTabContent,
//   3. its controls declared via addRow(name, {...}),
//   4. an 'input'/'change' listener per control that applies the value.
// There are none yet — this is a fresh scaffold with no features.

// The UI Layout Engine's Inspector, as a PANEL-LEVEL collapsible group.
//
// Why panel-level rather than one group per Desktop/Mobile/Landscape tab:
// the Inspector carries its OWN Base / Mobile Portrait / Mobile Landscape
// context tabs, so one instance already covers all three — the identical
// situation as "Saved Dev Settings" (§12d), which is panel-level for
// exactly this reason. It also sidesteps the shared engine's cross-tab
// mirroring, which can only mirror REGISTERED control rows: a mirrored
// copy of a hand-built widget like this one is always an empty shell (the
// same reason "Mouse Log" is excluded from mirroring by name). Living
// outside the three tab-content roots means the drag-reorder, drag-handle-
// injection and cascade-checkbox passes all skip it automatically, since
// every one of them is scoped to search inside those roots.
function buildUILayoutInspectorGroup() {
    if (document.getElementById('uiLayoutInspectorBody')) return;
    const savedStatesSelect = document.getElementById('devSavedStatesSelect');
    const savedStatesSection = savedStatesSelect ? savedStatesSelect.closest('.dev-section') : null;
    if (!savedStatesSection || !savedStatesSection.parentElement) {
        console.error('buildUILayoutInspectorGroup: could not find the "Saved Dev Settings" section to anchor to.');
        return;
    }

    const section = document.createElement('div');
    section.className = 'dev-section';
    const title = document.createElement('div');
    title.className = 'dev-section-title';
    title.setAttribute('onclick', 'toggleSection(this)');
    title.textContent = '▼ UI Layout';
    const content = document.createElement('div');
    content.className = 'dev-section-content';
    const body = document.createElement('div');
    body.id = 'uiLayoutInspectorBody';
    content.appendChild(body);
    section.append(title, content);
    savedStatesSection.parentElement.insertBefore(section, savedStatesSection.nextSibling);

    mountInspector(body);
}

// Called by devPanel.js at the template's documented splice point inside
// ensureDevPanelBuilt() — the single line that copy differs by. Defined on
// window because devPanel.js is a classic script and this file is a module
// (a module's top-level declarations never reach global scope).
window.renderFontsoDevGroups = function renderFontsoDevGroups() {
    // PROJECT: call each render<Feature>Group() here, before the two calls
    // below — the same ordering the template requires of its own calls.
    if (FONTSO_CONTROLS.length && typeof window.renderControlArray === 'function') {
        window.renderControlArray(FONTSO_CONTROLS, 'renderFontsoDevGroups');
    }
    if (typeof window.registerDevControlArray === 'function') {
        window.registerDevControlArray('FONTSO_CONTROLS', FONTSO_CONTROLS);
    }
    buildUILayoutInspectorGroup();
};

// ---- 5. Persistence -------------------------------------------------
// §12l: localStorage is the working default and needs nothing here. This
// block adds the OPTIONAL git-tracked write-through on top, so a setting
// saved from a phone is visible to a desktop session in the same repo.
// It degrades to localStorage automatically and silently whenever the
// endpoint is not there (file://, a plain static server, an unconfigured
// deployment) — which is the normal local-development case.
const SETTINGS_ENDPOINT = '/api/save-settings';
// Client-side half of §12l's DEV_PANEL_SAVE_SECRET. Deliberately empty in
// the repo: fill it in per-deployment (or leave it empty to run
// localStorage-only). The endpoint rejects a POST whose header does not
// match the server-side value, so an empty string here simply means "no
// remote saves from this build."
const DEV_PANEL_SAVE_SECRET = '';

async function remoteGetSettings() {
    try {
        const resp = await fetch(SETTINGS_ENDPOINT, { cache: 'no-store' });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data && data.ok ? data.settings : null;
    } catch {
        return null; // no endpoint behind this page — localStorage stands.
    }
}

// GET-merge-POST, never a blind POST.
//
// This is not defensive politeness: a blind overwrite of the whole file
// with one writer's snapshot silently erases every OTHER top-level field
// in it. The engine's layout config and the dev panel's own state are two
// such fields already, written by two different code paths — a blind POST
// from either one would wipe the other. Any future top-level field added
// to this JSON needs the same discipline, everywhere it is written.
async function remotePutSettings(patch) {
    if (!DEV_PANEL_SAVE_SECRET) return false;
    try {
        const current = (await remoteGetSettings()) || {};
        const merged = { ...current, ...patch };
        const resp = await fetch(SETTINGS_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-dev-panel-secret': DEV_PANEL_SAVE_SECRET },
            body: JSON.stringify(merged),
        });
        return resp.ok;
    } catch {
        return false;
    }
}

// The engine's own two-tier persistence (ENGINE_API.md -> Persistence):
// registerStorageBackend() swaps localStorage for a host backend. This one
// writes to the SAME settings file as the dev panel, under its own
// top-level key, so the project has one source of truth rather than two.
// load() stays synchronous because the engine's contract is synchronous —
// it returns the copy cached by the startup fetch below, and falls back to
// localStorage until (and if) that arrives.
const UI_LAYOUT_STORAGE_KEY = 'fontso.uiLayoutConfig';
let remoteUILayoutCache = null;
registerStorageBackend({
    save(configs) {
        try { localStorage.setItem(UI_LAYOUT_STORAGE_KEY, JSON.stringify(configs)); } catch { /* private mode, quota */ }
        remoteUILayoutCache = configs;
        remotePutSettings({ uiLayoutConfig: configs });
        return true;
    },
    load() {
        if (remoteUILayoutCache) return remoteUILayoutCache;
        try {
            const raw = localStorage.getItem(UI_LAYOUT_STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    },
});

// The shipped config, captured immediately after registration — this is
// what Reset restores to (ENGINE_API.md: "back to the shipped config, not
// back to the last save").
const SHIPPED_UI_LAYOUT = captureAllLayoutConfigs();
window.resetFontsoUILayout = () => { resetLayoutConfig(SHIPPED_UI_LAYOUT); refreshInspector(); };

// Everything below needs devPanel.js's globals, which exist only after it
// has run. 'load' fires after every deferred script, so no polling.
window.addEventListener('load', () => {
    // Clear a settings save written against an older group/row structure —
    // see FONTSO_SETTINGS_SCHEMA_VERSION's own comment.
    try {
        const seen = localStorage.getItem('fontso.settingsSchemaVersion');
        if (seen !== String(FONTSO_SETTINGS_SCHEMA_VERSION)) {
            localStorage.removeItem('devPanelSettings');
            localStorage.setItem('fontso.settingsSchemaVersion', String(FONTSO_SETTINGS_SCHEMA_VERSION));
        }
    } catch { /* private mode */ }

    // Write-through on Sync. Extra listeners on the EXISTING buttons rather
    // than edits inside devPanel.js — that copy stays verbatim, and the
    // template's own saveDevPanelSettings() (localStorage) still runs first,
    // so a failed remote save can never cost a local one.
    const syncButtons = [
        document.getElementById('devHeaderSyncBtn'),
        ...Array.from(document.querySelectorAll('.dev-buttons button'))
            .filter(b => (b.getAttribute('onclick') || '').includes('saveDevPanelSettings')),
    ].filter(Boolean);
    syncButtons.forEach(btn => btn.addEventListener('click', () => {
        if (typeof window.captureFullDevPanelState === 'function') {
            remotePutSettings({ devPanel: window.captureFullDevPanelState() });
        }
    }));

    // Startup load: remote wins over localStorage when it is actually there.
    remoteGetSettings().then(settings => {
        if (!settings) return;
        if (settings.uiLayoutConfig) {
            remoteUILayoutCache = settings.uiLayoutConfig;
            loadLayoutConfig();
            refreshInspector();
        }
        if (settings.devPanel && typeof window.applyFullDevPanelState === 'function') {
            window.applyFullDevPanelState(settings.devPanel);
        }
    });
});
