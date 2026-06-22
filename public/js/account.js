// Shared client helpers for the account pages + header widget.

export const DEFAULT_AVATARS = ['person-glasses', 'hacker', 'hoodie'];

// Client mirror of lib/avatars.js initialAvatarDataUri() — keep the palette and
// hashing in sync so the live preview matches what the server renders.
const INITIAL_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
];

/** A YouTube-style generated initial avatar (coloured circle + first letter). */
export function initialAvatarDataUri(name) {
  const s = (typeof name === 'string' ? name : '').trim();
  const letter = (s ? s[0] : '?').toUpperCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const bg = INITIAL_COLORS[h % INITIAL_COLORS.length];
  const esc = (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]);
  const safe = letter.replace(/[<>&'"]/g, esc);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">`
    + `<rect width="96" height="96" rx="48" fill="${bg}"/>`
    + `<text x="48" y="49" font-family="Arial,Helvetica,sans-serif" font-size="46" font-weight="700"`
    + ` fill="#ffffff" text-anchor="middle" dominant-baseline="central">${safe}</text>`
    + `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** POST JSON, returning { ok, status, data }. Never throws. */
export async function postJSON(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'Network error — please try again.' } };
  }
}

/** GET JSON, returning parsed data or null. */
export async function getJSON(path) {
  try {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Fetch a fresh signed math challenge. Returns { token, question } or null. */
export async function loadChallenge() {
  return getJSON('/api/challenge');
}

/** Who is logged in? Returns the user object or null. */
export async function fetchMe() {
  const data = await getJSON('/api/auth/me');
  return data ? data.user : null;
}
