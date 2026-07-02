// Anonymous free-view quota. Visitors without a verified account may START a
// limited number of DISTINCT videos (rewatches are free); the set of started
// video ids rides in a signed httpOnly cookie, so it's tamper-proof without any
// server-side store. Clearing cookies resets the quota — accepted softness (the
// gate is a signup nudge, not DRM). Signed with the same AUTH_SECRET that signs
// sessions, distinguished by the token's `purpose` field.
import { createToken, verifyToken } from './auth-token.js';
import { parseCookies, serializeCookie } from './cookies.js';

export const FREE_VIEWS_COOKIE = 'dbtv_free_views';
const PURPOSE = 'free_views';
const TTL_MS = 365 * 24 * 60 * 60 * 1000;
// Hard cap on ids kept in the cookie regardless of the configured limit, so a
// forged/huge token can never bloat Set-Cookie headers.
const MAX_IDS = 25;

/** The video ids this browser has started, [] when absent/invalid/expired. */
export function readFreeViews(req, secret) {
  const raw = parseCookies(req.headers['cookie'] || '')[FREE_VIEWS_COOKIE];
  if (!raw) return [];
  const payload = verifyToken(secret, raw);
  if (!payload || payload.purpose !== PURPOSE || !Array.isArray(payload.v)) return [];
  return payload.v.filter((id) => typeof id === 'string' && id).slice(0, MAX_IDS);
}

function issueCookie(videos, secret, { secure = false, domain = '' } = {}) {
  const token = createToken(secret, { purpose: PURPOSE, v: videos.slice(0, MAX_IDS) }, TTL_MS);
  const opts = { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: Math.floor(TTL_MS / 1000), secure };
  if (domain) opts.domain = domain;
  return serializeCookie(FREE_VIEWS_COOKIE, token, opts);
}

/**
 * Decide whether this request may start `videoId`.
 * Returns { allowed, videos, setCookie } — setCookie is non-null only when the
 * set grew (a new distinct video was consumed) and must be sent with the 200.
 */
export function evaluateFreeView({ req, videoId, limit, secret, secure = false, domain = '' }) {
  const videos = readFreeViews(req, secret);
  if (videos.includes(videoId)) return { allowed: true, videos, setCookie: null };
  if (videos.length < limit) {
    const next = [...videos, videoId];
    return { allowed: true, videos: next, setCookie: issueCookie(next, secret, { secure, domain }) };
  }
  return { allowed: false, videos, setCookie: null };
}
