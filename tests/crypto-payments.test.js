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
    mailer: { sendProductGrantedEmail: async () => mails.push('product'), sendMembershipGrantedEmail: async () => mails.push('membership'), mailerConfigured: () => true },
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
    await orders.create({ id: 'o1', userId: 'u1', kind: 'product', productId: 'p1', coin: 'ETH', amount: '0.05', status: 'waiting', confirmations: 6 });
    const body = { orderId: 'o1', coin: 'ETH', txid: '0xabc', amount: '0.05', confirmations: 6 };
    const res1 = fakeRes();
    await cp._test.webhook(webhookReq(body), res1);
    expect(res1.statusCode).toBe(200);
    expect(store._users.u1.products).toHaveLength(1);
    expect(orders._orders.o1.status).toBe('granted');
    expect(mails).toEqual(['product']);
    expect(tg.filter((x) => x.t === 'course_purchase')).toHaveLength(1);

    const res2 = fakeRes();
    await cp._test.webhook(webhookReq(body), res2);
    expect(res2.statusCode).toBe(200);
    expect(store._users.u1.products).toHaveLength(1);
    expect(mails).toEqual(['product']);
  });

  it('grants fixed-term membership on a confirmed callback', async () => {
    const { cp, store, orders } = make();
    await orders.create({ id: 'm1', userId: 'u1', kind: 'membership', termMonths: 3, coin: 'LTC', amount: '1.0', status: 'waiting', confirmations: 6 });
    const res = fakeRes();
    await cp._test.webhook(webhookReq({ orderId: 'm1', coin: 'LTC', txid: 't', amount: '1.0', confirmations: 6 }), res);
    expect(res.statusCode).toBe(200);
    expect(store._users.u1.membership.provider).toBe('crypto');
    expect(store._users.u1.membership.status).toBe('active');
    expect(store._users.u1.membership.interval).toBe('3mo');
    expect(store._users.u1.membership.currentPeriodEnd).toBeGreaterThan(Date.now());
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
});
