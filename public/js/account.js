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

/** Public auth config: { turnstileSiteKey, providers:{discord,google,github} }. */
export async function fetchAuthConfig() {
  return (await getJSON('/api/auth/config')) || { turnstileSiteKey: null, providers: {} };
}

const PROVIDER_LABELS = { discord: 'Discord', google: 'Google', github: 'GitHub' };

/**
 * Render "Continue with …" buttons for each enabled provider into `container`,
 * followed by an "or" divider. Hides the container when none are enabled.
 */
export function renderProviderButtons(container, providers, next) {
  if (!container) return;
  const entries = Object.entries(providers || {}).filter(([, on]) => on);
  if (!entries.length) { container.hidden = true; container.innerHTML = ''; return; }
  const q = next ? `?next=${encodeURIComponent(next)}` : '';
  container.innerHTML = entries.map(([p]) =>
    `<a class="acc-oauth-btn oauth-${p}" href="/api/auth/oauth/${p}/start${q}">`
    + `Continue with ${PROVIDER_LABELS[p] || p}</a>`).join('')
    + '<div class="acc-or"><span>or</span></div>';
  container.hidden = false;
}

/** Inject a Cloudflare Turnstile widget into `holder` and load the script once. */
export function mountTurnstile(holder, siteKey) {
  if (!holder || !siteKey) return;
  holder.innerHTML = `<div class="cf-turnstile" data-sitekey="${siteKey}"></div>`;
  holder.hidden = false;
  if (!document.getElementById('cf-turnstile-script')) {
    const s = document.createElement('script');
    s.id = 'cf-turnstile-script';
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.async = true; s.defer = true;
    document.head.appendChild(s);
  }
}

/** Read the token the Turnstile widget writes into its hidden input. */
export function turnstileToken(holder) {
  const el = holder && holder.querySelector('[name="cf-turnstile-response"]');
  return el ? el.value : '';
}
