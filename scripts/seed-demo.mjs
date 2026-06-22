// DEV-ONLY local seeder: writes a throwaway manifest of placeholder videos so
// discovery (infinite scroll, categories, premium lock) can be verified without
// real uploads. NOT for production — run scripts/wipe-content.mjs --yes after.
// Usage: node scripts/seed-demo.mjs [count]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'public', 'thumbs', 'videos.json');

const N = Number(process.argv[2]) || 30;
const cats = ['travel', 'aerial', 'vlogs', 'tutorials', 'music', ''];
const base = Date.parse('2026-06-20T00:00:00Z');
const out = [];
for (let i = 0; i < N; i++) {
  const thumbIdx = String(i % 33).padStart(2, '0'); // reuse leftover static thumbs
  const premium = i % 7 === 0; // ~every 7th is premium
  out.push({
    id: `demo-${i}`,
    title: `Demo Video ${i + 1}`,
    description: `Placeholder entry #${i + 1} for local discovery testing.`,
    status: 'ready',
    duration: 30 + i,
    durLabel: `0:${String(30 + (i % 29)).padStart(2, '0')}`,
    thumb: `/thumbs/thumb-${thumbIdx}.jpg`,
    preview: null,
    uploaded: 'Jun 20, 2026',
    uploadedAt: base - i * 60000,
    published: true,
    visibility: premium ? 'premium' : 'free',
    blur: premium ? ['strong', 'medium', 'off'][i % 3] : 'off',
    category: cats[i % cats.length],
    qualityLevels: [],
    storyboard: null,
  });
}
fs.writeFileSync(MANIFEST, JSON.stringify(out, null, 2));
console.log(`Seeded ${N} demo videos (categories + ${out.filter((v) => v.visibility === 'premium').length} premium).`);
