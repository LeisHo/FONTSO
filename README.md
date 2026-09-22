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

## Optional: git-tracked settings (CLAUDE.md §12l)

`localStorage` is the working default and needs no setup. To make a setting
saved on one device visible to every other device and to a Claude Code
session in the same repo, deploy `api/save-settings.js` (a Vercel serverless
function) and set, in that Vercel project's own environment variables:

| Variable | What it is |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT with contents read+write on this repo. Value is in `keyps.txt` under the `GOTHOT` label. |
| `DEV_PANEL_SAVE_SECRET` | Shared token gating *use of* the above. Also in `keyps.txt`. |
| `GITHUB_REPO` | `owner/repo`. No default — the endpoint refuses to run without it rather than guessing. |
| `GITHUB_BRANCH` | Optional, defaults to `main`. |
| `SETTINGS_FILE_PATH` | Optional, defaults to `data/processed/dev-panel-settings.json`. |

Then set `DEV_PANEL_SAVE_SECRET` in `src/main.js` to the same value. Neither
secret's value ever belongs in a committed file. Until that is done, Save
writes to `localStorage` only — which is a supported mode, not a failure.

## Known limitations

See `docs/PROJECT_SUMMARY.txt`'s Known Limitations section for the current,
maintained list — not duplicated here to avoid drift between two copies of
the same information.

## Roadmap

No formal roadmap is tracked separately. See `docs/PROJECT_PROGRESS.md` for
what's currently being worked on and what's next, and `docs/CHANGELOG.txt`
for the full history of what's been built.
