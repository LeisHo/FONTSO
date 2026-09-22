// ui-layout-engine v0.1.0 — canonical source: J:\CLAUDE\PROJECTS\HTML UI ENGINE\engine.mjs
//
// Layout Resolution Engine — pure functions that turn a Layout Configuration
// (intent) into concrete CSS custom properties, classes, and attributes
// (resolved geometry, applied to the live DOM only — never written back into
// configuration; see Architecture Section 14's intent/geometry separation
// rule, enforced here by construction: this module never touches config.json
// or any persisted state, only the DOM).
//
// Zero knowledge of any host application, any specific project, or any
// specific DOM structure beyond what's passed in. Native ES module, zero
// dependencies.

import { FIELDS, MODE_SCHEMA, SIZE_AXIS_MODE_SCHEMA } from './schema.mjs';
import { readFieldValue, applyFieldOverrides } from './fieldAccess.mjs';

// ============================================================
// RESOLVERS — the small, closed set of generic resolver TYPES referenced by
// name from FIELDS[field].resolver. A field never gets a bespoke function;
// see Architecture Section 9's schema-purity rule. Keep this registry small
// — if it needs to keep growing, that's a signal a field/mode is doing too
// much, not a cue to add resolver types freely.
// ============================================================
export const RESOLVERS = {
  // No CSS output. Used for elementRef fields (parent/relativeTo) whose only
  // job is a DOM-structure ASSERTION, done separately by assertDomStructure()
  // below — never by mutating DOM structure. See ENGINE_API.md's explicit
  // rule on the DOM-parent vs. position.parent vs. containingBlock question.
  'dom-ref-noop': () => ({}),

  // Same as dom-ref-noop, but also flags the referenced element as needing
  // the 'ui-containing-block' CSS class (position: relative), which is a
  // CSS-mechanics side effect (establishing a CSS containing block for
  // position:absolute children), not a DOM-structure mutation — see
  // applyToDOM()'s handling of `containingBlockRefs` below.
  'containing-block-ref': () => ({}),

  // Deferred field placeholder — kept as a generic escape hatch for any
  // future field a project stages before its resolver is ready; nothing in
  // FIELDS currently references it (relative mode's 4 fields moved to
  // 'anchor-ref-noop' in v0.2.2, see below). Warns once per field/element so
  // a chatty console doesn't drown out real problems, and returns no CSS.
  'not-implemented': (value, args, tokens, ctx) => {
    const key = (ctx && ctx.elementId) + ':' + (ctx && ctx.field);
    if (!RESOLVERS.__warned) RESOLVERS.__warned = new Set();
    if (!RESOLVERS.__warned.has(key)) {
      RESOLVERS.__warned.add(key);
      console.warn(
        '[ui-layout-engine] field "' + (ctx && ctx.field) + '" on element "' + (ctx && ctx.elementId) +
        '" uses a not-yet-implemented resolver (' + (args && args.reason) + '). No CSS was applied for this field.'
      );
    }
    return {};
  },

  // v0.2.2 — relative mode's 4 fields (relativeTo/myAnchor/targetAnchor/gap)
  // produce no CSS through the normal per-field fragment pipeline: unlike
  // every other field, their actual output depends on ANOTHER element's live
  // geometry, which a pure resolver (no DOM, no registry access — see this
  // file's own header comment) cannot compute. resolveElementLayout() below
  // reads these 4 fields directly and packages them into a `relativeAnchor`
  // descriptor on its result instead; registry.mjs's applyRelativeAnchor()
  // is what actually turns that descriptor into CSS Anchor Positioning (or a
  // JS-measured fallback). This resolver exists only so the generic
  // required/optional field loop has a valid, silent no-op to call.
  'anchor-ref-noop': () => ({}),

  // v0.2.6 — size 'match' mode's widthRelativeTo/heightRelativeTo fields,
  // same reasoning as anchor-ref-noop directly above: the actual value
  // depends on another element's LIVE rendered size, which a pure resolver
  // can't compute. resolveElementLayout() below packages this into a
  // `sizeMatch` descriptor per axis instead; registry.mjs's
  // applySizeMatch() turns it into a real measured px value.
  'size-match-noop': () => ({}),

  // v0.2.3 — 'css-length' now also accepts a BLENDED-LENGTH value (see
  // resolveLengthValue() below) alongside its existing plain-string/token()
  // forms. This is the ONLY change needed anywhere in schema.mjs to give
  // every existing length-typed field (offsetX/offsetY, x/y, gap,
  // widthValue/heightValue, widthMin/Preferred/Max, ...) blended-length
  // capability "for free" — exactly the same way `token(...)` is already an
  // alternate representation resolved by this same function, not a
  // per-field opt-in flag.
  'css-length': (value, args, tokens) => ({ cssVars: { [args.cssVar]: resolveLengthValue(value, tokens) } }),
  'css-attr': (value, args) => ({ attrs: { [args.attr]: String(value) } }),
  'css-class-toggle': (value, args) => (value ? { classes: [args.class] } : {}),
  'css-enum-var': (value, args) => ({ cssVars: { [args.cssVar]: value } }),
  'css-number-var': (value, args) => ({ cssVars: { [args.cssVar]: String(value) } }),
};

// ============================================================
// Blended length (v0.2.3) — grounded in real Clicko source (index.html),
// read-only, per direct request comparing this engine against a real host
// under evaluation. Clicko's "Scale With Browser" mechanism, used across
// every sized/positioned text element (18+ real CSS rules, e.g. line 1380's
// .result-win font-size), blends TWO independently-authored numbers — a
// fixed px value and a viewport-proportional value — via a factor:
//
//   calc((1 - blend) * pxValue * 1px + blend * vwValue * 1vmin)
//
// This is a genuinely general LENGTH-VALUE concept, not a typography-only
// one — it's the sibling of this schema's existing `clamp` size mode (a
// length that resolves via a formula involving viewport units, rather than
// a single fixed value), just for scalar fields (offsets, gap, x/y,
// individual size-axis values) instead of a width/height axis. It's added
// as an ALTERNATE VALUE SHAPE any `type: 'length'` field already accepts —
// exactly how `token(...)` is already a 2nd representation for the same
// fields (see expandLength() below) — not a new field type hand-added per
// field, and not a font-size/typography feature (font-size itself stays
// out of this engine's scope; only the underlying length-value MECHANISM
// generalizes).
//
// { pxValue, vwValue, blend, vwUnit? } — vwUnit defaults to 'vmin' (Clicko's
// own real choice for font-size, correct because it scales uniformly
// regardless of aspect ratio) but a host blending a directional field like
// offsetX/offsetY may reasonably want 'vw'/'vh' instead — this is a REAL
// per-field authoring choice, not something the engine can default
// correctly for every field, so it's part of the value itself.
// ============================================================
export function isBlendedLength(value) {
  return !!value && typeof value === 'object' &&
    typeof value.pxValue === 'number' && typeof value.vwValue === 'number' && typeof value.blend === 'number';
}

export function resolveLengthValue(value, tokens) {
  if (isBlendedLength(value)) {
    const unit = value.vwUnit || 'vmin';
    const blend = value.blend;
    return 'calc((1 - ' + blend + ') * ' + value.pxValue + ' * 1px + ' + blend + ' * ' + value.vwValue + ' * 1' + unit + ')';
  }
  return expandLength(value, tokens);
}

// ============================================================
// Per-axis gap (v0.2.4) — grounded in real Clicko source found during
// Stage-1 testing of relative mode against a real host: index.html's
// #targetCountSuffix is genuinely anchored to Number's bottom-right corner
// on BOTH axes at once, with 2 DIFFERENT real magnitudes (-21.6px X,
// -54.09px Y, both live in production) — a single scalar `gap` cannot
// express this. `gap` now ALSO accepts `{ x?, y? }` (each an ordinary
// length value, including a blended-length object) alongside its existing
// scalar form (which still applies the same magnitude to both axes,
// unchanged from v0.2.2). Deliberately SCOPED TO `gap` specifically, not
// made a universal 3rd shape every length field accepts (unlike
// blended-length, which genuinely is general) — a per-axis shape has no
// sensible meaning for e.g. `offsetX`, which is already single-axis by
// definition; accepting it there would silently produce broken CSS instead
// of a clear validation error. Exported so validate.mjs's type-check and
// registry.mjs's resolution both check the exact same shape, never 2
// independently-drifting implementations of "is this a per-axis gap."
// ============================================================
export function isPerAxisGap(value) {
  return !!value && typeof value === 'object' && !isBlendedLength(value);
}

// ============================================================
// Length-unit conversion (v0.2.3) — grounded in real Clicko source
// (setupOffsetUnitCheckboxes(), index.html): Clicko's "Edge Lock"/offset
// px<->vw toggle is NOT a `position.mode` switch (it never changes which
// of this schema's 5 position modes is active) and NOT a blended length
// either (only ONE number is stored; toggling the unit re-INTERPRETS that
// same number under a different unit, rather than blending 2 stored
// numbers) — it is a 3rd, narrower, distinct mechanism: converting a single
// length between an absolute unit and a viewport-relative one so its
// RENDERED pixel value stays the same after the unit changes. Clicko's own
// fix (`factor = checkedNow ? refPx/100 : 100/refPx`) is generalized here
// into a pure function covering any px/vw/vh/vmin/vmax pairing, usable by
// any host implementing a similar unit-toggle control for any length field
// — see CHANGELOG.md's v0.2.3 entry for why this, and NOT a general
// cross-`position.mode` "preserve visual position" helper, is what's
// actually evidenced and being added.
//
// Deliberately DOM-free (per this file's own header comment: engine.mjs
// never touches the DOM) — the caller supplies the correct viewport
// reference pixel dimension for the axis in question (window.innerWidth
// for a `vw`-relative conversion, window.innerHeight for `vh`, etc.),
// exactly as Clicko's own call site already does today.
// ============================================================
const VIEWPORT_RELATIVE_UNITS = new Set(['vw', 'vh', 'vmin', 'vmax', '%']);

function parseLengthUnit(lengthStr) {
  const m = String(lengthStr).match(/^(-?[\d.]+)(px|vw|vh|vmin|vmax|%)$/);
  return m ? { number: parseFloat(m[1]), unit: m[2] } : null;
}

export function convertLengthUnit(lengthStr, toUnit, viewportRefPx) {
  const parsed = parseLengthUnit(lengthStr);
  if (!parsed) {
    console.warn(
      '[ui-layout-engine] convertLengthUnit: cannot parse "' + lengthStr + '" as a plain ' +
      '<number><px|vw|vh|vmin|vmax|%> length (a token() reference or calc() expression can\'t ' +
      'be unit-converted numerically) — returned unchanged.'
    );
    return lengthStr;
  }
  if (parsed.unit === toUnit) return lengthStr;
  // Every supported unit is either px or "N% of viewportRefPx" (vw/vh/vmin/
  // vmax are all percentage-of-one-reference-dimension by definition — the
  // CALLER picks which dimension is the correct reference for the axis in
  // play, this function just does the arithmetic) — so px is the one
  // necessary intermediate for any pairing, not a special case.
  const px = parsed.unit === 'px' ? parsed.number : (parsed.number / 100) * viewportRefPx;
  if (toUnit === 'px') return px + 'px';
  return (px / viewportRefPx) * 100 + toUnit;
}

// ============================================================
// Token expansion — "token(spacing.md)" -> the real value from tokens.json.
// A plain length string passes through unchanged.
// ============================================================
export function expandLength(value, tokens) {
  if (typeof value !== 'string') return value;
  const m = value.match(/^token\(([\w.]+)\)$/);
  if (!m) return value;
  const path = m[1].split('.');
  let node = tokens;
  for (const part of path) {
    if (node == null) break;
    node = node[part];
  }
  if (node === undefined) {
    console.warn('[ui-layout-engine] unresolved token reference: ' + value);
    return value;
  }
  return node;
}

// ============================================================
// Field-list helpers — derive the full set of fields relevant to a given
// position mode / size-axis mode, per schema.mjs's MODE_SCHEMA /
// SIZE_AXIS_MODE_SCHEMA. Used by the resolver, the validator, and the
// inspector alike (Architecture Section 9's "one table, three consumers").
// ============================================================
export function positionFieldsForMode(mode) {
  const modeDef = MODE_SCHEMA[mode];
  if (!modeDef) return { required: [], optional: [] };
  return { required: [...modeDef.required], optional: [...modeDef.optional] };
}

export function sizeFieldsForAxis(axis, mode) {
  // axis: 'width' | 'height'. Returns real FIELDS keys (e.g. 'widthMin'),
  // derived from SIZE_AXIS_MODE_SCHEMA's suffix lists.
  const modeDef = SIZE_AXIS_MODE_SCHEMA[mode];
  if (!modeDef) return { required: [], optional: [] };
  const cap = axis === 'width' ? 'width' : 'height';
  return {
    required: modeDef.required.map((suffix) => cap + suffix),
    optional: modeDef.optional.map((suffix) => cap + suffix),
  };
}

// ============================================================
// resolveElementLayout — the pure core of the engine. Given one element's
// base layout config, a FLAT { fieldKey: value } map of already-resolved
// effective overrides (empty for base, or whatever the active responsive
// context contributes — see registry.mjs's computeEffectiveOverrides()),
// and the tokens object, returns { cssVars, classes, attrs } ready to apply
// to a DOM node. Never mutates its inputs; never touches persisted config.
// Same inputs always produce the same output.
//
// v0.2.0 change: this function used to take a nested `responsiveConfig` +
// `activeBreakpoint` and deep-merge internally. That coupled resolution to
// "how overrides are organized," which the new canonical-schema/responsive-
// context system (registry.mjs) needed to redesign around inheritance,
// per-context enable state, and override lifecycle. Resolution itself only
// ever needed "the final effective value per field" — so that concern moved
// up to the caller (registry.mjs), and this function got simpler, not more
// complex, as a result. See fieldAccess.mjs for the field-by-field
// read/write logic this and every other module now shares.
// ============================================================
export function resolveElementLayout(layoutConfig, fieldOverrides, tokens, elementId) {
  const merged = applyFieldOverrides(layoutConfig, fieldOverrides);
  const fragments = [];
  const classes = new Set();
  const containingBlockRefs = [];

  // ---- position ----
  const position = merged.position || {};
  const mode = position.mode;
  let relativeAnchor = null;
  if (mode && MODE_SCHEMA[mode]) {
    classes.add('ui-mode-' + mode);
    const { required, optional } = positionFieldsForMode(mode);
    for (const field of [...required, ...optional]) {
      const value = readFieldValue(merged, field);
      if (value === undefined) continue;
      const fragment = resolveOneField(field, value, tokens, elementId);
      fragments.push(fragment);
      if (field === 'containingBlock' && value) containingBlockRefs.push(value);
    }
    // relative mode: package the 4 fields into one descriptor for
    // registry.mjs to act on (see 'anchor-ref-noop' above for why this can't
    // happen inside the pure per-field resolver pipeline). Only emitted when
    // relativeTo actually names a target — an incomplete/mid-edit config
    // (e.g. mode switched to 'relative' but no target picked yet) resolves
    // to no positioning rather than a broken one, same tolerance the other
    // modes already have for an unset optional field.
    if (mode === 'relative') {
      const relativeTo = readFieldValue(merged, 'relativeTo');
      if (relativeTo) {
        relativeAnchor = {
          relativeTo,
          myAnchor: readFieldValue(merged, 'myAnchor') || 'top-center',
          targetAnchor: readFieldValue(merged, 'targetAnchor') || 'bottom-center',
          gap: readFieldValue(merged, 'gap') || '0px',
        };
      }
    }
  }

  // ---- size (per axis) ----
  // sizeMatch: v0.2.6, mirrors `relativeAnchor` above but per-axis (width
  // and height can independently be in 'match' mode) — see widthRelativeTo/
  // heightRelativeTo's own schema.mjs comment for why this can't resolve
  // through the normal per-field fragment pipeline.
  const sizeMatch = { width: null, height: null };
  for (const axis of ['width', 'height']) {
    const axisConfig = merged.size && merged.size[axis];
    if (!axisConfig || !axisConfig.mode) continue;
    classes.add('ui-size-' + (axis === 'width' ? 'w' : 'h') + '-' + axisConfig.mode);
    const { required, optional } = sizeFieldsForAxis(axis, axisConfig.mode);
    for (const field of [...required, ...optional]) {
      const value = readFieldValue(merged, field);
      if (value === undefined) continue;
      fragments.push(resolveOneField(field, value, tokens, elementId));
    }
    if (axisConfig.mode === 'match') {
      const relativeTo = readFieldValue(merged, axis === 'width' ? 'widthRelativeTo' : 'heightRelativeTo');
      if (relativeTo) sizeMatch[axis] = { relativeTo };
    }
  }

  // ---- constraints ----
  const constraints = merged.constraints || {};
  for (const field of Object.keys(constraints)) {
    if (!FIELDS[field]) continue;
    fragments.push(resolveOneField(field, constraints[field], tokens, elementId));
  }

  const result = mergeFragments(fragments);
  result.classes = [...classes, ...(result.classes || [])];
  result.containingBlockRefs = containingBlockRefs;
  result.relativeAnchor = relativeAnchor;
  result.sizeMatch = (sizeMatch.width || sizeMatch.height) ? sizeMatch : null;
  return result;
}

// ============================================================
// decomposeAnchorPoint — the 9-point anchor vocabulary (schema.mjs's
// myAnchor/targetAnchor enum) split into independent horizontal/vertical
// components, e.g. 'top-right' -> { h: 'right', v: 'top' }. Pure and
// DOM-free on purpose: both registry.mjs's CSS-Anchor-Positioning path and
// its JS-measurement fallback need the exact same decomposition, so it
// lives here once rather than being re-derived (or drifting) in each path.
// ============================================================
const ANCHOR_H = {
  'top-left': 'left', 'center-left': 'left', 'bottom-left': 'left',
  'top-center': 'center', center: 'center', 'bottom-center': 'center',
  'top-right': 'right', 'center-right': 'right', 'bottom-right': 'right',
};
const ANCHOR_V = {
  'top-left': 'top', 'top-center': 'top', 'top-right': 'top',
  'center-left': 'center', center: 'center', 'center-right': 'center',
  'bottom-left': 'bottom', 'bottom-center': 'bottom', 'bottom-right': 'bottom',
};
export function decomposeAnchorPoint(point) {
  return { h: ANCHOR_H[point] || 'center', v: ANCHOR_V[point] || 'center' };
}

// ============================================================
// relativeAnchorGapSign — whether/which-direction `gap` applies along one
// axis, given this element's anchor side and the target's anchor side on
// that same axis. A JUDGMENT CALL (not a spec-derived value — see CLAUDE.md
// §0c rule 6, and Architecture Section 25 for the reasoning): gap only has
// an unambiguous physical direction when the two anchors are the two
// OUTWARD-facing edges of a directly adjacent pair (my=left facing
// target=right means self sits to target's right, so +gap pushes further
// right/away; the mirror pair is the reverse sign). Every other combination
// — same-side ('left'/'left'), or either side being 'center' — has no
// single defensible "away from target" direction, so gap is simply not
// applied on that axis (0), rather than guessing. A same-side or
// center-involving offset is exactly what plain `anchor` mode's `offset`
// field is for instead.
// ============================================================
export function relativeAnchorGapSign(mySide, targetSide, startSide, endSide) {
  if (mySide === startSide && targetSide === endSide) return 1;
  if (mySide === endSide && targetSide === startSide) return -1;
  return 0;
}

function resolveOneField(field, value, tokens, elementId) {
  const def = FIELDS[field];
  if (!def) {
    console.warn('[ui-layout-engine] unknown field "' + field + '" — no FIELDS entry, ignored.');
    return {};
  }
  const resolver = RESOLVERS[def.resolver];
  if (!resolver) {
    console.warn('[ui-layout-engine] field "' + field + '" references unknown resolver "' + def.resolver + '" — ignored.');
    return {};
  }
  return resolver(value, def.resolverArgs, tokens, { elementId, field });
}

function mergeFragments(fragments) {
  const cssVars = {};
  const classes = [];
  const attrs = {};
  for (const frag of fragments) {
    if (!frag) continue;
    if (frag.cssVars) Object.assign(cssVars, frag.cssVars);
    if (frag.classes) classes.push(...frag.classes);
    if (frag.attrs) Object.assign(attrs, frag.attrs);
  }
  return { cssVars, classes, attrs };
}

// ============================================================
// applyToDOM — the one place this engine ever touches a real DOM node.
// Idempotent: safe to call repeatedly with the same resolved result.
// ============================================================
export function applyToDOM(domNode, resolved, allKnownModeClasses, allKnownSizeClasses) {
  if (!domNode || typeof domNode.style === 'undefined') return; // no-op outside a browser/DOM environment

  // Clear previously-applied mode/size classes before applying the new set —
  // otherwise switching position.mode would leave stale classes like
  // ui-mode-anchor sitting alongside a freshly-applied ui-mode-flow.
  for (const cls of allKnownModeClasses || []) domNode.classList.remove(cls);
  for (const cls of allKnownSizeClasses || []) domNode.classList.remove(cls);
  domNode.classList.remove('ui-constraint-viewport', 'ui-constraint-parent');

  for (const cls of resolved.classes || []) domNode.classList.add(cls);
  for (const [name, value] of Object.entries(resolved.cssVars || {})) domNode.style.setProperty(name, value);
  for (const [attr, value] of Object.entries(resolved.attrs || {})) domNode.setAttribute(attr, value);
}

// ============================================================
// Breakpoint detection — JS's ONLY responsibility in the responsive system
// (Architecture Section 7): decide which named context is active, purely
// for the Inspector's own display. All actual fluid interpolation is CSS
// clamp()/media-query driven, not recomputed here.
//
// v0.2.0 naming change: 'narrow'/'landscape' were renamed to
// 'mobilePortrait'/'mobileLandscape' to match the 3 public responsive
// contexts (Base/Mobile Portrait/Mobile Landscape) the canonical-schema
// work introduces — see docs/DEV_PANEL_ADAPTER.md's "Naming decision"
// section for why this was a clean rename rather than a compatibility
// shim (no Clicko integration exists yet to need backward compatibility
// with the old names, per Architecture Section 24's own guidance to prefer
// clean architecture over preserving accidental legacy behavior at this
// stage).
// ============================================================
export const BREAKPOINTS = {
  mobilePortrait: '(max-width: 767px) and (orientation: portrait)',
  mobileLandscape: '(orientation: landscape) and (max-height: 500px)',
};

export function getActiveBreakpoint(win) {
  win = win || (typeof window !== 'undefined' ? window : undefined);
  if (!win || !win.matchMedia) return 'base';
  if (win.matchMedia(BREAKPOINTS.mobileLandscape).matches) return 'mobileLandscape';
  if (win.matchMedia(BREAKPOINTS.mobilePortrait).matches) return 'mobilePortrait';
  return 'base';
}

// Reacts to a breakpoint actually crossing a boundary, using MediaQueryList's
// own 'change' event — the correct, standard mechanism for this, and
// meaningfully more robust than a raw window 'resize' listener: a plain
// resize listener (a) fires on every pixel of a drag, not just at the
// boundary that actually matters, and (b) was found live, during this
// engine's own browser-based validation, to not reliably fire at all under
// some viewport-emulation paths (a devtools-style viewport override cleared
// back to a default size without dispatching a 'resize' event at all, even
// though the underlying media query's match state had genuinely changed).
// matchMedia's own 'change' event does not have either problem — it is
// defined to fire exactly when a query's match state changes, regardless of
// what caused the viewport to change size.
export function watchBreakpointChanges(callback, win) {
  win = win || (typeof window !== 'undefined' ? window : undefined);
  if (!win || !win.matchMedia) return () => {};
  const lists = Object.values(BREAKPOINTS).map((query) => win.matchMedia(query));
  const handler = () => callback(getActiveBreakpoint(win));
  for (const list of lists) list.addEventListener('change', handler);
  return () => { for (const list of lists) list.removeEventListener('change', handler); };
}

// ============================================================
// DOM-structure assertions (ENGINE_API.md's explicit rule): the engine never
// moves DOM nodes to satisfy `position.parent` / `containingBlock` /
// `relativeTo`. It only ever checks that the DOM the host already built
// actually matches what the config claims, and reports a mismatch as a
// validation-shaped error object — never silently fixed either direction.
// ============================================================
export function assertDomStructure(elementId, layoutConfig, registryLookup) {
  const errors = [];
  const position = layoutConfig.position || {};
  if (position.mode === 'flow' && position.parent) {
    const parentEntry = registryLookup(position.parent);
    const selfEntry = registryLookup(elementId);
    if (parentEntry && selfEntry && selfEntry.domNode.parentElement !== parentEntry.domNode) {
      errors.push(
        'Element "' + elementId + '" declares position.parent="' + position.parent + '" (flow mode), ' +
        'but its actual DOM parentElement is not that element\'s domNode. The engine does not reparent ' +
        'DOM nodes — fix the DOM structure to match the config, or update the config to match the DOM.'
      );
    }
  }
  if (position.mode === 'absolute' && position.containingBlock) {
    const cbEntry = registryLookup(position.containingBlock);
    const selfEntry = registryLookup(elementId);
    if (cbEntry && selfEntry && !cbEntry.domNode.contains(selfEntry.domNode)) {
      errors.push(
        'Element "' + elementId + '" declares position.containingBlock="' + position.containingBlock + '", ' +
        'but its domNode is not a descendant of that element\'s domNode. absolute-mode elements must live ' +
        'inside their declared containing block in the real DOM.'
      );
    }
  }
  return errors;
}
