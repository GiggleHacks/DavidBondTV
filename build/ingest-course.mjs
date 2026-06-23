// One-off batch ingester for "The Digital Image" course (Cohort 1) + its trailer.
//
// For each source episode it:
//   1. aggressively compresses to small 720p + 360p H.264 (GPU h264_nvenc, CPU
//      fallback) — these ARE the playback variants, no second re-encode.
//   2. grabs 5 thumbnail candidates, a hover-preview montage, and a storyboard.
//   3. extracts 16kHz mono audio and transcribes it with ffmpeg's built-in
//      whisper filter (model in ./whisper/ggml-base.en.bin) → build/transcripts/.
//   4. appends a ready manifest entry to content/thumbs/videos.json (atomic).
//
// Episodes are ingested as visibility:'premium' (course-gated once assigned to
// the product). The trailer is ingested as visibility:'free' + unlisted:true so
// it plays for everyone but never shows up in the general library grid.
//
// Resumable: a state file (build/ingest-course.state.json) records each source's
// assigned id + done flag, so re-running skips finished work. Titles are left as
// the cleaned filename and descriptions blank here — the real marketer copy is
// written in a second pass from the transcripts.
//
// Run:  node build/ingest-course.mjs
import { spawnSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  run, probeDurationAsync, probeHeightAsync, fmtDur, segments,
  makeThumbAsync, makePreviewAsync, makeStoryboardAsync,
} from '../lib/media.mjs';
import {
  MANIFEST, THUMBS_DIR, PREVIEWS_DIR, VIDEOS_DIR, STORYBOARDS_DIR,
} from '../lib/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// --- config -----------------------------------------------------------------

const COURSE_DIR = 'D:/Local/Digital Products/Digial Image Course (Edited)/Digital Image - Cohort 1';
const TRAILER_SRC = 'C:/Users/qxdc/Downloads/The Digital Image - HACK YOUR SOCIAL MEDIA TO ATTRACT WOMEN.mp4';
const WHISPER_MODEL = path.join(ROOT, 'whisper', 'ggml-base.en.bin');
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');
const STATE_FILE = path.join(__dirname, 'ingest-course.state.json');
const SRC_RE = /\.(mp4|mov|m4v|mkv)$/i;

// Aggressive small ladder (confirmed): 720p ~1.5Mbps cap, 360p ~600k, AAC 128k.
const TIERS = [
  { name: '720p', height: 720, vbitrate: '1300k', maxrate: '1500k', bufsize: '3000k', bandwidth: 1500000 },
  { name: '360p', height: 360, vbitrate: '500k',  maxrate: '600k',  bufsize: '1200k', bandwidth: 600000 },
];

const HOURS6 = 6 * 60 * 60 * 1000; // generous per-step timeout for multi-hour masters

// --- nvenc detection (functional, cached) -----------------------------------

let _useNvenc = null;
function useNvenc() {
  if (_useNvenc === null) {
    const o = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf-8' });
    _useNvenc = (o.stdout || '').includes('h264_nvenc');
  }
  return _useNvenc;
}

// --- helpers ----------------------------------------------------------------

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch { return { episodes: [], trailer: null }; }
}
function saveState(s) {
  fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(s, null, 2));
  fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}

/** Atomic read-modify-write of the manifest (matches lib/ingest.mjs behaviour). */
function appendManifest(entry) {
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')); } catch { arr = []; }
  // De-dupe by id so a resumed run never double-inserts.
  arr = arr.filter((e) => e.id !== entry.id);
  arr.unshift(entry);
  fs.writeFileSync(`${MANIFEST}.tmp`, JSON.stringify(arr, null, 2));
  fs.renameSync(`${MANIFEST}.tmp`, MANIFEST);
}

/** Encode one tier of the FULL clip. Aggressive small settings; CPU fallback. */
async function encodeTier(src, dest, tier) {
  const vf = `scale=-2:'min(${tier.height},ih)'`;
  const common = ['-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', dest];
  const nvenc = ['-y', '-i', src, '-vf', vf,
    '-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr',
    '-b:v', tier.vbitrate, '-maxrate', tier.maxrate, '-bufsize', tier.bufsize, ...common];
  const cpu = ['-y', '-i', src, '-vf', vf,
    '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'veryfast',
    '-b:v', tier.vbitrate, '-maxrate', tier.maxrate, '-bufsize', tier.bufsize, ...common];
  let r = useNvenc() ? await run('ffmpeg', nvenc, { timeoutMs: HOURS6 }) : { status: 1 };
  if (r.status !== 0) {
    if (useNvenc()) console.warn(`  nvenc failed for ${tier.name}, falling back to libx264`);
    r = await run('ffmpeg', cpu, { timeoutMs: HOURS6 });
  }
  return r.status === 0;
}

/** Spawn a command with an explicit cwd. Resolves { status, stderr }; never rejects. */
function runIn(cwd, cmd, args, timeoutMs = 600_000) {
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try { child = spawn(cmd, args, { cwd }); }
    catch { resolve({ status: -1, stderr: 'spawn failed' }); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ status: -1, stderr }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stderr }); });
  });
}

/**
 * Transcribe to plain text via ffmpeg's built-in whisper filter. The filtergraph
 * parser treats ':' and spaces as separators, so we run ffmpeg with cwd set to
 * the whisper dir and reference the model + output by bare filename, then move
 * the transcript into build/transcripts/. Returns the transcript text or ''.
 */
async function transcribe(src, id) {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const txt = path.join(TRANSCRIPTS_DIR, `${id}.txt`);
  if (fs.existsSync(txt) && fs.statSync(txt).size > 0) return fs.readFileSync(txt, 'utf-8');
  const wav = path.join(TRANSCRIPTS_DIR, `${id}.wav`);
  const ex = await run('ffmpeg', ['-y', '-i', src, '-vn', '-ar', '16000', '-ac', '1',
    '-c:a', 'pcm_s16le', wav], { timeoutMs: HOURS6 });
  if (ex.status !== 0) { console.warn('  audio extract failed'); return ''; }
  const whisperDir = path.join(ROOT, 'whisper');
  const filter = `whisper=model=${path.basename(WHISPER_MODEL)}:language=en:queue=10:`
    + `destination=${id}.txt:format=text:use_gpu=true`;
  const w = await runIn(whisperDir, 'ffmpeg', ['-y', '-i', wav, '-af', filter, '-f', 'null', '-'], HOURS6);
  try { fs.unlinkSync(wav); } catch { /* ignore */ }
  const produced = path.join(whisperDir, `${id}.txt`);
  if (w.status === 0 && fs.existsSync(produced)) {
    fs.renameSync(produced, txt);
    return fs.readFileSync(txt, 'utf-8');
  }
  console.warn('  whisper failed:', (w.stderr || '').slice(-300));
  return '';
}

/** Full per-source pipeline. Returns the assigned id (existing or new). */
async function ingest(src, { visibility, unlisted, displayTitle, existingId }) {
  const id = existingId || crypto.randomUUID();
  console.log(`\n=== ${displayTitle}\n    id=${id}`);

  const duration = await probeDurationAsync(src);
  const height = (await probeHeightAsync(src)) || 720;
  console.log(`    ${fmtDur(duration)}, ${height}p source — encoding (${useNvenc() ? 'nvenc' : 'libx264'})`);

  // 1) Compress. Encode 720p straight from the (huge) source ONCE, then derive
  //    360p and every thumbnail/preview/storyboard/transcript from that small
  //    720p file — so the multi-GB master is only read through a single time.
  const outDir = path.join(VIDEOS_DIR, id);
  fs.mkdirSync(outDir, { recursive: true });
  const qualityLevels = [];
  const want720 = height >= 700;
  let workSrc = src;
  if (want720) {
    const dest = path.join(outDir, '720p.mp4');
    process.stdout.write('    720p ... ');
    const ok = await encodeTier(src, dest, TIERS[0]);
    console.log(ok ? `ok (${(fs.statSync(dest).size / 1e6).toFixed(0)} MB)` : 'FAILED');
    if (ok) { qualityLevels.push({ height: 720, bitrate: TIERS[0].bandwidth, url: `/videos/${id}/720p.mp4` }); workSrc = dest; }
  }
  {
    const dest = path.join(outDir, '360p.mp4');
    process.stdout.write('    360p ... ');
    const ok = await encodeTier(workSrc, dest, TIERS[1]);
    console.log(ok ? `ok (${(fs.statSync(dest).size / 1e6).toFixed(0)} MB)` : 'FAILED');
    if (ok) qualityLevels.push({ height: 360, bitrate: TIERS[1].bandwidth, url: `/videos/${id}/360p.mp4` });
  }
  if (!qualityLevels.length) throw new Error('no playable variant produced');
  // Sort highest-first so the player's quality menu reads top-down like the rest of the site.
  qualityLevels.sort((a, b) => b.height - a.height);

  // 2) Thumbnails (5 candidates), default = 30%.
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  const pcts = [0.1, 0.3, 0.5, 0.7, 0.9];
  const thumbCandidates = [];
  let defaultThumb = '';
  for (let i = 0; i < pcts.length; i += 1) {
    const seek = Math.max(0, Math.min(duration - 0.1, duration * pcts[i]));
    const name = `thumb-${id}-${i}.jpg`;
    // eslint-disable-next-line no-await-in-loop
    if (await makeThumbAsync(workSrc, path.join(THUMBS_DIR, name), seek)) {
      thumbCandidates.push(`/thumbs/${name}`);
      if (i === 1) defaultThumb = `/thumbs/${name}`;
    }
  }
  if (!defaultThumb) defaultThumb = thumbCandidates[0] || '';

  // 3) Hover preview montage.
  fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
  const previewName = `preview-${id}.mp4`;
  const previewOk = await makePreviewAsync(workSrc, path.join(PREVIEWS_DIR, previewName), segments(duration));

  // 4) Storyboard sprite sheets.
  const sbDir = path.join(STORYBOARDS_DIR, id);
  fs.mkdirSync(sbDir, { recursive: true });
  const sbMeta = await makeStoryboardAsync(workSrc, sbDir, duration);
  if (sbMeta) fs.writeFileSync(path.join(sbDir, 'storyboard.json'), JSON.stringify(sbMeta, null, 2));

  // 5) Transcribe (for the later title/description pass).
  process.stdout.write('    transcribing ... ');
  const tr = await transcribe(workSrc, id);
  console.log(tr ? `ok (${tr.length} chars)` : 'skipped');

  // 6) Manifest entry.
  const uploaded = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  appendManifest({
    id,
    title: displayTitle,
    description: '',
    autoGenerated: false,
    status: 'ready',
    duration,
    durLabel: fmtDur(duration),
    thumb: defaultThumb,
    thumbCandidates,
    preview: previewOk ? `/previews/${previewName}` : null,
    storyboard: sbMeta ? `/storyboards/${id}/storyboard.json` : null,
    qualityLevels,
    uploaded,
    uploadedAt: Date.now(),
    published: true,
    publishAt: null,
    visibility,
    unlisted: !!unlisted,
    blur: visibility === 'premium' ? 'medium' : 'off',
    category: '',
  });
  return id;
}

// --- main -------------------------------------------------------------------

/** "Day 01 - Part 03 - Photos Jack sparrow.mp4" -> "Day 01 — Part 03 — Photos". */
function cleanTitle(base) {
  return base
    .replace(SRC_RE, '')
    .replace(/\s*Jack sparrow\s*(\(\d+\))?\s*$/i, '')
    .replace(/\.mp4\s*/i, '')
    .replace(/\s*-\s*/g, ' — ')
    .trim();
}

async function main() {
  if (!fs.existsSync(WHISPER_MODEL)) {
    console.error(`Whisper model missing: ${WHISPER_MODEL}`);
    process.exit(1);
  }
  const state = loadState();

  // Build the ordered episode list, dropping the exact-size duplicate "(1)".
  const files = fs.readdirSync(COURSE_DIR)
    .filter((f) => SRC_RE.test(f))
    .filter((f) => !/\(1\)\.mp4$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  console.log(`Encoder: ${useNvenc() ? 'h264_nvenc (GPU)' : 'libx264 (CPU)'}`);
  console.log(`${files.length} episodes + 1 trailer\n`);

  // Trailer first (small, fast) — validates the whole pipeline before the
  // multi-hour episode encodes start. Free + unlisted.
  if (!state.trailer || !state.trailer.done) {
    if (!state.trailer) state.trailer = { id: crypto.randomUUID(), done: false };
    saveState(state);
    try {
      await ingest(TRAILER_SRC, {
        visibility: 'free', unlisted: true,
        displayTitle: 'The Digital Image — Official Trailer', existingId: state.trailer.id,
      });
      state.trailer.done = true; saveState(state);
    } catch (err) {
      console.error(`  TRAILER FAILED: ${err.message}`);
    }
  } else {
    console.log('SKIP (done): trailer');
  }

  for (const f of files) {
    let rec = state.episodes.find((e) => e.base === f);
    if (rec && rec.done) { console.log(`SKIP (done): ${f}`); continue; }
    if (!rec) { rec = { base: f, id: crypto.randomUUID(), done: false }; state.episodes.push(rec); saveState(state); }
    const src = path.join(COURSE_DIR, f);
    try {
      await ingest(src, { visibility: 'premium', unlisted: false, displayTitle: cleanTitle(f), existingId: rec.id });
      rec.done = true; saveState(state);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
    }
  }

  // Print the assembled ids for product creation.
  console.log('\n--- DONE ---');
  console.log('Episode ids (in order):');
  state.episodes.filter((e) => e.done).forEach((e) => console.log(`  ${e.id}  ${e.base}`));
  console.log(`Trailer id: ${state.trailer && state.trailer.done ? state.trailer.id : '(not done)'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
