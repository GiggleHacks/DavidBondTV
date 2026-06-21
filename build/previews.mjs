// Generates a short "hover preview" montage per Bangkok clip: a few ~3s
// segments sampled across the video, concatenated into one small muted looping
// MP4. The jump-cuts are baked in, so on the homepage we just play the clip on
// hover. Writes public/previews/preview-NN.mp4 and patches the `preview` field
// into public/thumbs/videos.json (index-aligned with thumbs.mjs).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = 'D:/Local/Traveling/Bangkok 2026/shopping jess barbie'; // same source as thumbs.mjs
const OUT = path.join(ROOT, 'public', 'previews');
const MANIFEST = path.join(ROOT, 'public', 'thumbs', 'videos.json');
const CROP = 'scale=426:240:force_original_aspect_ratio=increase,crop=426:240,setsar=1';

const round1 = (n) => Math.round(n * 10) / 10;

function probeDuration(file) {
  const o = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf-8' });
  return parseFloat((o.stdout || '0').trim()) || 0;
}

// Sample points across the clip; returns [[start, length], ...].
function segments(D) {
  if (D <= 4) return [[0, Math.max(1, round1(D))]];
  const L = D <= 10 ? Math.min(3, D / 3) : 3;
  const pts = D <= 10 ? [0.30, 0.70] : [0.15, 0.38, 0.62, 0.85];
  return pts.map((p) => [round1(Math.min(Math.max(p * D - L / 2, 0), D - L)), round1(L)]);
}

function buildFilter(segs) {
  const trims = segs.map(([s, L], i) =>
    `[0:v]trim=start=${s}:duration=${L},setpts=PTS-STARTPTS,${CROP}[v${i}]`);
  const labels = segs.map((_, i) => `[v${i}]`).join('');
  return `${trims.join(';')};${labels}concat=n=${segs.length}:v=1:a=0[out]`;
}

const ENCODE = ['-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
  '-r', '24', '-g', '48', '-crf', '30', '-preset', 'veryfast',
  '-fps_mode', 'cfr', '-movflags', '+faststart'];

function makePreview(file, dest, segs) {
  const args = ['-y', '-i', file, '-an'];
  if (segs.length === 1) {
    args.push('-vf', CROP);
  } else {
    args.push('-filter_complex', buildFilter(segs), '-map', '[out]');
  }
  args.push(...ENCODE, dest);
  return spawnSync('ffmpeg', args, { encoding: 'utf-8' }).status === 0;
}

fs.mkdirSync(OUT, { recursive: true });
const files = fs.readdirSync(SRC).filter((f) => /\.mp4$/i.test(f)).sort();
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));

files.forEach((f, i) => {
  const D = probeDuration(path.join(SRC, f));
  const segs = segments(D);
  const name = `preview-${String(i).padStart(2, '0')}.mp4`;
  process.stdout.write(`[${i + 1}/${files.length}] ${f} (${segs.length} seg)... `);
  const ok = makePreview(path.join(SRC, f), path.join(OUT, name), segs);
  console.log(ok ? 'ok' : 'FAILED');
  if (manifest[i]) manifest[i].preview = ok ? `/previews/${name}` : null;
});

fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
console.log(`\nPatched ${files.length} preview paths into videos.json`);
