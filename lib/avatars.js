// Default avatar catalog + avatar-value helpers.
// A user's stored `avatar` is either "default:<id>" (one of the bundled SVGs in
// public/avatars/) or "upload:/media/avatars/<file>" (a user-uploaded image).
// When a user has no avatar set, we render a YouTube-style generated initial
// (a coloured circle with the first letter of their name) instead of a stock
// image — see initialAvatarDataUri().

// Avatars users may pick from in the UI. Deliberately excludes "david-bond"
// (the site owner's personal image) — new users get a generated initial by
// default and can upload their own photo.
export const DEFAULT_AVATARS = ['person-glasses', 'hacker', 'hoodie'];

// Avatars that still resolve to a bundled SVG even though they're not offered in
// the picker. "david-bond" lives here so the admin account (seeded with
// default:david-bond) keeps rendering, and legacy users keep their old choices.
const RESOLVABLE_AVATARS = new Set([...DEFAULT_AVATARS, 'david-bond']);

/** True if `id` is offered in the avatar picker (i.e. a user may select it). */
export function isDefaultAvatar(id) {
  return DEFAULT_AVATARS.includes(id);
}

export function defaultAvatarUrl(id) {
  return `/avatars/${id}.svg`;
}

// Deterministic palette for generated initial avatars.
const INITIAL_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
];

/**
 * Build a self-contained "initial" avatar: a coloured circle with the first
 * letter of `name`. Returned as a data: URI so it works everywhere an <img>
 * src goes, with no extra request or file. Colour is hashed from the name so a
 * given user is always the same colour.
 */
export function initialAvatarDataUri(name) {
  const s = (typeof name === 'string' ? name : '').trim();
  const letter = (s ? s[0] : '?').toUpperCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const bg = INITIAL_COLORS[h % INITIAL_COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">`
    + `<rect width="96" height="96" rx="48" fill="${bg}"/>`
    + `<text x="48" y="49" font-family="Arial,Helvetica,sans-serif" font-size="46" font-weight="700"`
    + ` fill="#ffffff" text-anchor="middle" dominant-baseline="central">${escapeXml(letter)}</text>`
    + `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

/**
 * Validate a user-submitted avatar value. Returns { ok, value } or { ok:false }.
 * Only picker avatars (not "david-bond") and safe uploads are accepted.
 * Uploads must live under /media/avatars/ and contain no path traversal.
 */
export function validateAvatarValue(value) {
  if (typeof value !== 'string' || value.length > 256) return { ok: false };
  if (value.startsWith('default:')) {
    const id = value.slice('default:'.length);
    return isDefaultAvatar(id) ? { ok: true, value } : { ok: false };
  }
  if (value.startsWith('upload:/media/avatars/')) {
    if (value.includes('..')) return { ok: false };
    return { ok: true, value };
  }
  return { ok: false };
}

/**
 * Resolve a stored avatar value to a servable URL. When there's no usable
 * avatar (empty, unknown id, etc.) falls back to a generated initial avatar
 * built from `name` — never to a stock image.
 */
export function avatarUrl(value, name) {
  if (typeof value === 'string') {
    if (value.startsWith('default:')) {
      const id = value.slice('default:'.length);
      if (RESOLVABLE_AVATARS.has(id)) return defaultAvatarUrl(id);
      return initialAvatarDataUri(name);
    }
    if (value.startsWith('upload:')) return value.slice('upload:'.length);
  }
  return initialAvatarDataUri(name);
}
