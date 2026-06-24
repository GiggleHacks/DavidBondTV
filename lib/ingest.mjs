// Server-side ingestion: turn an uploaded video into a fully-described grid
// entry. Upload appends a `status:"processing"` manifest entry immediately and
// returns a job id; a single serial worker (ffmpeg/whisper are CPU-heavy) runs
// analyze → thumbnail → hover-preview, then flips the entry to "ready" (or
// "failed"). Manifest writes are atomic and serialized so the static reader and
// concurrent jobs never see a torn file.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {
  fmtDur, probeDurationAsync, makeThumbAsync, makePreviewAsync, segments, hasFfmpeg,
  probeHeightAsync, variantLadder, encodeVariantAsync, makeStoryboardAsync, hasNvenc,
} from './media.mjs';
import { buildPhases, overallPct, etaFrom } from './progress-plan.mjs';
import { addNotification, removeNotificationForVideo } from './notifications-store.js';
import { recordDeletion } from './tombstones.mjs';
import {
  MANIFEST, ORIGINALS_DIR, THUMBS_DIR, PREVIEWS_DIR, VIDEOS_DIR, STORYBOARDS_DIR,
  PRODUCT_ASSETS_DIR, CONTENT_DIR, MEDIA_DIR, ROOT, assetPathFromUrl,
} from './paths.js';

const DATA_DIR = path.join(ROOT, 'data');
const JOBS_FILE = path.join(DATA_DIR, 'active-jobs.json');
for (const d of [ORIGINALS_DIR, THUMBS_DIR, PREVIEWS_DIR, VIDEOS_DIR, STORYBOARDS_DIR, PRODUCT_ASSETS_DIR, DATA_DIR]) fs.mkdirSync(d, { recursive: true });

// Which quality tiers the live pipeline renders. Capped at 480p for the smallest
// practical files; override with LIVE_VARIANTS (e.g. "360p,480p,720p").
const LIVE_VARIANTS = (process.env.LIVE_VARIANTS || '360p,480p')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Delay before deleting the uploaded original after processing completes.
const ORIGINAL_RETENTION_MS = Number(process.env.ORIGINAL_RETENTION_MS) || 90_000;
const KEEP_ORIGINALS = process.env.KEEP_ORIGINALS === '1';

// In-memory job registry (id → { status, manifestId, title, error }).
const jobs = new Map();
// Serial worker chain — one ingestion at a time.
let chain = Promise.resolve();
// Serialize manifest read-modify-write so concurrent updates can't clobber.
let manifestLock = Promise.resolve();

// --- Job persistence (survives page refresh; lost on server restart) ---
let _jobWriteTimer = null;
function persistJobs() {
  if (_jobWriteTimer) return;
  _jobWriteTimer = setTimeout(() => {
    _jobWriteTimer = null;
    const obj = {};
    for (const [id, j] of jobs) obj[id] = j;
    try { fs.writeFileSync(JOBS_FILE, JSON.stringify(obj, null, 2)); } catch { /* best effort */ }
  }, 2000);
}
function loadPersistedJobs() {
  try {
    const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
    for (const [id, j] of Object.entries(data)) {
      if (j && typeof j === 'object') jobs.set(id, j);
    }
  } catch { /* no file or corrupt — fine */ }
}
loadPersistedJobs();

// --- File fingerprinting for duplicate detection ---
async function fileFingerprint(filePath, fileSize) {
  const SAMPLE = 1024 * 1024; // 1 MB
  const fh = await fsp.open(filePath, 'r');
  try {
    const hash = crypto.createHash('sha256');
    hash.update(`size:${fileSize}`);
    const headBuf = Buffer.alloc(Math.min(SAMPLE, fileSize));
    await fh.read(headBuf, 0, headBuf.length, 0);
    hash.update(headBuf);
    if (fileSize > SAMPLE) {
      const tailBuf = Buffer.alloc(Math.min(SAMPLE, fileSize));
      await fh.read(tailBuf, 0, tailBuf.length, Math.max(0, fileSize - SAMPLE));
      hash.update(tailBuf);
    }
    return hash.digest('hex');
  } finally { await fh.close(); }
}

/** Check if a file is a duplicate of an existing manifest entry. */
export async function checkDuplicate(filePath, fileSize) {
  const fp = await fileFingerprint(filePath, fileSize);
  const existing = readManifest().find((e) => e.fingerprint === fp);
  if (existing) return { duplicate: true, existingId: existing.id, existingTitle: existing.title, fingerprint: fp };
  return { duplicate: false, fingerprint: fp };
}

// --- System metrics ---
async function dirSize(dir) {
  let total = 0;
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirSize(p);
      else { try { total += (await fsp.stat(p)).size; } catch { /* skip */ } }
    }
  } catch { /* dir missing */ }
  return total;
}

let _metricsCache = { ts: 0, data: null };
const METRICS_TTL = 30_000; // 30s

export async function getSystemMetrics() {
  const now = Date.now();
  if (_metricsCache.data && now - _metricsCache.ts < METRICS_TTL) return _metricsCache.data;

  const [contentSize, mediaSize] = await Promise.all([dirSize(CONTENT_DIR), dirSize(MEDIA_DIR)]);
  const manifest = readManifest();
  const ready = manifest.filter((v) => v.status === 'ready');
  const totalOriginal = ready.reduce((s, v) => s + (v.originalSize || 0), 0);
  const avgOriginal = ready.length ? Math.round(totalOriginal / ready.length) : 0;

  // Real filesystem capacity of the volume holding our content (not just how much
  // we use): total / free / available so the dashboard can show "X of Y used".
  // bavail is space usable by an unprivileged process; we report used as the
  // portion not free to the OS at all (total - bfree) for an accurate "% full".
  let storage = null;
  try {
    const s = await fsp.statfs(CONTENT_DIR);
    const total = s.blocks * s.bsize;
    const available = s.bavail * s.bsize; // usable by us
    const used = total - s.bfree * s.bsize; // consumed on the volume overall
    storage = { total, used, available, free: s.bfree * s.bsize, pctUsed: total ? Math.round((used / total) * 100) : 0 };
  } catch { /* statfs unsupported → leave null; UI falls back to usage figures */ }

  const cpus = os.cpus();
  const data = {
    cpu: { cores: cpus.length, model: (cpus[0] || {}).model || 'unknown', load: os.loadavg() },
    memory: { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem() },
    disk: { content: contentSize, media: mediaSize, total: contentSize + mediaSize },
    storage, // filesystem capacity (null if the platform lacks statfs)
    videos: {
      total: manifest.length,
      ready: ready.length,
      uploaded: manifest.filter((v) => v.status === 'uploaded').length,
      // "processing" reported to the dashboard now means actively encoding
      // (the deferred, CPU-heavy step) — legacy 'processing' counts too.
      processing: manifest.filter((v) => v.status === 'encoding' || v.status === 'processing').length,
      failed: manifest.filter((v) => v.status === 'failed').length,
      totalOriginalSize: totalOriginal,
      avgOriginalSize: avgOriginal,
    },
    uptime: process.uptime(),
    platform: `${os.type()} ${os.release()}`,
    nodeVersion: process.version,
  };
  _metricsCache = { ts: now, data };
  return data;
}

/** Fresh read+parse of the manifest (no cache). Used by the writer. */
function readManifestRaw() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
  } catch {
    return [];
  }
}

// mtime-keyed cache for the read-only hot paths: videoVisibility() runs on every
// /videos/* request (incl. Range requests during playback) and isKnownVideo() on
// every /api/track heartbeat. Re-parsing the whole file each time is wasteful; a
// cheap statSync gates the re-parse so reads still always reflect the latest file.
// Callers must treat the result as read-only (the writer uses readManifestRaw).
let _manifestCache = { mtimeMs: -1, data: null };
function readManifest() {
  try {
    const st = fs.statSync(MANIFEST);
    if (_manifestCache.data && st.mtimeMs === _manifestCache.mtimeMs) return _manifestCache.data;
    const data = readManifestRaw();
    _manifestCache = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch {
    return [];
  }
}

/**
 * Atomically read-modify-write the manifest. `mutator(array)` runs synchronously
 * with NO awaits, so the critical section can't interleave with another job.
 */
function updateManifest(mutator) {
  manifestLock = manifestLock.then(() => {
    const arr = readManifestRaw(); // writer needs a fresh, mutable copy (not the cache)
    mutator(arr);
    const tmp = `${MANIFEST}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, MANIFEST);
  }).catch((e) => { console.error('manifest update failed:', e.message); });
  return manifestLock;
}

function patchEntry(manifestId, patch) {
  return updateManifest((arr) => {
    const e = arr.find((x) => x.id === manifestId);
    if (e) Object.assign(e, patch);
  });
}

// Core "approve" effect shared by the `approve` and `approve-free` bulk actions.
// uploaded/failed videos go into the transcode pipeline from their stored original;
// already-encoded ('ready') videos just get their approval flag flipped on. Both
// paths field-merge, so flags written to the entries beforehand (e.g. visibility/blur
// for approve-free) are preserved. Returns the number of videos acted on.
async function applyApprove(set) {
  const manifest = readManifest();
  const encodeIds = manifest
    .filter((e) => set.has(e.id) && (e.status === 'uploaded' || e.status === 'failed'))
    .map((e) => e.id);
  let count = 0;
  if (encodeIds.length) { const r = await startEncode(encodeIds); count += r.count || 0; }
  const rest = new Set([...set].filter((id) => !encodeIds.includes(id)));
  if (rest.size) {
    await updateManifest((arr) => {
      for (const e of arr) if (rest.has(e.id) && (e.status || 'ready') === 'ready') { e.approval = 'approved'; count += 1; }
    });
  }
  return count;
}

const isVideo = (name) => /\.(mp4|mov|m4v)$/i.test(name || '');

/** Allowlist check used by the upload route before opening a write stream. */
export function acceptableUpload(name, contentType) {
  if (isVideo(name)) return true;
  return typeof contentType === 'string' && contentType.startsWith('video/');
}

/**
 * Register a freshly-saved upload and kick off async processing.
 * `savedPath` is the file already streamed to disk; `displayName` is the
 * original filename (display only). Returns { jobId, manifestId } immediately.
 */
export function enqueue(savedPath, displayName, opts = {}) {
  const manifestId = path.basename(savedPath).replace(/\.[^.]+$/, '');
  const jobId = crypto.randomUUID();
  const uploaded = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
  const visibility = opts.visibility === 'premium' ? 'premium' : 'free';
  // Thumbnail blur for locked premium cards. Medium by default for premium.
  const blur = ['strongest', 'strong', 'medium', 'off'].includes(opts.blur)
    ? opts.blur : (visibility === 'premium' ? 'medium' : 'off');
  // Admin-assigned category slug (free-form; validated against the registry by
  // the route). Empty string = uncategorized.
  const category = typeof opts.category === 'string' ? opts.category : '';
  // Scheduled "slow-drip" release. A future publishAt holds the entry back
  // (published:false) until releaseScheduled() flips it; anything else (0, past,
  // missing) publishes as soon as processing finishes.
  const publishAtMs = Number(opts.publishAt);
  const scheduled = Number.isFinite(publishAtMs) && publishAtMs > Date.now();

  // Title defaults to the uploaded filename (extension stripped) so the review
  // queue shows a real name before any encoding happens.
  const title = String(displayName || manifestId).replace(/\.[^./\\]+$/, '') || manifestId;

  jobs.set(jobId, {
    status: 'uploaded', manifestId, title,
    label: 'Uploaded — awaiting review', detail: '', pct: 0, etaSec: null, step: 0, steps: 0,
  });
  persistJobs();

  // Insert the entry in the new "uploaded" state: the original is on disk but
  // NOT encoded. Encoding (the CPU-heavy part) is deferred until an admin reviews
  // and approves it — so we never burn CPU on a video that might be rejected.
  updateManifest((arr) => {
    arr.unshift({
      id: manifestId,
      title,
      description: '',
      autoGenerated: true,
      status: 'uploaded',     // uploaded · in review (pre-encode); approve → encoding → ready
      sourcePath: savedPath,  // original kept until approve (→encode) or reject (→delete)
      duration: 0,
      durLabel: '',
      thumb: '',
      preview: null,
      uploaded,
      uploadedAt: Date.now(), // machine timestamp → drives the 3-day "NEW" badge
      // Uploads NEVER auto-publish: every new video lands as an unapproved draft
      // (published:false + approval:'unapproved') and stays hidden from the public
      // until it's reviewed (approved → encoded) and explicitly published.
      published: false,
      approval: 'unapproved',
      publishAt: scheduled ? publishAtMs : null, // pending future release, else none
      visibility,             // 'free' | 'premium'
      blur,                   // 'strongest' | 'strong' | 'medium' | 'off' (locked-card thumbnail)
      category,               // admin category slug ('' = uncategorized)
    });
  });

  // Light prep only (probe + ONE poster frame + fingerprint) so the reviewer has
  // a thumbnail and we can dedupe — negligible CPU vs a full transcode.
  chain = chain.then(() => prepUpload(jobId, savedPath, manifestId));
  return { jobId, manifestId };
}

/**
 * Cheap post-upload prep that runs WITHOUT transcoding: probe duration, extract a
 * single poster frame, and fingerprint the original. Leaves the entry in the
 * 'uploaded' state for the review queue. Full encoding happens later, on approval.
 */
async function prepUpload(jobId, file, manifestId) {
  try {
    const stat = await fsp.stat(file);
    const originalSize = stat.size;
    const fp = await fileFingerprint(file, originalSize);
    let duration = 0;
    let posterUrl = '';
    if (hasFfmpeg()) {
      duration = await probeDurationAsync(file).catch(() => 0);
      const seek = Math.max(0, Math.min(Math.max(0, duration - 0.1), duration * 0.3));
      const name = `thumb-${manifestId}-0.jpg`;
      if (await makeThumbAsync(file, path.join(THUMBS_DIR, name), seek)) posterUrl = `/thumbs/${name}`;
    }
    await patchEntry(manifestId, {
      originalSize, fingerprint: fp,
      duration, durLabel: duration ? fmtDur(duration) : '',
      thumb: posterUrl, thumbCandidates: posterUrl ? [posterUrl] : [],
    });
    setTask(jobId, { status: 'uploaded', label: 'Uploaded — awaiting review', detail: '', pct: 100, etaSec: 0 });
  } catch (err) {
    const msg = (err && err.message) ? String(err.message).slice(0, 200) : 'prep failed';
    await patchEntry(manifestId, { status: 'failed' });
    setTask(jobId, { status: 'failed', error: msg, label: 'Upload prep failed', detail: msg, pct: 0, etaSec: null });
  }
}

/** Locate a stored original by id (the .part-free file whose stem matches). */
function findOriginal(id) {
  try {
    const f = fs.readdirSync(ORIGINALS_DIR).find((n) => !n.endsWith('.part') && n.replace(/\.[^.]+$/, '') === id);
    return f ? path.join(ORIGINALS_DIR, f) : null;
  } catch { return null; }
}

/**
 * Resolve the on-disk original for a not-yet-encoded video so the admin can WATCH
 * it during review (it has no renditions yet). Returns { path } only for videos
 * still holding an original (uploaded/failed), and only when the path resolves
 * safely inside ORIGINALS_DIR — never serves an arbitrary path. null otherwise.
 */
export function reviewSource(id) {
  if (!id || typeof id !== 'string') return null;
  const entry = readManifest().find((e) => e.id === id);
  if (!entry) return null;
  const candidate = (entry.sourcePath && fs.existsSync(entry.sourcePath)) ? entry.sourcePath : findOriginal(id);
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  if (resolved !== ORIGINALS_DIR && !resolved.startsWith(ORIGINALS_DIR + path.sep)) return null;
  try { if (!fs.statSync(resolved).isFile()) return null; } catch { return null; }
  return { path: resolved };
}

/**
 * Begin encoding previously-uploaded (or failed) videos — the deferred, CPU-heavy
 * step, triggered only after approval. Flips each to status 'encoding' + approved,
 * then runs the full transcode pipeline from the stored original. Returns { ok, count }.
 */
export async function startEncode(ids) {
  if (!Array.isArray(ids) || !ids.length) return { ok: false, error: 'No videos selected.' };
  const set = new Set(ids);
  const toEncode = readManifest().filter((e) => set.has(e.id)
    && (e.status === 'uploaded' || e.status === 'failed' || e.status === 'rejected'));
  let count = 0;
  for (const e of toEncode) {
    let src = e.sourcePath && fs.existsSync(e.sourcePath) ? e.sourcePath : findOriginal(e.id);
    if (!src) {
      // eslint-disable-next-line no-await-in-loop
      await patchEntry(e.id, { status: 'failed' });
      continue;
    }
    const jobId = crypto.randomUUID();
    jobs.set(jobId, {
      status: 'encoding', manifestId: e.id, title: e.title || e.id,
      label: 'Approved — queued for encoding', detail: '', pct: 0, etaSec: null, step: 0, steps: 0,
    });
    // eslint-disable-next-line no-await-in-loop
    await patchEntry(e.id, { status: 'encoding', approval: 'approved' });
    const title = e.title || e.id;
    chain = chain.then(() => processJob(jobId, src, e.id, title));
    count += 1;
  }
  persistJobs();
  return { ok: true, count };
}

/** Merge a telemetry patch into a job record (preserves status/manifestId/title). */
function setTask(jobId, patch) {
  const j = jobs.get(jobId);
  if (j) { jobs.set(jobId, { ...j, ...patch }); persistJobs(); }
}

async function processJob(jobId, file, manifestId, displayName) {
  try {
    if (!hasFfmpeg()) throw new Error('ffmpeg not installed on server');

    // Capture original file size + fingerprint before processing.
    const originalStat = await fsp.stat(file);
    const originalSize = originalStat.size;
    const fpResult = await fileFingerprint(file, originalSize);
    await patchEntry(manifestId, { originalSize, fingerprint: fpResult });

    // --- Plan the pipeline up front so the bar is smooth + ETA is meaningful. ---
    setTask(jobId, { label: 'Reading video info (ffprobe)', detail: '', pct: 1, etaSec: null, step: 1, steps: 6 });
    const duration = await probeDurationAsync(file);
    const height = (await probeHeightAsync(file)) || 720;
    const tiers = variantLadder(height).filter((t) => LIVE_VARIANTS.includes(t.name));
    const encoderLabel = (await hasNvenc()) ? 'NVENC GPU' : 'libx264 CPU';
    const phases = buildPhases(tiers, encoderLabel);
    const startedAt = Date.now();
    let activeIndex = 0;
    let lastEmit = 0;
    // Push a telemetry snapshot. Throttled to ~2/sec except when `force` (phase
    // transitions + completions), which always emit so the UI snaps immediately.
    const report = (fraction, over = {}, force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 400) return;
      lastEmit = now;
      const pct = overallPct(phases, activeIndex, fraction);
      const cur = phases[activeIndex] || {};
      setTask(jobId, {
        label: over.label || cur.label || 'Working…',
        detail: over.detail !== undefined ? over.detail : (cur.detail || ''),
        pct: Math.round(pct),
        etaSec: etaFrom((now - startedAt) / 1000, pct),
        step: activeIndex + 1, steps: phases.length,
      });
    };
    const enter = (key, over) => {
      const i = phases.findIndex((p) => p.key === key);
      if (i >= 0) activeIndex = i;
      report(0, over, true);
    };

    // Auto-generate several thumbnail candidates from frames across the clip so
    // the admin can pick the best one in the editor. Index 1 (30%) is the
    // default framing (matches the old single-thumbnail behaviour).
    enter('thumbs');
    const THUMB_PCTS = [0.1, 0.3, 0.5, 0.7, 0.9];
    const thumbCandidates = [];
    let defaultThumb = '';
    for (let i = 0; i < THUMB_PCTS.length; i += 1) {
      const seek = Math.max(0, Math.min(Math.max(0, duration - 0.1), duration * THUMB_PCTS[i]));
      const name = `thumb-${manifestId}-${i}.jpg`;
      // eslint-disable-next-line no-await-in-loop
      if (await makeThumbAsync(file, path.join(THUMBS_DIR, name), seek)) {
        const url = `/thumbs/${name}`;
        thumbCandidates.push(url);
        if (i === 1) defaultThumb = url;
      }
      report((i + 1) / THUMB_PCTS.length, { label: `Generating thumbnails — frame ${i + 1} of ${THUMB_PCTS.length}` }, true);
    }
    if (!defaultThumb) defaultThumb = thumbCandidates[0] || '';

    enter('preview');
    const previewName = `preview-${manifestId}.mp4`;
    const previewOk = await makePreviewAsync(file, path.join(PREVIEWS_DIR, previewName), segments(duration));
    report(1, {}, true);

    // Per-video hover-scrub sprite sheets for the progress-bar preview.
    enter('storyboard');
    const sbDir = path.join(STORYBOARDS_DIR, manifestId);
    fs.mkdirSync(sbDir, { recursive: true });
    const sbMeta = await makeStoryboardAsync(file, sbDir, duration);
    if (sbMeta) fs.writeFileSync(path.join(sbDir, 'storyboard.json'), JSON.stringify(sbMeta, null, 2));
    const storyboard = sbMeta ? `/storyboards/${manifestId}/storyboard.json` : null;
    report(1, {}, true);
    // Title defaults to the uploaded filename (extension stripped). The AI
    // title/description generator was disabled — it produced nonsense like
    // "soft birds eye fly through". The owner sets the real title/description
    // afterward from the edit page (/god-edit.html).
    const title = String(displayName || manifestId).replace(/\.[^./\\]+$/, '') || manifestId;
    const description = '';
    const autoGenerated = false;

    // Encode playable quality variants (360p + 720p) from the full clip. FFmpeg
    // streams real progress (out_time vs duration) → live per-encode %/ETA.
    const outDir = path.join(VIDEOS_DIR, manifestId);
    fs.mkdirSync(outDir, { recursive: true });
    const qualityLevels = [];
    let compressedSize = 0; // sum of the playable rendition files
    for (const tier of tiers) {
      enter(`enc-${tier.name}`);
      const dest = path.join(outDir, `${tier.name}.mp4`);
      // eslint-disable-next-line no-await-in-loop, no-loop-func
      const ok = await encodeVariantAsync(file, dest, { start: 0, length: duration }, tier, (ev) => {
        report(duration > 0 ? ev.outSec / duration : 0);
      });
      report(1, {}, true);
      if (ok) {
        qualityLevels.push({ height: tier.height, bitrate: tier.bandwidth, url: `/videos/${manifestId}/${tier.name}.mp4` });
        try { compressedSize += fs.statSync(dest).size; } catch { /* stat race — skip */ }
      }
    }
    if (!qualityLevels.length) throw new Error('variant encoding produced no playable output');

    // Space saved vs the uploaded original (renditions only — the comparable "video").
    const savedPct = originalSize > 0 && compressedSize > 0
      ? Math.max(0, Math.round((1 - compressedSize / originalSize) * 100)) : null;

    await patchEntry(manifestId, {
      title,
      description,
      autoGenerated,
      status: 'ready',
      duration,
      durLabel: fmtDur(duration),
      thumb: defaultThumb,
      thumbCandidates,
      preview: previewOk ? `/previews/${previewName}` : null,
      storyboard,
      qualityLevels,
      originalSize,
      compressedSize,
      savedPct,
      sourcePath: undefined, // encoded now; the original is about to be deleted
    });

    jobs.set(jobId, {
      status: 'ready', manifestId, title,
      label: 'Done', detail: '', pct: 100, etaSec: 0, step: phases.length, steps: phases.length,
      originalSize, compressedSize, savedPct,
    });
    persistJobs();

    // Notify viewers — but only for videos that go live now. Scheduled drips
    // (published:false + future publishAt) are announced later by releaseScheduled().
    const ready = readManifest().find((x) => x.id === manifestId);
    if (ready && ready.published !== false) {
      await addNotification({ videoId: manifestId, title, thumb: defaultThumb });
    }

    // After processing fully completes, wait, then delete the original to save
    // storage. Unref so it never holds the process open; a restart-safe sweep
    // (bootSweep) catches any original whose timer didn't fire.
    if (!KEEP_ORIGINALS) {
      setTimeout(() => safeUnlink(file), ORIGINAL_RETENTION_MS).unref();
    }
  } catch (err) {
    const msg = (err && err.message) ? String(err.message).slice(0, 200) : 'processing failed';
    await patchEntry(manifestId, { status: 'failed', title: displayName || manifestId, description: '' });
    jobs.set(jobId, {
      status: 'failed', manifestId, error: msg,
      label: 'Processing failed', detail: msg, pct: 0, etaSec: null,
    });
    persistJobs();
  }
}

/** Unlink a file only if it resolves inside one of our managed directories. */
function safeUnlink(absPath) {
  if (!absPath) return;
  const p = path.normalize(absPath);
  const ok = [CONTENT_DIR, ORIGINALS_DIR].some((root) => p === root || p.startsWith(root + path.sep));
  if (!ok) return;
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

/**
 * Remove a video from the manifest and delete its thumbnail, preview, and any
 * stored original. Matches by id against the manifest (never trusts a raw path
 * from the client). Returns { ok } or { ok:false, error }.
 */
export async function deleteVideo(id, { tombstone = true } = {}) {
  if (!id || typeof id !== 'string') return { ok: false, error: 'Missing id' };
  let removed = null;
  await updateManifest((arr) => {
    const idx = arr.findIndex((x) => x.id === id);
    if (idx >= 0) [removed] = arr.splice(idx, 1);
  });
  if (!removed) return { ok: false, error: 'Not found' };

  // Drop any "new video" notification for this id so it can't linger as a stale
  // unread item (the API also filters by live ids, but this keeps the feed clean).
  removeNotificationForVideo(id);

  // Best-effort asset cleanup, using paths recorded in the manifest entry. The
  // stored URLs (/thumbs/…, /previews/…) resolve into CONTENT_DIR.
  if (removed.thumb) safeUnlink(assetPathFromUrl(removed.thumb));
  // Auto-generated thumbnail candidates (a custom-uploaded thumb won't be listed
  // here, so it's covered by removed.thumb above).
  if (Array.isArray(removed.thumbCandidates)) {
    for (const url of removed.thumbCandidates) safeUnlink(assetPathFromUrl(url));
  }
  if (removed.preview) safeUnlink(assetPathFromUrl(removed.preview));
  // Quality variants live in content/videos/<id>/ — remove the whole folder.
  try {
    const vdir = path.join(VIDEOS_DIR, id);
    if (vdir === path.join(VIDEOS_DIR, id) && vdir.startsWith(VIDEOS_DIR + path.sep)) {
      fs.rmSync(vdir, { recursive: true, force: true });
    }
  } catch { /* nothing to clean */ }
  // Storyboard sprite sheets live in content/storyboards/<id>/.
  try {
    const sdir = path.join(STORYBOARDS_DIR, id);
    if (sdir.startsWith(STORYBOARDS_DIR + path.sep)) fs.rmSync(sdir, { recursive: true, force: true });
  } catch { /* nothing to clean */ }
  // Stored originals are named <id>.<ext> (uploads only); remove any match.
  try {
    for (const f of fs.readdirSync(ORIGINALS_DIR)) {
      if (f === id || f.startsWith(`${id}.`)) safeUnlink(path.join(ORIGINALS_DIR, f));
    }
  } catch { /* no originals dir / nothing to clean */ }

  // Purge any processing/finished job record for this video so it stops showing
  // in the upload page's "Recent uploads" list (jobs outlive the manifest entry).
  let purged = false;
  for (const [jobId, j] of jobs) {
    if (j.manifestId === id) { jobs.delete(jobId); purged = true; }
  }
  if (purged) persistJobs();

  // Remember this deletion so the next publish can remove it from the server.
  // The server's own delete-sync passes tombstone:false (nothing to propagate).
  if (tombstone) recordDeletion(id);

  return { ok: true, id };
}

/**
 * Delete any stored original whose manifest entry is already "ready" — catches
 * originals whose delayed-delete timer was lost to a restart. Best-effort.
 */
function sweepOrphanOriginals() {
  if (KEEP_ORIGINALS) return;
  let originals = [];
  try { originals = fs.readdirSync(ORIGINALS_DIR); } catch { return; }
  if (!originals.length) return;
  const ready = new Set(readManifest().filter((e) => e.status === 'ready').map((e) => e.id));
  for (const f of originals) {
    if (f.endsWith('.part')) continue; // an in-flight upload
    const id = f.replace(/\.[^.]+$/, '');
    if (ready.has(id)) safeUnlink(path.join(ORIGINALS_DIR, f));
  }
}

/** Strip control characters (keep printable + spaces), trim, and cap length. */
function clean(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Edit a video's title and/or description. A manually-set title clears the
 * `autoGenerated` flag (and its ✨ badge). Returns { ok } or { ok:false, error }.
 */
export async function editVideo(id, { title, description, blur, category, thumb, visibility } = {}) {
  if (!id || typeof id !== 'string') return { ok: false, error: 'Missing id' };
  const arr = readManifest();
  const entry = arr.find((x) => x.id === id);
  if (!entry) return { ok: false, error: 'Not found' };

  const patch = {};
  if (visibility !== undefined) {
    if (!['free', 'premium'].includes(visibility)) return { ok: false, error: 'Invalid visibility.' };
    patch.visibility = visibility;
  }
  if (thumb !== undefined) {
    // Selecting one of the auto-generated candidates. Validate against the
    // entry's own candidate list so an arbitrary path can't be injected, and
    // patch without unlinking (candidates are a shared pool).
    const candidates = Array.isArray(entry.thumbCandidates) ? entry.thumbCandidates : [];
    if (!candidates.includes(thumb)) return { ok: false, error: 'Unknown thumbnail.' };
    patch.thumb = thumb;
  }
  if (title !== undefined) {
    const t = clean(title, 200);
    if (!t) return { ok: false, error: 'Title cannot be empty.' };
    patch.title = t;
    patch.autoGenerated = false; // a human edited it
  }
  if (description !== undefined) {
    patch.description = clean(description, 2000);
  }
  if (blur !== undefined) {
    if (!['strongest', 'strong', 'medium', 'off'].includes(blur)) return { ok: false, error: 'Invalid blur level.' };
    patch.blur = blur;
  }
  if (category !== undefined) {
    patch.category = typeof category === 'string' ? category.slice(0, 40) : '';
  }
  if (!Object.keys(patch).length) return { ok: false, error: 'Nothing to update.' };
  await patchEntry(id, patch);
  return { ok: true, id };
}

/**
 * Apply a bulk action to a set of video ids. action ∈ delete | publish |
 * unpublish | premium | free. Returns { ok, count }.
 */
export async function bulkAction(ids, action) {
  if (!Array.isArray(ids) || !ids.length) return { ok: false, error: 'No videos selected.' };
  const set = new Set(ids);
  if (action === 'delete') {
    let count = 0;
    for (const id of ids) { const r = await deleteVideo(id); if (r.ok) count += 1; }
    return { ok: true, count };
  }
  // Bulk thumbnail blur: action is `blur-<level>` (e.g. `blur-strongest`).
  if (typeof action === 'string' && action.startsWith('blur-')) {
    const level = action.slice('blur-'.length);
    if (!['strongest', 'strong', 'medium', 'off'].includes(level)) {
      return { ok: false, error: 'Invalid blur level.' };
    }
    let count = 0;
    await updateManifest((arr) => {
      for (const e of arr) if (set.has(e.id)) { e.blur = level; count += 1; }
    });
    return { ok: true, count };
  }
  // Bulk category assignment: action is `set-category:<slug>` (empty slug = uncategorize).
  if (typeof action === 'string' && action.startsWith('set-category:')) {
    const slug = action.slice('set-category:'.length);
    let count = 0;
    await updateManifest((arr) => {
      for (const e of arr) if (set.has(e.id)) { e.category = slug; count += 1; }
    });
    return { ok: true, count };
  }
  // Approve: this is the review decision that STARTS encoding. Videos still in the
  // 'uploaded' state — or whose previous encode 'failed' (e.g. a server restart
  // interrupted ffmpeg) — are sent into the transcode pipeline now from their
  // stored original; videos that are already encoded ('ready') just have their
  // approval flag flipped on. startEncode() itself accepts uploaded/failed/rejected.
  if (action === 'approve') {
    const count = await applyApprove(set);
    return { ok: true, count };
  }
  // Make Free (UI label) — the review "super-approve". Remove blur (blur:'off') and
  // move to the free tier (visibility:'free'), THEN run the normal approve effect — one
  // atomic action so there's no partial-failure window. The topic `category` is untouched.
  // Flags are written first so startEncode's later status writes (a field-merge)
  // don't clobber them.
  if (action === 'approve-free') {
    await updateManifest((arr) => {
      for (const e of arr) if (set.has(e.id)) { e.visibility = 'free'; e.blur = 'off'; }
    });
    const count = await applyApprove(set);
    return { ok: true, count };
  }
  // Reject: the "No" review decision. Mark the video rejected (kept as a hidden
  // record so the admin sees the outcome) and delete its un-encoded original to
  // reclaim space — it was never encoded or published, so nothing else to remove.
  if (action === 'reject') {
    const manifest = readManifest();
    const sources = manifest.filter((e) => set.has(e.id) && e.sourcePath).map((e) => e.sourcePath);
    let count = 0;
    await updateManifest((arr) => {
      for (const e of arr) if (set.has(e.id)) {
        e.status = 'rejected'; e.published = false; e.approval = 'unapproved';
        delete e.sourcePath;
        count += 1;
      }
    });
    for (const src of sources) safeUnlink(src);
    return { ok: true, count };
  }
  const flags = {
    // publish/unpublish also cancel any pending drip so a manual override sticks
    // (otherwise a past publishAt could re-trigger the scheduler). Publishing also
    // marks the video approved so a live video is never left in the review queue.
    publish: { published: true, publishAt: null, approval: 'approved' },
    unpublish: { published: false, publishAt: null },
    // Review-mode moderation: move a draft between unapproved ↔ approved without
    // touching its published flag (it stays hidden until explicitly published).
    approve: { approval: 'approved' }, unapprove: { approval: 'unapproved' },
    premium: { visibility: 'premium' }, free: { visibility: 'free' },
  }[action];
  if (!flags) return { ok: false, error: 'Unknown action.' };
  let count = 0;
  const published = [];
  await updateManifest((arr) => {
    for (const e of arr) if (set.has(e.id)) {
      // Capture videos going from hidden → live so we can announce them.
      if (action === 'publish' && e.published === false && (e.status || 'ready') === 'ready') {
        published.push({ id: e.id, title: e.title, thumb: e.thumb });
      }
      Object.assign(e, flags);
      count += 1;
    }
  });
  // Notify viewers about anything just published (addNotification dedupes by
  // videoId, so re-publishing an already-announced video won't double-post).
  for (const v of published) {
    // eslint-disable-next-line no-await-in-loop
    await addNotification({ videoId: v.id, title: v.title, thumb: v.thumb });
  }
  return { ok: true, count };
}

/**
 * Release any scheduled drips whose time has come: published:false + ready +
 * a publishAt now in the past. Flips them live, clears publishAt, and posts a
 * notification for each. Called on a timer (and once at boot) by the server.
 * Returns the list of newly-published entries.
 */
export async function releaseScheduled() {
  const now = Date.now();
  const due = readManifest().filter((e) => e.published === false
    && (e.status || 'ready') === 'ready'
    && (e.approval || 'approved') === 'approved' // never auto-release an unreviewed draft
    && typeof e.publishAt === 'number' && e.publishAt <= now);
  if (!due.length) return [];
  const ids = new Set(due.map((e) => e.id));
  await updateManifest((arr) => {
    for (const e of arr) if (ids.has(e.id)) { e.published = true; e.publishAt = null; }
  });
  for (const e of due) {
    // eslint-disable-next-line no-await-in-loop
    await addNotification({ videoId: e.id, title: e.title, thumb: e.thumb });
  }
  return due;
}

const THUMB_EXTS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Resolve where a replacement thumbnail for `id` should be written. */
export function thumbTarget(id, contentType) {
  const ext = THUMB_EXTS[(contentType || '').split(';')[0].trim()];
  if (!ext || !id || typeof id !== 'string' || !/^[\w.-]+$/.test(id)) return null;
  const file = `thumb-${id}.${ext}`;
  return { dest: path.join(THUMBS_DIR, file), url: `/thumbs/${file}` };
}

/**
 * Point a video's manifest entry at a freshly written thumbnail and remove the
 * previous thumb if its path differs. Returns { ok } or { ok:false, error }.
 */
export async function setThumb(id, url) {
  const arr = readManifest();
  const entry = arr.find((x) => x.id === id);
  if (!entry) return { ok: false, error: 'Not found' };
  const old = entry.thumb;
  const candidates = Array.isArray(entry.thumbCandidates) ? entry.thumbCandidates : [];
  await patchEntry(id, { thumb: url });
  // Remove the previous thumb only if it was a custom upload — never delete a
  // shared auto-generated candidate (the editor still offers them).
  if (old && old !== url && !candidates.includes(old)) safeUnlink(assetPathFromUrl(old));
  return { ok: true, id, thumb: url };
}

/** True if `id` matches a manifest entry (used to validate analytics events). */
export function isKnownVideo(id) {
  if (!id || typeof id !== 'string') return false;
  return readManifest().some((e) => e.id === id);
}

/** A video's visibility ('free' | 'premium'), or null if unknown. */
export function videoVisibility(id) {
  if (!id || typeof id !== 'string') return null;
  const e = readManifest().find((x) => x.id === id);
  return e ? (e.visibility === 'premium' ? 'premium' : 'free') : null;
}

/**
 * Whether a video is publicly visible (published & not a pending scheduled drip).
 * Unknown ids are treated as public so non-video assets aren't accidentally gated.
 */
export function videoPublic(id) {
  if (!id || typeof id !== 'string') return true;
  const e = readManifest().find((x) => x.id === id);
  if (!e) return true;
  return e.published !== false;
}

/** Read-only manifest snapshot (used by the server to serve /thumbs/videos.json). */
export function listManifest() {
  return readManifest();
}

/**
 * Insert or replace a whole manifest entry (the commit point of a local→server
 * publish). Find-by-id replace, else prepend. Goes through the same serialized,
 * atomic writer as every other manifest mutation, so a push can never clobber
 * the server's library or interleave with another write.
 *
 * This is also where the SERVER announces a freshly-arrived video: when the
 * committed entry is live (published + ready), post a "new video" notification
 * so every viewer's feed updates. addNotification dedupes by videoId, so a
 * re-publish or a settings-only re-sync never double-posts. (Local processing
 * notifies separately in processOne(); this covers videos that only ever reach
 * viewers via the local→server push.)
 */
export async function mergeManifestEntry(entry) {
  if (!entry || typeof entry !== 'object' || !entry.id) return;
  await updateManifest((arr) => {
    const i = arr.findIndex((x) => x.id === entry.id);
    if (i >= 0) arr[i] = entry;
    else arr.unshift(entry);
  });
  if (entry.published !== false && (entry.status || 'ready') === 'ready') {
    await addNotification({ videoId: entry.id, title: entry.title, thumb: entry.thumb });
  }
}

/**
 * Post a "new video" notification for every published, ready video that doesn't
 * already have a feed entry. Idempotent (addNotification dedupes by videoId), so
 * it's safe to run on boot — it backfills videos that were published before the
 * server-side notification hook existed without ever double-posting.
 */
export async function backfillNotifications() {
  const live = readManifest().filter((e) => e.published !== false && (e.status || 'ready') === 'ready');
  let added = 0;
  for (const e of live) {
    // eslint-disable-next-line no-await-in-loop
    await addNotification({ videoId: e.id, title: e.title, thumb: e.thumb });
    added += 1;
  }
  return added;
}

/** Job status for the admin poller. */
export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

/** All known jobs (most-recent first not guaranteed — admin sorts). */
export function listJobs() {
  return [...jobs.entries()].map(([id, j]) => ({ jobId: id, ...j }));
}

/** Where uploads should be streamed. Returns { savedPath } for a new id. */
export function newUploadTarget(displayName) {
  const ext = isVideo(displayName) ? path.extname(displayName).toLowerCase() : '.mp4';
  const id = crypto.randomUUID();
  return {
    id,
    savedPath: path.join(ORIGINALS_DIR, `${id}${ext}`),
    partPath: path.join(ORIGINALS_DIR, `${id}${ext}.part`),
  };
}

/**
 * On server start, mark any manifest entries still "processing" as "failed"
 * (a job that was interrupted by a restart will never resume).
 */
export async function bootSweep() {
  // An interrupted encode (or legacy 'processing') can't resume → fail it. An
  // 'uploaded' entry is safe: its original is on disk, awaiting review, and can
  // still be approved/encoded after the restart, so leave those untouched.
  const interrupted = new Set(['processing', 'encoding']);
  for (const [id, j] of jobs) {
    if (interrupted.has(j.status)) {
      j.status = 'failed';
      j.label = 'Encoding interrupted by server restart';
      j.detail = '';
    }
  }
  persistJobs();
  await updateManifest((arr) => {
    for (const e of arr) {
      if (interrupted.has(e.status)) {
        e.status = 'failed';
        if (!e.description) e.description = '';
      }
    }
  });
  sweepOrphanOriginals();
}
