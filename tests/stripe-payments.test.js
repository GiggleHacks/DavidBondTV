import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { verifyStripeSignature, toForm, createStripePayments } from '../lib/stripe-payments.js';

const SECRET = 'whsec_test';
const NOW = 1_700_000_000_000; // ms
const tNow = Math.floor(NOW / 1000);

function signHeader(body, secret = SECRET, t = tNow) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

describe('verifyStripeSignature', () => {
  it('accepts a valid signature', () => {
    const body = '{"a":1}';
    expect(verifyStripeSignature(body, signHeader(body), SECRET, { now: NOW })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const header = signHeader('{"a":1}');
    expect(verifyStripeSignature('{"a":2}', header, SECRET, { now: NOW })).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const body = '{"a":1}';
    expect(verifyStripeSignature(body, signHeader(body, 'other'), SECRET, { now: NOW })).toBe(false);
  });

  it('rejects a stale timestamp beyond tolerance', () => {
    const body = '{"a":1}';
    const header = signHeader(body, SECRET, tNow - 10_000);
    expect(verifyStripeSignature(body, header, SECRET, { now: NOW, toleranceSec: 300 })).toBe(false);
  });

  it('accepts when one of several v1 candidates matches', () => {
    const body = '{"a":1}';
    const good = signHeader(body).split('v1=')[1];
    const header = `t=${tNow},v1=deadbeef,v1=${good}`;
    expect(verifyStripeSignature(body, header, SECRET, { now: NOW })).toBe(true);
  });

  it('verifies a Buffer body', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifyStripeSignature(body, signHeader(body.toString('utf8')), SECRET, { now: NOW })).toBe(true);
  });

  it('never throws on garbage', () => {
    expect(verifyStripeSignature('x', 'garbage', SECRET, { now: NOW })).toBe(false);
    expect(verifyStripeSignature('x', null, SECRET, { now: NOW })).toBe(false);
    expect(verifyStripeSignature(null, 'x', SECRET, { now: NOW })).toBe(false);
    expect(verifyStripeSignature('x', 'x', '', { now: NOW })).toBe(false);
  });
});

describe('toForm', () => {
  it('flattens nested objects + arrays with bracket notation', () => {
    const s = toForm({
      mode: 'subscription',
      line_items: [{ price: 'p_1', quantity: 1 }],
      subscription_data: { metadata: { uid: 'u1' } },
    });
    expect(s).toContain('mode=subscription');
    expect(s).toContain('line_items%5B0%5D%5Bprice%5D=p_1');
    expect(s).toContain('line_items%5B0%5D%5Bquantity%5D=1');
    expect(s).toContain('subscription_data%5Bmetadata%5D%5Buid%5D=u1');
  });

  it('skips null/undefined', () => {
    expect(toForm({ a: 1, b: null, c: undefined })).toBe('a=1');
  });

  it('flattens one-time price_data (dynamic pricing) bracket notation', () => {
    const s = toForm({
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: 9900, product_data: { name: 'Digital Pickup' } } }],
    });
    expect(s).toContain('mode=payment');
    expect(s).toContain('line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=9900');
    expect(s).toContain('line_items%5B0%5D%5Bprice_data%5D%5Bproduct_data%5D%5Bname%5D=Digital%20Pickup');
  });
});

// --- handleEvent / applySubscription (in-memory fakes) ---

function fakeStore(initial = {}) {
  const users = JSON.parse(JSON.stringify(initial));
  return {
    getById: (id) => (users[id] ? JSON.parse(JSON.stringify(users[id])) : null),
    getByStripeCustomerId: (cid) => {
      const u = Object.values(users).find((x) => x.stripeCustomerId === cid);
      return u ? JSON.parse(JSON.stringify(u)) : null;
    },
    updateUser: async (id, patch) => { users[id] = { ...(users[id] || { id }), ...patch }; return { ok: true, user: users[id] }; },
    _users: users,
  };
}

function fakePayments() {
  const events = {}; const txns = {};
  return {
    isStripeEventProcessed: (id) => Object.prototype.hasOwnProperty.call(events, id),
    markStripeEvent: async (id) => { events[id] = 1; },
    addTxn: async (uid, t) => { (txns[uid] = txns[uid] || []).push(t); },
    _events: events, _txns: txns,
  };
}

function makeSP(store, paymentsStore) {
  return createStripePayments({
    store,
    paymentsStore,
    currentUser: () => null,
    baseUrl: 'http://localhost',
    secretKey: 'sk_test',
    webhookSecret: SECRET,
    priceMonthly: 'price_m',
    priceYearly: 'price_y',
  });
}

function fakeCoupons(coupon = null) {
  const redemptions = [];
  return {
    validate: (code) => (coupon && String(code || '').trim().toUpperCase() === coupon.code ? { ok: true, coupon } : { ok: false, error: 'That code isn’t valid.' }),
    stripeCouponFresh: (c) => !!(c && c.stripeCouponId),
    setStripeCoupon: (id, stripeCouponId) => {
      if (coupon && coupon.id === id) coupon.stripeCouponId = stripeCouponId;
      return { ok: true, coupon };
    },
    recordRedemption: (rec) => { redemptions.push(rec); return { ok: true }; },
    _redemptions: redemptions,
  };
}

// Genuinely-future (relative to the real clock) because applySubscription
// derives the hasPurchased mirror from the live Date.now().
const future = Math.floor((Date.now() + 30 * 86400 * 1000) / 1000); // unix seconds

function subObject(over = {}) {
  return {
    id: 'sub_1', status: 'active', customer: 'cus_1',
    current_period_end: future, cancel_at_period_end: false,
    metadata: { uid: 'u1' },
    items: { data: [{ price: { id: 'price_m', recurring: { interval: 'month' } } }] },
    ...over,
  };
}

describe('handleEvent → applySubscription', () => {
  it('maps subscription.updated by metadata.uid and writes membership (ms period end)', async () => {
    const store = fakeStore({ u1: { id: 'u1' } });
    const sp = makeSP(store, fakePayments());
    await sp._test.handleEvent({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: subObject() } });
    const m = store._users.u1.membership;
    expect(m.provider).toBe('stripe');
    expect(m.status).toBe('active');
    expect(m.interval).toBe('month');
    expect(m.currentPeriodEnd).toBe(future * 1000);
    expect(store._users.u1.stripeCustomerId).toBe('cus_1');
    expect(store._users.u1.hasPurchased).toBe(true);
  });

  it('reads interval/priceId from the legacy `plan` shape (old API version)', async () => {
    const store = fakeStore({ u1: { id: 'u1' } });
    const sp = makeSP(store, fakePayments());
    const legacy = subObject({ items: { data: [{ plan: { id: 'plan_y', interval: 'year' } }] } });
    delete legacy.items.data[0].price;
    await sp._test.handleEvent({ id: 'evt_legacy', type: 'customer.subscription.updated', data: { object: legacy } });
    expect(store._users.u1.membership.priceId).toBe('plan_y');
    expect(store._users.u1.membership.interval).toBe('year');
  });

  it('falls back to customer-id mapping when metadata is absent', async () => {
    const store = fakeStore({ u2: { id: 'u2', stripeCustomerId: 'cus_2' } });
    const sp = makeSP(store, fakePayments());
    await sp._test.handleEvent({
      id: 'evt_2', type: 'customer.subscription.updated',
      data: { object: subObject({ metadata: {}, customer: 'cus_2' }) },
    });
    expect(store._users.u2.membership.status).toBe('active');
  });

  it('subscription.deleted (canceled) leaves the user inactive', async () => {
    const store = fakeStore({ u1: { id: 'u1' } });
    const sp = makeSP(store, fakePayments());
    await sp._test.handleEvent({
      id: 'evt_3', type: 'customer.subscription.deleted',
      data: { object: subObject({ status: 'canceled' }) },
    });
    expect(store._users.u1.membership.status).toBe('canceled');
    expect(store._users.u1.hasPurchased).toBe(false);
  });

  it('invoice.paid records a ledger transaction', async () => {
    const store = fakeStore({ u1: { id: 'u1', stripeCustomerId: 'cus_1' } });
    const payments = fakePayments();
    const sp = makeSP(store, payments);
    await sp._test.handleEvent({
      id: 'evt_4', type: 'invoice.paid',
      data: { object: { id: 'in_1', customer: 'cus_1', amount_paid: 500, currency: 'usd', hosted_invoice_url: 'http://x', status: 'paid' } },
    });
    expect(payments._txns.u1).toHaveLength(1);
    expect(payments._txns.u1[0]).toMatchObject({ kind: 'stripe.invoice.paid', amount: 500, invoiceId: 'in_1' });
  });

  it('resolveUid prefers metadata, then customer lookup', () => {
    const store = fakeStore({ u1: { id: 'u1', stripeCustomerId: 'cus_9' } });
    const sp = makeSP(store, fakePayments());
    expect(sp._test.resolveUid({ metadata: { uid: 'meta' }, customer: 'cus_9' })).toBe('meta');
    expect(sp._test.resolveUid({ metadata: {}, customer: 'cus_9' })).toBe('u1');
    expect(sp._test.resolveUid({ customer: 'cus_none' })).toBe(null);
  });
});

describe('handleEvent → product entitlement (one-time course purchase)', () => {
  const paymentSession = (over = {}) => ({
    id: 'cs_1', mode: 'payment', customer: 'cus_1',
    amount_total: 9900, currency: 'usd',
    client_reference_id: 'u1', metadata: { uid: 'u1', productId: 'p1' },
    ...over,
  });

  it('grants the entitlement and records a txn, WITHOUT touching membership', async () => {
    const store = fakeStore({ u1: { id: 'u1' } });
    const payments = fakePayments();
    const sp = makeSP(store, payments);
    await sp._test.handleEvent({ id: 'evt_p1', type: 'checkout.session.completed', data: { object: paymentSession() } });
    const u = store._users.u1;
    expect(u.products).toHaveLength(1);
    expect(u.products[0]).toMatchObject({ productId: 'p1', provider: 'stripe', stripeSessionId: 'cs_1', amount: 9900, currency: 'usd' });
    expect(u.membership == null).toBe(true);   // course purchase is separate from membership
    expect(u.hasPurchased).not.toBe(true);
    expect(payments._txns.u1[0]).toMatchObject({ kind: 'stripe.product.paid', productId: 'p1' });
  });

  it('is idempotent for a redelivered session (one grant, one txn)', async () => {
    const store = fakeStore({ u1: { id: 'u1' } });
    const payments = fakePayments();
    const sp = makeSP(store, payments);
    const ev = { id: 'evt_p2', type: 'checkout.session.completed', data: { object: paymentSession() } };
    await sp._test.handleEvent(ev);
    await sp._test.handleEvent(ev); // same session id again
    expect(store._users.u1.products).toHaveLength(1);
    expect(payments._txns.u1).toHaveLength(1);
  });

  it('leaves subscription checkout sessions on the membership path', async () => {
    const store = fakeStore({ u1: { id: 'u1' } });
    const sp = makeSP(store, fakePayments());
    // A subscription-mode session has no productId; it must NOT grant a product.
    await sp._test.handleEvent({
      id: 'evt_sub', type: 'checkout.session.completed',
      data: { object: { id: 'cs_2', mode: 'subscription', customer: 'cus_1', client_reference_id: 'u1', metadata: { uid: 'u1' } } },
    });
    expect(store._users.u1.products || []).toHaveLength(0);
  });

  it('records coupon redemption metadata from a completed product checkout', async () => {
    const store = fakeStore({ u1: { id: 'u1' } });
    const couponApi = fakeCoupons();
    const sp = createStripePayments({
      store, paymentsStore: fakePayments(), currentUser: () => null,
      baseUrl: 'http://x', secretKey: 'sk_test', webhookSecret: SECRET,
      priceMonthly: 'price_m', priceYearly: 'price_y', coupons: couponApi,
    });

    await sp._test.handleEvent({
      id: 'evt_coupon_product',
      type: 'checkout.session.completed',
      data: { object: paymentSession({
        metadata: { uid: 'u1', productId: 'p1', couponId: 'cpn_1', couponCode: 'SAVE20' },
        total_details: { amount_discount: 1200 },
      }) },
    });

    expect(couponApi._redemptions).toHaveLength(1);
    expect(couponApi._redemptions[0]).toMatchObject({
      couponId: 'cpn_1',
      code: 'SAVE20',
      userId: 'u1',
      sessionId: 'cs_1',
      kind: 'product',
      productId: 'p1',
      amountDiscount: 1200,
      currency: 'usd',
    });
  });
});

describe('checkout → dynamic subscription pricing', () => {
  const fakeRes = () => ({
    statusCode: null, body: null,
    writeHead(s) { this.statusCode = s; },
    end(p) { this.body = p; },
  });

  // Capture the form-encoded Stripe params by spying through fetchImpl body.
  async function checkoutBody(config, interval = 'month') {
    let captured = null;
    const user = { id: 'u1', profileComplete: true, stripeCustomerId: 'cus_1', email: 'a@b.com' };
    const sp = createStripePayments({
      store: fakeStore({ u1: user }), paymentsStore: fakePayments(),
      currentUser: () => user, baseUrl: 'http://x', secretKey: 'sk_test', webhookSecret: SECRET,
      pricing: { getConfig: () => config },
      fetchImpl: async (url, opts) => {
        if (url.endsWith('/checkout/sessions')) { captured = opts.body; return { ok: true, json: async () => ({ url: 'https://stripe' }) }; }
        return { ok: true, json: async () => ({ id: 'cus_1' }) };
      },
    });
    const req = Readable.from([Buffer.from(JSON.stringify({ interval }))]);
    const res = fakeRes();
    await sp._test.checkout(req, res);
    return { status: res.statusCode, body: captured };
  }

  async function checkoutBodyWithCoupon(config) {
    let captured = null;
    const coupon = {
      id: 'cpn_local',
      code: 'SAVE20',
      percentOff: 20,
      duration: 'once',
      stripeCouponId: 'stripe_coupon_20',
    };
    const user = { id: 'u1', profileComplete: true, stripeCustomerId: 'cus_1', email: 'a@b.com' };
    const sp = createStripePayments({
      store: fakeStore({ u1: user }), paymentsStore: fakePayments(),
      currentUser: () => user, baseUrl: 'http://x', secretKey: 'sk_test', webhookSecret: SECRET,
      pricing: { getConfig: () => config }, coupons: fakeCoupons(coupon),
      fetchImpl: async (url, opts) => {
        if (url.endsWith('/checkout/sessions')) { captured = opts.body; return { ok: true, json: async () => ({ url: 'https://stripe' }) }; }
        return { ok: true, json: async () => ({ id: 'cus_1' }) };
      },
    });
    const req = Readable.from([Buffer.from(JSON.stringify({ interval: 'month', couponCode: 'save20' }))]);
    const res = fakeRes();
    await sp._test.checkout(req, res);
    return { status: res.statusCode, body: captured };
  }

  const withIntro = { currency: 'usd', monthly: { amount: 1700, introAmount: 4700, introLabel: 'First month' }, yearly: { enabled: true, amount: 12000 } };

  it('monthly with intro: recurring price_data + one-time intro line item + 30-day trial', async () => {
    const { status, body } = await checkoutBody(withIntro, 'month');
    expect(status).toBe(200);
    expect(body).toContain('line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=1700');
    expect(body).toContain('line_items%5B0%5D%5Bprice_data%5D%5Brecurring%5D%5Binterval%5D=month');
    expect(body).toContain('line_items%5B1%5D%5Bprice_data%5D%5Bunit_amount%5D=4700');
    // The intro line item is one-time → it must NOT carry a recurring block.
    expect(body).not.toContain('line_items%5B1%5D%5Bprice_data%5D%5Brecurring%5D');
    expect(body).toContain('subscription_data%5Btrial_period_days%5D=30');
  });

  it('monthly without intro: single recurring line item, no trial, no second item', async () => {
    const { body } = await checkoutBody({ ...withIntro, monthly: { amount: 1700, introAmount: 0 } }, 'month');
    expect(body).toContain('line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=1700');
    expect(body).not.toContain('line_items%5B1%5D');
    expect(body).not.toContain('trial_period_days');
  });

  it('yearly: single annual recurring line item, no intro/trial', async () => {
    const { body } = await checkoutBody(withIntro, 'year');
    expect(body).toContain('line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=12000');
    expect(body).toContain('line_items%5B0%5D%5Bprice_data%5D%5Brecurring%5D%5Binterval%5D=year');
    expect(body).not.toContain('line_items%5B1%5D');
    expect(body).not.toContain('trial_period_days');
  });

  it('attaches a validated first-party coupon to the Stripe checkout session', async () => {
    const { status, body } = await checkoutBodyWithCoupon(withIntro);

    expect(status).toBe(200);
    expect(body).toContain('discounts%5B0%5D%5Bcoupon%5D=stripe_coupon_20');
    expect(body).toContain('subscription_data%5Bmetadata%5D%5BcouponId%5D=cpn_local');
    expect(body).toContain('subscription_data%5Bmetadata%5D%5BcouponCode%5D=SAVE20');
  });
});

describe('configured flag', () => {
  it('is false without keys/prices', () => {
    const sp = createStripePayments({
      store: fakeStore(), paymentsStore: fakePayments(), currentUser: () => null,
      baseUrl: 'http://x', secretKey: '', webhookSecret: '', priceMonthly: '', priceYearly: '',
    });
    expect(sp.configured).toBe(false);
  });

  it('is true with a secret key and just one price (monthly-only launch)', () => {
    const sp = createStripePayments({
      store: fakeStore(), paymentsStore: fakePayments(), currentUser: () => null,
      baseUrl: 'http://x', secretKey: 'sk_test', webhookSecret: 'whsec', priceMonthly: 'price_m', priceYearly: '',
    });
    expect(sp.configured).toBe(true);
  });
});

// A spy mailer so we can assert "exactly one confirmation email".
function fakeMailer() {
  const calls = { membership: [], product: [] };
  return {
    mailerConfigured: () => true,
    sendMembershipGrantedEmail: async (to, link) => { calls.membership.push({ to, link }); },
    sendProductGrantedEmail: async (to, name, link) => { calls.product.push({ to, name, link }); },
    _calls: calls,
  };
}

const reconcileRes = () => ({
  statusCode: null, body: null,
  writeHead(s) { this.statusCode = s; },
  end(p) { this.body = p; },
});
const resJson = (res) => { try { return JSON.parse(res.body); } catch { return null; } };

// fetchImpl that answers the two GETs reconcile makes: the checkout session and
// (for subscriptions) the subscription object.
function reconcileFetch({ session, sub }) {
  return async (url, opts) => {
    if (url.includes('/checkout/sessions/')) return { ok: true, json: async () => session };
    if (url.includes('/subscriptions/')) return { ok: true, json: async () => sub };
    return { ok: true, json: async () => ({}) };
  };
}

describe('reconcile (synchronous activation on return from checkout)', () => {
  const makeReconcileSP = (user, fetchImpl, mailer) => createStripePayments({
    store: fakeStore({ [user.id]: user }), paymentsStore: fakePayments(),
    currentUser: () => user, baseUrl: 'http://x', secretKey: 'sk_test', webhookSecret: SECRET,
    priceMonthly: 'price_m', fetchImpl, mailer,
  });

  it('rejects a session whose client_reference_id is a different user (403, no activation)', async () => {
    const user = { id: 'u1', email: 'a@b.com' };
    const mailer = fakeMailer();
    const sp = createStripePayments({
      store: fakeStore({ u1: user }), paymentsStore: fakePayments(),
      currentUser: () => user, baseUrl: 'http://x', secretKey: 'sk_test', webhookSecret: SECRET, priceMonthly: 'price_m',
      mailer,
      fetchImpl: reconcileFetch({ session: { id: 'cs_x', mode: 'subscription', client_reference_id: 'someone_else', payment_status: 'paid', subscription: 'sub_1' }, sub: subObject() }),
    });
    const req = Readable.from([Buffer.from(JSON.stringify({ sessionId: 'cs_attacker' }))]);
    const res = reconcileRes();
    await sp._test.reconcile(req, res);
    expect(res.statusCode).toBe(403);
    expect(mailer._calls.membership).toHaveLength(0);
  });

  it('rejects a malformed session id (400)', async () => {
    const user = { id: 'u1', email: 'a@b.com' };
    const sp = makeReconcileSP(user, reconcileFetch({ session: {}, sub: subObject() }), fakeMailer());
    const req = Readable.from([Buffer.from(JSON.stringify({ sessionId: 'not-a-session' }))]);
    const res = reconcileRes();
    await sp._test.reconcile(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('activates membership from a paid subscription session and returns active', async () => {
    const user = { id: 'u1', email: 'a@b.com' };
    const sp = makeReconcileSP(
      user,
      reconcileFetch({ session: { id: 'cs_ok', mode: 'subscription', client_reference_id: 'u1', payment_status: 'paid', subscription: 'sub_1' }, sub: subObject() }),
      fakeMailer(),
    );
    const req = Readable.from([Buffer.from(JSON.stringify({ sessionId: 'cs_ok' }))]);
    const res = reconcileRes();
    await sp._test.reconcile(req, res);
    expect(res.statusCode).toBe(200);
    expect(resJson(res).membership.active).toBe(true);
  });

  it('is idempotent and sends exactly one welcome email across webhook + reconcile', async () => {
    const user = { id: 'u1', email: 'a@b.com' };
    const store = fakeStore({ u1: user });
    const mailer = fakeMailer();
    const sp = createStripePayments({
      store, paymentsStore: fakePayments(),
      currentUser: () => user, baseUrl: 'http://x', secretKey: 'sk_test', webhookSecret: SECRET, priceMonthly: 'price_m',
      mailer,
      fetchImpl: reconcileFetch({ session: { id: 'cs_ok', mode: 'subscription', client_reference_id: 'u1', payment_status: 'paid', subscription: 'sub_1' }, sub: subObject() }),
    });

    // Webhook activates first…
    await sp._test.handleEvent({ id: 'evt_w', type: 'customer.subscription.updated', data: { object: subObject() } });
    // …then the user returns and we reconcile the same subscription.
    const req = Readable.from([Buffer.from(JSON.stringify({ sessionId: 'cs_ok' }))]);
    await sp._test.reconcile(req, reconcileRes());
    // …and a redundant second reconcile.
    const req2 = Readable.from([Buffer.from(JSON.stringify({ sessionId: 'cs_ok' }))]);
    await sp._test.reconcile(req2, reconcileRes());

    expect(store._users.u1.hasPurchased).toBe(true);
    expect(store._users.u1.membership.welcomeEmailFor).toBe('sub_1');
    expect(mailer._calls.membership).toHaveLength(1); // exactly once, never double-sent
  });

  it('does not activate when the session is not yet paid', async () => {
    const user = { id: 'u1', email: 'a@b.com' };
    const sp = makeReconcileSP(
      user,
      reconcileFetch({ session: { id: 'cs_unpaid', mode: 'subscription', client_reference_id: 'u1', payment_status: 'unpaid', subscription: 'sub_1' }, sub: subObject() }),
      fakeMailer(),
    );
    const req = Readable.from([Buffer.from(JSON.stringify({ sessionId: 'cs_unpaid' }))]);
    const res = reconcileRes();
    await sp._test.reconcile(req, res);
    expect(res.statusCode).toBe(200);
    expect(resJson(res).membership.active).toBe(false);
  });
});

describe('resyncUser (admin safety-net)', () => {
  it('pulls the latest active subscription from Stripe and activates the user', async () => {
    const store = fakeStore({ u1: { id: 'u1', email: 'a@b.com', stripeCustomerId: 'cus_1' } });
    const mailer = fakeMailer();
    const sp = createStripePayments({
      store, paymentsStore: fakePayments(), currentUser: () => null,
      baseUrl: 'http://x', secretKey: 'sk_test', webhookSecret: SECRET, priceMonthly: 'price_m', mailer,
      fetchImpl: async (url) => {
        if (url.includes('/subscriptions?customer=')) return { ok: true, json: async () => ({ data: [subObject({ status: 'active' })] }) };
        return { ok: true, json: async () => ({}) };
      },
    });
    const out = await sp.resyncUser('u1');
    expect(out.ok).toBe(true);
    expect(out.membership.active).toBe(true);
    expect(store._users.u1.hasPurchased).toBe(true);
  });

  it('returns an error when the user has no Stripe customer', async () => {
    const store = fakeStore({ u1: { id: 'u1', email: 'a@b.com' } });
    const sp = createStripePayments({
      store, paymentsStore: fakePayments(), currentUser: () => null,
      baseUrl: 'http://x', secretKey: 'sk_test', webhookSecret: SECRET, priceMonthly: 'price_m',
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    });
    const out = await sp.resyncUser('u1');
    expect(out.ok).toBe(false);
  });
});
