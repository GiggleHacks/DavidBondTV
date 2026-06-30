import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { contentType, parseRange, sendJson, readBody, readRawBody, clientIp, withSecurityHeaders } from './lib/http-util.js';
import { createChallenge, verifyChallenge } from './lib/challenge.js';
import { createRateLimiter } from './lib/rate-limit.js';
import { validateComment, addComment, listComments, deleteComment, readAllComments, threadComments } from './lib/comments-store.js';
import { getCounts, getUserVote, setVote } from './lib/reactions-store.js';
import { adminConfigured, verifyBearerSecret } from './lib/admin-auth.js';
import { createAdminAccount } from './lib/admin-account.js';
import { serializeCookie, parseCookies } from './lib/cookies.js';
import { hashPassword, verifyPassword } from './lib/password.js';
import { createGeoip } from './lib/geoip.js';
import { createAccounts } from './lib/accounts.js';
import { createTurnstile } from './lib/turnstile.js';
import { createTenor, isTenorGifUrl } from './lib/tenor.js';
import { createCommentGuard, DEFAULT_BANNED } from './lib/comment-guard.js';
import { createCommentFilterStore } from './lib/comment-filter.js';
import { adminUser } from './lib/users-store.js';
import { createPaymentsStore } from './lib/payments-store.js';
import { createCryptoOrdersStore } from './lib/crypto-orders-store.js';
import { createCryptoPayments } from './lib/crypto-payments.js';
import { createWhopPayments } from './lib/whop-payments.js';
import { loadCryptoConfig } from './lib/crypto-config.js';
import { createTelegramNotifier, createTelegramGroupGate } from './lib/telegram-bot.js';
import { announceBoot } from './lib/deploy-notify.mjs';
import { createTelegramAccess } from './lib/telegram-access.js';
import { hasActiveMembership } from './lib/membership.js';
import { avatarUrl } from './lib/avatars.js';
import {
  enqueue, getJob, listJobs, newUploadTarget, acceptableUpload, bootSweep, deleteVideo,
  editVideo, thumbTarget, setThumb, isKnownVideo, bulkAction, videoVisibility,
  releaseScheduled, sweepRejected, videoPublic, listManifest, checkDuplicate, getSystemMetrics,
  mergeManifestEntry, backfillNotifications, reviewSource, setPinned,
} from './lib/ingest.mjs';
import {
  listForUser as listNotifications, markSeen as markNotificationsSeen,
  dismiss as dismissNotification, clearAll as clearNotifications,
  addAccountNotification, addAdminNotification, decorateForViewer as decorateNotificationsForViewer,
} from './lib/notifications-store.js';
import { sendMembershipGrantedEmail, sendProductGrantedEmail } from './lib/mailer.js';
import { hasFfmpeg } from './lib/media.mjs';
import * as categories from './lib/categories.js';
import * as coupons from './lib/coupons.js';
import * as uploads from './lib/upload-sessions.mjs';
import * as products from './lib/products.js';
import * as pricing from './lib/pricing.js';
import { buildFinancialSummary } from './lib/financial-summary.js';
import { resolveCanonicalRedirect } from './lib/public-routes.js';
import { createIpGeo } from './lib/ip-geo.js';
import { createRequestContext, isBotUa } from './lib/request-context.mjs';
import { createAnalytics } from './lib/analytics-store.mjs';
import { createGeoGate } from './lib/geo-gate.mjs';
import { PUBLIC_DIR, MEDIA_DIR, MANIFEST, resolveAssetPath } from './lib/paths.js';
import { sha256File } from './lib/hash-file.mjs';
import { diffManifest } from './lib/sync-diff.mjs';
import { startPublish, getPublishJob, latestPublishJob, controlPublishJob } from './lib/sync-client.mjs';
import { ADMIN_ROUTE_PREFIX, isLegacyAdminRoute, isPrettyAdminRoute, resolveAdminFilePath } from './lib/admin-routes.js';
import { gigabrainConfigured, proxyGet, proxyJson } from './lib/gigabrain-proxy.js';
import { sanitizePlaybackVideo, sanitizePublicVideo } from './lib/video-manifest.js';
import { CENTROIDS } from './public/js/world-data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

// App version (single source of truth = package.json). Shown as a small badge in
// the corner of every page so changes are easy to track. Bump package.json on
// each change to roll it forward.
const APP_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();
// Self-contained (inline-styled) so it renders regardless of which stylesheet a
// page loads; pointer-events:none so it never blocks clicks (e.g. player controls).
const VERSION_BADGE = `<div id="site-version" style="position:fixed;bottom:8px;left:10px;z-index:2147483000;`
  + `font:600 11px/1 system-ui,-apple-system,sans-serif;color:rgba(255,255,255,.4);`
  + `background:rgba(0,0,0,.35);padding:3px 7px;border-radius:6px;pointer-events:none;user-select:none">`
  + `v${APP_VERSION}</div>`;

// Stamp ?v=<version> onto root-relative .css/.js asset URLs in an HTML page so
// every deploy busts both browser and Cloudflare-edge caches. Skips refs that
// already have a query string (idempotent) and absolute/protocol URLs.
function addAssetVersion(html, version) {
  return html.replace(
    /\b(href|src)=("|')(\/[^"'?#]+\.(?:css|js))\2/gi,
    (m, attr, q, url) => `${attr}=${q}${url}?v=${version}${q}`,
  );
}

// --- API setup ---
const SECRET = crypto.randomBytes(32).toString('hex');
// Admin token signing key. Set ADMIN_SECRET to keep tokens valid across restarts;
// otherwise a fresh random key logs admins out on each restart (fine for one admin).
const ADMIN_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(32).toString('hex');
// Instantaneous CPU utilisation (0–100) from os.cpus() time deltas between calls.
// Cross-platform (Windows + Linux) and cheap. Returns null on the first call (no
// baseline yet). Module-level state holds the previous aggregate snapshot.
let _cpuLast = null;
function cpuPercentDelta() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; }
  const prev = _cpuLast;
  _cpuLast = { idle, total };
  if (!prev) return null;
  const dt = total - prev.total, di = idle - prev.idle;
  if (dt <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)));
}

// Network throughput (bytes/sec) from /proc/net/dev deltas between calls (Linux).
// Returns nulls on non-Linux (no /proc) or the first call (no baseline yet).
let _netLast = null;
function netThroughput() {
  let rx = 0, tx = 0;
  try {
    const data = fs.readFileSync('/proc/net/dev', 'utf8');
    for (const line of data.split('\n')) {
      const m = line.match(/^\s*([^:]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/);
      if (!m || m[1].trim() === 'lo') continue;
      rx += Number(m[2]); tx += Number(m[3]);
    }
  } catch { return { rxPerSec: null, txPerSec: null }; }
  const now = _netNow();
  const prev = _netLast;
  _netLast = { rx, tx, t: now };
  if (!prev || now <= prev.t) return { rxPerSec: null, txPerSec: null };
  const dt = (now - prev.t) / 1000;
  return { rxPerSec: Math.max(0, (rx - prev.rx) / dt), txPerSec: Math.max(0, (tx - prev.tx) / dt) };
}
function _netNow() { return Number(process.hrtime.bigint() / 1000000n); }

// Local→server video publish. SYNC_TOKEN authenticates machine-to-machine pushes
// (set identically on both ends); when unset, the /api/sync/* receive endpoints
// 404 so an unconfigured server never accepts pushes. SYNC_TARGET_URL is only set
// on the LOCAL instance — the production address it publishes to.
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const SYNC_TARGET_URL = (process.env.SYNC_TARGET_URL || '').replace(/\/+$/, '');
const ALLOWED_SYNC_PREFIXES = ['/thumbs/', '/previews/', '/videos/', '/storyboards/'];
const limiter = createRateLimiter(60_000, 3); // up to 3 comments/min per IP
// Comment anti-spam: per-account limits, duplicate/flood detection and link
// controls. Sensitive phrase filtering is a separate shadow-moderation layer
// below so posters see success while the public feed stays clean.
const commentGuard = createCommentGuard({ banned: DEFAULT_BANNED });
const COMMENT_FILTER_FILE = path.join(__dirname, 'data', 'comment-blocklist.json');
const commentFilters = createCommentFilterStore(COMMENT_FILTER_FILE);
// Max accepted upload size. Configurable so the grey-cloud upload host can take
// large masters; default 25 GB. (Cloudflare still caps the main host at ~100 MB,
// so large uploads go via the DNS-only upload subdomain — see deploy docs.)
const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES) || 25 * 1024 * 1024 * 1024;
// Chunk size for resumable uploads. Small enough that a single chunk always
// finishes well under Node's requestTimeout (so the 502-on-slow-upload class of
// failure can't happen), large enough to keep request overhead low.
const UPLOAD_CHUNK_SIZE = Number(process.env.UPLOAD_CHUNK_SIZE) || 16 * 1024 * 1024;
const UPLOAD_SCHEDULE_MAX_MS = 365 * 24 * 60 * 60 * 1000; // a year out, sanity cap
const UPLOAD_SESSION_IDLE_MS = 6 * 60 * 60 * 1000; // discard a stalled .part after 6h
const COMMENTS_FILE = path.join(__dirname, 'data', 'comments.json');
const REACTIONS_FILE = path.join(__dirname, 'data', 'reactions.json');
const ADMIN_FILE = path.join(__dirname, 'data', 'admin.json');
const ADMIN_CREDS_FILE = path.join(__dirname, 'data', 'admin-credentials.txt');
const adminAccount = createAdminAccount({ filePath: ADMIN_FILE, credentialsFile: ADMIN_CREDS_FILE });
const COOKIE_SECURE = (process.env.BASE_URL || '').startsWith('https');
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || ''; // e.g. 'davidbondtv.com' → session shared with upload subdomain
const uploadLimiter = createRateLimiter(60_000, 30); // 30 upload starts/min per IP

// --- User accounts + geo ---
// AUTH_SECRET signs session/verify/reset tokens. Set it to keep users logged in
// across restarts; otherwise a fresh random key logs everyone out on restart.
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
// GigaBrain analytics sidecar (separate Next.js service / own origin). When set,
// public pages get the first-party tracker snippet and the "Analytics 2.0" admin
// tile embeds its dashboard. Leave unset to disable the integration entirely.
//   dev:  http://localhost:3001     prod: https://analytics.davidbondtv.com
const GIGABRAIN_PUBLIC_URL = (process.env.GIGABRAIN_PUBLIC_URL || '').replace(/\/+$/, '');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const GEOIP_FILE = path.join(__dirname, 'data', 'geoip-country.json');
const geoip = createGeoip(GEOIP_FILE);
// Cloudflare Turnstile (bot gate for signup/reset). When TURNSTILE_SECRET is
// unset it stays disabled and accounts fall back to the math challenge.
const turnstile = createTurnstile({ secret: process.env.TURNSTILE_SECRET });

// GIF picker for comments (Tenor). Disabled when TENOR_API_KEY is unset — the
// comment box just hides the GIF button (graceful degradation).
const tenor = createTenor({ apiKey: process.env.TENOR_API_KEY });
const gifLimiter = createRateLimiter(60_000, 60); // 60 gif lookups/min per IP

// Social-login providers. Each is enabled only when BOTH its id + secret are set;
// otherwise it's hidden in the UI and its routes 404 (graceful degradation).
function oauthProvider(idEnv, secretEnv) {
  const clientId = process.env[idEnv];
  const clientSecret = process.env[secretEnv];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
const oauthProviders = {
  discord: oauthProvider('OAUTH_DISCORD_CLIENT_ID', 'OAUTH_DISCORD_CLIENT_SECRET'),
  google: oauthProvider('OAUTH_GOOGLE_CLIENT_ID', 'OAUTH_GOOGLE_CLIENT_SECRET'),
  github: oauthProvider('OAUTH_GITHUB_CLIENT_ID', 'OAUTH_GITHUB_CLIENT_SECRET'),
};

const accounts = createAccounts({
  tokenSecret: AUTH_SECRET,
  challengeSecret: SECRET, // same key that mints /api/challenge tokens
  baseUrl: BASE_URL,
  usersFile: USERS_FILE,
  mediaDir: MEDIA_DIR,
  isSecure: BASE_URL.startsWith('https'),
  cookieDomain: COOKIE_DOMAIN,
  turnstile,
  providers: oauthProviders,
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
});

// --- Payments ---
// WHOP (card) + self-hosted crypto (ETH) are the payment rails. Each ships dark
// unless its env is configured; the rest of the app runs unchanged. Public pricing
// + offer copy is served by GET /api/membership/config (pricing.publicConfig()).
const PAYMENTS_FILE = path.join(__dirname, 'data', 'payments.json');
const paymentsStore = createPaymentsStore(PAYMENTS_FILE);
const telegramNotifier = createTelegramNotifier({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
});

const CRYPTO_ORDERS_FILE = path.join(__dirname, 'data', 'crypto-orders.json');
const CRYPTO_CONFIG_FILE = path.join(__dirname, 'data', 'crypto-config.json');
const cryptoOrdersStore = createCryptoOrdersStore(CRYPTO_ORDERS_FILE);
const cryptoConfig = loadCryptoConfig(CRYPTO_CONFIG_FILE);
const cryptoPayments = createCryptoPayments({
  store: accounts.store,
  currentUser: accounts.currentUser,
  ordersStore: cryptoOrdersStore,
  paymentsStore,
  baseUrl: BASE_URL,
  webhookSecret: process.env.CRYPTO_WEBHOOK_SECRET,
  watcherUrl: process.env.CRYPTO_WATCHER_URL || null,
  watcherToken: process.env.CRYPTO_WATCHER_TOKEN || null,
  cryptoConfig,
  products,
  pricing,
  coupons,
  telegramNotifier,
});
console.log(`[crypto] enabled coins: ${cryptoConfig.enabledCoins.join(', ') || '(none)'}`);

// --- WHOP card rail (replaces suspended Stripe) ---
// Third payment provider beside 'stripe' and 'crypto'. Writes the same
// user.membership shape, so every membership gate already understands it. Ships
// dark unless WHOP_API_KEY + WHOP_PLAN_ID are set (config reports disabled →
// frontend hides the Card option). The webhook still verifies when its secret is set.
const whopPayments = createWhopPayments({
  store: accounts.store,
  currentUser: accounts.currentUser,
  paymentsStore,
  baseUrl: BASE_URL,
  apiKey: process.env.WHOP_API_KEY,
  webhookSecret: process.env.WHOP_WEBHOOK_SECRET,
  planId: process.env.WHOP_PLAN_ID,
  companyId: process.env.WHOP_COMPANY_ID || null,
  // Fallback price (USD dollars) for the Card headline if the live plan lookup fails.
  priceUsd: process.env.WHOP_PRICE_USD ? Number(process.env.WHOP_PRICE_USD) : null,
  telegramNotifier,
});
console.log(`[whop] card rail: ${whopPayments.configured ? 'ENABLED' : 'disabled (no WHOP_API_KEY/WHOP_PLAN_ID)'}`);

// --- Private Telegram group access gate ---
// Paid users get a one-time, single-use invite to a private Telegram group; the
// group link is never exposed publicly. Ships dark unless the bot is configured
// with a group chat id + webhook secret + bot username (otherwise the routes
// return 503 and the revocation sweep doesn't run). Reuses the alerts bot token.
const telegramGate = createTelegramGroupGate({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  groupChatId: process.env.TELEGRAM_GROUP_CHAT_ID || '',
  inviteTtlMs: Number(process.env.TELEGRAM_INVITE_TTL_MS) || 10 * 60_000,
});
const telegramAccess = createTelegramAccess({
  store: accounts.store,
  currentUser: accounts.currentUser,
  gate: telegramGate,
  paymentsStore,
  tokenSecret: AUTH_SECRET,
  botUsername: process.env.TELEGRAM_BOT_USERNAME || '',
  webhookToken: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  linkTokenTtlMs: Number(process.env.TELEGRAM_LINK_TOKEN_TTL_MS) || 15 * 60_000,
});

// --- analytics + per-request context ---
// Trust Cloudflare's CF-* headers only when the origin actually sits behind it.
const TRUST_CLOUDFLARE = process.env.TRUST_CLOUDFLARE === '1';
const analytics = createAnalytics({
  dir: path.join(__dirname, 'data', 'analytics'),
  rawRetentionDays: Number(process.env.ANALYTICS_RAW_DAYS) || 30,
  dayWindow: Number(process.env.ANALYTICS_ROLLUP_DAYS) || 365,
});
const buildRequestContext = createRequestContext({
  geoip, accounts, trustCloudflare: TRUST_CLOUDFLARE,
});
// City-level IP geolocation for the admin visitor dossier (admin-only, cached,
// best-effort). Set IP_GEO_DISABLE=1 to keep it country-level / fully offline.
const ipGeo = createIpGeo({
  cacheFile: path.join(__dirname, 'data', 'ip-geo-cache.json'),
  endpoint: process.env.IP_GEO_URL || 'http://ip-api.com/json/',
  enabled: process.env.IP_GEO_DISABLE !== '1',
});
// Enrich a visitor profile's `location` with city/region/coords from the IP.
async function enrichProfileLocation(profile) {
  if (!profile) return profile;
  const ip = (profile.ips && profile.ips[0]) || (profile.location && profile.location.ip) || null;
  const geo = await ipGeo.lookup(ip).catch(() => null);
  if (!geo) return profile;
  const base = profile.location || {};
  profile.location = {
    cc: base.cc || geo.cc || null,
    country: base.country || geo.country || null,
    region: geo.region || base.region || null,
    city: geo.city || base.city || null,
    lat: base.lat != null ? base.lat : geo.lat,
    lon: base.lon != null ? base.lon : geo.lon,
    isp: geo.isp || base.isp || null,
  };
  return profile;
}
const trackLimiter = createRateLimiter(60_000, 120); // generous: ~heartbeats from a few concurrent views
const GEO_RULES_FILE = path.join(__dirname, 'data', 'geo-rules.json');
const geoGate = createGeoGate(GEO_RULES_FILE);

/** Admin guard: the session-cookie user must carry the 'admin' role. */
function isAdminReq(req) {
  const u = accounts.currentUser(req);
  return !!(u && Array.isArray(u.roles) && u.roles.includes('admin'));
}

// Machine-to-machine sync auth: a static Bearer SYNC_TOKEN, or a logged-in admin
// (so the owner can also hit /api/sync/* from a browser session for debugging).
function isSyncAuthed(req) {
  return verifyBearerSecret(SYNC_TOKEN, req) || isAdminReq(req);
}

// Ids of every admin account, for fanning system/comment/server alerts into their
// notification bell. Cheap (in-memory user list); recomputed per emit so a newly
// promoted admin starts receiving alerts without a restart.
function adminUserIds() {
  return accounts.store.listAll()
    .filter((u) => Array.isArray(u.roles) && u.roles.includes('admin'))
    .map((u) => u.id);
}

/** Best-effort admin bell alert (new comment, server event, deploy, …). Never throws. */
function notifyAdmins(payload) {
  try { addAdminNotification(adminUserIds(), payload); } catch { /* best-effort */ }
}

/**
 * Ensure the David Bond admin exists as a normal user with roles:['admin'],
 * migrating the password from data/admin.json once so the existing credentials
 * keep working. Idempotent.
 */
async function seedAdminUser() {
  const existing = accounts.store.getByUsername('davidbond');
  if (existing) {
    if (!existing.roles || !existing.roles.includes('admin') || !existing.verified) {
      await accounts.store.updateUser(existing.id, { roles: ['admin'], verified: true, profileComplete: true });
    }
    return;
  }
  const passwordHash = adminAccount.passwordHash();
  if (!passwordHash) return; // admin.json not seeded yet
  const created = await accounts.store.createUser({ email: 'davidbond@davidbondtv.local', passwordHash });
  if (created.ok) {
    await accounts.store.updateUser(created.user.id, {
      username: 'davidbond', roles: ['admin'], verified: true, verifiedAt: Date.now(),
      profileComplete: true, avatar: 'default:david-bond',
    });
  }
}

// Paths a geo-blocked visitor may still load: the under-construction shell
// (logo/styles/fonts), the admin login page + its JS (so the owner can sign in
// and arm bypass from a blocked country), and vendored libs.
function isGeoCarveOut(pathname) {
  // All admin surfaces stay reachable so the owner can sign in, manage rules,
  // and (crucially) turn OFF a simulate-preview from any blocked country.
  if (isPrettyAdminRoute(pathname)) return true;
  if (pathname === '/under-construction.html') return true;
  if (pathname === '/styles.css' || pathname === '/apple-touch-icon.png') return true;
  if (pathname.startsWith('/favicon')) return true;
  return ['/js/', '/css/', '/fonts/', '/brand/', '/avatars/', '/vendor/'].some((p) => pathname.startsWith(p));
}

let UNDER_CONSTRUCTION = '';
try { UNDER_CONSTRUCTION = fs.readFileSync(path.join(PUBLIC_DIR, 'under-construction.html'), 'utf-8'); } catch { /* built below */ }

/** Serve the neutral "Under Construction" page (200, never reveals the reason). */
function serveUnderConstruction(res) {
  res.writeHead(200, withSecurityHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  }));
  res.end(UNDER_CONSTRUCTION || '<!doctype html><meta name="robots" content="noindex"><title>David Bond TV</title><h1>Under Construction</h1>');
}

/** id → title map from the manifest, for joining analytics/history to names. */
function manifestTitleMap() {
  try {
    const arr = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    return Object.fromEntries(arr.map((v) => [v.id, v.title]));
  } catch {
    return {};
  }
}

function userNameMap() {
  return new Map(accounts.store.listAll().map((u) => [u.id, u.username || u.email || u.id]));
}

// Display-normalize an IP: take the first hop of any X-Forwarded-For chain,
// unwrap IPv4-mapped IPv6 (::ffff:1.2.3.4 → 1.2.3.4), and tidy loopback. Keeps
// real IPv6 intact. Cleans both fresh and legacy stored IPs at render time.
function normalizeIp(ip) {
  if (typeof ip !== 'string' || !ip) return ip || null;
  let s = ip.split(',')[0].trim();
  s = s.replace(/^::ffff:/i, '');
  if (s === '::1') s = '127.0.0.1';
  return s;
}

function decorateLogEvent(e, titles = manifestTitleMap(), names = userNameMap()) {
  if (!e || typeof e !== 'object') return e;
  const videoId = e.videoId || e.video || null;
  const userId = e.userId || null;
  // Prefer the manifest title; the stored videoTitle is often just the slug
  // (normalizeEvent fallback) rather than a real human title.
  const storedTitle = e.videoTitle && e.videoTitle !== videoId ? e.videoTitle : null;
  return {
    ...e,
    ip: normalizeIp(e.ip),
    videoId,
    videoTitle: (videoId ? titles[videoId] : null) || storedTitle || null,
    username: e.username || (userId ? names.get(userId) || 'deleted user' : null),
  };
}

function logFiltersFromUrl(url) {
  const out = {};
  for (const key of ['from', 'to', 'q', 'type', 'userId', 'videoId', 'ip', 'cc', 'subscriber', 'limit', 'cursor']) {
    const v = url.searchParams.get(key);
    if (v != null && v !== '') out[key] = v;
  }
  return out;
}

function allCommentsWithContext() {
  const store = readAllComments(COMMENTS_FILE);
  const vmeta = new Map();
  for (const v of listManifest()) vmeta.set(v.id, { id: v.id, title: v.title || v.id, thumb: v.thumb || null });
  const out = [];
  for (const [vid, list] of Object.entries(store)) {
    if (!Array.isArray(list)) continue;
    const vc = vmeta.get(vid) || { id: vid, title: vid, thumb: null };
    for (const c of list) {
      if (!c) continue;
      out.push({
        id: c.id,
        video: vc,
        name: c.name || 'Anonymous',
        username: c.username || null,
        userId: c.userId || null,
        text: c.text || '',
        ts: c.ts || 0,
        avatar: c.avatar || null,
        gifUrl: c.gifUrl || null,
        country: c.country || null,
        visitorId: c.visitorId || (c.analytics && c.analytics.visitorId) || null,
        analytics: c.analytics || null,
      });
    }
  }
  return out;
}

function shadowModerationFor(match) {
  if (!match) return undefined;
  return {
    shadow: true,
    reason: 'word_filter',
    phrase: match.phrase,
    filterId: match.id,
    ts: Date.now(),
  };
}

function ownsShadowComment(c, ctx, visitorId = '') {
  if (!c || !(c.moderation && c.moderation.shadow)) return true;
  if (ctx && ctx.isAdmin) return true;
  if (ctx && ctx.user && c.userId && ctx.user.id === c.userId) return true;
  if (visitorId && c.visitorId && visitorId === c.visitorId) return true;
  return false;
}

function resolveFile(urlPath) {
  let pathname = decodeURIComponent(urlPath.split('?')[0]);
  const cleanRoute = resolveCanonicalRedirect(urlPath, { videos: listManifest(), products: products.listPublished() });
  if (cleanRoute && cleanRoute.rewrite) pathname = cleanRoute.rewrite;
  if (pathname === '/') pathname = '/browse.html'; // homepage = the video grid
  if (pathname === '/videos') pathname = '/browse.html'; // canonical feed URL (post-login landing)
  if (pathname === '/watch') pathname = '/index.html'; // per-video watch page (?v=<id>)
  if (pathname === '/products' || pathname === '/store') pathname = '/products.html'; // course storefront
  if (pathname === '/course') pathname = '/course.html'; // course sales page (?slug=<slug>)
  const adminFile = resolveAdminFilePath(pathname);
  if (adminFile) pathname = adminFile;
  // Pretty URLs for the legal / policy pages (linked from the site footer).
  if (pathname === '/terms') pathname = '/terms.html';
  if (pathname === '/privacy') pathname = '/privacy.html';
  if (pathname === '/refunds') pathname = '/refunds.html';

  // Map onto the filesystem: /media/* → MEDIA_DIR, the content prefixes
  // (/thumbs,/previews,/videos,/storyboards) → CONTENT_DIR, everything else →
  // public/. Traversal guard lives in resolveAssetPath (returns null on escape).
  return resolveAssetPath(pathname);
}

function playbackVideoById(id) {
  if (!id) return null;
  return listManifest().find((v) => v.id === id) || null;
}

function canAccessVideo(ctx, vid) {
  const courseIds = products.productIdsForVideo(vid, { publishedOnly: true });
  const courseGated = courseIds.length > 0;
  const ownsCourse = courseGated && courseIds.some((pid) => ctx.ownedProductIds.includes(pid));
  const dripBlocked = !videoPublic(vid) && !ctx.isAdmin;
  const premiumBlocked = videoVisibility(vid) === 'premium' && !ctx.isMember;
  return !(!ctx.isAdmin && (dripBlocked || (courseGated ? !ownsCourse : premiumBlocked)));
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateSitemap() {
  const urls = [];
  
  // Base URLs
  urls.push({ loc: `${BASE_URL}/`, changefreq: 'daily', priority: '1.0' });
  urls.push({ loc: `${BASE_URL}/membership`, changefreq: 'monthly', priority: '0.8' });
  
  // Videos
  try {
    const videos = listManifest().filter((v) => v.published !== false && v.status === 'ready');
    for (const v of videos) {
      urls.push({
        loc: `${BASE_URL}/watch?v=${v.id}`,
        changefreq: 'weekly',
        priority: '0.9',
      });
    }
  } catch (err) {
    console.error('Sitemap generator: failed to list videos:', err);
  }

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  for (const item of urls) {
    xml += '  <url>\n';
    xml += `    <loc>${escapeHtml(item.loc)}</loc>\n`;
    xml += `    <changefreq>${item.changefreq}</changefreq>\n`;
    xml += `    <priority>${item.priority}</priority>\n`;
    xml += '  </url>\n';
  }
  xml += '</urlset>';
  return xml;
}

function injectMetaTags(html, reqUrl) {
  const urlObj = new URL(reqUrl, BASE_URL);
  const pathname = decodeURIComponent(urlObj.pathname);

  let title = 'David Bond TV';
  let description = 'Watch David Bond TV — Exclusive travel videos, documentaries, vlogs, and community updates.';
  let ogImage = `${BASE_URL}/logo.jpg`;
  let ogUrl = `${BASE_URL}${urlObj.pathname}${urlObj.search}`;
  let ogType = 'website';

  if (pathname === '/' || pathname === '/videos' || pathname === '/browse.html') {
    title = 'David Bond TV — Browse';
    description = 'Watch David Bond TV — Exclusive travel videos, documentaries, vlogs, and community updates.';
    ogImage = `${BASE_URL}/logo.jpg`;
    ogUrl = `${BASE_URL}/`;
    ogType = 'website';
  } else if (pathname === '/watch' || pathname === '/index.html') {
    const videoId = urlObj.searchParams.get('v');
    if (videoId) {
      const video = listManifest().find((v) => v.id === videoId);
      if (video && video.published !== false) {
        title = `${video.title} — David Bond TV`;
        description = video.description || `Watch ${video.title} on David Bond TV.`;
        if (video.thumb) {
          ogImage = `${BASE_URL}${video.thumb}`;
        }
        ogUrl = `${BASE_URL}/watch?v=${video.id}`;
        ogType = 'video.other';
      }
    }
  } else if (pathname === '/membership' || pathname === '/membership.html') {
    title = 'Membership — David Bond TV';
    description = 'Join David Bond TV for exclusive premium videos and community access.';
  } else if (pathname === '/terms' || pathname === '/terms.html') {
    title = 'Terms of Service — David Bond TV';
  } else if (pathname === '/privacy' || pathname === '/privacy.html') {
    title = 'Privacy Policy — David Bond TV';
  } else if (pathname === '/refunds' || pathname === '/refunds.html') {
    title = 'Refund Policy — David Bond TV';
  } else if (pathname === '/login' || pathname === '/login.html') {
    title = 'Login — David Bond TV';
  } else if (pathname === '/signup' || pathname === '/signup.html') {
    title = 'Sign Up — David Bond TV';
  } else if (pathname === '/recover' || pathname === '/recover.html') {
    title = 'Recover Account — David Bond TV';
  }

  const metaTags = `
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  
  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="${escapeHtml(ogType)}" />
  <meta property="og:url" content="${escapeHtml(ogUrl)}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:image" content="${escapeHtml(ogImage)}" />
  <meta property="og:site_name" content="David Bond TV" />

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:url" content="${escapeHtml(ogUrl)}" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
`;

  // Remove existing title tags and metadata tags that we want to override
  html = html.replace(/<title>[^]*?<\/title>/gi, '');
  html = html.replace(/<meta\s+name=["']description["']\s+content=["'][^]*?["']\s*\/?>/gi, '');
  html = html.replace(/<meta\s+property=["']og:[^]*?["']\s+content=["'][^]*?["']\s*\/?>/gi, '');
  html = html.replace(/<meta\s+name=["']twitter:[^]*?["']\s+content=["'][^]*?["']\s*\/?>/gi, '');

  // Inject right after <head>
  html = html.replace(/<head>/i, `<head>${metaTags}`);
  return html;
}

/** Handle API routes. Returns true if the request was handled, false to fall through. */
async function handleApi(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');

  // POST /api/track  — watch heartbeat. Body: { v, vid, dt, pos, dur }.
  // High-frequency: keep it cheap, never error the client, drop bots.
  if (req.method === 'POST' && url.pathname === '/api/track') {
    try {
      if (ctx.isBot || !trackLimiter.hit(ctx.ip).allowed) { res.writeHead(204); res.end(); return true; }
      const raw = await readBody(req, 2048);
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (body && isKnownVideo(body.v)) {
        const u = ctx.user || null;
        analytics.record({
          t: Date.now(),
          video: body.v,
          viewId: body.vid,
          sessionId: body.sid,
          userId: u ? u.id : null,
          username: u ? (u.username || u.email || u.id) : null,
          subscriber: !!(u && hasActiveMembership(u)),
          ip: ctx.ip,
          cc: ctx.country,
          country: ctx.geo && ctx.geo.countryName,
          city: ctx.geo && ctx.geo.city,
          region: ctx.geo && ctx.geo.region,
          lat: ctx.geo && ctx.geo.lat,
          lon: ctx.geo && ctx.geo.lon,
          dt: body.dt,
          pos: body.pos,
          dur: body.dur,
          visitorId: body.visitorId || body.did,
          deviceId: body.did,
          device: {
            ...(ctx.device || {}),
            id: body.did,
            viewport: body.vp,
            type: body.devType || (ctx.device && ctx.device.type),
          },
        });
      }
    } catch { /* never surface tracking errors to the client */ }
    res.writeHead(204); res.end();
    return true;
  }

  // POST /api/visit — page-visit beacon. Body: { path, ref, did }.
  // One call per page load; bots silently dropped.
  if (req.method === 'POST' && url.pathname === '/api/visit') {
    try {
      if (ctx.isBot || !trackLimiter.hit(ctx.ip).allowed) { res.writeHead(204); res.end(); return true; }
      const raw = await readBody(req, 2048);
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      const visitPath = typeof body?.path === 'string' && body.path.startsWith('/')
        ? body.path.slice(0, 200) : '/';
      if (!isLegacyAdminRoute(visitPath) && !isPrettyAdminRoute(visitPath)) {
        const u = ctx.user || null;
        analytics.recordVisit({
          path: visitPath,
          referrer: String(body?.ref || '').slice(0, 500),
          deviceId: String(body?.did || '').slice(0, 64),
          visitorId: String(body?.visitorId || body?.vid || body?.did || '').slice(0, 160),
          sessionId: String(body?.sessionId || body?.sid || '').slice(0, 120),
          ip: ctx.ip,
          cc: ctx.country,
          country: ctx.geo && ctx.geo.countryName,
          city: ctx.geo && ctx.geo.city,
          region: ctx.geo && ctx.geo.region,
          device: ctx.device || {},
          userId: u ? u.id : null,
          username: u ? (u.username || u.email || u.id) : null,
        });
      }
    } catch { /* never surface tracking errors */ }
    res.writeHead(204); res.end();
    return true;
  }

  // POST /api/analytics/event — low-volume purchase-intent/funnel events.
  if (req.method === 'POST' && url.pathname === '/api/analytics/event') {
    try {
      if (ctx.isBot || !trackLimiter.hit(ctx.ip).allowed) { res.writeHead(204); res.end(); return true; }
      const raw = await readBody(req, 4096);
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      const eventType = typeof body?.eventType === 'string' ? body.eventType.slice(0, 80) : '';
      if (eventType) {
        const u = ctx.user || null;
        analytics.recordFunnelEvent({
          eventType,
          path: typeof body.path === 'string' ? body.path.slice(0, 240) : '',
          referrer: typeof body.referrer === 'string' ? body.referrer.slice(0, 500) : '',
          productId: typeof body.productId === 'string' ? body.productId.slice(0, 160) : '',
          provider: typeof body.provider === 'string' ? body.provider.slice(0, 80) : '',
          visitorId: String(body.visitorId || body.did || '').slice(0, 160),
          sessionId: String(body.sessionId || body.sid || '').slice(0, 120),
          deviceId: String(body.deviceId || body.did || '').slice(0, 160),
          ip: ctx.ip,
          cc: ctx.country,
          country: ctx.geo && ctx.geo.countryName,
          city: ctx.geo && ctx.geo.city,
          region: ctx.geo && ctx.geo.region,
          device: ctx.device || {},
          userId: u ? u.id : null,
          username: u ? (u.username || u.email || u.id) : null,
          meta: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
        });
      }
    } catch { /* tracking is best-effort */ }
    res.writeHead(204); res.end();
    return true;
  }

  // GET /api/challenge
  if (req.method === 'GET' && url.pathname === '/api/challenge') {
    try {
      const { question, token } = createChallenge(SECRET);
      sendJson(res, 200, { question, token });
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // GET /api/gifs/trending  and  /api/gifs/search?q=  — Tenor proxy for the
  // comment GIF picker. Keeps the API key server-side + forces the content filter.
  if (req.method === 'GET' && (url.pathname === '/api/gifs/trending' || url.pathname === '/api/gifs/search')) {
    if (!tenor.enabled) { sendJson(res, 200, { enabled: false, gifs: [] }); return true; }
    if (!gifLimiter.hit(clientIp(req)).allowed) { sendJson(res, 429, { error: 'Slow down a moment.' }); return true; }
    try {
      const gifs = url.pathname.endsWith('/search')
        ? await tenor.search(url.searchParams.get('q') || '', 24)
        : await tenor.trending(24);
      sendJson(res, 200, { enabled: true, gifs });
    } catch {
      sendJson(res, 200, { enabled: true, gifs: [] });
    }
    return true;
  }

  // GET /api/comments?video=<id>
  if (req.method === 'GET' && url.pathname === '/api/comments') {
    try {
      const video = url.searchParams.get('video') || 'bikinis';
      const viewerVisitorId = String(url.searchParams.get('visitorId') || url.searchParams.get('did') || '').slice(0, 160);
      // Hide comments from banned (blocked) users — banning an author also
      // removes their comments from view.
      const blockedIds = new Set(geoGate.getRules().blockedUserIds);
      // Derive the admin + member badges live from the author's CURRENT status,
      // overriding whatever was stored at post time — so a member badge appears
      // the moment they subscribe and disappears when they cancel/lapse, and an
      // ex-admin's old badge clears too.
      const flat = listComments(COMMENTS_FILE, video)
        .filter((c) => !(c.userId && blockedIds.has(c.userId)))
        .filter((c) => ownsShadowComment(c, ctx, viewerVisitorId))
        .map((c) => {
          const { analytics: _analytics, visitorId: _visitorId, moderation: _moderation, ...publicComment } = c;
          if (!publicComment.username) return publicComment;
          const u = accounts.store.getByUsername(publicComment.username);
          const admin = !!(u && Array.isArray(u.roles) && u.roles.includes('admin'));
          const member = !!(u && hasActiveMembership(u));
          return { ...publicComment, admin, member };
        });
      // Group into single-level threads: roots newest-first, each with its replies
      // (oldest-first) + replyCount. `total` counts roots AND replies for the header.
      const comments = threadComments(flat);
      sendJson(res, 200, { comments, total: flat.length });
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // POST /api/comments
  if (req.method === 'POST' && url.pathname === '/api/comments') {
    try {
      // 1. Rate limit
      const ip = ctx.ip || clientIp(req);
      const rl = limiter.hit(ip);
      if (!rl.allowed) {
        sendJson(res, 429, {
          error: "You're posting too fast. Please wait a moment.",
          retryAfter: rl.retryAfter,
        });
        return true;
      }

      // 1b. Geo/IP/user block: API routing runs before the global geo-gate, so
      // enforce it here too. Blocked posters are silently shadow-hidden (they
      // still see their own comment; the public never does) rather than rejected,
      // so a banned troll keeps shouting into a void instead of probing for the
      // block and rotating identity.
      const geoModeration = (!ctx.isAdmin && geoGate.evaluate(ctx).blocked)
        ? { shadow: true, reason: 'geo_block', ts: Date.now() }
        : undefined;

      // 2. Read + parse body
      const raw = await readBody(req, 65536);
      if (raw === null) {
        sendJson(res, 400, { error: 'Invalid request' });
        return true;
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'Invalid request' });
        return true;
      }

      // Honeypot: a hidden field humans never see. If a bot fills it, pretend the
      // post succeeded (silent drop) so it gets no signal to adapt.
      if (body.hp) { sendJson(res, 200, { ok: true }); return true; }

      const { video, name, anonymous, text, answer, token } = body;
      const user = accounts.currentUser(req);
      const country = geoip.lookup(ip) || undefined;
      // Optional GIF: only embed if it's a valid Tenor URL (and gifs are enabled).
      const gifUrl = (tenor.enabled && isTenorGifUrl(body.gif)) ? body.gif : undefined;
      // Optional reply: parentId must reference a real comment on this video.
      const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : undefined;
      if (parentId && !listComments(COMMENTS_FILE, video || 'bikinis').some((c) => c.id === parentId)) {
        sendJson(res, 400, { error: 'That comment no longer exists.' });
        return true;
      }

      // Anti-spam: link/banned-word/duplicate/per-account checks (admins bypass).
      const guard = commentGuard.check({ user, ip, text });
      if (!guard.ok) {
        sendJson(res, guard.status || 400, { error: guard.error, retryAfter: guard.retryAfter });
        return true;
      }

      let stored;
      if (user && user.profileComplete) {
        // Logged-in: post as the profile identity, no math challenge needed.
        const validation = validateComment({ name: user.username, anonymous: false, text, hasGif: !!gifUrl });
        if (!validation.ok) {
          sendJson(res, 400, { error: validation.error });
          return true;
        }
        const filterMatch = commentFilters.match(validation.value.text);
        stored = await addComment(COMMENTS_FILE, video || 'bikinis', {
          name: user.username,
          text: validation.value.text,
          userId: user.id,
          username: user.username,
          admin: Array.isArray(user.roles) && user.roles.includes('admin'),
          avatar: avatarUrl(user.avatar, user.username),
          gifUrl,
          country,
          parentId,
          moderation: shadowModerationFor(filterMatch) || geoModeration,
          visitorId: typeof body.visitorId === 'string' ? body.visitorId : undefined,
          analytics: {
            ip,
            country,
            city: ctx.geo && ctx.geo.city,
            region: ctx.geo && ctx.geo.region,
            referrer: typeof body.referrer === 'string' ? body.referrer : '',
            path: typeof body.path === 'string' ? body.path : '',
            deviceId: typeof body.deviceId === 'string' ? body.deviceId : (typeof body.did === 'string' ? body.did : ''),
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
            device: ctx.device || {},
          },
        });
      } else {
        // Anonymous: require the math challenge; give a varied generic avatar.
        if (!verifyChallenge(SECRET, token, answer)) {
          sendJson(res, 400, { error: 'Incorrect answer to the verification question.' });
          return true;
        }
        const validation = validateComment({ name, anonymous, text, hasGif: !!gifUrl });
        if (!validation.ok) {
          sendJson(res, 400, { error: validation.error });
          return true;
        }
        const filterMatch = commentFilters.match(validation.value.text);
        stored = await addComment(COMMENTS_FILE, video || 'bikinis', {
          name: validation.value.name,
          text: validation.value.text,
          avatarSeed: crypto.randomBytes(4).toString('hex'),
          gifUrl,
          country,
          parentId,
          moderation: shadowModerationFor(filterMatch) || geoModeration,
          visitorId: typeof body.visitorId === 'string' ? body.visitorId : undefined,
          analytics: {
            ip,
            country,
            city: ctx.geo && ctx.geo.city,
            region: ctx.geo && ctx.geo.region,
            referrer: typeof body.referrer === 'string' ? body.referrer : '',
            path: typeof body.path === 'string' ? body.path : '',
            deviceId: typeof body.deviceId === 'string' ? body.deviceId : (typeof body.did === 'string' ? body.did : ''),
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
            device: ctx.device || {},
          },
        });
      }
      // Ping the owner's bell about the new comment (skip the admin's own posts
      // in the bell, but ALWAYS fire the Telegram ping — David wants every comment).
      const authorIsAdmin = !!(user && Array.isArray(user.roles) && user.roles.includes('admin'));
      if (!authorIsAdmin && stored) {
        const who = stored.username || stored.name || 'Someone';
        const snippet = String(stored.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        notifyAdmins({
          kind: 'comment',
          title: `New ${parentId ? 'reply' : 'comment'} from ${who}`,
          body: snippet,
          link: `/watch?v=${encodeURIComponent(video || 'bikinis')}`,
        });
      }
      if (stored) {
        const cc = ctx.country || country || '';
        const safePath = (typeof body.path === 'string' && /^\/[\w\-/?=&.%#]*$/.test(body.path))
          ? body.path
          : `/watch?v=${encodeURIComponent(video || 'bikinis')}`;
        telegramNotifier.notify('comment', {
          parentId,
          username: user ? (user.username || user.email || 'Member') : (stored.name || 'Anonymous'),
          tag: user ? 'member' : 'anonymous',
          text: stored.text,
          ip,
          cc,
          country: (ctx.geo && ctx.geo.countryName) || cc || 'Unknown',
          url: `${BASE_URL}${safePath}`,
          hidden: !!(stored.moderation && stored.moderation.shadow),
          hiddenReason: stored.moderation && (stored.moderation.phrase || stored.moderation.reason),
        });
      }
      sendJson(res, 200, { ok: true, comment: stored });
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // DELETE /api/comments?video=<id>&id=<commentId>  (admin moderation)
  if (req.method === 'DELETE' && url.pathname === '/api/comments') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    try {
      const video = url.searchParams.get('video') || '';
      const id = url.searchParams.get('id') || '';
      const result = await deleteComment(COMMENTS_FILE, video, id);
      sendJson(res, result.ok ? 200 : 404, result);
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // GET /api/reactions?video=<id>  → { likes, dislikes, mine }
  if (req.method === 'GET' && url.pathname === '/api/reactions') {
    try {
      const video = url.searchParams.get('video') || 'bikinis';
      const counts = getCounts(REACTIONS_FILE, video);
      const user = accounts.currentUser(req);
      const mine = user ? getUserVote(REACTIONS_FILE, video, user.id) : 0;
      sendJson(res, 200, { ...counts, mine });
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // POST /api/reactions  { video, vote: 1 | -1 | 0 }  (login required)
  if (req.method === 'POST' && url.pathname === '/api/reactions') {
    try {
      const user = accounts.currentUser(req);
      if (!user) {
        sendJson(res, 401, { error: 'Please sign in to like or dislike.' });
        return true;
      }
      const raw = await readBody(req, 4096);
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      if (!body || ![1, -1, 0].includes(body.vote)) {
        sendJson(res, 400, { error: 'Invalid request' });
        return true;
      }
      const video = body.video || 'bikinis';
      const result = await setVote(REACTIONS_FILE, video, user.id, body.vote);
      sendJson(res, 200, { ok: true, ...result });
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // GET /api/admin/account → admin profile (no hashes)
  if (req.method === 'GET' && url.pathname === '/api/admin/account') {
    const u = isAdminReq(req) ? accounts.currentUser(req) : null;
    if (!u) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    sendJson(res, 200, { account: { username: u.username, email: u.email } });
    return true;
  }

  // POST /api/admin/account/password  { current, next } — change the admin's own password
  if (req.method === 'POST' && url.pathname === '/api/admin/account/password') {
    const u = isAdminReq(req) ? accounts.currentUser(req) : null;
    if (!u) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    try {
      const raw = await readBody(req, 4096);
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body || !verifyPassword(body.current, u.passwordHash)) {
        sendJson(res, 401, { error: 'Current password is incorrect.' }); return true;
      }
      if (typeof body.next !== 'string' || body.next.length < 4) {
        sendJson(res, 400, { error: 'Password must be at least 4 characters.' }); return true;
      }
      await accounts.store.updateUser(u.id, { passwordHash: hashPassword(body.next), securityStamp: crypto.randomBytes(16).toString('hex') });
      accounts.establishSession(res, accounts.store.getById(u.id)); // keep this session alive
      sendJson(res, 200, { ok: true });
    } catch { sendJson(res, 500, { error: 'Server error' }); }
    return true;
  }

  // Legacy public admin recovery is intentionally removed. Recovery is now a
  // server-only break-glass script, not a web endpoint.
  if (url.pathname === '/api/admin/recover') {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  // Full manifest for authenticated admin surfaces only.
  if (req.method === 'GET' && url.pathname === '/api/admin/videos') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    sendJson(res, 200, { videos: listManifest() });
    return true;
  }

  // GET /api/admin/status[?job=<id>]  → ffmpeg availability + job(s)
  if (req.method === 'GET' && url.pathname === '/api/admin/status') {
    if (!isAdminReq(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const jobId = url.searchParams.get('job');
    if (jobId) {
      sendJson(res, 200, { job: getJob(jobId), ffmpeg: hasFfmpeg(), maxUploadBytes: UPLOAD_MAX_BYTES });
    } else {
      sendJson(res, 200, { jobs: listJobs(), ffmpeg: hasFfmpeg(), maxUploadBytes: UPLOAD_MAX_BYTES });
    }
    return true;
  }

  // GET /api/admin/metrics → system stats (CPU, memory, disk, video stats)
  if (req.method === 'GET' && url.pathname === '/api/admin/metrics') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    try {
      const metrics = await getSystemMetrics();
      sendJson(res, 200, metrics);
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to collect metrics' });
    }
    return true;
  }

  // GET /api/admin/metrics/live → cheap, uncached CPU%/memory for the live graphs.
  // CPU% is derived from os.cpus() time deltas between calls (works on Windows +
  // Linux, unlike loadavg which is 0 on Windows). No disk walk → safe to poll fast.
  if (req.method === 'GET' && url.pathname === '/api/admin/metrics/live') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const mem = { total: os.totalmem(), free: os.freemem() };
    mem.used = mem.total - mem.free;
    sendJson(res, 200, {
      t: Date.now(),
      cpu: { percent: cpuPercentDelta(), cores: os.cpus().length, load: os.loadavg() },
      memory: mem,
      net: netThroughput(),
    });
    return true;
  }

  // ===================== Local→server video publish =====================
  // SERVER side: receive endpoints (/api/sync/*). Disabled (404) unless SYNC_TOKEN
  // is set. Auth: static Bearer SYNC_TOKEN or a logged-in admin.
  if (url.pathname.startsWith('/api/sync/')) {
    if (!SYNC_TOKEN) { sendJson(res, 404, { error: 'Not found' }); return true; }
    if (!isSyncAuthed(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }

    // POST /api/sync/config { categories?, coupons? } → mirror authored config from
    // local to production (categories + coupons). Local is the source of truth, so
    // the live site matches what the owner built locally — this is what carries
    // category names/emojis/icons over so published videos show their styling.
    // Runtime/user data (accounts, payments, analytics) is never touched.
    if (req.method === 'POST' && url.pathname === '/api/sync/config') {
      let body; try { body = JSON.parse(await readBody(req, 1 << 20)); } catch { body = null; }
      const result = {};
      if (body && Array.isArray(body.categories)) {
        const r = categories.importAll(body.categories);
        result.categories = r.ok ? r.count : 0;
      }
      if (body && Array.isArray(body.coupons)) {
        const r = coupons.importAll(body.coupons);
        result.coupons = r.ok ? r.count : 0;
      }
      console.log(`[sync] config merged: ${result.categories ?? 0} categories, ${result.coupons ?? 0} coupons`);
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    // POST /api/sync/diff { videos:[{id,fingerprint}] } → { present, changed, missing }
    if (req.method === 'POST' && url.pathname === '/api/sync/diff') {
      let body; try { body = JSON.parse(await readBody(req, 1 << 20)); } catch { body = null; }
      const incoming = body && Array.isArray(body.videos) ? body.videos : [];
      sendJson(res, 200, diffManifest(listManifest(), incoming));
      return true;
    }

    // POST /api/sync/artifact/init { relPath, size, sha256 } → { uploadId, offset, chunkSize }
    if (req.method === 'POST' && url.pathname === '/api/sync/artifact/init') {
      let body; try { body = JSON.parse(await readBody(req, 8192)); } catch { body = null; }
      const relPath = body && typeof body.relPath === 'string' ? body.relPath : '';
      const size = body ? Number(body.size) : NaN;
      const sha256 = body && typeof body.sha256 === 'string' ? body.sha256 : '';
      if (!relPath || !Number.isFinite(size) || size < 0 || !sha256) { sendJson(res, 400, { error: 'Invalid request.' }); return true; }
      if (!ALLOWED_SYNC_PREFIXES.some((p) => relPath.startsWith(p))) { sendJson(res, 400, { error: 'Path not allowed.' }); return true; }
      const dest = resolveAssetPath(relPath); // null if it escapes its content root
      if (!dest) { sendJson(res, 400, { error: 'Unsafe path.' }); return true; }
      if (size > UPLOAD_MAX_BYTES) { sendJson(res, 413, { error: 'Artifact too large.' }); return true; }
      const partPath = `${dest}.part`;
      // Content-addressed session id: re-init of the same artifact (after a pause,
      // cancel, or retry) maps back to the same in-progress transfer.
      const id = sha256;

      // 1) Already fully present with identical content → nothing to upload. The
      //    sha sidecar (written at complete) lets us answer without re-hashing a
      //    multi-GB rendition. This is what makes a re-publish skip unchanged
      //    artifacts (settings-only edits stay cheap).
      try {
        await fsp.access(dest);
        const have = (await fsp.readFile(`${dest}.sha256`, 'utf8')).trim();
        if (have && have === sha256) { sendJson(res, 200, { complete: true }); return true; }
      } catch { /* not present / no sidecar → fall through */ }

      // 2) Resume an interrupted partial: a session for this content is still live
      //    and its .part is intact at the declared size. Hand back how far we got.
      const existing = uploads.getSession(id);
      if (existing && existing.size === size) {
        let partOk = false;
        try { partOk = (await fsp.stat(partPath)).size === size; } catch { partOk = false; }
        if (partOk) {
          uploads.touch(existing);
          sendJson(res, 200, { uploadId: id, offset: uploads.contiguousBytes(existing), chunkSize: UPLOAD_CHUNK_SIZE });
          return true;
        }
      }

      // 3) Fresh transfer — (re)allocate the .part and a new content-addressed session.
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.unlink(partPath).catch(() => {});
      const fh = await fsp.open(partPath, 'w');
      await fh.truncate(size);
      await fh.close();
      uploads.deleteSession(id);
      uploads.createSession(id, { partPath, savedPath: dest, name: relPath, size, sha256 });
      sendJson(res, 200, { uploadId: id, offset: 0, chunkSize: UPLOAD_CHUNK_SIZE });
      return true;
    }

    // POST /api/sync/artifact/chunk?id=&offset=  (positional write; same as upload)
    if (req.method === 'POST' && url.pathname === '/api/sync/artifact/chunk') {
      const id = url.searchParams.get('id') || '';
      const offset = Number(url.searchParams.get('offset'));
      const session = uploads.getSession(id);
      const declaredLen = Number(req.headers['content-length']) || 0;
      const check = uploads.validateChunk(session, offset, declaredLen, UPLOAD_MAX_BYTES);
      if (!check.ok) { try { req.resume(); } catch { /* drain */ } sendJson(res, check.status, { error: check.error }); return true; }
      if (check.skip) { uploads.touch(session); try { req.resume(); } catch { /* drain */ } sendJson(res, 200, { received: session.received }); return true; }
      const buf = await readRawBody(req, declaredLen + 1024);
      if (buf === null) { sendJson(res, 500, { error: 'Could not receive that chunk.' }); return true; }
      try {
        const fh = await fsp.open(session.partPath, 'r+');
        await fh.write(buf, 0, buf.length, offset);
        await fh.close();
        uploads.addRange(session, offset, offset + buf.length);
        uploads.touch(session);
        sendJson(res, 200, { received: session.received });
      } catch { sendJson(res, 500, { error: 'Could not save that chunk.' }); }
      return true;
    }

    // POST /api/sync/artifact/complete?id=  → verify sha256, commit .part → dest
    if (req.method === 'POST' && url.pathname === '/api/sync/artifact/complete') {
      const id = url.searchParams.get('id') || '';
      const session = uploads.getSession(id);
      const check = uploads.validateComplete(session);
      if (!check.ok) { sendJson(res, check.status, { error: check.error }); return true; }
      try {
        const actual = await sha256File(session.partPath);
        if (session.sha256 && actual !== session.sha256) {
          await fsp.unlink(session.partPath).catch(() => {});
          uploads.deleteSession(id);
          sendJson(res, 422, { error: 'Checksum mismatch — artifact corrupted in transit.' });
          return true;
        }
        await fsp.rename(session.partPath, session.savedPath);
        // Record the verified hash so a later publish can confirm "already have
        // this exact artifact" at init without re-reading the whole file.
        await fsp.writeFile(`${session.savedPath}.sha256`, session.sha256).catch(() => {});
        uploads.deleteSession(id);
        sendJson(res, 200, { ok: true });
      } catch { sendJson(res, 500, { error: 'Could not finalize artifact.' }); }
      return true;
    }

    // POST /api/sync/manifest { entry } → merge into the manifest (commit point)
    if (req.method === 'POST' && url.pathname === '/api/sync/manifest') {
      let body; try { body = JSON.parse(await readBody(req, 1 << 20)); } catch { body = null; }
      const entry = body && body.entry;
      if (!entry || typeof entry !== 'object' || !entry.id) { sendJson(res, 400, { error: 'Invalid entry.' }); return true; }
      await mergeManifestEntry(entry);
      console.log(`[sync] merged manifest entry id=${entry.id} title="${entry.title || ''}"`);
      sendJson(res, 200, { ok: true });
      return true;
    }

    // POST /api/sync/delete { ids:[...] } → remove exactly those videos. Only the
    // ids the client deleted locally (tombstones) are sent, so server-only videos
    // (e.g. phone uploads) are never affected. tombstone:false → receiving a delete
    // doesn't create a new tombstone on this machine.
    if (req.method === 'POST' && url.pathname === '/api/sync/delete') {
      let body; try { body = JSON.parse(await readBody(req, 1 << 20)); } catch { body = null; }
      const ids = body && Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
      const deleted = [];
      const notFound = [];
      for (const id of ids) {
        const r = await deleteVideo(id, { tombstone: false });
        if (r.ok) { deleted.push(id); console.log(`[sync] deleted id=${id}`); }
        else notFound.push(id);
      }
      sendJson(res, 200, { deleted, notFound });
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  // LOCAL side: drive a publish to the configured SYNC_TARGET_URL. Admin-only;
  // SYNC_TOKEN/target never reach the browser.
  if (req.method === 'POST' && url.pathname === '/api/admin/publish/start') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    if (!SYNC_TARGET_URL || !SYNC_TOKEN) {
      sendJson(res, 400, { error: 'Publishing is not configured — set SYNC_TARGET_URL and SYNC_TOKEN on this machine.' });
      return true;
    }
    // Don't run two publishes at once — reconnect the caller to the live one.
    const live = latestPublishJob();
    if (live && live.status === 'running') { sendJson(res, 200, { jobId: live.jobId, target: SYNC_TARGET_URL, resumed: true }); return true; }
    const { jobId } = startPublish({ targetUrl: SYNC_TARGET_URL, token: SYNC_TOKEN });
    sendJson(res, 200, { jobId, target: SYNC_TARGET_URL });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/publish/status') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const q = url.searchParams.get('job') || '';
    // No id (or "latest") → reconnect to the most recent job after a page reload.
    const job = (!q || q === 'latest') ? latestPublishJob() : getPublishJob(q);
    if (!job) { sendJson(res, 404, { error: 'No such publish job.' }); return true; }
    const { control, ...safe } = job; // never leak the internal control handle
    sendJson(res, 200, { job: safe });
    return true;
  }
  // Pause / resume / cancel an in-flight publish. Cancel leaves every uploaded
  // byte on the server, so the next Publish resumes from where this stopped.
  if (req.method === 'POST' && url.pathname === '/api/admin/publish/control') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    let body; try { body = JSON.parse(await readBody(req, 8192)); } catch { body = null; }
    const jobId = body && typeof body.job === 'string' ? body.job : '';
    const action = body && typeof body.action === 'string' ? body.action : '';
    const r = controlPublishJob(jobId, action);
    sendJson(res, r.ok ? 200 : 400, r);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/publish/config') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    sendJson(res, 200, { configured: !!(SYNC_TARGET_URL && SYNC_TOKEN), target: SYNC_TARGET_URL || null });
    return true;
  }

  // Stream a not-yet-encoded video's ORIGINAL for admin review (it has no
  // renditions yet). Admin-only; Range-enabled so the review player can scrub.
  if (req.method === 'GET' && url.pathname === '/api/admin/review-source') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const src = reviewSource(url.searchParams.get('id') || '');
    if (!src) { sendJson(res, 404, { error: 'No reviewable original for that video.' }); return true; }
    try {
      const stat = await fsp.stat(src.path);
      const headers = { 'Content-Type': contentType(src.path), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      const range = parseRange(req.headers.range, stat.size);
      if (range && range.invalid) { res.writeHead(416, withSecurityHeaders({ 'Content-Range': `bytes */${stat.size}` })); res.end(); return true; }
      if (range) {
        const { start, end } = range;
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        headers['Content-Length'] = end - start + 1;
        res.writeHead(206, withSecurityHeaders(headers));
        fs.createReadStream(src.path, { start, end }).pipe(res);
      } else {
        headers['Content-Length'] = stat.size;
        res.writeHead(200, withSecurityHeaders(headers));
        fs.createReadStream(src.path).pipe(res);
      }
    } catch { sendJson(res, 500, { error: 'Could not read the original.' }); }
    return true;
  }

  // POST /api/admin/delete  { id } → { ok }
  if (req.method === 'POST' && url.pathname === '/api/admin/delete') {
    if (!isAdminReq(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    try {
      const raw = await readBody(req, 4096);
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      const result = await deleteVideo(body && body.id);
      sendJson(res, result.ok ? 200 : 404, result);
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // POST /api/admin/edit  { id, title?, description?, blur? } → { ok }
  if (req.method === 'POST' && url.pathname === '/api/admin/edit') {
    if (!isAdminReq(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    try {
      const raw = await readBody(req, 16384);
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      if (!body) { sendJson(res, 400, { error: 'Invalid request' }); return true; }
      const category = body.category === undefined ? undefined
        : (categories.has(body.category) || body.category === '' ? body.category : undefined);
      const result = await editVideo(body.id, { title: body.title, description: body.description, blur: body.blur, category, thumb: body.thumb, visibility: body.visibility });
      sendJson(res, result.ok ? 200 : 404, result);
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // POST /api/admin/pin  { id, pinned } → pin/unpin a video to the top of the grid.
  if (req.method === 'POST' && url.pathname === '/api/admin/pin') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    try {
      const raw = await readBody(req, 4096);
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      if (!body || typeof body.id !== 'string') { sendJson(res, 400, { error: 'Invalid request' }); return true; }
      const result = await setPinned(body.id, !!body.pinned);
      sendJson(res, result.ok ? 200 : (result.error === 'Not found' ? 404 : 400), result);
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // POST /api/admin/thumb?id=<id>  (raw image body) → { ok, thumb }
  if (req.method === 'POST' && url.pathname === '/api/admin/thumb') {
    if (!isAdminReq(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const id = url.searchParams.get('id') || '';
    const target = thumbTarget(id, req.headers['content-type']);
    if (!target) {
      sendJson(res, 415, { error: 'Provide ?id and a PNG, JPEG or WEBP image.' });
      return true;
    }
    await streamThumb(req, res, id, target);
    return true;
  }

  // --- Geo-restriction management (all require admin) ---

  // GET /api/admin/geo → rules + what the server detects about THIS request.
  if (req.method === 'GET' && url.pathname === '/api/admin/geo') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    sendJson(res, 200, {
      rules: geoGate.getRules(),
      detected: { ip: ctx.ip, country: ctx.country, countrySource: ctx.countrySource, bypass: ctx.bypass, trustCloudflare: TRUST_CLOUDFLARE },
    });
    return true;
  }

  // POST /api/admin/geo  { op, value, action } → mutate rules, return new rules.
  if (req.method === 'POST' && url.pathname === '/api/admin/geo') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    try {
      const raw = await readBody(req, 4096);
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body || !body.op) { sendJson(res, 400, { error: 'Invalid request' }); return true; }
      const add = body.action !== 'remove' && body.action !== 'unblock';
      let rules;
      switch (body.op) {
        case 'enabled': rules = await geoGate.setEnabled(!!body.value); break;
        case 'country': rules = await (add ? geoGate.addBlockedCountry(body.value) : geoGate.removeBlockedCountry(body.value)); break;
        case 'ip': rules = await (add ? geoGate.blockIp(body.value) : geoGate.unblockIp(body.value)); break;
        case 'user': rules = await (add ? geoGate.blockUser(body.value) : geoGate.unblockUser(body.value)); break;
        // allowlist: "add my IP" when value omitted → uses the detected IP.
        case 'allow': rules = await (add ? geoGate.allowIp(body.value || ctx.ip) : geoGate.disallowIp(body.value || ctx.ip)); break;
        default: sendJson(res, 400, { error: 'Unknown op' }); return true;
      }
      sendJson(res, 200, { ok: true, rules });
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // POST /api/admin/geo/simulate  { cc } → set/clear the admin simulate-country cookie.
  if (req.method === 'POST' && url.pathname === '/api/admin/geo/simulate') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    try {
      const raw = await readBody(req, 1024);
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      const cc = body && typeof body.cc === 'string' ? body.cc.trim().toUpperCase() : '';
      const valid = /^[A-Z]{2}$/.test(cc);
      res.setHeader('Set-Cookie', serializeCookie('dbtv_simcc', valid ? cc : '', {
        maxAge: valid ? 86400 : 0, httpOnly: false, sameSite: 'Lax', secure: COOKIE_SECURE,
      }));
      sendJson(res, 200, { ok: true, simulate: valid ? cc : null });
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }


  // --- DataBond GigaBrain (native dashboard ← GigaBrain sidecar proxy) ---
  // The browser only ever talks to this app; these routes relay to the GigaBrain
  // sidecar server-to-server (see lib/gigabrain-proxy.js). Every one is admin-gated.

  // GET /api/admin/databond/status → is the sidecar configured? (drives the UI's
  // "not connected" notice without leaking whether the password is set).
  if (req.method === 'GET' && url.pathname === '/api/admin/databond/status') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    sendJson(res, 200, { configured: gigabrainConfigured() });
    return true;
  }

  // GET proxies — forward the whitelisted query string to the matching GigaBrain
  // admin endpoint and pass its status/body straight back to the client.
  {
    const GB_GET = {
      '/api/admin/databond/stats': { path: 'stats', params: ['range', 'bots', 'bucket'] },
      '/api/admin/databond/realtime': { path: 'realtime', params: [] },
      '/api/admin/databond/activity': { path: 'activity', params: ['range', 'bots', 'type', 'limit'] },
      '/api/admin/databond/visitor': { path: 'visitor', params: ['id'] },
      '/api/admin/databond/geo': { path: 'geo', params: ['range', 'country'] },
      '/api/admin/databond/gsc': { path: 'gsc', params: ['range'] },
    };
    const gbRoute = GB_GET[url.pathname];
    if (req.method === 'GET' && gbRoute) {
      if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
      const fwd = new URLSearchParams();
      for (const key of gbRoute.params) {
        const v = url.searchParams.get(key);
        if (v != null && v !== '') fwd.set(key, v);
      }
      const qs = fwd.toString();
      const { status, json } = await proxyGet(gbRoute.path, qs ? `?${qs}` : '');
      sendJson(res, status, json);
      return true;
    }
  }

  // POST /api/admin/databond/geo → block/unblock a country on the sidecar.
  if (req.method === 'POST' && url.pathname === '/api/admin/databond/geo') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    let body;
    try {
      const raw = await readBody(req, 2048);
      body = JSON.parse(raw);
    } catch { sendJson(res, 400, { error: 'Invalid request' }); return true; }
    const { status, json } = await proxyJson('POST', 'geo', body);
    sendJson(res, status, json);
    return true;
  }

  // --- Analytics dashboards (admin) ---

  // GET /api/admin/analytics/overview → totals + top videos + countries + blocked.
  if (req.method === 'GET' && url.pathname === '/api/admin/analytics/overview') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const DAY = 86400000;
    const now = Date.now();
    const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
    const rangeParam = (url.searchParams.get('range') || '30d').toLowerCase();
    const titles = manifestTitleMap();
    const verifiedUsers = accounts.store.listAll().filter((u) => u.verified).length;
    const countries = analytics.getCountryStats(); // all-time (no per-day country rollup yet)

    // 24h → hourly buckets from raw events. Raw has no viewId, so a "view" here is
    // approximated as a distinct ip|video pair within the window (minutes are exact).
    if (rangeParam === '24h') {
      const since = now - DAY;
      const evs = analytics.getRecentEvents(50000)
        .filter((e) => e.t >= since && !isBotUa(e.device && e.device.ua));
      const buckets = {};
      const seen = new Set();
      const seenVisitorsByHour = {};
      const vidAgg = {};
      let totViews = 0, totSeconds = 0, totBlocked = 0;
      for (const e of evs) {
        const hk = new Date(e.t).toISOString().slice(0, 13); // YYYY-MM-DDTHH
        const b = (buckets[hk] ||= { views: 0, _sec: 0, blocked: 0, pageViews: 0, uniqueVisitors: 0 });
        if (e.blocked) { b.blocked += 1; totBlocked += 1; continue; }
        b._sec += e.dt || 0; totSeconds += e.dt || 0;
        if (e.video) { const va = (vidAgg[e.video] ||= { views: 0, seconds: 0 }); va.seconds += e.dt || 0; }
        const vkey = `${e.ip || '?'}|${e.video || '?'}`;
        if (!seen.has(vkey)) {
          seen.add(vkey); b.views += 1; totViews += 1;
          if (e.video) vidAgg[e.video].views += 1;
        }
      }
      const visitLogs = analytics.queryLogs({ type: 'visit', from: utcDay(since), to: utcDay(now), limit: 5000 }).events
        .filter((e) => e.t >= since);
      for (const e of visitLogs) {
        const hk = new Date(e.t).toISOString().slice(0, 13);
        const b = (buckets[hk] ||= { views: 0, _sec: 0, blocked: 0, pageViews: 0, uniqueVisitors: 0 });
        b.pageViews += 1;
        const vk = e.visitorId || e.deviceId || e.ip;
        if (vk) {
          const s = (seenVisitorsByHour[hk] ||= new Set());
          if (!s.has(vk)) { s.add(vk); b.uniqueVisitors += 1; }
        }
      }
      const series = Object.keys(buckets).sort().map((hk) => ({
        day: hk.slice(11) + ':00', views: buckets[hk].views,
        minutes: Math.round(buckets[hk]._sec / 60), blocked: buckets[hk].blocked,
        pageViews: buckets[hk].pageViews || 0, uniqueVisitors: buckets[hk].uniqueVisitors || 0,
      }));
      const topVideos = Object.entries(vidAgg)
        .map(([id, s]) => ({ id, title: titles[id] || id, views: s.views, minutes: Math.round(s.seconds / 60) }))
        .sort((a, b) => b.views - a.views).slice(0, 20);
      const vs24h = analytics.getVisitorStats(utcDay(since), utcDay(now));
      sendJson(res, 200, {
        range: '24h', granularity: 'hour', countriesAllTime: true,
        totals: { views: totViews, minutes: Math.round(totSeconds / 60), hours: Math.round(totSeconds / 360) / 10,
          pageViews: vs24h.pageViews, uniqueVisitors: vs24h.uniqueVisitors },
        topVideos, countries,
        blocked: { total: totBlocked, byCountry: analytics.getBlockedStats().byCountry, byDay: {} },
        userCount: verifiedUsers, series, generatedAt: now,
      });
      return true;
    }

    // Day ranges (7d/30d/90d/custom) → window the byDay rollups.
    let toDay = utcDay(now), fromDay;
    if (rangeParam === 'custom') {
      const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
      const f = url.searchParams.get('from'), t = url.searchParams.get('to');
      fromDay = valid(f) ? f : utcDay(now - 29 * DAY);
      if (valid(t)) toDay = t;
      if (fromDay > toDay) { const tmp = fromDay; fromDay = toDay; toDay = tmp; }
    } else {
      const days = rangeParam === '7d' ? 7 : rangeParam === '90d' ? 90 : 30;
      fromDay = utcDay(now - (days - 1) * DAY);
    }
    const inWindow = (day) => day >= fromDay && day <= toDay;

    const vids = analytics.getAllVideoStats();
    const byDay = {};
    const vidAgg = {};
    for (const [id, s] of Object.entries(vids)) {
      let vv = 0, vs = 0;
      for (const [day, d] of Object.entries(s.byDay || {})) {
        if (!inWindow(day)) continue;
        const e = (byDay[day] ||= { views: 0, minutes: 0, blocked: 0 });
        e.views += d.views || 0; e.minutes += Math.round((d.seconds || 0) / 60);
        vv += d.views || 0; vs += d.seconds || 0;
      }
      if (vv || vs) vidAgg[id] = { views: vv, seconds: vs };
    }
    const blockedStats = analytics.getBlockedStats();
    let blockedTotal = 0;
    for (const [day, n] of Object.entries(blockedStats.byDay || {})) {
      if (!inWindow(day)) continue;
      (byDay[day] ||= { views: 0, minutes: 0, blocked: 0 }).blocked += n;
      blockedTotal += n;
    }
    for (const v of analytics.getVisitorSeries(fromDay, toDay)) {
      const e = (byDay[v.day] ||= { views: 0, minutes: 0, blocked: 0 });
      e.pageViews = v.pageViews || 0;
      e.uniqueVisitors = v.uniqueVisitors || 0;
    }
    const series = Object.keys(byDay).sort().map((day) => ({ day, ...byDay[day] }));
    const totViews = series.reduce((a, s) => a + s.views, 0);
    const totMinutes = series.reduce((a, s) => a + s.minutes, 0);
    const topVideos = Object.entries(vidAgg)
      .map(([id, s]) => ({ id, title: titles[id] || id, views: s.views, minutes: Math.round(s.seconds / 60) }))
      .sort((a, b) => b.views - a.views).slice(0, 20);
    const vs = analytics.getVisitorStats(fromDay, toDay);
    sendJson(res, 200, {
      range: rangeParam, granularity: 'day', from: fromDay, to: toDay, countriesAllTime: true,
      totals: { views: totViews, minutes: totMinutes, hours: Math.round((totMinutes / 60) * 10) / 10,
        pageViews: vs.pageViews, uniqueVisitors: vs.uniqueVisitors },
      topVideos, countries,
      blocked: { total: blockedTotal, byCountry: blockedStats.byCountry, byDay: blockedStats.byDay },
      userCount: verifiedUsers, series, generatedAt: now,
    });
    return true;
  }

  // GET /api/admin/analytics/video?id=<id> → one video's stats + daily series.
  if (req.method === 'GET' && url.pathname === '/api/admin/analytics/video') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const id = url.searchParams.get('id') || '';
    const s = analytics.getVideoStats(id);
    const titles = manifestTitleMap();
    const views = (s && s.views) || 0;
    const seconds = (s && s.totalSeconds) || 0;
    const byDay = Object.entries((s && s.byDay) || {})
      .map(([day, d]) => ({ day, views: d.views || 0, minutes: Math.round((d.seconds || 0) / 60) }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));
    sendJson(res, 200, {
      id, title: titles[id] || id,
      views, minutes: Math.round(seconds / 60),
      avgSeconds: views ? Math.round(seconds / views) : 0,
      byDay,
    });
    return true;
  }

  // GET /api/admin/analytics/pages — per-path visit counts for the selected date range.
  if (req.method === 'GET' && url.pathname === '/api/admin/analytics/pages') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const DAY = 86400000;
    const now = Date.now();
    const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
    const rangeParam = (url.searchParams.get('range') || '30d').toLowerCase();
    let toDay = utcDay(now), fromDay;
    if (rangeParam === 'custom') {
      const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
      const f = url.searchParams.get('from'), t = url.searchParams.get('to');
      fromDay = valid(f) ? f : utcDay(now - 29 * DAY);
      if (valid(t)) toDay = t;
      if (fromDay > toDay) { const tmp = fromDay; fromDay = toDay; toDay = tmp; }
    } else {
      const days = rangeParam === '7d' ? 7 : rangeParam === '90d' ? 90 : 30;
      fromDay = utcDay(now - (days - 1) * DAY);
    }
    const allPages = analytics.getPageStats(fromDay, toDay)
      .filter(p => !isLegacyAdminRoute(p.path) && !isPrettyAdminRoute(p.path));
    sendJson(res, 200, {
      pages: allPages,
      totals: analytics.getVisitorStats(fromDay, toDay),
      generatedAt: now,
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/analytics/funnel') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const DAY = 86400000;
    const now = Date.now();
    const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
    const rangeParam = (url.searchParams.get('range') || '30d').toLowerCase();
    let toDay = utcDay(now), fromDay;
    if (rangeParam === 'custom') {
      const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
      const f = url.searchParams.get('from'), t = url.searchParams.get('to');
      fromDay = valid(f) ? f : utcDay(now - 29 * DAY);
      if (valid(t)) toDay = t;
      if (fromDay > toDay) { const tmp = fromDay; fromDay = toDay; toDay = tmp; }
    } else {
      const days = rangeParam === '7d' ? 7 : rangeParam === '90d' ? 90 : 30;
      fromDay = utcDay(now - (days - 1) * DAY);
    }
    sendJson(res, 200, { ...analytics.getFunnelStats(fromDay, toDay), from: fromDay, to: toDay, generatedAt: now });
    return true;
  }

  // GET /api/admin/analytics/countries → viewers + subscribers + blocked per country (for the map).
  if (req.method === 'GET' && url.pathname === '/api/admin/analytics/countries') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const ustats = analytics.getAllUserStats();
    const subscribers = {};
    for (const u of accounts.store.listAll()) {
      if (hasActiveMembership(u)) {
        const cc = ustats[u.id] && ustats[u.id].lastCountry;
        if (cc) subscribers[cc] = (subscribers[cc] || 0) + 1;
      }
    }
    sendJson(res, 200, {
      viewers: analytics.getCountryStats(),
      subscribers,
      blocked: analytics.getBlockedStats().byCountry,
    });
    return true;
  }

  // GET /api/admin/analytics/traffic → marker-level traffic events for the 3D globe.
  if (req.method === 'GET' && url.pathname === '/api/admin/analytics/traffic') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const mode = url.searchParams.get('mode') || 'viewers';
    const filters = logFiltersFromUrl(url);
    if (mode === 'subscribers') filters.subscriber = 'true';
    if (mode === 'blocked') filters.type = 'blocked';
    const titles = manifestTitleMap();
    const names = userNameMap();
    const markers = analytics.getTrafficMarkers(filters)
      .filter((m) => !isBotUa(m.device && m.device.ua))
      .map((m) => decorateLogEvent(m, titles, names));
    const preciseKeys = new Set(markers.map((m) => `${m.t}|${m.ip || ''}|${m.videoId || ''}|${m.type || ''}`));
    // An event has a usable precise coordinate only if it's a finite, in-range,
    // non-Null-Island lat/lon (mirrors getTrafficMarkers). Everything else falls
    // back to the country centroid so it lands on the right country, not the ocean.
    const validCoord = (e) => {
      const la = Number(e.lat), lo = Number(e.lon);
      return Number.isFinite(la) && Number.isFinite(lo)
        && !(Math.abs(la) < 0.01 && Math.abs(lo) < 0.01)
        && Math.abs(la) <= 90 && Math.abs(lo) <= 180;
    };
    const approximate = analytics.queryLogs({ ...filters, limit: 5000 }).events
      .filter((e) => (e.type === 'watch' || e.type === 'blocked') && !validCoord(e))
      .map((e, i) => {
        const key = `${e.t}|${e.ip || ''}|${e.videoId || ''}|${e.type || ''}`;
        if (preciseKeys.has(key)) return null;
        const c = e.cc && CENTROIDS[e.cc];
        if (!c) return null;
        return decorateLogEvent({
          ...e,
          id: `approx-${e.t}-${i}`,
          lat: c[0],
          lon: c[1],
          precise: false,
        }, titles, names);
      }).filter(Boolean);
    markers.push(...approximate);
    sendJson(res, 200, { markers, mode, generatedAt: Date.now() });
    return true;
  }

  // GET /api/admin/analytics/visitors?limit= → recent individual viewer events
  // with IP + country + user + video (newest first), for the analytics panel.
  if (req.method === 'GET' && url.pathname === '/api/admin/analytics/visitors') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), 1000);
    const titles = manifestTitleMap();
    const names = userNameMap();
    // Current subscriber set (authoritative live membership) so the feed can badge
    // subscriber usernames without trusting possibly-stale per-event flags.
    const subscriberIds = new Set(accounts.store.listAll().filter((u) => hasActiveMembership(u)).map((u) => u.id));
    const events = analytics.getRecentEvents(limit)
      .filter((raw) => !isBotUa(raw.device && raw.device.ua))
      .map((raw) => {
      const e = decorateLogEvent(raw, titles, names);
      return {
      t: e.t,
      ip: e.ip,
      cc: e.cc,
      country: e.country,
      city: e.city,
      region: e.region,
      user: e.username || null,
      userId: e.userId,
      subscriber: !!(e.userId && subscriberIds.has(e.userId)),
      video: e.videoTitle || null,
      videoId: e.videoId,
      seconds: e.seconds || e.dt,
      position: e.position,
      duration: e.duration,
      deviceId: e.deviceId,
      device: e.device,
      sessionId: e.sessionId,
      viewId: e.viewId,
      blocked: e.blocked,
      type: e.type,
      reason: e.reason,
    }; });
    sendJson(res, 200, { events });
    return true;
  }

  // GET /api/admin/financial → sales, revenue, subscription health, paid/free.
  // Aggregates the payment ledger (data/payments.json) + user membership state.
  if (req.method === 'GET' && url.pathname === '/api/admin/financial') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    sendJson(res, 200, buildFinancialSummary(accounts.store.listAll(), paymentsStore));
    return true;
  }

  // GET /api/admin/logs → searchable historical activity logs.
  if (req.method === 'GET' && url.pathname === '/api/admin/logs') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const titles = manifestTitleMap();
    const names = userNameMap();
    const result = analytics.queryLogs(logFiltersFromUrl(url));
    result.events = result.events.map((e) => decorateLogEvent(e, titles, names));
    sendJson(res, 200, { ...result, generatedAt: Date.now() });
    return true;
  }

  // GET /api/admin/logs/export → CSV export for current log filters.
  if (req.method === 'GET' && url.pathname === '/api/admin/logs/export') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const csv = analytics.exportLogsCsv(logFiltersFromUrl(url));
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="davidbondtv-activity-logs.csv"',
      'Cache-Control': 'no-store',
    });
    res.end(csv);
    return true;
  }

  // --- Community inbox (admin) --- aggregate every comment across all videos.
  // GET /api/admin/community?q=&video=&author=&sort=&limit=&offset=
  if (req.method === 'GET' && url.pathname === '/api/admin/community') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    try {
      const store = readAllComments(COMMENTS_FILE);
      // video id -> { title, thumb } for the context column + filter dropdown.
      const vmeta = new Map();
      for (const v of listManifest()) vmeta.set(v.id, { id: v.id, title: v.title || v.id, thumb: v.thumb || null });

      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const videoFilter = url.searchParams.get('video') || '';
      const author = url.searchParams.get('author') || 'all';
      const sort = url.searchParams.get('sort') === 'old' ? 'old' : 'new';
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

      // Flatten + enrich with live author status and video context.
      let all = [];
      const summary = { total: 0, registered: 0, anon: 0, withGif: 0, filtered: 0 };
      const videosWithComments = [];
      for (const [vid, list] of Object.entries(store)) {
        if (!Array.isArray(list) || !list.length) continue;
        const vc = vmeta.get(vid) || { id: vid, title: vid, thumb: null };
        videosWithComments.push({ id: vid, title: vc.title, count: list.length });
        for (const c of list) {
          const u = c.username ? accounts.store.getByUsername(c.username) : null;
          const isMember = !!(u && hasActiveMembership(u));
          const isAdmin = !!(u && Array.isArray(u.roles) && u.roles.includes('admin'));
          summary.total += 1;
          if (c.username) summary.registered += 1; else summary.anon += 1;
          if (c.gifUrl) summary.withGif += 1;
          if (c.moderation && c.moderation.shadow) summary.filtered += 1;
          all.push({
            id: c.id, video: vc, name: c.name || 'Anonymous', username: c.username || null,
            userId: c.userId || null, text: c.text || '', ts: c.ts || 0,
            avatar: c.avatar || null, gifUrl: c.gifUrl || null, country: c.country || null,
            visitorId: c.visitorId || null,
            moderation: c.moderation || null,
            isMember, isAdmin,
          });
        }
      }

      // Filters.
      if (videoFilter) all = all.filter((c) => c.video.id === videoFilter);
      if (author === 'registered') all = all.filter((c) => c.username);
      else if (author === 'anon') all = all.filter((c) => !c.username);
      else if (author === 'member') all = all.filter((c) => c.isMember);
      else if (author === 'admin') all = all.filter((c) => c.isAdmin);
      else if (author === 'filtered') all = all.filter((c) => c.moderation && c.moderation.shadow);
      if (q) all = all.filter((c) => c.text.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q) || (c.username || '').toLowerCase().includes(q));

      all.sort((a, b) => (sort === 'old' ? a.ts - b.ts : b.ts - a.ts));
      const matched = all.length;
      const page = all.slice(offset, offset + limit);
      videosWithComments.sort((a, b) => b.count - a.count);

      sendJson(res, 200, { comments: page, matched, summary, videos: videosWithComments });
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/admin/visitors/')) {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const visitorId = decodeURIComponent(url.pathname.slice('/api/admin/visitors/'.length));
    const comments = allCommentsWithContext();
    const profile = analytics.getVisitorProfile(visitorId, { comments });
    if (!profile) { sendJson(res, 404, { error: 'Visitor not found' }); return true; }
    await enrichProfileLocation(profile);
    sendJson(res, 200, { profile, generatedAt: Date.now() });
    return true;
  }

  if (url.pathname === '/api/admin/comment-filters' || url.pathname.startsWith('/api/admin/comment-filters/')) {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const id = url.pathname.startsWith('/api/admin/comment-filters/')
      ? decodeURIComponent(url.pathname.slice('/api/admin/comment-filters/'.length))
      : '';
    if (req.method === 'GET' && url.pathname === '/api/admin/comment-filters') {
      sendJson(res, 200, { filters: commentFilters.list() });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/comment-filters') {
      try {
        const raw = await readBody(req, 8192);
        let body; try { body = JSON.parse(raw); } catch { body = null; }
        const result = commentFilters.add(body && body.phrase);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch { sendJson(res, 500, { error: 'Server error' }); }
      return true;
    }
    if (req.method === 'POST' && id) {
      try {
        const raw = await readBody(req, 8192);
        let body; try { body = JSON.parse(raw); } catch { body = null; }
        const result = commentFilters.update(id, body || {});
        sendJson(res, result.ok ? 200 : 404, result);
      } catch { sendJson(res, 500, { error: 'Server error' }); }
      return true;
    }
    if (req.method === 'DELETE' && id) {
      const result = commentFilters.remove(id);
      sendJson(res, result.ok ? 200 : 404, result);
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/admin/comments/') && url.pathname.endsWith('/visitor')) {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const commentId = decodeURIComponent(url.pathname.slice('/api/admin/comments/'.length, -'/visitor'.length));
    const comments = allCommentsWithContext();
    const comment = comments.find((c) => c.id === commentId);
    if (!comment) { sendJson(res, 404, { error: 'Comment not found' }); return true; }
    const visitorId = comment.visitorId || (comment.analytics && (comment.analytics.visitorId || comment.analytics.deviceId));
    if (!visitorId) { sendJson(res, 404, { error: 'No visitor profile for this comment' }); return true; }
    const profile = analytics.getVisitorProfile(visitorId, { comments });
    await enrichProfileLocation(profile);
    sendJson(res, 200, { comment, profile, generatedAt: Date.now() });
    return true;
  }

  // POST /api/admin/community/reply — post an admin reply (@mention) on a video.
  if (req.method === 'POST' && url.pathname === '/api/admin/community/reply') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    try {
      const admin = accounts.currentUser(req);
      const raw = await readBody(req, 8192);
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body || !body.video) { sendJson(res, 400, { error: 'Invalid request' }); return true; }
      const mention = body.to ? `@${String(body.to).replace(/\s+/g, '')} ` : '';
      const validation = validateComment({ name: admin.username, anonymous: false, text: `${mention}${body.text || ''}` });
      if (!validation.ok) { sendJson(res, 400, { error: validation.error }); return true; }
      const stored = await addComment(COMMENTS_FILE, body.video, {
        name: admin.username,
        text: validation.value.text,
        userId: admin.id,
        username: admin.username,
        admin: true,
        avatar: avatarUrl(admin.avatar, admin.username),
      });
      sendJson(res, 200, { ok: true, comment: stored });
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // --- User management (admin) --- /api/admin/users[/<id>[/password|block|unblock]]
  if (url.pathname === '/api/admin/users' || url.pathname.startsWith('/api/admin/users/')) {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const rest = url.pathname.slice('/api/admin/users'.length).replace(/^\//, '');
    const [userId, action] = rest.split('/');

    // GET list — ?filter=verified|unverified|all (default verified). Unverified
    // accounts are pending/fake signups; the owner can review and purge them.
    if (req.method === 'GET' && !userId) {
      const ustats = analytics.getAllUserStats();
      const blockedIds = new Set(geoGate.getRules().blockedUserIds);
      const all = accounts.store.listAll();
      const verifiedCount = all.filter((u) => u.verified).length;
      const unverifiedCount = all.length - verifiedCount;
      const filter = url.searchParams.get('filter') || 'verified';
      const picked = filter === 'all' ? all
        : filter === 'unverified' ? all.filter((u) => !u.verified)
          : all.filter((u) => u.verified);
      const users = picked.map((u) => {
        const s = ustats[u.id] || {};
        return {
          id: u.id, username: u.username, email: u.email,
          country: s.lastCountry || null,
          lastIp: (s.ips && s.ips[0]) || null,
          subscribed: hasActiveMembership(u),
          videosWatched: s.byVideo ? Object.keys(s.byVideo).length : 0,
          minutesWatched: Math.round((s.totalSeconds || 0) / 60),
          lastSeen: s.lastSeen || null,
          blocked: blockedIds.has(u.id),
          verified: u.verified, createdAt: u.createdAt,
        };
      });
      // `hiddenUnverified` kept for backward-compat with older clients.
      sendJson(res, 200, { users, filter, verifiedCount, unverifiedCount, hiddenUnverified: unverifiedCount });
      return true;
    }

    const u = userId ? accounts.store.getById(userId) : null;
    if (!u) { sendJson(res, 404, { error: 'User not found' }); return true; }

    // GET detail
    if (req.method === 'GET' && !action) {
      const s = analytics.getUserStats(userId) || {};
      const titles = manifestTitleMap();
      const history = Object.entries(s.byVideo || {})
        .map(([vid, secs]) => ({ id: vid, title: titles[vid] || vid, minutes: Math.round(secs / 60), seconds: Math.round(secs) }))
        .sort((a, b) => b.seconds - a.seconds);
      sendJson(res, 200, {
        user: { ...adminUser(u), avatarUrl: avatarUrl(u.avatar, u.username || u.email) },
        subscribed: hasActiveMembership(u),
        stats: {
          minutes: Math.round((s.totalSeconds || 0) / 60),
          hours: Math.round((s.totalSeconds || 0) / 360) / 10,
          videosWatched: history.length,
          views: s.views || 0,
          lastCountry: s.lastCountry || null,
          lastSeen: s.lastSeen || null,
          ips: s.ips || [],
          devices: s.devices || [],
        },
        history,
        activity: analytics.queryLogs({ userId, limit: 30 }).events.map((e) => decorateLogEvent(e, titles, userNameMap())),
        blocked: new Set(geoGate.getRules().blockedUserIds).has(userId),
      });
      return true;
    }

    // POST password reset
    if (req.method === 'POST' && action === 'password') {
      try {
        const raw = await readBody(req, 4096);
        let body; try { body = JSON.parse(raw); } catch { body = null; }
        const next = body && body.newPassword;
        if (typeof next !== 'string' || next.length < 4) { sendJson(res, 400, { error: 'Password must be at least 4 characters.' }); return true; }
        await accounts.store.updateUser(userId, { passwordHash: hashPassword(next), securityStamp: crypto.randomBytes(16).toString('hex') });
        sendJson(res, 200, { ok: true }); // securityStamp rotation kills their active sessions
      } catch { sendJson(res, 500, { error: 'Server error' }); }
      return true;
    }

    // POST block / unblock
    if (req.method === 'POST' && (action === 'block' || action === 'unblock')) {
      const admin = accounts.currentUser(req);
      await (action === 'block' ? geoGate.blockUser(userId) : geoGate.unblockUser(userId));
      analytics.recordActivity(`admin.user.${action}`, {
        userId, username: u.username || u.email || u.id,
        ip: ctx.ip, cc: ctx.country, geo: ctx.geo, device: ctx.device,
        meta: { by: admin ? admin.id : null },
      });
      sendJson(res, 200, { ok: true, blocked: action === 'block' });
      return true;
    }

    // POST grant / revoke — manual comp membership (admin override, no payment).
    if (req.method === 'POST' && (action === 'grant' || action === 'revoke')) {
      const admin = accounts.currentUser(req);
      if (action === 'grant') {
        const membership = {
          provider: 'admin', status: 'active', interval: null,
          currentPeriodEnd: null, cancelAtPeriodEnd: false,
          grantedBy: admin ? admin.id : null, updatedAt: Date.now(),
          // Preserve an existing "member since" across re-grants.
          since: (u.membership && typeof u.membership.since === 'number') ? u.membership.since : Date.now(),
        };
        await accounts.store.updateUser(userId, { membership, hasPurchased: true });
        await paymentsStore.addTxn(userId, { kind: 'admin.grant', ts: Date.now(), by: admin ? admin.id : null });
        analytics.recordActivity('admin.membership.grant', {
          userId, username: u.username || u.email || u.id,
          ip: ctx.ip, cc: ctx.country, geo: ctx.geo, device: ctx.device,
          meta: { by: admin ? admin.id : null },
        });
        // Let the user know — in-app bell + email.
        addAccountNotification(userId, {
          title: 'Membership activated 🎉',
          body: 'You now have full access to all exclusive videos.',
          link: '/account.html',
        }).catch(() => {});
        if (u.email) sendMembershipGrantedEmail(u.email, `${BASE_URL}/videos`);
        sendJson(res, 200, { ok: true, subscribed: true });
        return true;
      }
      await accounts.store.updateUser(userId, { membership: null, hasPurchased: false });
      await paymentsStore.addTxn(userId, { kind: 'admin.revoke', ts: Date.now(), by: admin ? admin.id : null });
      analytics.recordActivity('admin.membership.revoke', {
        userId, username: u.username || u.email || u.id,
        ip: ctx.ip, cc: ctx.country, geo: ctx.geo, device: ctx.device,
        meta: { by: admin ? admin.id : null },
      });
      sendJson(res, 200, { ok: true, subscribed: false });
      return true;
    }

    // POST delete — permanently remove the account. Analytics rollups + payment
    // history are intentionally left intact; they're historical/financial records
    // and simply no longer resolve to a live user.
    if (req.method === 'POST' && action === 'delete') {
      const result = await accounts.store.deleteUser(userId);
      if (!result.ok) { sendJson(res, 404, { error: 'User not found' }); return true; }
      // Cross-store cleanup: drop any geo-block rule.
      await geoGate.unblockUser(userId).catch(() => {});
      analytics.recordActivity('admin.user.delete', {
        userId, username: u.username || u.email || u.id,
        ip: ctx.ip, cc: ctx.country, geo: ctx.geo, device: ctx.device,
      });
      sendJson(res, 200, { ok: true, deleted: true });
      return true;
    }

    // POST product — grant/revoke access to a specific product (course/bundle/
    // digital), independent of membership. Body: { productId, op:'grant'|'revoke' }.
    // An admin grant mirrors the Stripe purchase entitlement shape with
    // provider:'admin', so playback's ownership check treats it identically.
    if (req.method === 'POST' && action === 'product') {
      const admin = accounts.currentUser(req);
      let body; try { body = JSON.parse(await readBody(req, 4096)); } catch { body = null; }
      const productId = body && typeof body.productId === 'string' ? body.productId : '';
      const op = body && body.op === 'revoke' ? 'revoke' : 'grant';
      const product = productId ? products.getById(productId) : null;
      if (!product) { sendJson(res, 404, { error: 'Product not found.' }); return true; }

      const owned = Array.isArray(u.products) ? u.products.slice() : [];
      if (op === 'grant') {
        if (!owned.some((p) => p && p.productId === productId)) {
          owned.push({ productId, provider: 'admin', grantedBy: admin ? admin.id : null, purchasedAt: Date.now() });
          await accounts.store.updateUser(userId, { products: owned });
          await paymentsStore.addTxn(userId, { kind: 'admin.product.grant', ts: Date.now(), productId, by: admin ? admin.id : null });
          analytics.recordActivity('admin.product.grant', {
            userId, username: u.username || u.email || u.id,
            videoTitle: product.name,
            ip: ctx.ip, cc: ctx.country, geo: ctx.geo, device: ctx.device,
            meta: { by: admin ? admin.id : null, productId },
          });
          addAccountNotification(userId, {
            title: `Access granted: ${product.name} 🎉`,
            body: 'It’s now unlocked in your library.',
            link: product.slug ? `/course.html?slug=${encodeURIComponent(product.slug)}` : '/account.html',
          }).catch(() => {});
          if (u.email) sendProductGrantedEmail(u.email, product.name, `${BASE_URL}/`);
        }
        sendJson(res, 200, { ok: true, owns: true });
        return true;
      }
      // revoke: drop every entitlement for this product id.
      const next = owned.filter((p) => !(p && p.productId === productId));
      await accounts.store.updateUser(userId, { products: next });
      await paymentsStore.addTxn(userId, { kind: 'admin.product.revoke', ts: Date.now(), productId, by: admin ? admin.id : null });
      analytics.recordActivity('admin.product.revoke', {
        userId, username: u.username || u.email || u.id,
        videoTitle: product.name,
        ip: ctx.ip, cc: ctx.country, geo: ctx.geo, device: ctx.device,
        meta: { by: admin ? admin.id : null, productId },
      });
      sendJson(res, 200, { ok: true, owns: false });
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  // POST /api/admin/upload?name=<file>  (raw video body) → { jobId, manifestId }
  if (req.method === 'POST' && url.pathname === '/api/admin/upload') {
    if (!isAdminReq(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const name = url.searchParams.get('name') || '';
    if (!acceptableUpload(name, req.headers['content-type'])) {
      sendJson(res, 415, { error: 'Only video files (.mp4/.mov/.m4v) are accepted.' });
      return true;
    }
    const visibility = url.searchParams.get('visibility') === 'premium' ? 'premium' : 'free';
    const blur = url.searchParams.get('blur') || '';
    const catParam = url.searchParams.get('category') || '';
    const category = categories.has(catParam) ? catParam : ''; // only accept known slugs
    // Optional scheduled-release timestamp (ms). Only honoured when it's a sane
    // future time; anything else means "publish as soon as it's processed".
    const pa = Number(url.searchParams.get('publishAt'));
    const MAX_SCHEDULE_MS = 365 * 24 * 60 * 60 * 1000; // a year out, as a sanity cap
    const publishAt = Number.isFinite(pa) && pa > Date.now() && pa < Date.now() + MAX_SCHEDULE_MS ? pa : 0;
    await streamUpload(req, res, name, visibility, blur, category, publishAt);
    return true;
  }

  // --- Resumable chunked upload (preferred path; single-shot above kept as a
  // fallback). Flow: init → chunk×N → complete. status enables resume; abort
  // cleans up. Each chunk is small so it never trips Node's requestTimeout. ---
  if (req.method === 'POST' && url.pathname === '/api/admin/upload/init') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    let body; try { body = JSON.parse(await readBody(req, 8192)); } catch { body = null; }
    const name = body && typeof body.name === 'string' ? body.name : '';
    const size = body ? Number(body.size) : NaN;
    if (!name || !Number.isFinite(size)) { sendJson(res, 400, { error: 'Invalid request.' }); return true; }
    if (!acceptableUpload(name, body.type)) {
      sendJson(res, 415, { error: 'Only video files (.mp4/.mov/.m4v) are accepted.' }); return true;
    }
    if (size <= 0) { sendJson(res, 400, { error: 'That file is empty.' }); return true; }
    if (size > UPLOAD_MAX_BYTES) { sendJson(res, 413, { error: 'File too large.' }); return true; }
    const visibility = body.visibility === 'premium' ? 'premium' : 'free';
    const blur = typeof body.blur === 'string' ? body.blur : '';
    const catParam = typeof body.category === 'string' ? body.category : '';
    const category = categories.has(catParam) ? catParam : '';
    const pa = Number(body.publishAt);
    const publishAt = Number.isFinite(pa) && pa > Date.now() && pa < Date.now() + UPLOAD_SCHEDULE_MAX_MS ? pa : 0;
    const { id, savedPath, partPath } = newUploadTarget(name);
    await fsp.unlink(partPath).catch(() => {}); // clear any stale .part for this id
    // Pre-allocate the .part file so parallel chunks can do positional writes.
    const fh = await fsp.open(partPath, 'w');
    await fh.truncate(size);
    await fh.close();
    uploads.createSession(id, { partPath, savedPath, name, size, visibility, blur, category, publishAt });
    console.log(`[upload] INIT id=${id} name="${name}" size=${(size / 1e6).toFixed(1)}MB visibility=${visibility}`);
    sendJson(res, 200, { uploadId: id, offset: 0, chunkSize: UPLOAD_CHUNK_SIZE });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/upload/status') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const session = uploads.getSession(url.searchParams.get('id') || '');
    if (!session) { sendJson(res, 404, { error: 'Upload session not found — start the upload again.' }); return true; }
    sendJson(res, 200, { offset: uploads.contiguousBytes(session), received: session.received, size: session.size });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/upload/chunk') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const id = url.searchParams.get('id') || '';
    const offset = Number(url.searchParams.get('offset'));
    const session = uploads.getSession(id);
    const declaredLen = Number(req.headers['content-length']) || 0;
    const check = uploads.validateChunk(session, offset, declaredLen, UPLOAD_MAX_BYTES);
    if (!check.ok) {
      try { req.resume(); } catch { /* drain */ }
      console.error(`[upload] chunk REJECT ${check.status} id=${id} offset=${offset} (${check.error})`);
      sendJson(res, check.status, { error: check.error, expected: check.expected });
      return true;
    }
    // Already received (idempotent retry) — skip the write.
    if (check.skip) {
      uploads.touch(session);
      try { req.resume(); } catch { /* drain */ }
      sendJson(res, 200, { offset: session.received, received: session.received });
      return true;
    }
    const buf = await readRawBody(req, declaredLen + 1024); // small slack over declared length
    if (buf === null) {
      console.error(`[upload] chunk FAIL id=${id} offset=${offset}: body read error/overflow`);
      sendJson(res, 500, { error: 'Could not receive that chunk — Retry to resume.' });
      return true;
    }
    try {
      // Positional write — parallel chunks write to different offsets safely.
      const fh = await fsp.open(session.partPath, 'r+');
      await fh.write(buf, 0, buf.length, offset);
      await fh.close();
      uploads.addRange(session, offset, offset + buf.length);
      uploads.touch(session);
      sendJson(res, 200, { offset: session.received, received: session.received });
    } catch (err) {
      console.error(`[upload] chunk FAIL id=${id} offset=${offset}: ${(err && (err.code || err.message)) || 'error'}`);
      sendJson(res, 500, { error: 'Could not save that chunk — Retry to resume.' });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/upload/complete') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const id = url.searchParams.get('id') || '';
    const session = uploads.getSession(id);
    const check = uploads.validateComplete(session);
    if (!check.ok) { sendJson(res, check.status, { error: check.error, expected: check.expected }); return true; }
    try {
      await fsp.rename(session.partPath, session.savedPath);
      // Duplicate detection: fingerprint the completed file and check against manifest.
      const dupCheck = await checkDuplicate(session.savedPath, session.size);
      if (dupCheck.duplicate) {
        await fsp.unlink(session.savedPath).catch(() => {});
        uploads.deleteSession(id);
        sendJson(res, 409, {
          error: `Duplicate — this video matches "${dupCheck.existingTitle}" already in your library.`,
          existingId: dupCheck.existingId,
        });
        return true;
      }
      const { jobId, manifestId } = enqueue(session.savedPath, session.name, {
        visibility: session.visibility, blur: session.blur,
        category: session.category, publishAt: session.publishAt,
      });
      uploads.deleteSession(id);
      console.log(`[upload] COMPLETE id=${id} ${(session.size / 1e6).toFixed(1)}MB → jobId=${jobId} manifestId=${manifestId}`);
      sendJson(res, 202, { ok: true, jobId, manifestId });
    } catch (err) {
      console.error(`[upload] complete FAIL id=${id}: ${(err && (err.code || err.message)) || 'error'}`);
      sendJson(res, 500, { error: 'Could not finalize the upload — Retry to resume.' });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/upload/abort') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const id = url.searchParams.get('id') || '';
    const session = uploads.getSession(id);
    if (session) {
      await fsp.unlink(session.partPath).catch(() => {});
      uploads.deleteSession(id);
      console.log(`[upload] ABORT id=${id}`);
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  // Categories: public list (GET) + admin add/rename/remove (POST).
  if (url.pathname === '/api/categories' && req.method === 'GET') {
    sendJson(res, 200, { categories: categories.list() });
    return true;
  }
  if (url.pathname === '/api/admin/categories') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    if (req.method === 'GET') { sendJson(res, 200, { categories: categories.list() }); return true; }
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req, 8192);
        let body; try { body = JSON.parse(raw); } catch { body = null; }
        if (!body || !body.action) { sendJson(res, 400, { error: 'Invalid request' }); return true; }
        let result;
        if (body.action === 'add') {
          result = categories.add(body.name, body.flag);
          if (result.ok && body.visual) result = categories.setVisual(result.category.slug, body.visual);
        } else if (body.action === 'rename') result = categories.rename(body.slug, body.name);
        else if (body.action === 'setflag') result = categories.setFlag(body.slug, body.flag);
        else if (body.action === 'seticon') result = categories.setIcon(body.slug, body.icon);
        else if (body.action === 'setvisual') result = categories.setVisual(body.slug, body.visual);
        else if (body.action === 'remove') result = categories.remove(body.slug);
        else result = { ok: false, error: 'Unknown action.' };
        sendJson(res, result.ok ? 200 : 400, { ...result, categories: categories.list() });
      } catch { sendJson(res, 500, { error: 'Server error' }); }
      return true;
    }
  }

  // Telegram Admin Config API
  if (url.pathname === '/api/god/telegram/config') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    if (req.method === 'GET') {
      sendJson(res, 200, {
        config: {
          TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
          TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME || '',
          TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
          TELEGRAM_GROUP_CHAT_ID: process.env.TELEGRAM_GROUP_CHAT_ID || '',
          TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET || '',
        }
      });
      return true;
    } else if (req.method === 'POST') {
      try {
        const raw = await readBody(req, 8192);
        let body; try { body = JSON.parse(raw); } catch { body = null; }
        if (!body) { sendJson(res, 400, { error: 'Invalid request' }); return true; }

        const envPath = path.join(__dirname, '.env');
        let envRaw = '';
        try { envRaw = await fsp.readFile(envPath, 'utf8'); } catch { /* ignore */ }
        
        const keys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_CHAT_ID', 'TELEGRAM_GROUP_CHAT_ID', 'TELEGRAM_WEBHOOK_SECRET'];
        for (const k of keys) {
          if (typeof body[k] === 'string') {
            process.env[k] = body[k]; // Update process.env too
            const re = new RegExp(`^${k}=.*$`, 'm');
            if (re.test(envRaw)) {
              envRaw = envRaw.replace(re, `${k}=${body[k]}`);
            } else {
              envRaw += `\n${k}=${body[k]}`;
            }
          }
        }
        envRaw = envRaw.trim() + '\n';
        await fsp.writeFile(envPath, envRaw);
        
        sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error('Error saving telegram config:', err);
        sendJson(res, 500, { error: 'Failed to save config' });
      }
      return true;
    }
  }

  // Telegram Admin Test API
  if (url.pathname === '/api/god/telegram/test' && req.method === 'POST') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    try {
      const tg = createTelegramNotifier({
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
      });
      if (!tg.configured) {
        sendJson(res, 400, { error: 'Bot token or chat ID is missing in configuration.' });
        return true;
      }
      await tg._test.sendMessage('🤖 <b>Test Message</b>\nYour Telegram bot configuration is working correctly!');
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error('Error testing telegram bot:', err);
      sendJson(res, 500, { error: 'Failed to test bot' });
    }
    return true;
  }

  // Admin coupon management: /api/admin/coupons[/<id>[/redemptions]]
  if (url.pathname === '/api/admin/coupons' || url.pathname.startsWith('/api/admin/coupons/')) {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const rest = url.pathname.slice('/api/admin/coupons'.length).replace(/^\//, '');
    const [couponId, action] = rest.split('/');

    if (req.method === 'GET' && !couponId) {
      sendJson(res, 200, { coupons: coupons.listWithStats() });
      return true;
    }
    if (req.method === 'POST' && !couponId) {
      try {
        const raw = await readBody(req, 8192);
        let body; try { body = JSON.parse(raw); } catch { body = null; }
        if (!body) { sendJson(res, 400, { error: 'Invalid request' }); return true; }
        const result = coupons.create(body);
        sendJson(res, result.ok ? 200 : 400, { ...result, coupons: coupons.listWithStats() });
      } catch { sendJson(res, 500, { error: 'Server error' }); }
      return true;
    }

    const existing = couponId ? coupons.getById(couponId) : null;
    if (!existing) { sendJson(res, 404, { error: 'Coupon not found' }); return true; }

    if (req.method === 'GET' && action === 'redemptions') {
      sendJson(res, 200, {
        coupon: existing,
        stats: coupons.usageStats(couponId),
        redemptions: coupons.listRedemptions(couponId),
      });
      return true;
    }
    if ((req.method === 'PATCH' || req.method === 'POST') && !action) {
      try {
        const raw = await readBody(req, 8192);
        let body; try { body = JSON.parse(raw); } catch { body = null; }
        if (!body) { sendJson(res, 400, { error: 'Invalid request' }); return true; }
        const result = coupons.update(couponId, body);
        sendJson(res, result.ok ? 200 : 400, { ...result, coupons: coupons.listWithStats() });
      } catch { sendJson(res, 500, { error: 'Server error' }); }
      return true;
    }
    if (req.method === 'DELETE' && !action) {
      const result = coupons.remove(couponId);
      sendJson(res, result.ok ? 200 : 404, { ...result, coupons: coupons.listWithStats() });
      return true;
    }
  }

  // Products / courses: public storefront list + per-slug lookup.
  if (url.pathname === '/api/products' && req.method === 'GET') {
    sendJson(res, 200, { products: products.listPublished().map(products.publicView) });
    return true;
  }
  if (url.pathname.startsWith('/api/products/') && req.method === 'GET') {
    const slug = decodeURIComponent(url.pathname.slice('/api/products/'.length));
    const p = products.getBySlug(slug);
    if (!p || !p.published) { sendJson(res, 404, { error: 'Not found' }); return true; }
    sendJson(res, 200, { product: products.publicView(p) });
    return true;
  }

  // Admin product management: /api/admin/products[/<id>[/videos|branding|publish|asset]]
  if (url.pathname === '/api/admin/products' || url.pathname.startsWith('/api/admin/products/')) {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const rest = url.pathname.slice('/api/admin/products'.length).replace(/^\//, '');
    const [productId, action] = rest.split('/');

    // GET full list (incl. unpublished) for the admin grid.
    if (req.method === 'GET' && !productId) { sendJson(res, 200, { products: products.list() }); return true; }

    // POST create.
    if (req.method === 'POST' && !productId) {
      try {
        const raw = await readBody(req, 16384);
        let body; try { body = JSON.parse(raw); } catch { body = null; }
        if (!body) { sendJson(res, 400, { error: 'Invalid request' }); return true; }
        const result = products.add(body);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch { sendJson(res, 500, { error: 'Server error' }); }
      return true;
    }

    const existing = productId ? products.getById(productId) : null;
    if (!existing) { sendJson(res, 404, { error: 'Product not found' }); return true; }

    // GET one.
    if (req.method === 'GET' && !action) { sendJson(res, 200, { product: existing }); return true; }

    // DELETE.
    if (req.method === 'DELETE' && !action) {
      const result = products.remove(productId);
      sendJson(res, result.ok ? 200 : 404, result);
      return true;
    }

    // POST asset upload (logo/bg) — raw image body, streamed to content/product-assets.
    if (req.method === 'POST' && action === 'asset') {
      const kind = url.searchParams.get('kind') === 'bg' ? 'bg' : 'logo';
      const target = products.productAssetTarget(productId, kind, req.headers['content-type']);
      if (!target) { sendJson(res, 415, { error: 'Provide a PNG, JPEG or WEBP image.' }); return true; }
      await streamProductAsset(req, res, productId, target);
      return true;
    }

    // POST update / videos / branding / publish.
    if (req.method === 'POST' && (!action || action === 'videos' || action === 'branding' || action === 'publish')) {
      try {
        const raw = await readBody(req, 65536);
        let body; try { body = JSON.parse(raw); } catch { body = null; }
        if (!body) { sendJson(res, 400, { error: 'Invalid request' }); return true; }
        let result;
        if (action === 'videos') {
          const ids = Array.isArray(body.videoIds) ? body.videoIds.filter((v) => isKnownVideo(v)) : [];
          result = products.setVideos(productId, ids);
        } else if (action === 'branding') {
          result = products.setBranding(productId, body.branding || body);
        } else if (action === 'publish') {
          result = products.update(productId, { published: !!body.published });
        } else {
          result = products.update(productId, body);
        }
        sendJson(res, result.ok ? 200 : 400, result);
      } catch { sendJson(res, 500, { error: 'Server error' }); }
      return true;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  // Subscription pricing: admin reads/writes the membership price config. (Course
  // prices live per-product; see /api/admin/products.)
  if (url.pathname === '/api/admin/pricing') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    if (req.method === 'GET') { sendJson(res, 200, { config: pricing.getConfig() }); return true; }
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req, 8192);
        let body; try { body = JSON.parse(raw); } catch { body = null; }
        if (!body) { sendJson(res, 400, { error: 'Invalid request' }); return true; }
        const result = pricing.update(body);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch { sendJson(res, 500, { error: 'Server error' }); }
      return true;
    }
  }

  // POST /api/admin/bulk  { ids[], action } → delete/publish/unpublish/premium/free
  if (req.method === 'POST' && url.pathname === '/api/admin/bulk') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    try {
      const raw = await readBody(req, 65536);
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body) { sendJson(res, 400, { error: 'Invalid request' }); return true; }
      const result = await bulkAction(body.ids, body.action);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch { sendJson(res, 500, { error: 'Server error' }); }
    return true;
  }

  // --- Notifications (signed-in viewers only) ---
  // GET /api/notifications → { notifications, unread } for the current user.
  if (url.pathname === '/api/notifications' && req.method === 'GET') {
    const u = accounts.currentUser(req);
    if (!u) { sendJson(res, 401, { error: 'Sign in to see notifications.' }); return true; }
    // Only count notifications for videos that still exist and are published, so
    // deleted/unpublished videos can't inflate the badge.
    const liveVideos = listManifest().filter((v) => v.published !== false);
    const liveIds = new Set(liveVideos.map((v) => v.id));
    const feed = listNotifications(u.id, liveIds);
    const canViewPremium = isAdminReq(req) || hasActiveMembership(u);
    sendJson(res, 200, decorateNotificationsForViewer(feed, liveVideos, { canViewPremium }));
    return true;
  }
  // POST /api/notifications/seen → mark all current notifications as read.
  if (url.pathname === '/api/notifications/seen' && req.method === 'POST') {
    const u = accounts.currentUser(req);
    if (!u) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    await markNotificationsSeen(u.id);
    sendJson(res, 200, { ok: true });
    return true;
  }
  // POST /api/notifications/dismiss { id } → hide one notification for this user.
  if (url.pathname === '/api/notifications/dismiss' && req.method === 'POST') {
    const u = accounts.currentUser(req);
    if (!u) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    try {
      const raw = await readBody(req, 4096);
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      await dismissNotification(u.id, body && body.id);
      sendJson(res, 200, { ok: true });
    } catch { sendJson(res, 500, { error: 'Server error' }); }
    return true;
  }
  // POST /api/notifications/clear → dismiss all of this user's notifications.
  if (url.pathname === '/api/notifications/clear' && req.method === 'POST') {
    const u = accounts.currentUser(req);
    if (!u) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    await clearNotifications(u.id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // Public membership pricing + offer copy (prices, intro, offer headline/CTA),
  // edited from /god-pricing. Consumed by the paywall gate + browse modal
  // (offer-copy.js). Provider-neutral — replaces the former Stripe config route.
  if (req.method === 'GET' && url.pathname === '/api/membership/config') {
    sendJson(res, 200, pricing.publicConfig());
    return true;
  }

  // Self-hosted crypto payments (/api/pay/crypto/*). Public webhook (HMAC-signed
  // by the watcher) is reached before accounts; it reads the raw body to verify.
  if (await cryptoPayments.handle(req, res, url)) return true;

  // WHOP card payments (/api/pay/whop/*). Public webhook (Standard-Webhooks signed)
  // shares the pre-accounts slot like the Stripe/crypto webhooks.
  if (await whopPayments.handle(req, res, url)) return true;

  // Private Telegram group gate (/api/telegram/*). The bot webhook is session-less
  // (authenticated by ?token=), so it shares the pre-accounts slot; the link/status
  // routes resolve the session themselves via currentUser.
  if (await telegramAccess.handle(req, res, url)) return true;

  // User accounts + profiles (/api/auth/*, /api/profile/*, /api/users/*)
  if (await accounts.handle(req, res, url)) return true;

  return false; // not an API route
}

const THUMB_MAX_BYTES = 8 * 1024 * 1024; // 8 MB cap for a replacement thumbnail

/** Stream a raw image body to a video's thumbnail path, then patch the manifest. */
function streamThumb(req, res, id, target) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(target.dest);
    let total = 0;
    let aborted = false;
    const fail = (status, error) => {
      if (aborted) return;
      aborted = true;
      try { req.destroy(); } catch { /* ignore */ }
      out.destroy();
      fsp.unlink(target.dest).catch(() => {});
      sendJson(res, status, { error });
      resolve();
    };
    req.on('data', (chunk) => { total += chunk.length; if (total > THUMB_MAX_BYTES) fail(413, 'Image too large (max 8 MB).'); });
    req.on('error', () => fail(400, 'Upload interrupted.'));
    out.on('error', () => fail(500, 'Write failed.'));
    req.pipe(out);
    out.on('close', async () => {
      if (aborted) return;
      if (total === 0) { fail(400, 'Empty upload.'); return; }
      const result = await setThumb(id, target.url);
      sendJson(res, result.ok ? 200 : 404, result);
      resolve();
    });
  });
}

/** Stream a raw image body to a product's branding asset path, then patch the product. */
function streamProductAsset(req, res, id, target) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(target.dest);
    let total = 0;
    let aborted = false;
    const fail = (status, error) => {
      if (aborted) return;
      aborted = true;
      try { req.destroy(); } catch { /* ignore */ }
      out.destroy();
      fsp.unlink(target.dest).catch(() => {});
      sendJson(res, status, { error });
      resolve();
    };
    req.on('data', (chunk) => { total += chunk.length; if (total > THUMB_MAX_BYTES) fail(413, 'Image too large (max 8 MB).'); });
    req.on('error', () => fail(400, 'Upload interrupted.'));
    out.on('error', () => fail(500, 'Write failed.'));
    req.pipe(out);
    out.on('close', () => {
      if (aborted) return;
      if (total === 0) { fail(400, 'Empty upload.'); return; }
      const result = products.setBranding(id, { [target.field]: target.url });
      sendJson(res, result.ok ? 200 : 404, result);
      resolve();
    });
  });
}

/** Stream a raw request body to disk (bypassing readBody), then enqueue ingestion.
 *  Heavily logged ([upload] prefix) so 502s / interruptions can be diagnosed:
 *  every terminal path records the reason, elapsed time, and bytes received vs
 *  the Content-Length the client promised. */
function streamUpload(req, res, name, visibility = 'free', blur = '', category = '', publishAt = 0) {
  return new Promise((resolve) => {
    const { savedPath, partPath } = newUploadTarget(name);
    const out = fs.createWriteStream(partPath);
    let total = 0;
    let aborted = false;

    const t0 = Date.now();
    const expected = Number(req.headers['content-length']) || 0;
    const ip = clientIp(req);
    const mb = (n) => (n / 1e6).toFixed(1);
    const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
    const pct = () => (expected ? ` (${((total / expected) * 100).toFixed(0)}%)` : '');
    const got = () => `${mb(total)}MB${expected ? `/${mb(expected)}MB` : ''}${pct()}`;
    let nextLogAt = 256 * 1024 * 1024; // progress line roughly every 256 MB

    console.log(`[upload] START name="${name}" expected=${expected ? `${mb(expected)}MB` : 'unknown'} type=${req.headers['content-type'] || '?'} visibility=${visibility} ip=${ip}`);

    const fail = (status, error, detail) => {
      if (aborted) return;
      aborted = true;
      console.error(`[upload] FAIL ${status} "${error}"${detail ? ` [${detail}]` : ''} after ${secs()}s — received ${got()} name="${name}"`);
      try { req.destroy(); } catch { /* ignore */ }
      out.destroy();
      fsp.unlink(partPath).catch(() => {});
      sendJson(res, status, { error });
      resolve();
    };

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total >= nextLogAt) {
        const el = (Date.now() - t0) / 1000;
        console.log(`[upload] ..progress ${got()} · ${(total / 1e6 / Math.max(el, 0.001)).toFixed(1)}MB/s avg · ${el.toFixed(0)}s name="${name}"`);
        nextLogAt += 256 * 1024 * 1024;
      }
      if (total > UPLOAD_MAX_BYTES) fail(413, 'File too large.', `exceeded cap ${mb(UPLOAD_MAX_BYTES)}MB`);
    });
    out.on('error', (err) => fail(500, 'Write failed.', `disk write ${(err && (err.code || err.message)) || 'error'}`));
    req.on('error', (err) => fail(400, 'Upload interrupted.', `req ${(err && (err.code || err.message)) || 'error'}`));
    req.on('aborted', () => fail(400, 'Upload aborted.', 'req aborted — client/proxy closed the connection, or Node requestTimeout fired'));

    // Diagnostic for the 502 case: if the connection closes before the body is
    // fully received and we're at/near server.requestTimeout, Node killed the
    // request (nginx then surfaces a 502). req.complete is true only on a clean,
    // fully-read body, so this fires on premature closes that 'aborted' may miss.
    req.on('close', () => {
      if (!aborted && !req.complete) {
        console.error(`[upload] CLOSED before body complete after ${secs()}s — received ${got()}. Node requestTimeout=${server.requestTimeout}ms (a slow upload exceeding it is aborted → 502). name="${name}"`);
      }
    });

    req.pipe(out);

    out.on('close', () => {
      if (aborted) return;
      if (total === 0) { fail(400, 'Empty upload.', 'no bytes received'); return; }
      fsp.rename(partPath, savedPath)
        .then(() => {
          const { jobId, manifestId } = enqueue(savedPath, name, { visibility, blur, category, publishAt });
          console.log(`[upload] DONE name="${name}" ${got()} in ${secs()}s → jobId=${jobId} manifestId=${manifestId}`);
          sendJson(res, 202, { ok: true, jobId, manifestId });
          resolve();
        })
        .catch((err) => fail(500, 'Could not finalize upload.', `rename ${(err && (err.code || err.message)) || 'error'}`));
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // Force HTTPS (defense-in-depth behind Cloudflare/nginx). When the proxy
    // reports the original client spoke plain HTTP, 301 to the https:// URL so the
    // site never answers over an insecure channel. The header is absent for local
    // dev and direct-origin health checks, so those are left untouched.
    const fwdProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (fwdProto === 'http') {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (host) {
        res.writeHead(301, withSecurityHeaders({ Location: `https://${host}${req.url}` }));
        return res.end();
      }
    }

    // Derive IP / country / user / admin-bypass / bot once for this request.
    const ctx = buildRequestContext(req);

    // API routes take priority
    if (req.url.startsWith('/api/')) {
      const handled = await handleApi(req, res, ctx);
      if (handled) return;
    }

    // Geo-restriction gate: pages + media for non-admin, non-bypass visitors in
    // a blocked country/IP, or blocked users. Carve-outs (admin login, shell
    // assets, under-construction page) always pass so the owner can't lock out.
    const pathname = decodeURIComponent((req.url.split('?')[0]) || '/');
    const canonical = resolveCanonicalRedirect(req.url, { videos: listManifest().filter((v) => v.published !== false), products: products.listPublished() });
    if (canonical && canonical.location) {
      res.writeHead(canonical.status || 301, withSecurityHeaders({ Location: canonical.location }));
      return res.end();
    }
    if (isLegacyAdminRoute(pathname)) {
      res.writeHead(404, withSecurityHeaders());
      return res.end('Not found');
    }
    if (!isGeoCarveOut(pathname)) {
      const decision = geoGate.evaluate(ctx);
      if (decision.blocked) {
        analytics.recordBlocked(ctx, decision.reason);
        return serveUnderConstruction(res);
      }
    }

    // Media backstop for /videos/<id>/* renditions (the player gate is the UX;
    // this is the enforcement — a direct URL is gated too). Precedence:
    //   admin                         → always allowed
    //   scheduled/unpublished (drip)  → admin-only (members can't pull early)
    //   course-assigned               → requires owning ANY product it's in
    //                                   (membership is irrelevant — courses are a
    //                                    separate purchase; ownership is binding)
    //   premium (not course-assigned) → requires an active member
    //   free, live                    → open
    const vmatch = pathname.match(/^\/videos\/([^/]+)\//); // pathname is already decoded
    if (vmatch) {
      const vid = vmatch[1];
      if (!canAccessVideo(ctx, vid)) {
        res.writeHead(403, withSecurityHeaders());
        return res.end('Forbidden');
      }
    }

    if (pathname.startsWith('/api/videos/') && pathname.endsWith('/playback')) {
      const vid = pathname.slice('/api/videos/'.length, -'/playback'.length);
      const entry = playbackVideoById(vid);
      if (!entry) {
        res.writeHead(404, withSecurityHeaders());
        return res.end('Not found');
      }
      if (!canAccessVideo(ctx, vid)) {
        res.writeHead(403, withSecurityHeaders());
        return res.end('Forbidden');
      }
      const vstats = analytics.getVideoStats(vid);
      const json = JSON.stringify({
        video: sanitizePlaybackVideo(entry),
        views: vstats ? (vstats.views || 0) : 0,
      });
      res.writeHead(200, withSecurityHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json),
        'Cache-Control': 'no-store',
      }));
      return res.end(json);
    }

    // Dynamic sitemap generation for crawlers
    if (pathname === '/sitemap.xml') {
      const xml = generateSitemap();
      res.writeHead(200, withSecurityHeaders({
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(xml),
        'Cache-Control': 'no-cache',
      }));
      return res.end(xml);
    }

    // Public view counts for the homepage grid: a compact { videoId: views } map
    // so each card can show its count without an analytics call per video.
    if (pathname === '/api/videos/views') {
      const all = analytics.getAllVideoStats();
      const map = {};
      for (const [id, s] of Object.entries(all)) map[id] = (s && s.views) || 0;
      const json = JSON.stringify(map);
      res.writeHead(200, withSecurityHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json),
        'Cache-Control': 'no-cache',
      }));
      return res.end(json);
    }

    // The manifest is a static file, but it must not leak scheduled-but-unreleased
    // titles/thumbs. Serve a filtered copy to non-admins (admins get the full list
    // so the upload/edit/manage pages still work).
    if (pathname === '/thumbs/videos.json') {
      const all = listManifest();
      const list = ctx.isAdmin ? all : all.filter((v) => v.published !== false).map(sanitizePublicVideo);
      const json = JSON.stringify(list);
      res.writeHead(200, withSecurityHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json),
        'Cache-Control': 'no-cache',
      }));
      return res.end(json);
    }
    // Static file serving (unchanged)
    const filePath = resolveFile(req.url);
    if (!filePath) {
      res.writeHead(403, withSecurityHeaders());
      return res.end('Forbidden');
    }

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      res.writeHead(404, withSecurityHeaders());
      return res.end('Not found');
    }
    if (stat.isDirectory()) {
      res.writeHead(404, withSecurityHeaders());
      return res.end('Not found');
    }

    const headers = {
      'Content-Type': contentType(filePath),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };

    // HTML pages: inject the version badge just before </body>. Read into memory
    // (pages are small) rather than streaming so we can rewrite the body.
    if (headers['Content-Type'].startsWith('text/html')) {
      let html = await fsp.readFile(filePath, 'utf8');
      html = injectMetaTags(html, req.url);
      // Inject visit-tracker on public pages only (not admin pages).
      const vtPath = new URL(req.url, 'http://x').pathname;
      if (!isLegacyAdminRoute(vtPath) && !isPrettyAdminRoute(vtPath) && html.includes('</head>')) {
        html = html.replace('</head>', '<script src="/js/visit-tracker.js" defer></script></head>');
        // GigaBrain first-party analytics (sidecar). Same public-only gate; loads
        // only when the sidecar origin is configured. data-base points at the
        // sidecar; the snippet posts events there as a no-preflight beacon.
        if (GIGABRAIN_PUBLIC_URL) {
          html = html.replace('</head>', `<script src="/js/gigabrain-analytics.js" data-base="${escapeHtml(GIGABRAIN_PUBLIC_URL)}" defer></script></head>`);
        }
      }
      // Cache-bust local CSS/JS by stamping the app version onto their URLs, so a
      // deploy can never leave a browser (or the Cloudflare edge) painting with a
      // stale stylesheet/script. Only touches root-relative .css/.js refs that
      // don't already carry a query string.
      html = addAssetVersion(html, APP_VERSION);
      html = html.includes('</body>')
        ? html.replace('</body>', `${VERSION_BADGE}</body>`)
        : html + VERSION_BADGE;
      const buf = Buffer.from(html, 'utf8');
      delete headers['Accept-Ranges'];
      headers['Content-Length'] = buf.length;
      res.writeHead(200, withSecurityHeaders(headers));
      return res.end(buf);
    }

    const range = parseRange(req.headers.range, stat.size);
    if (range && range.invalid) {
      res.writeHead(416, withSecurityHeaders({ 'Content-Range': `bytes */${stat.size}` }));
      return res.end();
    }

    if (range) {
      const { start, end } = range;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, withSecurityHeaders(headers));
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      headers['Content-Length'] = stat.size;
      res.writeHead(200, withSecurityHeaders(headers));
      fs.createReadStream(filePath).pipe(res);
    }
  } catch {
    res.writeHead(500, withSecurityHeaders());
    res.end('Server error');
  }
});

server.listen(PORT, async () => {
  // Seed the David Bond admin account on first boot; surface the password once.
  const seededPassword = adminAccount.ensureSeeded();
  if (seededPassword) {
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│  ADMIN ACCOUNT CREATED — SAVE THIS NOW (shown only once)     │');
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log(`│  Username: davidbond`);
    console.log(`│  Password: ${seededPassword}`);
    console.log(`│  Also written to: data/admin-credentials.txt`);
    console.log('└─────────────────────────────────────────────────────────────┘\n');
  }
  await seedAdminUser(); // ensure davidbond exists as a user with the admin role
  console.log(`▶  David Bond TV running at http://localhost:${PORT}`);
  console.log(`   admin uploads: ${adminConfigured(adminAccount) ? 'enabled' : 'DISABLED'} · ffmpeg: ${hasFfmpeg() ? 'ok' : 'MISSING'} · cloudflare: ${TRUST_CLOUDFLARE ? 'trusted' : 'off'}`);
  // Surface the effective HTTP timeouts. A slow upload that runs longer than
  // requestTimeout (Node default 300000ms = 5 min) is aborted by Node mid-body,
  // which the nginx proxy reports to the browser as a 502. See streamUpload logs.
  console.log(`   http timeouts (ms): requestTimeout=${server.requestTimeout} headersTimeout=${server.headersTimeout} keepAliveTimeout=${server.keepAliveTimeout} timeout=${server.timeout}`);
  await bootSweep(); // any interrupted "processing" entries → "failed"
  await releaseScheduled(); // publish any drips whose time passed while we were down
  await sweepRejected().catch(() => {}); // purge rejected videos past their grace period
  // Backfill "new video" notifications for already-published videos missing a
  // feed entry (idempotent) — covers videos pushed before the server-side
  // notification hook existed, so viewers finally get notified.
  try { const n = await backfillNotifications(); if (n) console.log(`   notifications: ensured feed entries for ${n} published video(s)`); }
  catch (e) { console.error('   notifications backfill failed:', e.message); }
  // Announce deploys (version/commit changed → owner bell + Telegram summary) vs
  // plain reboots (bell only). Best-effort; never blocks readiness.
  try {
    const r = await announceBoot({
      version: APP_VERSION,
      cwd: __dirname,
      stateFile: path.join(__dirname, 'data', 'boot-state.json'),
      notifyAdmins,
      sendTelegram: telegramNotifier.configured ? (t) => telegramNotifier.send(t) : null,
    });
    console.log(`   boot: ${r.kind}${r.kind === 'update' ? ` (from v${r.from}, ${r.commits} commit(s))` : ''}`);
  } catch (e) { console.error('   boot announce failed:', e.message); }
});

// Scheduled-release worker: publish due "slow-drip" videos (and notify viewers)
// roughly every minute. unref() so it never holds the process open.
setInterval(() => {
  releaseScheduled().catch(() => {});
  sweepRejected().catch(() => {}); // auto-delete rejected videos after their grace period
}, 60_000).unref();

// Telegram access worker: remove group members whose access has lapsed (no active
// membership and no owned products). Only runs when the gate is configured.
// unref() so it never holds the process open.
if (telegramAccess.configured) {
  setInterval(() => { telegramAccess.sweep().catch(() => {}); }, 60_000).unref();
}

// Reclaim disk from chunked uploads that stalled and were never finished:
// drop idle sessions and unlink their orphaned .part files. Runs every 30 min.
setInterval(() => {
  for (const s of uploads.sweepStale(UPLOAD_SESSION_IDLE_MS)) {
    fsp.unlink(s.partPath).catch(() => {});
    console.log(`[upload] swept stale session id=${s.id} (idle > ${UPLOAD_SESSION_IDLE_MS / 3600000}h)`);
  }
}, 30 * 60_000).unref();

// Persist in-memory analytics rollups on shutdown so nothing is lost.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { analytics.flush(true); } catch { /* ignore */ } process.exit(0); });
}
