// Admin-managed video category registry, backed by data/categories.json. Small,
// low-frequency list — synchronous read/write is fine. A category is { slug, name }:
// `slug` is the stable id stored on each video's manifest entry; `name` is the
// display label the admin can rename. Seeded with a sensible starter set on first
// use; fully editable in the /god panel.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolved per call so tests can point it at a tmp file via CATEGORIES_FILE.
const filePath = () => process.env.CATEGORIES_FILE || path.join(__dirname, '..', 'data', 'categories.json');

const SEED = [
  { slug: 'travel', name: 'Travel' },
  { slug: 'aerial', name: 'Aerial' },
  { slug: 'vlogs', name: 'Vlogs' },
  { slug: 'tutorials', name: 'Tutorials' },
  { slug: 'music', name: 'Music' },
];

/**
 * A category's optional flag is an ISO 3166-1 alpha-2 country code, lowercase
 * (e.g. "co" → Colombia), matching the SVG set in public/vendor/flags/4x3/.
 * Returns the normalized code if valid, else '' (which clears the flag).
 */
export function isValidFlag(code) {
  const c = String(code || '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(c) ? c : '';
}

/** Turn a display name into a url-safe slug, or '' if nothing usable remains. */
export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function read() {
  try {
    const arr = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (Array.isArray(arr)) return arr.filter((c) => c && c.slug && c.name);
  } catch { /* missing/corrupt → seed below */ }
  return null;
}

function write(arr) {
  const f = filePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(arr, null, 2));
}

/** All categories (seeds + persists the starter set on first call). */
export function list() {
  let arr = read();
  if (!arr) { arr = SEED.slice(); write(arr); }
  return arr;
}

export function has(slug) {
  return list().some((c) => c.slug === slug);
}

/** Add a category from a display name (+ optional flag). Returns { ok, category } or { ok:false, error }. */
export function add(name, flag) {
  const display = String(name || '').trim().slice(0, 40);
  if (!display) return { ok: false, error: 'Name is required.' };
  const slug = slugify(display);
  if (!slug) return { ok: false, error: 'Name must contain letters or numbers.' };
  const arr = list();
  if (arr.some((c) => c.slug === slug)) return { ok: false, error: 'That category already exists.' };
  const category = { slug, name: display };
  const fl = isValidFlag(flag);
  if (fl) category.flag = fl; // omit the key entirely when there's no flag
  arr.push(category);
  write(arr);
  return { ok: true, category };
}

/**
 * Set (or clear) a category's country flag. An empty/invalid code clears it
 * (deletes the key). Returns { ok, category } or { ok:false, error }.
 */
export function setFlag(slug, flag) {
  const arr = list();
  const c = arr.find((x) => x.slug === slug);
  if (!c) return { ok: false, error: 'Category not found.' };
  const fl = isValidFlag(flag);
  if (fl) c.flag = fl; else delete c.flag;
  write(arr);
  return { ok: true, category: c };
}

/** Rename an existing category (slug stays stable). */
export function rename(slug, name) {
  const display = String(name || '').trim().slice(0, 40);
  if (!display) return { ok: false, error: 'Name is required.' };
  const arr = list();
  const c = arr.find((x) => x.slug === slug);
  if (!c) return { ok: false, error: 'Category not found.' };
  c.name = display;
  write(arr);
  return { ok: true, category: c };
}

/** Remove a category. (Videos keep their slug; they just filter under nothing.) */
export function remove(slug) {
  const arr = list();
  const next = arr.filter((c) => c.slug !== slug);
  if (next.length === arr.length) return { ok: false, error: 'Category not found.' };
  write(next);
  return { ok: true };
}
