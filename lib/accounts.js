// User accounts: signup, email verification, login/logout, password reset, and
// profile management. Self-contained route handler wired into server.mjs. Reuses
// the project's existing primitives (signed tokens, math challenge, rate limiter,
// JSON store) and keeps all user persistence behind lib/users-store.js.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createUsersStore, selfUser, publicUser } from './users-store.js';
import { hashPassword, verifyPassword, validatePassword } from './password.js';
import { createToken, verifyToken } from './auth-token.js';
import { verifyChallenge } from './challenge.js';
import { createRateLimiter } from './rate-limit.js';
import { parseCookies, serializeCookie } from './cookies.js';
import { validateAvatarValue, avatarUrl } from './avatars.js';
import { sendVerificationEmail, sendResetEmail, sendWelcomeEmail, mailDevMode } from './mailer.js';
import { sendJson, readBody, clientIp } from './http-util.js';
import { createOAuth } from './oauth.js';
import { generateRecoveryPhrase, hashRecoveryPhrase, verifyRecoveryPhrase } from './recovery-key.js';

const COOKIE = 'dbtv_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const VERIFY_TTL = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TTL = 60 * 60 * 1000; // 1 hour
const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const RESERVED = new Set(['admin', 'anonymous', 'administrator', 'root', 'support', 'dbtv', 'davidbond']);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const stripControls = (s) => String(s).replace(CONTROL, '');

function validateEmail(email) {
  return typeof email === 'string'
    && email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateUsername(username) {
  if (typeof username !== 'string') return { ok: false, error: 'Username is required.' };
  const t = username.trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(t)) {
    return { ok: false, error: 'Username must be 3-20 letters, numbers or underscores.' };
  }
  if (RESERVED.has(t.toLowerCase())) return { ok: false, error: 'That username is reserved.' };
  return { ok: true, value: t };
}

function cleanAbout(about) {
  if (about === undefined || about === null) return { ok: true, value: undefined };
  const t = stripControls(about).slice(0, 500);
  return { ok: true, value: t };
}

function cleanLink(link) {
  if (link === undefined || link === null || link === '') return { ok: true, value: '' };
  const t = stripControls(link).trim();
  if (t.length > 200) return { ok: false, error: 'Link is too long.' };
  if (!/^https?:\/\/[^\s]+$/i.test(t)) return { ok: false, error: 'Link must start with http:// or https://' };
  return { ok: true, value: t };
}

export function createAccounts({
  tokenSecret, challengeSecret, baseUrl, usersFile, mediaDir, isSecure = false, cookieDomain = '',
  turnstile = { enabled: false }, providers = {}, turnstileSiteKey = null,
}) {
  const store = createUsersStore(usersFile);

  /**
   * Bot gate for signup / reset-request. When Cloudflare Turnstile is configured
   * we require a valid widget token; otherwise we fall back to the built-in math
   * challenge so local dev and the existing test suite keep working unchanged.
   */
  async function passedHumanCheck(body, ip) {
    if (turnstile.enabled) return turnstile.verify(body.turnstileToken, ip);
    return verifyChallenge(challengeSecret, body.token, body.answer);
  }

  // Rate limiters tuned per action. (key = IP, or IP+email where noted.)
  const signupIpLimiter = createRateLimiter(60_000, 5);
  const signupEmailLimiter = createRateLimiter(60 * 60_000, 3); // 3/hour per email
  const loginLimiter = createRateLimiter(60_000, 10);
  const resetLimiter = createRateLimiter(60_000, 5);
  const recoverLimiter = createRateLimiter(60_000, 5); // recovery-key login attempts
  const recoveryKeyLimiter = createRateLimiter(60_000, 10); // generate/regenerate

  function setSession(res, user) {
    const token = createToken(
      tokenSecret,
      { purpose: 'session', uid: user.id, stamp: user.securityStamp },
      SESSION_TTL,
    );
    res.setHeader('Set-Cookie', serializeCookie(COOKIE, token, {
      httpOnly: true, maxAge: SESSION_TTL / 1000, sameSite: 'Lax', secure: isSecure, domain: cookieDomain || undefined,
    }));
  }

  function clearSession(res) {
    res.setHeader('Set-Cookie', serializeCookie(COOKIE, '', {
      httpOnly: true, maxAge: 0, sameSite: 'Lax', secure: isSecure, domain: cookieDomain || undefined,
    }));
  }

  /** Resolve the logged-in user from the session cookie, or null. */
  function currentUser(req) {
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (!tok) return null;
    const payload = verifyToken(tokenSecret, tok);
    if (!payload || payload.purpose !== 'session') return null;
    const user = store.getById(payload.uid);
    if (!user || user.securityStamp !== payload.stamp) return null; // rotated → invalid
    return user;
  }

  function meBody(user) {
    return { ...selfUser(user), avatarUrl: avatarUrl(user.avatar, user.username || user.email) };
  }

  // Social login (Discord/Google/GitHub). Reuses this module's store, session
  // writer and current-user resolver; mounted in handle() below.
  const oauth = createOAuth({
    store, establishSession: setSession, currentUser,
    tokenSecret, baseUrl, isSecure, providers,
  });

  async function parseJson(req) {
    const raw = await readBody(req, 16_384);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async function handleSignup(req, res) {
    const ip = clientIp(req);
    if (!signupIpLimiter.hit(ip).allowed) {
      return sendJson(res, 429, { error: 'Too many sign-up attempts. Please wait a minute.' });
    }
    const body = await parseJson(req);
    if (!body) return sendJson(res, 400, { error: 'Invalid request.' });

    // Honeypot: a real user never fills this hidden field. Pretend success.
    if (body.hp) return sendJson(res, 200, { ok: true, message: 'Check your email to confirm your account.' });

    if (!validateEmail(body.email)) return sendJson(res, 400, { error: 'Please enter a valid email address.' });
    if (!(await passedHumanCheck(body, ip))) {
      return sendJson(res, 400, { error: 'Verification failed. Please try again.' });
    }
    const pw = validatePassword(body.password);
    if (!pw.ok) return sendJson(res, 400, { error: pw.error });

    if (!signupEmailLimiter.hit(body.email.toLowerCase()).allowed) {
      return sendJson(res, 429, { error: 'Too many sign-up attempts for this email.' });
    }

    const generic = { ok: true, message: 'Thanks! Check your email (and spam folder) to confirm your account.' };

    // In dev mode mail is never actually delivered (it lands in data/outbox/), so
    // we hand the verification link straight back to the client for easy testing.
    const devLink = (link) => (mailDevMode() ? { ...generic, verifyUrl: link } : generic);

    const existing = store.getByEmail(body.email);
    if (existing) {
      // Don't reveal that the account exists. Resend verification if still unverified.
      if (!existing.verified) {
        const link = `${baseUrl}/api/auth/verify?token=${encodeURIComponent(
          createToken(tokenSecret, { purpose: 'verify', uid: existing.id, stamp: existing.securityStamp }, VERIFY_TTL),
        )}`;
        sendVerificationEmail(existing.email, link);
        return sendJson(res, 200, devLink(link));
      }
      return sendJson(res, 200, generic);
    }

    const created = await store.createUser({ email: body.email, passwordHash: hashPassword(body.password) });
    if (!created.ok) return sendJson(res, 200, generic);
    const link = `${baseUrl}/api/auth/verify?token=${encodeURIComponent(
      createToken(tokenSecret, { purpose: 'verify', uid: created.user.id, stamp: created.user.securityStamp }, VERIFY_TTL),
    )}`;
    sendVerificationEmail(created.user.email, link);
    return sendJson(res, 200, devLink(link));
  }

  async function handleVerify(req, res, url) {
    const token = url.searchParams.get('token') || '';
    const payload = verifyToken(tokenSecret, token);
    const redirect = (loc) => { res.writeHead(302, { Location: loc }); res.end(); };
    if (!payload || payload.purpose !== 'verify') return redirect('/login.html?error=verify');
    const user = store.getById(payload.uid);
    if (!user || user.securityStamp !== payload.stamp) return redirect('/login.html?error=verify');

    if (!user.verified) await store.updateUser(user.id, { verified: true, verifiedAt: Date.now() });
    const fresh = store.getById(user.id);
    setSession(res, fresh);
    return redirect(fresh.profileComplete ? '/account.html' : '/profile-setup.html');
  }

  async function handleLogin(req, res) {
    if (!loginLimiter.hit(clientIp(req)).allowed) {
      return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });
    }
    const body = await parseJson(req);
    if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
    // Accept an email OR a username as the identifier (admins sign in by username).
    const id = body.email || body.identifier;
    const user = store.getByEmail(id) || store.getByUsername(id);
    if (user && !user.passwordHash) {
      return sendJson(res, 403, {
        error: 'This account uses social login. Sign in with your provider, or set a password from your account page.',
      });
    }
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      return sendJson(res, 401, { error: 'Incorrect email or password.' });
    }
    if (!user.verified) {
      return sendJson(res, 403, { error: 'Please confirm your email first. Check your inbox and spam folder.' });
    }
    setSession(res, user);
    return sendJson(res, 200, { ok: true, user: meBody(user) });
  }

  function handleLogout(req, res) {
    clearSession(res);
    return sendJson(res, 200, { ok: true });
  }

  function handleMe(req, res) {
    const user = currentUser(req);
    return sendJson(res, 200, { user: user ? meBody(user) : null });
  }

  // Public auth config so the frontend renders only what's switched on: the
  // Turnstile site key (public) and which social providers are available.
  function handleConfig(req, res) {
    return sendJson(res, 200, {
      turnstileSiteKey: turnstileSiteKey || null,
      providers: oauth.enabled,
    });
  }

  // Let a logged-in user set their FIRST password (OAuth-only accounts). Changing
  // an existing password goes through the reset flow, which rotates the session.
  async function handleSetPassword(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    const body = await parseJson(req);
    if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
    if (user.passwordHash) {
      return sendJson(res, 400, { error: 'You already have a password — use “forgot password” to change it.' });
    }
    const pw = validatePassword(body.password);
    if (!pw.ok) return sendJson(res, 400, { error: pw.error });
    const r = await store.updateUser(user.id, { passwordHash: hashPassword(body.password) });
    if (!r.ok) return sendJson(res, 500, { error: 'Could not save your password.' });
    return sendJson(res, 200, { ok: true, user: meBody(r.user) });
  }

  // Generate (or regenerate) the user's 12-word recovery phrase. The plaintext is
  // returned ONCE here and only its hash is stored. Regenerating an existing key
  // requires the current password so a hijacked session can't rotate + lock out.
  async function handleRecoveryKey(req, res) {
    if (!recoveryKeyLimiter.hit(clientIp(req)).allowed) {
      return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });
    }
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    if (!user.passwordHash) {
      return sendJson(res, 400, { error: 'Recovery keys are available for email + password accounts.' });
    }
    const body = await parseJson(req);
    if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
    if (user.recoveryKeyHash && !verifyPassword(body.password, user.passwordHash)) {
      return sendJson(res, 403, { error: 'Enter your current password to regenerate your recovery key.' });
    }
    const phrase = generateRecoveryPhrase();
    const r = await store.updateUser(user.id, {
      recoveryKeyHash: hashRecoveryPhrase(phrase), recoveryKeySetAt: Date.now(),
    });
    if (!r.ok) return sendJson(res, 500, { error: 'Could not save your recovery key.' });
    return sendJson(res, 200, { ok: true, phrase, user: meBody(r.user) });
  }

  // Regain access with a recovery phrase. On success we hand back a reset token so
  // the user sets a new password through the existing reset flow. Generic errors +
  // IP rate limiting keep it from leaking which accounts exist.
  async function handleRecover(req, res) {
    if (!recoverLimiter.hit(clientIp(req)).allowed) {
      return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });
    }
    const body = await parseJson(req);
    if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
    const user = store.getByEmail(body.email);
    const ok = user && user.recoveryKeyHash && verifyRecoveryPhrase(body.recoveryKey, user.recoveryKeyHash);
    if (!ok) return sendJson(res, 400, { error: 'That email and recovery key don’t match.' });
    const token = createToken(tokenSecret, { purpose: 'reset', uid: user.id, stamp: user.securityStamp }, RESET_TTL);
    return sendJson(res, 200, { ok: true, resetToken: token });
  }

  async function handleRequestReset(req, res) {
    const ip = clientIp(req);
    if (!resetLimiter.hit(ip).allowed) {
      return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });
    }
    const body = await parseJson(req);
    if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
    if (!(await passedHumanCheck(body, ip))) {
      return sendJson(res, 400, { error: 'Verification failed. Please try again.' });
    }
    const generic = { ok: true, message: 'If that email is registered, a reset link is on its way.' };
    const user = store.getByEmail(body.email);
    if (user && user.verified) {
      const link = `${baseUrl}/reset.html?token=${encodeURIComponent(
        createToken(tokenSecret, { purpose: 'reset', uid: user.id, stamp: user.securityStamp }, RESET_TTL),
      )}`;
      sendResetEmail(user.email, link);
    }
    return sendJson(res, 200, generic);
  }

  async function handleReset(req, res) {
    const body = await parseJson(req);
    if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
    const payload = verifyToken(tokenSecret, body.token);
    if (!payload || payload.purpose !== 'reset') {
      return sendJson(res, 400, { error: 'This reset link is invalid or has expired.' });
    }
    const user = store.getById(payload.uid);
    if (!user || user.securityStamp !== payload.stamp) {
      return sendJson(res, 400, { error: 'This reset link is invalid or has expired.' });
    }
    const pw = validatePassword(body.password);
    if (!pw.ok) return sendJson(res, 400, { error: pw.error });
    // Rotate the security stamp → invalidates this link and any active sessions.
    await store.updateUser(user.id, {
      passwordHash: hashPassword(body.password),
      securityStamp: crypto.randomBytes(16).toString('hex'),
    });
    return sendJson(res, 200, { ok: true });
  }

  async function handleProfileSetup(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    const body = await parseJson(req);
    if (!body) return sendJson(res, 400, { error: 'Invalid request.' });

    const uname = validateUsername(body.username);
    if (!uname.ok) return sendJson(res, 400, { error: uname.error });
    // Avatar is optional: with none set, the user gets a generated initial avatar.
    let avatarValue = '';
    if (body.avatar) {
      const av = validateAvatarValue(body.avatar);
      if (!av.ok) return sendJson(res, 400, { error: 'That profile photo isn’t valid. Upload a PNG, JPEG or WEBP.' });
      avatarValue = av.value;
    }
    if (store.isUsernameTaken(uname.value) && store.getByUsername(uname.value).id !== user.id) {
      return sendJson(res, 409, { error: 'That username is taken.' });
    }
    const r = await store.updateUser(user.id, {
      username: uname.value, avatar: avatarValue, profileComplete: true,
    });
    if (!r.ok) {
      return sendJson(res, 409, { error: r.error === 'username_taken' ? 'That username is taken.' : 'Could not save profile.' });
    }
    if (!user.profileComplete) sendWelcomeEmail(user.email, uname.value);
    return sendJson(res, 200, { ok: true, user: meBody(r.user) });
  }

  async function handleProfileUpdate(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    const body = await parseJson(req);
    if (!body) return sendJson(res, 400, { error: 'Invalid request.' });

    // Usernames are fixed after account creation — never updated here. Only
    // avatar, About and link are editable. (Ignoring body.username also means
    // editing About/link can't trip the username-reserved validation.)
    const patch = {};
    if (body.avatar !== undefined) {
      if (body.avatar === '') {
        patch.avatar = ''; // clear → fall back to the generated initial avatar
      } else {
        const av = validateAvatarValue(body.avatar);
        if (!av.ok) return sendJson(res, 400, { error: 'Invalid avatar selection.' });
        patch.avatar = av.value;
      }
    }
    const about = cleanAbout(body.about);
    if (about.value !== undefined) patch.about = about.value;
    const link = cleanLink(body.link);
    if (!link.ok) return sendJson(res, 400, { error: link.error });
    if (body.link !== undefined) patch.link = link.value;

    const r = await store.updateUser(user.id, patch);
    if (!r.ok) {
      return sendJson(res, 409, { error: r.error === 'username_taken' ? 'That username is taken.' : 'Could not save.' });
    }
    return sendJson(res, 200, { ok: true, user: meBody(r.user) });
  }

  function handleAvatarUpload(req, res) {
    const user = currentUser(req);
    if (!user) { sendJson(res, 401, { error: 'Please sign in.' }); return; }
    const ct = (req.headers['content-type'] || '').split(';')[0].trim();
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[ct];
    if (!ext) { sendJson(res, 415, { error: 'Only PNG, JPEG or WEBP images are accepted.' }); return; }

    const file = `${crypto.randomUUID()}.${ext}`;
    const dir = path.join(mediaDir, 'avatars');
    const dest = path.join(dir, file);
    fs.mkdirSync(dir, { recursive: true });
    const out = fs.createWriteStream(dest);
    let total = 0;
    let aborted = false;
    const fail = (status, error) => {
      if (aborted) return;
      aborted = true;
      try { req.destroy(); } catch { /* ignore */ }
      out.destroy();
      fsp.unlink(dest).catch(() => {});
      sendJson(res, status, { error });
    };
    req.on('data', (chunk) => { total += chunk.length; if (total > AVATAR_MAX_BYTES) fail(413, 'Image too large (max 2 MB).'); });
    req.on('error', () => fail(400, 'Upload interrupted.'));
    out.on('error', () => fail(500, 'Write failed.'));
    req.pipe(out);
    out.on('close', async () => {
      if (aborted) return;
      if (total === 0) { fail(400, 'Empty upload.'); return; }
      const value = `upload:/media/avatars/${file}`;
      await store.updateUser(user.id, { avatar: value });
      sendJson(res, 200, { ok: true, value, url: `/media/avatars/${file}` });
    });
  }

  function handlePublicProfile(req, res, name) {
    const user = store.getByUsername(name);
    if (!user || !user.profileComplete) return sendJson(res, 404, { error: 'Profile not found.' });
    const pub = publicUser(user);
    return sendJson(res, 200, { user: { ...pub, avatarUrl: avatarUrl(user.avatar, user.username) } });
  }

  // [method, pathname] → handler. Exact-match routes.
  const routes = {
    'POST /api/auth/signup': handleSignup,
    'GET /api/auth/verify': (req, res, url) => handleVerify(req, res, url),
    'POST /api/auth/login': handleLogin,
    'POST /api/auth/logout': handleLogout,
    'GET /api/auth/me': handleMe,
    'GET /api/auth/config': handleConfig,
    'POST /api/auth/set-password': handleSetPassword,
    'POST /api/auth/recovery-key': handleRecoveryKey,
    'POST /api/auth/recover': handleRecover,
    'POST /api/auth/request-reset': handleRequestReset,
    'POST /api/auth/reset': handleReset,
    'POST /api/profile/setup': handleProfileSetup,
    'POST /api/profile/update': handleProfileUpdate,
    'POST /api/profile/avatar': handleAvatarUpload,
  };

  /** Route dispatch. Returns true if handled. */
  async function handle(req, res, url) {
    // Social-login routes (/api/auth/oauth/*) are pattern-matched, not exact.
    if (url.pathname.startsWith('/api/auth/oauth/')) {
      try {
        if (await oauth.handle(req, res, url)) return true;
      } catch {
        if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
        return true;
      }
    }
    const key = `${req.method} ${url.pathname}`;
    const fn = routes[key];
    if (fn) {
      try {
        await fn(req, res, url);
      } catch {
        if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
      }
      return true;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/users/')) {
      try {
        handlePublicProfile(req, res, decodeURIComponent(url.pathname.slice('/api/users/'.length)));
      } catch {
        if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
      }
      return true;
    }
    return false;
  }

  return { handle, currentUser, store, establishSession: setSession };
}
