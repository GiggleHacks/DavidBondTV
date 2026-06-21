// Generates a short "hover preview" montage per Bangkok clip: a few ~3s
// segments sampled across the video, concatenated into one small muted looping
// MP4. The jump-cuts are baked in, so on the homepage we just play the clip on
// hover. Writes public/previews/preview-NN.mp4 and patches the `preview` field
// into public/thumbs/videos.json (index-aligned with thumbs.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeDuration, segments, makePreview } from '../lib/media.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = 'D:/Local/Traveling/Bangkok 2026/shopping jess barbie'; // same source as thumbs.mjs
const OUT = path.join(ROOT, 'public', 'previews');
const MANIFEST = path.join(ROOT, 'public', 'thumbs', 'videos.json');

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
