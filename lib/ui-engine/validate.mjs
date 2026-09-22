// ui-layout-engine v0.1.0 — canonical source: J:\CLAUDE\PROJECTS\HTML UI ENGINE\validate.mjs
//
// Validation — checks a layout config against schema.mjs's FIELDS/MODE_SCHEMA,
// and checks schema.mjs itself for internal consistency. This is the concrete
// enforcement mechanism behind Architecture Section 14's intent/geometry
// separation rule: a config field that isn't a legitimate FIELDS entry for
// its mode is rejected here, not silently accepted.

import { FIELDS, MODE_SCHEMA, SIZE_AXIS_MODE_SCHEMA, POSITION_MODES, SIZE_MODES } from './schema.mjs';
import { RESOLVERS, isBlendedLength, isPerAxisGap } from './engine.mjs';

// ============================================================
// validateSchemaIntegrity — a static self-check of schema.mjs + engine.mjs
// together, independent of any element config. Run once at load (and by the
// automated test suite): catches a typo'd resolver name or a mode
// referencing a field that doesn't exist in FIELDS immediately, rather than
// failing silently the first time that field is actually resolved.
// ============================================================
export function validateSchemaIntegrity() {
  const errors = [];

  for (const [mode, def] of Object.entries(MODE_SCHEMA)) {
    for (const field of [...def.required, ...def.optional]) {
      if (!FIELDS[field]) errors.push('MODE_SCHEMA.' + mode + ' references unknown field "' + field + '" (no FIELDS entry).');
    }
  }

  for (const [mode, def] of Object.entries(SIZE_AXIS_MODE_SCHEMA)) {
    for (const suffix of [...def.required, ...def.optional]) {
      for (const axis of ['width', 'height']) {
        const key = axis + suffix;
        if (!FIELDS[key]) errors.push('SIZE_AXIS_MODE_SCHEMA.' + mode + ' implies field "' + key + '" (no FIELDS entry).');
      }
    }
  }

  for (const [field, def] of Object.entries(FIELDS)) {
    if (!RESOLVERS[def.resolver]) {
      errors.push('FIELDS.' + field + ' references unknown resolver "' + def.resolver + '" (no RESOLVERS entry).');
    }
    if (def.type === 'enum' && (!Array.isArray(def.values) || def.values.length === 0)) {
      errors.push('FIELDS.' + field + ' has type "enum" but no non-empty "values" array.');
    }
  }

  return errors;
}

// ============================================================
// derivedForbidden — everything not required/optional for a mode is
// forbidden for it. Computed, never hand-maintained (Architecture Section 9).
// ============================================================
export function derivedForbidden(mode) {
  const def = MODE_SCHEMA[mode];
  if (!def) return Object.keys(FIELDS);
  const allowed = new Set([...def.required, ...def.optional]);
  return Object.keys(FIELDS).filter((f) => !allowed.has(f));
}

function typeCheck(field, value) {
  const def = FIELDS[field];
  if (!def) return 'unknown field "' + field + '"';
  switch (def.type) {
    case 'enum':
      if (!def.values.includes(value)) return 'field "' + field + '" value "' + value + '" is not one of ' + JSON.stringify(def.values);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return 'field "' + field + '" expected boolean, got ' + typeof value;
      break;
    case 'number':
      if (typeof value !== 'number') return 'field "' + field + '" expected number, got ' + typeof value;
      break;
    case 'length':
      // v0.2.3 — a length field also accepts a blended-length object
      // ({pxValue, vwValue, blend, vwUnit?}, see engine.mjs's own header
      // comment on resolveLengthValue()) alongside a plain CSS length
      // string — the SAME 2-representations pattern `token(...)` already
      // established for this type, not a special case bolted on here.
      //
      // v0.2.4 — `gap` SPECIFICALLY also accepts a per-axis object
      // ({x?, y?}, engine.mjs's isPerAxisGap()) — scoped to this one field,
      // not every length field, since a per-axis shape has no sensible
      // meaning for e.g. offsetX (already single-axis by definition); it
      // would silently produce broken CSS there instead of a clear error.
      if (field === 'gap' && isPerAxisGap(value)) {
        const badAxis = ['x', 'y'].find((axis) => value[axis] !== undefined && typeof value[axis] !== 'string' && !isBlendedLength(value[axis]));
        if (badAxis) return 'field "gap.' + badAxis + '" expected a string or a blended-length object, got ' + typeof value[badAxis];
        break;
      }
      if (typeof value !== 'string' && !isBlendedLength(value)) {
        return 'field "' + field + '" (length) expected a string or a blended-length object ({pxValue, vwValue, blend})' +
          (field === 'gap' ? ' or a per-axis object ({x?, y?})' : '') + ', got ' + typeof value;
      }
      break;
    case 'elementRef':
      if (value !== null && typeof value !== 'string') return 'field "' + field + '" (elementRef) expected a string id or null, got ' + typeof value;
      break;
    case 'string':
      if (typeof value !== 'string') return 'field "' + field + '" expected string, got ' + typeof value;
      break;
    default:
      return null;
  }
  return null;
}

// Flattens the YAML-nested position shape (horizontal.anchor, offset.x, ...)
// into the flat field-name keys FIELDS/MODE_SCHEMA use, mirroring
// engine.mjs's readNestedPositionField() so validation checks the exact same
// shape the resolver actually consumes.
const POSITION_STRUCTURAL_KEYS = new Set(['mode', 'horizontal', 'vertical', 'offset']);
const POSITION_KNOWN_FLAT_KEYS = ['parent', 'order', 'alignment', 'relativeTo', 'myAnchor', 'targetAnchor', 'gap', 'containingBlock', 'x', 'y', 'viewportAnchor'];

function flattenPositionFields(position) {
  const flat = {};
  if (position.horizontal && position.horizontal.anchor !== undefined) flat.anchorH = position.horizontal.anchor;
  if (position.vertical && position.vertical.anchor !== undefined) flat.anchorV = position.vertical.anchor;
  const offX = (position.horizontal && position.horizontal.offset) ?? (position.offset && position.offset.x);
  const offY = (position.vertical && position.vertical.offset) ?? (position.offset && position.offset.y);
  if (offX !== undefined) flat.offsetX = offX;
  if (offY !== undefined) flat.offsetY = offY;
  for (const key of POSITION_KNOWN_FLAT_KEYS) {
    if (position[key] !== undefined) flat[key] = position[key];
  }
  // Preserve any OTHER own key verbatim (not one of the structural nesting
  // keys, not already handled above) so an unrecognized/leaked key is still
  // visible to callers like assertNoResolvedGeometryLeak() rather than being
  // silently dropped by this flattening step — a rogue key must be
  // detectable, not filtered out before validation ever sees it.
  for (const key of Object.keys(position)) {
    if (POSITION_STRUCTURAL_KEYS.has(key)) continue;
    if (POSITION_KNOWN_FLAT_KEYS.includes(key)) continue;
    if (flat[key] === undefined) flat[key] = position[key];
  }
  return flat;
}

// ============================================================
// validatePositionConfig — checks one element's position block against its
// declared mode: required present, forbidden absent, values type-check.
// ============================================================
export function validatePositionConfig(position) {
  const errors = [];
  if (!position || !position.mode) {
    errors.push('position.mode is required.');
    return errors;
  }
  if (!POSITION_MODES.includes(position.mode)) {
    errors.push('position.mode "' + position.mode + '" is not one of ' + JSON.stringify(POSITION_MODES));
    return errors;
  }
  const mode = position.mode;
  const { required, optional } = MODE_SCHEMA[mode];
  const forbidden = derivedForbidden(mode);
  const flat = flattenPositionFields(position);

  for (const field of required) {
    if (flat[field] === undefined) errors.push('position (mode: ' + mode + ') is missing required field "' + field + '".');
  }
  for (const field of Object.keys(flat)) {
    if (forbidden.includes(field)) errors.push('position (mode: ' + mode + ') has forbidden field "' + field + '" — not valid for mode "' + mode + '".');
  }
  for (const field of [...required, ...optional]) {
    if (flat[field] === undefined) continue;
    const err = typeCheck(field, flat[field]);
    if (err) errors.push(err);
  }
  return errors;
}

// ============================================================
// validateSizeConfig — checks one axis's size block against its declared
// mode (content/fixed/fill/clamp/aspect/match).
// ============================================================
export function validateSizeConfig(axisConfig, axis) {
  const errors = [];
  if (!axisConfig || !axisConfig.mode) return errors; // size is optional per axis
  if (!SIZE_MODES.includes(axisConfig.mode)) {
    errors.push('size.' + axis + '.mode "' + axisConfig.mode + '" is not one of ' + JSON.stringify(SIZE_MODES));
    return errors;
  }
  const modeDef = SIZE_AXIS_MODE_SCHEMA[axisConfig.mode];
  const cap = axis;
  for (const suffix of modeDef.required) {
    const key = suffix.charAt(0).toLowerCase() + suffix.slice(1);
    if (axisConfig[key] === undefined) errors.push('size.' + axis + ' (mode: ' + axisConfig.mode + ') is missing required "' + key + '".');
  }
  const allowedKeys = new Set([...modeDef.required, ...modeDef.optional].map((s) => s.charAt(0).toLowerCase() + s.slice(1)));
  for (const key of Object.keys(axisConfig)) {
    if (key === 'mode') continue;
    if (!allowedKeys.has(key)) errors.push('size.' + axis + ' (mode: ' + axisConfig.mode + ') has forbidden field "' + key + '".');
  }
  for (const key of allowedKeys) {
    if (axisConfig[key] === undefined) continue;
    const fieldName = cap + key.charAt(0).toUpperCase() + key.slice(1);
    const err = typeCheck(fieldName, axisConfig[key]);
    if (err) errors.push(err);
  }
  return errors;
}

// ============================================================
// validateConstraints — constraints are a flat, always-optional field list;
// only type-checking + "must be a known constraint field" applies.
// ============================================================
export function validateConstraints(constraints) {
  const errors = [];
  if (!constraints) return errors;
  for (const [field, value] of Object.entries(constraints)) {
    if (!FIELDS[field]) {
      errors.push('constraints has unknown field "' + field + '".');
      continue;
    }
    const err = typeCheck(field, value);
    if (err) errors.push(err);
  }
  return errors;
}

// ============================================================
// validateConfig — the full entry point: one element's whole layout config
// (position + size + constraints), NOT including responsive overrides
// (validate those the same way, recursively, per breakpoint, at the call
// site — kept separate here so the core checks stay simple and reusable).
// ============================================================
export function validateConfig(layoutConfig) {
  const errors = [];
  errors.push(...validatePositionConfig(layoutConfig.position));
  if (layoutConfig.size) {
    errors.push(...validateSizeConfig(layoutConfig.size.width, 'width'));
    errors.push(...validateSizeConfig(layoutConfig.size.height, 'height'));
  }
  errors.push(...validateConstraints(layoutConfig.constraints));
  return errors;
}

// ============================================================
// assertNoResolvedGeometryLeak — the concrete, automatable test for
// Architecture Section 14's hard rule: a config must never contain a raw
// resolved-geometry key (things like a literal computed "resolvedX"/"px"
// output) that isn't a legitimate FIELDS entry for the element's mode. Since
// FIELDS only ever contains intent fields, any key present in a config that
// ISN'T in FIELDS at all (not just forbidden-for-this-mode) is flagged
// distinctly, since that's the shape a leaked resolved value would take.
// ============================================================
export function assertNoResolvedGeometryLeak(layoutConfig) {
  const errors = [];
  const flat = flattenPositionFields(layoutConfig.position || {});
  for (const key of Object.keys(flat)) {
    if (!FIELDS[key]) errors.push('position contains key "' + key + '" which is not a real intent field in FIELDS at all — looks like leaked resolved geometry, not configuration.');
  }
  return errors;
}
