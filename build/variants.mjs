// Generates real, audible Low/Medium/High playback variants for every video in
// the manifest — fixing the watch page that previously only played the tiny
// 240p muted hover-montage. For each entry (matched BY id, so thumbnail +
// qualities + metadata all come from the same source file):
//   1. cut one representative ~40s segment (clipWindow)
//   2. encode it at 360p / 720p / 1080p (variantLadder), with audio
//   3. grab the thumbnail from that SAME segment (so the still matches playback)
//   4. patch qualityLevels + duration into public/thumbs/videos.json (atomic)
//
// Outputs land in public/videos/<id>/<name>.mp4 (gitignored). Prefers the GPU
// encoder h264_nvenc when present, else libx264. Zero deps — just spawns ffmpeg.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  probeDuration, fmtDur, clipWindow, variantLadder, hasFfmpeg, encodeArgs,
} from '../lib/media.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'public', 'thumbs', 'videos.json');
const VIDEOS_OUT = path.join(ROOT, 'public', 'videos');
const THUMBS_OUT = path.join(ROOT, 'public', 'thumbs');

// Where original source clips might live, matched by id (filename without ext).
const SRC_DIRS = [
  ROOT,
  'D:/Local/Traveling/Bangkok 2026/shopping jess barbie',
];
const SRC_RE = /\.(mp4|mov|m4v)$/i;

if (!hasFfmpeg()) {
  console.error('ERROR: ffmpeg not found on PATH. Install ffmpeg and retry.');
  process.exit(1);
}

/** Does this ffmpeg build expose the given encoder? (cached) */
let _encoders = null;
function hasEncoder(name) {
  if (_encoders === null) {
    const o = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf-8' });
    _encoders = o.stdout || '';
  }
  return _encoders.includes(name);
}
const USE_NVENC = hasEncoder('h264_nvenc');
const VCODEC = USE_NVENC ? 'h264_nvenc' : 'libx264';

/** Build id -> source path map by scanning the known source directories. */
function buildSourceMap() {
  const map = new Map();
  for (const dir of SRC_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!SRC_RE.test(f)) continue;
      const id = f.replace(SRC_RE, '');
      if (!map.has(id)) map.set(id, path.join(dir, f)); // first dir wins
    }
  }
  return map;
}

/** Probe the source video height (0 on failure). */
function probeHeight(file) {
  const o = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=height', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { encoding: 'utf-8' });
  return parseInt((o.stdout || '0').trim(), 10) || 0;
}

/** Encode one quality variant of [start, start+length] from src. */
function encodeVariant(src, dest, window, tier) {
  const args = encodeArgs(src, dest, window, tier, USE_NVENC);
  return spawnSync('ffmpeg', args, { encoding: 'utf-8' }).status === 0;
}

/** Grab a representative thumbnail from within the same segment. */
function grabThumb(src, dest, { start, length }) {
  const seek = start + length * 0.3;
  const args = ['-y', '-ss', String(seek), '-i', src, '-frames:v', '1',
    '-vf', 'thumbnail,scale=480:270:force_original_aspect_ratio=increase,crop=480:270',
    '-q:v', '3', dest];
  return spawnSync('ffmpeg', args, { encoding: 'utf-8' }).status === 0;
}

// --- main ---------------------------------------------------------------

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
const srcMap = buildSourceMap();
fs.mkdirSync(VIDEOS_OUT, { recursive: true });
fs.mkdirSync(THUMBS_OUT, { recursive: true });

console.log(`Encoder: ${VCODEC}${USE_NVENC ? ' (GPU)' : ''}\n`);

let done = 0;
let skipped = 0;
for (let i = 0; i < manifest.length; i++) {
  const entry = manifest[i];
  const src = srcMap.get(entry.id);
  process.stdout.write(`[${i + 1}/${manifest.length}] ${entry.id} ... `);

  if (!src) { console.log('SKIP (no source)'); skipped++; continue; }

  const dur = probeDuration(src);
  const height = probeHeight(src) || 1080;
  const win = clipWindow(dur);
  const tiers = variantLadder(height);

  const outDir = path.join(VIDEOS_OUT, entry.id);
  fs.mkdirSync(outDir, { recursive: true });

  const qualityLevels = [];
  let ok = true;
  for (const tier of tiers) {
    const dest = path.join(outDir, `${tier.name}.mp4`);
    const good = encodeVariant(src, dest, win, tier);
    if (!good) { ok = false; break; }
    qualityLevels.push({ height: tier.height, bitrate: tier.bandwidth, url: `/videos/${entry.id}/${tier.name}.mp4` });
  }
  if (!ok) { console.log('FAILED (encode)'); skipped++; continue; }

  // Refresh the thumbnail from the same window, overwriting the existing path.
  const thumbName = path.basename(entry.thumb || `thumb-${String(i).padStart(2, '0')}.jpg`);
  grabThumb(src, path.join(THUMBS_OUT, thumbName), win);

  entry.qualityLevels = qualityLevels;
  entry.duration = win.length;
  entry.durLabel = fmtDur(win.length);
  entry.thumb = `/thumbs/${thumbName}`;

  done++;
  console.log(`ok (${tiers.map((t) => t.name).join('/')}, ${fmtDur(win.length)} from ${win.start}s)`);
}

// Atomic manifest write.
const tmp = `${MANIFEST}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
fs.renameSync(tmp, MANIFEST);

console.log(`\nDone. ${done} encoded, ${skipped} skipped. Patched ${MANIFEST}.`);
