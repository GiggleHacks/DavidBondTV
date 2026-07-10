// Anti-spam guard for comments. Layers on top of the existing per-IP rate limit
// and math challenge: per-account rate limits, duplicate/flood detection, link
// controls, a banned-word blocklist, and stricter rules for brand-new/anonymous
// posters. Pure helpers are exported for unit tests; createCommentGuard() holds
// the in-memory state (per-process, resets on restart — fine for this app).
import { createRateLimiter } from './rate-limit.js';

// No banned words by default — this hard-reject list is inert. Phrase filtering
// is handled by lib/comment-filter.js (admin-managed via /god-community, backed
// by data/comment-blocklist.json in its {entries:[...]} shape — do NOT write a
// plain string array there), which shadow-hides matches instead of rejecting.
export const DEFAULT_BANNED = [];

/** Count obvious links (http/https/www). Deliberately conservative. */
export function countLinks(text) {
  const m = String(text || '').match(/\b(?:https?:\/\/|www\.)\S+/gi);
  return m ? m.length : 0;
}

/** Collapse to a comparable form for duplicate detection. */
export function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Content-only verdict (no state). { ok:true } or { ok:false, error }.
 * allowLinks=false blocks any link (used for new/anonymous posters).
 */
export function contentVerdict(text, { allowLinks = true, maxLinks = 2, banned = DEFAULT_BANNED } = {}) {
  const links = countLinks(text);
  if (!allowLinks && links > 0) {
    return { ok: false, error: 'New accounts can’t post links yet — you can add them once your account is a little older.' };
  }
  if (links > maxLinks) {
    return { ok: false, error: `That’s too many links (max ${maxLinks}).` };
  }
  const low = String(text || '').toLowerCase();
  for (const w of banned) {
    if (w && low.includes(String(w).toLowerCase())) {
      return { ok: false, error: 'Your comment looks like spam and was blocked.' };
    }
  }
  return { ok: true };
}

export function createCommentGuard({
  newAccountAgeMs = 60 * 60 * 1000, // accounts younger than this are "new"
  perAccountMax = 6,                // established member: comments/min
  newAccountMax = 3,                // new logged-in account: comments/min
  windowMs = 60 * 1000,
  dupWindowMs = 2 * 60 * 1000,      // window for "you already posted that"
  maxLinks = 2,
  banned = DEFAULT_BANNED,
  now = () => Date.now(),
} = {}) {
  const normalLimiter = createRateLimiter(windowMs, perAccountMax);
  const newLimiter = createRateLimiter(windowMs, newAccountMax);
  const recent = new Map(); // key -> [{ t: normalized, ts }]

  function isDuplicate(key, norm) {
    if (!norm) return false;
    const t = now();
    const list = (recent.get(key) || []).filter((e) => t - e.ts < dupWindowMs);
    const dup = list.some((e) => e.t === norm);
    list.push({ t: norm, ts: t });
    recent.set(key, list);
    return dup;
  }

  /**
   * Evaluate one comment attempt. Returns { ok:true } or
   * { ok:false, status, error, retryAfter? }. Admins bypass everything.
   * `user` is the account record (or null for anonymous).
   */
  function check({ user, ip, text }) {
    const isAdmin = !!(user && Array.isArray(user.roles) && user.roles.includes('admin'));
    if (isAdmin) return { ok: true };

    const isAnon = !user;
    const isNew = isAnon || !user.verified
      || (typeof user.createdAt === 'number' && now() - user.createdAt < newAccountAgeMs);
    const key = user ? `u:${user.id}` : `ip:${ip || 'unknown'}`;
    const trimmed = String(text || '').trim();

    // Content + duplicate checks only apply when there's actual text (a GIF-only
    // comment has none).
    if (trimmed) {
      const verdict = contentVerdict(trimmed, { allowLinks: !isNew, maxLinks, banned });
      if (!verdict.ok) return { ok: false, status: 400, error: verdict.error };
      if (isDuplicate(key, normalizeText(trimmed))) {
        return { ok: false, status: 429, error: 'You already posted that.', retryAfter: 30 };
      }
    }

    // Per-account rate limit (logged-in only; anonymous is already bounded by the
    // per-IP limiter upstream). New accounts get the stricter ceiling.
    if (user) {
      const limiter = isNew ? newLimiter : normalLimiter;
      const r = limiter.hit(key);
      if (!r.allowed) {
        return { ok: false, status: 429, error: 'You’re commenting too fast — give it a moment.', retryAfter: r.retryAfter };
      }
    }

    return { ok: true };
  }

  return { check };
}
