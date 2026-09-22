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
import http.server
import os
import sys

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
