import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createWhopPayments, verifyWhopSignature } from '../lib/whop-payments.js';

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
  const evts = {}; const txns = [];
  return {
    isWhopEventProcessed: (id) => Object.prototype.hasOwnProperty.call(evts, id),
    markWhopEvent: async (id) => { evts[id] = 1; },
    addTxn: async (uid, t) => { txns.push({ uid, ...t }); },
    _evts: evts, _txns: txns,
  };
}

function make(overrides = {}) {
  const store = overrides.store
    || fakeStore({ u1: { id: 'u1', email: 'a@b.c', username: 'amy', profileComplete: true } });
  const payments = overrides.payments || fakePayments();
  const tg = []; const mails = []; const fetchCalls = [];
  const fetchImpl = overrides.fetchImpl || (async (url, opts) => {
    fetchCalls.push({ url: String(url), opts });
    if (String(url).includes('/checkout-configurations')) {
      return { ok: true, json: async () => ({ purchase_url: 'https://whop.com/checkout/plan_x/sess', id: 'ch_1' }) };
    }
    if (String(url).includes('/plans/')) {
      return { ok: true, json: async () => ({ initial_price: 1, base_currency: 'usd', billing_period: 30 }) };
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
    fetchImpl,
    telegramNotifier: { notify: (t, p) => tg.push({ t, p }) },
    mailer: {
      sendMembershipGrantedEmail: async () => mails.push('membership'),
      sendProductGrantedEmail: async () => {},
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

describe('whop checkout', () => {
  it('creates a checkout session with metadata.userId and returns the purchase_url', async () => {
    const user = { id: 'u1', email: 'a@b.c', profileComplete: true };
    const { wp, fetchCalls } = make({ user });
    const res = fakeRes();
    await wp._test.checkout(jsonReq({ next: '/videos' }), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).url).toBe('https://whop.com/checkout/plan_x/sess');
    const call = fetchCalls.find((c) => c.url.includes('/checkout-configurations'));
    expect(call).toBeTruthy();
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
      fetchImpl: async (url) => { if (String(url).includes('/checkout-configurations')) throw new Error('boom'); return { ok: false, json: async () => ({}) }; },
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
    expect(cfg.price).toBe(1);          // initial_price from the plan lookup
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
