import { describe, it, expect } from 'vitest';
import { createOAuth } from '../lib/oauth.js';

// Minimal in-memory user store mirroring lib/users-store.js semantics for the
// fields OAuth touches: email index, oauth index, createUser/linkOAuth.
function fakeStore(initial = {}) {
  const users = JSON.parse(JSON.stringify(initial));
  let n = 0;
  const clone = (u) => (u ? JSON.parse(JSON.stringify(u)) : null);
  const byEmail = (email) => Object.values(users).find(
    (u) => u.emailLower && u.emailLower === String(email || '').toLowerCase());
  const byOAuth = (provider, sub) => Object.values(users).find(
    (u) => (u.oauthAccounts || []).some((a) => a.provider === provider && a.sub === sub));
  return {
    _users: users,
    getByEmail: (e) => clone(byEmail(e)),
    getByOAuth: (p, s) => clone(byOAuth(p, s)),
    async createUser({ email = null, verified = false, oauthAccount = null }) {
      const emailLower = email ? String(email).toLowerCase() : null;
      if (emailLower && byEmail(emailLower)) return { ok: false, error: 'exists' };
      const id = `u${++n}`;
      users[id] = {
        id, email, emailLower, passwordHash: null, verified,
        securityStamp: 'stamp', profileComplete: false,
        oauthAccounts: oauthAccount ? [oauthAccount] : [],
      };
      return { ok: true, user: clone(users[id]) };
    },
    async linkOAuth(id, account) {
      const u = users[id];
      if (!u) return { ok: false, error: 'not_found' };
      const owner = byOAuth(account.provider, account.sub);
      if (owner && owner.id !== id) return { ok: false, error: 'linked_elsewhere' };
      u.oauthAccounts = u.oauthAccounts || [];
      if (!u.oauthAccounts.some((a) => a.provider === account.provider && a.sub === account.sub)) {
        u.oauthAccounts.push(account);
      }
      return { ok: true, user: clone(u) };
    },
  };
}

function makeOAuth(store) {
  return createOAuth({
    store,
    establishSession: () => {},
    currentUser: () => null,
    tokenSecret: 'secret',
    baseUrl: 'https://x.test',
    providers: {
      discord: { clientId: 'id', clientSecret: 'sec' },
      google: { clientId: 'id', clientSecret: 'sec' },
      github: { clientId: 'id', clientSecret: 'sec' },
    },
  });
}

const P = (over = {}) => ({ sub: 's1', email: 'a@x.com', emailVerified: true, name: 'A', avatar: null, ...over });

describe('createOAuth.enabled', () => {
  it('reflects which providers have credentials', () => {
    const oauth = createOAuth({
      store: fakeStore(), establishSession: () => {}, currentUser: () => null,
      tokenSecret: 's', baseUrl: 'https://x.test',
      providers: { discord: { clientId: 'i', clientSecret: 's' } },
    });
    expect(oauth.enabled).toEqual({ discord: true, google: false, github: false });
  });
});

describe('resolveUser', () => {
  it('logs in an existing linked identity (match by sub)', async () => {
    const store = fakeStore({
      u1: { id: 'u1', email: 'a@x.com', emailLower: 'a@x.com', oauthAccounts: [{ provider: 'google', sub: 's1' }] },
    });
    const oauth = makeOAuth(store);
    const r = await oauth._test.resolveUser('google', P(), null);
    expect(r.ok).toBe(true);
    expect(r.user.id).toBe('u1');
  });

  it('links to an existing account when the provider email is verified', async () => {
    const store = fakeStore({
      u1: { id: 'u1', email: 'a@x.com', emailLower: 'a@x.com', passwordHash: 'scrypt$x', oauthAccounts: [] },
    });
    const oauth = makeOAuth(store);
    const r = await oauth._test.resolveUser('google', P({ emailVerified: true }), null);
    expect(r.ok).toBe(true);
    expect(r.user.id).toBe('u1');
    expect(store._users.u1.oauthAccounts).toHaveLength(1);
  });

  it('REFUSES to link to an existing password account when email is unverified (takeover guard)', async () => {
    const store = fakeStore({
      u1: { id: 'u1', email: 'a@x.com', emailLower: 'a@x.com', passwordHash: 'scrypt$x', oauthAccounts: [] },
    });
    const oauth = makeOAuth(store);
    const r = await oauth._test.resolveUser('google', P({ emailVerified: false }), null);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('oauth');
    expect(store._users.u1.oauthAccounts).toHaveLength(0); // untouched
  });

  it('creates a new account for a fresh verified identity', async () => {
    const store = fakeStore();
    const oauth = makeOAuth(store);
    const r = await oauth._test.resolveUser('discord', P({ sub: 'new', email: 'new@x.com' }), null);
    expect(r.ok).toBe(true);
    expect(r.user.verified).toBe(true);
    expect(r.user.oauthAccounts[0]).toMatchObject({ provider: 'discord', sub: 'new' });
  });

  it('creates a new account even with an unverified email when that email is unused', async () => {
    const store = fakeStore();
    const oauth = makeOAuth(store);
    const r = await oauth._test.resolveUser('discord', P({ sub: 'd2', email: 'free@x.com', emailVerified: false }), null);
    expect(r.ok).toBe(true);
    expect(r.user.oauthAccounts[0].sub).toBe('d2');
  });

  it('links to the logged-in account in the linking flow', async () => {
    const store = fakeStore({ u1: { id: 'u1', email: 'a@x.com', emailLower: 'a@x.com', oauthAccounts: [] } });
    const oauth = makeOAuth(store);
    const r = await oauth._test.resolveUser('github', P({ sub: 'g9' }), 'u1');
    expect(r.ok).toBe(true);
    expect(store._users.u1.oauthAccounts[0].sub).toBe('g9');
  });

  it('rejects linking an identity already owned by another user', async () => {
    const store = fakeStore({
      u1: { id: 'u1', oauthAccounts: [{ provider: 'github', sub: 'g9' }] },
      u2: { id: 'u2', oauthAccounts: [] },
    });
    const oauth = makeOAuth(store);
    const r = await oauth._test.resolveUser('github', P({ sub: 'g9' }), 'u2');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('oauth_taken');
  });
});

describe('safeNext', () => {
  it('allows same-origin relative paths only', () => {
    const oauth = makeOAuth(fakeStore());
    expect(oauth._test.safeNext('/account.html')).toBe('/account.html');
    expect(oauth._test.safeNext('//evil.com')).toBe(null);
    expect(oauth._test.safeNext('https://evil.com')).toBe(null);
    expect(oauth._test.safeNext(null)).toBe(null);
  });
});
