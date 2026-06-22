// Guarded content wipe: removes ALL videos + their derived data so the library
// starts clean for launch. Reuses deleteVideo() (which already cleans per-video
// assets: public/videos/<id>/, thumbs, previews, storyboards, originals), then
// zeroes the video-tied stores. PRESERVES accounts, admin creds, geo rules.
//
// Usage: node scripts/wipe-content.mjs --yes
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteVideo } from '../lib/ingest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'public', 'thumbs', 'videos.json');
const DATA = path.join(ROOT, 'data');

if (!process.argv.includes('--yes')) {
  console.error('Refusing to wipe without --yes. This deletes ALL videos + their comments/reactions/analytics.');
  console.error('Preserved: accounts (users.json), admin (admin.json, admin-credentials.txt), geo-rules.json, avatars.');
  process.exit(1);
}

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

// 1. Delete every video (assets + manifest entry) via the canonical path.
const manifest = readJson(MANIFEST, []);
let ok = 0;
for (const v of manifest) {
  const r = await deleteVideo(v.id);
  if (r.ok) { ok += 1; process.stdout.write(`  removed ${v.id} (${v.title || ''})\n`); }
  else process.stdout.write(`  SKIP ${v.id}: ${r.error}\n`);
}
// Belt-and-suspenders: ensure the manifest is an empty array.
writeJson(MANIFEST, []);

// 2. Zero the video-tied stores so launch stats/threads start clean.
writeJson(path.join(DATA, 'comments.json'), {});
writeJson(path.join(DATA, 'reactions.json'), {});

// 3. Clear analytics rollups + raw logs (keep the folders).
const ANALYTICS = path.join(DATA, 'analytics');
for (const f of ['videos.json', 'countries.json', 'users.json', 'totals.json', 'blocked.json']) {
  try { fs.rmSync(path.join(ANALYTICS, f), { force: true }); } catch { /* not present */ }
}
try {
  const raw = path.join(ANALYTICS, 'raw');
  for (const f of fs.readdirSync(raw)) fs.rmSync(path.join(raw, f), { force: true });
} catch { /* no raw dir */ }

console.log(`\nWiped ${ok}/${manifest.length} videos. Library is clean. Accounts + admin preserved.`);
