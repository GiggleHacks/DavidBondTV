// Admin-managed product catalog, backed by data/products.json. A product is a
// sellable unit — a course, bundle, digital download, or the membership itself —
// each with its own branding, sales copy, dynamic price, and assigned videos.
// Mirrors lib/categories.js (small, low-frequency list → synchronous read/write,
// seeded on first use, fully editable in the /god panel).
//
// WHY assignment lives here (product.videoIds) and not on the manifest: a video
// can belong to several products (e.g. a bundle), and keeping the link on the
// product means no manifest migration and a trivial reverse index. Access gating
// reads productIdsForVideo(); see canWatchVideo (public/js/viewer-access.js) and
// the media backstop in server.mjs. Owned-ness is checked via lib/entitlements.js.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PRODUCT_ASSETS_DIR } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolved per call so tests can point it at a tmp file via PRODUCTS_FILE; in
// production it's the persistent data/products.json (outside public/, like
// categories.json — survives code deploys).
const filePath = () => process.env.PRODUCTS_FILE || path.join(__dirname, '..', 'data', 'products.json');

export const PRODUCT_TYPES = ['course', 'bundle', 'digital', 'membership'];
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

const DEFAULT_BRANDING = { logo: null, primary: '#e11d48', accent: '#fb7185', bgImage: null };
// A branding image must be a same-origin path with no characters that could break
// out of an HTML attribute or CSS url() (no quotes/space/angle-brackets/colon), so
// the value is safe wherever the client interpolates it into innerHTML or a style.
// Our uploaded assets are always `/product-assets/<file>` (see productAssetTarget).
const SAFE_ASSET_PATH = /^\/[A-Za-z0-9_\-./]+$/;
const cleanAssetUrl = (v) => (typeof v === 'string' && SAFE_ASSET_PATH.test(v) ? v : null);

// First-run seed: the Digital Pickup course. Ships UNPUBLISHED with no videos so
// a deploy gates nothing — the admin assigns videos + flips published in the UI.
// A fixed id keeps purchased entitlements stable across restarts/reseeds.
const SEED = [{
  id: 'prod_digital_pickup',
  type: 'course',
  slug: 'digital-pickup',
  name: 'Digital Pickup',
  description: 'An online dating course that teaches you how to meet people online.',
  price: 9900,
  currency: 'usd',
  published: false,
  videoIds: [],
  branding: { logo: null, primary: '#7c3aed', accent: '#22d3ee', bgImage: null },
  sales: {
    headline: 'Master online dating with Digital Pickup',
    body: 'Get the complete Digital Pickup course — every lesson, unlocked for life with a single purchase. No membership required.',
    bullets: ['Full course, instant lifetime access', 'Proven online dating frameworks', 'One-time payment — yours forever'],
    ctaLabel: 'Purchase $99',
  },
  createdAt: 0,
  updatedAt: 0,
}];

/** Turn a display name into a url-safe slug, or '' if nothing usable remains. */
export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const genId = () => `prod_${crypto.randomUUID()}`;

/** Coerce a value into a clean, validated branding object. */
function cleanBranding(b) {
  const out = { ...DEFAULT_BRANDING };
  if (b && typeof b === 'object') {
    if (b.logo === null || typeof b.logo === 'string') out.logo = cleanAssetUrl(b.logo);
    if (b.bgImage === null || typeof b.bgImage === 'string') out.bgImage = cleanAssetUrl(b.bgImage);
    if (typeof b.primary === 'string' && HEX_COLOR.test(b.primary)) out.primary = b.primary;
    if (typeof b.accent === 'string' && HEX_COLOR.test(b.accent)) out.accent = b.accent;
  }
  return out;
}

/** Coerce a value into a clean sales-copy object (strings + bullet array). */
function cleanSales(s) {
  const out = { headline: '', body: '', bullets: [], ctaLabel: 'Buy now' };
  if (s && typeof s === 'object') {
    if (typeof s.headline === 'string') out.headline = s.headline.slice(0, 200);
    if (typeof s.body === 'string') out.body = s.body.slice(0, 4000);
    if (typeof s.ctaLabel === 'string' && s.ctaLabel.trim()) out.ctaLabel = s.ctaLabel.trim().slice(0, 60);
    if (Array.isArray(s.bullets)) {
      out.bullets = s.bullets.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 200)).slice(0, 12);
    }
  }
  return out;
}

/** Normalize one raw record (defaults + types) so callers see a stable shape. */
function normalize(p) {
  if (!p || !p.id || !p.slug || !p.name) return null;
  return {
    id: p.id,
    type: PRODUCT_TYPES.includes(p.type) ? p.type : 'course',
    slug: p.slug,
    name: p.name,
    description: typeof p.description === 'string' ? p.description : '',
    price: Number.isInteger(p.price) && p.price >= 0 ? p.price : 0,
    currency: typeof p.currency === 'string' && /^[a-z]{3}$/.test(p.currency.toLowerCase()) ? p.currency.toLowerCase() : 'usd',
    published: !!p.published,
    // The course-category this product is grouped under on the storefront
    // (Categories → Courses → course). A free-text slug, decoupled from the video
    // category registry so a course grouping never shows as an empty video filter
    // in the sidebar. '' = uncategorized.
    category: typeof p.category === 'string' ? slugify(p.category) : '',
    // The public trailer video (a manifest video id) shown atop the sales page.
    // null = no trailer.
    trailer: typeof p.trailer === 'string' && p.trailer ? p.trailer : null,
    videoIds: Array.isArray(p.videoIds) ? p.videoIds.filter((v) => typeof v === 'string') : [],
    branding: cleanBranding(p.branding),
    sales: cleanSales(p.sales),
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
  };
}

function read() {
  try {
    const arr = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (Array.isArray(arr)) return arr.map(normalize).filter(Boolean);
  } catch { /* missing/corrupt → seed below */ }
  return null;
}

function write(arr) {
  const f = filePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(arr, null, 2));
}

/** All products (seeds + persists the starter set on first call). */
export function list() {
  let arr = read();
  if (!arr) { arr = SEED.map(normalize).filter(Boolean); write(arr); }
  return arr;
}

/** Only products visible to the public (published). */
export function listPublished() {
  return list().filter((p) => p.published);
}

export function getById(id) {
  return list().find((p) => p.id === id) || null;
}

export function getBySlug(slug) {
  return list().find((p) => p.slug === slug) || null;
}

/** Map of videoId → [productId, …] across all products. */
export function videoProductMap() {
  const map = new Map();
  for (const p of list()) {
    for (const vid of p.videoIds) {
      const arr = map.get(vid) || [];
      arr.push(p.id);
      map.set(vid, arr);
    }
  }
  return map;
}

/** Product ids that gate a given video. `publishedOnly` restricts to live products. */
export function productIdsForVideo(videoId, { publishedOnly = false } = {}) {
  if (!videoId) return [];
  return list()
    .filter((p) => (!publishedOnly || p.published) && p.videoIds.includes(videoId))
    .map((p) => p.id);
}

/** Create a product. Returns { ok, product } or { ok:false, error }. */
export function add({ type = 'course', name, description = '', price = 0, currency = 'usd', slug, sales, branding, category, trailer } = {}) {
  const display = String(name || '').trim().slice(0, 120);
  if (!display) return { ok: false, error: 'Name is required.' };
  if (!PRODUCT_TYPES.includes(type)) return { ok: false, error: 'Unknown product type.' };
  const finalSlug = slugify(slug || display);
  if (!finalSlug) return { ok: false, error: 'Name must contain letters or numbers.' };
  if (!Number.isInteger(price) || price < 0) return { ok: false, error: 'Price must be a whole number of cents (≥ 0).' };
  const arr = list();
  if (arr.some((p) => p.slug === finalSlug)) return { ok: false, error: 'That slug already exists.' };
  const now = Date.now();
  const product = normalize({
    id: genId(), type, slug: finalSlug, name: display, description, price, currency,
    published: false, category: category || '', trailer: trailer || null,
    videoIds: [], branding, sales, createdAt: now, updatedAt: now,
  });
  arr.push(product);
  write(arr);
  return { ok: true, product };
}

/** Patch a product's editable fields. Returns { ok, product } or { ok:false, error }. */
export function update(id, patch = {}) {
  const arr = list();
  const p = arr.find((x) => x.id === id);
  if (!p) return { ok: false, error: 'Product not found.' };

  if (patch.name !== undefined) {
    const display = String(patch.name).trim().slice(0, 120);
    if (!display) return { ok: false, error: 'Name is required.' };
    p.name = display;
  }
  if (patch.slug !== undefined) {
    const s = slugify(patch.slug);
    if (!s) return { ok: false, error: 'Slug must contain letters or numbers.' };
    if (arr.some((x) => x.id !== id && x.slug === s)) return { ok: false, error: 'That slug already exists.' };
    p.slug = s;
  }
  if (patch.type !== undefined) {
    if (!PRODUCT_TYPES.includes(patch.type)) return { ok: false, error: 'Unknown product type.' };
    p.type = patch.type;
  }
  if (patch.description !== undefined) p.description = String(patch.description).slice(0, 4000);
  if (patch.price !== undefined) {
    if (!Number.isInteger(patch.price) || patch.price < 0) return { ok: false, error: 'Price must be a whole number of cents (≥ 0).' };
    p.price = patch.price;
  }
  if (patch.currency !== undefined) {
    const c = String(patch.currency).toLowerCase();
    if (!/^[a-z]{3}$/.test(c)) return { ok: false, error: 'Currency must be a 3-letter code.' };
    p.currency = c;
  }
  if (patch.published !== undefined) p.published = !!patch.published;
  if (patch.category !== undefined) p.category = slugify(String(patch.category || ''));
  if (patch.trailer !== undefined) {
    p.trailer = (typeof patch.trailer === 'string' && patch.trailer) ? patch.trailer : null;
  }
  if (patch.sales !== undefined) p.sales = cleanSales(patch.sales);
  if (patch.branding !== undefined) p.branding = cleanBranding({ ...p.branding, ...patch.branding });
  if (patch.videoIds !== undefined) {
    p.videoIds = Array.isArray(patch.videoIds) ? [...new Set(patch.videoIds.filter((v) => typeof v === 'string'))] : [];
  }
  p.updatedAt = Date.now();
  write(arr);
  return { ok: true, product: p };
}

/** Replace a product's assigned video list. Returns { ok, product } or error. */
export function setVideos(id, ids) {
  return update(id, { videoIds: ids });
}

/** Merge branding fields (logo/bg url after upload, colors). Returns { ok, product }. */
export function setBranding(id, patch) {
  const p = getById(id);
  if (!p) return { ok: false, error: 'Product not found.' };
  return update(id, { branding: { ...p.branding, ...patch } });
}

/** Remove a product. (Owned entitlements keep their productId; they just match nothing.) */
export function remove(id) {
  const arr = list();
  const next = arr.filter((p) => p.id !== id);
  if (next.length === arr.length) return { ok: false, error: 'Product not found.' };
  write(next);
  return { ok: true };
}

const ASSET_EXTS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * Resolve where a product's branding asset (logo or bg) should be written, and
 * its public url. `kind` is 'logo' | 'bg'. Mirrors ingest.thumbTarget(). Returns
 * null on a bad id / unsupported content type.
 */
export function productAssetTarget(id, kind, contentType) {
  const ext = ASSET_EXTS[(contentType || '').split(';')[0].trim()];
  const k = kind === 'bg' ? 'bg' : 'logo';
  if (!ext || !id || typeof id !== 'string' || !/^[\w.-]+$/.test(id)) return null;
  const file = `${k}-${id}.${ext}`;
  return { dest: path.join(PRODUCT_ASSETS_DIR, file), url: `/product-assets/${file}`, field: k === 'bg' ? 'bgImage' : 'logo' };
}

/** Client-safe projection (everything the storefront/gate needs; nothing secret). */
export function publicView(p) {
  if (!p) return null;
  return {
    id: p.id,
    type: p.type,
    slug: p.slug,
    name: p.name,
    description: p.description,
    price: p.price,
    currency: p.currency,
    category: p.category,
    trailer: p.trailer,
    videoIds: p.videoIds,
    branding: p.branding,
    sales: p.sales,
  };
}
