// Phase 4: configure the Digital Pickup 2.0 course product from the ingest
// journal (build/dp-ingest-result.json). Reuses lib/products.js. Idempotent —
// safe to re-run. Run AFTER build/ingest-digital-pickup.mjs has finished.
//
//   node build/configure-digital-pickup.mjs
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as products from '../lib/products.js';
import { listManifest, bulkAction } from '../lib/ingest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULT_FILE = path.join(__dirname, 'dp-ingest-result.json');
const PRODUCT_ID = 'prod_digital_pickup';

const result = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
const lessons = (result.lessons || []).filter((l) => l && l.id);
if (!lessons.length) { console.error('No lessons in journal — run the ingest first.'); process.exit(1); }

// Sanity: confirm every lesson id is a ready manifest entry.
const ready = new Set(listManifest().filter((e) => (e.status || 'ready') === 'ready').map((e) => e.id));
const missing = lessons.filter((l) => !ready.has(l.id));
if (missing.length) {
  console.error(`Not all lessons are ready yet (${missing.length} pending):`);
  for (const m of missing) console.error(`  • ${m.title} (${m.id})`);
  process.exit(1);
}

const orderedIds = lessons.slice().sort((a, b) => a.order - b.order).map((l) => l.id);

// The fixed-id seed (prod_digital_pickup) only materializes when products.json is
// missing/corrupt. A prior deploy may have left it as an empty []  — in which case
// remove that empty file so list() re-seeds the product, keeping its stable id.
if (!products.getById(PRODUCT_ID)) {
  const f = process.env.PRODUCTS_FILE || path.join(__dirname, '..', 'data', 'products.json');
  try {
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(arr) && arr.length === 0) fs.rmSync(f, { force: true });
  } catch { /* missing/corrupt is fine — list() will seed */ }
  products.list(); // re-seeds prod_digital_pickup
}

const SALES = {
  headline: 'Stop swiping. Start running the system.',
  body: "Digital Pickup 2.0 is David Bond's complete, no-fluff playbook for meeting women online — a technical, "
    + 'systems-first approach to Tinder, Bumble, Instagram and beyond. 28 video lessons across 6 chapters take you '
    + 'from profile setup to automation to the first date. One purchase unlocks every lesson, for life.',
  bullets: [
    '28 video lessons across 6 chapters — lifetime access',
    'Profile, ranking & automation systems for Tinder and Bumble',
    'Instagram story-push and warm-DM playbooks',
    'Advanced Digital Pickup 2.0 tactics + first-date game',
    'One-time payment — no membership, yours forever',
  ],
  ctaLabel: 'Buy Now — $299',
};

const up = products.update(PRODUCT_ID, {
  name: 'Digital Pickup 2.0',
  slug: 'digital-pickup-2-0',
  type: 'course',
  description: "David Bond's complete hacker's guide to meeting women online — 28 lessons, lifetime access.",
  price: 29900,
  currency: 'usd',
  category: 'meeting-women',
  trailer: result.trailerId || null,
  sales: SALES,
  branding: {
    primary: '#2fe06f',
    accent: '#13c257',
    logo: '/product-assets/logo-prod_digital_pickup.png',
    bgImage: '/product-assets/bg-prod_digital_pickup.jpg',
  },
  published: true,
});
if (!up.ok) { console.error('update failed:', up.error); process.exit(1); }

const sv = products.setVideos(PRODUCT_ID, orderedIds);
if (!sv.ok) { console.error('setVideos failed:', sv.error); process.exit(1); }

// Paid course → blur the lesson thumbnails so locked (free) viewers can't preview
// the content. Owners/admin see clear thumbs (the card only blurs when locked).
// The video itself is already 403-gated server-side.
const bl = await bulkAction(orderedIds, 'blur-medium');
if (!bl.ok) { console.error('blur failed:', bl.error); process.exit(1); }

const p = products.getById(PRODUCT_ID);
console.log('Configured product:');
console.log(`  name:     ${p.name}`);
console.log(`  slug:     ${p.slug}  →  /course.html?slug=${p.slug}`);
console.log(`  price:    $${(p.price / 100).toFixed(2)} ${p.currency}`);
console.log(`  category: ${p.category}`);
console.log(`  trailer:  ${p.trailer}`);
console.log(`  videos:   ${p.videoIds.length} assigned`);
console.log(`  logo:     ${p.branding.logo}`);
console.log(`  bg:       ${p.branding.bgImage}`);
console.log(`  published:${p.published}`);
