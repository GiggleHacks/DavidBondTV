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
import { hasActiveMembership, membershipSummary } from './membership.js';
import { ownsProduct } from './entitlements.js';
import { sendMembershipGrantedEmail, sendProductGrantedEmail, mailerConfigured } from './mailer.js';

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
  products = null, pricing = null, coupons = null,
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
  telegramNotifier = null,
  // Injectable so tests can spy on confirmation emails; defaults to the real mailer.
  mailer = { sendMembershipGrantedEmail, sendProductGrantedEmail, mailerConfigured },
}) {
  // Wired when we have a secret key + at least one price. Offering only monthly
  // (or only yearly) is fine — the frontend hides the plan that has no price.
  // Until configured, checkout/portal return 503 (the webhook still verifies if
  // its secret is set).
  const configured = !!(secretKey && (priceMonthly || priceYearly) && fetchImpl);
  // One-time course/product purchases don't need a membership price configured —
  // pricing is dynamic (price_data), so a secret key + fetch is enough to charge.
  const canCharge = !!(secretKey && fetchImpl);
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

  // Fetch + cache the legacy env price amounts — only used to backfill the DB
  // pricing once at boot (see envPriceAmounts). Cached for the process lifetime.
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

  async function ensureStripeCoupon(coupon) {
    if (!coupons || !coupon) return null;
    if (coupons.stripeCouponFresh && coupons.stripeCouponFresh(coupon)) return coupon.stripeCouponId;
    const params = {
      percent_off: coupon.percentOff,
      duration: coupon.duration || 'once',
      name: coupon.label || coupon.code,
      metadata: { couponId: coupon.id, code: coupon.code },
    };
    if (coupon.duration === 'repeating' && coupon.durationInMonths) params.duration_in_months = coupon.durationInMonths;
    if (coupon.maxRedemptions) params.max_redemptions = coupon.maxRedemptions;
    if (coupon.expiresAt) params.redeem_by = Math.floor(coupon.expiresAt / 1000);
    const stripeCoupon = await stripeApi('POST', '/coupons', params);
    if (coupons.setStripeCoupon) coupons.setStripeCoupon(coupon.id, stripeCoupon.id);
    return stripeCoupon.id;
  }

  function recordCouponRedemption(uid, obj, kind, productId = null) {
    if (!coupons || !obj || !obj.metadata || !obj.metadata.couponId) return;
    coupons.recordRedemption({
      couponId: obj.metadata.couponId,
      code: obj.metadata.couponCode || null,
      userId: uid,
      ts: Date.now(),
      kind,
      productId,
      amountDiscount: obj.total_details && typeof obj.total_details.amount_discount === 'number'
        ? obj.total_details.amount_discount : null,
      currency: obj.currency || null,
      sessionId: obj.id || null,
    });
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
    // Send the welcome email exactly once per subscription. Both the webhook and
    // the synchronous reconcile call this — whichever runs first stamps
    // `welcomeEmailFor`, so the second is a no-op and we never double-send.
    const active = hasActiveMembership({ membership });
    const prevWelcome = prev && prev.membership ? prev.membership.welcomeEmailFor : null;
    const shouldEmail = active && !!sub.id && prevWelcome !== sub.id;
    membership.welcomeEmailFor = shouldEmail ? sub.id : (prevWelcome || null);
    const patch = { membership };
    if (sub.customer) patch.stripeCustomerId = sub.customer;
    // Keep the legacy flag in lockstep with current active state for any reads
    // not yet migrated to hasActiveMembership().
    patch.hasPurchased = active;
    await store.updateUser(uid, patch);
    console.log(`[pay] membership ${active ? 'ACTIVE' : (sub.status || 'updated')} uid=${uid} sub=${sub.id || '?'}`);
    if (shouldEmail) {
      const email = prev && prev.email;
      if (email && mailer.mailerConfigured()) {
        try {
          await mailer.sendMembershipGrantedEmail(email, `${baseUrl}/videos`);
          console.log(`[pay] welcome email sent uid=${uid}`);
        } catch (e) {
          console.error(`[pay] welcome email FAILED uid=${uid}: ${e && e.message}`);
        }
      } else if (!mailer.mailerConfigured()) {
        console.warn(`[pay] mailer not configured — no welcome email sent uid=${uid}`);
      }
    }
    // Owner alert for a brand-new paid member. Gated by the same once-per-
    // subscription condition as the welcome email, so it fires exactly once even
    // when both the webhook and the synchronous reconcile run for the same sale.
    if (shouldEmail && telegramNotifier) {
      try {
        const recurringAmount = priceOrPlan ? (priceOrPlan.unit_amount ?? priceOrPlan.amount ?? null) : null;
        // The real amount taken today (intro/coupon applied) when the invoice is
        // expanded on the subscription; otherwise fall back to the recurring price.
        const inv = sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
        const chargedToday = inv && typeof inv.amount_paid === 'number' ? inv.amount_paid : recurringAmount;
        const coupon = sub.discount && sub.discount.coupon ? sub.discount.coupon : null;
        telegramNotifier.notify('new_subscription', {
          username: (prev && prev.username) || uid,
          email: (prev && prev.email) || '?',
          interval,
          amount: recurringAmount, // back-compat
          recurringAmount,
          chargedToday,
          currency: priceOrPlan ? (priceOrPlan.currency || null) : (inv ? inv.currency : null),
          couponCode: coupon ? (coupon.name || coupon.id || null) : null,
          couponPercentOff: coupon ? (typeof coupon.percent_off === 'number' ? coupon.percent_off : null) : null,
        });
        console.log(`[pay] telegram new-member alert sent uid=${uid}`);
      } catch { /* never block payment flow */ }
    }
  }

  /**
   * Grant a one-time product entitlement (course/bundle/digital) to a user.
   * Idempotent: a redelivered session is skipped. Append-only — never touches
   * `membership`/`hasPurchased` (courses are a separate purchase from membership).
   */
  async function applyProductEntitlement(uid, { productId, sessionId, amount = null, currency = null } = {}) {
    if (!uid || !productId) return;
    const u = store.getById(uid);
    if (!u) {
      // Paid session but the user record is gone (deleted, or a restore lag). The
      // grant is lost — surface it loudly rather than silently dropping a paid sale.
      console.error(`[pay] product entitlement LOST — no user uid=${uid} product=${productId} session=${sessionId || '?'}`);
      return;
    }
    // Atomic, deduped append in the store's critical section. The webhook and the
    // synchronous reconcile race on the same sale; `added` is true for exactly one
    // of them, so email/Telegram/ledger fire once and a redelivered session is a
    // no-op (never a double grant, double email, or dropped sibling product).
    const r = await store.addProductEntitlement(uid, {
      productId, provider: 'stripe', stripeSessionId: sessionId || null, amount, currency, purchasedAt: Date.now(),
    });
    if (!r.added) return;

    // Confirmation email for the new purchase (best-effort; never blocks).
    const product = products && products.getById ? products.getById(productId) : null;
    if (u.email && product && mailer.mailerConfigured()) {
      try {
        await mailer.sendProductGrantedEmail(u.email, product.name, `${baseUrl}/course.html?slug=${encodeURIComponent(product.slug)}`);
        console.log(`[pay] product email sent uid=${uid} product=${productId}`);
      } catch (e) {
        console.error(`[pay] product email FAILED uid=${uid}: ${e && e.message}`);
      }
    } else if (!mailer.mailerConfigured()) {
      console.warn(`[pay] mailer not configured — no product email sent uid=${uid}`);
    }
    // Owner alert for the new course/product sale (new-grant branch only, so a
    // redelivered session never double-pings).
    if (telegramNotifier) {
      try {
        telegramNotifier.notify('course_purchase', {
          username: u.username || uid,
          email: u.email || '?',
          product: (product && product.name) || productId,
          amount, currency,
        });
        console.log(`[pay] telegram course-sale alert sent uid=${uid} product=${productId}`);
      } catch { /* never block payment flow */ }
    }
    // Ledger txn — inside the new-grant branch so a webhook retry can't double-count.
    await paymentsStore.addTxn(uid, {
      kind: 'stripe.product.paid', ts: Date.now(), productId, amount, currency, sessionId: sessionId || null,
    });
  }

  function telegramSaleWithAmount(eventType, uid, obj) {
    if (!telegramNotifier) return;
    try {
      const u = store.getById(uid);
      telegramNotifier.notify(eventType, {
        username: u?.username || uid,
        email: u?.email || '?',
        interval: u?.membership?.interval || '?',
        amount: typeof obj.amount_paid === 'number' ? obj.amount_paid : (obj.amount_due ?? null),
        currency: obj.currency || null,
        timestamp: new Date().toISOString(),
      });
    } catch { /* never block payment flow */ }
  }

  /** Apply the side effects of one Stripe event. Idempotency is handled by the caller. */
  async function handleEvent(event) {
    const type = event && event.type;
    const obj = event && event.data && event.data.object;
    if (!type || !obj) return;

    // `completed` covers instant (card) payments; `async_payment_succeeded` fires
    // later for delayed methods (bank debits, etc.) that aren't paid at completion.
    // Handling both means those sales still grant access. Idempotent dedup lives in
    // applyProductEntitlement (by session id), so a session that fires both is safe.
    if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
      const uid = obj.client_reference_id || resolveUid(obj);
      if (!uid) {
        if (obj.payment_status === 'paid') console.error(`[pay] PAID session with no resolvable uid session=${obj.id || '?'}`);
        return;
      }
      if (obj.customer) {
        const u = store.getById(uid);
        if (u && !u.stripeCustomerId) await store.updateUser(uid, { stripeCustomerId: obj.customer });
      }
      // One-time product purchase (mode:'payment'): grant the entitlement and
      // stop — no subscription is created, no invoice.paid fires. amount_total /
      // currency live on the SESSION here (not amount_paid, which is invoice-only).
      if (obj.mode === 'payment' && obj.metadata && obj.metadata.productId) {
        await applyProductEntitlement(uid, {
          productId: obj.metadata.productId,
          sessionId: obj.id,
          amount: typeof obj.amount_total === 'number' ? obj.amount_total : null,
          currency: obj.currency || null,
        });
        recordCouponRedemption(uid, obj, 'product', obj.metadata.productId);
        return;
      }
      recordCouponRedemption(uid, obj, 'membership');
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
      if (uid) {
        await applySubscription(uid, obj);
      }
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
        // Renewal alert only for genuine recurring charges — the first invoice of
        // a new subscription (billing_reason 'subscription_create') is already
        // covered by the "new member" alert, so skip it to avoid a double-ping.
        if (type === 'invoice.paid' && obj.billing_reason !== 'subscription_create') {
          telegramSaleWithAmount('renewal', uid, obj);
        }
      }
    }
  }

  // --- route handlers ---

  async function checkout(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    if (!user.profileComplete) return sendJson(res, 403, { error: 'Finish setting up your profile first.' });
    if (!canCharge || !pricing) return sendJson(res, 503, { error: 'Card payments aren’t available yet.' });
    if (!limiter.hit(user.id).allowed) return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });

    const raw = await readBody(req, 4096);
    let body; try { body = JSON.parse(raw); } catch { body = null; }
    const interval = body && body.interval === 'year' ? 'year' : 'month';
    const cfg = pricing.getConfig();
    const currency = cfg.currency || 'usd';
    // Prices are built on the fly from our DB (price_data) — no pre-created Stripe
    // Price objects, so an admin change is live on the next checkout.
    const recurringAmount = interval === 'year' ? cfg.yearly.amount : cfg.monthly.amount;
    if (interval === 'year' && !cfg.yearly.enabled) return sendJson(res, 400, { error: 'That plan isn’t available.' });
    if (!Number.isInteger(recurringAmount) || recurringAmount <= 0) return sendJson(res, 400, { error: 'That plan isn’t available.' });

    const line_items = [{
      quantity: 1,
      price_data: {
        currency,
        product_data: { name: interval === 'year' ? 'David Bond TV Membership (annual)' : 'David Bond TV Membership' },
        recurring: { interval },
        unit_amount: recurringAmount,
      },
    }];
    const subscription_data = { metadata: { uid: user.id } };
    let appliedCoupon = null;
    if (coupons && body && body.couponCode) {
      const valid = coupons.validate(body.couponCode, { userId: user.id });
      if (!valid.ok) return sendJson(res, 400, { error: valid.error || 'That code is not valid.' });
      appliedCoupon = valid.coupon;
      subscription_data.metadata.couponId = appliedCoupon.id;
      subscription_data.metadata.couponCode = appliedCoupon.code;
    }

    // Intro pricing (monthly only): charge the intro amount NOW as a one-time line
    // item, and put the recurring plan on a one-interval trial so it doesn't also
    // bill today. Result: "first month <intro>, then <recurring>/mo" — works
    // whether intro is higher or lower than the recurring price.
    const intro = cfg.monthly.introAmount;
    if (interval === 'month' && Number.isInteger(intro) && intro > 0) {
      line_items.push({
        quantity: 1,
        price_data: {
          currency,
          product_data: { name: cfg.monthly.introLabel || 'First month' },
          unit_amount: intro,
        },
      });
      subscription_data.trial_period_days = 30;
    }

    // Return-to-content after payment: only same-origin relative paths allowed.
    const next = body && typeof body.next === 'string' && body.next.startsWith('/') && !body.next.startsWith('//')
      ? body.next : '';

    try {
      const customer = await ensureCustomer(user);
      const stripeCouponId = appliedCoupon ? await ensureStripeCoupon(appliedCoupon) : null;
      const session = await stripeApi('POST', '/checkout/sessions', {
        mode: 'subscription',
        customer,
        line_items,
        client_reference_id: user.id,
        subscription_data,
        discounts: stripeCouponId ? [{ coupon: stripeCouponId }] : undefined,
        allow_promotion_codes: stripeCouponId ? undefined : true,
        success_url: `${baseUrl}/membership.html?status=success&session_id={CHECKOUT_SESSION_ID}${next ? `&next=${encodeURIComponent(next)}` : ''}`,
        cancel_url: `${baseUrl}/membership.html?status=cancel`,
      });
      console.log(`[pay] checkout session created uid=${user.id} interval=${interval} coupon=${appliedCoupon ? appliedCoupon.code : 'none'}`);
      return sendJson(res, 200, { url: session.url });
    } catch (e) {
      console.error(`[pay] checkout FAILED uid=${user.id}: ${e && e.message}`);
      return sendJson(res, 502, { error: 'Could not start checkout. Please try again.' });
    }
  }

  /**
   * One-time purchase of a product (course/bundle/digital). Pricing is dynamic —
   * the amount comes from our own catalog (price_data), never the client, so a
   * tampered request can't change what's charged. mode:'payment' (no recurring).
   */
  async function buy(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    if (!user.profileComplete) return sendJson(res, 403, { error: 'Finish setting up your profile first.' });
    if (!canCharge || !products) return sendJson(res, 503, { error: 'Card payments aren’t available yet.' });
    if (!limiter.hit(user.id).allowed) return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });

    const raw = await readBody(req, 4096);
    let body; try { body = JSON.parse(raw); } catch { body = null; }
    const productId = body && typeof body.productId === 'string' ? body.productId : '';
    const product = productId ? products.getById(productId) : null;
    if (!product || !product.published) return sendJson(res, 404, { error: 'That product isn’t available.' });
    if (!Number.isInteger(product.price) || product.price <= 0) return sendJson(res, 400, { error: 'That product isn’t purchasable.' });
    if (ownsProduct(user, product.id)) return sendJson(res, 409, { error: 'You already own this.' });
    // Return-to-content after payment: only same-origin relative paths allowed.
    const next = body && typeof body.next === 'string' && body.next.startsWith('/') && !body.next.startsWith('//')
      ? body.next : '';
    let appliedCoupon = null;
    if (coupons && body && body.couponCode) {
      const valid = coupons.validate(body.couponCode, { userId: user.id });
      if (!valid.ok) return sendJson(res, 400, { error: valid.error || 'That code is not valid.' });
      appliedCoupon = valid.coupon;
    }

    try {
      const customer = await ensureCustomer(user);
      const meta = { uid: user.id, productId: product.id };
      if (appliedCoupon) { meta.couponId = appliedCoupon.id; meta.couponCode = appliedCoupon.code; }
      const stripeCouponId = appliedCoupon ? await ensureStripeCoupon(appliedCoupon) : null;
      const session = await stripeApi('POST', '/checkout/sessions', {
        mode: 'payment',
        customer,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: product.currency || 'usd',
            unit_amount: product.price,
            product_data: { name: product.name, description: product.description || undefined },
          },
        }],
        client_reference_id: user.id,
        metadata: meta,
        payment_intent_data: { metadata: meta },
        discounts: stripeCouponId ? [{ coupon: stripeCouponId }] : undefined,
        allow_promotion_codes: stripeCouponId ? undefined : true,
        success_url: `${baseUrl}/course.html?slug=${encodeURIComponent(product.slug)}&status=success&session_id={CHECKOUT_SESSION_ID}${next ? `&next=${encodeURIComponent(next)}` : ''}`,
        cancel_url: `${baseUrl}/course.html?slug=${encodeURIComponent(product.slug)}&status=cancel`,
      });
      return sendJson(res, 200, { url: session.url });
    } catch (e) {
      console.error(`[pay] buy FAILED uid=${user.id} product=${product.id}: ${e && e.message}`);
      return sendJson(res, 502, { error: 'Could not start checkout. Please try again.' });
    }
  }

  /**
   * Synchronous activation on return from Checkout — the safety net that means a
   * paid user is NEVER left un-activated by a slow/missing/misconfigured webhook.
   * The client posts the `session_id` Stripe put on the success URL; we fetch the
   * session, confirm it belongs to THIS signed-in user, and apply the
   * subscription/product right away. Idempotent: re-running (or the webhook also
   * firing) is harmless. The webhook stays the canonical channel for the ongoing
   * lifecycle (renewals, cancellations, failures).
   */
  async function reconcile(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    if (!canCharge) return sendJson(res, 503, { error: 'Card payments aren’t available yet.' });
    if (!limiter.hit(user.id).allowed) return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });
    const raw = await readBody(req, 4096);
    let body; try { body = JSON.parse(raw); } catch { body = null; }
    const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return sendJson(res, 400, { error: 'Missing or invalid session.' });

    try {
      const session = await stripeApi('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
      // Ownership: our uid is stamped on the session as client_reference_id (and
      // metadata.uid). Require a match — fail CLOSED if neither is present, so a
      // user can never activate off a session that isn't provably theirs.
      const refUid = session.client_reference_id || (session.metadata && session.metadata.uid) || null;
      if (refUid !== user.id) {
        console.warn(`[pay] reconcile ownership mismatch uid=${user.id} ref=${refUid || 'none'} session=${sessionId}`);
        return sendJson(res, 403, { error: 'This checkout does not belong to you.' });
      }
      const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';

      if (session.mode === 'subscription' && session.subscription) {
        if (!paid) {
          console.log(`[pay] reconcile pending uid=${user.id} status=${session.payment_status} session=${sessionId}`);
        } else {
          const sub = await stripeApi('GET', `/subscriptions/${session.subscription}`);
          if (!sub.metadata || !sub.metadata.uid) {
            try { await stripeApi('POST', `/subscriptions/${session.subscription}`, { metadata: { uid: user.id } }); } catch { /* ignore */ }
          }
          recordCouponRedemption(user.id, session, 'membership');
          await applySubscription(user.id, sub);
          console.log(`[pay] reconcile applied subscription uid=${user.id} sub=${session.subscription}`);
        }
      } else if (session.mode === 'payment' && session.metadata && session.metadata.productId) {
        if (paid) {
          await applyProductEntitlement(user.id, {
            productId: session.metadata.productId,
            sessionId: session.id,
            amount: typeof session.amount_total === 'number' ? session.amount_total : null,
            currency: session.currency || null,
          });
          recordCouponRedemption(user.id, session, 'product', session.metadata.productId);
          console.log(`[pay] reconcile applied product uid=${user.id} product=${session.metadata.productId}`);
        }
      }

      const fresh = store.getById(user.id) || user;
      return sendJson(res, 200, { ok: true, membership: membershipSummary(fresh) });
    } catch (e) {
      console.error(`[pay] reconcile error uid=${user.id} session=${sessionId}: ${e && e.message}`);
      return sendJson(res, 502, { error: 'Could not verify your payment yet. Please refresh in a moment.' });
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
    } catch (e) {
      console.error(`[pay] portal FAILED uid=${user.id}: ${e && e.message}`);
      return sendJson(res, 502, { error: 'Could not open the billing portal.' });
    }
  }

  /**
   * Self-serve cancel: set the subscription to cancel at the end of the paid
   * period (the user keeps access until then). Stripe stays the source of truth;
   * we optimistically reflect cancelAtPeriodEnd locally and the webhook confirms.
   */
  async function cancel(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    if (!configured) return sendJson(res, 503, { error: 'Card payments aren’t available yet.' });
    const m = user.membership;
    if (!m || m.provider !== 'stripe' || !m.stripeSubscriptionId) {
      return sendJson(res, 400, { error: 'No active card subscription to cancel.' });
    }
    if (m.cancelAtPeriodEnd) {
      return sendJson(res, 200, { ok: true, cancelAtPeriodEnd: true, currentPeriodEnd: m.currentPeriodEnd || null });
    }
    if (!limiter.hit(user.id).allowed) return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });
    try {
      const sub = await stripeApi('POST', `/subscriptions/${encodeURIComponent(m.stripeSubscriptionId)}`, { cancel_at_period_end: true });
      // Optimistic local update; the customer.subscription.updated webhook will
      // reconcile the authoritative state shortly after.
      const next = { ...m, cancelAtPeriodEnd: true, updatedAt: Date.now() };
      if (typeof sub.current_period_end === 'number') next.currentPeriodEnd = sub.current_period_end * 1000;
      await store.updateUser(user.id, { membership: next });
      return sendJson(res, 200, { ok: true, cancelAtPeriodEnd: true, currentPeriodEnd: next.currentPeriodEnd || null });
    } catch {
      return sendJson(res, 502, { error: 'Could not cancel right now — please try again, or use “Manage billing”.' });
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

    console.log(`[pay] webhook received type=${event.type} id=${event.id}`);
    // Idempotency: a redelivered event id is acknowledged but not re-processed.
    if (paymentsStore.isStripeEventProcessed(event.id)) {
      console.log(`[pay] webhook duplicate id=${event.id} (skipped)`);
      return sendJson(res, 200, { received: true, duplicate: true });
    }
    try {
      await handleEvent(event);
      await paymentsStore.markStripeEvent(event.id);
    } catch (e) {
      // Leave it unmarked so Stripe retries; 500 signals "retry me".
      console.error(`[pay] webhook handler error type=${event.type} id=${event.id}: ${e && e.message}`);
      res.writeHead(500); return res.end('Handler error');
    }
    return sendJson(res, 200, { received: true });
  }

  /** Public: plans + their prices (from our DB) so pages render real, live values. */
  async function config(req, res) {
    const base = pricing
      ? pricing.publicConfig()
      : { currency: 'usd', intervals: { month: false, year: false }, prices: { month: null, year: null }, intro: null };
    // `enabled` gates the buy buttons: needs a charge-capable Stripe key AND a
    // priced monthly/yearly plan.
    const purchasable = canCharge && (base.intervals.month || base.intervals.year);
    sendJson(res, 200, { enabled: purchasable, ...base });
  }

  /**
   * Legacy env Stripe prices' amounts (cents), for the one-time pricing backfill
   * at boot. Returns { month: cents|null, year: cents|null }. Best-effort.
   */
  async function envPriceAmounts() {
    if (!secretKey || !fetchImpl) return { month: null, year: null };
    try {
      const info = await priceInfo();
      return {
        month: info.month && Number.isInteger(info.month.amount) ? info.month.amount : null,
        year: info.year && Number.isInteger(info.year.amount) ? info.year.amount : null,
      };
    } catch { return { month: null, year: null }; }
  }

  /**
   * Admin safety-net: pull a user's real subscription straight from Stripe and
   * apply it. Use when a payment went through Stripe but the local membership is
   * out of sync (e.g. a webhook was missed). Reuses applySubscription, so it also
   * sends the (deduped) welcome email. Returns { ok, membership } or { ok:false }.
   */
  async function resyncUser(uid) {
    const u = store.getById(uid);
    if (!u) return { ok: false, error: 'No such user.' };
    if (!canCharge) return { ok: false, error: 'Stripe is not configured on this server.' };
    if (!u.stripeCustomerId) return { ok: false, error: 'No Stripe customer is linked to this user.' };
    let list;
    try {
      list = await stripeApi('GET', `/subscriptions?customer=${encodeURIComponent(u.stripeCustomerId)}&status=all&limit=10`);
    } catch (e) {
      return { ok: false, error: `Stripe lookup failed: ${e && e.message}` };
    }
    const subs = (list && list.data) || [];
    if (!subs.length) return { ok: false, error: 'No subscriptions found for this customer in Stripe.' };
    const ACTIVE = new Set(['active', 'trialing', 'past_due']);
    const chosen = subs.find((s) => ACTIVE.has(s.status)) || subs[0];
    if (!chosen.metadata || !chosen.metadata.uid) {
      try { await stripeApi('POST', `/subscriptions/${chosen.id}`, { metadata: { uid } }); } catch { /* ignore */ }
    }
    await applySubscription(uid, chosen);
    console.log(`[pay] admin resync uid=${uid} sub=${chosen.id} status=${chosen.status}`);
    const fresh = store.getById(uid);
    return { ok: true, membership: membershipSummary(fresh) };
  }

  /** Route dispatch. Returns true if handled. */
  async function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/pay/stripe/config') { await config(req, res); return true; }
    if (req.method !== 'POST') return false;
    if (url.pathname === '/api/pay/stripe/webhook') { await webhook(req, res); return true; }
    if (url.pathname === '/api/pay/stripe/checkout') { await checkout(req, res); return true; }
    if (url.pathname === '/api/pay/stripe/reconcile') { await reconcile(req, res); return true; }
    if (url.pathname === '/api/pay/stripe/buy') { await buy(req, res); return true; }
    if (url.pathname === '/api/pay/stripe/portal') { await portal(req, res); return true; }
    if (url.pathname === '/api/pay/stripe/cancel') { await cancel(req, res); return true; }
    return false;
  }

  return { handle, configured, resyncUser, envPriceAmounts, _test: { applySubscription, applyProductEntitlement, handleEvent, resolveUid, ensureCustomer, checkout, reconcile } };
}
