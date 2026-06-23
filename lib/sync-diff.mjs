// Pure helpers for the local→server publish flow. No fs / no network so they
// unit-test cleanly; the client (lib/sync-client.mjs) and routes own the I/O.

/**
 * Classify which incoming videos the server already has. `serverEntries` is the
 * server's manifest (array); `incoming` is [{ id, fingerprint }]. Returns
 * { present, changed, missing } as arrays of ids:
 *   present  — same id + same fingerprint (skip)
 *   changed  — same id, different fingerprint (re-push to update)
 *   missing  — id not on the server (push)
 */
export function diffManifest(serverEntries, incoming) {
  const byId = new Map((serverEntries || []).map((e) => [e.id, e]));
  const present = [];
  const changed = [];
  const missing = [];
  for (const v of incoming || []) {
    const existing = byId.get(v.id);
    if (!existing) missing.push(v.id);
    else if (existing.fingerprint && v.fingerprint && existing.fingerprint === v.fingerprint) present.push(v.id);
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
