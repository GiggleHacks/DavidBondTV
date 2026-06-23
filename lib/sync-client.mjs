// Local→server publish client. Runs on the LOCAL instance: it reads finished
// videos from the local manifest and pushes each one's artifacts + manifest
// entry to the production server over authenticated HTTPS (Bearer SYNC_TOKEN).
// The server only receives files — it never transcodes.
//
// All network calls accept an injectable `fetchImpl` so the orchestration is
// unit-testable without a real server.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { listManifest } from './ingest.mjs';
import { assetPathFromUrl } from './paths.js';
import { sha256File } from './hash-file.mjs';
import { artifactUrlsForEntry } from './sync-diff.mjs';
import { listDeletions, clearDeletions } from './tombstones.mjs';

const DEFAULT_CHUNK = 16 * 1024 * 1024;

async function postJson(fetchImpl, base, token, route, body) {
  const res = await fetchImpl(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

/**
 * Ask the server which of `entries` it's missing or has an out-of-date copy of.
 * Returns the array of ids to push (missing ∪ changed).
 */
export async function computeMissing(base, token, entries, fetchImpl = fetch) {
  const videos = entries.map((e) => ({ id: e.id, fingerprint: e.fingerprint }));
  const r = await postJson(fetchImpl, base, token, '/api/sync/diff', { videos });
  if (!r.ok) throw new Error(`diff failed (${r.status}): ${r.data.error || 'unknown'}`);
  return [...(r.data.missing || []), ...(r.data.changed || [])];
}

/**
 * Every artifact URL a video needs on the server: the entry-derived URLs plus
 * the storyboard's segment images, discovered by reading the storyboard dir.
 */
export async function expandArtifacts(entry) {
  const urls = artifactUrlsForEntry(entry);
  // Storyboard JSON lives alongside its segment PNGs — add the whole dir.
  if (typeof entry.storyboard === 'string' && entry.storyboard.startsWith('/')) {
    const jsonPath = assetPathFromUrl(entry.storyboard);
    if (jsonPath) {
      const dir = path.dirname(jsonPath);
      const urlDir = entry.storyboard.slice(0, entry.storyboard.lastIndexOf('/'));
      try {
        const files = await fsp.readdir(dir, { withFileTypes: true });
        for (const f of files) {
          if (f.isFile()) urls.push(`${urlDir}/${f.name}`);
        }
      } catch { /* no storyboard dir — fine */ }
    }
  }
  return [...new Set(urls)];
}

/** Total bytes of every artifact across `entries` (for a progress denominator). */
export async function totalArtifactBytes(entries) {
  let total = 0;
  for (const e of entries) {
    for (const rel of await expandArtifacts(e)) {
      const p = assetPathFromUrl(rel);
      if (!p) continue;
      try { total += (await fsp.stat(p)).size; } catch { /* skip missing */ }
    }
  }
  return total;
}

/**
 * Stream one artifact file to the server (init → chunk×N → complete).
 * `onProgress(bytesDelta)` is called after each chunk the server confirms.
 */
export async function pushArtifact(base, token, relPath, fetchImpl = fetch, onProgress = () => {}) {
  const filePath = assetPathFromUrl(relPath);
  if (!filePath) throw new Error(`unsafe artifact path: ${relPath}`);
  let size;
  try { size = (await fsp.stat(filePath)).size; }
  catch { throw new Error(`missing artifact on disk: ${relPath}`); }
  const sha256 = await sha256File(filePath);

  const init = await postJson(fetchImpl, base, token, '/api/sync/artifact/init', { relPath, size, sha256 });
  if (!init.ok) throw new Error(`artifact init failed (${init.status}): ${init.data.error || relPath}`);
  const chunkSize = init.data.chunkSize || DEFAULT_CHUNK;
  let offset = init.data.offset || 0; // resume point if the server already has a partial
  if (offset > 0) onProgress(offset); // count bytes the server already had

  const fh = await fsp.open(filePath, 'r');
  try {
    while (offset < size) {
      const len = Math.min(chunkSize, size - offset);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      const res = await fetchImpl(`${base}/api/sync/artifact/chunk?id=${encodeURIComponent(init.data.uploadId)}&offset=${offset}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` },
        body: buf,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(`chunk failed (${res.status}) for ${relPath}: ${d.error || ''}`);
      }
      offset += len;
      onProgress(len);
    }
  } finally {
    await fh.close();
  }

  const done = await postJson(fetchImpl, base, token, `/api/sync/artifact/complete?id=${encodeURIComponent(init.data.uploadId)}`, {});
  if (!done.ok) throw new Error(`artifact complete failed (${done.status}) for ${relPath}: ${done.data.error || ''}`);
}

/**
 * Propagate locally-deleted video ids to the server. Returns the ids the server
 * removed (or didn't have) — both are safe to clear from the local tombstones.
 */
export async function pushDeletions(base, token, ids, fetchImpl = fetch) {
  if (!ids || !ids.length) return [];
  const r = await postJson(fetchImpl, base, token, '/api/sync/delete', { ids });
  if (!r.ok) throw new Error(`delete sync failed (${r.status}): ${r.data.error || ''}`);
  return [...(r.data.deleted || []), ...(r.data.notFound || [])];
}

/** Push all artifacts for a video, then commit its manifest entry (last). */
export async function pushVideo(base, token, entry, fetchImpl = fetch, onProgress = () => {}) {
  const artifacts = await expandArtifacts(entry);
  for (const relPath of artifacts) {
    await pushArtifact(base, token, relPath, fetchImpl, onProgress);
  }
  const r = await postJson(fetchImpl, base, token, '/api/sync/manifest', { entry });
  if (!r.ok) throw new Error(`manifest commit failed (${r.status}) for ${entry.id}: ${r.data.error || ''}`);
}

// --- Publish job registry (in-memory, mirrors lib/ingest.mjs's job pattern) ---
const publishJobs = new Map();
let _seq = 0;

export function getPublishJob(jobId) {
  return publishJobs.get(jobId) || null;
}

/**
 * Kick off a publish in the background. Returns { jobId } immediately; the route
 * polls getPublishJob for progress. Filters the local manifest to ready videos,
 * diffs against the server, and pushes the missing/changed ones.
 */
export function startPublish({ targetUrl, token, fetchImpl = fetch, now = Date.now() }) {
  const jobId = `pub-${now}-${++_seq}`;
  const job = {
    jobId, phase: 'starting', pct: 0, done: 0, total: 0, current: '',
    bytesTotal: 0, bytesSent: 0, speed: 0, deleted: 0, errors: [], status: 'running', startedAt: now,
  };
  publishJobs.set(jobId, job);
  // Run detached; the poller reads `job` as it mutates.
  (async () => {
    try {
      // 1) Propagate local deletions first (cheap; frees server space up front).
      const tombstones = listDeletions();
      if (tombstones.length) {
        job.phase = 'deleting';
        try {
          const handled = await pushDeletions(targetUrl, token, tombstones, fetchImpl);
          clearDeletions(handled); // forget only what the server confirmed
          job.deleted = handled.length;
        } catch (err) {
          job.errors.push({ error: `delete sync: ${err.message}` });
        }
      }

      const ready = listManifest().filter((v) => v.status === 'ready');
      job.phase = 'diffing';
      const ids = await computeMissing(targetUrl, token, ready, fetchImpl);
      const toPush = ready.filter((v) => ids.includes(v.id));
      job.total = toPush.length;
      if (!toPush.length) {
        job.phase = 'done';
        job.status = job.errors.length ? 'error' : 'done';
        job.pct = 100;
        return;
      }

      // Measure total bytes up front so the bar + ETA are meaningful.
      job.phase = 'measuring';
      job.bytesTotal = await totalArtifactBytes(toPush);

      // Byte-level progress with a smoothed transfer speed (bytes/sec).
      let lastTs = Date.now();
      let lastBytes = 0;
      const onProgress = (delta) => {
        job.bytesSent += delta;
        const t = Date.now();
        const dt = (t - lastTs) / 1000;
        if (dt >= 0.3) {
          const inst = (job.bytesSent - lastBytes) / dt;
          job.speed = job.speed ? job.speed * 0.7 + inst * 0.3 : inst;
          lastTs = t; lastBytes = job.bytesSent;
        }
        // Cap at 99 while bytes are still flowing; the loop sets 100 at the end.
        job.pct = job.bytesTotal ? Math.min(99, Math.round((job.bytesSent / job.bytesTotal) * 100)) : job.pct;
      };

      job.phase = 'pushing';
      for (const entry of toPush) {
        job.current = entry.title || entry.id;
        try {
          await pushVideo(targetUrl, token, entry, fetchImpl, onProgress);
          job.done += 1;
        } catch (err) {
          job.errors.push({ id: entry.id, error: err.message });
        }
      }
      job.pct = 100;
      job.speed = 0;
      job.phase = 'done';
      job.status = job.errors.length ? 'error' : 'done';
    } catch (err) {
      job.status = 'error';
      job.phase = 'failed';
      job.errors.push({ error: err.message });
    }
  })();
  return { jobId };
}
