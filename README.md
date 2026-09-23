# FONTSO — <one-line tagline>

<1-3 sentence description: what this project is, what it does. Nothing has
been built on top of the scaffold yet, so this is the first thing to fill in
once the project has an actual purpose.>

Right now FONTSO is a **blank HTML project scaffold**: the workspace-standard
dev panel (`CLAUDE.md` §12) and UI Layout Engine (`CLAUDE.md` §13), wired
together and verified working, with no application features yet.

See `docs/PROJECT_SUMMARY.txt` for the current state (objective, scope,
current state, recent decisions, known limitations, next action — the part
that changes often) and `docs/PROJECT_PROGRESS.md` for what's being worked
on right now. This README stays a short pointer, not a duplicate of either —
don't let real content drift into this file instead of those.

## How to run it

No build step. It is plain HTML/CSS/JS with native ES modules.

```bash
python scripts/active/serve.py 8420
```

Then open <http://localhost:8420/index.html>.

**Do not use `python -m http.server`.** It serves `.mjs` as `text/plain`, and
browsers reject that for `<script type="module">` — every UI Layout Engine
import fails. `scripts/active/serve.py` fixes the MIME types and disables
caching; that is the whole reason it exists.

Opening `index.html` as a bare `file://` URL also will not work, for the same
module-loading reasons. Use the server.

**Dev panel.** Visible on `localhost`, on `127.0.0.1`, over `file://`, or with
`?dev=1` on any URL — never to a normal visitor. Press **D** to hide/show it,
**R** to reset, **Ctrl+Z** to undo.

## Project structure

```
FONTSO/
├── index.html               <page shell + the dev panel's markup (verbatim from the template)>
├── src/
│   ├── main.js              <the host: engine registration, dev-panel groups, persistence>
│   ├── style.css            <the template's dev-panel CSS (verbatim) + this project's own styles>
│   └── devpanel/devPanel.js <the shared dev-panel engine, verbatim — see CLAUDE.md before editing>
├── lib/ui-engine/           <vendored UI Layout Engine v0.2.6 — see CLAUDE.md for re-vendoring>
├── api/save-settings.js     <optional git-tracked settings write-through (§12l)>
├── data/
│   ├── raw/                 <scraped/dumped/regenerable inputs — gitignored>
│   └── processed/           <ui-layout-config.json, and the dev-panel settings log if enabled>
├── docs/                    <PROJECT_SUMMARY.txt, CODE_SUMMARY.txt, PROJECT_PROGRESS.md,
│                             CHANGELOG.txt, HANDOFF.md>
├── scripts/
│   ├── active/serve.py      <the local dev server>
│   └── archive/             <one-off scripts that already did their job>
└── CLAUDE.md                <project conventions, file map, gotchas — read this first>
```

## Deployment (Vercel)

The repository root holds two pages: `index.html`, the workspace-standard
scaffold (which has only the built-in dev-panel groups, by design), and
`lab/index.html`, the Font Path Laboratory, which is the actual project.
Vercel serves the root, so a bare deployment opens on the scaffold and
looks as though every project setting is missing. `vercel.json` therefore
redirects `/` to `/lab/index.html`.

A **redirect**, not a rewrite, deliberately. A rewrite keeps the browser's
URL at `/` while serving `lab/index.html`, so every relative path in that
page (`src/app.mjs`, `devpanel.css`, `test-fonts/manifest.json`) would
resolve against the root instead of `/lab/` and 404. `permanent: false`
(307) on purpose: a permanent redirect is cached hard by browsers and is
painful to undo. The scaffold stays reachable at `/index.html`.

`vercel.json` carries no explanatory keys. Vercel validates the file
against a strict schema and **fails the build on any unrecognised
top-level property** — an earlier version with a `_comment_redirect` array
was silently rejected, and the previous deployment kept being served with
no obvious sign anything was wrong. Comments belong here, not in that file.

Two things are deliberately absent from the deployment:

- **Eight bundled fonts, all open-licence.** As of 2026-09-23 the
  deployment serves an OFL / Apache-2.0 set (Arimo, Tinos, Gelasio,
  Cousine, Comic Neue, Caveat, Shadows Into Light, Dancing Script) chosen
  to reproduce the range of skeleton behaviour the pipeline needs to be
  tested against. See `lab/test-fonts/LICENSES.md` for each one's licence
  and upstream source. Every other font binary stays gitignored:
  proprietary faces copied in locally still appear in the dropdown marked
  `[local only]` and are not deployed. The picker HEAD-probes each entry
  before offering it, so it never advertises a font it cannot load.
- **`/api/fonts` does not exist.** It is an endpoint of the local
  `scripts/active/serve.py` only.

## Optional: git-tracked settings (CLAUDE.md §12l)

`localStorage` is the working default and needs no setup. To make a setting
saved on one device visible to every other device and to a Claude Code
session in the same repo, deploy `api/save-settings.js` (a Vercel serverless
function) and set, in that Vercel project's own environment variables:

| Variable | What it is |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT with contents read+write on this repo. Value is in `keyps.txt` under the `GOTHOT` label. |
| `DEV_PANEL_SAVE_SECRET` | Shared token gating *use of* the above. Also in `keyps.txt`. |
| `GITHUB_REPO` | `owner/repo`. **Optional since 2026-09-23** — falls back to Vercel's own `VERCEL_GIT_REPO_OWNER`/`VERCEL_GIT_REPO_SLUG`, the deployment's real git origin. Set it only to write settings into a *different* repo from the one deployed. |
| `GITHUB_BRANCH` | Optional, defaults to `main`. |
| `SETTINGS_FILE_PATH` | Optional, defaults to `data/processed/dev-panel-settings.json`. |

Then give each browser the same secret **once**, from the console on the
deployed page:

```
fontLab.setSaveSecret('<the DEV_PANEL_SAVE_SECRET value>')
```

It is stored per-device in `localStorage`, never in a committed file. This
is deliberate: `lab/src/app.mjs` is served to every visitor and lives in a
public repo, so a hardcoded constant there would be readable by anyone and
would only *look* like a secret. Check with `fontLab.hasSaveSecret()` and
clear with `fontLab.setSaveSecret(null)`.

Until that is done, Save writes to `localStorage` only — a supported mode,
not a failure. A save attempt without the secret returns `401
Unauthorized`; a `500 Server not configured` means a Vercel environment
variable is missing instead, and the message names which.

## Known limitations

See `docs/PROJECT_SUMMARY.txt`'s Known Limitations section for the current,
maintained list — not duplicated here to avoid drift between two copies of
the same information.

## Roadmap

No formal roadmap is tracked separately. See `docs/PROJECT_PROGRESS.md` for
what's currently being worked on and what's next, and `docs/CHANGELOG.txt`
for the full history of what's been built.
