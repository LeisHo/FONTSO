# FONTSO — Project Conventions

Two things live here:

1. **`lab/` — the Font Path Laboratory.** The live project: a geometry
   feasibility prototype converting arbitrary font glyphs into drawable
   centreline paths automatically. This is what FONTSO is *for*. It has
   its own `lab/README.md` covering architecture, method, limitations
   and next steps — read that before touching pipeline code.
2. **The root HTML scaffold.** The workspace-standard dev panel (§12)
   and UI Layout Engine (§13), built first and verified working, but
   **not used by the laboratory** — the brief for the lab asked for
   minimal debugging chrome, so it has plain controls instead. Kept
   because it is the workspace standard if this project grows a real
   front end.

`docs/PROJECT_SUMMARY.txt`, `docs/CODE_SUMMARY.txt` and
`docs/PROJECT_PROGRESS.md` are now filled in (they were blank templates
only while the scaffold had no purpose).

## Laboratory notes (`lab/`)

The full file map, architecture, algorithmic decisions and gotchas are
in `docs/CODE_SUMMARY.txt` and `lab/README.md`, not duplicated here.
The four rules most likely to be broken by a later session:

- **Every tunable number lives in `lab/src/config.mjs`**, each with a
  note on what breaks at either extreme. No stage hard-codes a
  threshold; don't start. Adding a key there and listing it in
  `app.mjs`'s `CONFIG_GROUPS` is all that is needed to get a wired,
  labelled dev-panel control for it.
- **Config controls are wired by ONE delegated listener on the panel**,
  not per element. Per-element wiring only reaches Desktop controls; a
  Mobile/Landscape twin is created later, on demand, and would drive
  nothing. All three tabs share one config value on purpose — a glyph's
  skeleton does not depend on the viewport.
- **Pixel classification uses the CROSSING NUMBER, never the 8-neighbour
  count.** A diagonal staircase corner has three neighbours and is not a
  junction. Getting this wrong reported 23 junctions on an `O`.
- **"Real or noise?" is decided on SOURCE MASK AREA, never skeleton
  length.** By length a dot and an anti-aliasing speck are identical.
- **Never delete a tiny self-loop's pixels — only its edge.** Those
  pixels are a junction's connective tissue; deleting them severs the
  glyph.

`lab/` deliberately does **not** import anything from the root scaffold.
Keep it self-contained: it is meant to be liftable into another project
as a geometry engine.

## File map (root scaffold)

- `index.html` — page shell. The dev-panel markup between the two
  `PROJECT: your own game content goes ...` markers, and the tiny
  `html.dev-mode` `<head>` script above it, are copied **verbatim** from
  `.claude/TEMPLATE_DEV_PANEL.html`. Everything else (the `#appStage`
  block, the two `<link>`s, the two `<script>`s) is this project's.
  **Script order is load-bearing — see its own `<head>` comment.**
- `src/main.js` — the host. Engine registration, the active-context
  bridge, `window.renderFontsoDevGroups`, and persistence. This is where
  every new feature's state and dev-panel group belongs.
- `src/style.css` — the template's `<style>` block verbatim (Part 1),
  then this project's own page styling and the Inspector's host-side
  chrome (Part 2). The banner comment marks the boundary.
- `src/devpanel/devPanel.js` — the template's `<script>` block verbatim,
  differing by **exactly one inserted line** at the template's own
  documented `[JS-14]` splice point (`window.renderFontsoDevGroups`).
- `lib/ui-engine/` — vendored UI Layout Engine **v0.2.6**, byte-identical
  to `J:\CLAUDE\PROJECTS\HTML UI ENGINE\` as of 2026-09-22.
- `data/processed/ui-layout-config.json` — git-tracked layout *intent*,
  one entry per registered element. Not resolved geometry.
- `api/save-settings.js` — the optional §12l git-tracked write-through.
  Inert until its env vars and the client-side secret are configured;
  `localStorage` carries everything until then.
- `scripts/active/serve.py` — the local dev server. Required, not
  optional — see README.
- `data/raw/inherited-handyset-2026-09-22/` — the HANDYSET files this
  folder contained before it became FONTSO, moved aside rather than
  deleted (§11: "nothing gets deleted by default"). Gitignored. Nothing
  live reads them; safe to delete deliberately once you're sure.

## Untouchable systems

- **`src/devpanel/devPanel.js` is a verbatim copy and must stay one.** Do
  not fix a dev-panel bug here. Fix it in
  `.claude/TEMPLATE_DEV_PANEL.html` first (via
  `.claude/scripts/edit-template-dev-panel.js`), then re-copy its
  `<script>` block and re-apply the single splice line. The same rule
  applies to Part 1 of `src/style.css` and the template-derived markup in
  `index.html`. Every per-project divergence in this file is exactly what
  the shared template exists to prevent.
- **`lib/ui-engine/*` is vendored, not authored here.** A genuine engine
  gap gets fixed in `HTML UI ENGINE/` (with a test and a CHANGELOG entry,
  grounded in this project's real code — §13's evidence-first rule), then
  re-vendored. Never patch the vendored copy in place; `diff -q` against
  the canonical source first to scope what actually changed.

## Vocabulary

- **Tab** (dev panel) — Desktop / Mobile / Landscape.
- **Context** (UI engine) — `base` / `mobilePortrait` / `mobileLandscape`.
  `src/main.js`'s `ENGINE_CONTEXT_BY_TAB` is the mapping between the two,
  and the host pushes its own determination into the engine so they can
  never disagree (`DEV_PANEL_ADAPTER.md` §13.1).
- **Splice point** — the one line inside `ensureDevPanelBuilt()` where the
  template hands control to a project's own `render*` functions.

## Known gotchas

Most are inherited from sibling projects built on the same two systems and
have not been re-hit here; they are recorded so nobody re-discovers them.
The two marked "Hit here" were hit in this project and are not theoretical.

- **`registerDevControlArray()` is required, not optional cleanup.**
  Without it, a control's "Show in Mobile/Landscape" checkbox toggles,
  cascades, saves and loads perfectly — and creates no row, ever, with no
  error anywhere. `src/main.js`'s `addRow()` collects every control so the
  registration cannot be forgotten. After wiring any new control, **click
  its checkbox and confirm the row actually appears on the Mobile tab** —
  reading the code is not sufficient to catch this one.
- **`ctrl.tab` must be `'desktop'`** on a Desktop control, or
  `buildUniformControlRow()` attaches the wrong per-row device checkbox.
  `addRow()` sets it centrally for exactly this reason.
- **Bump `FONTSO_SETTINGS_SCHEMA_VERSION`** (top of `src/main.js`) for any
  structural dev-panel change — a group/row rename, split, merge, or id
  change. A stale save otherwise restores the old layout *on top of* the
  new one (`applySectionOrder()` appends an unmatched group instead of
  replacing it), producing duplicate groups and rows with dead ids.
- **Bump `?v=` on both `<script>` tags** in `index.html` when their
  content changes. `serve.py` sends `Cache-Control: no-store`, but a
  deployed static host will not.
- **Never blind-POST to the settings endpoint.** `remotePutSettings()`
  does GET → merge → POST because the file holds several independent
  top-level keys (`devPanel`, `uiLayoutConfig`) written by different code
  paths; a blind overwrite from either silently erases the other. Any new
  top-level key needs the same discipline everywhere it is written.
- **`vercel.json` must contain no explanatory keys.** Vercel validates it
  against a strict schema and **fails the build on any unrecognised
  top-level property** — and a failed build keeps serving the previous
  deployment, so the site simply does not change and nothing in the
  served page says why. A `_comment_redirect` array cost 16 minutes of
  polling a deployment that was never coming. Put the rationale in
  `README.md`'s Deployment section. (Hit here, 2026-09-22 — unlike the
  rest of this list.)
- **The deployment root is the blank scaffold, not the lab.** The
  repository root holds both `index.html` (scaffold) and
  `lab/index.html` (the project); `vercel.json` redirects `/` to the
  latter. It must stay a **redirect, not a rewrite** — a rewrite keeps
  the URL at `/`, so every relative path in `lab/index.html` resolves
  against the root and 404s. (Hit here, 2026-09-22.)
- **There are TWO server implementations of `/api/save-settings` and they
  must be kept in step.** `scripts/active/serve.py` (local) and
  `api/save-settings.js` (Vercel) both answer the same endpoint for the
  same client. Font saving was written into the Python one only, so
  imported fonts persisted locally and silently never did on the
  deployment - and the JS one meanwhile committed the whole POST body,
  embedding font bytes into the settings document. When you change
  either side's request or response contract, change both, and test
  against the DEPLOYMENT rather than the local server, which is the half
  that was already correct. (Hit here, 2026-09-23.)
- **Any early return in `serve.py`'s `do_POST` must read the request body
  first.** The connection is HTTP/1.1 keep-alive, so an unread body stays
  in the socket buffer and the next request parse reads it as a request
  line - producing `400 Bad request version ('Tween":null,...')` and
  `414 Request-URI Too Long`, a dead connection, and an opaque "Failed to
  fetch" in the browser instead of the error the server actually sent. It
  only shows up once a POST carries a font, because a small body fits in
  the buffer and a large one does not. (Hit here, 2026-09-23.)
- **`python -m http.server` cannot serve this project** — it sends `.mjs`
  as `text/plain` and every engine import fails. Use `serve.py`.
- **A local static server in the Claude Code sandbox can intermittently
  half-deliver a large script** (`200 OK` alongside
  `net::ERR_CONNECTION_RESET`). If the dev panel loads with empty groups
  and its globals are missing, retry the navigation before assuming a
  code regression. `devPanel.js` is ~4,570 lines.
- **`javascript_tool` eval cannot see page globals**, and a module's
  top-level declarations are not globals at all. To exercise host logic
  from a test, drive the real UI or patch a genuinely global API
  (`window.fetch`) rather than calling a function by name.

## Deliberate architecture exceptions

- **The "UI Layout" Inspector group is panel-level, not per-tab.** It sits
  outside `#desktopTabContent`/`#mobileTabContent`/`#landscapeTabContent`,
  beside "Saved Dev Settings" — the same precedent §12d sets, for the same
  reason: the Inspector carries its own Base / Mobile Portrait / Mobile
  Landscape context tabs, so one instance already covers all three. It
  would also mirror into the other tabs as an empty shell if it lived
  inside them, since cross-tab mirroring can only copy *registered control
  rows* (the same reason the built-in "Mouse Log" is excluded by name).
- **`lab/` now uses the standard dev panel (§12); it does NOT use the UI
  Layout Engine (§13).** Superseding the earlier note here that said it
  used neither — the panel was adopted on 2026-09-22 and every
  laboratory control lives in it. The engine is still not used: the lab
  has exactly one layout element (a full-bleed canvas), so there is no
  positioning intent for it to manage. Revisit only if the lab grows
  real UI geometry.
- **`lab/devpanel.js` and `lab/devpanel.css` are a SECOND verbatim copy
  of the template**, independent of the root scaffold's copy in `src/`.
  Two copies is deliberate: `lab/` is meant to be liftable into another
  project whole, which a shared import across the two would prevent.
  Both must be re-copied from the template when it changes.

## Divergences from the shared template (keep this list at zero-ish)

Every item here is a place this project is *not* byte-identical to
`.claude/TEMPLATE_DEV_PANEL.html`. Adding to it should feel expensive.

1. `src/devpanel/devPanel.js`: one inserted line (the splice point) plus a
   5-line comment explaining it.
2. `src/style.css` / `index.html`: a provenance header comment above the
   verbatim template content, and this project's own content appended
   after it. The template content itself is unmodified.

Note for a future maintainer: a sibling project (HANDYSET) added a
per-group cascade-**retention** feature to its own copy of `devPanel.js`
that was never folded back upstream. It is deliberately **not** carried
here — this project tracks the canonical template. If that feature is
wanted, fold it into the template first, then re-copy.
