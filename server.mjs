import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { contentType, parseRange, sendJson, readBody, clientIp } from './lib/http-util.js';
import { createChallenge, verifyChallenge } from './lib/challenge.js';
import { createRateLimiter } from './lib/rate-limit.js';
import { validateComment, addComment, listComments, deleteComment } from './lib/comments-store.js';
import { getCounts, getUserVote, setVote } from './lib/reactions-store.js';
import { adminConfigured } from './lib/admin-auth.js';
import { createAdminAccount } from './lib/admin-account.js';
import { serializeCookie } from './lib/cookies.js';
import { hashPassword, verifyPassword } from './lib/password.js';
import { createGeoip } from './lib/geoip.js';
import { createAccounts } from './lib/accounts.js';
import { adminUser } from './lib/users-store.js';
import { createPaymentsStore } from './lib/payments-store.js';
import { createStripePayments } from './lib/stripe-payments.js';
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
import * as subscribers from './lib/subscribers.js';
import { createRequestContext } from './lib/request-context.mjs';
import { createAnalytics } from './lib/analytics-store.mjs';
import { createGeoGate } from './lib/geo-gate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MEDIA_DIR = path.join(__dirname, 'media');

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

// --- API setup ---
const SECRET = crypto.randomBytes(32).toString('hex');
// Admin token signing key. Set ADMIN_SECRET to keep tokens valid across restarts;
// otherwise a fresh random key logs admins out on each restart (fine for one admin).
const ADMIN_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(32).toString('hex');
const limiter = createRateLimiter(60_000, 3); // up to 3 comments/min per IP
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
const accounts = createAccounts({
  tokenSecret: AUTH_SECRET,
  challengeSecret: SECRET, // same key that mints /api/challenge tokens
  baseUrl: BASE_URL,
  usersFile: USERS_FILE,
  mediaDir: MEDIA_DIR,
  isSecure: BASE_URL.startsWith('https'),
});

// --- Payments (Stripe membership) ---
// All keys come from the environment; without them checkout/portal return 503
// and the rest of the app runs unchanged. The webhook must be publicly reachable
// at BASE_URL/api/pay/stripe/webhook (it is, behind nginx/Cloudflare in prod).
const PAYMENTS_FILE = path.join(__dirname, 'data', 'payments.json');
const paymentsStore = createPaymentsStore(PAYMENTS_FILE);
const stripePayments = createStripePayments({
  store: accounts.store,
  currentUser: accounts.currentUser,
  paymentsStore,
  baseUrl: BASE_URL,
  secretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  priceMonthly: process.env.STRIPE_PRICE_MONTHLY,
  priceYearly: process.env.STRIPE_PRICE_YEARLY,
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
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  });
  res.end(UNDER_CONSTRUCTION || '<!doctype html><meta name="robots" content="noindex"><title>David Bond TV</title><h1>Under Construction</h1>');
}

/** id → title map from the manifest, for joining analytics/history to names. */
function manifestTitleMap() {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'thumbs', 'videos.json'), 'utf8'));
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
  // Pretty public-profile URLs: /u/<username> all serve the profile page,
  // which reads the username from the path and fetches /api/users/<name>.
  if (pathname.startsWith('/u/')) pathname = '/profile.html';

  const isMedia = pathname.startsWith('/media/');
  const root = isMedia ? MEDIA_DIR : PUBLIC_DIR;
  const rel = isMedia ? pathname.slice('/media'.length) : pathname;
  const filePath = path.normalize(path.join(root, rel));

  // Traversal guard: resolved path must stay within its root.
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;
  return filePath;
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

  // GET /api/comments?video=<id>
  if (req.method === 'GET' && url.pathname === '/api/comments') {
    try {
      const video = url.searchParams.get('video') || 'bikinis';
      // Hide comments from banned (blocked) users — banning an author also
      // removes their comments from view.
      const blockedIds = new Set(geoGate.getRules().blockedUserIds);
      // Derive the admin badge live from current roles (covers comments posted
      // before the flag existed, and stays accurate if roles ever change).
      const comments = listComments(COMMENTS_FILE, video)
        .filter((c) => !(c.userId && blockedIds.has(c.userId)))
        .map((c) => {
          if (!c.username) return c;
          const u = accounts.store.getByUsername(c.username);
          const isAdmin = !!(u && Array.isArray(u.roles) && u.roles.includes('admin'));
          return isAdmin ? { ...c, admin: true } : c;
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

      const { video, name, anonymous, text, answer, token } = body;
      const user = accounts.currentUser(req);
      const country = geoip.lookup(ip) || undefined;

      let stored;
      if (user && user.profileComplete) {
        // Logged-in: post as the profile identity, no math challenge needed.
        const validation = validateComment({ name: user.username, anonymous: false, text });
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
          country,
        });
      } else {
        // Anonymous: require the math challenge; give a varied generic avatar.
        if (!verifyChallenge(SECRET, token, answer)) {
          sendJson(res, 400, { error: 'Incorrect answer to the verification question.' });
          return true;
        }
        const validation = validateComment({ name, anonymous, text });
        if (!validation.ok) {
          sendJson(res, 400, { error: validation.error });
          return true;
        }
        stored = await addComment(COMMENTS_FILE, video || 'bikinis', {
          name: validation.value.name,
          text: validation.value.text,
          avatarSeed: crypto.randomBytes(4).toString('hex'),
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
    sendJson(res, 200, listNotifications(u.id));
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

    // Premium backstop: a premium video's renditions require an active member
    // (admins count — see ctx.isMember). Non-members get 403 even with a direct
    // /videos/<id>/* URL (the player gate is the UX; this is the enforcement). A
    // scheduled/unpublished video's renditions stay admin-only so a member can't
    // pull a drip early. Free, live videos and other assets are unaffected.
    const vmatch = pathname.match(/^\/videos\/([^/]+)\//); // pathname is already decoded
    if (vmatch && (
      (videoVisibility(vmatch[1]) === 'premium' && !ctx.isMember)
      || (!videoPublic(vmatch[1]) && !ctx.isAdmin)
    )) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    // The manifest is a static file, but it must not leak scheduled-but-unreleased
    // titles/thumbs. Serve a filtered copy to non-admins (admins get the full list
    // so the upload/edit/manage pages still work).
    if (pathname === '/thumbs/videos.json') {
      const all = listManifest();
      const list = ctx.isAdmin ? all : all.filter((v) => v.published !== false);
      const json = JSON.stringify(list);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json),
        'Cache-Control': 'no-cache',
      });
      return res.end(json);
    }

    // Static file serving (unchanged)
    const filePath = resolveFile(req.url);
    if (!filePath) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      res.writeHead(404);
      return res.end('Not found');
    }
    if (stat.isDirectory()) {
      res.writeHead(404);
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
      html = html.includes('</body>')
        ? html.replace('</body>', `${VERSION_BADGE}</body>`)
        : html + VERSION_BADGE;
      const buf = Buffer.from(html, 'utf8');
      delete headers['Accept-Ranges'];
      headers['Content-Length'] = buf.length;
      res.writeHead(200, headers);
      return res.end(buf);
    }

    const range = parseRange(req.headers.range, stat.size);
    if (range && range.invalid) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }

    if (range) {
      const { start, end } = range;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      headers['Content-Length'] = stat.size;
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch {
    res.writeHead(500);
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
