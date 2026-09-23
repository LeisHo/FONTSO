# Bundled font licences

Every font committed in this directory is redistributable. Each is listed
below with its licence and the exact upstream file it came from, so the
provenance is checkable rather than asserted.

Fetched 2026-09-23 from https://github.com/google/fonts.

| File | Family | Licence | Upstream path |
|---|---|---|---|
| Arimo-Regular.ttf | Arimo | Apache-2.0 | `ofl/arimo/Arimo[wght].ttf` |
| Tinos-Regular.ttf | Tinos | Apache-2.0 | `ofl/tinos/Tinos-Regular.ttf` |
| Gelasio-Regular.ttf | Gelasio | SIL OFL 1.1 | `ofl/gelasio/Gelasio[wght].ttf` |
| Cousine-Regular.ttf | Cousine | Apache-2.0 | `ofl/cousine/Cousine-Regular.ttf` |
| ComicNeue-Regular.ttf | Comic Neue | SIL OFL 1.1 | `ofl/comicneue/ComicNeue-Regular.ttf` |
| Caveat-Regular.ttf | Caveat | SIL OFL 1.1 | `ofl/caveat/Caveat[wght].ttf` |
| ShadowsIntoLight-Regular.ttf | Shadows Into Light | SIL OFL 1.1 | `ofl/shadowsintolight/ShadowsIntoLight.ttf` |
| DancingScript-Regular.ttf | Dancing Script | SIL OFL 1.1 | `ofl/dancingscript/DancingScript[wght].ttf` |

Four are variable fonts (`[wght]`), saved under a `-Regular` name because
that is what this project's manifest refers to them by. opentype.js reads
the default instance, which is the regular weight, so the glyph outlines
this laboratory extracts are the regular ones.

## Why these, and not the originals

This directory originally listed Arial, Times New Roman, Georgia, Courier
Std, Comic Sans MS, Ink Free, Segoe Script and Gabriola. All eight are
proprietary Microsoft or Adobe faces. Committing them so the deployment
could serve them would be redistribution, and git history makes that
awkward to retract once a repository is public.

The replacements were picked to preserve what the originals were actually
*for* here, which is a spread of skeleton behaviour to test the pipeline
against: a plain sans, a serif with real bracketed serifs that branch under
thinning, a slab-ish serif, a monospace, an irregular humanist face, a
handwriting face, a script, and a decorative one. Four are metric-compatible
with the face they stand in for.

The originals still appear in the dropdown when they are present on a local
machine, marked `[local only]`; they remain gitignored and are not deployed.
