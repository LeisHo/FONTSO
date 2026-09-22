// ui-layout-engine v0.2.0 — canonical source: J:\CLAUDE\PROJECTS\HTML UI ENGINE\registry.mjs
//
// Registry — the runtime map of elementId -> { domNode, role, layout, contexts }.
// Owns element registration, live updates, the responsive-context model
// (inheritance, sparse overrides, override lifecycle, enable/disable),
// presets, and persistence.
//
// Host/Engine boundary (see docs/ENGINE_API.md): the HOST owns the DOM — it
// creates each domNode and passes it in. This registry never creates,
// removes, or reparents DOM nodes; it only reads/writes layout config and
// applies resolved CSS to nodes the host already built. See
// engine.mjs's assertDomStructure() for how a DOM/config mismatch is
// surfaced (a validation error) rather than silently resolved either way.
//
// v0.2.0 — the responsive-context rewrite (docs/DEV_PANEL_ADAPTER.md):
//   - `entry.responsive` (nested per-breakpoint config, deep-merged at
//     resolve time) is replaced by `entry.contexts` — one entry per
//     responsive context (RESPONSIVE_CONTEXTS below), each holding a FLAT
//     { fieldKey: value } override map plus an `enabled` flag.
//   - This is what makes real inheritance possible: "is field X overridden
//     in context Y" is now a direct `fieldKey in contexts[Y].overrides`
//     check, not an implicit deep-object-shape inference. See
//     getEffectiveValue()/createOverride()/removeOverride() below.
//   - 'narrow'/'landscape' were renamed to 'mobilePortrait'/'mobileLandscape'
//     — see engine.mjs's BREAKPOINTS comment for why this was a clean
//     rename, not a compatibility shim.
//
// v0.2.1 — multi-project generalization (docs/PROJECT_COMPATIBILITY_ANALYSIS.md):
// investigating Clicko/Hando/HandyDandies/DotFlicko as real integration
// cases (not just Clicko) surfaced two genuine, evidence-based
// generalizations, both applied below:
//   1. `domNode` is now OPTIONAL. HandyDandies' and Hando's dev panels wire
//      controls DIRECTLY to imperative state (three.js object mutation),
//      never touching CSS/DOM at all except for their own panel chrome —
//      confirmed by reading their actual `onChange` callbacks. Forcing a
//      domNode requirement on every registered element assumed every host
//      consumes resolved values as CSS, which is false for a real,
//      already-investigated host. An element registered without a domNode
//      still gets the full canonical schema / responsive-context /
//      inheritance / override-lifecycle system — it just never runs
//      DOM-touching steps (assertDomStructure, applyToDOM, the viewport
//      constraint) — a host reads effective values via the adapter and
//      wires them into its own consumption path itself, the exact same way
//      HandyDandies' own `onChange` callbacks already do for its own state.
//   2. A host can PUSH its own active-context determination
//      (`setActiveContextOverride`) instead of always relying on the
//      engine's built-in `matchMedia`-based detection. Hando's own device
//      detection (`Math.min(w,h) >= 768`) is genuinely different logic from
//      this engine's — a host is not required to adopt the engine's
//      specific breakpoint queries just to use its responsive-context
//      system.

import {
  resolveElementLayout, applyToDOM, getActiveBreakpoint, assertDomStructure,
  decomposeAnchorPoint, relativeAnchorGapSign,
  resolveLengthValue, isPerAxisGap,
} from './engine.mjs';
import { validateConfig } from './validate.mjs';
import { POSITION_MODES, SIZE_MODES } from './schema.mjs';
import { readFieldValue, writeFieldValue } from './fieldAccess.mjs';

const ALL_MODE_CLASSES = POSITION_MODES.map((m) => 'ui-mode-' + m);
const ALL_SIZE_CLASSES = [
  ...SIZE_MODES.map((m) => 'ui-size-w-' + m),
  ...SIZE_MODES.map((m) => 'ui-size-h-' + m),
];

// The 3 public responsive contexts. 'base' is always implicitly present and
// always enabled — it is the element's own `layout`, not a `contexts` entry
// — RESPONSIVE_CONTEXTS lists only the OVERRIDE-capable contexts.
export const RESPONSIVE_CONTEXTS = ['mobilePortrait', 'mobileLandscape'];

const elements = new Map(); // id -> { domNode, role, layout, contexts }
let tokens = {};
let storageBackend = null; // { save(state), load() } — see registerStorageBackend()

function emptyContexts() {
  const out = {};
  for (const ctx of RESPONSIVE_CONTEXTS) out[ctx] = { enabled: true, overrides: {} };
  return out;
}

// ============================================================
// Element registration — host provides id/role/layout/domNode, optionally
// seeding initial `contexts` state ({ mobilePortrait: { enabled?, overrides? }, ... }).
//
// v0.2.5 — `group`/`propertyLabel` (both optional, both purely PRESENTATION
// metadata — never read by engine.mjs/resolveAndApply, never affect
// resolution) let a host that registers several separate engine elements
// for what's conceptually ONE object (e.g. "Target Number" needing its own
// position element AND its own font-size-as-a-relative-length element)
// tell the Inspector they're related, instead of the flat element list
// being the only way a host can group its own elements. Grounded in a real
// host need (Clicko: exactly this "one object, several registered
// elements" shape, worked around today with a hand-maintained host-side
// lookup table) — see inspector.mjs's buildElementSelect() for the
// resulting 2-level cascade, and CHANGELOG.md's v0.2.5 entry for why this
// is registration metadata (engine-owned, generic) rather than a host-side
// table (duplicated, hand-maintained, per-host).
// ============================================================
export function createUIElement({ id, role, layout, contexts, domNode, group, propertyLabel }) {
  if (!id) throw new Error('createUIElement: "id" is required.');
  if (!role) throw new Error('createUIElement: "role" is required.');
  if (!layout || !layout.position || !layout.position.mode) {
    throw new Error('createUIElement("' + id + '"): layout.position.mode is required.');
  }
  // domNode is OPTIONAL as of v0.2.1 — see this file's own header comment.
  // A host managing values it never resolves to CSS (e.g. a three.js scene
  // parameter, matching HandyDandies'/Hando's real onChange-callback
  // pattern) registers without one and reads effective values via the
  // adapter instead.
  if (elements.has(id)) throw new Error('createUIElement: an element with id "' + id + '" is already registered.');

  const errors = validateConfig(layout);
  if (errors.length) {
    throw new Error('createUIElement("' + id + '"): invalid layout config:\n  - ' + errors.join('\n  - '));
  }

  const initialContexts = emptyContexts();
  for (const ctx of RESPONSIVE_CONTEXTS) {
    if (contexts && contexts[ctx]) {
      initialContexts[ctx] = {
        enabled: contexts[ctx].enabled !== undefined ? contexts[ctx].enabled : true,
        overrides: { ...(contexts[ctx].overrides || {}) },
      };
    }
  }

  elements.set(id, { domNode: domNode || null, role, layout, contexts: initialContexts, group: group || null, propertyLabel: propertyLabel || null });
  if (domNode) domNode.setAttribute('data-ui-id', id);
  resolveAndApply(id);
  return getElement(id);
}

// ============================================================
// updateElement — deep-merges a partial patch into an element's BASE layout
// config only (used by the Inspector, presets, and direct config edits
// alike), re-validates, re-resolves, re-applies. Never mutates DOM
// structure. To edit a RESPONSIVE CONTEXT's value, use setContextValue()
// below, not this function — v0.2.0 removed updateElement's old
// `patch.responsive` path along with the nested-responsive-config model it
// belonged to.
// ============================================================
export function updateElement(id, patch) {
  const entry = elements.get(id);
  if (!entry) throw new Error('updateElement: no element registered with id "' + id + '".');
  const nextLayout = deepMergePlain(entry.layout, patch.layout || patch);

  const errors = validateConfig(nextLayout);
  if (errors.length) {
    throw new Error('updateElement("' + id + '"): patch would produce an invalid config:\n  - ' + errors.join('\n  - '));
  }

  entry.layout = nextLayout;
  resolveAndApply(id);
  return getElement(id);
}

// ============================================================
// replaceLayoutNode — a WHOLESALE replace at a given key path within an
// element's BASE layout, as opposed to updateElement()'s deep MERGE.
// Required specifically for switching position.mode or a size axis's mode —
// see this function's own original comment (unchanged from v0.1.0) for the
// real bug this fixes.
// ============================================================
export function replaceLayoutNode(id, keyPath, value) {
  const entry = elements.get(id);
  if (!entry) throw new Error('replaceLayoutNode: no element registered with id "' + id + '".');
  const nextLayout = JSON.parse(JSON.stringify(entry.layout));
  let node = nextLayout;
  for (let i = 0; i < keyPath.length - 1; i++) {
    node[keyPath[i]] = node[keyPath[i]] || {};
    node = node[keyPath[i]];
  }
  node[keyPath[keyPath.length - 1]] = value;

  const errors = validateConfig(nextLayout);
  if (errors.length) {
    throw new Error('replaceLayoutNode("' + id + '"): replacement would produce an invalid config:\n  - ' + errors.join('\n  - '));
  }
  entry.layout = nextLayout;
  resolveAndApply(id);
  return getElement(id);
}

export function getElement(id) {
  const entry = elements.get(id);
  if (!entry) return null;
  return { id, role: entry.role, layout: entry.layout, contexts: entry.contexts, domNode: entry.domNode, group: entry.group, propertyLabel: entry.propertyLabel };
}

export function listElements() {
  return [...elements.keys()].map((id) => getElement(id));
}

function requireEntry(id, callerName) {
  const entry = elements.get(id);
  if (!entry) throw new Error(callerName + ': no element registered with id "' + id + '".');
  return entry;
}

// ============================================================
// Responsive context model — inheritance, override lifecycle, enable/disable.
// This is the core new mechanics: "is field X overridden in context Y" is a
// direct lookup, never inferred from nested-object shape.
// ============================================================

// getEffectiveValue — the single function that answers "what value does
// field X actually have in context Y, and is that inherited from base or
// its own override." 'base' always returns {inherited: false} (base IS the
// source of truth, not something that inherits from itself).
export function getEffectiveValue(id, fieldKey, contextKey) {
  const entry = requireEntry(id, 'getEffectiveValue');
  if (contextKey === 'base' || !contextKey) {
    return { value: readFieldValue(entry.layout, fieldKey), inherited: false };
  }
  const ctx = entry.contexts[contextKey];
  if (!ctx) throw new Error('getEffectiveValue: unknown context "' + contextKey + '".');
  if (ctx.enabled && Object.prototype.hasOwnProperty.call(ctx.overrides, fieldKey)) {
    return { value: ctx.overrides[fieldKey], inherited: false };
  }
  // Not overridden (or the context is disabled, per point 11: a disabled
  // context's overrides are IGNORED, not deleted — resolution falls back to
  // base exactly as if no override existed, while the stored override
  // itself remains untouched in ctx.overrides).
  return { value: readFieldValue(entry.layout, fieldKey), inherited: true };
}

export function isFieldOverridden(id, fieldKey, contextKey) {
  const entry = requireEntry(id, 'isFieldOverridden');
  const ctx = entry.contexts[contextKey];
  if (!ctx) return false;
  return Object.prototype.hasOwnProperty.call(ctx.overrides, fieldKey);
}

// createOverride — Architecture point 8's exact lifecycle: (1) the field is
// currently inherited, (2) create the override, (3) initialize it from the
// current effective (inherited) value. Steps 4-5 ("apply the user's new
// value", "persist") are the caller's job via setContextValue() below —
// createOverride() alone just seeds the override with the value it's
// currently mirroring, changing nothing visible yet. A no-op if the field
// is already overridden (does not reset it back to the inherited value).
export function createOverride(id, contextKey, fieldKey) {
  const entry = requireEntry(id, 'createOverride');
  const ctx = entry.contexts[contextKey];
  if (!ctx) throw new Error('createOverride: unknown context "' + contextKey + '".');
  if (Object.prototype.hasOwnProperty.call(ctx.overrides, fieldKey)) return; // already overridden — no-op
  const { value } = getEffectiveValue(id, fieldKey, contextKey);
  ctx.overrides[fieldKey] = value;
  // No resolveAndApply() call here — creating an override seeded from the
  // CURRENT effective value changes nothing visible; re-resolving is a
  // harmless no-op but skipped for clarity of intent (setContextValue()
  // below, the normal caller, always resolves after the real value lands).
}

// removeOverride — Architecture point 9: deletes the override, restoring
// inheritance. The field simply disappears from the sparse overrides map.
export function removeOverride(id, contextKey, fieldKey) {
  const entry = requireEntry(id, 'removeOverride');
  const ctx = entry.contexts[contextKey];
  if (!ctx) throw new Error('removeOverride: unknown context "' + contextKey + '".');
  delete ctx.overrides[fieldKey];
  resolveAndApply(id);
}

// setContextValue — the main "edit this field, in this context" operation
// (what the Inspector calls). For 'base', this is a plain base-layout edit.
// For a responsive context, this implements Architecture point 8's full
// lifecycle in one call: detect-inherited -> create-override (seeded from
// the effective inherited value) -> apply the new value -> persist ->
// re-resolve. If the field is already overridden, this just updates the
// existing override's value (no separate "isolated" state to manage).
export function setContextValue(id, contextKey, fieldKey, value) {
  const entry = requireEntry(id, 'setContextValue');
  if (contextKey === 'base' || !contextKey) {
    entry.layout = writeFieldValue(entry.layout, fieldKey, value);
    const validationErrors = validateConfig(entry.layout);
    if (validationErrors.length) throw new Error('setContextValue("' + id + '"): resulting base config is invalid:\n  - ' + validationErrors.join('\n  - '));
    resolveAndApply(id);
    return getElement(id);
  }
  const ctx = entry.contexts[contextKey];
  if (!ctx) throw new Error('setContextValue: unknown context "' + contextKey + '".');
  // createOverride() is a no-op if already overridden — either way, we then
  // overwrite with the user's real new value, exactly matching Architecture
  // point 8's 5-step lifecycle collapsed into one atomic call.
  createOverride(id, contextKey, fieldKey);
  ctx.overrides[fieldKey] = value;
  resolveAndApply(id);
  return getElement(id);
}

export function getContextState(id, contextKey) {
  const entry = requireEntry(id, 'getContextState');
  const ctx = entry.contexts[contextKey];
  if (!ctx) throw new Error('getContextState: unknown context "' + contextKey + '".');
  return { enabled: ctx.enabled };
}

// setContextEnabled — Architecture point 11: disabling NEVER deletes stored
// overrides; it only stops them from affecting resolution (getEffectiveValue
// already checks ctx.enabled, so this function's only job is flipping the
// flag and re-resolving).
export function setContextEnabled(id, contextKey, enabled) {
  const entry = requireEntry(id, 'setContextEnabled');
  const ctx = entry.contexts[contextKey];
  if (!ctx) throw new Error('setContextEnabled: unknown context "' + contextKey + '".');
  ctx.enabled = enabled;
  resolveAndApply(id);
}

export function getOverriddenFieldKeys(id, contextKey) {
  const entry = requireEntry(id, 'getOverriddenFieldKeys');
  const ctx = entry.contexts[contextKey];
  if (!ctx) return [];
  return Object.keys(ctx.overrides);
}

function lookupForAssertion(id) {
  const entry = elements.get(id);
  return entry ? { domNode: entry.domNode } : null;
}

// ============================================================
// Active context — normally the engine's own matchMedia-based detection
// (getActiveBreakpoint), but a host may push its own determination instead
// via setActiveContextOverride() (v0.2.1 — see this file's header comment;
// grounded in Hando's real, different device-detection logic). The override
// is global, not per-element: a host either fully owns "what's active" or
// fully defers to the engine, matching how every real project studied
// determines device state once, globally, not per-setting.
// ============================================================
let activeContextOverride = null;

export function setActiveContextOverride(contextKey) {
  activeContextOverride = contextKey;
  resolveAndApplyAll();
}
export function clearActiveContextOverride() {
  activeContextOverride = null;
  resolveAndApplyAll();
}
export function getActiveContext() {
  return activeContextOverride !== null ? activeContextOverride : getActiveBreakpoint();
}

// ============================================================
// resolveAndApply — the core resolve-then-apply cycle for one element.
// Computes which field-overrides are ACTUALLY active (the current
// context, only if enabled — a disabled context contributes no overrides,
// per point 11) and hands that flat map straight to engine.mjs's
// resolveElementLayout(), which no longer needs to know anything about
// "contexts" at all. If the element has no domNode (v0.2.1 — a host
// managing non-CSS values), every DOM-touching step is skipped; the
// canonical config/inheritance/override system still runs in full — a host
// reads the result via getEffectiveValue()/the adapter and applies it
// itself, however it wants.
// ============================================================
export function resolveAndApply(id) {
  const entry = elements.get(id);
  if (!entry) return;

  const activeContextKey = getActiveContext(); // 'base' | 'mobilePortrait' | 'mobileLandscape'
  const activeContext = activeContextKey !== 'base' ? entry.contexts[activeContextKey] : null;
  const activeOverrides = activeContext && activeContext.enabled ? activeContext.overrides : {};
  const resolved = resolveElementLayout(entry.layout, activeOverrides, tokens, id);

  if (!entry.domNode) return resolved; // domless element — config/inheritance already computed; nothing more to do

  const domErrors = assertDomStructure(id, entry.layout, lookupForAssertion);
  if (domErrors.length) {
    console.error('[ui-layout-engine] DOM/config mismatch for "' + id + '":\n  - ' + domErrors.join('\n  - '));
  }

  // Clear any previous JS-fallback constraint override before re-applying
  // CSS — otherwise a stale !important inline left/top would survive a
  // config edit that turned the constraint off or moved the element.
  clearViewportConstraintOverride(entry.domNode);
  applyToDOM(entry.domNode, resolved, ALL_MODE_CLASSES, ALL_SIZE_CLASSES);

  // Establish a CSS containing block on any element referenced as one, per
  // engine.mjs's 'containing-block-ref' resolver comment — a CSS-mechanics
  // side effect (position:relative), never a DOM-structure mutation.
  for (const refId of resolved.containingBlockRefs || []) {
    const refEntry = elements.get(refId);
    if (refEntry && refEntry.domNode) refEntry.domNode.classList.add('ui-containing-block');
  }

  const effectiveKeepInsideViewport = getEffectiveValue(id, 'keepInsideViewport', activeContextKey).value;
  if (effectiveKeepInsideViewport) {
    applyViewportConstraint(entry.domNode);
    watchViewportConstraint(entry.domNode);
  } else {
    unwatchViewportConstraint(entry.domNode);
  }

  // relative mode (v0.2.2) — see this file's own applyRelativeAnchor() block
  // below for the resolution logic. Requires the target to be registered
  // WITH a domNode (a domless target has no box to anchor against).
  if (resolved.relativeAnchor) {
    const targetEntry = elements.get(resolved.relativeAnchor.relativeTo);
    if (targetEntry && targetEntry.domNode) {
      applyRelativeAnchor(entry.domNode, targetEntry.domNode, resolved.relativeAnchor);
      watchRelativeAnchor(entry.domNode, targetEntry.domNode, resolved.relativeAnchor);
    } else {
      console.error(
        '[ui-layout-engine] relative mode for "' + id + '": relativeTo target "' +
        resolved.relativeAnchor.relativeTo + '" is not registered, or was registered without a domNode.'
      );
      unwatchRelativeAnchor(entry.domNode);
      clearRelativeAnchor(entry.domNode);
    }
  } else {
    unwatchRelativeAnchor(entry.domNode);
    clearRelativeAnchor(entry.domNode);
  }

  // size 'match' mode (v0.2.6) — see this file's own applySizeMatch() block
  // below. Same domNode-on-both-sides requirement as relative mode above,
  // same reason (a domless target has no box to measure).
  for (const axis of ['width', 'height']) {
    const match = resolved.sizeMatch && resolved.sizeMatch[axis];
    if (match) {
      const targetEntry = elements.get(match.relativeTo);
      if (targetEntry && targetEntry.domNode) {
        applySizeMatch(entry.domNode, targetEntry.domNode, axis);
        watchSizeMatch(entry.domNode, targetEntry.domNode, axis);
      } else {
        console.error(
          '[ui-layout-engine] size match mode for "' + id + '" (' + axis + '): relativeTo target "' +
          match.relativeTo + '" is not registered, or was registered without a domNode.'
        );
        unwatchSizeMatch(entry.domNode, axis);
        clearSizeMatch(entry.domNode, axis);
      }
    } else {
      unwatchSizeMatch(entry.domNode, axis);
      clearSizeMatch(entry.domNode, axis);
    }
  }

  return resolved;
}

// ============================================================
// Relative anchor resolution (v0.2.2) — turns one `relativeAnchor`
// descriptor ({relativeTo, myAnchor, targetAnchor, gap}, built by
// engine.mjs's resolveElementLayout()) into an actual on-screen position.
//
// CSS Anchor Positioning is the primary path: native, zero-JS, and —
// crucially for "scale with browser" objects — recomputed by the browser on
// EVERY layout pass, so both a self-resize and a target-resize (whatever
// causes it: a window resize, a dev-panel slider, content changing) stay
// correctly anchored with no JS re-invocation at all. The JS fallback exists
// only for browsers without support (~12% per Architecture Section 8's
// research at time of writing) and re-measures on demand — see
// watchRelativeAnchor() below for exactly when "on demand" fires.
// ============================================================
let _cssAnchorPositioningSupport = null;
function supportsCssAnchorPositioning() {
  if (_cssAnchorPositioningSupport === null) {
    _cssAnchorPositioningSupport =
      typeof CSS !== 'undefined' && typeof CSS.supports === 'function' &&
      CSS.supports('anchor-name', '--ui-anchor-test');
  }
  return _cssAnchorPositioningSupport;
}

function sanitizeAnchorName(id) {
  return '--ui-anchor-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// v0.2.4 — `gap` accepts a per-axis object `{ x?, y? }` alongside its
// existing plain-scalar form, grounded in real Clicko source found during
// Stage-1 testing (index.html:1572-1589, #targetCountSuffix — genuinely
// anchored to Number's bottom-right corner on BOTH axes at once, with 2
// DIFFERENT real magnitudes: -21.6px X, -54.09px Y, both live in
// production). A scalar `gap` (e.g. '12px') still applies the SAME
// magnitude to both axes — fully backward compatible with every v0.2.2
// config. Each axis's value may itself be a blended-length object (free
// composability via the same resolveLengthValue() every other length field
// already uses) — a per-axis gap object is trivially distinguishable from a
// blended-length object since the two shapes share no keys at all
// ({x,y} vs {pxValue,vwValue,blend}). Missing/omitted axis defaults to
// '0px', matching how gap is optional at all (no gap at all -> '0px' on
// both axes, same as before this existed).
function resolveGapAxis(gap, axis, tokens) {
  if (isPerAxisGap(gap)) return gap[axis] === undefined ? '0px' : resolveLengthValue(gap[axis], tokens);
  return resolveLengthValue(gap, tokens) || '0px';
}

function applyRelativeAnchor(domNode, targetNode, ra) {
  if (supportsCssAnchorPositioning()) {
    applyRelativeAnchorCSS(domNode, targetNode, ra);
  } else {
    applyRelativeAnchorFallback(domNode, targetNode, ra);
  }
}

function applyRelativeAnchorCSS(domNode, targetNode, ra) {
  const anchorName = sanitizeAnchorName(ra.relativeTo);
  targetNode.style.setProperty('anchor-name', anchorName);
  domNode.style.setProperty('position', 'absolute');
  domNode.style.setProperty('position-anchor', anchorName);

  const my = decomposeAnchorPoint(ra.myAnchor);
  const target = decomposeAnchorPoint(ra.targetAnchor);
  const gapX = resolveGapAxis(ra.gap, 'x', tokens);
  const gapY = resolveGapAxis(ra.gap, 'y', tokens);
  const hSign = relativeAnchorGapSign(my.h, target.h, 'left', 'right');
  const vSign = relativeAnchorGapSign(my.v, target.v, 'top', 'bottom');
  const hOffset = hSign === 0 ? '0px' : (hSign > 0 ? '' : '-') + gapX;
  const vOffset = vSign === 0 ? '0px' : (vSign > 0 ? '' : '-') + gapY;

  domNode.style.setProperty('left', 'calc(anchor(' + anchorName + ' ' + target.h + ') + (' + hOffset + '))');
  domNode.style.setProperty('top', 'calc(anchor(' + anchorName + ' ' + target.v + ') + (' + vOffset + '))');
  domNode.style.setProperty('right', 'auto');
  domNode.style.setProperty('bottom', 'auto');
  const xPct = my.h === 'left' ? 0 : my.h === 'center' ? -50 : -100;
  const yPct = my.v === 'top' ? 0 : my.v === 'center' ? -50 : -100;
  domNode.style.setProperty('transform', 'translate(' + xPct + '%, ' + yPct + '%)');
  domNode.classList.add('ui-mode-relative-css');
  domNode.classList.remove('ui-mode-relative-js-fallback');
}

// px-parsing helper for the JS fallback only — the CSS path never needs a
// numeric value, it hands the length straight to calc()/anchor() as a
// string. The fallback DOES need a real number since it's doing the
// arithmetic itself via getBoundingClientRect(); anything that isn't a
// plain `<number>px` string (e.g. an unresolved token, or a unit this
// engine doesn't parse) falls back to 0 rather than producing NaN math.
function parseLengthPx(lengthStr) {
  const m = String(lengthStr).match(/^(-?[\d.]+)px$/);
  return m ? parseFloat(m[1]) : 0;
}

function applyRelativeAnchorFallback(domNode, targetNode, ra) {
  const selfRect = domNode.getBoundingClientRect();
  const targetRect = targetNode.getBoundingClientRect();
  const gapXPx = parseLengthPx(resolveGapAxis(ra.gap, 'x', tokens));
  const gapYPx = parseLengthPx(resolveGapAxis(ra.gap, 'y', tokens));

  const my = decomposeAnchorPoint(ra.myAnchor);
  const target = decomposeAnchorPoint(ra.targetAnchor);

  const targetX = target.h === 'left' ? targetRect.left : target.h === 'right' ? targetRect.right : targetRect.left + targetRect.width / 2;
  const targetY = target.v === 'top' ? targetRect.top : target.v === 'bottom' ? targetRect.bottom : targetRect.top + targetRect.height / 2;
  const hSign = relativeAnchorGapSign(my.h, target.h, 'left', 'right');
  const vSign = relativeAnchorGapSign(my.v, target.v, 'top', 'bottom');
  const pointX = targetX + hSign * gapXPx;
  const pointY = targetY + vSign * gapYPx;

  const selfOffsetX = my.h === 'left' ? 0 : my.h === 'center' ? selfRect.width / 2 : selfRect.width;
  const selfOffsetY = my.v === 'top' ? 0 : my.v === 'center' ? selfRect.height / 2 : selfRect.height;
  const viewportLeft = pointX - selfOffsetX;
  const viewportTop = pointY - selfOffsetY;

  // domNode is position:absolute, so its left/top are relative to its
  // nearest positioned ancestor (offsetParent), not the viewport — convert.
  const parent = domNode.offsetParent || (typeof document !== 'undefined' ? document.documentElement : null);
  const parentRect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };

  domNode.style.setProperty('position', 'absolute', 'important');
  domNode.style.setProperty('left', (viewportLeft - parentRect.left) + 'px', 'important');
  domNode.style.setProperty('top', (viewportTop - parentRect.top) + 'px', 'important');
  domNode.style.setProperty('right', 'auto', 'important');
  domNode.style.setProperty('bottom', 'auto', 'important');
  domNode.style.setProperty('transform', 'none', 'important');
  domNode.classList.add('ui-mode-relative-js-fallback');
  domNode.classList.remove('ui-mode-relative-css');
}

function clearRelativeAnchor(domNode) {
  if (!domNode) return;
  if (!domNode.classList.contains('ui-mode-relative-css') && !domNode.classList.contains('ui-mode-relative-js-fallback')) return;
  domNode.style.removeProperty('position');
  domNode.style.removeProperty('position-anchor');
  domNode.style.removeProperty('left');
  domNode.style.removeProperty('top');
  domNode.style.removeProperty('right');
  domNode.style.removeProperty('bottom');
  domNode.style.removeProperty('transform');
  domNode.classList.remove('ui-mode-relative-css', 'ui-mode-relative-js-fallback');
}

// Watchers — CSS-Anchor-Positioning path needs none: `anchor()` and the
// percentage `transform` are both live CSS, recomputed by the browser on
// every layout pass with zero JS re-invocation, which is exactly what makes
// it correct for a "scale with browser" self OR target with no extra work.
// The JS fallback has no such luck — it's a one-shot measurement — so it's
// re-run on: a window resize, AND a ResizeObserver on BOTH the target (its
// box can change size for reasons that aren't a window resize at all — a
// dev-panel edit, content changing) and self (so a self element that scales
// with the browser independently of the target doesn't drift out of sync,
// since the fallback's own offset math depends on self's box size too).
const relativeAnchorWatchers = new WeakMap(); // domNode -> { resizeHandler, resizeObserver }

function watchRelativeAnchor(domNode, targetNode, ra) {
  if (supportsCssAnchorPositioning()) { unwatchRelativeAnchor(domNode); return; }
  if (relativeAnchorWatchers.has(domNode) || typeof window === 'undefined') return;
  const handler = () => applyRelativeAnchorFallback(domNode, targetNode, ra);
  window.addEventListener('resize', handler);
  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(handler);
    resizeObserver.observe(targetNode);
    resizeObserver.observe(domNode);
  }
  relativeAnchorWatchers.set(domNode, { resizeHandler: handler, resizeObserver });
}

function unwatchRelativeAnchor(domNode) {
  if (!domNode) return;
  const entry = relativeAnchorWatchers.get(domNode);
  if (entry) {
    if (typeof window !== 'undefined') window.removeEventListener('resize', entry.resizeHandler);
    if (entry.resizeObserver) entry.resizeObserver.disconnect();
    relativeAnchorWatchers.delete(domNode);
  }
}

// ============================================================
// Size match (v0.2.6) — turns a `sizeMatch` descriptor ({ relativeTo }, one
// per axis, built by engine.mjs's resolveElementLayout()) into a real
// measured size on-screen: `domNode`'s width/height (whichever axis is in
// 'match' mode) is set to `targetNode`'s live rendered size on that SAME
// axis, via getBoundingClientRect() — real DOM measurement is the only way
// to track a TEXT element's rendered width, which depends on font metrics
// and content, not a computable formula (see widthRelativeTo's own
// schema.mjs comment for the full "why this needs measurement, not CSS"
// account).
//
// Unlike relative-anchor position, this has NO native-CSS-first path:
// `anchor-size()` (the CSS Anchor Positioning function that reads another
// element's size) has narrower browser support than `anchor()` itself at
// time of writing, and this feature's one motivating use case is exactly
// the kind of "MVP-scoped, JS-only, re-measured on resize" behavior the
// viewport constraint below already established a precedent for in this
// same file — same tradeoff, not a new one. Always measure-and-set; no
// mode branch on CSS support.
const sizeMatchWatchers = new WeakMap(); // domNode -> { width?: {...}, height?: {...} }

function applySizeMatch(domNode, targetNode, axis) {
  const rect = targetNode.getBoundingClientRect();
  const measuredPx = axis === 'width' ? rect.width : rect.height;
  domNode.style.setProperty(axis, measuredPx + 'px', 'important');
  domNode.classList.add('ui-size-' + (axis === 'width' ? 'w' : 'h') + '-match');
}

function clearSizeMatch(domNode, axis) {
  if (!domNode) return;
  const cls = 'ui-size-' + (axis === 'width' ? 'w' : 'h') + '-match';
  if (!domNode.classList.contains(cls)) return;
  domNode.style.removeProperty(axis);
  domNode.classList.remove(cls);
}

// Re-measures on: a window resize, AND a ResizeObserver on BOTH the target
// (its box can change size for reasons that aren't a window resize at all —
// a dev-panel edit, its own content changing) and self (so keepInsideParent/
// other constraints resizing self don't drift the measurement stale) — same
// reasoning as watchRelativeAnchor()'s own pair of observers above.
function watchSizeMatch(domNode, targetNode, axis) {
  const existing = sizeMatchWatchers.get(domNode) || {};
  if (existing[axis] || typeof window === 'undefined') return;
  const handler = () => applySizeMatch(domNode, targetNode, axis);
  window.addEventListener('resize', handler);
  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(handler);
    resizeObserver.observe(targetNode);
    resizeObserver.observe(domNode);
  }
  existing[axis] = { resizeHandler: handler, resizeObserver };
  sizeMatchWatchers.set(domNode, existing);
}

function unwatchSizeMatch(domNode, axis) {
  if (!domNode) return;
  const existing = sizeMatchWatchers.get(domNode);
  if (!existing || !existing[axis]) return;
  if (typeof window !== 'undefined') window.removeEventListener('resize', existing[axis].resizeHandler);
  if (existing[axis].resizeObserver) existing[axis].resizeObserver.disconnect();
  delete existing[axis];
  if (!existing.width && !existing.height) sizeMatchWatchers.delete(domNode);
  else sizeMatchWatchers.set(domNode, existing);
}

// ============================================================
// Viewport constraint — the one genuinely JS-dependent piece of MVP-scoped
// behavior (Architecture Section 6/8: CSS alone can't clamp an element back
// on-screen without knowing its rendered size, which for content-sized
// elements isn't known ahead of layout). Read-measure-then-clamp, applied
// once per resolve plus on window resize — never a scroll listener or
// per-frame poll, per the architecture's own performance guidance. Uses
// !important inline styles specifically so this override wins over the
// CSS anchor/fixed rules in engine.css without needing !important there.
// ============================================================
const viewportConstraintWatchers = new WeakMap();

function applyViewportConstraint(domNode) {
  const rect = domNode.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = rect.left;
  let top = rect.top;
  let changed = false;
  if (rect.right > vw) { left = vw - rect.width; changed = true; }
  if (left < 0) { left = 0; changed = true; }
  if (rect.bottom > vh) { top = vh - rect.height; changed = true; }
  if (top < 0) { top = 0; changed = true; }
  if (changed) {
    domNode.style.setProperty('left', left + 'px', 'important');
    domNode.style.setProperty('top', top + 'px', 'important');
    domNode.style.setProperty('right', 'auto', 'important');
    domNode.style.setProperty('bottom', 'auto', 'important');
    domNode.style.setProperty('transform', 'none', 'important');
    domNode.classList.add('ui-constraint-viewport-clamped');
  } else {
    clearViewportConstraintOverride(domNode);
  }
}

function clearViewportConstraintOverride(domNode) {
  if (!domNode.classList.contains('ui-constraint-viewport-clamped')) return;
  domNode.style.removeProperty('left');
  domNode.style.removeProperty('top');
  domNode.style.removeProperty('right');
  domNode.style.removeProperty('bottom');
  domNode.style.removeProperty('transform');
  domNode.classList.remove('ui-constraint-viewport-clamped');
}

function watchViewportConstraint(domNode) {
  if (viewportConstraintWatchers.has(domNode) || typeof window === 'undefined') return;
  const handler = () => applyViewportConstraint(domNode);
  window.addEventListener('resize', handler);
  viewportConstraintWatchers.set(domNode, handler);
}

function unwatchViewportConstraint(domNode) {
  const handler = viewportConstraintWatchers.get(domNode);
  if (handler) {
    window.removeEventListener('resize', handler);
    viewportConstraintWatchers.delete(domNode);
  }
  clearViewportConstraintOverride(domNode);
}

export function resolveAndApplyAll() {
  for (const id of elements.keys()) resolveAndApply(id);
}

// ============================================================
// Tokens — set once at init (or updated live); re-resolves everything so a
// token-value change propagates immediately, same as any other config edit.
// ============================================================
export function setTokens(newTokens) {
  tokens = newTokens || {};
  resolveAndApplyAll();
}
export function getTokens() {
  return tokens;
}

// ============================================================
// Persistence — localStorage by default, with a pluggable backend so a host
// (e.g. Clicko's eventual GitHub-sync endpoint) can swap storage WITHOUT
// this module ever importing or knowing about that backend's implementation.
// See docs/ENGINE_API.md.
// ============================================================
const DEFAULT_STORAGE_KEY = 'uiLayoutEngineConfig';

const localStorageBackend = {
  save(state) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(DEFAULT_STORAGE_KEY, JSON.stringify(state));
  },
  load() {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(DEFAULT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  },
};

export function registerStorageBackend(backend) {
  if (!backend || typeof backend.save !== 'function' || typeof backend.load !== 'function') {
    throw new Error('registerStorageBackend: backend must implement { save(state), load() }.');
  }
  storageBackend = backend;
}

function activeBackend() {
  return storageBackend || localStorageBackend;
}

export function captureAllLayoutConfigs() {
  const out = {};
  for (const [id, entry] of elements.entries()) {
    out[id] = { layout: entry.layout, contexts: JSON.parse(JSON.stringify(entry.contexts)) };
  }
  return out;
}

export function saveLayoutConfig() {
  activeBackend().save(captureAllLayoutConfigs());
}

export function loadLayoutConfig() {
  const state = activeBackend().load();
  if (!state) return false;
  for (const [id, saved] of Object.entries(state)) {
    const entry = elements.get(id);
    if (!entry) continue; // element from a saved state that no longer exists in this DOM — skip, don't error
    entry.layout = saved.layout;
    entry.contexts = saved.contexts || emptyContexts();
  }
  resolveAndApplyAll();
  return true;
}

export function resetLayoutConfig(originalConfigs) {
  // originalConfigs: { id: { layout, contexts } } — typically captured once
  // at init, before any live edits, so Reset means "back to shipped
  // config," matching the Dev Panel Template's own Reset convention.
  for (const [id, original] of Object.entries(originalConfigs)) {
    const entry = elements.get(id);
    if (!entry) continue;
    entry.layout = original.layout;
    entry.contexts = original.contexts ? JSON.parse(JSON.stringify(original.contexts)) : emptyContexts();
  }
  resolveAndApplyAll();
}

// Plain deep merge for BASE config patches only (updateElement). Kept local
// + tiny rather than reusing a shared utility — this is the only remaining
// deep-merge need in the whole engine now that responsive overrides are
// flat (fieldAccess.mjs's applyFieldOverrides handles those instead).
function deepMergePlain(base, patch) {
  if (patch === undefined) return base;
  if (typeof base !== 'object' || base === null || typeof patch !== 'object' || patch === null || Array.isArray(base) || Array.isArray(patch)) {
    return patch;
  }
  const result = { ...base };
  for (const key of Object.keys(patch)) {
    result[key] = deepMergePlain(base[key], patch[key]);
  }
  return result;
}
