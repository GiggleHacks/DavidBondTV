import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'bikinis.mp4');
const MEDIA_DIR = path.join(ROOT, 'media');
const SB_DIR = path.join(MEDIA_DIR, 'storyboard');

const INTERVAL = 2;       // seconds between thumbnails
const TILE_W = 160;
const TILE_H = 90;
const COLUMNS = 5;
const ROWS = 5;
const TILES_PER_SHEET = COLUMNS * ROWS;

function requireTools() {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const probe = spawnSync(tool, ['-version'], { encoding: 'utf-8' });
    if (probe.status !== 0) {
      console.error(`ERROR: ${tool} not found on PATH. Install ffmpeg and retry.`);
      process.exit(1);
    }
  }
}

function getDuration() {
  const out = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', SOURCE,
  ], { encoding: 'utf-8' });
  if (out.status !== 0) {
    console.error('ERROR: ffprobe failed to read duration.');
    process.exit(1);
  }
  return parseFloat(out.stdout.trim());
}

function buildSprites() {
  const vf = `fps=1/${INTERVAL},scale=${TILE_W}:${TILE_H},tile=${COLUMNS}x${ROWS}`;
  const args = ['-y', '-i', SOURCE, '-vf', vf, '-q:v', '4', path.join(SB_DIR, 'sprite-%d.jpg')];
  console.log('Generating storyboard sprite sheets...');
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('ERROR: ffmpeg failed generating sprites.');
    process.exit(1);
  }
}

function buildPoster() {
  const args = ['-y', '-ss', '5', '-i', SOURCE, '-frames:v', '1', '-q:v', '3',
    path.join(MEDIA_DIR, 'poster.jpg')];
  console.log('Generating poster...');
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('ERROR: ffmpeg failed generating poster.');
    process.exit(1);
  }
}

function writeIndex(duration) {
  const count = Math.floor(duration / INTERVAL);
  const numSheets = Math.ceil(count / TILES_PER_SHEET);
  const sheets = Array.from({ length: numSheets }, (_, i) => `sprite-${i + 1}.jpg`);
  const meta = {
    interval: INTERVAL,
    tileWidth: TILE_W,
    tileHeight: TILE_H,
    columns: COLUMNS,
    rows: ROWS,
    tilesPerSheet: TILES_PER_SHEET,
    count,
    sheets,
  };
  fs.writeFileSync(path.join(SB_DIR, 'storyboard.json'), JSON.stringify(meta, null, 2));
  console.log(`Wrote storyboard.json (count=${count}, sheets=${numSheets}).`);
}

requireTools();
if (!fs.existsSync(SOURCE)) {
  console.error(`ERROR: source not found: ${SOURCE}`);
  process.exit(1);
}
fs.mkdirSync(SB_DIR, { recursive: true });
const duration = getDuration();
buildSprites();
buildPoster();
writeIndex(duration);
console.log('\nStoryboard complete.');
