import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'bikinis.mp4');
const HLS_DIR = path.join(ROOT, 'media', 'hls');

const RENDITIONS = [
  { name: '360p',  width: 640,  height: 360,  maxrate: '856k',   bufsize: '1200k',  abitrate: '96k',  bandwidth: 900000 },
  { name: '480p',  width: 854,  height: 480,  maxrate: '1498k',  bufsize: '2100k',  abitrate: '128k', bandwidth: 1600000 },
  { name: '720p',  width: 1280, height: 720,  maxrate: '2996k',  bufsize: '4200k',  abitrate: '128k', bandwidth: 3000000 },
  { name: '1080p', width: 1920, height: 1080, maxrate: '5350k',  bufsize: '7500k',  abitrate: '192k', bandwidth: 5350000 },
  { name: '1440p', width: 2560, height: 1440, maxrate: '10700k', bufsize: '15000k', abitrate: '192k', bandwidth: 10700000 },
];

function requireFfmpeg() {
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' });
  if (probe.status !== 0) {
    console.error('ERROR: ffmpeg not found on PATH. Install ffmpeg and retry.');
    process.exit(1);
  }
}

function transcode(r) {
  const outDir = path.join(HLS_DIR, r.name);
  fs.mkdirSync(outDir, { recursive: true });
  const vf = `scale=w=${r.width}:h=${r.height}:force_original_aspect_ratio=decrease,` +
             `pad=${r.width}:${r.height}:(ow-iw)/2:(oh-ih)/2`;

  const args = [
    '-y', '-i', SOURCE,
    '-vf', vf,
    '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'veryfast',
    '-crf', '20', '-maxrate', r.maxrate, '-bufsize', r.bufsize,
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', r.abitrate, '-ac', '2',
    '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(outDir, 'seg_%03d.ts'),
    path.join(outDir, 'playlist.m3u8'),
  ];

  console.log(`\nTranscoding ${r.name} (${r.width}x${r.height})...`);
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`ERROR: ffmpeg failed for ${r.name}`);
    process.exit(1);
  }
}

function writeMasterPlaylist() {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const r of RENDITIONS) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${r.width}x${r.height}`);
    lines.push(`${r.name}/playlist.m3u8`);
  }
  const masterPath = path.join(HLS_DIR, 'master.m3u8');
  fs.writeFileSync(masterPath, lines.join('\n') + '\n');
  console.log(`\nWrote ${masterPath}`);
}

requireFfmpeg();
if (!fs.existsSync(SOURCE)) {
  console.error(`ERROR: source not found: ${SOURCE}`);
  process.exit(1);
}
fs.mkdirSync(HLS_DIR, { recursive: true });
for (const r of RENDITIONS) transcode(r);
writeMasterPlaylist();
console.log('\nHLS ladder complete.');
