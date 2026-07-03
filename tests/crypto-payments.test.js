import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createCryptoPayments } from '../lib/crypto-payments.js';

const SECRET = 'whsec_crypto_test';

function fakeStore(initial = {}) {
  const users = JSON.parse(JSON.stringify(initial));
  return {
    getById: (id) => (users[id] ? JSON.parse(JSON.stringify(users[id])) : null),
    updateUser: async (id, patch) => { users[id] = { ...(users[id] || { id }), ...patch }; return { ok: true, user: users[id] }; },
    addProductEntitlement: async (id, entry) => {
      const u = users[id];
      if (!u) return { ok: false, added: false };
      if (!Array.isArray(u.products)) u.products = [];
      const dup = u.products.some((p) => p && p.productId === entry.productId);
      if (dup) return { ok: true, added: false };
      u.products.push(entry);
      return { ok: true, added: true };
    },
    _users: users,
  };
}

function fakeOrders() {
  const orders = {}; const cbs = {};
  return {
    create: async (o) => { orders[o.id] = { ...o }; return orders[o.id]; },
    get: (id) => (orders[id] ? { ...orders[id] } : null),
    update: async (id, p) => { if (orders[id]) Object.assign(orders[id], p); return orders[id]; },
    listOpen: () => Object.values(orders).filter((o) => o.status === 'waiting'),
    findActiveByUser: (userId, nowTs = Date.now()) => {
      const inFlight = (o) => o.status === 'detected' || o.status === 'confirmed'
        || (o.status === 'waiting' && (!o.expiresAt || nowTs <= o.expiresAt));
      const mine = Object.values(orders).filter((o) => o.userId === userId && inFlight(o));
      if (!mine.length) return null;
      mine.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return { ...mine[0] };
    },
    isCallbackProcessed: (id) => Object.prototype.hasOwnProperty.call(cbs, id),
    markCallback: async (id) => { cbs[id] = 1; },
    flush: async () => {},
    _orders: orders, _cbs: cbs,
  };
}

function sign(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

function webhookReq(bodyObj) {
  const raw = JSON.stringify(bodyObj);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = { 'x-crypto-signature': sign(raw, SECRET) };
  return req;
}
function fakeRes() {
  return { statusCode: 0, body: '', headers: {},
    writeHead(s, h) { this.statusCode = s; if (h) Object.assign(this.headers, h); },
    end(b) { this.body = b || ''; } };
}

function make(overrides = {}) {
  const store = overrides.store || fakeStore({ u1: { id: 'u1', email: 'a@b.c', username: 'amy', products: [] } });
  const orders = overrides.orders || fakeOrders();
  const tg = []; const mails = [];
  const cp = createCryptoPayments({
    store, ordersStore: orders, currentUser: () => null,
    baseUrl: 'http://localhost', webhookSecret: SECRET,
    products: { getById: (id) => ({ id, name: 'Course', slug: 'course' }) },
    pricing: { getConfig: () => ({ currency: 'usd', monthly: { amount: 1700 }, yearly: { enabled: true, amount: 12000 } }) },
    paymentsStore: { addTxn: async () => {} },
    telegramNotifier: { notify: (t, p) => tg.push({ t, p }) },
    mailer: { sendProductGrantedEmail: async () => mails.push('product'), sendMembershipGrantedEmail: async () => mails.push('membership'), sendCryptoPaymentDetectedEmail: async () => mails.push('detected'), mailerConfigured: () => true },
  });
  return { cp, store, orders, tg, mails };
}

describe('crypto webhook', () => {
  it('rejects a bad signature', async () => {
    const { cp } = make();
    const req = webhookReq({ orderId: 'o1', coin: 'ETH', amount: '0.05', confirmations: 6 });
    req.headers['x-crypto-signature'] = 't=1,v1=deadbeef';
    const res = fakeRes();
    await cp._test.webhook(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('grants a product on a confirmed callback and fires email + telegram once', async () => {
    const { cp, store, orders, tg, mails } = make();
    await orders.create({ id: 'o1', userId: 'u1', kind: 'product', productId: 'p1', coin: 'ETH', amount: '0.05', expectedFiat: 269.1, status: 'waiting', confirmations: 6 });
    const body = { orderId: 'o1', coin: 'ETH', txid: '0xabc', amount: '0.05', confirmations: 6 };
    const res1 = fakeRes();
    await cp._test.webhook(webhookReq(body), res1);
    expect(res1.statusCode).toBe(200);
    expect(store._users.u1.products).toHaveLength(1);
    expect(orders._orders.o1.status).toBe('granted');
    expect(mails).toEqual(['product']);
    // The crypto sale must use the crypto-specific template carrying the COIN
    // amount + USD value (not the Stripe new_subscription/course_purchase shape).
    const courseTg = tg.filter((x) => x.t === 'crypto_course');
    expect(courseTg).toHaveLength(1);
    expect(courseTg[0].p).toMatchObject({ coinAmount: '0.05', coin: 'ETH', usd: 269.1 });

    const res2 = fakeRes();
    await cp._test.webhook(webhookReq(body), res2);
    expect(res2.statusCode).toBe(200);
    expect(store._users.u1.products).toHaveLength(1);
    expect(mails).toEqual(['product']);
  });

  it('marks an order underpaid and alerts the owner without granting', async () => {
    const { cp, store, orders, tg, mails } = make();
    await orders.create({ id: 'u3', userId: 'u1', kind: 'product', productId: 'p1', coin: 'ETH', amount: '0.05', status: 'waiting', confirmations: 6 });
    const res = fakeRes();
    await cp._test.webhook(webhookReq({ orderId: 'u3', coin: 'ETH', outcome: 'underpaid', amount: '0.05', confirmations: 6 }), res);
    expect(res.statusCode).toBe(200);
    expect(orders._orders.u3.status).toBe('underpaid');
    expect(store._users.u1.products).toHaveLength(0);   // NOT granted
    expect(mails).toEqual([]);                            // no grant email
    expect(tg.filter((x) => x.t === 'crypto_underpaid')).toHaveLength(1);
  });

  it('grants fixed-term membership on a confirmed callback', async () => {
    const { cp, store, orders, tg } = make();
    await orders.create({ id: 'm1', userId: 'u1', kind: 'membership', termMonths: 3, coin: 'ETH', amount: '0.0834', expectedFiat: 59.07, status: 'waiting', confirmations: 6 });
    const res = fakeRes();
    await cp._test.webhook(webhookReq({ orderId: 'm1', coin: 'ETH', txid: 't', amount: '0.0834', confirmations: 6 }), res);
    expect(res.statusCode).toBe(200);
    expect(store._users.u1.membership.provider).toBe('crypto');
    expect(store._users.u1.membership.status).toBe('active');
    expect(store._users.u1.membership.interval).toBe('3mo');
    expect(store._users.u1.membership.currentPeriodEnd).toBeGreaterThan(Date.now());
    // Telegram sale alert uses the crypto template with coin amount + USD value.
    const saleTg = tg.filter((x) => x.t === 'crypto_membership');
    expect(saleTg).toHaveLength(1);
    expect(saleTg[0].p).toMatchObject({ coinAmount: '0.0834', coin: 'ETH', usd: 59.07, interval: '3mo' });
  });

  it('membership grant is idempotent for the same order (no double-stack)', async () => {
    const { cp, store, orders } = make();
    await orders.create({ id: 'm2', userId: 'u1', kind: 'membership', termMonths: 3, coin: 'LTC', amount: '1.0', status: 'waiting', confirmations: 6 });
    const order = orders.get('m2');
    await cp._test.grantMembership(order);
    const end1 = store._users.u1.membership.currentPeriodEnd;
    await cp._test.grantMembership(order); // same order again — must NOT stack
    const end2 = store._users.u1.membership.currentPeriodEnd;
    expect(end2).toBe(end1);
  });

  it('emails the buyer once when payment is first detected, and not on repeat detected callbacks', async () => {
    const { cp, orders, mails } = make();
    await orders.create({ id: 'e1', userId: 'u1', kind: 'membership', termMonths: 3, coin: 'ETH', amount: '0.0834', expectedFiat: 59.07, status: 'waiting', confirmations: 1, productId: null });
    const r1 = fakeRes();
    await cp._test.webhook(webhookReq({ orderId: 'e1', coin: 'ETH', outcome: 'detected', txid: '0xaa', amount: '0.0834', confirmations: 0 }), r1);
    expect(orders._orders.e1.status).toBe('detected');
    expect(mails).toEqual(['detected']);
    expect(orders._orders.e1.detectedEmailedAt).toBeTruthy();
    const r2 = fakeRes();
    await cp._test.webhook(webhookReq({ orderId: 'e1', coin: 'ETH', outcome: 'detected', txid: '0xaa', amount: '0.0834', confirmations: 0 }), r2);
    expect(mails).toEqual(['detected']); // not re-sent
  });

  it('marks detected on a broadcast callback without granting, then grants on confirm', async () => {
    const { cp, store, orders } = make();
    await orders.create({ id: 'd1', userId: 'u1', kind: 'product', productId: 'p1', coin: 'ETH', amount: '0.05', status: 'waiting', confirmations: 1 });
    const det = fakeRes();
    await cp._test.webhook(webhookReq({ orderId: 'd1', coin: 'ETH', outcome: 'detected', txid: '0xaa', amount: '0.05', confirmations: 0 }), det);
    expect(det.statusCode).toBe(200);
    expect(orders._orders.d1.status).toBe('detected');
    expect(store._users.u1.products).toHaveLength(0); // not granted yet
    const con = fakeRes();
    await cp._test.webhook(webhookReq({ orderId: 'd1', coin: 'ETH', txid: '0xaa', amount: '0.05', confirmations: 1 }), con);
    expect(con.statusCode).toBe(200);
    expect(orders._orders.d1.status).toBe('granted');
    expect(store._users.u1.products).toHaveLength(1);
  });
});

function jsonReq(bodyObj, user) {
  const raw = JSON.stringify(bodyObj);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST'; req.headers = {}; req._user = user;
  return req;
}

describe('crypto checkout', () => {
  function makeWithWatcher(user) {
    const store = fakeStore({ u1: { id: 'u1', email: 'a@b.c', username: 'amy', profileComplete: true, products: [] } });
    const orders = fakeOrders();
    const watchCalls = [];
    const cp = createCryptoPayments({
      store, ordersStore: orders, currentUser: () => user,
      baseUrl: 'http://localhost', webhookSecret: SECRET,
      watcherUrl: 'http://watcher', watcherToken: 'wtok',
      cryptoConfig: { enabledCoins: ['ETH'], coins: { ETH: { address: '0xabc', decimals: 6, confirmations: 6 } }, orderTtlMs: 1200000, jitterMax: 100, membership: { plans: { '3mo': { months: 3, priceUsd: 59.07, label: '3 months' }, year: { months: 12, priceUsd: 197, label: '1 year' } } }, productDiscountPercent: 10 },
      products: { getById: (id) => (id === 'p1' ? { id: 'p1', name: 'Course', slug: 'course', price: 29900, currency: 'usd', published: true } : null) },
      pricing: { getConfig: () => ({ currency: 'usd', monthly: { amount: 1700 }, yearly: { enabled: true, amount: 12000 } }) },
      fetchImpl: async (u2, opts) => {
        if (String(u2).includes('/quote')) return { ok: true, json: async () => ({ coin: 'ETH', usd: 299, amount: '0.1495', rate: 2000, ts: 1 }) };
        if (String(u2).includes('/watch')) { watchCalls.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true }) }; }
        return { ok: false, json: async () => ({}) };
      },
      rng: () => 0.5, now: () => 1_000_000,
    });
    return { cp, store, orders, watchCalls };
  }

  it('creates a product order and registers a watch', async () => {
    const { cp, orders, watchCalls } = makeWithWatcher({ id: 'u1', profileComplete: true, products: [] });
    const res = fakeRes();
    await cp._test.checkout(jsonReq({ kind: 'product', productId: 'p1', coin: 'ETH' }), res);
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body);
    expect(out.coin).toBe('ETH');
    expect(out.address).toBe('0xabc');
    expect(out.amount).toMatch(/^0\.1346/); // $299 − 10% = $269.10 ÷ $2000/ETH ≈ 0.1346
    expect(Object.keys(orders._orders)).toHaveLength(1);
    expect(watchCalls).toHaveLength(1);
    expect(watchCalls[0].expectedAmount).toBe(out.amount);
  });

  it('rejects an unsupported coin', async () => {
    const { cp } = makeWithWatcher({ id: 'u1', profileComplete: true, products: [] });
    const res = fakeRes();
    await cp._test.checkout(jsonReq({ kind: 'product', productId: 'p1', coin: 'DOGE' }), res);
    expect(res.statusCode).toBe(400);
  });

  it('401s when signed out', async () => {
    const { cp } = makeWithWatcher(null);
    const res = fakeRes();
    await cp._test.checkout(jsonReq({ kind: 'product', productId: 'p1', coin: 'ETH' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('allows checkout for a fresh account with no completed profile (regression: removed 403 gate)', async () => {
    const { cp } = makeWithWatcher({ id: 'u1', products: [] }); // no profileComplete
    const res = fakeRes();
    await cp._test.checkout(jsonReq({ kind: 'membership', membershipPlan: '3mo', coin: 'ETH' }), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).orderId).toBeTruthy();
  });

  it('config reports enabled coins', async () => {
    const { cp } = makeWithWatcher({ id: 'u1', profileComplete: true, products: [] });
    const res = fakeRes();
    await cp._test.config({ method: 'GET', headers: {} }, res);
    expect(res.statusCode).toBe(200);
    const cfg = JSON.parse(res.body);
    expect(cfg.enabled).toBe(true);
    expect(cfg.coins).toEqual(['ETH']);
    expect(cfg.membershipPlans).toContainEqual({ key: '3mo', months: 3, priceUsd: 59.07, label: '3 months' });
  });

  it('reports order status', async () => {
    const { cp, orders } = makeWithWatcher({ id: 'u1', profileComplete: true, products: [] });
    await orders.create({ id: 'o9', userId: 'u1', kind: 'product', productId: 'p1', coin: 'ETH', amount: '0.1', address: '0xabc', status: 'waiting', expiresAt: 2_000_000 });
    const res = fakeRes();
    await cp._test.orderStatus({ method: 'GET', headers: {} }, res, 'o9', { id: 'u1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('waiting');
  });
});

describe('crypto open-order (resume)', () => {
  it('401s when signed out', async () => {
    const { cp } = make();
    const res = fakeRes();
    await cp._test.openOrder({ method: 'GET', headers: {} }, res, null);
    expect(res.statusCode).toBe(401);
  });

  it('returns {order:null} when the user has no in-flight order', async () => {
    const { cp } = make();
    const res = fakeRes();
    await cp._test.openOrder({ method: 'GET', headers: {} }, res, { id: 'u1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).order).toBe(null);
  });

  it('returns the active order (enough to re-render) for the owner', async () => {
    const { cp, orders } = make();
    await orders.create({ id: 'op1', userId: 'u1', kind: 'membership', productId: null, coin: 'ETH', amount: '0.0834', address: '0xabc', status: 'waiting', createdAt: 1, expiresAt: Date.now() + 100000 });
    const res = fakeRes();
    await cp._test.openOrder({ method: 'GET', headers: {} }, res, { id: 'u1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).order).toMatchObject({
      orderId: 'op1', coin: 'ETH', amount: '0.0834', address: '0xabc', status: 'waiting', kind: 'membership',
    });
  });
});
