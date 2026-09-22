// ====================================================================
// Imported-font store
// ====================================================================
// Holds the raw bytes of every font imported this session so that Sync
// can persist them, and so a font restored from the server can be
// re-parsed without the user picking the file again.
//
// WHY FONTS ARE SAVED AS SEPARATE REPO FILES, NOT INSIDE THE SETTINGS
// JSON. A font is 250KB-1.8MB of binary. Base64 inflates that by ~33%,
// so a single 1.8MB face becomes ~2.4MB of text — and Sync rewrites the
// whole settings document every time it runs, which would mean a fresh
// multi-megabyte git object on every save. Written as its own file
// under data/processed/fonts/, a font is committed once and the
// settings JSON only carries a short reference to it.
//
// The store is in-memory only. It is deliberately NOT mirrored into
// localStorage: the 5MB quota is per-origin and base64 would burn
// through it on two fonts, and a half-populated store that silently
// drops the third font is worse than one that is simply empty on
// reload. Persistence is the server's job; the fetch on startup is what
// makes a saved font reappear.
// ====================================================================

const fonts = new Map(); // key -> {key, fileName, bytes, size, savedPath|null}

// A filesystem- and URL-safe key derived from the file name. Collisions
// are resolved by the caller re-importing over the same key, which is
// the behaviour you want: re-picking the same file replaces it.
export function keyForFileName(fileName) {
    return String(fileName)
        .replace(/\.[^.]+$/, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'font';
}

export function rememberFont(fileName, arrayBuffer) {
    const key = keyForFileName(fileName);
    const bytes = new Uint8Array(arrayBuffer);
    fonts.set(key, {
        key,
        fileName,
        bytes,
        size: bytes.byteLength,
        // Set once the server confirms where it was written, so Sync can
        // skip fonts that are already committed unchanged.
        savedPath: null,
    });
    return key;
}

export function getFont(key) {
    return fonts.get(key) || null;
}

export function listFonts() {
    return [...fonts.values()].map((f) => ({
        key: f.key, fileName: f.fileName, size: f.size, savedPath: f.savedPath,
    }));
}

export function unsavedFonts() {
    return [...fonts.values()].filter((f) => !f.savedPath);
}

export function markSaved(key, path) {
    const f = fonts.get(key);
    if (f) f.savedPath = path;
}

// Base64 for transport. Chunked because String.fromCharCode.apply with a
// multi-hundred-thousand-element spread overflows the argument limit and
// throws — a real failure on any font over roughly 100KB, which is most
// of them.
export function bytesToBase64(bytes) {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

export function base64ToBytes(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

// Adopts a font fetched back from the server, so it behaves exactly like
// one the user just picked — already marked saved, since it came from
// there.
export function adoptSavedFont(key, fileName, bytes, savedPath) {
    fonts.set(key, { key, fileName, bytes, size: bytes.byteLength, savedPath });
}
