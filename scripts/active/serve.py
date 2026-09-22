#!/usr/bin/env python3
"""Local static server for FONTSO.

WHY THIS EXISTS (and why `python -m http.server` is NOT enough here):
Python's built-in server does not map the .mjs extension to a JavaScript
MIME type, and browsers enforce strict MIME checking for
<script type="module">. Without this fix every `.mjs` import in
lib/ui-engine/ fails with "Expected a JavaScript-or-Wasm module script but
the server responded with a MIME type of text/plain". Adapted from the UI
Layout Engine's own demo/serve.py, which documents the same gotcha.

It also disables caching, because a plain static server will otherwise
serve a stale src/main.js or src/devpanel/devPanel.js after an edit (the
reason index.html carries ?v= query strings on both).

Usage: python scripts/active/serve.py [port]   (defaults to 8420)
Serves the PROJECT ROOT (two levels up from this file), so index.html's
relative paths resolve exactly as they do on a real deployment.
"""
import base64
import http.server
import json
import os
import sys
import urllib.error
import urllib.request

# ---------------------------------------------------------------------------
# /api/save-settings  --  local stand-in for the Vercel function
# ---------------------------------------------------------------------------
# api/save-settings.js is a Vercel serverless function and this is a static
# file server, so on localhost that endpoint simply 404s -- which meant the
# dev panel's Sync could never reach it during local development, only on a
# deployment. This implements the same contract in-process so Save works
# where the work actually happens.
#
# THE TOKEN IS READ FROM THE ENVIRONMENT ONLY. It is never read from a file,
# never logged, and never echoed in a response. Set it in the shell that
# launches this server:
#     GITHUB_TOKEN=...  GITHUB_REPO=owner/repo  python scripts/active/serve.py
# Without GITHUB_TOKEN the endpoint returns a clear 503 and the browser
# falls back to localStorage, which is the documented default behaviour
# rather than a failure.
GITHUB_API = 'https://api.github.com'


def _gh_config():
    return {
        'token': os.environ.get('GITHUB_TOKEN'),
        'repo': os.environ.get('GITHUB_REPO', 'LeisHo/FONTSO'),
        'branch': os.environ.get('GITHUB_BRANCH', 'main'),
        'settings_path': os.environ.get('SETTINGS_FILE_PATH', 'data/processed/dev-panel-settings.json'),
    }


def _gh_request(url, token, method='GET', payload=None):
    req = urllib.request.Request(url, method=method)
    req.add_header('Authorization', 'Bearer ' + token)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('X-GitHub-Api-Version', '2022-11-28')
    data = None
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, data) as resp:
            return resp.getcode(), json.loads(resp.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(body or '{}')
        except json.JSONDecodeError:
            return e.code, {'message': body[:400]}


def _gh_put_file(cfg, path, content_b64, message):
    """Create or update one file via the Contents API. The API requires the
    current blob sha to update an existing file, so look it up first; a 404
    simply means this is a create."""
    url = f"{GITHUB_API}/repos/{cfg['repo']}/contents/{path}"
    code, body = _gh_request(f"{url}?ref={cfg['branch']}", cfg['token'])
    sha = body.get('sha') if code == 200 else None
    payload = {'message': message, 'content': content_b64, 'branch': cfg['branch']}
    if sha:
        payload['sha'] = sha
    return _gh_request(url, cfg['token'], 'PUT', payload)


def _gh_get_file(cfg, path):
    url = f"{GITHUB_API}/repos/{cfg['repo']}/contents/{path}?ref={cfg['branch']}"
    code, body = _gh_request(url, cfg['token'])
    if code == 404:
        return None
    if code != 200:
        raise RuntimeError(f'GitHub read failed ({code}): {body.get("message")}')
    return base64.b64decode(body.get('content', '') or '')


PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8420
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.mjs': 'text/javascript',
        '.js': 'text/javascript',
        '.json': 'application/json',
    }

    # HTTP/1.1 keep-alive. The default HTTP/1.0 closes the socket after
    # every response, and this server hands out ~20 files per page load;
    # that connection churn is what produced repeated
    # net::ERR_CONNECTION_RESET on the largest file (the vendored
    # opentype.js bundle), which silently broke the whole ES module graph
    # and left the page loading with window.fontLab undefined. Observed
    # repeatedly during development, on that file specifically, because
    # it is by far the biggest.
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Project code must never be cached — a stale main.js after an
        # edit is its own confusing bug. But lib/ holds vendored
        # dependencies that change only when deliberately re-vendored, so
        # letting the browser cache them removes the large-file transfer
        # from every single reload, which is the transfer that kept
        # failing.
        if '/lib/' in self.path:
            self.send_header('Cache-Control', 'public, max-age=3600')
        else:
            self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    # ---- /api/save-settings -------------------------------------------
    def _json(self, code, obj):
        raw = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _is_api(self):
        return self.path.split('?')[0].rstrip('/') == '/api/save-settings'

    def _is_font_list(self):
        return self.path.split('?')[0].rstrip('/') == '/api/fonts'

    # Directory listing of the font folders, so a face dropped into
    # data/Fonts/ appears in the picker with no manifest to maintain.
    # Auto-discovery rather than a checked-in list precisely because a
    # hand-maintained list is the thing that goes stale the first time
    # someone adds a font and forgets.
    def _font_list(self):
        roots = [
            ('data/Fonts', 'data/Fonts'),
            ('lab/test-fonts', 'test-fonts'),
        ]
        exts = ('.ttf', '.otf', '.woff', '.ttc')
        out = []
        for rel, label in roots:
            abs_dir = os.path.join(ROOT, rel)
            if not os.path.isdir(abs_dir):
                continue
            for name in sorted(os.listdir(abs_dir)):
                if not name.lower().endswith(exts):
                    continue
                full = os.path.join(abs_dir, name)
                if not os.path.isfile(full):
                    continue
                out.append({
                    'group': label,
                    'fileName': name,
                    'path': rel + '/' + name,
                    'size': os.path.getsize(full),
                })
        return self._json(200, {'ok': True, 'fonts': out})

    def do_GET(self):
        if self._is_font_list():
            return self._font_list()
        if not self._is_api():
            return super().do_GET()
        cfg = _gh_config()
        if not cfg['token']:
            return self._json(503, {'ok': False, 'error': 'GITHUB_TOKEN not set in this server\'s environment; falling back to localStorage.'})
        try:
            raw = _gh_get_file(cfg, cfg['settings_path'])
            settings = json.loads(raw.decode('utf-8')) if raw else None
            return self._json(200, {'ok': True, 'settings': settings})
        except Exception as e:  # noqa: BLE001 - surfaced to the client verbatim
            return self._json(502, {'ok': False, 'error': str(e)})

    def do_POST(self):
        if not self._is_api():
            return self._json(404, {'ok': False, 'error': 'Not found'})
        cfg = _gh_config()
        if not cfg['token']:
            return self._json(503, {'ok': False, 'error': 'GITHUB_TOKEN not set in this server\'s environment; falling back to localStorage.'})

        secret = os.environ.get('DEV_PANEL_SAVE_SECRET')
        if secret and self.headers.get('x-dev-panel-secret') != secret:
            return self._json(401, {'ok': False, 'error': 'Unauthorized'})

        try:
            length = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
        except Exception as e:  # noqa: BLE001
            return self._json(400, {'ok': False, 'error': f'Bad JSON body: {e}'})

        try:
            written = []
            # Binary assets (fonts) go in as their OWN files, not embedded
            # in the settings document -- see fontStore.mjs for why.
            for f in body.get('files', []) or []:
                path = str(f.get('path', ''))
                if not path or '..' in path or path.startswith('/'):
                    return self._json(400, {'ok': False, 'error': f'Refusing suspicious path: {path!r}'})
                code, resp = _gh_put_file(cfg, path, f.get('contentBase64', ''),
                                          f.get('message') or f'Add {path} via Font Path Laboratory')
                if code not in (200, 201):
                    return self._json(502, {'ok': False, 'error': f'Write failed for {path}: {resp.get("message")}'})
                written.append(path)

            settings = body.get('settings')
            if settings is not None:
                content = base64.b64encode(
                    (json.dumps(settings, indent=2) + '\n').encode('utf-8')).decode('ascii')
                code, resp = _gh_put_file(cfg, cfg['settings_path'], content,
                                          'Update dev-panel-settings.json via Font Path Laboratory')
                if code not in (200, 201):
                    return self._json(502, {'ok': False, 'error': f'Settings write failed: {resp.get("message")}'})
                written.append(cfg['settings_path'])

            return self._json(200, {'ok': True, 'written': written})
        except Exception as e:  # noqa: BLE001
            return self._json(500, {'ok': False, 'error': str(e)})

    def copyfile(self, source, outputfile):
        # A browser that navigates away mid-transfer aborts the socket,
        # which surfaces here as a traceback on the console for what is
        # entirely normal behaviour. Swallow only that case.
        try:
            super().copyfile(source, outputfile)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def log_message(self, fmt, *args):
        # Default logging writes a line per request; ~20 per page load
        # buries anything that matters. Keep errors only.
        if args and str(args[0]).startswith(('4', '5')):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    with http.server.ThreadingHTTPServer(('', PORT), Handler) as httpd:
        print(f'Serving {ROOT} at http://localhost:{PORT}')
        httpd.serve_forever()
