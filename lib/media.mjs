// Shared ffmpeg/ffprobe helpers used by the offline build scripts (sync) and
// the live server ingestion path (async). Zero dependencies — we only spawn
// ffmpeg/ffprobe. Keep behavior identical to the original build scripts.
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';

// --- shared constants (must match the original build-script output) ---

// Crop/scale filter for hover-preview montages: fill 426x240 (16:9), square pixels.
export const CROP =
  'scale=426:240:force_original_aspect_ratio=increase,crop=426:240,setsar=1';

// H.264 encode flags for the small, fast-starting preview montages.
export const ENCODE = ['-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
  '-r', '24', '-g', '48', '-crf', '30', '-preset', 'veryfast',
  '-fps_mode', 'cfr', '-movflags', '+faststart'];

const round1 = (n) => Math.round(n * 10) / 10;

// --- quality-variant planning (pure; used by build/variants.mjs) ---

// The Low/Medium/High ladder. Each tier carries its encode bitrate target and
// the manifest `bandwidth` (bits/s) so the player's quality menu can label it.
const VARIANT_TIERS = [
  { name: '1080p', height: 1080, vbitrate: '5000k', maxrate: '5500k', bufsize: '8000k', bandwidth: 5000000 },
  { name: '720p',  height: 720,  vbitrate: '2800k', maxrate: '3000k', bufsize: '5000k', bandwidth: 2800000 },
  { name: '360p',  height: 360,  vbitrate: '800k',  maxrate: '1000k', bufsize: '1500k', bandwidth: 800000 },
];

/**
 * Pick one representative ~`clip`-second window from a clip of duration `D`.
 * Starts ~25% in (skips dull intros) and never runs past the end. Returns
 * { start, length } in seconds. The thumbnail is grabbed from this same window
 * so the still always matches what plays.
 */
export function clipWindow(D, clip = 40) {
  // Floor (not round) to 0.1s so start+length can never spill past the source.
  const floor1 = (n) => Math.floor(n * 10) / 10;
  const length = floor1(Math.min(clip, Math.max(0, D)));
  const start = floor1(Math.min(Math.max(D * 0.25, 0), Math.max(0, D - length)));
  return { start, length };
}

/**
 * The quality ladder for a given source height: drop tiers taller than the
 * source, but always keep at least the smallest so every video has an option.
 * Returned highest-first.
 */
export function variantLadder(srcHeight) {
  const fit = VARIANT_TIERS.filter((t) => t.height <= srcHeight);
  return fit.length ? fit : [VARIANT_TIERS[VARIANT_TIERS.length - 1]];
}

// --- formatting ---

/** Format a duration in seconds as h:mm:ss or m:ss. */
export function fmtDur(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// --- preview montage segment planning (pure) ---

/** Sample points across a clip of duration D; returns [[start, length], ...]. */
export function segments(D) {
  if (D <= 4) return [[0, Math.max(1, round1(D))]];
  const L = D <= 10 ? Math.min(3, D / 3) : 3;
  const pts = D <= 10 ? [0.30, 0.70] : [0.15, 0.38, 0.62, 0.85];
  return pts.map((p) => [round1(Math.min(Math.max(p * D - L / 2, 0), D - L)), round1(L)]);
}

/** Build the ffmpeg -filter_complex string that trims + concatenates segments. */
export function buildFilter(segs) {
  const trims = segs.map(([s, L], i) =>
    `[0:v]trim=start=${s}:duration=${L},setpts=PTS-STARTPTS,${CROP}[v${i}]`);
  const labels = segs.map((_, i) => `[v${i}]`).join('');
  return `${trims.join(';')};${labels}concat=n=${segs.length}:v=1:a=0[out]`;
}

/**
 * ffmpeg argv for a thumbnail grab at seekSec. Scales to fit within 1280x720
 * while PRESERVING the source aspect ratio (no crop) — a 16:9 clip yields a
 * 1280x720 thumb, a portrait clip yields a tall native-aspect thumb. The grid
 * letterboxes portrait thumbs with a blurred fill rather than cropping them.
 */
function thumbArgs(file, dest, seekSec) {
  return ['-y', '-ss', String(seekSec), '-i', file, '-frames:v', '1',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease',
    '-q:v', '2', dest];
}

// --- per-video hover-scrub storyboards (sprite sheets) ---

// Geometry must match public/js/storyboard.js's spriteLocation() expectations.
const SB_INTERVAL = 2;   // seconds between sampled frames
const SB_TILE_W = 160;
const SB_TILE_H = 90;
const SB_COLUMNS = 5;
const SB_ROWS = 5;
const SB_TILES_PER_SHEET = SB_COLUMNS * SB_ROWS;

/**
 * Build per-video storyboard sprite sheets + a storyboard.json index in `outDir`.
 * Samples one frame every SB_INTERVAL seconds, packed into 5x5 tiled sheets.
 * Async (live ingest / backfill). Returns the meta object on success, else null.
 */
export async function makeStoryboardAsync(src, outDir, duration) {
  const vf = `fps=1/${SB_INTERVAL},scale=${SB_TILE_W}:${SB_TILE_H},tile=${SB_COLUMNS}x${SB_ROWS}`;
  const r = await run('ffmpeg',
    ['-y', '-i', src, '-vf', vf, '-q:v', '4', path.join(outDir, 'sprite-%d.jpg')]);
  if (r.status !== 0) return null;
  const d = duration || (await probeDurationAsync(src));
  const count = Math.max(1, Math.floor(d / SB_INTERVAL));
  const numSheets = Math.ceil(count / SB_TILES_PER_SHEET);
  const sheets = Array.from({ length: numSheets }, (_, i) => `sprite-${i + 1}.jpg`);
  return {
    interval: SB_INTERVAL, tileWidth: SB_TILE_W, tileHeight: SB_TILE_H,
    columns: SB_COLUMNS, rows: SB_ROWS, tilesPerSheet: SB_TILES_PER_SHEET,
    count, sheets,
  };
}

/** ffmpeg argv for a hover-preview montage. */
function previewArgs(file, dest, segs) {
  const args = ['-y', '-i', file, '-an'];
  if (segs.length === 1) {
    args.push('-vf', CROP);
  } else {
    args.push('-filter_complex', buildFilter(segs), '-map', '[out]');
  }
  args.push(...ENCODE, dest);
  return args;
}

// --- sync variants (offline build scripts) ---

/** Probe a file's duration in seconds (0 on failure). Sync. */
export function probeDuration(file) {
  const o = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf-8' });
  return parseFloat((o.stdout || '0').trim()) || 0;
}

/** Grab a single thumbnail frame. Sync. Returns true on success. */
export function makeThumb(file, dest, seekSec) {
  return spawnSync('ffmpeg', thumbArgs(file, dest, seekSec), { encoding: 'utf-8' }).status === 0;
}

/** Encode a hover-preview montage. Sync. Returns true on success. */
export function makePreview(file, dest, segs) {
  return spawnSync('ffmpeg', previewArgs(file, dest, segs), { encoding: 'utf-8' }).status === 0;
}

// --- async variants (live server; never block the event loop) ---

/** Run a command to completion, resolving { status, stdout, stderr }. Never rejects. */
export function run(cmd, args, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args);
    } catch {
      resolve({ status: -1, stdout: '', stderr: 'spawn failed' });
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ status: -1, stdout, stderr }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
}

/** Probe a file's duration in seconds (0 on failure). Async. */
export async function probeDurationAsync(file) {
  const o = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file]);
  return parseFloat((o.stdout || '0').trim()) || 0;
}

/** Grab a single thumbnail frame. Async. Returns true on success. */
export async function makeThumbAsync(file, dest, seekSec) {
  const r = await run('ffmpeg', thumbArgs(file, dest, seekSec));
  return r.status === 0;
}

/** Encode a hover-preview montage. Async. Returns true on success. */
export async function makePreviewAsync(file, dest, segs) {
  const r = await run('ffmpeg', previewArgs(file, dest, segs));
  return r.status === 0;
}

// --- quality variants (shared argv; used by build/variants.mjs + live ingest) ---

/**
 * Build the ffmpeg argv for one quality variant of [start, start+length].
 * Single source of truth so the offline build script and the live server
 * produce byte-identical encodes. Scales to the tier height (even width via -2),
 * keeps audio. `useNvenc` selects the GPU encoder when available.
 */
export function encodeArgs(src, dest, { start, length }, tier, useNvenc) {
  const vf = `scale=-2:${tier.height}`;
  const codecArgs = useNvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-b:v', tier.vbitrate,
       '-maxrate', tier.maxrate, '-bufsize', tier.bufsize]
    : ['-c:v', 'libx264', '-profile:v', 'main', '-preset', 'veryfast', '-b:v', tier.vbitrate,
       '-maxrate', tier.maxrate, '-bufsize', tier.bufsize];
  return ['-y', '-ss', String(start), '-i', src, '-t', String(length),
    '-vf', vf, ...codecArgs, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', dest];
}

let _nvenc = null;
/**
 * True only if h264_nvenc actually WORKS on this host (cached). Async.
 * A build can list h264_nvenc in `-encoders` while having no usable GPU
 * (e.g. libcuda.so.1 missing) — so we functionally probe with a 1-frame
 * encode to null rather than trusting the encoder list. On a GPU-less box
 * this returns false and callers fall back to libx264 (CPU).
 */
export async function hasNvenc() {
  if (_nvenc === null) {
    const o = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'color=c=black:s=64x64:d=0.1', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-']);
    _nvenc = o.status === 0;
  }
  return _nvenc;
}

/**
 * Encode one quality variant. Async (live ingest). Returns true on success.
 * Prefers the GPU encoder when available, but if an nvenc encode fails for any
 * reason it retries once on the CPU (libx264) so a flaky/absent GPU can't
 * blackhole every upload. ffmpeg stderr is logged on failure for diagnosis.
 */
export async function encodeVariantAsync(src, dest, window, tier) {
  const useNvenc = await hasNvenc();
  let r = await run('ffmpeg', encodeArgs(src, dest, window, tier, useNvenc), { timeoutMs: 1_800_000 });
  if (r.status !== 0) {
    console.error(`encode failed (${tier.name}, ${useNvenc ? 'nvenc' : 'libx264'}):`,
      (r.stderr || '').slice(-500));
    if (useNvenc) {
      // GPU path failed — fall back to CPU encoding for this variant.
      r = await run('ffmpeg', encodeArgs(src, dest, window, tier, false), { timeoutMs: 1_800_000 });
      if (r.status !== 0) {
        console.error(`encode failed (${tier.name}, libx264 fallback):`, (r.stderr || '').slice(-500));
      }
    }
  }
  return r.status === 0;
}

/** Probe the source video's pixel height (0 on failure). Async. */
export async function probeHeightAsync(file) {
  const o = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=height', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
  return parseInt((o.stdout || '0').trim(), 10) || 0;
}

// --- availability probes ---

let _ffmpeg = null;
let _ffprobe = null;

/** True if `ffmpeg` is callable on this host (cached). */
export function hasFfmpeg() {
  if (_ffmpeg === null) {
    _ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' }).status === 0;
  }
  return _ffmpeg;
}

/** True if `ffprobe` is callable on this host (cached). */
export function hasFfprobe() {
  if (_ffprobe === null) {
    _ffprobe = spawnSync('ffprobe', ['-version'], { encoding: 'utf-8' }).status === 0;
  }
  return _ffprobe;
}
