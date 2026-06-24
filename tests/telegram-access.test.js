import { describe, it, expect } from 'vitest';
import { createTelegramAccess, isTelegramEligible } from '../lib/telegram-access.js';
import { verifyToken } from '../lib/auth-token.js';

// --- fixtures ---------------------------------------------------------------

const SECRET = 'test-secret';
const BOT = 'DavidBondBot';
const HOOK = 'hook-secret';

const HOUR = 60 * 60_000;
// An always-active membership and a clearly-lapsed one.
const activeMembership = { provider: 'stripe', status: 'active', currentPeriodEnd: Date.now() + 30 * 24 * HOUR };
const lapsedMembership = { provider: 'stripe', status: 'canceled', currentPeriodEnd: Date.now() - HOUR };
const oneProduct = [{ productId: 'course-1', provider: 'stripe', purchasedAt: Date.now() }];

function fakeStore(initial = {}) {
  const users = JSON.parse(JSON.stringify(initial));
  return {
    getById: (id) => (users[id] ? JSON.parse(JSON.stringify(users[id])) : null),
    updateUser: async (id, patch) => { users[id] = { ...(users[id] || { id }), ...patch }; return { ok: true }; },
    listAll: () => Object.values(users).map((u) => JSON.parse(JSON.stringify(u))),
    _users: users,
  };
}

// Records every gate call; invite/kick replies are configurable.
function fakeGate({ invite = 'https://t.me/+abc123', kickOk = true } = {}) {
  const calls = { dms: [], invites: 0, kicks: [] };
  return {
    configured: true,
    sendDirectMessage: async (userId, text) => { calls.dms.push({ userId, text }); return { ok: true }; },
    createSingleUseInvite: async () => { calls.invites += 1; return invite; },
    kickMember: async (userId) => { calls.kicks.push(userId); return { ok: kickOk }; },
    _calls: calls,
  };
}

function make({ store = fakeStore(), gate = fakeGate(), ...rest } = {}) {
  const access = createTelegramAccess({
    store, currentUser: () => null, gate,
    tokenSecret: SECRET, botUsername: BOT, webhookToken: HOOK, ...rest,
  });
  return { access, store, gate };
}

const member = (over = {}) => ({ id: 'u1', securityStamp: 'stamp-1', telegram: { linkState: 'none' }, ...over });

// --- eligibility ------------------------------------------------------------

describe('isTelegramEligible', () => {
  it('true for an active member with no products', () => {
    expect(isTelegramEligible({ membership: activeMembership, products: [] })).toBe(true);
  });
  it('true for a product owner with no membership', () => {
    expect(isTelegramEligible({ membership: null, products: oneProduct })).toBe(true);
  });
  it('true with both', () => {
    expect(isTelegramEligible({ membership: activeMembership, products: oneProduct })).toBe(true);
  });
  it('false with neither', () => {
    expect(isTelegramEligible({ membership: null, products: [] })).toBe(false);
  });
  it('true for a trialing membership', () => {
    expect(isTelegramEligible({ membership: { ...activeMembership, status: 'trialing' }, products: [] })).toBe(true);
  });
  it('false when membership lapsed and no products', () => {
    expect(isTelegramEligible({ membership: lapsedMembership, products: [] })).toBe(false);
  });
  it('true when membership lapsed but a product is owned (lifetime)', () => {
    expect(isTelegramEligible({ membership: lapsedMembership, products: oneProduct })).toBe(true);
  });
  it('false for null/undefined', () => {
    expect(isTelegramEligible(null)).toBe(false);
    expect(isTelegramEligible(undefined)).toBe(false);
  });
});

// --- token mint / verify ----------------------------------------------------

describe('mintLinkToken', () => {
  it('round-trips through verifyToken with the right purpose and uid', () => {
    const { access } = make();
    const { token, deepLink } = access.mintLinkToken(member());
    expect(deepLink).toBe(`https://t.me/${BOT}?start=${token}`);
    const payload = verifyToken(SECRET, token);
    expect(payload.purpose).toBe('tg-link');
    expect(payload.uid).toBe('u1');
    expect(payload.stamp).toBe('stamp-1');
  });

  it('produces a token that is rejected after its TTL', () => {
    const { access } = make({ linkTokenTtlMs: 1000 });
    const t0 = 1_000_000;
    const { token } = access.mintLinkToken(member(), t0);
    expect(verifyToken(SECRET, token, t0 + 500)).toBeTruthy();
    expect(verifyToken(SECRET, token, t0 + 2000)).toBeNull();
  });

  it('a tampered token fails verification', () => {
    const { access } = make();
    const { token } = access.mintLinkToken(member());
    expect(verifyToken(SECRET, `${token}x`)).toBeNull();
  });
});

// --- redeem -----------------------------------------------------------------

describe('redeemLinkToken', () => {
  const from = { id: 555, username: 'tg_user' };

  it('captures the Telegram id, sets joined, and mints an invite', async () => {
    const store = fakeStore({ u1: member({ membership: activeMembership }) });
    const { access, gate } = make({ store });
    const { token } = access.mintLinkToken(store.getById('u1'));

    const r = await access.redeemLinkToken(token, from);
    expect(r.status).toBe('ok');
    expect(r.invite).toBe('https://t.me/+abc123');
    expect(gate._calls.invites).toBe(1);
    const saved = store.getById('u1');
    expect(saved.telegram.userId).toBe(555);
    expect(saved.telegram.username).toBe('tg_user');
    expect(saved.telegram.linkState).toBe('joined');
  });

  it('returns not_eligible when the account has no active access', async () => {
    const store = fakeStore({ u1: member({ membership: lapsedMembership, products: [] }) });
    const { access, gate } = make({ store });
    const { token } = access.mintLinkToken(store.getById('u1'));
    const r = await access.redeemLinkToken(token, from);
    expect(r.status).toBe('not_eligible');
    expect(gate._calls.invites).toBe(0);
  });

  it('returns expired for a stale token', async () => {
    const store = fakeStore({ u1: member({ membership: activeMembership }) });
    const { access } = make({ store, linkTokenTtlMs: 1000 });
    const { token } = access.mintLinkToken(store.getById('u1'), 1_000_000);
    const r = await access.redeemLinkToken(token, from, 1_000_000 + 5000);
    expect(r.status).toBe('expired');
  });

  it('returns expired when the securityStamp no longer matches', async () => {
    const store = fakeStore({ u1: member({ membership: activeMembership }) });
    const { access } = make({ store });
    const { token } = access.mintLinkToken(store.getById('u1'));
    await store.updateUser('u1', { securityStamp: 'rotated' }); // e.g. password change
    const r = await access.redeemLinkToken(token, from);
    expect(r.status).toBe('expired');
  });

  it('re-issues to the SAME Telegram account when asked again', async () => {
    const store = fakeStore({ u1: member({ membership: activeMembership, telegram: { userId: 555, linkState: 'joined' } }) });
    const { access } = make({ store });
    const { token } = access.mintLinkToken(store.getById('u1'));
    const r = await access.redeemLinkToken(token, { id: 555 });
    expect(r.status).toBe('ok');
  });

  it('refuses a DIFFERENT Telegram account on an already-linked user', async () => {
    const store = fakeStore({ u1: member({ membership: activeMembership, telegram: { userId: 555, linkState: 'joined' } }) });
    const { access } = make({ store });
    const { token } = access.mintLinkToken(store.getById('u1'));
    const r = await access.redeemLinkToken(token, { id: 999 });
    expect(r.status).toBe('already_linked');
  });

  it('returns error when the invite cannot be created', async () => {
    const store = fakeStore({ u1: member({ membership: activeMembership }) });
    const gate = fakeGate({ invite: null });
    const { access } = make({ store, gate });
    const { token } = access.mintLinkToken(store.getById('u1'));
    const r = await access.redeemLinkToken(token, from);
    expect(r.status).toBe('error');
  });
});

// --- sweep / revocation -----------------------------------------------------

describe('sweep', () => {
  it('kicks only ineligible joined members and is idempotent', async () => {
    const store = fakeStore({
      keep: { id: 'keep', membership: activeMembership, telegram: { userId: 1, linkState: 'joined' } },
      lapsed: { id: 'lapsed', membership: lapsedMembership, products: [], telegram: { userId: 2, linkState: 'joined' } },
      lifetime: { id: 'lifetime', membership: lapsedMembership, products: oneProduct, telegram: { userId: 3, linkState: 'joined' } },
      none: { id: 'none', membership: lapsedMembership, telegram: { userId: 4, linkState: 'none' } },
    });
    const { access, gate } = make({ store });

    await access.sweep();
    expect(gate._calls.kicks).toEqual([2]); // only the subscription-only lapse
    expect(store.getById('lapsed').telegram.linkState).toBe('kicked');
    expect(store.getById('keep').telegram.linkState).toBe('joined');
    expect(store.getById('lifetime').telegram.linkState).toBe('joined');

    // Second sweep: the kicked user is no longer 'joined', so no new kicks.
    await access.sweep();
    expect(gate._calls.kicks).toEqual([2]);
  });

  it('leaves state joined when the kick call fails, so it retries', async () => {
    const store = fakeStore({
      lapsed: { id: 'lapsed', membership: lapsedMembership, telegram: { userId: 2, linkState: 'joined' } },
    });
    const gate = fakeGate({ kickOk: false });
    const { access } = make({ store, gate });
    await access.sweep();
    expect(store.getById('lapsed').telegram.linkState).toBe('joined');
  });
});

// --- webhook update handling ------------------------------------------------

describe('handleUpdate', () => {
  it('DMs a single-use invite on a valid /start <token>', async () => {
    const store = fakeStore({ u1: member({ membership: activeMembership }) });
    const { access, gate } = make({ store });
    const { token } = access.mintLinkToken(store.getById('u1'));
    await access._test.handleUpdate({ message: { from: { id: 555 }, text: `/start ${token}` } });
    expect(gate._calls.dms.length).toBe(1);
    expect(gate._calls.dms[0].userId).toBe(555);
    expect(gate._calls.dms[0].text).toContain('https://t.me/+abc123');
  });

  it('prompts to use the account page on a bare /start', async () => {
    const { access, gate } = make();
    await access._test.handleUpdate({ message: { from: { id: 7 }, text: '/start' } });
    expect(gate._calls.dms[0].text).toContain('account page');
  });

  it('ignores updates with no sender', async () => {
    const { access, gate } = make();
    await access._test.handleUpdate({ message: { text: '/start abc' } });
    expect(gate._calls.dms.length).toBe(0);
  });

  it('ignores group/supergroup messages so it never spams the VIP group', async () => {
    const { access, gate } = make();
    await access._test.handleUpdate({ message: { from: { id: 9 }, chat: { type: 'supergroup' }, text: 'hello everyone' } });
    await access._test.handleUpdate({ message: { from: { id: 9 }, chat: { type: 'group' }, text: '/start' } });
    expect(gate._calls.dms.length).toBe(0);
  });

  it('still replies in a private chat', async () => {
    const { access, gate } = make();
    await access._test.handleUpdate({ message: { from: { id: 7 }, chat: { type: 'private' }, text: '/start' } });
    expect(gate._calls.dms.length).toBe(1);
  });
});

// --- configured flag --------------------------------------------------------

describe('configured', () => {
  it('false without a bot username or webhook secret', () => {
    expect(make({ botUsername: '' }).access.configured).toBe(false);
    expect(make({ webhookToken: '' }).access.configured).toBe(false);
  });
  it('false when the gate itself is unconfigured', () => {
    const gate = { ...fakeGate(), configured: false };
    expect(make({ gate }).access.configured).toBe(false);
  });
  it('true when everything is present', () => {
    expect(make().access.configured).toBe(true);
  });
});
