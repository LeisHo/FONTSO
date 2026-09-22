// ui-layout-engine v0.2.0 — canonical source: J:\CLAUDE\PROJECTS\HTML UI ENGINE\adapter.mjs
//
// Host Dev Panel Adapter — the ONE generic boundary between this engine and
// ANY host UI (the standalone demo's own Inspector, or a future Clicko Dev
// Panel). Zero Clicko-specific imports, URLs, group IDs, CSS classes, DOM
// assumptions, or assumptions that the host is even HTML-based. A host
// consumes this adapter's plain-data/function contract and renders it
// however its own chrome/tabs/groups/drag-drop/locks system wants to — see
// docs/DEV_PANEL_ADAPTER.md for the full boundary explanation and how this
// maps onto Clicko's existing group/order/lock/collapse infrastructure.
//
// createInspectorAdapter({ elementId }) returns one adapter scoped to one
// registered element — a host managing many elements creates one adapter
// per element it wants to expose (this mirrors how the engine itself is
// already element-scoped throughout registry.mjs).

import {
  getElement, getEffectiveValue, isFieldOverridden, createOverride, removeOverride,
  setContextValue, getContextState, setContextEnabled, getOverriddenFieldKeys,
  replaceLayoutNode, RESPONSIVE_CONTEXTS,
} from './registry.mjs';
import { applyPreset, listPresetNames } from './presets.mjs';
import {
  buildElementCanonicalTree, filterCanonicalTreeToFieldKeys, flattenCanonicalTree,
  skeletonForPositionMode, skeletonForSizeMode,
} from './canonicalSchema.mjs';

export const ALL_CONTEXTS = ['base', ...RESPONSIVE_CONTEXTS];

export function createInspectorAdapter({ elementId }) {
  function currentTree() {
    const el = getElement(elementId);
    return buildElementCanonicalTree(elementId, el.layout);
  }

  return {
    elementId,

    // ---- Canonical hierarchy (host-agnostic tree data) ----
    listContexts() {
      return [...ALL_CONTEXTS];
    },
    getCanonicalTree() {
      return currentTree();
    },
    // For 'base': the full canonical tree (Architecture point 6: "Base
    // displays the full canonical tree"). For a responsive context: the
    // tree PRUNED to only its overridden settings + their ancestor groups
    // (point 6's "do not show unrelated inherited settings," with ancestors
    // retained per the nested-override example) — [] when there are no
    // overrides yet, which the host renders as its own empty state.
    getContextTree(contextKey) {
      const tree = currentTree();
      if (contextKey === 'base' || !contextKey) return tree;
      const overriddenKeys = getOverriddenFieldKeys(elementId, contextKey);
      return filterCanonicalTreeToFieldKeys(tree, overriddenKeys);
    },
    // The "+ Add Override" source list (Architecture point 7): the FULL
    // canonical hierarchy, exact ordering/nesting, never a flat list — a
    // host's own override-picker UI walks this the same way it would walk
    // getCanonicalTree() for Base.
    getAddOverrideTree() {
      return currentTree();
    },
    flatten(tree) {
      return flattenCanonicalTree(tree);
    },

    // ---- Values ----
    getEffectiveValue(fieldKey, contextKey) {
      return getEffectiveValue(elementId, fieldKey, contextKey);
    },
    isOverridden(fieldKey, contextKey) {
      return contextKey === 'base' ? false : isFieldOverridden(elementId, fieldKey, contextKey);
    },
    // The one "edit this field in this context" entry point — for 'base' a
    // direct edit, for a responsive context the full create-or-update
    // override lifecycle (Architecture point 8), per registry.mjs's own
    // setContextValue().
    setValue(fieldKey, contextKey, value) {
      return setContextValue(elementId, contextKey, fieldKey, value);
    },

    // ---- Override lifecycle (Architecture points 7-9) ----
    createOverride(fieldKey, contextKey) {
      return createOverride(elementId, contextKey, fieldKey);
    },
    removeOverride(fieldKey, contextKey) {
      return removeOverride(elementId, contextKey, fieldKey);
    },
    getOverriddenFieldKeys(contextKey) {
      return getOverriddenFieldKeys(elementId, contextKey);
    },

    // ---- Context state (Architecture point 11) ----
    getContextState(contextKey) {
      if (contextKey === 'base') return { enabled: true };
      return getContextState(elementId, contextKey);
    },
    setContextEnabled(contextKey, enabled) {
      return setContextEnabled(elementId, contextKey, enabled);
    },

    // ---- Mode switching (wholesale replace — see registry.mjs's
    // replaceLayoutNode for why this must never be a merge) ----
    setPositionMode(mode) {
      return replaceLayoutNode(elementId, ['position'], skeletonForPositionMode(mode));
    },
    setSizeMode(axis, mode) {
      return replaceLayoutNode(elementId, ['size', axis], skeletonForSizeMode(axis, mode));
    },

    // ---- Presets ----
    listPresetNames() {
      return listPresetNames();
    },
    applyPreset(presetName) {
      return applyPreset(elementId, presetName);
    },

    // ---- Diagnostics (Architecture/demo point 22's debug view — a
    // read-only dump, never a second production Dev Panel) ----
    getDiagnostics() {
      const el = getElement(elementId);
      const tree = currentTree();
      const contexts = {};
      for (const ctx of RESPONSIVE_CONTEXTS) {
        contexts[ctx] = {
          state: getContextState(elementId, ctx),
          overrides: { ...el.contexts[ctx].overrides },
        };
      }
      const effective = {};
      for (const ctxKey of ALL_CONTEXTS) {
        effective[ctxKey] = {};
        for (const node of flattenCanonicalTree(tree)) {
          if (node.type !== 'setting') continue;
          effective[ctxKey][node.id] = getEffectiveValue(elementId, node.id, ctxKey);
        }
      }
      return { canonicalTree: tree, base: el.layout, contexts, effective };
    },
  };
}
