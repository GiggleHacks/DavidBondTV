// Social login via OAuth 2.0 (authorization-code flow), hand-rolled and fetch-based
// — no SDK, matching the project's zero-dependency ethos. Supports Discord, Google
// and GitHub. A provider is only active when its client id + secret are configured;
// otherwise its routes 404 and the UI hides its button (graceful degradation, like
// the Stripe module). Mounted inside lib/accounts.js, which supplies the shared
// session writer, user store and current-user resolver.
//
// Security: the `state` parameter is a signed token (lib/auth-token.js) bound to a
// single-use nonce cookie (CSRF double-submit). Auto-linking a social identity to
// an existing email/password account happens ONLY when the provider asserts the
// email is verified — this prevents account takeover via an unverified address.
import crypto from 'node:crypto';
import { createToken, verifyToken } from './auth-token.js';
import { parseCookies, serializeCookie } from './cookies.js';
import { createRateLimiter } from './rate-limit.js';
import { clientIp, sendJson } from './http-util.js';

const STATE_TTL = 10 * 60 * 1000; // 10 minutes to complete the round-trip
const STATE_COOKIE = 'dbtv_oauth';

// Static, non-secret definitions per provider. `profile()` normalises each
// provider's user payload to { sub, email, emailVerified, name, avatar }.
const PROVIDERS = {
  discord: {
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    scope: 'identify email',
    async profile(token, f) {
      const r = await f('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`discord profile ${r.status}`);
      const u = await r.json();
      return {
        sub: String(u.id),
        email: u.email || null,
        emailVerified: Boolean(u.verified),
        name: u.global_name || u.username || null,
        avatar: null,
      };
    },
  },
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    authExtra: { access_type: 'online', prompt: 'select_account' },
    async profile(token, f) {
      const r = await f('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`google profile ${r.status}`);
      const u = await r.json();
      return {
        sub: String(u.sub),
        email: u.email || null,
        emailVerified: Boolean(u.email_verified),
        name: u.name || null,
        avatar: u.picture || null,
      };
    },
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    async profile(token, f) {
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'davidbondtv',
      };
      const r = await f('https://api.github.com/user', { headers });
      if (!r.ok) throw new Error(`github profile ${r.status}`);
      const u = await r.json();
      // GitHub often hides the email on the profile; fetch the verified primary.
      let email = u.email || null;
      let emailVerified = false;
      try {
        const er = await f('https://api.github.com/user/emails', { headers });
        if (er.ok) {
          const emails = await er.json();
          if (Array.isArray(emails)) {
            const pick = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
            if (pick) { email = pick.email; emailVerified = true; }
          }
        }
      } catch { /* fall back to profile email (unverified) */ }
      return {
        sub: String(u.id),
        email,
        emailVerified,
        name: u.name || u.login || null,
        avatar: u.avatar_url || null,
      };
    },
  },
};

/** Only allow same-origin relative paths as a post-login redirect target. */
function safeNext(next) {
  if (typeof next !== 'string') return null;
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  return next;
}

export function createOAuth({
  store, establishSession, currentUser, tokenSecret, baseUrl, isSecure = false,
  providers = {}, fetchImpl,
}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const startLimiter = createRateLimiter(60_000, 20); // 20 starts/min/IP

  const enabled = {
    discord: Boolean(providers.discord),
    google: Boolean(providers.google),
    github: Boolean(providers.github),
  };

  const redirect = (res, loc) => { res.writeHead(302, { Location: loc }); res.end(); };
  const redirectUri = (provider) => `${baseUrl}/api/auth/oauth/${provider}/callback`;
  const account = (provider, p) => ({ provider, sub: p.sub, email: p.email || null, linkedAt: Date.now() });

  function setStateCookie(res, nonce) {
    res.setHeader('Set-Cookie', serializeCookie(STATE_COOKIE, nonce, {
      httpOnly: true, maxAge: STATE_TTL / 1000, sameSite: 'Lax', secure: isSecure,
    }));
  }
  function clearStateCookie(res) {
    res.setHeader('Set-Cookie', serializeCookie(STATE_COOKIE, '', {
      httpOnly: true, maxAge: 0, sameSite: 'Lax', secure: isSecure,
    }));
  }

  async function exchangeCode(provider, code) {
    const def = PROVIDERS[provider];
    const cfg = providers[provider];
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(provider),
    });
    const r = await doFetch(def.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    if (!r.ok) throw new Error(`token ${r.status}`);
    const data = await r.json();
    if (!data || !data.access_token) throw new Error('no access_token');
    return data.access_token;
  }

  /**
   * Map a verified provider identity to a local user. Order: existing link →
   * verified-email match (link) → new account. Returns { ok, user } or
   * { ok:false, error }. With `linkUid`, attaches to that logged-in account.
   */
  async function resolveUser(provider, profile, linkUid) {
    if (linkUid) {
      const owner = store.getByOAuth(provider, profile.sub);
      if (owner && owner.id !== linkUid) return { ok: false, error: 'oauth_taken' };
      const r = await store.linkOAuth(linkUid, account(provider, profile));
      return r.ok ? { ok: true, user: r.user } : { ok: false, error: 'oauth' };
    }
    // 1) Identity already linked → straight login.
    const bySub = store.getByOAuth(provider, profile.sub);
    if (bySub) return { ok: true, user: bySub };
    // 2) Provider-verified email matching an existing account → link + login.
    if (profile.email && profile.emailVerified) {
      const byEmail = store.getByEmail(profile.email);
      if (byEmail) {
        const r = await store.linkOAuth(byEmail.id, account(provider, profile));
        return r.ok ? { ok: true, user: r.user } : { ok: false, error: 'oauth' };
      }
    }
    // 3) New account — the provider has vouched for this identity.
    const created = await store.createUser({
      email: profile.email || null,
      verified: true,
      oauthAccount: account(provider, profile),
    });
    if (created.ok) return { ok: true, user: created.user };
    // createUser failed (email already taken). Only safe to link when verified;
    // an unverified provider email must NOT attach to an existing account.
    if (created.error === 'exists' && profile.email && profile.emailVerified) {
      const byEmail = store.getByEmail(profile.email);
      if (byEmail) {
        const r = await store.linkOAuth(byEmail.id, account(provider, profile));
        if (r.ok) return { ok: true, user: r.user };
      }
    }
    return { ok: false, error: 'oauth' };
  }

  async function startFlow(req, res, url, provider) {
    if (!enabled[provider]) return redirect(res, '/login.html?error=oauth_disabled');
    if (!startLimiter.hit(clientIp(req)).allowed) return redirect(res, '/login.html?error=oauth_rate');
    const def = PROVIDERS[provider];
    const next = safeNext(url.searchParams.get('next'));
    let linkUid = null;
    if (url.searchParams.get('link') === '1') {
      const u = currentUser(req);
      if (u) linkUid = u.id;
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    const state = createToken(tokenSecret, { purpose: 'oauth', provider, nonce, next, linkUid }, STATE_TTL);
    setStateCookie(res, nonce);
    const params = new URLSearchParams({
      client_id: providers[provider].clientId,
      redirect_uri: redirectUri(provider),
      response_type: 'code',
      scope: def.scope,
      state,
      ...(def.authExtra || {}),
    });
    return redirect(res, `${def.authorizeUrl}?${params.toString()}`);
  }

  async function callbackFlow(req, res, url, provider) {
    const fail = (code) => { clearStateCookie(res); redirect(res, `/login.html?error=${code}`); };
    if (!enabled[provider]) return fail('oauth_disabled');
    const def = PROVIDERS[provider];
    const code = url.searchParams.get('code');
    const stateRaw = url.searchParams.get('state');
    if (!code || !stateRaw) return fail('oauth');

    const state = verifyToken(tokenSecret, stateRaw);
    const cookieNonce = parseCookies(req.headers.cookie)[STATE_COOKIE];
    if (!state || state.purpose !== 'oauth' || state.provider !== provider) return fail('oauth');
    if (!cookieNonce || cookieNonce !== state.nonce) return fail('oauth'); // CSRF mismatch

    let profile;
    try {
      const token = await exchangeCode(provider, code);
      profile = await def.profile(token, doFetch);
    } catch {
      return fail('oauth');
    }
    if (!profile || !profile.sub) return fail('oauth');

    const resolved = await resolveUser(provider, profile, state.linkUid);
    if (!resolved.ok) return fail(resolved.error || 'oauth');

    // Success: establishSession overwrites the Set-Cookie header with the session
    // cookie; the short-lived, single-use nonce cookie simply expires.
    establishSession(res, resolved.user);
    const dest = state.linkUid
      ? (state.next || '/account.html')
      : (state.next || '/videos');
    return redirect(res, dest);
  }

  async function unlinkFlow(req, res, provider) {
    const u = currentUser(req);
    if (!u) return sendJson(res, 401, { error: 'Please sign in.' });
    const remaining = (u.oauthAccounts || []).filter((a) => a.provider !== provider).length;
    if (!u.passwordHash && remaining === 0) {
      return sendJson(res, 400, { error: 'Set a password before removing your only sign-in method.' });
    }
    const r = await store.unlinkOAuth(u.id, provider);
    if (!r.ok) return sendJson(res, 400, { error: 'Could not unlink that account.' });
    return sendJson(res, 200, { ok: true });
  }

  /** Dispatch /api/auth/oauth/<provider>/<start|callback|unlink>. Returns true if handled. */
  async function handle(req, res, url) {
    const m = url.pathname.match(/^\/api\/auth\/oauth\/([a-z]+)\/(start|callback|unlink)$/);
    if (!m) return false;
    const [, provider, action] = m;
    if (!PROVIDERS[provider]) return false;
    if (action === 'start' && req.method === 'GET') { await startFlow(req, res, url, provider); return true; }
    if (action === 'callback' && req.method === 'GET') { await callbackFlow(req, res, url, provider); return true; }
    if (action === 'unlink' && req.method === 'POST') { await unlinkFlow(req, res, provider); return true; }
    return false;
  }

  return { handle, enabled, _test: { resolveUser, safeNext } };
}
