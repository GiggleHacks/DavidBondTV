// Creates/updates the "The Digital Image" course product from the ingest state
// file. Idempotent + re-runnable: run it now (trailer + however many episodes are
// done) and again after the batch finishes to fill in all 22 episode ids in the
// correct Day/Part order. Sales copy + branding live here so a re-run never wipes
// them. Run:  node build/upsert-product.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as products from '../lib/products.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'ingest-course.state.json');

const SLUG = 'the-digital-image';
const SALES = {
  headline: 'Engineer a social media presence so magnetic that women message YOU first — by the hundreds.',
  body: "The Digital Image is David Bond's complete system for turning your phone into an inbound machine. "
    + 'Over 8 days of filmed, in-the-room coaching you rebuild your photos, your Instagram, your paid ads and '
    + "your texting until women are sliding into your DMs faster than you can answer them. This isn't theory — "
    + "it's the exact playbook, photoshoots, ad campaigns and messaging scripts that have flooded students' "
    + 'inboxes with hundreds of messages a day from real women. Buy once, own it for life.',
  bullets: [
    '8 days of raw, filmed coaching — every session, unlocked for life',
    'Build a digital image that makes women hit you up first',
    'The photoshoot blueprint: look like the prize without a pro studio',
    'Instagram Stories that turn passive viewers into DMs',
    'Run paid ads that put your face in front of thousands of women',
    'Texting & messaging systems to handle hundreds of replies a day',
    'TikTok tactics that keep generating leads for weeks',
    'Real student transformations, live results and full Q&A — nothing held back',
    'One-time payment — no subscription, no membership required',
  ],
  ctaLabel: 'Get The Digital Image — $197',
};
const BRANDING = { primary: '#f5c451', accent: '#b8860b', logo: null, bgImage: null };
const DESCRIPTION = "David Bond's complete 8-day system to engineer a magnetic social media image that floods "
  + 'your DMs with women. Lifetime access, one-time purchase.';

const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
const episodeIds = state.episodes.filter((e) => e.done).map((e) => e.id); // already in Day/Part order
const trailerId = state.trailer && state.trailer.done ? state.trailer.id : null;

let product = products.getBySlug(SLUG);
if (!product) {
  const r = products.add({
    type: 'course', name: 'The Digital Image', slug: SLUG,
    description: DESCRIPTION, price: 19700, currency: 'usd', sales: SALES, branding: BRANDING,
  });
  if (!r.ok) { console.error('add failed:', r.error); process.exit(1); }
  product = r.product;
  console.log(`created ${product.id}`);
}

const r = products.update(product.id, {
  description: DESCRIPTION, price: 19700, sales: SALES, branding: BRANDING,
  videoIds: episodeIds, trailerVideoId: trailerId, published: true,
});
if (!r.ok) { console.error('update failed:', r.error); process.exit(1); }

console.log(`upserted "${r.product.name}" (${r.product.slug})`);
console.log(`  price: $${(r.product.price / 100).toFixed(2)}`);
console.log(`  episodes assigned: ${r.product.videoIds.length}`);
console.log(`  trailerVideoId: ${r.product.trailerVideoId || '(none yet)'}`);
console.log(`  published: ${r.product.published}`);
