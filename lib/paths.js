// Single source of truth for where the app reads/writes files, and how request
// URLs map onto the filesystem. Both the HTTP server (serving) and the ingest
// pipeline (writing + cleanup) import from here so the two can never drift.
//
// WHY a separate content dir: generated/uploaded content (the video manifest,
// thumbnails, hover previews, quality renditions, storyboards) used to live under
// public/. Because deploys ship public/, a stale local copy could overwrite — or
// blank out — the live library ("all the videos vanished"). Keeping every piece
// of mutable content OUTSIDE public/ means a code deploy physically cannot touch
// it. CONTENT_DIR (and MEDIA_DIR) are env-overridable so prod can point them at a
// persistent location if desired.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.join(__dirname, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const MEDIA_DIR = process.env.MEDIA_DIR || path.join(ROOT, 'media');
// All generated/uploaded content lives here, deliberately outside public/.
export const CONTENT_DIR = process.env.CONTENT_DIR || path.join(ROOT, 'content');

export const THUMBS_DIR = path.join(CONTENT_DIR, 'thumbs');
export const PREVIEWS_DIR = path.join(CONTENT_DIR, 'previews');
export const VIDEOS_DIR = path.join(CONTENT_DIR, 'videos');
export const STORYBOARDS_DIR = path.join(CONTENT_DIR, 'storyboards');
// Admin-uploaded product branding (course logos / background graphics). Mutable,
// so it lives in CONTENT_DIR (outside public/) like every other uploaded asset.
export const PRODUCT_ASSETS_DIR = path.join(CONTENT_DIR, 'product-assets');
export const ORIGINALS_DIR = path.join(MEDIA_DIR, 'originals');
export const MANIFEST = path.join(THUMBS_DIR, 'videos.json');

// URL path prefixes that resolve into CONTENT_DIR instead of public/. These keep
// their original public-facing URLs (/thumbs/…, /previews/…, /videos/…,
// /storyboards/…) so no frontend/manifest URLs had to change in the migration.
const CONTENT_PREFIXES = ['/thumbs', '/previews', '/videos', '/storyboards', '/product-assets'];

function underPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

/**
 * Map a decoded request URL path (no query string) to its filesystem root and
 * the path relative to that root. /media/* → MEDIA_DIR; the content prefixes →
 * CONTENT_DIR; everything else → PUBLIC_DIR.
 */
export function rootForUrl(pathname) {
  if (underPrefix(pathname, '/media')) {
    return { root: MEDIA_DIR, rel: pathname.slice('/media'.length) || '/' };
  }
  for (const p of CONTENT_PREFIXES) {
    if (underPrefix(pathname, p)) return { root: CONTENT_DIR, rel: pathname };
  }
  return { root: PUBLIC_DIR, rel: pathname };
}

/**
 * Resolve a request URL path to an absolute filesystem path, with a traversal
 * guard (the result must stay within its mapped root). Returns null if the path
 * escapes its root. `pathname` must already be decoded and query-stripped.
 */
export function resolveAssetPath(pathname) {
  const { root, rel } = rootForUrl(pathname);
  const filePath = path.normalize(path.join(root, rel));
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;
  return filePath;
}

/**
 * Resolve a stored asset URL (e.g. a manifest entry's `thumb`/`preview`, like
 * "/thumbs/thumb-x.jpg") to its on-disk path for deletion. Same mapping/guard as
 * serving, so cleanup always targets the real file location.
 */
export function assetPathFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('/')) return null;
  return resolveAssetPath(url.split('?')[0]);
}
