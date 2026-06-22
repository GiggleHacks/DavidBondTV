// Derives the facts every downstream stage needs from a raw request, ONCE:
// client IP, country (Cloudflare header → MaxMind → admin simulate override),
// user-agent + bot flag, logged-in user, and admin/bypass status. Shared by the
// analytics tracker and the geo-restriction gate so detection logic lives in one
// place. Country detection prefers Cloudflare's CF-IPCountry when the operator
// asserts the origin is behind Cloudflare (TRUST_CLOUDFLARE); otherwise it falls
// back to the local MaxMind DB (if built) and an admin-only simulate override.
import { clientIp } from './http-util.js';
import { parseCookies } from './cookies.js';
import { hasActiveMembership } from './membership.js';
import { ownedProductIds } from './entitlements.js';

// Conservative bot user-agent heuristics. Bots are flagged (excluded from
// analytics) but never blocked, so false positives only cost a stat, not access.
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|embedly|headless|preview|monitor|python-requests|curl|wget|go-http|axios|node-fetch|bytespider|ahrefs|semrush|httpclient|scrapy/i;

/** Normalize a 2-letter ISO country code; reject CF's unknown/Tor placeholders. */
export function normalizeCC(cc) {
  if (typeof cc !== 'string') return null;
  const up = cc.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(up)) return null;
  if (up === 'XX' || up === 'T1' || up === 'AP' || up === 'EU') return null;
  return up;
}

export function createRequestContext({ geoip, accounts, adminSecret, bypassSecret, trustCloudflare }) {
  return function buildRequestContext(req) {
    const cookies = parseCookies(req.headers['cookie'] || '');
    let search = null;
    try { search = new URL(req.url, 'http://localhost').searchParams; } catch { search = new URLSearchParams(); }

    // Real client IP — trust CF-Connecting-IP only when behind Cloudflare.
    const ip = (trustCloudflare && req.headers['cf-connecting-ip'])
      ? String(req.headers['cf-connecting-ip']).split(',')[0].trim()
      : clientIp(req);

    const ua = req.headers['user-agent'] || '';
    const isBot = !ua || BOT_RE.test(ua);

    // Identify the logged-in user; admin = a user whose roles include 'admin'.
    // The session cookie IS the bypass — an admin signed in anywhere is exempt.
    let user = null;
    try { user = accounts.currentUser(req); } catch { user = null; }
    const isAdmin = !!(user && Array.isArray(user.roles) && user.roles.includes('admin'));
    // Unlocks premium content: an admin, or an active paying member. The premium
    // gate in server.mjs reads this; admins are folded in so downstream is one check.
    const isMember = isAdmin || hasActiveMembership(user);
    // One-time product entitlements (course/bundle/digital). The media backstop
    // in server.mjs reads this to gate course-assigned videos by ownership.
    const owned = ownedProductIds(user);

    // Country: admin simulate override → Cloudflare header → MaxMind → unknown.
    let country = null;
    let countrySource = null;
    let bypass = isAdmin; // admins normally skip the geo gate entirely…
    const simRaw = isAdmin ? (search.get('cc') || cookies['dbtv_simcc']) : null;
    const sim = normalizeCC(simRaw);
    const cf = trustCloudflare ? normalizeCC(req.headers['cf-ipcountry']) : null;
    if (sim) {
      // …unless they're simulating a country: then preview the site exactly as a
      // visitor from `sim` sees it (gate applies). /god stays carved out, so
      // they can always reach the panel to switch simulation back off.
      country = sim; countrySource = 'sim'; bypass = false;
    } else if (cf) { country = cf; countrySource = 'cf'; }
    else {
      const g = geoip.lookup(ip);
      if (g) { country = g; countrySource = 'geoip'; }
    }

    return { ip, country, countrySource, ua, isBot, isAdmin, isMember, ownedProductIds: owned, bypass, user };
  };
}
