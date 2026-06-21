// Shared ffmpeg/ffprobe helpers used by the offline build scripts (sync) and
// the live server ingestion path (async). Zero dependencies — we only spawn
// ffmpeg/ffprobe. Keep behavior identical to the original build scripts.
import { spawnSync, spawn } from 'node:child_process';

// --- shared constants (must match the original build-script output) ---

// Crop/scale filter for hover-preview montages: fill 426x240 (16:9), square pixels.
export const CROP =
  'scale=426:240:force_original_aspect_ratio=increase,crop=426:240,setsar=1';

// H.264 encode flags for the small, fast-starting preview montages.
export const ENCODE = ['-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
  '-r', '24', '-g', '48', '-crf', '30', '-preset', 'veryfast',
  '-fps_mode', 'cfr', '-movflags', '+faststart'];

const round1 = (n) => Math.round(n * 10) / 10;

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

/** ffmpeg argv for a thumbnail grab at seekSec. */
function thumbArgs(file, dest, seekSec) {
  return ['-y', '-ss', String(seekSec), '-i', file, '-frames:v', '1',
    '-vf', 'scale=480:270:force_original_aspect_ratio=increase,crop=480:270',
    '-q:v', '3', dest];
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
