// WHOP integration — recurring, single-tier, all-access membership. This is the
// card rail that replaces the suspended Stripe account. Kept in the project's
// hand-rolled spirit (no SDK): the WHOP REST API is called with fetch + JSON, and
// webhook signatures are verified per the Standard Webhooks spec (base64 HMAC) —
// a DIFFERENT scheme from Stripe's `t=,v1=` hex (see verifyWhopSignature below).
// All WHOP-specific knowledge lives here; the rest of the app only reads
// user.membership (see lib/membership.js), so WHOP is just a third provider beside
// 'stripe' and 'crypto'.
//
// Flow: client POSTs /api/pay/whop/checkout → we create a WHOP checkout session
// for the configured plan carrying metadata{userId} + a redirect_url → return the
// purchase_url → WHOP hosts the payment → WHOP calls our webhook
// (payment.succeeded / membership.went_valid) → we write user.membership. Renewals
// and cancellations arrive as later membership.* webhooks and keep us in sync.
import crypto from 'node:crypto';
import { sendJson, readBody, readRawBody } from './http-util.js';
import { createRateLimiter } from './rate-limit.js';
import { hasActiveMembership, membershipSummary } from './membership.js';
import { ownsProduct } from './entitlements.js';
import { sendMembershipGrantedEmail, sendProductGrantedEmail, mailerConfigured } from './mailer.js';

const WHOP_API = 'https://api.whop.com/api/v1';
// Checkout sessions live on the v2 API (v1 has no such route); plan lookups are v1.
const WHOP_API_V2 = 'https://api.whop.com/api/v2';
const DAY_MS = 24 * 60 * 60 * 1000;

// WHOP's webhook `action` strings use UNDERSCORES (payment_succeeded,
// membership_activated, …) — confirmed from the dashboard's event list. We also
// normalize any dotted form (payment.succeeded) to underscores so either spelling
// matches. Events that grant/extend access:
const GRANT_EVENTS = new Set(['payment_succeeded', 'membership_activated', 'membership_went_valid']);
// Events that end access: the membership going invalid (cancellation taking effect,
// a failed renewal, or leaving), or a refund/chargeback. We revoke immediately
// (WHOP fires membership_deactivated only once access is actually invalid, not at
// "cancel at period end" — that's a separate event we intentionally ignore).
const REVOKE_EVENTS = new Set([
  'membership_deactivated', 'membership_went_invalid', 'membership_cancelled', 'membership_canceled',
  'refund_created', 'payment_refunded',
]);

/** Normalize a WHOP event name to its underscore form (payment.succeeded → payment_succeeded). */
const normEvent = (t) => (typeof t === 'string' ? t.replace(/\./g, '_') : '');

/**
 * Candidate HMAC keys for a WHOP webhook secret. WHOP's secret is `ws_<hex>`, which
 * doesn't fit the classic Svix `whsec_<base64>` convention, and WHOP's SDK guidance
 * is to base64-ENCODE the secret before validation (so the effective key is the raw
 * secret bytes). Rather than bet on one derivation — a wrong guess silently fails
 * every webhook — we derive every plausible key from the (trusted) secret and accept
 * a signature that matches ANY. All candidates require knowing the secret, so this
 * doesn't weaken forgery resistance.
 */
function whopKeyCandidates(secret) {
  const keys = [];
  const push = (b) => { if (b && b.length) keys.push(b); };
  // 1) Raw secret string bytes (the WHOP "base64-encode then standard-webhooks
  //    base64-decodes it back" path → key is the literal `ws_…` string).
  push(Buffer.from(secret, 'utf8'));
  // 2) Classic Standard-Webhooks: strip a whsec_ prefix, base64-decode the rest.
  try { push(Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64')); } catch { /* not base64 */ }
  // 3) `ws_<hex>` → the 64 hex chars decoded to 32 raw bytes.
  const hexBody = secret.startsWith('ws_') ? secret.slice(3) : secret;
  if (/^[0-9a-fA-F]+$/.test(hexBody) && hexBody.length % 2 === 0) {
    try { push(Buffer.from(hexBody, 'hex')); } catch { /* not hex */ }
  }
  // 4) The secret string without the ws_ prefix, as raw bytes.
  if (secret.startsWith('ws_')) push(Buffer.from(secret.slice(3), 'utf8'));
  return keys;
}

const num = (v) => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN));
function firstNum(...vals) {
  for (const v of vals) { const n = num(v); if (Number.isFinite(n)) return n; }
  return NaN;
}

/**
 * Verify a WHOP webhook signature (Standard Webhooks spec — https://www.standardwebhooks.com).
 * WHOP sends three headers:
 *   webhook-id          — unique event id (also our idempotency key)
 *   webhook-timestamp   — unix seconds
 *   webhook-signature   — space-delimited list of "v1,<base64-hmac>" entries
 * The signed content is `${id}.${timestamp}.${rawBody}`; the HMAC-SHA256 key is the
 * webhook secret base64-DECODED (a leading "whsec_" is stripped first), and the
 * digest is compared base64-encoded, constant-time, within the timestamp tolerance.
 * Never throws — returns false on any malformed input.
 */
export function verifyWhopSignature(rawBody, headers, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!secret || !headers || rawBody == null) return false;
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sigHeader = headers['webhook-signature'];
  if (!id || !ts || typeof sigHeader !== 'string') return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  // Replay window: reject signatures whose timestamp is too far from now.
  if (toleranceSec > 0 && Math.abs(now / 1000 - tsNum) > toleranceSec) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const toSign = `${id}.${ts}.${body}`;
  const keys = whopKeyCandidates(secret);
  if (!keys.length) return false;
  // Expected signature under each candidate key (raw HMAC bytes).
  const expecteds = keys.map((k) => crypto.createHmac('sha256', k).update(toSign, 'utf8').digest());
  // The header may carry several space-delimited "v1,<base64>" signatures (key
  // rotation) — accept if any provided signature matches any candidate key.
  return sigHeader.split(' ').some((part) => {
    if (!part) return false;
    const comma = part.indexOf(',');
    const sig = comma === -1 ? part : part.slice(comma + 1);
    let sigBuf;
    try { sigBuf = Buffer.from(sig, 'base64'); } catch { return false; }
    return expecteds.some((exp) => sigBuf.length === exp.length && crypto.timingSafeEqual(sigBuf, exp));
  });
}

export function createWhopPayments({
  store, currentUser, paymentsStore, baseUrl,
  apiKey, webhookSecret, planId, companyId = null,
  // Product catalog, so one-time course purchases can run on the card rail too.
  // Each product carries its own WHOP plan id (products.whopPlanId).
  products = null,
  // Membership term granted per paid period. WHOP keeps us in sync via renewal/
  // cancellation webhooks, so this is a generous ceiling (a few days past the
  // 30-day billing cycle) so a slightly-late renewal webhook never briefly lapses.
  termDays = 33,
  // Fallback price (USD, dollars) for the config endpoint when the live plan
  // lookup is unavailable — keeps the Card headline rendering.
  priceUsd = null,
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
  telegramNotifier = null,
  // Injectable so tests can spy on confirmation emails; defaults to the real mailer.
  mailer = { sendMembershipGrantedEmail, sendProductGrantedEmail, mailerConfigured },
  now = Date.now,
}) {
  // Wired once we have an API key + a plan id + fetch. Until then config reports
  // disabled (frontend hides the Card option) and checkout returns 503. The
  // webhook still verifies if its secret is set.
  const configured = !!(apiKey && planId && fetchImpl);
  // Products carry their own plan ids, so selling a course by card does NOT depend
  // on WHOP_PLAN_ID (the membership plan) being set.
  const apiReady = !!(apiKey && fetchImpl);
  const termMs = termDays * DAY_MS;
  const limiter = createRateLimiter(60_000, 10); // 10 checkout attempts/min per user

  async function whopApi(method, p, body) {
    // `p` may be a v1 path (prefixed with the v1 base) or a full URL (e.g. a v2 route).
    const target = /^https?:\/\//.test(p) ? p : `${WHOP_API}${p}`;
    const res = await fetchImpl(target, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json && (json.message || (json.error && (json.error.message || json.error)))) || `WHOP ${res.status}`;
      const err = new Error(typeof msg === 'string' ? msg : `WHOP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // --- live plan price (for the config endpoint), cached briefly ---
  let planCache = null;
  let planCacheAt = 0;
  async function planInfo() {
    if (!configured) return null;
    if (planCache && now() - planCacheAt < 60_000) return planCache;
    try {
      const p = await whopApi('GET', `/plans/${encodeURIComponent(planId)}`);
      // initial_price = the first charge (a higher "signup" first month); renewal_price
      // = the ongoing monthly. We surface both so the page can show "$19.69/mo · $28
      // first month" instead of mislabeling the signup charge as the recurring price.
      const price = firstNum(p.initial_price, p.renewal_price, p.price);
      const renewal = firstNum(p.renewal_price, p.price, p.initial_price);
      const days = firstNum(p.billing_period, p.billing_period_days);
      planCache = {
        price: Number.isFinite(price) ? price : null,
        renewalPrice: Number.isFinite(renewal) ? renewal : null,
        currency: (p.base_currency || p.currency || 'usd'),
        interval: Number.isFinite(days) && days >= 350 ? 'year' : 'month',
      };
      planCacheAt = now();
    } catch (e) {
      console.warn(`[whop] plan lookup failed (using fallback price): ${e && e.message}`);
    }
    return planCache;
  }

  // --- event → user mapping ---

  /** The buyer email carried by an event, wherever WHOP put it. */
  function emailOf(data) {
    if (!data) return null;
    return data.email
      || data.user_email
      || (data.user && typeof data.user === 'object' && data.user.email)
      || (data.member && typeof data.member === 'object' && data.member.email)
      || null;
  }

  /**
   * Map a WHOP event's data object back to our user id.
   *
   * Order matters: metadata (exact) → WHOP email (usually right) → the pending
   * checkout we recorded before sending them to WHOP (the only thing that saves a
   * degraded checkout, which carries no metadata AND no redirect_url, when the
   * buyer's WHOP email differs from their site email).
   */
  function resolveUid(data) {
    if (!data) return null;
    const meta = data.metadata
      || data.membership_metadata
      || (data.membership && typeof data.membership === 'object' && data.membership.metadata)
      || (data.checkout && data.checkout.metadata)
      || null;
    const fromMeta = meta && (meta.userId || meta.uid || meta.user_id || meta.customer_id);
    if (fromMeta && store.getById(fromMeta)) return fromMeta;
    const email = emailOf(data);
    if (email) { const u = store.getByEmail(email); if (u) return u.id; }
    if (typeof paymentsStore.findPendingWhopCheckout === 'function') {
      const pending = paymentsStore.findPendingWhopCheckout(
        { planId: planIdOf(data) || planId, email },
        { now: now() },
      );
      if (pending && store.getById(pending.userId)) {
        console.log(`[whop] resolved uid from pending checkout uid=${pending.userId} (metadata + email both missed)`);
        return pending.userId;
      }
    }
    return null;
  }

  /** The WHOP membership id carried by an event (payment events nest it under `membership`). */
  function membershipIdOf(type, data) {
    if (!data) return null;
    if (typeof data.membership === 'string' && data.membership) return data.membership;
    if (data.membership && typeof data.membership === 'object' && data.membership.id) return data.membership.id;
    if (data.membership_id) return data.membership_id;
    // On a membership_* event the data object IS the membership, so its own id is it.
    if (typeof type === 'string' && type.startsWith('membership') && data.id) return data.id;
    return null;
  }

  /** The WHOP plan id an event refers to (membership events carry it directly). */
  function planIdOf(data) {
    if (!data) return null;
    const pick = (v) => {
      if (typeof v === 'string' && v) return v;
      if (v && typeof v === 'object' && typeof v.id === 'string' && v.id) return v.id;
      return null;
    };
    return pick(data.plan)
      || pick(data.plan_id)
      || (data.membership && typeof data.membership === 'object'
        ? (pick(data.membership.plan) || pick(data.membership.plan_id))
        : null);
  }

  /**
   * Is this event about a plan we actually sell?
   *
   * WHOP sends every membership event for the whole company, and we grant by
   * matching the buyer's email when metadata is missing (see resolveUid). Without
   * this check, ANY membership on ANY plan in the account — including a $0 or
   * $1 test plan sitting on a hidden access pass — would grant a full paid
   * membership to whoever's email matched, and a deactivation on such a plan
   * would revoke a real paying member's access.
   *
   * Fail-open when the payload carries no plan id at all (not every event shape
   * includes one, and dropping a real sale is worse than the narrow hole this
   * closes); fail-closed only on a positive mismatch.
   */
  function isSoldPlan(data) {
    const pid = planIdOf(data);
    if (!pid) return true;
    if (pid === planId) return true;
    return !!productForPlan(pid);
  }

  /** The product sold by a given WHOP plan id, or null. */
  function productForPlan(pid) {
    if (!pid || !products || typeof products.list !== 'function') return null;
    return products.list().find((p) => p.whopPlanId && p.whopPlanId === pid) || null;
  }

  /**
   * Which product (if any) a grant event is for. Plan id is the reliable key: it's
   * on the event whether or not metadata survived, and each product has its own
   * plan. Metadata is only a shortcut when present.
   */
  function resolveProductId(data) {
    const meta = data && (data.metadata
      || data.membership_metadata
      || (data.membership && typeof data.membership === 'object' && data.membership.metadata)
      || (data.checkout && data.checkout.metadata));
    const fromMeta = meta && meta.productId;
    if (fromMeta && products && products.getById && products.getById(fromMeta)) return fromMeta;
    const pid = planIdOf(data);
    // The membership plan is never a product, so don't let it match one.
    if (!pid || pid === planId) return null;
    const p = productForPlan(pid);
    return p ? p.id : null;
  }

  /**
   * A payment moved money but access did NOT unlock. Keep the console.error (it's
   * how this was found), and additionally make it durable + push it to the owner,
   * because a buyer sitting on a charge with no access is the one failure nobody
   * discovers on their own. Never let alerting throw: this runs inside the webhook,
   * and a rejection there makes WHOP retry the delivery forever.
   */
  async function alertUnresolved({ reason, uid = null, email = null, product = null, reference = null, amountCents = null, currency = 'usd', detail = null }) {
    try {
      const u = uid ? store.getById(uid) : null;
      await paymentsStore.addUnresolvedPayment({
        kind: reason, userId: uid, email: email || (u && u.email) || null,
        productId: product, reference, amountCents, currency, detail,
      });
      if (telegramNotifier && typeof telegramNotifier.notify === 'function') {
        await telegramNotifier.notify('payment_needs_attention', {
          reason, username: u && u.username, email: email || (u && u.email) || null,
          product, reference, amount: amountCents, currency, detail,
        });
      }
    } catch (e) {
      console.error(`[whop] could not record unresolved payment (${reason}): ${e && e.message}`);
    }
  }

  // --- grant / revoke side effects ---

  /**
   * Grant lifetime access to a one-time product bought by card.
   *
   * Dedupe is the entitlement itself: addProductEntitlement refuses a second entry
   * for the same productId, so payment_succeeded + membership_activated for one sale
   * grant once and fire the email/alert/ledger once. No extra idempotency state.
   */
  async function grantProduct(uid, productId, { membershipId = null, amountCents = null, currency = 'usd', eventType = '' } = {}) {
    const u = store.getById(uid);
    const product = products && products.getById ? products.getById(productId) : null;
    if (!u) {
      console.error(`[whop] product grant LOST — no user uid=${uid} product=${productId}`);
      await alertUnresolved({
        reason: 'whop.grant.lost', uid, product: productId, reference: membershipId,
        amountCents, currency, detail: 'Paid for a course on WHOP but the account no longer exists.',
      });
      return;
    }
    const r = await store.addProductEntitlement(uid, {
      productId, provider: 'whop', whopMembershipId: membershipId,
      amount: amountCents, currency, purchasedAt: now(),
    });
    if (!r.added) return;   // already owned → this is a duplicate event
    console.log(`[whop] product GRANTED uid=${uid} product=${productId} via=${eventType}`);
    if (u.email && product && mailer.mailerConfigured()) {
      try { await mailer.sendProductGrantedEmail(u.email, product.name, `${baseUrl}/courses/${encodeURIComponent(product.slug)}`); }
      catch (e) { console.error(`[whop] product email FAILED uid=${uid}: ${e && e.message}`); }
    }
    if (telegramNotifier) {
      try {
        telegramNotifier.notify('course_purchase', {
          username: u.username || uid, email: u.email || '?',
          product: (product && product.name) || productId,
          amount: amountCents, currency,
        });
      } catch { /* never block a grant on an alert */ }
    }
    if (paymentsStore) {
      await paymentsStore.addTxn(uid, {
        kind: 'whop.product.paid', ts: now(), productId,
        amountCents, currency, whopMembershipId: membershipId,
      });
    }
  }

  /** Remove a product entitlement (card refund / dispute on a one-time purchase). */
  async function revokeProduct(uid, productId, { eventType = '' } = {}) {
    const u = store.getById(uid);
    if (!u || !Array.isArray(u.products)) return;
    const kept = u.products.filter((p) => !(p && p.productId === productId));
    if (kept.length === u.products.length) return;
    await store.updateUser(uid, { products: kept });
    console.log(`[whop] product REVOKED uid=${uid} product=${productId} via=${eventType}`);
    if (paymentsStore) {
      await paymentsStore.addTxn(uid, { kind: 'whop.product.refunded', ts: now(), productId });
    }
  }

  /**
   * Grant or extend a WHOP membership. Both payment_succeeded and membership_activated
   * call this to unlock access; the one-time side effects (welcome email, Telegram
   * alert, ledger txn) are deduped per membership id via `welcomeEmailFor`, so they
   * fire exactly once per sale no matter which event lands first — and never again on
   * a renewal/reactivation (those reuse the same membership id). True duplicate events
   * are already short-circuited by the webhook-id idempotency guard upstream.
   */
  async function grantMembership(uid, { membershipId = null, amountCents = null, currency = 'usd', periodEndMs = null, announce = false, eventType = '' } = {}) {
    const u = store.getById(uid);
    if (!u) {
      console.error(`[whop] grant LOST — no user uid=${uid} membership=${membershipId || '?'}`);
      await alertUnresolved({
        reason: 'whop.grant.lost', uid, reference: membershipId,
        amountCents, currency, detail: 'Paid on WHOP but the account no longer exists.',
      });
      return;
    }
    const prev = u.membership && u.membership.provider === 'whop' ? u.membership : {};
    // Extend from the later of "now" or an existing future expiry (renewals stack).
    const base = (prev.currentPeriodEnd && prev.currentPeriodEnd > now()) ? prev.currentPeriodEnd : now();
    const currentPeriodEnd = (Number.isFinite(periodEndMs) && periodEndMs > now()) ? periodEndMs : base + termMs;
    // First time we've seen THIS membership id → fire the sale side effects once.
    const prevWelcome = prev.welcomeEmailFor || null;
    const isNew = announce && !!membershipId && prevWelcome !== membershipId;
    const membership = {
      provider: 'whop',
      status: 'active',
      interval: 'month',
      whopMembershipId: membershipId || prev.whopMembershipId || null,
      currentPeriodEnd,
      cancelAtPeriodEnd: false,
      since: typeof prev.since === 'number' ? prev.since : now(),
      updatedAt: now(),
      welcomeEmailFor: isNew ? membershipId : prevWelcome,
    };
    const active = hasActiveMembership({ membership });
    await store.updateUser(uid, { membership, hasPurchased: active });
    console.log(`[whop] membership ${active ? 'ACTIVE' : 'updated'} uid=${uid} membership=${membershipId || '?'} via=${eventType}`);
    if (!isNew) return; // access granted above; side effects only on the first event for this sale
    if (u.email && mailer.mailerConfigured()) {
      try { await mailer.sendMembershipGrantedEmail(u.email, `${baseUrl}/videos`); console.log(`[whop] welcome email sent uid=${uid}`); }
      catch (e) { console.error(`[whop] welcome email FAILED uid=${uid}: ${e && e.message}`); }
    } else if (!mailer.mailerConfigured()) {
      console.warn(`[whop] mailer not configured — no welcome email sent uid=${uid}`);
    }
    if (telegramNotifier) {
      try {
        telegramNotifier.notify('whop_membership', { username: u.username || uid, email: u.email || '?', interval: 'month', amount: amountCents, currency });
        console.log(`[whop] telegram new-member alert sent uid=${uid}`);
      } catch { /* never block payment flow */ }
    }
    if (paymentsStore) {
      await paymentsStore.addTxn(uid, { kind: 'whop.membership.paid', ts: now(), interval: 'month', amount: amountCents, currency, whopMembershipId: membershipId || null });
    }
  }

  /** End a WHOP membership (cancellation took effect / failed renewal / refund). */
  async function revokeMembership(uid, { eventType = '' } = {}) {
    const u = store.getById(uid);
    if (!u) return;
    const prev = u.membership;
    // Only touch a WHOP membership — never clobber a Stripe/admin/crypto one.
    if (!prev || prev.provider !== 'whop') return;
    const membership = { ...prev, status: 'canceled', currentPeriodEnd: now(), cancelAtPeriodEnd: true, updatedAt: now() };
    await store.updateUser(uid, { membership, hasPurchased: false });
    console.log(`[whop] membership REVOKED uid=${uid} via=${eventType}`);
  }

  /** Apply the side effects of one WHOP event. Idempotency is handled by the caller. */
  async function handleEvent(evt) {
    const type = normEvent(evt && (evt.type || evt.action));
    const data = evt && (evt.data || evt.object);
    if (!type || !data) return;

    if (GRANT_EVENTS.has(type)) {
      if (!isSoldPlan(data)) {
        console.warn(`[whop] ${type} ignored — plan=${planIdOf(data)} is not the plan we sell (${planId})`);
        return;
      }
      const uid = resolveUid(data);
      if (!uid) {
        // The membership_activated event carries metadata.userId, so this is rare —
        // log loudly so a paid sale that can't be linked is never silently dropped.
        console.error(`[whop] ${type} with no resolvable uid — membership=${membershipIdOf(type, data) || '?'}`);
        await alertUnresolved({
          reason: 'whop.grant.unresolvable', email: emailOf(data),
          reference: membershipIdOf(type, data),
          detail: 'Paid on WHOP but no site account matched — most likely a different email on WHOP.',
        });
        return;
      }
      const periodEndSec = firstNum(data.renewal_period_end, data.expires_at, data.valid_until);
      const periodEndMs = Number.isFinite(periodEndSec) ? periodEndSec * 1000 : null;
      // The charged amount lives on a payment event (membership events omit it).
      const amount = firstNum(data.final_amount, data.amount, data.subtotal, data.total);
      const amountCents = Number.isFinite(amount) ? Math.round(amount * 100) : null;
      // A one-time product sale looks identical at the event level — the plan id is
      // what distinguishes it. Branch before grantMembership so buying a course
      // never hands out a subscription.
      const productId = resolveProductId(data);
      if (productId) {
        await grantProduct(uid, productId, {
          membershipId: membershipIdOf(type, data),
          amountCents, currency: data.currency || 'usd', eventType: type,
        });
        if (typeof paymentsStore.clearPendingWhopCheckout === 'function') {
          await paymentsStore.clearPendingWhopCheckout(`${planIdOf(data) || planId}:${uid}`);
        }
        return;
      }
      // Both payment_succeeded and membership_activated unlock access; the sale
      // side effects (email/Telegram/ledger) are deduped per membership id inside
      // grantMembership, so they fire exactly once no matter which event lands first.
      await grantMembership(uid, {
        membershipId: membershipIdOf(type, data),
        amountCents,
        currency: data.currency || 'usd',
        periodEndMs,
        announce: true,
        eventType: type,
      });
      // Sale landed — the pending bridge record has done its job.
      if (typeof paymentsStore.clearPendingWhopCheckout === 'function') {
        await paymentsStore.clearPendingWhopCheckout(`${planIdOf(data) || planId}:${uid}`);
      }
      return;
    }

    if (REVOKE_EVENTS.has(type)) {
      // Same guard as the grant path: a cancellation on some other plan in the
      // account must never revoke a member's real, paid access.
      if (!isSoldPlan(data)) {
        console.warn(`[whop] ${type} ignored — plan=${planIdOf(data)} is not the plan we sell (${planId})`);
        return;
      }
      const uid = resolveUid(data);
      if (!uid) return;
      // A refunded COURSE must not cancel someone's membership.
      const productId = resolveProductId(data);
      if (productId) { await revokeProduct(uid, productId, { eventType: type }); return; }
      await revokeMembership(uid, { eventType: type });
      return;
    }
    // Anything else (entry_created, dispute_created, trial_ending_soon, …) is a no-op.
  }

  // --- route handlers ---

  /**
   * Shared checkout-session creation for both rails (membership + one-time product).
   * Records the pending bridge first, retries a transient failure once, and only
   * then degrades to the plain hosted link. Returns the JSON body to send.
   */
  async function startCheckout({ user, targetPlan, productId = null, redirectUrl }) {
    // Recorded BEFORE we call WHOP so it exists even if the session create fails —
    // it's what lets the webhook attribute a degraded checkout (no metadata, no
    // redirect_url) back to this buyer.
    if (typeof paymentsStore.addPendingWhopCheckout === 'function') {
      await paymentsStore.addPendingWhopCheckout({ userId: user.id, planId: targetPlan, productId, email: user.email }, now());
    }

    // Most session-create failures are transient (5xx / network), and the degraded
    // path is materially worse for the buyer — so pay for one retry before falling back.
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Stamp our userId (and productId) in metadata so the webhook can map the
        // sale back, and a redirect_url so WHOP returns the buyer to our success
        // page. WHOP attaches the metadata to the Membership and echoes it back.
        const session = await whopApi('POST', `${WHOP_API_V2}/checkout_sessions`, {
          plan_id: targetPlan,
          redirect_url: redirectUrl,
          metadata: { userId: user.id, email: user.email || undefined, productId: productId || undefined },
        });
        const url = session.purchase_url
          || session.checkout_url
          || (session.id ? `https://whop.com/checkout/${session.id}` : `https://whop.com/checkout/${targetPlan}`);
        console.log(`[whop] checkout created uid=${user.id} plan=${targetPlan}${productId ? ` product=${productId}` : ''}${attempt ? ` (retry ${attempt})` : ''}`);
        return { url };
      } catch (e) {
        lastErr = e;
      }
    }

    // Degraded: the plain hosted link still lets them pay (a dead button is worse),
    // but it carries no metadata and no redirect_url — so the webhook can only match
    // by WHOP email or the pending record above, and `reconcile` will never run.
    // Flag it now so David can watch for a sale that doesn't unlock itself.
    console.error(`[whop] checkout session FAILED (falling back to hosted link) uid=${user.id}: ${lastErr && lastErr.message}`);
    if (typeof paymentsStore.addPendingWhopCheckout === 'function') {
      await paymentsStore.addPendingWhopCheckout({ userId: user.id, planId: targetPlan, productId, email: user.email, degraded: true }, now());
    }
    await alertUnresolved({
      reason: 'whop.checkout.degraded', uid: user.id, product: productId,
      detail: `Could not create a WHOP checkout session (${lastErr && lastErr.message}); buyer sent to the plain hosted link. If they pay, access may not unlock automatically.`,
    });
    return { url: `https://whop.com/checkout/${encodeURIComponent(targetPlan)}`, degraded: true };
  }

  async function checkout(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    if (!configured) return sendJson(res, 503, { error: 'Card payments aren’t available yet.' });
    if (hasActiveMembership(user)) return sendJson(res, 409, { error: 'You already have an active membership.' });
    if (!limiter.hit(user.id).allowed) return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });

    const raw = await readBody(req, 4096);
    let body; try { body = JSON.parse(raw); } catch { body = null; }
    // Return-to-content after payment: only same-origin relative paths allowed.
    const next = body && typeof body.next === 'string' && body.next.startsWith('/') && !body.next.startsWith('//')
      ? body.next : '';
    const redirectUrl = `${baseUrl}/membership.html?status=success${next ? `&next=${encodeURIComponent(next)}` : ''}`;
    return sendJson(res, 200, await startCheckout({ user, targetPlan: planId, redirectUrl }));
  }

  /**
   * Card checkout for a ONE-TIME product (e.g. the $299 course), which until now
   * could only be bought with ETH. Independent of the membership plan: a product
   * brings its own WHOP plan id, so this works even without WHOP_PLAN_ID set.
   */
  async function productCheckout(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    if (!apiReady) return sendJson(res, 503, { error: 'Card payments aren’t available yet.' });
    if (!limiter.hit(user.id).allowed) return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });

    const raw = await readBody(req, 4096);
    let body; try { body = JSON.parse(raw); } catch { body = null; }
    const productId = body && typeof body.productId === 'string' ? body.productId : '';
    const product = productId && products && products.getById ? products.getById(productId) : null;
    if (!product || !product.published) return sendJson(res, 404, { error: 'That product isn’t available.' });
    if (!Number.isInteger(product.price) || product.price <= 0) return sendJson(res, 400, { error: 'That product isn’t purchasable.' });
    if (!product.whopPlanId) return sendJson(res, 503, { error: 'Card payments aren’t set up for this product yet.' });
    if (ownsProduct(user, productId)) return sendJson(res, 409, { error: 'You already own this.' });

    const next = body && typeof body.next === 'string' && body.next.startsWith('/') && !body.next.startsWith('//')
      ? body.next : '';
    const redirectUrl = `${baseUrl}/courses/${encodeURIComponent(product.slug)}?status=success${next ? `&next=${encodeURIComponent(next)}` : ''}`;
    return sendJson(res, 200, await startCheckout({ user, targetPlan: product.whopPlanId, productId, redirectUrl }));
  }

  async function webhook(req, res) {
    const raw = await readRawBody(req, 1_048_576);
    if (raw === null) { res.writeHead(400); return res.end('Invalid payload'); }
    if (!webhookSecret) { res.writeHead(503); return res.end('Webhook not configured'); }
    if (!verifyWhopSignature(raw, req.headers, webhookSecret)) {
      res.writeHead(400); return res.end('Bad signature');
    }
    let evt; try { evt = JSON.parse(raw.toString('utf8')); } catch { res.writeHead(400); return res.end('Bad JSON'); }

    const eventId = req.headers['webhook-id'] || null;
    const type = evt && (evt.type || evt.action);
    console.log(`[whop] webhook received type=${type} id=${eventId || '?'}`);
    // Idempotency: a redelivered event id is acknowledged but not re-processed.
    if (eventId && paymentsStore.isWhopEventProcessed(eventId)) {
      console.log(`[whop] webhook duplicate id=${eventId} (skipped)`);
      return sendJson(res, 200, { received: true, duplicate: true });
    }
    try {
      await handleEvent(evt);
      if (eventId) await paymentsStore.markWhopEvent(eventId);
    } catch (e) {
      // Leave it unmarked so WHOP retries; 500 signals "retry me".
      console.error(`[whop] webhook handler error type=${type} id=${eventId}: ${e && e.message}`);
      res.writeHead(500); return res.end('Handler error');
    }
    return sendJson(res, 200, { received: true });
  }

  /**
   * Redirect-time safety net: on return from WHOP the page can POST here to pull the
   * buyer's membership straight from WHOP and grant it, covering a slow/missing
   * webhook. Best-effort — the webhook stays the canonical channel, so any lookup
   * failure just returns the current (possibly not-yet-active) membership summary.
   */
  async function reconcile(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    if (configured && !hasActiveMembership(user)) {
      try {
        const q = companyId ? `?company_id=${encodeURIComponent(companyId)}` : '';
        const list = await whopApi('GET', `/memberships${q}`);
        const items = Array.isArray(list) ? list : (list && Array.isArray(list.data) ? list.data : []);
        const mine = items.find((m) => {
          const meta = m && m.metadata;
          const byMeta = meta && (meta.userId === user.id || meta.uid === user.id);
          const byEmail = user.email && ((m.email && m.email.toLowerCase() === user.email.toLowerCase())
            || (m.user && m.user.email && m.user.email.toLowerCase() === user.email.toLowerCase()));
          const valid = m && (m.valid === true || m.status === 'active' || m.status === 'completed');
          // Same plan guard as the webhook: this route is reachable by any signed-in
          // user, so without it a membership on a $0/test plan would self-serve access.
          return valid && isSoldPlan(m) && (byMeta || byEmail);
        });
        if (mine) {
          const periodEndSec = firstNum(mine.renewal_period_end, mine.expires_at, mine.valid_until);
          await grantMembership(user.id, {
            membershipId: mine.id || null,
            amountCents: null,
            currency: mine.currency || 'usd',
            periodEndMs: Number.isFinite(periodEndSec) ? periodEndSec * 1000 : null,
            announce: false, // the webhook owns the sale alert/email; avoid double-firing
            eventType: 'reconcile',
          });
        }
      } catch (e) {
        console.warn(`[whop] reconcile lookup failed uid=${user.id}: ${e && e.message}`);
      }
    }
    const fresh = store.getById(user.id) || user;
    return sendJson(res, 200, { ok: true, membership: membershipSummary(fresh) });
  }

  /**
   * The product equivalent of `reconcile`. The course page POSTs here on return
   * from WHOP so a slow webhook can't leave a paid buyer looking at a locked course.
   */
  async function productReconcile(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    const raw = await readBody(req, 4096);
    let body; try { body = JSON.parse(raw); } catch { body = null; }
    const productId = body && typeof body.productId === 'string' ? body.productId : '';
    const product = productId && products && products.getById ? products.getById(productId) : null;
    if (!product) return sendJson(res, 404, { error: 'That product isn’t available.' });

    if (apiReady && product.whopPlanId && !ownsProduct(user, productId)) {
      try {
        const q = companyId ? `?company_id=${encodeURIComponent(companyId)}` : '';
        const list = await whopApi('GET', `/memberships${q}`);
        const items = Array.isArray(list) ? list : (list && Array.isArray(list.data) ? list.data : []);
        const mine = items.find((m) => {
          const meta = m && m.metadata;
          const byMeta = meta && (meta.userId === user.id || meta.uid === user.id);
          const byEmail = user.email && ((m.email && m.email.toLowerCase() === user.email.toLowerCase())
            || (m.user && m.user.email && m.user.email.toLowerCase() === user.email.toLowerCase()));
          const valid = m && (m.valid === true || m.status === 'active' || m.status === 'completed');
          // Must be THIS product's plan — otherwise a membership would unlock a course.
          return valid && planIdOf(m) === product.whopPlanId && (byMeta || byEmail);
        });
        if (mine) {
          await grantProduct(user.id, productId, {
            membershipId: mine.id || null,
            currency: mine.currency || 'usd',
            eventType: 'reconcile',
          });
        }
      } catch (e) {
        console.warn(`[whop] product reconcile lookup failed uid=${user.id}: ${e && e.message}`);
      }
    }
    const fresh = store.getById(user.id) || user;
    return sendJson(res, 200, { ok: true, ownsProduct: ownsProduct(fresh, productId) });
  }

  /**
   * Warn before a member silently lapses.
   *
   * Access is granted in `termDays` (33) chunks and extended by renewal webhooks. If
   * those stop arriving — rotated secret, changed endpoint, WHOP-side config drift —
   * nothing errors: every member just quietly loses access 33 days after their last
   * event, and the first David hears of it is a complaint. This alerts while there's
   * still time to fix the webhook.
   */
  async function sweepExpiringMemberships({ warnWithinMs = 5 * DAY_MS } = {}) {
    if (typeof store.listAll !== 'function') return { warned: 0 };
    const ts = now();
    let warned = 0;
    for (const u of store.listAll()) {
      const m = u && u.membership;
      if (!m || m.provider !== 'whop' || m.status !== 'active') continue;
      if (m.cancelAtPeriodEnd) continue;          // ending on purpose, not a fault
      if (!Number.isFinite(m.currentPeriodEnd)) continue;
      const left = m.currentPeriodEnd - ts;
      if (left <= 0 || left > warnWithinMs) continue;
      // Once per period, keyed off the expiry we warned about.
      if (m.lapseWarnedFor === m.currentPeriodEnd) continue;
      await store.updateUser(u.id, { membership: { ...m, lapseWarnedFor: m.currentPeriodEnd } });
      warned += 1;
      console.warn(`[whop] membership expiring uid=${u.id} in ${Math.round(left / DAY_MS)}d with no renewal event`);
      await alertUnresolved({
        reason: 'whop.membership.expiring', uid: u.id, reference: m.whopMembershipId,
        detail: `Access ends in ${Math.round(left / DAY_MS)} day(s) and no renewal webhook has arrived. If they are still paying on WHOP, the webhook is broken — check the endpoint and WHOP_WEBHOOK_SECRET.`,
      });
    }
    if (warned) console.log(`[whop] expiry sweep: warned=${warned}`);
    return { warned };
  }

  /** Public: is the WHOP card rail live, and at what price (so the page renders it). */
  async function config(req, res) {
    const info = await planInfo();
    const price = info && Number.isFinite(info.price) ? info.price
      : (Number.isFinite(num(priceUsd)) ? num(priceUsd) : null);
    const renewalPrice = info && Number.isFinite(info.renewalPrice) ? info.renewalPrice : price;
    sendJson(res, 200, {
      enabled: configured,
      cardEnabled: configured,
      provider: 'whop',
      price,                                   // first charge / signup (dollars) or null
      renewalPrice,                            // ongoing monthly (dollars) or null
      currency: (info && info.currency) || 'usd',
      interval: (info && info.interval) || 'month',
      // Separate flag: products carry their own plan ids, so card checkout for a
      // course works even when the membership plan isn't configured.
      productsEnabled: apiReady,
    });
  }

  /** Route dispatch. Returns true if handled. */
  async function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/pay/whop/config') { await config(req, res); return true; }
    if (req.method !== 'POST') return false;
    if (url.pathname === '/api/pay/whop/webhook') { await webhook(req, res); return true; }
    if (url.pathname === '/api/pay/whop/checkout') { await checkout(req, res); return true; }
    if (url.pathname === '/api/pay/whop/reconcile') { await reconcile(req, res); return true; }
    if (url.pathname === '/api/pay/whop/product/checkout') { await productCheckout(req, res); return true; }
    if (url.pathname === '/api/pay/whop/product/reconcile') { await productReconcile(req, res); return true; }
    return false;
  }

  return {
    handle, configured, productsEnabled: apiReady,
    // Live plan price, for the admin pricing panel (so it can show what the card
    // rail really charges rather than only the editable-but-inert fields).
    livePlanInfo: planInfo,
    sweepExpiringMemberships,
    _test: {
      handleEvent, grantMembership, revokeMembership, grantProduct, revokeProduct,
      resolveUid, resolveProductId, membershipIdOf, checkout, productCheckout,
      webhook, config, reconcile, productReconcile,
    },
  };
}
