// Generates a poster thumbnail + metadata for each Bangkok clip, for the
// multi-video homepage preview. Reads from the source folder, writes
// public/thumbs/*.jpg and public/thumbs/videos.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtDur, probeDuration, makeThumb } from '../lib/media.mjs';
import { THUMBS_DIR as OUT } from '../lib/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = 'D:/Local/Traveling/Bangkok 2026/shopping jess barbie';

const TITLES = [
  'Bangkok Barbie Haul 🛍️ Jess Goes Wild at the Mall',
  'Chatuchak Weekend Market Shopping Spree',
  'Jess Finds the CUTEST Barbie Collab in Siam',
  'MBK Center Tour — Best Deals in Bangkok',
  'Pink Everything! 💗 Barbie Café Bangkok Vlog',
  'Street Food Break Between Shopping 🍜',
  'ICONSIAM Luxury Window Shopping with Jess',
  'Terminal 21 — Shopping Around the World',
  "Jess's Bangkok Outfit of the Day Lookbook",
  'Night Market Bargain Hunting 🌙',
  'Unboxing the Barbie Dreamhouse in Our Hotel',
  'Platinum Fashion Mall — Wholesale Madness',
  'Jess Tries On EVERYTHING at Siam Paragon',
  'Sunset Shopping at Asiatique Riverfront',
  'Barbie Pink Tuk-Tuk Tour of Bangkok 🛺',
  'Mega Bangna Haul — What Did Jess Buy?!',
  'Cute Cafés & Shopping in Ari District',
  'Jess vs. the Floating Market 🚤',
  'Best Souvenirs & Gifts from Bangkok',
  'Late Night Convenience Store Run',
  'Rooftop Views + Shopping Recap with Jess',
  'EmQuartierLuxury Mall Walkthrough',
  'Jess Builds the Ultimate Barbie Collection',
  'Bangkok Mall Food Court Taste Test',
  'Pratunam Market — Hidden Gems',
  'Jess Goes Thrifting in Bangkok',
  'Pastel Aesthetic Shopping Day 💕',
  'The BIGGEST Toy Store in Thailand',
  "Jess's Final Bangkok Shopping Haul",
  'Packing Up — All the Barbie Loot!',
  'Bonus: Bloopers from the Shopping Trip 😂',
  'Bangkok at Night — Last Day Vlog',
  'Thank You Bangkok ❤️ Trip Recap',
];

// Real upload date = the source file's last-modified time (a genuine timestamp).
function uploadDate(file) {
  return fs.statSync(file).mtime.toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

fs.mkdirSync(OUT, { recursive: true });
const files = fs.readdirSync(SRC).filter((f) => /\.mp4$/i.test(f)).sort();
const videos = [];

files.forEach((f, i) => {
  const full = path.join(SRC, f);
  const dur = probeDuration(full);
  const seek = Math.max(1, Math.floor(dur * 0.3));
  const thumbName = `thumb-${String(i).padStart(2, '0')}.jpg`;
  process.stdout.write(`[${i + 1}/${files.length}] ${f} (${fmtDur(dur)})... `);
  const ok = makeThumb(full, path.join(OUT, thumbName), seek);
  console.log(ok ? 'ok' : 'FAILED');
  videos.push({
    id: f.replace(/\.mp4$/i, ''),
    title: TITLES[i % TITLES.length],
    duration: dur,
    durLabel: fmtDur(dur),
    thumb: `/thumbs/${thumbName}`,
    uploaded: uploadDate(full),
  });
});

fs.writeFileSync(path.join(OUT, 'videos.json'), JSON.stringify(videos, null, 2));
console.log(`\nWrote ${videos.length} entries to public/thumbs/videos.json`);
