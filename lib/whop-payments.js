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

  /** Map a WHOP event's data object back to our user id: metadata first, email fallback. */
  function resolveUid(data) {
    if (!data) return null;
    const meta = data.metadata
      || data.membership_metadata
      || (data.membership && typeof data.membership === 'object' && data.membership.metadata)
      || (data.checkout && data.checkout.metadata)
      || null;
    const fromMeta = meta && (meta.userId || meta.uid || meta.user_id || meta.customer_id);
    if (fromMeta && store.getById(fromMeta)) return fromMeta;
    // Fallback: match the buyer's WHOP email to a site account. Covers a checkout
    // that lost its metadata (e.g. the hosted-link fallback path).
    const email = data.email
      || data.user_email
      || (data.user && typeof data.user === 'object' && data.user.email)
      || (data.member && typeof data.member === 'object' && data.member.email)
      || null;
    if (email) { const u = store.getByEmail(email); if (u) return u.id; }
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

  // --- grant / revoke side effects ---

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
    if (!u) { console.error(`[whop] grant LOST — no user uid=${uid} membership=${membershipId || '?'}`); return; }
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
      const uid = resolveUid(data);
      if (!uid) {
        // The membership_activated event carries metadata.userId, so this is rare —
        // log loudly so a paid sale that can't be linked is never silently dropped.
        console.error(`[whop] ${type} with no resolvable uid — membership=${membershipIdOf(type, data) || '?'}`);
        return;
      }
      const periodEndSec = firstNum(data.renewal_period_end, data.expires_at, data.valid_until);
      const periodEndMs = Number.isFinite(periodEndSec) ? periodEndSec * 1000 : null;
      // The charged amount lives on a payment event (membership events omit it).
      const amount = firstNum(data.final_amount, data.amount, data.subtotal, data.total);
      const amountCents = Number.isFinite(amount) ? Math.round(amount * 100) : null;
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
      return;
    }

    if (REVOKE_EVENTS.has(type)) {
      const uid = resolveUid(data);
      if (uid) await revokeMembership(uid, { eventType: type });
      return;
    }
    // Anything else (entry_created, dispute_created, trial_ending_soon, …) is a no-op.
  }

  // --- route handlers ---

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

    try {
      // Create a v2 checkout session for the existing plan, stamping our userId in
      // metadata so the webhook can map the sale back to this account, and a
      // redirect_url so WHOP sends the buyer back to our success page after paying.
      // WHOP attaches the metadata to the resulting Membership and echoes it back.
      const session = await whopApi('POST', `${WHOP_API_V2}/checkout_sessions`, {
        plan_id: planId,
        redirect_url: redirectUrl,
        metadata: { userId: user.id, email: user.email || undefined },
      });
      const url = session.purchase_url
        || session.checkout_url
        || (session.id ? `https://whop.com/checkout/${session.id}` : `https://whop.com/checkout/${planId}`);
      console.log(`[whop] checkout created uid=${user.id} plan=${planId}`);
      return sendJson(res, 200, { url });
    } catch (e) {
      // Resilient fallback: send the buyer to the plain hosted checkout for the
      // plan. Metadata is lost on this path, so the webhook resolves the sale by
      // the buyer's email instead (see resolveUid). They can still pay + unlock.
      console.error(`[whop] checkout session FAILED (falling back to hosted link) uid=${user.id}: ${e && e.message}`);
      return sendJson(res, 200, { url: `https://whop.com/checkout/${encodeURIComponent(planId)}`, degraded: true });
    }
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
          return valid && (byMeta || byEmail);
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
    });
  }

  /** Route dispatch. Returns true if handled. */
  async function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/pay/whop/config') { await config(req, res); return true; }
    if (req.method !== 'POST') return false;
    if (url.pathname === '/api/pay/whop/webhook') { await webhook(req, res); return true; }
    if (url.pathname === '/api/pay/whop/checkout') { await checkout(req, res); return true; }
    if (url.pathname === '/api/pay/whop/reconcile') { await reconcile(req, res); return true; }
    return false;
  }

  return { handle, configured, _test: { handleEvent, grantMembership, revokeMembership, resolveUid, membershipIdOf, checkout, webhook, config, reconcile } };
}
