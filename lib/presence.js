// Native, in-memory live-visitor presence + rolling tracking counters. This is
// first-party (no sidecar, no DB) so "Real-Time" works even when the GigaBrain
// sidecar is down/unconfigured, and the analytics-health panel can report what
// the tracker is actually doing. Everything here is process-local and cheap;
// it resets on restart, which is fine for a "who's here right now" view.

const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // "active now" = seen in the last 5 minutes
const MAX_SESSIONS = 20000;             // hard cap so a burst can't grow memory unbounded

const sessions = new Map(); // visitorId → { visitorId, path, country, countryName, city, device, os, browser, ip, channel, isMe, ts, pathSince }

/** Record/refresh a visitor's presence. `info.visitorId` is required. */
export function touch(info) {
  if (!info || !info.visitorId) return;
  const now = Date.now();
  const prev = sessions.get(info.visitorId);
  const pathSince = prev && prev.path === info.path ? prev.pathSince : now;
  // Re-insert last so Map iteration stays roughly LRU for the size cap.
  sessions.delete(info.visitorId);
  sessions.set(info.visitorId, { ...info, ts: now, pathSince });
  if (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
}

function prune(now = Date.now()) {
  for (const [k, v] of sessions) if (now - v.ts > ACTIVE_WINDOW_MS) sessions.delete(k);
}

/** Active visitors (most-recent first), shaped for the real-time table. */
export function active(windowMs = ACTIVE_WINDOW_MS) {
  const now = Date.now();
  prune(now);
  const cutoff = now - windowMs;
  const out = [];
  for (const v of sessions.values()) {
    if (v.ts < cutoff) continue;
    out.push({
      ts: v.ts,
      onPageSec: Math.max(0, Math.round((v.ts - (v.pathSince || v.ts)) / 1000)),
      path: v.path || '/',
      country: v.country || null,
      countryName: v.countryName || null,
      city: v.city || null,
      device: v.device || null,
      os: v.os || null,
      browser: v.browser || null,
      channel: v.channel || 'direct',
      isMe: !!v.isMe,
    });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** Count of currently-active visitors. */
export function count(windowMs = ACTIVE_WINDOW_MS) {
  const now = Date.now();
  prune(now);
  const cutoff = now - windowMs;
  let n = 0;
  for (const v of sessions.values()) if (v.ts >= cutoff) n++;
  return n;
}

// ---- rolling tracking counters (hourly buckets, 24h retained) ----
const HOURS = 24;
const buckets = new Map(); // hourKey → { counted, bots, rateLimited, pageviews }
const hourKey = (t = Date.now()) => Math.floor(t / 3_600_000);
let lastEventAt = null;

/** Increment a counter kind: 'counted' | 'bots' | 'rateLimited' | 'pageviews'. */
export function bump(kind, n = 1, t = Date.now()) {
  const k = hourKey(t);
  let b = buckets.get(k);
  if (!b) { b = { counted: 0, bots: 0, rateLimited: 0, pageviews: 0 }; buckets.set(k, b); }
  b[kind] = (b[kind] || 0) + n;
  const cut = k - HOURS;
  for (const key of buckets.keys()) if (key < cut) buckets.delete(key);
}

/** Mark that a real (non-bot, non-limited) tracked event just arrived. */
export function markEvent(t = Date.now()) { lastEventAt = t; }
export function getLastEventAt() { return lastEventAt; }

/** Summed counters over the last 24h. */
export function metrics24h() {
  const cut = hourKey() - (HOURS - 1);
  const out = { counted: 0, bots: 0, rateLimited: 0, pageviews: 0 };
  for (const [k, b] of buckets) {
    if (k < cut) continue;
    out.counted += b.counted || 0;
    out.bots += b.bots || 0;
    out.rateLimited += b.rateLimited || 0;
    out.pageviews += b.pageviews || 0;
  }
  return out;
}

/** Derive a coarse acquisition channel from a referrer URL. */
export function channelFromReferrer(ref) {
  if (!ref || typeof ref !== 'string') return 'direct';
  let host = '';
  try { host = new URL(ref).hostname.toLowerCase(); } catch { return 'referral'; }
  if (!host) return 'direct';
  if (/(youtube\.com|youtu\.be)/.test(host)) return 'youtube';
  if (/(google\.|bing\.|duckduckgo\.|yahoo\.)/.test(host)) return 'search';
  if (/(t\.co|twitter\.com|x\.com|facebook\.com|instagram\.com|reddit\.com|tiktok\.com|t\.me|linkedin\.com)/.test(host)) return 'social';
  return 'referral';
}
