// Server-to-server relay to the GigaBrain analytics sidecar so the native
// "DataBond GigaBrain" dashboard can read its data WITHOUT the browser ever
// talking to the sidecar directly, and WITHOUT a separate GigaBrain password.
//
// Why a proxy at all: GigaBrain's /api/admin/* endpoints are cookie-authenticated
// (a signed `adc_admin` JWT) and emit NO CORS headers — they're only meant to be
// hit same-origin. A browser on davidbondtv.com therefore can't fetch
// analytics.davidbondtv.com/api/admin/stats cross-origin.
//
// Single sign-on: the admin only logs into davidbondtv (as `davidbond`). Every
// proxy route here is gated by this app's own admin check (isAdminReq), and the
// proxy then MINTS GigaBrain's session JWT directly from a shared secret instead
// of logging in with a password. GigaBrain signs/verifies its `adc_admin` cookie
// as HS256 `{ role: 'admin' }` using ADMIN_SESSION_SECRET (gigabrain lib/auth.ts);
// we sign the same token with the same secret (GIGABRAIN_SESSION_SECRET here, set
// equal to the sidecar's ADMIN_SESSION_SECRET) using node:crypto — no extra
// dependency, no password, no login round-trip.
//
// Known limitation: proxied requests originate from THIS server's IP, so
// GigaBrain's per-request IP nuance (is_me / "this is me") reflects the server,
// not the admin's browser. The dashboard doesn't expose those controls in v1.

import { createHmac } from 'node:crypto';

const BASE = (process.env.GIGABRAIN_PUBLIC_URL || '').replace(/\/+$/, '');
// Shared with the sidecar's ADMIN_SESSION_SECRET. Accept a GigaBrain-specific name
// first, then fall back to ADMIN_SESSION_SECRET if both services share that env.
const SECRET = process.env.GIGABRAIN_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET || '';
const TOKEN_TTL_SEC = 7 * 24 * 3600; // matches gigabrain createSessionToken (7d)

let cached = null; // { token, exp }  (exp in epoch seconds)

/** Both the sidecar origin and the shared session secret must be configured. */
export function gigabrainConfigured() {
  return !!(BASE && SECRET);
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

// Mint a GigaBrain-compatible session JWT: HS256, payload { role:'admin', iat, exp },
// signed with the shared secret as UTF-8 bytes (mirrors jose's TextEncoder key).
function mintToken() {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_SEC;
  const header = b64url(JSON.stringify({ alg: 'HS256' }));
  const payload = b64url(JSON.stringify({ role: 'admin', iat: now, exp }));
  const data = `${header}.${payload}`;
  const sig = b64url(createHmac('sha256', SECRET).update(data).digest());
  return { token: `${data}.${sig}`, exp };
}

// Return a cached cookie value, re-minting when missing or within an hour of expiry.
function sessionCookie() {
  const now = Math.floor(Date.now() / 1000);
  if (!cached || cached.exp - now < 3600) cached = mintToken();
  return `adc_admin=${cached.token}`;
}

// fetch with a hard timeout so a hung sidecar can't stall the app's event loop.
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Core request. On a 401 (clock skew / rotated secret) re-mint once and retry.
async function request(method, path, { search = '', body = null } = {}) {
  if (!gigabrainConfigured()) {
    return { status: 503, json: { error: 'gigabrain_unconfigured' } };
  }
  const url = `${BASE}/api/admin/${path}${search || ''}`;
  const send = () => {
    const opts = { method, headers: { Cookie: sessionCookie() } };
    if (body != null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return fetchWithTimeout(url, opts);
  };
  try {
    let res = await send();
    if (res.status === 401) { cached = null; res = await send(); }
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } catch (err) {
    return { status: 502, json: { error: 'gigabrain_unreachable', detail: String(err && err.message || err) } };
  }
}

/** Proxy a GET to /api/admin/<path><search>. Returns { status, json }. */
export function proxyGet(path, search = '') {
  return request('GET', path, { search });
}

/** Proxy a JSON body request (POST/DELETE) to /api/admin/<path>. Returns { status, json }. */
export function proxyJson(method, path, body) {
  return request(method, path, { body });
}
