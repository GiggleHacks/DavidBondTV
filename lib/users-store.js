// Data-access layer for user accounts, backed by a JSON file today. ALL user
// reads/writes go through here so the backing store can be swapped to SQLite /
// Postgres later without touching routes. In-memory email/username indices give
// O(1) lookups; writes are serialized through a promise chain so concurrent
// requests can't corrupt the file (the whole-file-rewrite race).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { membershipSummary, hasActiveMembership } from './membership.js';

/** Fields safe to expose publicly (no email, hash, security stamp, etc.). */
export function publicUser(u) {
  if (!u) return null;
  return {
    username: u.username,
    avatar: u.avatar,
    about: u.about,
    link: u.link,
    createdAt: u.createdAt,
    isAdmin: Array.isArray(u.roles) && u.roles.includes('admin'),
    isMember: hasActiveMembership(u),
    // Only surfaced while membership is active; null otherwise (incl. legacy
    // records with no recorded start date) so the profile cleanly omits it.
    memberSince: hasActiveMembership(u) && u.membership && typeof u.membership.since === 'number'
      ? u.membership.since : null,
  };
}

/**
 * Admin-only projection. Includes email and the password hash (scrypt — a
 * one-way function, so the hash can't be reversed; it's shown for completeness).
 */
export function adminUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    avatar: u.avatar,
    about: u.about,
    link: u.link,
    verified: u.verified,
    profileComplete: u.profileComplete,
    createdAt: u.createdAt,
    hasPurchased: u.hasPurchased,
    purchases: u.purchases || [],
    membership: u.membership || null,
    stripeCustomerId: u.stripeCustomerId || null,
    oauthAccounts: sanitizeOauth(u.oauthAccounts),
    hasPassword: Boolean(u.passwordHash),
    hasRecoveryKey: Boolean(u.recoveryKeyHash),
    recoveryKeySetAt: u.recoveryKeySetAt || null,
    roles: u.roles || [],
    passwordHash: u.passwordHash,
  };
}

/** Strip any sensitive material from linked-provider records before exposure. */
function sanitizeOauth(list) {
  if (!Array.isArray(list)) return [];
  return list.map((a) => ({ provider: a.provider, email: a.email || null, linkedAt: a.linkedAt || null }));
}

/** Fields exposed to the logged-in user about themselves. */
export function selfUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    avatar: u.avatar,
    about: u.about,
    link: u.link,
    verified: u.verified,
    profileComplete: u.profileComplete,
    hasPurchased: u.hasPurchased,
    membership: membershipSummary(u),
    oauthAccounts: sanitizeOauth(u.oauthAccounts),
    hasPassword: Boolean(u.passwordHash),
    hasRecoveryKey: Boolean(u.recoveryKeyHash),
    recoveryKeySetAt: u.recoveryKeySetAt || null,
    roles: Array.isArray(u.roles) ? u.roles : [],
  };
}

export function createUsersStore(filePath) {
  let users = {}; // id -> user record
  const emailIndex = new Map(); // emailLower -> id
  const usernameIndex = new Map(); // usernameLower -> id
  const oauthIndex = new Map(); // "provider:sub" -> id
  let writeChain = Promise.resolve();

  const oauthKey = (provider, sub) => `${provider}:${sub}`;

  function reindex() {
    emailIndex.clear();
    usernameIndex.clear();
    oauthIndex.clear();
    for (const id of Object.keys(users)) {
      const u = users[id];
      if (u.emailLower) emailIndex.set(u.emailLower, id);
      if (u.usernameLower) usernameIndex.set(u.usernameLower, id);
      if (Array.isArray(u.oauthAccounts)) {
        for (const a of u.oauthAccounts) oauthIndex.set(oauthKey(a.provider, a.sub), id);
      }
    }
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      users = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      users = {};
    }
    reindex();
  }
  load();

  function persist() {
    writeChain = writeChain
      .then(async () => {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, JSON.stringify(users, null, 2), 'utf8');
      })
      .catch(() => {});
    return writeChain;
  }

  const clone = (u) => (u ? JSON.parse(JSON.stringify(u)) : null);

  return {
    getById(id) {
      return clone(users[id]);
    },
    getByEmail(email) {
      const id = emailIndex.get(String(email || '').toLowerCase());
      return id ? clone(users[id]) : null;
    },
    getByUsername(username) {
      const id = usernameIndex.get(String(username || '').toLowerCase());
      return id ? clone(users[id]) : null;
    },
    isUsernameTaken(username) {
      return usernameIndex.has(String(username || '').toLowerCase());
    },
    /** Look up a user by a linked OAuth identity (provider + provider's user id). */
    getByOAuth(provider, sub) {
      if (!provider || !sub) return null;
      const id = oauthIndex.get(oauthKey(provider, sub));
      return id ? clone(users[id]) : null;
    },
    /** Reverse-lookup a user by their Stripe customer id (webhook fallback mapping). */
    getByStripeCustomerId(customerId) {
      if (!customerId) return null;
      for (const id of Object.keys(users)) {
        if (users[id].stripeCustomerId === customerId) return clone(users[id]);
      }
      return null;
    },

    /**
     * Create an account. Email/password signups pass { email, passwordHash } and
     * land unverified; OAuth signups pass { email, verified:true, oauthAccount }
     * and have no password. Returns { ok, user } or { ok:false, error:'exists' }.
     */
    async createUser({ email = null, passwordHash = null, verified = false, oauthAccount = null }) {
      const emailLower = email ? String(email).toLowerCase() : null;
      if (emailLower && emailIndex.has(emailLower)) return { ok: false, error: 'exists' };
      const id = crypto.randomUUID();
      const user = {
        id,
        email: email || null,
        emailLower,
        passwordHash, // null for OAuth-only accounts
        verified,
        verifiedAt: verified ? Date.now() : null,
        createdAt: Date.now(),
        securityStamp: crypto.randomBytes(16).toString('hex'),
        username: null,
        usernameLower: null,
        avatar: null,
        about: '',
        link: '',
        profileComplete: false,
        // Legacy purchase flags (kept for backward-compat with older records and
        // admin views). The live source of truth is `membership` below.
        hasPurchased: false,
        purchases: [],
        // Paid membership state, written by the payment webhooks (see
        // lib/membership.js + lib/stripe-payments.js). null = never subscribed.
        membership: null,
        stripeCustomerId: null,
        // Linked social-login identities: [{ provider, sub, email, linkedAt }].
        oauthAccounts: oauthAccount ? [oauthAccount] : [],
        // Self-service recovery: scrypt hash of a 12-word phrase (lib/recovery-key.js).
        // null = never generated. Plaintext is shown once and never stored.
        recoveryKeyHash: null,
        recoveryKeySetAt: null,
        roles: [],
      };
      users[id] = user;
      if (emailLower) emailIndex.set(emailLower, id);
      for (const a of user.oauthAccounts) oauthIndex.set(oauthKey(a.provider, a.sub), id);
      await persist();
      return { ok: true, user: clone(user) };
    },

    /**
     * Link a social identity to an existing user. Returns { ok, user } or
     * { ok:false, error:'linked_elsewhere' } if that identity belongs to someone
     * else. Idempotent for the same (provider, sub) already on this account.
     */
    async linkOAuth(id, account) {
      const u = users[id];
      if (!u) return { ok: false, error: 'not_found' };
      const key = oauthKey(account.provider, account.sub);
      const owner = oauthIndex.get(key);
      if (owner && owner !== id) return { ok: false, error: 'linked_elsewhere' };
      if (!Array.isArray(u.oauthAccounts)) u.oauthAccounts = [];
      if (!u.oauthAccounts.some((a) => a.provider === account.provider && a.sub === account.sub)) {
        u.oauthAccounts.push(account);
      }
      oauthIndex.set(key, id);
      await persist();
      return { ok: true, user: clone(u) };
    },

    /** Remove a linked provider from a user. Returns { ok, user }. */
    async unlinkOAuth(id, provider) {
      const u = users[id];
      if (!u) return { ok: false, error: 'not_found' };
      const kept = (u.oauthAccounts || []).filter((a) => a.provider !== provider);
      for (const a of (u.oauthAccounts || [])) {
        if (a.provider === provider) oauthIndex.delete(oauthKey(a.provider, a.sub));
      }
      u.oauthAccounts = kept;
      await persist();
      return { ok: true, user: clone(u) };
    },

    /**
     * Merge `patch` into a user. Auto-derives emailLower/usernameLower and
     * enforces uniqueness. Returns { ok, user } or { ok:false, error }.
     */
    async updateUser(id, patch) {
      const u = users[id];
      if (!u) return { ok: false, error: 'not_found' };

      const next = { ...patch };
      if (typeof next.username === 'string') {
        next.usernameLower = next.username.toLowerCase();
        const owner = usernameIndex.get(next.usernameLower);
        if (owner && owner !== id) return { ok: false, error: 'username_taken' };
      }
      if (typeof next.email === 'string') {
        next.emailLower = next.email.toLowerCase();
        const owner = emailIndex.get(next.emailLower);
        if (owner && owner !== id) return { ok: false, error: 'email_taken' };
      }

      if (u.usernameLower) usernameIndex.delete(u.usernameLower);
      if (u.emailLower) emailIndex.delete(u.emailLower);
      Object.assign(u, next);
      if (u.usernameLower) usernameIndex.set(u.usernameLower, id);
      if (u.emailLower) emailIndex.set(u.emailLower, id);

      await persist();
      return { ok: true, user: clone(u) };
    },

    /** All user records (clones), for admin listing. */
    listAll() {
      return Object.values(users).map(clone);
    },

    /** Wait for all queued writes to flush (tests). */
    flush() {
      return writeChain;
    },
  };
}
