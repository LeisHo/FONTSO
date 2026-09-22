// ui-layout-engine v0.2.0 — canonical source: J:\CLAUDE\PROJECTS\HTML UI ENGINE\canonicalSchema.mjs
//
// Canonical Inspector Schema — the hierarchical tree layer a host Dev Panel
// (Clicko's, or the standalone demo's own) renders. This is deliberately a
// thin, generic layer OVER the existing FIELDS/MODE_SCHEMA (schema.mjs) —
// it does not redefine field semantics (type/default/control/resolver),
// it only organizes already-defined fields into a stable, ordered,
// group/nested-group/setting hierarchy. "If a field already has canonical
// metadata in FIELDS, reuse it" — this module never duplicates that.
//
// Node shape (pure data):
//   { id, type: 'group' | 'setting', parentId, order, label, control?, tier? }
// `id` is a STABLE identifier, never a displayed label and never a DOM id —
// for a group it's a short slug ('position', 'size-width', ...); for a
// setting it's the field's own FIELDS key ('anchorH', 'offsetX', ...),
// which is already globally stable within this engine (schema.mjs's own
// single source of truth for field identity — reused here, not redefined).

import { FIELDS, MODE_SCHEMA, SIZE_AXIS_MODE_SCHEMA } from './schema.mjs';

// ============================================================
// Generic tree primitives — know nothing about layout/position/size. Any
// host or future engine subsystem building its own canonical tree (per
// Architecture Section 20's extensibility note — typography/visibility/
// interaction, not implemented here) reuses these same functions.
// ============================================================

export function validateCanonicalTree(nodes) {
  const errors = [];
  const seenIds = new Set();
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const node of nodes) {
    if (seenIds.has(node.id)) errors.push('duplicate canonical id "' + node.id + '"');
    seenIds.add(node.id);
    if (!['group', 'setting'].includes(node.type)) errors.push('node "' + node.id + '" has invalid type "' + node.type + '"');
    if (node.parentId !== null && !byId.has(node.parentId)) {
      errors.push('node "' + node.id + '" has parentId "' + node.parentId + '" which does not exist in this tree');
    }
    if (typeof node.order !== 'number') errors.push('node "' + node.id + '" has non-numeric order');
  }

  // Deterministic ordering check: no two siblings (same parentId) share an order value.
  const siblingOrders = new Map();
  for (const node of nodes) {
    const key = String(node.parentId);
    if (!siblingOrders.has(key)) siblingOrders.set(key, new Set());
    const orders = siblingOrders.get(key);
    if (orders.has(node.order)) errors.push('siblings under parentId "' + node.parentId + '" share order value ' + node.order + ' (must be unique among siblings)');
    orders.add(node.order);
  }

  return errors;
}

// Depth-first, order-respecting flat list — the form a host Dev Panel
// actually renders from. Each entry also carries `depth` and `path`
// (ancestor id chain) since a host commonly needs both.
export function flattenCanonicalTree(nodes) {
  const byParent = new Map();
  for (const node of nodes) {
    const key = String(node.parentId);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(node);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order);

  const out = [];
  function walk(parentId, depth, path) {
    const children = byParent.get(String(parentId)) || [];
    for (const node of children) {
      out.push({ ...node, depth, path: [...path, node.id] });
      if (node.type === 'group') walk(node.id, depth + 1, [...path, node.id]);
    }
  }
  walk(null, 0, []);
  return out;
}

export function findCanonicalNode(nodes, id) {
  return nodes.find((n) => n.id === id) || null;
}

export function getAncestorIds(nodes, id) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ancestors = [];
  let current = byId.get(id);
  while (current && current.parentId !== null) {
    ancestors.unshift(current.parentId);
    current = byId.get(current.parentId);
  }
  return ancestors;
}

// Prunes a flat canonical node list down to only the settings whose id is
// in `fieldKeys`, PLUS every ancestor group needed to reach them — this is
// the exact mechanism behind "Mobile Portrait shows only its overrides,
// with ancestors retained, never flattened" (Architecture request point 6).
// Returns [] (an empty tree) if fieldKeys is empty — the host then renders
// its own "No overrides" empty state, not this module's concern.
export function filterCanonicalTreeToFieldKeys(nodes, fieldKeys) {
  if (!fieldKeys || fieldKeys.length === 0) return [];
  const keepIds = new Set();
  for (const key of fieldKeys) {
    keepIds.add(key);
    for (const ancestorId of getAncestorIds(nodes, key)) keepIds.add(ancestorId);
  }
  return nodes.filter((n) => keepIds.has(n.id));
}

// ============================================================
// Layout-specific canonical tree builder — the one piece that DOES know
// about position/size/constraints, because that's this engine's actual
// domain. Auto-derives a tree from an element's CURRENT mode (which
// FIELDS/MODE_SCHEMA already fully describe) — this is "reuse FIELDS,
// don't duplicate" made concrete: no group/setting here is hand-authored
// per element, the tree is a direct, mechanical projection of the schema
// data that already exists.
//
// Shape produced (2 levels of grouping under the element root, matching
// the depth the architecture's own worked examples show):
//   <elementId>              (root group)
//     position                 (group)
//       <mode's own required+optional fields>   (settings)
//     size-width                (group)
//       <axis mode's own fields>
//     size-height               (group)
//       <axis mode's own fields>
//     constraints                (group)
//       keepInsideViewport, keepInsideParent    (settings)
// ============================================================
// v0.2.6 — each top-level group (position / size-width / size-height /
// constraints) is now only included when the host's OWN raw layoutConfig
// actually configured that section, not unconditionally. Previously every
// element showed all 4 groups regardless — including an inert, never-
// configured Position section on a Font-Size-only registration, or an
// inert Size/Constraints pair on a Position-only one — real noise once a
// host registers many single-purpose elements (Clicko's Stage 2 system:
// one engine element per logical PROPERTY of a real on-screen object, e.g.
// "High Score: Font Size" is its own element with no real position config
// at all). Direct report, once Clicko hit this in practice: "Only show the
// relevant settings in the UI inspector. So if the selected object/
// property doesn't require a gap or Target anchor or whatever, don't show
// those settings." A group with mode-specific fields already filtered
// correctly by CURRENT mode (the loops below); this is the same filtering
// one level up, by WHETHER the section was configured at all. `parent`
// mode's own group presence is unaffected either way — 'flow' mode's own
// `position` group still renders since `layoutConfig.position` is present,
// same as every mode.
export function buildElementCanonicalTree(elementId, layoutConfig) {
  const nodes = [];
  nodes.push({ id: elementId, type: 'group', parentId: null, order: 0, label: elementId });

  // position
  if (layoutConfig.position) {
    const mode = layoutConfig.position.mode;
    nodes.push({ id: 'position', type: 'group', parentId: elementId, order: 0, label: 'Position' });
    if (mode && MODE_SCHEMA[mode]) {
      const { required, optional } = MODE_SCHEMA[mode];
      [...required, ...optional].forEach((fieldKey, i) => {
        nodes.push({
          id: fieldKey, type: 'setting', parentId: 'position', order: i,
          label: fieldKey, control: FIELDS[fieldKey].control, tier: FIELDS[fieldKey].tier,
        });
      });
    }
  }

  // size (one group per axis, only when that axis was actually configured)
  ['width', 'height'].forEach((axis, axisIndex) => {
    const axisConfig = layoutConfig.size && layoutConfig.size[axis];
    if (!axisConfig) return;
    const groupId = 'size-' + axis;
    nodes.push({ id: groupId, type: 'group', parentId: elementId, order: 1 + axisIndex, label: 'Size — ' + axis[0].toUpperCase() + axis.slice(1) });
    const axisMode = axisConfig.mode;
    if (axisMode && SIZE_AXIS_MODE_SCHEMA[axisMode]) {
      const modeDef = SIZE_AXIS_MODE_SCHEMA[axisMode];
      [...modeDef.required, ...modeDef.optional].forEach((suffix, i) => {
        const fieldKey = axis + suffix;
        nodes.push({
          id: fieldKey, type: 'setting', parentId: groupId, order: i,
          label: fieldKey, control: FIELDS[fieldKey].control, tier: FIELDS[fieldKey].tier,
        });
      });
    }
  });

  // constraints — only when the host explicitly configured at least one
  // (constraints are always-optional, not mode-dispatched, so "configured"
  // just means the `constraints` object was provided at all). No id
  // collision risk with position/size field keys, so this uses the exact
  // same id === fieldKey convention as every other setting node.
  if (layoutConfig.constraints) {
    nodes.push({ id: 'constraints', type: 'group', parentId: elementId, order: 3, label: 'Constraints' });
    ['keepInsideViewport', 'keepInsideParent'].forEach((fieldKey, i) => {
      nodes.push({
        id: fieldKey, type: 'setting', parentId: 'constraints', order: i,
        label: fieldKey, control: FIELDS[fieldKey].control, tier: FIELDS[fieldKey].tier,
      });
    });
  }

  return nodes;
}

// ============================================================
// Mode-switch skeletons — given a newly-chosen mode, returns a fresh,
// valid, fully-seeded position/size-axis config block (every required
// field filled from FIELDS' own defaults). This is engine-owned semantic
// default derivation, not Inspector presentation logic — moved here from
// the Inspector in v0.2.0 so any host (not just the standalone Inspector)
// switching a mode gets the same correct, schema-driven defaults, via the
// adapter's setPositionMode()/setSizeMode(). Used together with
// registry.mjs's replaceLayoutNode() (a WHOLESALE replace — see that
// function's own comment for the real stale-field bug this combination
// avoids).
// ============================================================
export function skeletonForPositionMode(mode) {
  const { required } = MODE_SCHEMA[mode];
  let skeleton = { mode };
  for (const field of required) skeleton = writeSkeletonField(skeleton, field, FIELDS[field].default);
  return skeleton;
}

function writeSkeletonField(skeleton, field, value) {
  if (field === 'anchorH') return { ...skeleton, horizontal: { ...(skeleton.horizontal || {}), anchor: value } };
  if (field === 'anchorV') return { ...skeleton, vertical: { ...(skeleton.vertical || {}), anchor: value } };
  if (field === 'offsetX') return { ...skeleton, horizontal: { ...(skeleton.horizontal || {}), offset: value } };
  if (field === 'offsetY') return { ...skeleton, vertical: { ...(skeleton.vertical || {}), offset: value } };
  return { ...skeleton, [field]: value };
}

export function skeletonForSizeMode(axis, mode) {
  const modeDef = SIZE_AXIS_MODE_SCHEMA[mode];
  const skeleton = { mode };
  for (const suffix of modeDef.required) {
    const key = suffix.charAt(0).toLowerCase() + suffix.slice(1);
    skeleton[key] = FIELDS[axis + suffix].default;
  }
  return skeleton;
}
