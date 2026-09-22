Font files dropped in here are discovered automatically by
scripts/active/serve.py's /api/fonts endpoint and appear in the
laboratory's font picker under a "data/Fonts" group. There is no
manifest to update -- add a .ttf/.otf/.woff/.ttc and reload.

The binaries themselves are gitignored (licensing + 8.5MB of repo
weight); this README and the discovery endpoint are tracked, so the
picker works for anyone who supplies their own files. See the note in
.gitignore if you want them committed anyway.
