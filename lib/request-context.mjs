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
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|embedly|headless|preview|monitor|python-requests|curl|wget|go-http|axios|node-fetch|bytespider|ahrefs|semrush|httpclient|scrapy|gptbot|chatgpt|claudebot|anthropic|ccbot|petalbot|dotbot|mj12bot|dataforseo|yandex|baidu|sogou|feedfetcher|phantomjs|puppeteer|selenium|playwright|lighthouse|pingdom|uptimerobot|telegrambot|whatsapp|discordbot|skypeuripreview|linkcheck|archive\.org/i;

/** UA-based bot heuristic. Exported so analytics reads can filter legacy events. */
export function isBotUa(ua) {
  return !ua || BOT_RE.test(ua);
}

/**
 * Optional Cloudflare bot signal — only acts when the relevant headers are
 * present, so it's a no-op until Cloudflare Bot Management (or a "add bot score"
 * managed transform) is enabled. cf-bot-score runs 1 (definitely bot) … 99
 * (definitely human); scores at/below CF_BOT_SCORE_MAX (default 30) are bots.
 * A cf-verified-bot:true (Googlebot etc.) is still automated traffic for stats.
 */
function cfBotSignal(req) {
  const verified = header(req, 'cf-verified-bot');
  if (typeof verified === 'string' && /^(true|1|yes)$/i.test(verified.trim())) return true;
  const raw = header(req, 'cf-bot-score') || header(req, 'x-bot-score');
  const score = Number(raw);
  if (Number.isFinite(score) && score > 0) {
    const max = Number(process.env.CF_BOT_SCORE_MAX) || 30;
    if (score <= max) return true;
  }
  return false;
}

/** Normalize a 2-letter ISO country code; reject CF's unknown/Tor placeholders. */
export function normalizeCC(cc) {
  if (typeof cc !== 'string') return null;
  const up = cc.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(up)) return null;
  if (up === 'XX' || up === 'T1' || up === 'AP' || up === 'EU') return null;
  return up;
}

function header(req, name) {
  return req.headers[name] || req.headers[name.toLowerCase()];
}

function cleanHeader(v, max = 120) {
  if (typeof v !== 'string') return null;
  try { v = decodeURIComponent(v); } catch { /* keep raw */ }
  const s = v.trim().replace(/^"|"$/g, '');
  return s ? s.slice(0, max) : null;
}

function coord(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseDevice(req, ua) {
  const platform = cleanHeader(header(req, 'sec-ch-ua-platform'), 60);
  const mobileHint = cleanHeader(header(req, 'sec-ch-ua-mobile'), 12);
  const os = platform
    || (/Windows/i.test(ua) ? 'Windows'
      : /Android/i.test(ua) ? 'Android'
        : /(iPhone|iPad|iPod)/i.test(ua) ? 'iOS'
          : /Mac OS X/i.test(ua) ? 'macOS'
            : /Linux/i.test(ua) ? 'Linux' : null);
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) && !/Chromium/.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) && !/Chrome\//.test(ua) ? 'Safari' : null;
  const type = mobileHint === '?1' || /Mobile|Android|iPhone|iPad|iPod/i.test(ua) ? 'mobile' : 'desktop';
  return { type, os, browser, ua: cleanHeader(ua, 260) };
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
    const isBot = isBotUa(ua) || cfBotSignal(req);
    const device = parseDevice(req, ua);

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

    const geo = {
      countryCode: country,
      countryName: null,
      city: null,
      region: null,
      lat: null,
      lon: null,
      source: countrySource,
    };
    if (trustCloudflare && countrySource === 'cf') {
      geo.city = cleanHeader(header(req, 'cf-ipcity'), 120);
      geo.region = cleanHeader(header(req, 'cf-region'), 120);
      geo.lat = coord(header(req, 'cf-iplatitude'));
      geo.lon = coord(header(req, 'cf-iplongitude'));
    }

    return { ip, country, countrySource, geo, device, ua, isBot, isAdmin, isMember, ownedProductIds: owned, bypass, user };
  };
}
