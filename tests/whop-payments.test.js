import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createWhopPayments, verifyWhopSignature } from '../lib/whop-payments.js';
import { createPaymentsStore } from '../lib/payments-store.js';

// Standard-Webhooks secret: "whsec_" + base64. The verifier strips the prefix and
// base64-decodes the rest into the HMAC key, so the tail must be valid base64.
const RAW_SECRET = Buffer.from('whop-standard-webhooks-test-secret').toString('base64');
const SECRET = `whsec_${RAW_SECRET}`;

/** Build the three Standard-Webhooks headers for a raw body. */
function whopSign(rawBody, { id = 'msg_1', t = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${t}.${rawBody}`, 'utf8').digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': String(t), 'webhook-signature': `v1,${sig}` };
}

function whopReq(bodyObj, opts = {}) {
  const raw = JSON.stringify(bodyObj);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = opts.headers || whopSign(raw, opts);
  return req;
}

function jsonReq(bodyObj) {
  const raw = JSON.stringify(bodyObj);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = {};
  return req;
}

function fakeRes() {
  return {
    statusCode: 0, body: '', headers: {},
    writeHead(s, h) { this.statusCode = s; if (h) Object.assign(this.headers, h); },
    end(b) { this.body = b || ''; },
  };
}

function fakeStore(initial = {}) {
  const users = JSON.parse(JSON.stringify(initial));
  return {
    getById: (id) => (users[id] ? JSON.parse(JSON.stringify(users[id])) : null),
    getByEmail: (email) => {
      const e = String(email || '').toLowerCase();
      const id = Object.keys(users).find((k) => (users[k].email || '').toLowerCase() === e);
      return id ? JSON.parse(JSON.stringify(users[id])) : null;
    },
    updateUser: async (id, patch) => { users[id] = { ...(users[id] || { id }), ...patch }; return { ok: true, user: users[id] }; },
    _users: users,
  };
}

function fakePayments() {
  const evts = {}; const txns = []; const unresolved = [];
  return {
    isWhopEventProcessed: (id) => Object.prototype.hasOwnProperty.call(evts, id),
    markWhopEvent: async (id) => { evts[id] = 1; },
    addTxn: async (uid, t) => { txns.push({ uid, ...t }); },
    addUnresolvedPayment: async (r) => { unresolved.push(r); return r; },
    _evts: evts, _txns: txns, _unresolved: unresolved,
  };
}

function make(overrides = {}) {
  const store = overrides.store
    || fakeStore({ u1: { id: 'u1', email: 'a@b.c', username: 'amy', profileComplete: true } });
  const payments = overrides.payments || fakePayments();
  const tg = []; const mails = []; const fetchCalls = [];
  const fetchImpl = overrides.fetchImpl || (async (url, opts) => {
    fetchCalls.push({ url: String(url), opts });
    if (String(url).includes('/checkout_sessions')) {
      return { ok: true, json: async () => ({ purchase_url: 'https://whop.com/checkout/plan_x/?session=ch_1', id: 'ch_1', redirect_url: JSON.parse(opts.body).redirect_url, metadata: JSON.parse(opts.body).metadata }) };
    }
    if (String(url).includes('/plans/')) {
      return { ok: true, json: async () => ({ initial_price: 28, renewal_price: 19.69, base_currency: 'usd', billing_period: 30 }) };
    }
    if (String(url).includes('/memberships')) {
      return { ok: true, json: async () => ({ data: overrides.memberships || [] }) };
    }
    return { ok: false, json: async () => ({}) };
  });
  const wp = createWhopPayments({
    store, currentUser: () => (overrides.user || null), paymentsStore: payments,
    baseUrl: 'http://localhost', apiKey: 'apiKey' in overrides ? overrides.apiKey : 'apik_test',
    webhookSecret: SECRET, planId: 'planId' in overrides ? overrides.planId : 'plan_x',
    companyId: 'biz_1', priceUsd: 47,
    products: overrides.products || null,
    fetchImpl,
    telegramNotifier: { notify: (t, p) => tg.push({ t, p }) },
    mailer: {
      sendMembershipGrantedEmail: async () => mails.push('membership'),
      sendProductGrantedEmail: async () => mails.push('product'),
      mailerConfigured: () => true,
    },
  });
  return { wp, store, payments, tg, mails, fetchCalls };
}

describe('verifyWhopSignature', () => {
  it('accepts a correctly signed payload', () => {
    const raw = JSON.stringify({ type: 'payment.succeeded' });
    expect(verifyWhopSignature(Buffer.from(raw), whopSign(raw), SECRET)).toBe(true);
  });
  it('rejects a forged signature', () => {
    const raw = JSON.stringify({ type: 'payment.succeeded' });
    const h = whopSign(raw);
    h['webhook-signature'] = 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    expect(verifyWhopSignature(Buffer.from(raw), h, SECRET)).toBe(false);
  });
  it('rejects a stale timestamp (outside the tolerance window)', () => {
    const raw = JSON.stringify({ type: 'payment.succeeded' });
    const old = Math.floor(Date.now() / 1000) - 4000;
    expect(verifyWhopSignature(Buffer.from(raw), whopSign(raw, { t: old }), SECRET)).toBe(false);
  });
  it('rejects when headers are missing', () => {
    expect(verifyWhopSignature(Buffer.from('{}'), {}, SECRET)).toBe(false);
  });

  // WHOP's real secret is `ws_<hex>`. We don't know which exact key derivation WHOP
  // uses, so the verifier tries them all — these prove the plausible ones accept.
  const WS_SECRET = `ws_${'a'.repeat(64)}`;
  const sigUnder = (key, raw, id = 'm', t = Math.floor(Date.now() / 1000)) => ({
    'webhook-id': id, 'webhook-timestamp': String(t),
    'webhook-signature': `v1,${crypto.createHmac('sha256', key).update(`${id}.${t}.${raw}`, 'utf8').digest('base64')}`,
  });
  it('accepts a ws_<hex> secret signed with the raw-string key (WHOP base64-encode scheme)', () => {
    const raw = JSON.stringify({ action: 'payment_succeeded' });
    expect(verifyWhopSignature(Buffer.from(raw), sigUnder(Buffer.from(WS_SECRET, 'utf8'), raw), WS_SECRET)).toBe(true);
  });
  it('accepts a ws_<hex> secret signed with the hex-decoded key', () => {
    const raw = JSON.stringify({ action: 'payment_succeeded' });
    expect(verifyWhopSignature(Buffer.from(raw), sigUnder(Buffer.from('a'.repeat(64), 'hex'), raw), WS_SECRET)).toBe(true);
  });
  it('still rejects a forged signature under a ws_ secret', () => {
    const raw = JSON.stringify({ action: 'payment_succeeded' });
    const h = { 'webhook-id': 'm', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
    expect(verifyWhopSignature(Buffer.from(raw), h, WS_SECRET)).toBe(false);
  });
});

describe('whop webhook — membership grant', () => {
  it('rejects a bad signature with 400', async () => {
    const { wp } = make();
    const req = whopReq({ type: 'payment.succeeded', data: {} });
    req.headers['webhook-signature'] = 'v1,deadbeef';
    const res = fakeRes();
    await wp._test.webhook(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('grants membership on payment_succeeded and fires email + telegram + ledger once (idempotent)', async () => {
    const { wp, store, payments, tg, mails } = make();
    const body = { action: 'payment_succeeded', data: { membership: 'mem_1', metadata: { userId: 'u1' }, final_amount: 1, currency: 'usd', user: { email: 'a@b.c' } } };
    const res1 = fakeRes();
    await wp._test.webhook(whopReq(body, { id: 'evt_1' }), res1);
    expect(res1.statusCode).toBe(200);

    const m = store._users.u1.membership;
    expect(m.provider).toBe('whop');
    expect(m.status).toBe('active');
    expect(m.interval).toBe('month');
    expect(m.whopMembershipId).toBe('mem_1');
    expect(m.currentPeriodEnd).toBeGreaterThan(Date.now());
    expect(mails).toEqual(['membership']);
    const sale = tg.filter((x) => x.t === 'whop_membership');
    expect(sale).toHaveLength(1);
    expect(sale[0].p).toMatchObject({ amount: 100, currency: 'usd' }); // $1.00 → 100 cents
    expect(payments._txns).toHaveLength(1);
    expect(payments._txns[0]).toMatchObject({ kind: 'whop.membership.paid', whopMembershipId: 'mem_1' });

    // Replay the SAME webhook-id → acknowledged as duplicate, no second grant.
    const res2 = fakeRes();
    await wp._test.webhook(whopReq(body, { id: 'evt_1' }), res2);
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.body).duplicate).toBe(true);
    expect(mails).toEqual(['membership']);
    expect(payments._txns).toHaveLength(1);
  });

  it('links the sale by email when metadata is absent (hosted-link fallback)', async () => {
    const { wp, store } = make();
    const body = { action: 'payment_succeeded', data: { membership: 'mem_2', final_amount: 1, user: { email: 'A@B.C' } } };
    const res = fakeRes();
    await wp._test.webhook(whopReq(body, { id: 'evt_email' }), res);
    expect(res.statusCode).toBe(200);
    expect(store._users.u1.membership.provider).toBe('whop');
    expect(store._users.u1.membership.status).toBe('active');
  });

  it('membership_activated grants access and announces (it carries metadata.userId)', async () => {
    const { wp, store, tg, mails } = make();
    const body = { action: 'membership_activated', data: { id: 'mem_3', metadata: { userId: 'u1' }, renewal_period_end: Math.floor(Date.now() / 1000) + 100000 } };
    const res = fakeRes();
    await wp._test.webhook(whopReq(body, { id: 'evt_valid' }), res);
    expect(res.statusCode).toBe(200);
    expect(store._users.u1.membership.status).toBe('active');
    expect(store._users.u1.membership.whopMembershipId).toBe('mem_3');
    expect(tg.filter((x) => x.t === 'whop_membership')).toHaveLength(1);
    expect(mails).toEqual(['membership']);
  });

  it('a payment + membership event for the same sale announces only once', async () => {
    const { wp, store, tg, mails, payments } = make();
    await wp._test.webhook(whopReq({ action: 'membership_activated', data: { id: 'mem_x', metadata: { userId: 'u1' } } }, { id: 'a' }), fakeRes());
    await wp._test.webhook(whopReq({ action: 'payment_succeeded', data: { membership: 'mem_x', metadata: { userId: 'u1' }, final_amount: 1 } }, { id: 'b' }), fakeRes());
    expect(store._users.u1.membership.status).toBe('active');
    expect(tg.filter((x) => x.t === 'whop_membership')).toHaveLength(1);
    expect(mails).toEqual(['membership']);
    expect(payments._txns).toHaveLength(1);
  });

  it('membership_deactivated revokes access', async () => {
    const { wp, store } = make();
    // First grant.
    await wp._test.webhook(whopReq({ action: 'payment_succeeded', data: { membership: 'mem_4', metadata: { userId: 'u1' }, final_amount: 1 } }, { id: 'g1' }), fakeRes());
    expect(store._users.u1.membership.status).toBe('active');
    // Then deactivate.
    const res = fakeRes();
    await wp._test.webhook(whopReq({ action: 'membership_deactivated', data: { id: 'mem_4', metadata: { userId: 'u1' } } }, { id: 'd1' }), res);
    expect(res.statusCode).toBe(200);
    expect(store._users.u1.membership.status).toBe('canceled');
    expect(store._users.u1.membership.currentPeriodEnd).toBeLessThanOrEqual(Date.now());
  });

  it('ignores unrelated events without touching membership', async () => {
    const { wp, store } = make();
    const res = fakeRes();
    await wp._test.webhook(whopReq({ action: 'entry_created', data: { metadata: { userId: 'u1' } } }, { id: 'e1' }), res);
    expect(res.statusCode).toBe(200);
    expect(store._users.u1.membership).toBeUndefined();
  });
});

// WHOP delivers events for EVERY plan in the company, and we fall back to matching
// the buyer's email when metadata is absent. A $0/$1 test plan on a hidden access
// pass would otherwise hand out full paid memberships to anyone whose email matched.
describe('whop webhook — only grants for the plan we sell', () => {
  it('ignores a grant for a different plan (the $0-test-plan free-access hole)', async () => {
    const { wp, store, payments, mails } = make();
    const res = fakeRes();
    await wp._test.webhook(whopReq({
      action: 'membership_activated',
      data: { id: 'mem_free', plan: 'plan_free_0usd', user: { email: 'a@b.c' } },
    }, { id: 'hole1' }), res);
    expect(res.statusCode).toBe(200);
    expect(store._users.u1.membership).toBeUndefined();
    expect(mails).toEqual([]);
    expect(payments._txns).toHaveLength(0);
  });

  it('ignores a grant for a foreign plan even when metadata names our user', async () => {
    const { wp, store } = make();
    await wp._test.webhook(whopReq({
      action: 'payment_succeeded',
      data: { membership: 'mem_f', plan: 'plan_other', metadata: { userId: 'u1' }, final_amount: 0 },
    }, { id: 'hole2' }), fakeRes());
    expect(store._users.u1.membership).toBeUndefined();
  });

  it('does NOT revoke a paid member when a foreign plan deactivates', async () => {
    const { wp, store } = make();
    // Real sale on our plan first.
    await wp._test.webhook(whopReq({
      action: 'payment_succeeded',
      data: { membership: 'mem_real', plan: 'plan_x', metadata: { userId: 'u1' }, final_amount: 28 },
    }, { id: 'real1' }), fakeRes());
    expect(store._users.u1.membership.status).toBe('active');

    // A cancellation on some other plan in the account must not touch it.
    await wp._test.webhook(whopReq({
      action: 'membership_deactivated',
      data: { id: 'mem_free', plan: 'plan_free_0usd', metadata: { userId: 'u1' } },
    }, { id: 'hole3' }), fakeRes());
    expect(store._users.u1.membership.status).toBe('active');
  });

  it('still grants when the plan id matches, including nested under membership', async () => {
    const { wp, store } = make();
    await wp._test.webhook(whopReq({
      action: 'payment_succeeded',
      data: { membership: { id: 'mem_n', plan: 'plan_x' }, metadata: { userId: 'u1' }, final_amount: 28 },
    }, { id: 'ok1' }), fakeRes());
    expect(store._users.u1.membership.status).toBe('active');
  });

  it('fails open when the payload carries no plan id at all', async () => {
    const { wp, store } = make();
    await wp._test.webhook(whopReq({
      action: 'payment_succeeded',
      data: { membership: 'mem_nop', metadata: { userId: 'u1' }, final_amount: 28 },
    }, { id: 'ok2' }), fakeRes());
    expect(store._users.u1.membership.status).toBe('active');
  });
});

describe('whop checkout', () => {
  it('creates a checkout session with metadata.userId and returns the purchase_url', async () => {
    const user = { id: 'u1', email: 'a@b.c', profileComplete: true };
    const { wp, fetchCalls } = make({ user });
    const res = fakeRes();
    await wp._test.checkout(jsonReq({ next: '/videos' }), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).url).toBe('https://whop.com/checkout/plan_x/?session=ch_1');
    const call = fetchCalls.find((c) => c.url.includes('/checkout_sessions'));
    expect(call).toBeTruthy();
    expect(call.url).toContain('/api/v2/checkout_sessions'); // v2 endpoint, not v1
    const sent = JSON.parse(call.opts.body);
    expect(sent.plan_id).toBe('plan_x');
    expect(sent.metadata.userId).toBe('u1');
    expect(sent.redirect_url).toContain('/membership.html?status=success');
    expect(sent.redirect_url).toContain('next=%2Fvideos');
  });

  it('401s when signed out', async () => {
    const { wp } = make({ user: null });
    const res = fakeRes();
    await wp._test.checkout(jsonReq({}), res);
    expect(res.statusCode).toBe(401);
  });

  it('allows checkout for a fresh account with no completed profile (regression: removed 403 gate)', async () => {
    const user = { id: 'u1', email: 'a@b.c' }; // no profileComplete, no username
    const { wp } = make({ user });
    const res = fakeRes();
    await wp._test.checkout(jsonReq({}), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).url).toBeTruthy();
  });

  it('409s when already an active member', async () => {
    const user = { id: 'u1', email: 'a@b.c', profileComplete: true, membership: { provider: 'whop', status: 'active', currentPeriodEnd: Date.now() + 1_000_000 } };
    const { wp } = make({ user });
    const res = fakeRes();
    await wp._test.checkout(jsonReq({}), res);
    expect(res.statusCode).toBe(409);
  });

  it('falls back to the hosted checkout link when the API call fails', async () => {
    const user = { id: 'u1', email: 'a@b.c', profileComplete: true };
    const { wp } = make({
      user,
      fetchImpl: async (url) => { if (String(url).includes('/checkout_sessions')) throw new Error('boom'); return { ok: false, json: async () => ({}) }; },
    });
    const res = fakeRes();
    await wp._test.checkout(jsonReq({}), res);
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    expect(out.url).toBe('https://whop.com/checkout/plan_x');
    expect(out.degraded).toBe(true);
  });

  it('503s when WHOP is not configured', async () => {
    const user = { id: 'u1', email: 'a@b.c', profileComplete: true };
    const { wp } = make({ user, apiKey: undefined });
    const res = fakeRes();
    await wp._test.checkout(jsonReq({}), res);
    expect(res.statusCode).toBe(503);
  });
});

describe('whop reconcile', () => {
  it('grants from a live membership lookup when the webhook lagged', async () => {
    const user = { id: 'u1', email: 'a@b.c', profileComplete: true };
    const { wp, store } = make({ user, memberships: [{ id: 'mem_9', metadata: { userId: 'u1' }, valid: true, currency: 'usd' }] });
    const res = fakeRes();
    await wp._test.reconcile(jsonReq({}), res);
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    expect(out.ok).toBe(true);
    expect(out.membership.active).toBe(true);
    expect(out.membership.provider).toBe('whop');
    expect(store._users.u1.membership.whopMembershipId).toBe('mem_9');
  });

  it('returns the current summary without error when no membership is found', async () => {
    const user = { id: 'u1', email: 'a@b.c', profileComplete: true };
    const { wp } = make({ user, memberships: [] });
    const res = fakeRes();
    await wp._test.reconcile(jsonReq({}), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).membership.active).toBe(false);
  });

  // Reconcile is reachable by any signed-in user, so it must apply the same plan
  // guard as the webhook — otherwise a $0/test-plan membership self-serves access.
  it('will not grant from a membership on a plan we do not sell', async () => {
    const user = { id: 'u1', email: 'a@b.c', profileComplete: true };
    const { wp, store } = make({
      user,
      memberships: [{ id: 'mem_free', plan: 'plan_free_0usd', metadata: { userId: 'u1' }, valid: true }],
    });
    const res = fakeRes();
    await wp._test.reconcile(jsonReq({}), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).membership.active).toBe(false);
    expect(store._users.u1.membership).toBeUndefined();
  });

  it('still grants from a membership on the plan we do sell', async () => {
    const user = { id: 'u1', email: 'a@b.c', profileComplete: true };
    const { wp, store } = make({
      user,
      memberships: [{ id: 'mem_ok', plan: 'plan_x', metadata: { userId: 'u1' }, valid: true }],
    });
    await wp._test.reconcile(jsonReq({}), fakeRes());
    expect(store._users.u1.membership.whopMembershipId).toBe('mem_ok');
  });
});

describe('whop config', () => {
  it('reports enabled + the live plan price', async () => {
    const { wp } = make();
    const res = fakeRes();
    await wp._test.config({ method: 'GET', headers: {} }, res);
    expect(res.statusCode).toBe(200);
    const cfg = JSON.parse(res.body);
    expect(cfg.enabled).toBe(true);
    expect(cfg.cardEnabled).toBe(true);
    expect(cfg.price).toBe(28);            // initial_price (first charge / signup)
    expect(cfg.renewalPrice).toBe(19.69);  // ongoing monthly
    expect(cfg.currency).toBe('usd');
    expect(cfg.interval).toBe('month');
  });

  it('reports disabled when WHOP is not configured', async () => {
    const { wp } = make({ apiKey: undefined });
    const res = fakeRes();
    await wp._test.config({ method: 'GET', headers: {} }, res);
    const cfg = JSON.parse(res.body);
    expect(cfg.enabled).toBe(false);
    expect(cfg.cardEnabled).toBe(false);
  });
});

// A WHOP payment that can't be mapped to an account used to be a console.error and
// nothing else — the buyer had a charge, no access, and nobody would ever find out.
describe('whop webhook — unresolvable payments are escalated, not swallowed', () => {
  it('alerts the owner and records the case when no account matches the buyer', async () => {
    const { wp, payments, tg } = make();
    const res = fakeRes();
    await wp._test.webhook(whopReq({
      action: 'payment_succeeded',
      data: { membership: 'mem_orphan', plan: 'plan_x', final_amount: 28, currency: 'usd', user: { email: 'someone-else@whop.example' } },
    }, { id: 'orph1' }), res);
    // Still 200: WHOP must not retry forever over something only a human can fix.
    expect(res.statusCode).toBe(200);
    expect(payments._unresolved.map((r) => r.kind)).toEqual(['whop.grant.unresolvable']);
    expect(payments._unresolved[0].email).toBe('someone-else@whop.example');
    expect(payments._unresolved[0].reference).toBe('mem_orphan');
    const alerts = tg.filter((x) => x.t === 'payment_needs_attention');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].p).toMatchObject({ reason: 'whop.grant.unresolvable' });
  });

  it('alerts when the resolved account no longer exists (grant LOST)', async () => {
    const { wp, payments, tg } = make();
    // metadata names a user id that isn't in the store.
    await wp._test.webhook(whopReq({
      action: 'payment_succeeded',
      data: { membership: 'mem_gone', plan: 'plan_x', metadata: { userId: 'ghost' }, final_amount: 28 },
    }, { id: 'orph2' }), fakeRes());
    // resolveUid rejects an unknown id, so this lands on the unresolvable path —
    // either way the money is flagged rather than silently dropped.
    expect(payments._unresolved).toHaveLength(1);
    expect(tg.filter((x) => x.t === 'payment_needs_attention')).toHaveLength(1);
  });

  it('a normal sale raises no attention record', async () => {
    const { wp, payments, tg } = make();
    await wp._test.webhook(whopReq({
      action: 'payment_succeeded',
      data: { membership: 'mem_fine', plan: 'plan_x', metadata: { userId: 'u1' }, final_amount: 28 },
    }, { id: 'fine1' }), fakeRes());
    expect(payments._unresolved).toHaveLength(0);
    expect(tg.filter((x) => x.t === 'payment_needs_attention')).toHaveLength(0);
    expect(tg.filter((x) => x.t === 'whop_membership')).toHaveLength(1);
  });
});

// The degraded fallback sends the buyer to a bare hosted link with NO metadata and
// NO redirect_url, so the webhook can only match by WHOP email and reconcile never
// runs. If their WHOP email differs from their site email, they paid for nothing.
// The pending-checkout record recorded at checkout time is the bridge.
describe('whop degraded checkout — pending-checkout bridge', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbtv-whop-')), 'payments.json');

  function makeReal({ failSessions = false, user } = {}) {
    const payments = createPaymentsStore(tmp());
    const fetchImpl = async (url, opts) => {
      if (String(url).includes('/checkout_sessions')) {
        if (failSessions) throw new Error('boom');
        return { ok: true, json: async () => ({ purchase_url: 'https://whop.com/checkout/x', id: 'ch_1' }) };
      }
      if (String(url).includes('/plans/')) return { ok: true, json: async () => ({ initial_price: 28, renewal_price: 19.69 }) };
      return { ok: true, json: async () => ({ data: [] }) };
    };
    return { payments, ...make({ payments, user, fetchImpl }) };
  }

  it('records a pending checkout before calling WHOP', async () => {
    const user = { id: 'u1', email: 'site@example.com' };
    const { wp, payments } = makeReal({ user });
    await wp._test.checkout(jsonReq({}), fakeRes());
    await payments.flush();
    expect(payments.listPendingWhopCheckouts().map((r) => r.userId)).toEqual(['u1']);
  });

  it('flags the degraded fallback so a sale that will not self-unlock is visible', async () => {
    const user = { id: 'u1', email: 'site@example.com' };
    const { wp, payments, tg } = makeReal({ user, failSessions: true });
    const res = fakeRes();
    await wp._test.checkout(jsonReq({}), res);
    await payments.flush();
    // Still 200 with a usable pay link — a dead button would be worse.
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).degraded).toBe(true);
    const alerts = tg.filter((x) => x.t === 'payment_needs_attention');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].p).toMatchObject({ reason: 'whop.checkout.degraded' });
    expect(payments.listPendingWhopCheckouts()[0].degraded).toBe(true);
  });

  it('attributes a metadata-less, email-mismatched sale via the pending record', async () => {
    // Site account email differs from the email they used on WHOP — the exact case
    // that previously produced "money in, no access".
    const store = fakeStore({ u1: { id: 'u1', email: 'site@example.com', username: 'amy' } });
    const payments = createPaymentsStore(tmp());
    const { wp } = make({ store, payments, user: { id: 'u1', email: 'site@example.com' } });
    await wp._test.checkout(jsonReq({}), fakeRes());
    await payments.flush();

    await wp._test.webhook(whopReq({
      action: 'payment_succeeded',
      data: { membership: 'mem_d', plan: 'plan_x', final_amount: 28, user: { email: 'different@whop.example' } },
    }, { id: 'deg1' }), fakeRes());

    expect(store._users.u1.membership).toBeTruthy();
    expect(store._users.u1.membership.status).toBe('active');
    // Bridge consumed once the sale landed.
    await payments.flush();
    expect(payments.listPendingWhopCheckouts()).toHaveLength(0);
  });

  it('refuses to guess when two buyers have pending checkouts on the same plan', async () => {
    const store = fakeStore({
      u1: { id: 'u1', email: 'one@example.com', username: 'one' },
      u2: { id: 'u2', email: 'two@example.com', username: 'two' },
    });
    const payments = createPaymentsStore(tmp());
    await payments.addPendingWhopCheckout({ userId: 'u1', planId: 'plan_x', email: 'one@example.com' });
    await payments.addPendingWhopCheckout({ userId: 'u2', planId: 'plan_x', email: 'two@example.com' });
    const { wp, tg } = make({ store, payments });

    await wp._test.webhook(whopReq({
      action: 'payment_succeeded',
      data: { membership: 'mem_amb', plan: 'plan_x', final_amount: 28, user: { email: 'nobody@whop.example' } },
    }, { id: 'amb1' }), fakeRes());

    // Granting the wrong person is worse than making David resolve it by hand.
    expect(store._users.u1.membership).toBeUndefined();
    expect(store._users.u2.membership).toBeUndefined();
    expect(tg.filter((x) => x.t === 'payment_needs_attention')).toHaveLength(1);
  });
});

// One-time products (the $299 course) on the card rail. Until now products were
// ETH-only: course.js hid the buy button unconditionally, so the page showed a
// price with nothing to click whenever crypto was off.
describe('whop product rail (one-time course purchases)', () => {
  const COURSE = { id: 'prod_dp', name: 'Digital Pickup 2.0', slug: 'digital-pickup-2-0', price: 29900, currency: 'usd', published: true, whopPlanId: 'plan_course' };

  function productStore(overrides = {}) {
    const p = { ...COURSE, ...overrides };
    return { getById: (id) => (id === p.id ? p : null), list: () => [p] };
  }

  function makeP({ user, product = productStore(), store } = {}) {
    const s = store || fakeStore({ u1: { id: 'u1', email: 'a@b.c', username: 'amy', products: [] } });
    s.addProductEntitlement = async (id, entry) => {
      const u = s._users[id];
      if (!u) return { ok: false, added: false };
      if (!Array.isArray(u.products)) u.products = [];
      if (u.products.some((x) => x && x.productId === entry.productId)) return { ok: true, added: false };
      u.products.push(entry);
      return { ok: true, added: true };
    };
    return make({ store: s, user, products: product });
  }

  it('stamps productId in checkout metadata so the sale maps to the right thing', async () => {
    const { wp, fetchCalls } = makeP({ user: { id: 'u1', email: 'a@b.c', products: [] } });
    const res = fakeRes();
    await wp._test.productCheckout(jsonReq({ productId: 'prod_dp' }), res);
    expect(res.statusCode).toBe(200);
    const session = fetchCalls.find((c) => c.url.includes('/checkout_sessions'));
    const body = JSON.parse(session.opts.body);
    expect(body.plan_id).toBe('plan_course');
    expect(body.metadata).toMatchObject({ userId: 'u1', productId: 'prod_dp' });
    expect(body.redirect_url).toContain('/courses/digital-pickup-2-0');
  });

  it('401s an anonymous buyer and 409s someone who already owns it', async () => {
    const anon = makeP({ user: null });
    const r1 = fakeRes();
    await anon.wp._test.productCheckout(jsonReq({ productId: 'prod_dp' }), r1);
    expect(r1.statusCode).toBe(401);

    const owner = makeP({ user: { id: 'u1', email: 'a@b.c', products: [{ productId: 'prod_dp' }] } });
    const r2 = fakeRes();
    await owner.wp._test.productCheckout(jsonReq({ productId: 'prod_dp' }), r2);
    expect(r2.statusCode).toBe(409);
  });

  it('refuses a product with no WHOP plan configured (stays crypto-only)', async () => {
    const { wp } = makeP({ user: { id: 'u1', email: 'a@b.c', products: [] }, product: productStore({ whopPlanId: null }) });
    const res = fakeRes();
    await wp._test.productCheckout(jsonReq({ productId: 'prod_dp' }), res);
    expect(res.statusCode).toBe(503);
  });

  it('grants the PRODUCT — not a membership — on a course sale', async () => {
    const { wp, store, payments } = makeP({});
    await wp._test.webhook(whopReq({
      action: 'payment_succeeded',
      data: { membership: 'mem_c1', plan: 'plan_course', metadata: { userId: 'u1', productId: 'prod_dp' }, final_amount: 299, currency: 'usd' },
    }, { id: 'crs1' }), fakeRes());
    expect(store._users.u1.products.map((p) => p.productId)).toEqual(['prod_dp']);
    expect(store._users.u1.membership).toBeUndefined();   // critically NOT a subscription
    expect(payments._txns[0]).toMatchObject({ kind: 'whop.product.paid', productId: 'prod_dp', amountCents: 29900 });
  });

  it('identifies the product by plan id alone when metadata is lost', async () => {
    const { wp, store } = makeP({});
    await wp._test.webhook(whopReq({
      action: 'membership_activated',
      data: { id: 'mem_c2', plan: 'plan_course', user: { email: 'a@b.c' } },
    }, { id: 'crs2' }), fakeRes());
    expect(store._users.u1.products.map((p) => p.productId)).toEqual(['prod_dp']);
    expect(store._users.u1.membership).toBeUndefined();
  });

  it('grants once when both payment and membership events arrive for one sale', async () => {
    const { wp, store, mails, payments } = makeP({});
    await wp._test.webhook(whopReq({ action: 'payment_succeeded', data: { membership: 'mem_c3', plan: 'plan_course', metadata: { userId: 'u1', productId: 'prod_dp' }, final_amount: 299 } }, { id: 'a1' }), fakeRes());
    await wp._test.webhook(whopReq({ action: 'membership_activated', data: { id: 'mem_c3', plan: 'plan_course', metadata: { userId: 'u1', productId: 'prod_dp' } } }, { id: 'a2' }), fakeRes());
    expect(store._users.u1.products).toHaveLength(1);
    expect(payments._txns.filter((t) => t.kind === 'whop.product.paid')).toHaveLength(1);
    expect(mails.filter((m) => m === 'product')).toHaveLength(1);
  });

  it('a refunded course revokes the course, not the membership', async () => {
    const { wp, store } = makeP({});
    // Buyer owns the course AND has a live membership.
    await wp._test.webhook(whopReq({ action: 'payment_succeeded', data: { membership: 'mem_c4', plan: 'plan_course', metadata: { userId: 'u1', productId: 'prod_dp' }, final_amount: 299 } }, { id: 'b1' }), fakeRes());
    await wp._test.webhook(whopReq({ action: 'payment_succeeded', data: { membership: 'mem_m1', plan: 'plan_x', metadata: { userId: 'u1' }, final_amount: 28 } }, { id: 'b2' }), fakeRes());
    expect(store._users.u1.membership.status).toBe('active');

    await wp._test.webhook(whopReq({ action: 'membership_deactivated', data: { id: 'mem_c4', plan: 'plan_course', metadata: { userId: 'u1', productId: 'prod_dp' } } }, { id: 'b3' }), fakeRes());
    expect(store._users.u1.products).toHaveLength(0);              // course gone
    expect(store._users.u1.membership.status).toBe('active');      // membership intact
  });

  it('the plan guard accepts product plans (it would otherwise reject every course sale)', async () => {
    const { wp, store } = makeP({});
    await wp._test.webhook(whopReq({
      action: 'payment_succeeded',
      data: { membership: 'mem_c5', plan: 'plan_course', metadata: { userId: 'u1', productId: 'prod_dp' }, final_amount: 299 },
    }, { id: 'g9' }), fakeRes());
    expect(store._users.u1.products).toHaveLength(1);
    // …but an unknown plan is still refused.
    await wp._test.webhook(whopReq({
      action: 'payment_succeeded',
      data: { membership: 'mem_c6', plan: 'plan_stranger', metadata: { userId: 'u1' }, final_amount: 0 },
    }, { id: 'g10' }), fakeRes());
    expect(store._users.u1.membership).toBeUndefined();
  });
});

// Access is granted in 33-day chunks and extended by renewal webhooks. If those stop
// arriving nothing errors — every member just quietly loses access 33 days later.
describe('whop silent-lapse guard', () => {
  const DAY = 24 * 60 * 60 * 1000;
  function storeWith(users) {
    const s = fakeStore(users);
    s.listAll = () => Object.values(s._users).map((u) => JSON.parse(JSON.stringify(u)));
    return s;
  }
  const member = (over = {}) => ({
    id: 'u1', email: 'a@b.c', username: 'amy',
    membership: { provider: 'whop', status: 'active', currentPeriodEnd: Date.now() + 2 * DAY, ...over },
  });

  it('warns when a member is about to lapse with no renewal event', async () => {
    const store = storeWith({ u1: member() });
    const { wp, payments, tg } = make({ store });
    const out = await wp.sweepExpiringMemberships();
    expect(out.warned).toBe(1);
    expect(payments._unresolved.map((r) => r.kind)).toEqual(['whop.membership.expiring']);
    expect(tg.filter((x) => x.t === 'payment_needs_attention')).toHaveLength(1);
  });

  it('warns only once per period', async () => {
    const store = storeWith({ u1: member() });
    const { wp, tg } = make({ store });
    await wp.sweepExpiringMemberships();
    await wp.sweepExpiringMemberships();
    expect(tg.filter((x) => x.t === 'payment_needs_attention')).toHaveLength(1);
  });

  it('warns again after a renewal moves the expiry out', async () => {
    const store = storeWith({ u1: member() });
    const { wp, tg } = make({ store });
    await wp.sweepExpiringMemberships();
    // Renewal lands, then that new period also approaches its end.
    const m = store._users.u1.membership;
    await store.updateUser('u1', { membership: { ...m, currentPeriodEnd: Date.now() + 1 * DAY } });
    await wp.sweepExpiringMemberships();
    expect(tg.filter((x) => x.t === 'payment_needs_attention')).toHaveLength(2);
  });

  it('ignores a member with plenty of time left', async () => {
    const store = storeWith({ u1: member({ currentPeriodEnd: Date.now() + 20 * DAY }) });
    const { wp, tg } = make({ store });
    expect((await wp.sweepExpiringMemberships()).warned).toBe(0);
    expect(tg).toHaveLength(0);
  });

  it('ignores a deliberate cancellation — that is not a fault', async () => {
    const store = storeWith({ u1: member({ cancelAtPeriodEnd: true }) });
    const { wp, tg } = make({ store });
    expect((await wp.sweepExpiringMemberships()).warned).toBe(0);
    expect(tg).toHaveLength(0);
  });

  it('ignores already-expired and non-whop memberships', async () => {
    const store = storeWith({
      u1: member({ currentPeriodEnd: Date.now() - DAY }),
      u2: { id: 'u2', email: 'c@d.e', membership: { provider: 'crypto', status: 'active', currentPeriodEnd: Date.now() + DAY } },
    });
    const { wp, tg } = make({ store });
    expect((await wp.sweepExpiringMemberships()).warned).toBe(0);
    expect(tg).toHaveLength(0);
  });
});
