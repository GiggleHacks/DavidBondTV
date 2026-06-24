// Pure helpers for the local→server publish flow. No fs / no network so they
// unit-test cleanly; the client (lib/sync-client.mjs) and routes own the I/O.

import crypto from 'node:crypto';

// The publishable settings that must travel with a video but are NOT captured by
// the file fingerprint (which hashes only the original video bytes). When any of
// these change on an already-published video — most importantly `blur` and
// `visibility` — the diff must flag it so the server gets the updated entry. The
// artifact-URL fields are included so a swapped thumbnail / re-rendered preview
// also re-publishes (the new file uploads; unchanged artifacts short-circuit).
const META_FIELDS = [
  'title', 'description', 'visibility', 'blur', 'category',
  'published', 'publishAt', 'approval', 'thumb', 'preview', 'storyboard',
];

/**
 * Stable hash of a video's publishable settings (everything that should sync but
 * isn't part of the raw-file fingerprint). Same inputs → same hash on both ends,
 * so the diff can detect a settings-only change without re-uploading artifacts.
 */
export function metaFingerprintForEntry(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const shape = {};
  for (const k of META_FIELDS) shape[k] = entry[k] ?? null;
  // Quality rendition URLs (the artifact set) — order-stable.
  shape.qualityLevels = (entry.qualityLevels || [])
    .map((q) => (q && typeof q.url === 'string' ? q.url : ''))
    .filter(Boolean)
    .sort();
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

/**
 * Classify which incoming videos the server already has. `serverEntries` is the
 * server's manifest (array); `incoming` is [{ id, fingerprint, metaFingerprint }].
 * Returns { present, changed, missing } as arrays of ids:
 *   present  — same id, same file fingerprint AND same settings (skip entirely)
 *   changed  — same id but the file OR the settings differ (re-push; unchanged
 *              artifacts short-circuit server-side, so a settings-only edit is cheap)
 *   missing  — id not on the server (push)
 *
 * `metaFingerprint` is optional for backward compatibility: when an incoming item
 * omits it, only the file fingerprint is compared (old behavior).
 */
export function diffManifest(serverEntries, incoming) {
  const byId = new Map((serverEntries || []).map((e) => [e.id, e]));
  const present = [];
  const changed = [];
  const missing = [];
  for (const v of incoming || []) {
    const existing = byId.get(v.id);
    if (!existing) { missing.push(v.id); continue; }
    const fileSame = existing.fingerprint && v.fingerprint && existing.fingerprint === v.fingerprint;
    // Settings match if the client didn't send a metaFingerprint (legacy) or both
    // sides hash identically. Compute the server side from its own stored entry.
    const metaSame = !v.metaFingerprint || metaFingerprintForEntry(existing) === v.metaFingerprint;
    if (fileSame && metaSame) present.push(v.id);
    else changed.push(v.id);
  }
  return { present, changed, missing };
}

/**
 * All server-relative artifact URLs derivable from a manifest entry (thumb,
 * thumb candidates, preview, quality renditions, storyboard JSON). De-duplicated,
 * strings only. Storyboard *segment* images aren't listed here — they're not in
 * the entry; the client expands them by reading the storyboard dir on disk.
 */
export function artifactUrlsForEntry(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const urls = [];
  const push = (u) => { if (typeof u === 'string' && u.startsWith('/')) urls.push(u); };
  push(entry.thumb);
  for (const c of (entry.thumbCandidates || [])) push(c);
  push(entry.preview);
  push(entry.storyboard);
  for (const q of (entry.qualityLevels || [])) push(q && q.url);
  return [...new Set(urls)];
}
