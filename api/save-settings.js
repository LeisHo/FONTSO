// Vercel serverless function backing the dev panel's Save/Sync button and
// the UI Layout Engine's own persistence (global CLAUDE.md §12l — the
// OPTIONAL git-tracked settings-log upgrade; localStorage remains the
// working default and the automatic fallback whenever this endpoint isn't
// reachable, which includes every file:// and plain-static-server run).
//
// POST commits the posted JSON object to SETTINGS_FILE_PATH in this repo
// via GitHub's Contents API, so any device/browser sees the same saved
// state — not just the one that clicked Save. GET reads that same file
// back LIVE from the Contents API rather than from the same-origin static
// copy, which only ever reflects the last Vercel deployment.
//
// Required Vercel project environment variables (see README.md):
//   GITHUB_TOKEN           - fine-grained PAT, contents:read+write on this repo
//   DEV_PANEL_SAVE_SECRET  - shared anti-abuse token, must match the client's copy (POST only)
//   GITHUB_REPO            - "owner/repo". OPTIONAL as of 2026-09-23: when it
//                            is unset, the repo is taken from Vercel's own
//                            VERCEL_GIT_REPO_OWNER / VERCEL_GIT_REPO_SLUG,
//                            which Vercel injects automatically for a
//                            git-connected project. That is the deployment's
//                            authoritative git metadata, not a guessed
//                            default, so it cannot point somewhere
//                            unintended the way a hardcoded fallback could -
//                            which was the original reason for having none.
//                            An explicit GITHUB_REPO still wins, for the case
//                            where settings belong in a DIFFERENT repo from
//                            the one being deployed. Missing GITHUB_REPO was
//                            the sole reason every Sync 500d in practice.
// Optional (defaulted below):
//   GITHUB_BRANCH          - defaults to "main"
//   SETTINGS_FILE_PATH     - defaults to "data/processed/dev-panel-settings.json"
//
// Both secrets' real VALUES live in J:\CLAUDE\PROJECTS\keyps.txt (GITHUB_TOKEN
// under the "GOTHOT" label) and are set in Vercel's own environment-variable
// UI — never committed here, never shipped to the client.

// Where the settings file lives. An explicit GITHUB_REPO wins; otherwise
// this deployment's own git origin, which Vercel provides.
function resolveRepo() {
    const explicit = (process.env.GITHUB_REPO || '').trim();
    if (explicit) return explicit;
    const owner = (process.env.VERCEL_GIT_REPO_OWNER || '').trim();
    const slug = (process.env.VERCEL_GIT_REPO_SLUG || '').trim();
    return owner && slug ? `${owner}/${slug}` : '';
}

const DEFAULT_BRANCH = 'main';
const DEFAULT_PATH = 'data/processed/dev-panel-settings.json';

module.exports = async (req, res) => {
    if (req.method !== 'POST' && req.method !== 'GET') {
        res.status(405).json({ ok: false, error: 'Method not allowed' });
        return;
    }

    const token = process.env.GITHUB_TOKEN;
    const secret = process.env.DEV_PANEL_SAVE_SECRET;
    const repo = resolveRepo();
    const missing = [];
    // A PUBLIC repo's contents are readable anonymously, so a read does not
    // need the token. Keeping GET alive without it means a deployment that
    // has lost its token still RESTORES saved settings and fonts; only
    // saving breaks. Writing always needs it.
    if (!token && req.method === 'POST') missing.push('GITHUB_TOKEN');
    if (!repo) missing.push('GITHUB_REPO (and no VERCEL_GIT_REPO_OWNER/SLUG to fall back on)');
    if (req.method === 'POST' && !secret) missing.push('DEV_PANEL_SAVE_SECRET');
    if (missing.length) {
        res.status(500).json({ ok: false, error: `Server not configured - missing: ${missing.join(', ')}` });
        return;
    }
    if (req.method === 'POST' && req.headers['x-dev-panel-secret'] !== secret) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
    }

    const branch = process.env.GITHUB_BRANCH || DEFAULT_BRANCH;
    const settingsPath = process.env.SETTINGS_FILE_PATH || DEFAULT_PATH;
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${settingsPath}`;
    const headers = {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
    };

    if (req.method === 'GET') {
        try {
            const getResp = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers, cache: 'no-store' });
            if (getResp.status === 404) {
                res.status(200).json({ ok: true, settings: null });
                return;
            }
            if (!getResp.ok) {
                const errText = await getResp.text();
                res.status(502).json({ ok: false, error: `GitHub lookup failed (${getResp.status}): ${errText}` });
                return;
            }
            const getData = await getResp.json();
            const jsonText = Buffer.from(getData.content || '', 'base64').toString('utf-8');
            res.status(200).json({ ok: true, settings: JSON.parse(jsonText) });
        } catch (err) {
            res.status(500).json({ ok: false, error: String((err && err.message) || err) });
        }
        return;
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ ok: false, error: 'Body must be a JSON object' });
        return;
    }

    // The posted shape is { settings, files } (see lab/src/app.mjs's
    // remoteSave). BINARY ASSETS GO IN AS THEIR OWN FILES, never embedded
    // in the settings document - a font is 250KB-1.8MB, base64 inflates it
    // by a third, and Sync rewrites the settings document on every run, so
    // embedding would mean a fresh multi-megabyte git object every save.
    // fontStore.mjs explains the reasoning at length.
    //
    // This half existed only in scripts/active/serve.py and never here,
    // which is why imported fonts persisted on a local server and silently
    // never did on the deployment: this function committed the WHOLE body
    // as the settings file, embedding the font bytes and reporting no
    // written files. Kept deliberately parallel to serve.py's version.
    try {
        const written = [];

        for (const f of (Array.isArray(body.files) ? body.files : [])) {
            const filePath = String((f && f.path) || '');
            // The path comes from the client and the token behind this call
            // can write anywhere in the repo, so anything that could climb
            // out of the intended directory is refused outright rather than
            // normalised into something that merely looks safe.
            if (!filePath || filePath.includes('..') || filePath.startsWith('/')) {
                res.status(400).json({ ok: false, error: `Refusing suspicious path: ${JSON.stringify(filePath)}` });
                return;
            }
            const r = await putFile(filePath, String((f && f.contentBase64) || ''),
                (f && f.message) || `Add ${filePath} via Font Path Laboratory`);
            if (!r.ok) {
                res.status(502).json({ ok: false, error: `Write failed for ${filePath}: ${r.error}` });
                return;
            }
            written.push(filePath);
        }

        let commitSha;
        if (body.settings !== undefined && body.settings !== null) {
            const content = Buffer.from(JSON.stringify(body.settings, null, 2) + '\n', 'utf-8').toString('base64');
            const r = await putFile(settingsPath, content, 'Update dev-panel-settings.json via Save Settings');
            if (!r.ok) {
                res.status(502).json({ ok: false, error: `Settings write failed: ${r.error}` });
                return;
            }
            written.push(settingsPath);
            commitSha = r.commitSha;
        }

        res.status(200).json({ ok: true, written, commitSha });
    } catch (err) {
        res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }

    // Create-or-update one file. The Contents API needs the existing blob
    // sha to update and fails without it on an existing file, so the sha is
    // looked up first; a 404 there simply means "create".
    async function putFile(filePath, contentBase64, message) {
        const url = `https://api.github.com/repos/${repo}/contents/${filePath}`;
        let sha;
        const head = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
        if (head.ok) {
            const d = await head.json();
            sha = d.sha;
        } else if (head.status !== 404) {
            return { ok: false, error: `lookup ${head.status}: ${await head.text()}` };
        }
        const put = await fetch(url, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ message, content: contentBase64, branch, ...(sha ? { sha } : {}) }),
        });
        if (!put.ok) return { ok: false, error: `${put.status}: ${await put.text()}` };
        const d = await put.json();
        return { ok: true, commitSha: d.commit && d.commit.sha };
    }
};
