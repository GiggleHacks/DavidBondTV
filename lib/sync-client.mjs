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
import { artifactUrlsForEntry, metaFingerprintForEntry } from './sync-diff.mjs';
import { listDeletions, clearDeletions } from './tombstones.mjs';

const DEFAULT_CHUNK = 16 * 1024 * 1024;

// Thrown to unwind the push loop when the operator cancels mid-flight. The job
// keeps its progress; a later Publish resumes from the server-side partials.
class PublishCancelled extends Error {
  constructor() { super('Publish cancelled.'); this.name = 'PublishCancelled'; }
}

/**
 * Cooperative pause/cancel checkpoint. Resolves immediately when running, blocks
 * (polling cheaply) while paused, and throws PublishCancelled when cancelled.
 * Called between chunks and between videos so the loop reacts within ~150ms.
 */
async function checkpoint(control) {
  if (!control) return;
  if (control.state === 'cancelled') throw new PublishCancelled();
  while (control.state === 'paused') {
    await new Promise((r) => setTimeout(r, 150));
    if (control.state === 'cancelled') throw new PublishCancelled();
  }
}

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
  const videos = entries.map((e) => ({
    id: e.id,
    fingerprint: e.fingerprint,
    metaFingerprint: metaFingerprintForEntry(e),
  }));
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
export async function pushArtifact(base, token, relPath, fetchImpl = fetch, onProgress = () => {}, control = null) {
  const filePath = assetPathFromUrl(relPath);
  if (!filePath) throw new Error(`unsafe artifact path: ${relPath}`);
  let size;
  try { size = (await fsp.stat(filePath)).size; }
  catch { throw new Error(`missing artifact on disk: ${relPath}`); }
  const sha256 = await sha256File(filePath);

  const init = await postJson(fetchImpl, base, token, '/api/sync/artifact/init', { relPath, size, sha256 });
  if (!init.ok) throw new Error(`artifact init failed (${init.status}): ${init.data.error || relPath}`);
  // Server already has this exact artifact (same sha) → nothing to upload. Count
  // its full size so the progress bar still reflects "this much is in place".
  if (init.data.complete) { onProgress(size); return; }
  const chunkSize = init.data.chunkSize || DEFAULT_CHUNK;
  let offset = init.data.offset || 0; // resume point if the server already has a partial
  if (offset > 0) onProgress(offset); // count bytes the server already had

  const fh = await fsp.open(filePath, 'r');
  try {
    while (offset < size) {
      await checkpoint(control); // honor pause/cancel between chunks
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
 * Mirror authored config (categories + coupons) to the server so the live site
 * matches what the owner built locally — category names/emojis/icons and coupon
 * codes. Best-effort: returns the server's merge counts, or throws on a hard
 * failure. Reads the local stores directly (lazy-imported to keep this module's
 * top-level dependency-free for the pure unit tests).
 */
export async function pushConfig(base, token, fetchImpl = fetch) {
  const [categories, coupons] = await Promise.all([
    import('./categories.js'),
    import('./coupons.js'),
  ]);
  const payload = { categories: categories.list(), coupons: coupons.list() };
  const r = await postJson(fetchImpl, base, token, '/api/sync/config', payload);
  if (!r.ok) throw new Error(`config sync failed (${r.status}): ${r.data.error || 'unknown'}`);
  return r.data; // { ok, categories, coupons }
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
export async function pushVideo(base, token, entry, fetchImpl = fetch, onProgress = () => {}, control = null) {
  const artifacts = await expandArtifacts(entry);
  for (const relPath of artifacts) {
    await checkpoint(control); // honor pause/cancel between artifacts
    await pushArtifact(base, token, relPath, fetchImpl, onProgress, control);
  }
  // Commit the manifest last — this is the per-video durability point, so a
  // cancel before it means the video re-pushes next time (already-uploaded
  // artifacts short-circuit), and only fully-committed videos count as "present".
  const r = await postJson(fetchImpl, base, token, '/api/sync/manifest', { entry });
  if (!r.ok) throw new Error(`manifest commit failed (${r.status}) for ${entry.id}: ${r.data.error || ''}`);
}

// --- Publish job registry (in-memory, mirrors lib/ingest.mjs's job pattern) ---
const publishJobs = new Map();
let _seq = 0;

export function getPublishJob(jobId) {
  return publishJobs.get(jobId) || null;
}

/** The most-recently-started job (the UI reconnects to it after a reload). */
export function latestPublishJob() {
  let latest = null;
  for (const job of publishJobs.values()) {
    if (!latest || job.startedAt > latest.startedAt) latest = job;
  }
  return latest;
}

/**
 * Operator control over a running job. `pause` halts between chunks (partials
 * stay on the server), `resume` continues, `cancel` unwinds the loop — leaving
 * every uploaded byte in place so the next Publish picks up where this left off.
 */
export function controlPublishJob(jobId, action) {
  const job = publishJobs.get(jobId);
  if (!job || !job.control) return { ok: false, error: 'No such publish job.' };
  if (job.status !== 'running') return { ok: false, error: `Job is already ${job.status}.` };
  if (action === 'pause') { job.control.state = 'paused'; job.paused = true; }
  else if (action === 'resume') { job.control.state = 'running'; job.paused = false; }
  else if (action === 'cancel') { job.control.state = 'cancelled'; }
  else return { ok: false, error: 'Unknown action.' };
  return { ok: true, state: job.control.state };
}

/**
 * Kick off a publish in the background. Returns { jobId } immediately; the route
 * polls getPublishJob for progress. Filters the local manifest to ready videos,
 * diffs against the server, and pushes the missing/changed ones — emitting a
 * per-video breakdown (size, sent, status) plus aggregate bytes/speed so the UI
 * can render a detailed, resumable, pausable transfer.
 */
export function startPublish({ targetUrl, token, fetchImpl = fetch, now = Date.now() }) {
  const jobId = `pub-${now}-${++_seq}`;
  const control = { state: 'running' };
  const job = {
    jobId, phase: 'starting', pct: 0, done: 0, total: 0, current: '', currentId: '',
    bytesTotal: 0, bytesSent: 0, speed: 0, deleted: 0, errors: [], status: 'running',
    paused: false, videos: [], startedAt: now, control,
  };
  publishJobs.set(jobId, job);
  // Run detached; the poller reads `job` as it mutates.
  (async () => {
    try {
      // 0) Mirror authored config (categories + coupons) so the live site matches
      //    local — published videos show their category styling. Non-fatal.
      job.phase = 'config';
      try {
        const cfg = await pushConfig(targetUrl, token, fetchImpl);
        job.config = { categories: cfg.categories || 0, coupons: cfg.coupons || 0 };
      } catch (err) {
        job.errors.push({ error: `config sync: ${err.message}` });
      }

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

      // Measure each video's bytes up front so the bar + ETA + per-row sizes are
      // meaningful. Only the artifacts the server is actually missing are counted
      // toward "needs uploading" — already-present bytes short-circuit at init.
      job.phase = 'measuring';
      job.videos = [];
      for (const entry of toPush) {
        // eslint-disable-next-line no-await-in-loop
        const bytes = await totalArtifactBytes([entry]);
        job.videos.push({
          id: entry.id, title: entry.title || entry.id,
          bytesTotal: bytes, bytesSent: 0, status: 'pending', error: '',
        });
        job.bytesTotal += bytes;
      }

      // Byte-level progress with a smoothed transfer speed (bytes/sec). The
      // per-video row currently uploading is tracked so its bar advances too.
      let lastTs = Date.now();
      let lastBytes = 0;
      let activeRow = null;
      const onProgress = (delta) => {
        job.bytesSent += delta;
        if (activeRow) activeRow.bytesSent = Math.min(activeRow.bytesTotal, activeRow.bytesSent + delta);
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
        const row = job.videos.find((r) => r.id === entry.id);
        activeRow = row;
        job.current = entry.title || entry.id;
        job.currentId = entry.id;
        if (row) row.status = 'active';
        try {
          await pushVideo(targetUrl, token, entry, fetchImpl, onProgress, control);
          if (row) { row.status = 'done'; row.bytesSent = row.bytesTotal; }
          job.done += 1;
        } catch (err) {
          if (err instanceof PublishCancelled) {
            if (row) row.status = 'pending'; // not done; resumes next Publish
            throw err; // unwind to the cancelled handler below
          }
          if (row) { row.status = 'error'; row.error = err.message; }
          job.errors.push({ id: entry.id, error: err.message });
        }
      }
      activeRow = null;
      job.speed = 0;
      job.current = '';
      job.currentId = '';
      job.pct = 100;
      job.phase = 'done';
      job.status = job.errors.length ? 'error' : 'done';
    } catch (err) {
      job.speed = 0;
      job.current = '';
      job.currentId = '';
      if (err instanceof PublishCancelled) {
        job.status = 'cancelled';
        job.phase = 'cancelled';
      } else {
        job.status = 'error';
        job.phase = 'failed';
        job.errors.push({ error: err.message });
      }
    }
  })();
  return { jobId };
}
