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
//   GITHUB_REPO            - "owner/repo". Deliberately has NO default: this
//                            scaffold has no repo yet, and a wrong default
//                            would fail confusingly (or, worse, write
//                            somewhere unintended) instead of saying so.
// Optional (defaulted below):
//   GITHUB_BRANCH          - defaults to "main"
//   SETTINGS_FILE_PATH     - defaults to "data/processed/dev-panel-settings.json"
//
// Both secrets' real VALUES live in J:\CLAUDE\PROJECTS\keyps.txt (GITHUB_TOKEN
// under the "GOTHOT" label) and are set in Vercel's own environment-variable
// UI — never committed here, never shipped to the client.

const DEFAULT_BRANCH = 'main';
const DEFAULT_PATH = 'data/processed/dev-panel-settings.json';

module.exports = async (req, res) => {
    if (req.method !== 'POST' && req.method !== 'GET') {
        res.status(405).json({ ok: false, error: 'Method not allowed' });
        return;
    }

    const token = process.env.GITHUB_TOKEN;
    const secret = process.env.DEV_PANEL_SAVE_SECRET;
    const repo = process.env.GITHUB_REPO;
    const missing = [];
    if (!token) missing.push('GITHUB_TOKEN');
    if (!repo) missing.push('GITHUB_REPO');
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
    const path = process.env.SETTINGS_FILE_PATH || DEFAULT_PATH;
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`;
    const headers = {
        Authorization: `Bearer ${token}`,
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

    try {
        let sha;
        const getResp = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
        if (getResp.ok) {
            const getData = await getResp.json();
            sha = getData.sha;
        } else if (getResp.status !== 404) {
            const errText = await getResp.text();
            res.status(502).json({ ok: false, error: `GitHub lookup failed (${getResp.status}): ${errText}` });
            return;
        }

        const content = Buffer.from(JSON.stringify(body, null, 2) + '\n', 'utf-8').toString('base64');
        const putResp = await fetch(apiUrl, {
            method: 'PUT',
            headers,
            body: JSON.stringify({
                message: 'Update dev-panel-settings.json via Save Settings',
                content,
                branch,
                ...(sha ? { sha } : {}),
            }),
        });

        if (!putResp.ok) {
            const errText = await putResp.text();
            res.status(502).json({ ok: false, error: `GitHub commit failed (${putResp.status}): ${errText}` });
            return;
        }

        const putData = await putResp.json();
        res.status(200).json({ ok: true, commitSha: putData.commit && putData.commit.sha });
    } catch (err) {
        res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
};
