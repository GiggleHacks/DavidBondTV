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
import { fileURLToPath } from 'node:url';
import {
  fmtDur, probeDurationAsync, makeThumbAsync, makePreviewAsync, segments, hasFfmpeg,
  probeHeightAsync, variantLadder, encodeVariantAsync, makeStoryboardAsync,
} from './media.mjs';
import { addNotification } from './notifications-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'public', 'thumbs', 'videos.json');
const ORIGINALS_DIR = path.join(ROOT, 'media', 'originals');
const THUMBS_DIR = path.join(ROOT, 'public', 'thumbs');
const PREVIEWS_DIR = path.join(ROOT, 'public', 'previews');
const VIDEOS_DIR = path.join(ROOT, 'public', 'videos');
const STORYBOARDS_DIR = path.join(ROOT, 'public', 'storyboards');

for (const d of [ORIGINALS_DIR, THUMBS_DIR, PREVIEWS_DIR, VIDEOS_DIR, STORYBOARDS_DIR]) fs.mkdirSync(d, { recursive: true });

// Which quality tiers the live pipeline renders (owner chose 360p + 720p).
const LIVE_VARIANTS = (process.env.LIVE_VARIANTS || '360p,720p')
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
  const blur = ['strong', 'medium', 'off'].includes(opts.blur)
    ? opts.blur : (visibility === 'premium' ? 'medium' : 'off');
  // Admin-assigned category slug (free-form; validated against the registry by
  // the route). Empty string = uncategorized.
  const category = typeof opts.category === 'string' ? opts.category : '';
  // Scheduled "slow-drip" release. A future publishAt holds the entry back
  // (published:false) until releaseScheduled() flips it; anything else (0, past,
  // missing) publishes as soon as processing finishes.
  const publishAtMs = Number(opts.publishAt);
  const scheduled = Number.isFinite(publishAtMs) && publishAtMs > Date.now();

  jobs.set(jobId, { status: 'processing', manifestId, title: displayName || manifestId, phase: 'queued' });

  // Insert a placeholder entry so the admin (and grid) can see it right away.
  updateManifest((arr) => {
    arr.unshift({
      id: manifestId,
      title: displayName || 'Processing…',
      description: '',
      autoGenerated: true,
      status: 'processing',
      duration: 0,
      durLabel: '',
      thumb: '',
      preview: null,
      uploaded,
      uploadedAt: Date.now(), // machine timestamp → drives the 3-day "NEW" badge
      published: !scheduled,  // scheduled drips stay hidden until their time
      publishAt: scheduled ? publishAtMs : null, // pending future release, else none
      visibility,             // 'free' | 'premium'
      blur,                   // 'strong' | 'medium' | 'off' (locked-card thumbnail)
      category,               // admin category slug ('' = uncategorized)
    });
  });

  chain = chain.then(() => processJob(jobId, savedPath, manifestId, displayName));
  return { jobId, manifestId };
}

function setPhase(jobId, phase) {
  const j = jobs.get(jobId);
  if (j) jobs.set(jobId, { ...j, phase });
}

async function processJob(jobId, file, manifestId, displayName) {
  try {
    if (!hasFfmpeg()) throw new Error('ffmpeg not installed on server');

    setPhase(jobId, 'analyzing');
    const duration = await probeDurationAsync(file);

    // Auto-generate several thumbnail candidates from frames across the clip so
    // the admin can pick the best one in the editor. Index 1 (30%) is the
    // default framing (matches the old single-thumbnail behaviour).
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
    }
    if (!defaultThumb) defaultThumb = thumbCandidates[0] || '';

    const previewName = `preview-${manifestId}.mp4`;
    const previewOk = await makePreviewAsync(file, path.join(PREVIEWS_DIR, previewName), segments(duration));

    // Per-video hover-scrub sprite sheets for the progress-bar preview.
    setPhase(jobId, 'storyboard');
    const sbDir = path.join(STORYBOARDS_DIR, manifestId);
    fs.mkdirSync(sbDir, { recursive: true });
    const sbMeta = await makeStoryboardAsync(file, sbDir, duration);
    if (sbMeta) fs.writeFileSync(path.join(sbDir, 'storyboard.json'), JSON.stringify(sbMeta, null, 2));
    const storyboard = sbMeta ? `/storyboards/${manifestId}/storyboard.json` : null;
    // Title defaults to the uploaded filename (extension stripped). The AI
    // title/description generator was disabled — it produced nonsense like
    // "soft birds eye fly through". The owner sets the real title/description
    // afterward from the edit page (/god-edit.html).
    const title = String(displayName || manifestId).replace(/\.[^./\\]+$/, '') || manifestId;
    const description = '';
    const autoGenerated = false;

    // Encode playable quality variants (360p + 720p) from the full clip.
    const height = (await probeHeightAsync(file)) || 720;
    const tiers = variantLadder(height).filter((t) => LIVE_VARIANTS.includes(t.name));
    const outDir = path.join(VIDEOS_DIR, manifestId);
    fs.mkdirSync(outDir, { recursive: true });
    const qualityLevels = [];
    for (const tier of tiers) {
      setPhase(jobId, `encoding ${tier.name}`);
      const dest = path.join(outDir, `${tier.name}.mp4`);
      const ok = await encodeVariantAsync(file, dest, { start: 0, length: duration }, tier);
      if (ok) {
        qualityLevels.push({ height: tier.height, bitrate: tier.bandwidth, url: `/videos/${manifestId}/${tier.name}.mp4` });
      }
    }
    if (!qualityLevels.length) throw new Error('variant encoding produced no playable output');

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
    });

    jobs.set(jobId, { status: 'ready', manifestId, title, phase: 'ready' });

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
    jobs.set(jobId, { status: 'failed', manifestId, error: msg, phase: 'failed' });
  }
}

const PUBLIC_DIR = path.join(ROOT, 'public');

/** Unlink a file only if it resolves inside one of our managed directories. */
function safeUnlink(absPath) {
  if (!absPath) return;
  const p = path.normalize(absPath);
  const ok = [PUBLIC_DIR, ORIGINALS_DIR].some((root) => p === root || p.startsWith(root + path.sep));
  if (!ok) return;
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

/**
 * Remove a video from the manifest and delete its thumbnail, preview, and any
 * stored original. Matches by id against the manifest (never trusts a raw path
 * from the client). Returns { ok } or { ok:false, error }.
 */
export async function deleteVideo(id) {
  if (!id || typeof id !== 'string') return { ok: false, error: 'Missing id' };
  let removed = null;
  await updateManifest((arr) => {
    const idx = arr.findIndex((x) => x.id === id);
    if (idx >= 0) [removed] = arr.splice(idx, 1);
  });
  if (!removed) return { ok: false, error: 'Not found' };

  // Best-effort asset cleanup, using paths recorded in the manifest entry.
  if (removed.thumb) safeUnlink(path.join(PUBLIC_DIR, removed.thumb));
  // Auto-generated thumbnail candidates (a custom-uploaded thumb won't be listed
  // here, so it's covered by removed.thumb above).
  if (Array.isArray(removed.thumbCandidates)) {
    for (const url of removed.thumbCandidates) safeUnlink(path.join(PUBLIC_DIR, url));
  }
  if (removed.preview) safeUnlink(path.join(PUBLIC_DIR, removed.preview));
  // Quality variants live in public/videos/<id>/ — remove the whole folder.
  try {
    const vdir = path.join(VIDEOS_DIR, id);
    if (vdir === path.join(VIDEOS_DIR, id) && vdir.startsWith(VIDEOS_DIR + path.sep)) {
      fs.rmSync(vdir, { recursive: true, force: true });
    }
  } catch { /* nothing to clean */ }
  // Storyboard sprite sheets live in public/storyboards/<id>/.
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
    if (!['strong', 'medium', 'off'].includes(blur)) return { ok: false, error: 'Invalid blur level.' };
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
  const flags = {
    // publish/unpublish also cancel any pending drip so a manual override sticks
    // (otherwise a past publishAt could re-trigger the scheduler).
    publish: { published: true, publishAt: null }, unpublish: { published: false, publishAt: null },
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
  if (old && old !== url && !candidates.includes(old)) safeUnlink(path.join(PUBLIC_DIR, old));
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
  await updateManifest((arr) => {
    for (const e of arr) {
      if (e.status === 'processing') {
        e.status = 'failed';
        if (!e.description) e.description = '';
      }
    }
  });
  sweepOrphanOriginals(); // reclaim originals whose delete timer was lost to a restart
}
