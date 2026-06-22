import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { contentType, parseRange, sendJson, readBody, clientIp, withSecurityHeaders } from './lib/http-util.js';
import { createChallenge, verifyChallenge } from './lib/challenge.js';
import { createRateLimiter } from './lib/rate-limit.js';
import { validateComment, addComment, listComments, deleteComment, readAllComments } from './lib/comments-store.js';
import { getCounts, getUserVote, setVote } from './lib/reactions-store.js';
import { adminConfigured } from './lib/admin-auth.js';
import { createAdminAccount } from './lib/admin-account.js';
import { serializeCookie } from './lib/cookies.js';
import { hashPassword, verifyPassword } from './lib/password.js';
import { createGeoip } from './lib/geoip.js';
import { createAccounts } from './lib/accounts.js';
import { createTurnstile } from './lib/turnstile.js';
import { createTenor, isTenorGifUrl } from './lib/tenor.js';
import { createCommentGuard, DEFAULT_BANNED } from './lib/comment-guard.js';
import { adminUser } from './lib/users-store.js';
import { createPaymentsStore } from './lib/payments-store.js';
import { createStripePayments } from './lib/stripe-payments.js';
import { createTelegramNotifier } from './lib/telegram-bot.js';
import { hasActiveMembership } from './lib/membership.js';
import { avatarUrl } from './lib/avatars.js';
import {
  enqueue, getJob, listJobs, newUploadTarget, acceptableUpload, bootSweep, deleteVideo,
  editVideo, thumbTarget, setThumb, isKnownVideo, bulkAction, videoVisibility,
  releaseScheduled, videoPublic, listManifest,
} from './lib/ingest.mjs';
import {
  listForUser as listNotifications, markSeen as markNotificationsSeen,
  dismiss as dismissNotification, clearAll as clearNotifications,
} from './lib/notifications-store.js';
import { hasFfmpeg } from './lib/media.mjs';
import * as categories from './lib/categories.js';
import * as products from './lib/products.js';
import * as pricing from './lib/pricing.js';
import * as subscribers from './lib/subscribers.js';
import { createRequestContext } from './lib/request-context.mjs';
import { createAnalytics } from './lib/analytics-store.mjs';
import { createGeoGate } from './lib/geo-gate.mjs';
import { PUBLIC_DIR, MEDIA_DIR, MANIFEST, resolveAssetPath } from './lib/paths.js';

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
const VERSION_BADGE = `<div id="site-version" style="position:fixed;bottom:8px;right:10px;z-index:2147483000;`
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
const limiter = createRateLimiter(60_000, 3); // up to 3 comments/min per IP
// Comment anti-spam: per-account limits, duplicate/flood detection, link controls,
// banned-word blocklist. Extra blocked words can be added in data/comment-blocklist.json
// (a JSON array of strings) without a code change.
const commentBlocklist = (() => {
  try {
    const extra = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'comment-blocklist.json'), 'utf8'));
    return Array.isArray(extra) ? [...DEFAULT_BANNED, ...extra.filter((w) => typeof w === 'string')] : DEFAULT_BANNED;
  } catch { return DEFAULT_BANNED; }
})();
const commentGuard = createCommentGuard({ banned: commentBlocklist });
const recoverLimiter = createRateLimiter(60_000, 5); // 5 recovery attempts/min per IP
const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB cap
const COMMENTS_FILE = path.join(__dirname, 'data', 'comments.json');
const REACTIONS_FILE = path.join(__dirname, 'data', 'reactions.json');
const ADMIN_FILE = path.join(__dirname, 'data', 'admin.json');
const ADMIN_CREDS_FILE = path.join(__dirname, 'data', 'admin-credentials.txt');
const adminAccount = createAdminAccount({ filePath: ADMIN_FILE, credentialsFile: ADMIN_CREDS_FILE });
const COOKIE_SECURE = (process.env.BASE_URL || '').startsWith('https');

// --- User accounts + geo ---
// AUTH_SECRET signs session/verify/reset tokens. Set it to keep users logged in
// across restarts; otherwise a fresh random key logs everyone out on restart.
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
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
  turnstile,
  providers: oauthProviders,
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
});

// --- Payments (Stripe membership) ---
// All keys come from the environment; without them checkout/portal return 503
// and the rest of the app runs unchanged. The webhook must be publicly reachable
// at BASE_URL/api/pay/stripe/webhook (it is, behind nginx/Cloudflare in prod).
const PAYMENTS_FILE = path.join(__dirname, 'data', 'payments.json');
const paymentsStore = createPaymentsStore(PAYMENTS_FILE);
const telegramNotifier = createTelegramNotifier({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
});
const stripePayments = createStripePayments({
  store: accounts.store,
  currentUser: accounts.currentUser,
  paymentsStore,
  baseUrl: BASE_URL,
  secretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  priceMonthly: process.env.STRIPE_PRICE_MONTHLY,
  priceYearly: process.env.STRIPE_PRICE_YEARLY,
  products,
  pricing,
  telegramNotifier,
});

// --- analytics + per-request context ---
// Trust Cloudflare's CF-* headers only when the origin actually sits behind it.
const TRUST_CLOUDFLARE = process.env.TRUST_CLOUDFLARE === '1';
const analytics = createAnalytics({
  dir: path.join(__dirname, 'data', 'analytics'),
  rawRetentionDays: Number(process.env.ANALYTICS_RAW_DAYS) || 7,
});
const buildRequestContext = createRequestContext({
  geoip, accounts, trustCloudflare: TRUST_CLOUDFLARE,
});
const trackLimiter = createRateLimiter(60_000, 120); // generous: ~heartbeats from a few concurrent views
const GEO_RULES_FILE = path.join(__dirname, 'data', 'geo-rules.json');
const geoGate = createGeoGate(GEO_RULES_FILE);

/** Admin guard: the session-cookie user must carry the 'admin' role. */
function isAdminReq(req) {
  const u = accounts.currentUser(req);
  return !!(u && Array.isArray(u.roles) && u.roles.includes('admin'));
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
  if (pathname === '/god' || pathname === '/god.html' || pathname.startsWith('/god-')) return true;
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

function resolveFile(urlPath) {
  let pathname = decodeURIComponent(urlPath.split('?')[0]);
  if (pathname === '/') pathname = '/browse.html'; // homepage = the video grid
  if (pathname === '/watch') pathname = '/index.html'; // per-video watch page (?v=<id>)
  if (pathname === '/god') pathname = '/god.html'; // the admin backend lives at /god
  // Pretty URLs for the legal / policy pages (linked from the site footer).
  if (pathname === '/terms') pathname = '/terms.html';
  if (pathname === '/privacy') pathname = '/privacy.html';
  if (pathname === '/refunds') pathname = '/refunds.html';
  // Pretty public-profile URLs: /u/<username> all serve the profile page,
  // which reads the username from the path and fetches /api/users/<name>.
  if (pathname.startsWith('/u/')) pathname = '/profile.html';

  // Map onto the filesystem: /media/* → MEDIA_DIR, the content prefixes
  // (/thumbs,/previews,/videos,/storyboards) → CONTENT_DIR, everything else →
  // public/. Traversal guard lives in resolveAssetPath (returns null on escape).
  return resolveAssetPath(pathname);
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

  // User profiles
  try {
    const allUsers = accounts.store.listAll().filter((u) => u.profileComplete);
    for (const u of allUsers) {
      urls.push({
        loc: `${BASE_URL}/u/${encodeURIComponent(u.username)}`,
        changefreq: 'weekly',
        priority: '0.6',
      });
    }
  } catch (err) {
    console.error('Sitemap generator: failed to list users:', err);
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

  if (pathname === '/' || pathname === '/browse.html') {
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
  } else if (pathname.startsWith('/u/')) {
    const match = pathname.match(/^\/u\/([^/]+)/);
    if (match) {
      const username = match[1];
      const user = accounts.store.getByUsername(username);
      if (user) {
        title = `${user.username} — David Bond TV`;
        description = user.about || `Check out ${user.username}'s profile on David Bond TV.`;
        const avatar = avatarUrl(user.avatar, user.username);
        if (avatar && !avatar.startsWith('data:')) {
          ogImage = `${BASE_URL}${avatar}`;
        } else {
          ogImage = `${BASE_URL}/logo.jpg`;
        }
        ogUrl = `${BASE_URL}/u/${encodeURIComponent(user.username)}`;
        ogType = 'profile';
      } else {
        title = 'Profile Not Found — David Bond TV';
        description = "This user doesn't exist or hasn't finished setting up their profile.";
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
        analytics.record({
          t: Date.now(), video: body.v, viewId: body.vid,
          userId: ctx.user ? ctx.user.id : null, ip: ctx.ip, cc: ctx.country, dt: body.dt,
        });
      }
    } catch { /* never surface tracking errors to the client */ }
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
      // Hide comments from banned (blocked) users — banning an author also
      // removes their comments from view.
      const blockedIds = new Set(geoGate.getRules().blockedUserIds);
      // Derive the admin + member badges live from the author's CURRENT status,
      // overriding whatever was stored at post time — so a member badge appears
      // the moment they subscribe and disappears when they cancel/lapse, and an
      // ex-admin's old badge clears too.
      const comments = listComments(COMMENTS_FILE, video)
        .filter((c) => !(c.userId && blockedIds.has(c.userId)))
        .map((c) => {
          if (!c.username) return c;
          const u = accounts.store.getByUsername(c.username);
          const admin = !!(u && Array.isArray(u.roles) && u.roles.includes('admin'));
          const member = !!(u && hasActiveMembership(u));
          return { ...c, admin, member };
        });
      sendJson(res, 200, { comments });
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // POST /api/comments
  if (req.method === 'POST' && url.pathname === '/api/comments') {
    try {
      // 1. Rate limit
      const ip = clientIp(req);
      const rl = limiter.hit(ip);
      if (!rl.allowed) {
        sendJson(res, 429, {
          error: "You're posting too fast. Please wait a moment.",
          retryAfter: rl.retryAfter,
        });
        return true;
      }

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
        stored = await addComment(COMMENTS_FILE, video || 'bikinis', {
          name: user.username,
          text: validation.value.text,
          userId: user.id,
          username: user.username,
          admin: Array.isArray(user.roles) && user.roles.includes('admin'),
          avatar: avatarUrl(user.avatar, user.username),
          gifUrl,
          country,
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
        stored = await addComment(COMMENTS_FILE, video || 'bikinis', {
          name: validation.value.name,
          text: validation.value.text,
          avatarSeed: crypto.randomBytes(4).toString('hex'),
          gifUrl,
          country,
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

  // GET /api/admin/account → admin profile + security question (no hashes)
  if (req.method === 'GET' && url.pathname === '/api/admin/account') {
    const u = isAdminReq(req) ? accounts.currentUser(req) : null;
    if (!u) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    sendJson(res, 200, { account: { username: u.username, email: u.email, securityQuestion: adminAccount.getSecurityQuestion() } });
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

  // POST /api/admin/account/security  { password, question, answer }
  if (req.method === 'POST' && url.pathname === '/api/admin/account/security') {
    const u = isAdminReq(req) ? accounts.currentUser(req) : null;
    if (!u) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    try {
      const raw = await readBody(req, 4096);
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body || !verifyPassword(body.password, u.passwordHash)) {
        sendJson(res, 401, { error: 'Password is incorrect.' }); return true;
      }
      const result = adminAccount.setSecurityQuestion(body.question, body.answer);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch { sendJson(res, 500, { error: 'Server error' }); }
    return true;
  }

  // GET /api/admin/recover → { question }  (unauthenticated, rate-limited)
  if (req.method === 'GET' && url.pathname === '/api/admin/recover') {
    if (!recoverLimiter.hit(clientIp(req)).allowed) {
      sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });
      return true;
    }
    sendJson(res, 200, { question: adminAccount.getSecurityQuestion() });
    return true;
  }

  // POST /api/admin/recover  { answer, newPassword } → resets the admin password + signs in
  if (req.method === 'POST' && url.pathname === '/api/admin/recover') {
    if (!recoverLimiter.hit(clientIp(req)).allowed) {
      sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });
      return true;
    }
    try {
      const raw = await readBody(req, 4096);
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body || !adminAccount.verifySecurityAnswer(body.answer)) {
        sendJson(res, 401, { error: 'Incorrect answer.' }); return true;
      }
      if (typeof body.newPassword !== 'string' || body.newPassword.length < 4) {
        sendJson(res, 400, { error: 'Password must be at least 4 characters.' }); return true;
      }
      const adminU = accounts.store.getByUsername('davidbond');
      if (!adminU) { sendJson(res, 500, { error: 'Admin account missing.' }); return true; }
      await accounts.store.updateUser(adminU.id, {
        passwordHash: hashPassword(body.newPassword), securityStamp: crypto.randomBytes(16).toString('hex'),
      });
      accounts.establishSession(res, accounts.store.getById(adminU.id)); // log straight in
      sendJson(res, 200, { ok: true });
    } catch { sendJson(res, 500, { error: 'Server error' }); }
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
      sendJson(res, 200, { job: getJob(jobId), ffmpeg: hasFfmpeg() });
    } else {
      sendJson(res, 200, { jobs: listJobs(), ffmpeg: hasFfmpeg() });
    }
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


  // --- Analytics dashboards (admin) ---

  // GET /api/admin/analytics/overview → totals + top videos + countries + blocked.
  if (req.method === 'GET' && url.pathname === '/api/admin/analytics/overview') {
    if (!isAdminReq(req)) { sendJson(res, 401, { error: 'Unauthorized' }); return true; }
    const totals = analytics.getTotals();
    const vids = analytics.getAllVideoStats();
    const titles = manifestTitleMap();
    const topVideos = Object.entries(vids)
      .map(([id, s]) => ({ id, title: titles[id] || id, views: s.views, minutes: Math.round(s.totalSeconds / 60) }))
      .sort((a, b) => b.views - a.views).slice(0, 20);
    sendJson(res, 200, {
      totals: { views: totals.views, minutes: Math.round(totals.seconds / 60), hours: Math.round(totals.seconds / 360) / 10 },
      topVideos,
      countries: analytics.getCountryStats(),
      blocked: analytics.getBlockedStats(),
      userCount: accounts.store.listAll().length,
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
      const summary = { total: 0, registered: 0, anon: 0, withGif: 0 };
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
          all.push({
            id: c.id, video: vc, name: c.name || 'Anonymous', username: c.username || null,
            userId: c.userId || null, text: c.text || '', ts: c.ts || 0,
            avatar: c.avatar || null, gifUrl: c.gifUrl || null, country: c.country || null,
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

    // GET list
    if (req.method === 'GET' && !userId) {
      const ustats = analytics.getAllUserStats();
      const blockedIds = new Set(geoGate.getRules().blockedUserIds);
      const users = accounts.store.listAll().map((u) => {
        const s = ustats[u.id] || {};
        return {
          id: u.id, username: u.username, email: u.email,
          country: s.lastCountry || null,
          subscribed: hasActiveMembership(u),
          videosWatched: s.byVideo ? Object.keys(s.byVideo).length : 0,
          minutesWatched: Math.round((s.totalSeconds || 0) / 60),
          blocked: blockedIds.has(u.id),
          verified: u.verified, createdAt: u.createdAt,
        };
      });
      sendJson(res, 200, { users });
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
        },
        history,
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
      await (action === 'block' ? geoGate.blockUser(userId) : geoGate.unblockUser(userId));
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
        sendJson(res, 200, { ok: true, subscribed: true });
        return true;
      }
      // revoke: only clear admin comps here; Stripe subscriptions are cancelled
      // through the billing portal so local + Stripe state can't drift.
      if (u.membership && u.membership.provider === 'stripe') {
        sendJson(res, 400, { error: 'This is a Stripe subscription — cancel it from the billing portal.' });
        return true;
      }
      await accounts.store.updateUser(userId, { membership: null, hasPurchased: false });
      await paymentsStore.addTxn(userId, { kind: 'admin.revoke', ts: Date.now(), by: admin ? admin.id : null });
      sendJson(res, 200, { ok: true, subscribed: false });
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

  // Subscribe (free follow) to the channel. Logged-in users only.
  if (url.pathname === '/api/subscribe/status' && req.method === 'GET') {
    const u = accounts.currentUser(req);
    sendJson(res, 200, { subscribed: u ? subscribers.isSubscribed(u.id) : false, count: subscribers.count() });
    return true;
  }
  if ((url.pathname === '/api/subscribe' || url.pathname === '/api/unsubscribe') && req.method === 'POST') {
    const u = accounts.currentUser(req);
    if (!u) { sendJson(res, 401, { error: 'Please sign in to subscribe.' }); return true; }
    const result = url.pathname === '/api/subscribe' ? subscribers.subscribe(u.id) : subscribers.unsubscribe(u.id);
    sendJson(res, 200, { ok: true, ...result });
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
        if (body.action === 'add') result = categories.add(body.name);
        else if (body.action === 'rename') result = categories.rename(body.slug, body.name);
        else if (body.action === 'remove') result = categories.remove(body.slug);
        else result = { ok: false, error: 'Unknown action.' };
        sendJson(res, result.ok ? 200 : 400, { ...result, categories: categories.list() });
      } catch { sendJson(res, 500, { error: 'Server error' }); }
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
    const liveIds = new Set(listManifest().filter((v) => v.published !== false).map((v) => v.id));
    sendJson(res, 200, listNotifications(u.id, liveIds));
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

  // Payments (/api/pay/stripe/*). Before accounts so the public webhook (no
  // session) is reached; the webhook reads the raw body for signature checking.
  if (await stripePayments.handle(req, res, url)) return true;

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

/** Stream a raw request body to disk (bypassing readBody), then enqueue ingestion. */
function streamUpload(req, res, name, visibility = 'free', blur = '', category = '', publishAt = 0) {
  return new Promise((resolve) => {
    const { savedPath, partPath } = newUploadTarget(name);
    const out = fs.createWriteStream(partPath);
    let total = 0;
    let aborted = false;

    const fail = (status, error) => {
      if (aborted) return;
      aborted = true;
      try { req.destroy(); } catch { /* ignore */ }
      out.destroy();
      fsp.unlink(partPath).catch(() => {});
      sendJson(res, status, { error });
      resolve();
    };

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > UPLOAD_MAX_BYTES) fail(413, 'File too large.');
    });
    out.on('error', () => fail(500, 'Write failed.'));
    req.on('error', () => fail(400, 'Upload interrupted.'));
    req.on('aborted', () => fail(400, 'Upload aborted.'));

    req.pipe(out);

    out.on('close', () => {
      if (aborted) return;
      if (total === 0) { fail(400, 'Empty upload.'); return; }
      fsp.rename(partPath, savedPath)
        .then(() => {
          const { jobId, manifestId } = enqueue(savedPath, name, { visibility, blur, category, publishAt });
          sendJson(res, 202, { ok: true, jobId, manifestId });
          resolve();
        })
        .catch(() => fail(500, 'Could not finalize upload.'));
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
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
      const courseIds = products.productIdsForVideo(vid, { publishedOnly: true });
      const courseGated = courseIds.length > 0;
      const ownsCourse = courseGated && courseIds.some((pid) => ctx.ownedProductIds.includes(pid));
      const dripBlocked = !videoPublic(vid) && !ctx.isAdmin;
      const premiumBlocked = videoVisibility(vid) === 'premium' && !ctx.isMember;
      const blocked = !ctx.isAdmin && (dripBlocked || (courseGated ? !ownsCourse : premiumBlocked));
      if (blocked) {
        res.writeHead(403, withSecurityHeaders());
        return res.end('Forbidden');
      }
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

    // The manifest is a static file, but it must not leak scheduled-but-unreleased
    // titles/thumbs. Serve a filtered copy to non-admins (admins get the full list
    // so the upload/edit/manage pages still work).
    if (pathname === '/thumbs/videos.json') {
      const all = listManifest();
      const list = ctx.isAdmin ? all : all.filter((v) => v.published !== false);
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
  // One-time pricing backfill: if the owner hasn't set membership pricing yet,
  // seed it from the legacy env Stripe prices so a deploy keeps charging the same
  // amount (after this, data/pricing.json is the source of truth).
  if (!pricing.isConfigured()) {
    try { pricing.seedFrom(await stripePayments.envPriceAmounts()); } catch { /* defaults stand */ }
  }
  console.log(`▶  David Bond TV running at http://localhost:${PORT}`);
  console.log(`   admin uploads: ${adminConfigured(adminAccount) ? 'enabled' : 'DISABLED'} · ffmpeg: ${hasFfmpeg() ? 'ok' : 'MISSING'} · cloudflare: ${TRUST_CLOUDFLARE ? 'trusted' : 'off'}`);
  await bootSweep(); // any interrupted "processing" entries → "failed"
  await releaseScheduled(); // publish any drips whose time passed while we were down
});

// Scheduled-release worker: publish due "slow-drip" videos (and notify viewers)
// roughly every minute. unref() so it never holds the process open.
setInterval(() => { releaseScheduled().catch(() => {}); }, 60_000).unref();

// Persist in-memory analytics rollups on shutdown so nothing is lost.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { analytics.flush(true); } catch { /* ignore */ } process.exit(0); });
}
