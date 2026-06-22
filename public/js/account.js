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

// Brand logos (inline SVG, 20px). GitHub uses currentColor; Discord keeps its
// brand purple; Google keeps its four-colour mark.
const PROVIDER_ICONS = {
  discord: '<svg class="acc-oauth-ic" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="#5865F2"><path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286ZM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189Zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>',
  github: '<svg class="acc-oauth-ic" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
  google: '<svg class="acc-oauth-ic" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#4285F4" d="M23.52 12.273c0-.851-.076-1.67-.218-2.455H12v4.642h6.458a5.52 5.52 0 0 1-2.395 3.622v3.01h3.878c2.27-2.09 3.579-5.17 3.579-8.819Z"/><path fill="#34A853" d="M12 24c3.24 0 5.956-1.075 7.941-2.908l-3.878-3.01c-1.075.72-2.45 1.144-4.063 1.144-3.125 0-5.77-2.11-6.714-4.948H1.276v3.108A11.996 11.996 0 0 0 12 24Z"/><path fill="#FBBC05" d="M5.286 14.278a7.212 7.212 0 0 1 0-4.555V6.615H1.276a12.01 12.01 0 0 0 0 10.77l4.01-3.107Z"/><path fill="#EA4335" d="M12 4.773c1.762 0 3.344.606 4.59 1.795l3.44-3.44C17.952 1.19 15.235 0 12 0A11.996 11.996 0 0 0 1.276 6.615l4.01 3.108C6.23 6.883 8.875 4.773 12 4.773Z"/></svg>',
};

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
    + `${PROVIDER_ICONS[p] || ''}<span>Continue with ${PROVIDER_LABELS[p] || p}</span></a>`).join('')
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
