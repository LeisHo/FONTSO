// ui-layout-engine v0.1.0 — canonical source: J:\CLAUDE\PROJECTS\HTML UI ENGINE\presets.mjs
//
// Layout Presets — named partial-config objects, deep-merged into an
// element's layout at creation or on demand. Pure data plus one thin
// convenience function; NOT a second positioning system (Architecture
// Section 12). Applying a preset produces nothing but ordinary FIELDS-shaped
// config — nothing about "this element came from a preset" persists.

import { replaceLayoutNode } from './registry.mjs';

export const LAYOUT_PRESETS = {
  'top-left': {
    position: { mode: 'anchor', horizontal: { anchor: 'left', offset: 'token(spacing.md)' }, vertical: { anchor: 'top', offset: 'token(spacing.md)' } },
  },
  'top-right': {
    position: { mode: 'anchor', horizontal: { anchor: 'right', offset: 'token(spacing.md)' }, vertical: { anchor: 'top', offset: 'token(spacing.md)' } },
  },
  'bottom-left': {
    position: { mode: 'anchor', horizontal: { anchor: 'left', offset: 'token(spacing.md)' }, vertical: { anchor: 'bottom', offset: 'token(spacing.md)' } },
  },
  'bottom-right': {
    position: { mode: 'anchor', horizontal: { anchor: 'right', offset: 'token(spacing.md)' }, vertical: { anchor: 'bottom', offset: 'token(spacing.md)' } },
  },
  center: {
    position: { mode: 'fixed', viewportAnchor: 'center' },
  },
  fill: {
    size: { width: { mode: 'fill' }, height: { mode: 'fill' } },
  },
  'centered-modal': {
    position: { mode: 'fixed', viewportAnchor: 'center' },
    size: { width: { mode: 'clamp', min: '280px', preferred: '40vw', max: '480px' } },
  },
  'edge-attached-bottom': {
    position: { mode: 'anchor', horizontal: { anchor: 'center' }, vertical: { anchor: 'bottom', offset: '0px' } },
  },
};

export function applyPreset(elementId, presetName) {
  const preset = LAYOUT_PRESETS[presetName];
  if (!preset) throw new Error('applyPreset: unknown preset "' + presetName + '". Known presets: ' + Object.keys(LAYOUT_PRESETS).join(', '));

  // WHOLESALE replace for position and each size axis, never a deep merge —
  // a preset always defines a COMPLETE, mode-consistent sub-object for
  // whichever layers it touches (see LAYOUT_PRESETS above), and a merge
  // would leave stale fields from the element's PREVIOUS mode behind,
  // exactly like the position/size mode-switch bug replaceLayoutNode()
  // itself documents — found live via this preset system specifically (the
  // "fill" preset applied to a clamp-sized card left a forbidden `max`
  // field behind and failed validation) during this engine's own browser
  // testing. constraints has no mode concept, so it's the one preset layer
  // that's still safe to merge if a future preset ever sets it.
  if (preset.position) replaceLayoutNode(elementId, ['position'], preset.position);
  if (preset.size) {
    for (const axis of Object.keys(preset.size)) {
      replaceLayoutNode(elementId, ['size', axis], preset.size[axis]);
    }
  }
  return elementId;
}

export function listPresetNames() {
  return Object.keys(LAYOUT_PRESETS);
}
