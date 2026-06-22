// Admin-managed video category registry, backed by data/categories.json. Small,
// low-frequency list — synchronous read/write is fine. A category is { slug, name }:
// `slug` is the stable id stored on each video's manifest entry; `name` is the
// display label the admin can rename. Seeded with a sensible starter set on first
// use; fully editable in the /god panel.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'categories.json');

const SEED = [
  { slug: 'travel', name: 'Travel' },
  { slug: 'aerial', name: 'Aerial' },
  { slug: 'vlogs', name: 'Vlogs' },
  { slug: 'tutorials', name: 'Tutorials' },
  { slug: 'music', name: 'Music' },
];

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
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(arr)) return arr.filter((c) => c && c.slug && c.name);
  } catch { /* missing/corrupt → seed below */ }
  return null;
}

function write(arr) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(arr, null, 2));
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

/** Add a category from a display name. Returns { ok, category } or { ok:false, error }. */
export function add(name) {
  const display = String(name || '').trim().slice(0, 40);
  if (!display) return { ok: false, error: 'Name is required.' };
  const slug = slugify(display);
  if (!slug) return { ok: false, error: 'Name must contain letters or numbers.' };
  const arr = list();
  if (arr.some((c) => c.slug === slug)) return { ok: false, error: 'That category already exists.' };
  const category = { slug, name: display };
  arr.push(category);
  write(arr);
  return { ok: true, category };
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
