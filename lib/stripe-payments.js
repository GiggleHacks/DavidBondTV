// Stripe integration — recurring, single-tier, all-access membership. Kept in
// the project's hand-rolled spirit (no SDK): the Stripe REST API is called with
// fetch + form-encoding, and webhook signatures are verified with node:crypto
// HMAC (same style as lib/auth-token.js). All Stripe-specific knowledge lives
// here; the rest of the app only reads user.membership (see lib/membership.js).
//
// Flow: client POSTs /api/pay/stripe/checkout → we create a Checkout Session and
// return its URL → Stripe hosts the payment → Stripe calls our webhook → we
// write user.membership. Management (cancel / update card / invoices) is the
// Stripe-hosted Customer Portal via /api/pay/stripe/portal.
import crypto from 'node:crypto';
import { sendJson, readBody, readRawBody } from './http-util.js';
import { createRateLimiter } from './rate-limit.js';
import { hasActiveMembership } from './membership.js';

const STRIPE_API = 'https://api.stripe.com/v1';
// Pin our own API calls to a modern version so retrieved subscriptions use the
// `price` shape, independent of the account's (possibly ancient) default. Webhook
// events still arrive in the endpoint's configured version, so applySubscription
// also tolerates the legacy `plan` shape below.
const STRIPE_API_VERSION = '2024-06-20';

/**
 * Flatten a params object into application/x-www-form-urlencoded with Stripe's
 * bracket notation, e.g. { line_items:[{price:'p'}] } → line_items[0][price]=p.
 */
export function toForm(obj, prefix = '', out = []) {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val === undefined || val === null) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (typeof val === 'object') toForm(val, k, out);
    else out.push(`${encodeURIComponent(k)}=${encodeURIComponent(val)}`);
  }
  return out.join('&');
}

/**
 * Verify a Stripe webhook signature. The header looks like
 * "t=<unix>,v1=<hex>[,v1=<hex>…]"; the signed payload is `${t}.${rawBody}` and
 * the signature is HMAC-SHA256(secret, payload). Returns true only on a
 * constant-time match within the timestamp tolerance. Never throws.
 */
export function verifyStripeSignature(rawBody, sigHeader, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!secret || typeof sigHeader !== 'string' || rawBody == null) return false;
  let t = null;
  const v1 = [];
  for (const kv of sigHeader.split(',')) {
    const i = kv.indexOf('=');
    if (i === -1) continue;
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1.push(v);
  }
  if (!t || v1.length === 0) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  // Replay window: reject signatures whose timestamp is too far from now.
  if (toleranceSec > 0 && Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
  const expBuf = Buffer.from(expected, 'hex');
  return v1.some((sig) => {
    let sigBuf;
    try { sigBuf = Buffer.from(sig, 'hex'); } catch { return false; }
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  });
}

export function createStripePayments({
  store, currentUser, paymentsStore, baseUrl,
  secretKey, webhookSecret, priceMonthly, priceYearly,
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
}) {
  // Wired when we have a secret key + at least one price. Offering only monthly
  // (or only yearly) is fine — the frontend hides the plan that has no price.
  // Until configured, checkout/portal return 503 (the webhook still verifies if
  // its secret is set).
  const configured = !!(secretKey && (priceMonthly || priceYearly) && fetchImpl);
  const limiter = createRateLimiter(60_000, 10); // 10 checkout/portal attempts/min per user

  async function stripeApi(method, p, params) {
    const res = await fetchImpl(`${STRIPE_API}${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
      },
      body: params ? toForm(params) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((json && json.error && json.error.message) || `Stripe ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // Returns the configured price id for the interval, or null if that plan
  // isn't offered.
  const priceFor = (interval) => ((interval === 'year' ? priceYearly : priceMonthly) || null);

  // Fetch + cache the price amounts so the membership page can show real pricing
  // ("$1/mo") instead of generic copy. Cached for the process lifetime.
  let priceCache = null;
  async function priceInfo() {
    if (priceCache) return priceCache;
    const out = { month: null, year: null };
    const load = async (id) => {
      const p = await stripeApi('GET', `/prices/${id}`);
      return { amount: p.unit_amount, currency: p.currency, interval: p.recurring && p.recurring.interval };
    };
    try { if (priceMonthly) out.month = await load(priceMonthly); } catch { /* ignore */ }
    try { if (priceYearly) out.year = await load(priceYearly); } catch { /* ignore */ }
    priceCache = out;
    return out;
  }

  /** Find/create the Stripe customer for a user, persisting the id on first use. */
  async function ensureCustomer(user) {
    if (user.stripeCustomerId) return user.stripeCustomerId;
    const cust = await stripeApi('POST', '/customers', {
      email: user.email,
      metadata: { uid: user.id },
    });
    await store.updateUser(user.id, { stripeCustomerId: cust.id });
    return cust.id;
  }

  /** Map a Stripe object back to our user id: subscription/session metadata, else customer. */
  function resolveUid(obj) {
    const fromMeta = obj && obj.metadata && obj.metadata.uid;
    if (fromMeta) return fromMeta;
    const cust = obj && obj.customer;
    if (cust) {
      const u = store.getByStripeCustomerId(cust);
      if (u) return u.id;
    }
    return null;
  }

  /** Write a Stripe subscription object into user.membership (the source of truth). */
  async function applySubscription(uid, sub) {
    if (!uid || !sub) return;
    const item = sub.items && sub.items.data && sub.items.data[0];
    // Modern API serializes the item with `price`; legacy versions (e.g. an
    // account pinned to 2018) use `plan`. Read the id + interval from whichever
    // is present so the webhook works regardless of the account's API version.
    const priceOrPlan = item && (item.price || item.plan);
    const interval = priceOrPlan
      ? (priceOrPlan.recurring ? priceOrPlan.recurring.interval : priceOrPlan.interval || null)
      : null;
    const membership = {
      provider: 'stripe',
      stripeSubscriptionId: sub.id || null,
      status: sub.status || null,
      priceId: priceOrPlan ? priceOrPlan.id : null,
      interval,
      currentPeriodEnd: typeof sub.current_period_end === 'number' ? sub.current_period_end * 1000 : null,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      updatedAt: Date.now(),
    };
    // Stamp "member since" the first time membership is recorded; preserve it
    // across renewals/updates so the profile date is stable.
    const prev = store.getById(uid);
    membership.since = (prev && prev.membership && typeof prev.membership.since === 'number')
      ? prev.membership.since : Date.now();
    const patch = { membership };
    if (sub.customer) patch.stripeCustomerId = sub.customer;
    // Keep the legacy flag in lockstep with current active state for any reads
    // not yet migrated to hasActiveMembership().
    patch.hasPurchased = hasActiveMembership({ membership });
    await store.updateUser(uid, patch);
  }

  /** Apply the side effects of one Stripe event. Idempotency is handled by the caller. */
  async function handleEvent(event) {
    const type = event && event.type;
    const obj = event && event.data && event.data.object;
    if (!type || !obj) return;

    if (type === 'checkout.session.completed') {
      const uid = obj.client_reference_id || resolveUid(obj);
      if (!uid) return;
      if (obj.customer) {
        const u = store.getById(uid);
        if (u && !u.stripeCustomerId) await store.updateUser(uid, { stripeCustomerId: obj.customer });
      }
      if (obj.subscription) {
        const sub = await stripeApi('GET', `/subscriptions/${obj.subscription}`);
        // Stamp uid onto the subscription so later subscription.* events resolve
        // even without a customer lookup. Best-effort.
        if (!sub.metadata || !sub.metadata.uid) {
          try { await stripeApi('POST', `/subscriptions/${obj.subscription}`, { metadata: { uid } }); } catch { /* ignore */ }
        }
        await applySubscription(uid, sub);
      }
      return;
    }

    if (type === 'customer.subscription.created'
      || type === 'customer.subscription.updated'
      || type === 'customer.subscription.deleted') {
      const uid = resolveUid(obj);
      if (uid) await applySubscription(uid, obj);
      return;
    }

    if (type === 'invoice.paid' || type === 'invoice.payment_failed') {
      const uid = resolveUid(obj);
      if (uid) {
        await paymentsStore.addTxn(uid, {
          kind: type === 'invoice.paid' ? 'stripe.invoice.paid' : 'stripe.invoice.failed',
          ts: Date.now(),
          amount: typeof obj.amount_paid === 'number' ? obj.amount_paid : (obj.amount_due ?? null),
          currency: obj.currency || null,
          invoiceId: obj.id || null,
          hostedInvoiceUrl: obj.hosted_invoice_url || null,
          status: obj.status || null,
        });
      }
    }
  }

  // --- route handlers ---

  async function checkout(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    if (!user.profileComplete) return sendJson(res, 403, { error: 'Finish setting up your profile first.' });
    if (!configured) return sendJson(res, 503, { error: 'Card payments aren’t available yet.' });
    if (!limiter.hit(user.id).allowed) return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });

    const raw = await readBody(req, 4096);
    let body; try { body = JSON.parse(raw); } catch { body = null; }
    const interval = body && body.interval === 'year' ? 'year' : 'month';
    const price = priceFor(interval);
    if (!price) return sendJson(res, 400, { error: 'That plan isn’t available.' });
    // Return-to-content after payment: only same-origin relative paths allowed.
    const next = body && typeof body.next === 'string' && body.next.startsWith('/') && !body.next.startsWith('//')
      ? body.next : '';

    try {
      const customer = await ensureCustomer(user);
      const session = await stripeApi('POST', '/checkout/sessions', {
        mode: 'subscription',
        customer,
        line_items: [{ price, quantity: 1 }],
        client_reference_id: user.id,
        subscription_data: { metadata: { uid: user.id } },
        allow_promotion_codes: true,
        success_url: `${baseUrl}/membership.html?status=success${next ? `&next=${encodeURIComponent(next)}` : ''}`,
        cancel_url: `${baseUrl}/membership.html?status=cancel`,
      });
      return sendJson(res, 200, { url: session.url });
    } catch {
      return sendJson(res, 502, { error: 'Could not start checkout. Please try again.' });
    }
  }

  async function portal(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    if (!configured) return sendJson(res, 503, { error: 'Card payments aren’t available yet.' });
    if (!user.stripeCustomerId) return sendJson(res, 400, { error: 'No billing account found.' });
    if (!limiter.hit(user.id).allowed) return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });

    try {
      const session = await stripeApi('POST', '/billing_portal/sessions', {
        customer: user.stripeCustomerId,
        return_url: `${baseUrl}/account.html`,
      });
      return sendJson(res, 200, { url: session.url });
    } catch {
      return sendJson(res, 502, { error: 'Could not open the billing portal.' });
    }
  }

  async function webhook(req, res) {
    const raw = await readRawBody(req, 1_048_576);
    if (raw === null) { res.writeHead(400); return res.end('Invalid payload'); }
    if (!webhookSecret) { res.writeHead(503); return res.end('Webhook not configured'); }
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], webhookSecret)) {
      res.writeHead(400); return res.end('Bad signature');
    }
    let event; try { event = JSON.parse(raw.toString('utf8')); } catch { res.writeHead(400); return res.end('Bad JSON'); }

    // Idempotency: a redelivered event id is acknowledged but not re-processed.
    if (paymentsStore.isStripeEventProcessed(event.id)) {
      return sendJson(res, 200, { received: true, duplicate: true });
    }
    try {
      await handleEvent(event);
      await paymentsStore.markStripeEvent(event.id);
    } catch {
      // Leave it unmarked so Stripe retries; 500 signals "retry me".
      res.writeHead(500); return res.end('Handler error');
    }
    return sendJson(res, 200, { received: true });
  }

  /** Public: which plans are available (+ their prices), so the page can render them. */
  async function config(req, res) {
    let prices = { month: null, year: null };
    if (configured) { try { prices = await priceInfo(); } catch { /* show generic */ } }
    sendJson(res, 200, {
      enabled: configured,
      intervals: { month: !!priceMonthly, year: !!priceYearly },
      prices,
    });
  }

  /** Route dispatch. Returns true if handled. */
  async function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/pay/stripe/config') { await config(req, res); return true; }
    if (req.method !== 'POST') return false;
    if (url.pathname === '/api/pay/stripe/webhook') { await webhook(req, res); return true; }
    if (url.pathname === '/api/pay/stripe/checkout') { await checkout(req, res); return true; }
    if (url.pathname === '/api/pay/stripe/portal') { await portal(req, res); return true; }
    return false;
  }

  return { handle, configured, _test: { applySubscription, handleEvent, resolveUid, ensureCustomer } };
}
