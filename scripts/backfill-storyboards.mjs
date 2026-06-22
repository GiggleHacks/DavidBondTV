// One-time backfill: generate hover-scrub storyboards (and crisper 720p posters
// where source quality allows) for videos that pre-date the storyboard pipeline.
// Originals are long gone, so we source from each video's best stored rendition
// in public/videos/<id>/. Idempotent: skips entries that already have a board.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStoryboardAsync, makeThumbAsync, probeDurationAsync, hasFfmpeg } from '../lib/media.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'public', 'thumbs', 'videos.json');
const VIDEOS_DIR = path.join(ROOT, 'public', 'videos');
const THUMBS_DIR = path.join(ROOT, 'public', 'thumbs');
const STORYBOARDS_DIR = path.join(ROOT, 'public', 'storyboards');

if (!hasFfmpeg()) { console.error('ffmpeg not found — aborting.'); process.exit(1); }

const arr = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));

/** Best available rendition mp4 for an id (highest height first), or null. */
function bestRendition(entry) {
  const dir = path.join(VIDEOS_DIR, entry.id);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')); } catch { return null; }
  if (!files.length) return null;
  const rank = (f) => parseInt(f, 10) || 0; // "720p.mp4" → 720
  files.sort((a, b) => rank(b) - rank(a));
  return { file: path.join(dir, files[0]), height: rank(files[0]) };
}

let made = 0;
let thumbs = 0;
for (const e of arr) {
  if (e.status && e.status !== 'ready') continue;
  const src = bestRendition(e);
  if (!src) { continue; }

  if (!e.storyboard) {
    const sbDir = path.join(STORYBOARDS_DIR, e.id);
    fs.mkdirSync(sbDir, { recursive: true });
    const duration = e.duration || (await probeDurationAsync(src.file));
    const meta = await makeStoryboardAsync(src.file, sbDir, duration);
    if (meta) {
      fs.writeFileSync(path.join(sbDir, 'storyboard.json'), JSON.stringify(meta, null, 2));
      e.storyboard = `/storyboards/${e.id}/storyboard.json`;
      made++;
      process.stdout.write(`  storyboard: ${e.id} (${e.title})\n`);
    }
  }

  // Re-grab a crisp poster only when the source is actually >=720p (don't upscale).
  if (src.height >= 720) {
    const name = `thumb-${e.id}.jpg`;
    const seek = Math.max(1, Math.floor((e.duration || 5) * 0.3));
    if (await makeThumbAsync(src.file, path.join(THUMBS_DIR, name), seek)) {
      e.thumb = `/thumbs/${name}`;
      thumbs++;
    }
  }
}

fs.writeFileSync(MANIFEST, JSON.stringify(arr, null, 2));
console.log(`\nDone. ${made} storyboards, ${thumbs} thumbnails regenerated.`);
