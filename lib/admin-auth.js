// Minimal admin authentication for the upload page. A single shared password
// (ADMIN_PASSWORD env) is exchanged for a short-lived HMAC bearer token.
// Same crypto style as lib/challenge.js. NOTE: the site is plain HTTP, so the
// password and token travel in cleartext — acceptable for a single-admin page;
// front it with HTTPS for anything more sensitive.
import crypto from 'node:crypto';

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function toBase64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function fromBase64url(str) {
  if (typeof str !== 'string') return null;
  try {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
}
function hmac(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

/** Constant-time string comparison over SHA-256 digests (length-safe). */
export function safeEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

/** True if admin auth is configured (ADMIN_PASSWORD set). */
export function adminConfigured() {
  return typeof process.env.ADMIN_PASSWORD === 'string' && process.env.ADMIN_PASSWORD.length > 0;
}

/**
 * Verify a submitted password against ADMIN_PASSWORD and, on success, mint a
 * signed bearer token. Returns { ok, token } or { ok:false }.
 */
export function login(secret, password, now = Date.now()) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof password !== 'string' || !safeEqual(password, expected)) {
    return { ok: false };
  }
  const expiresAt = now + TOKEN_TTL_MS;
  const payload = `${expiresAt}`;
  const sig = hmac(secret, payload);
  const token = toBase64url(Buffer.from(`${payload}.${sig}`, 'utf8'));
  return { ok: true, token };
}

/** Verify a bearer token's signature + expiry. Returns boolean; never throws. */
export function verifyToken(secret, token, now = Date.now()) {
  try {
    const raw = fromBase64url(token);
    if (!raw) return false;
    const parts = raw.split('.');
    if (parts.length !== 2) return false;
    const [expiresAtStr, providedHmac] = parts;
    const expiresAt = Number(expiresAtStr);
    if (!Number.isFinite(expiresAt) || now > expiresAt) return false;
    const expected = hmac(secret, expiresAtStr);
    if (providedHmac.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(providedHmac, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/** Extract + verify the Authorization: Bearer token from a request. */
export function requireAdmin(secret, req, now = Date.now()) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return false;
  return verifyToken(secret, m[1].trim(), now);
}
