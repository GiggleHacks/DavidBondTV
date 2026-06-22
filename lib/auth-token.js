// Generic signed token: base64url(JSON payload) + "." + HMAC-SHA256(payload).
// Same crypto style as lib/admin-auth.js / lib/challenge.js. Stateless: used for
// email-verification, password-reset, and session cookies, distinguished by a
// `purpose` field carried inside the payload.
import crypto from 'node:crypto';

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

/**
 * createToken(secret, payload, ttlMs, now?)
 * Embeds `exp` (absolute ms). Returns "<payloadB64>.<hmacHex>".
 */
export function createToken(secret, payload, ttlMs, now = Date.now()) {
  const body = { ...payload, exp: now + ttlMs };
  const b64 = toBase64url(Buffer.from(JSON.stringify(body), 'utf8'));
  const sig = hmac(secret, b64);
  return `${b64}.${sig}`;
}

/**
 * verifyToken(secret, token, now?)
 * Returns the decoded payload object (without exp) on success, or null.
 * Never throws.
 */
export function verifyToken(secret, token, now = Date.now()) {
  try {
    if (typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const b64 = token.slice(0, dot);
    const providedHmac = token.slice(dot + 1);
    const expected = hmac(secret, b64);
    if (providedHmac.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(providedHmac, 'hex'), Buffer.from(expected, 'hex'))) {
      return null;
    }
    const json = fromBase64url(b64);
    if (!json) return null;
    const body = JSON.parse(json);
    if (!body || typeof body.exp !== 'number' || now > body.exp) return null;
    const { exp, ...payload } = body;
    return payload;
  } catch {
    return null;
  }
}
