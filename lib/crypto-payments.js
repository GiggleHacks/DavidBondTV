// Self-hosted crypto payment rail. Mirrors lib/stripe-payments.js: the watcher
// service (on cccbox) POSTs an HMAC-signed callback when a payment confirms; we
// verify, de-dupe per order, and grant via the SAME entitlement/membership +
// email + Telegram pipeline Stripe uses. No keys live here — only public addresses.
import { sendJson, readBody, readRawBody } from './http-util.js';
import { createRateLimiter } from './rate-limit.js';
import { verifyStripeSignature } from './stripe-payments.js'; // generic t=,v1= HMAC verifier
import { hasActiveMembership, membershipSummary } from './membership.js';
import { ownsProduct } from './entitlements.js';
import { sendMembershipGrantedEmail, sendProductGrantedEmail, mailerConfigured } from './mailer.js';
import { uniqueAmount } from './crypto-amount.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export function createCryptoPayments({
  store, ordersStore, currentUser, paymentsStore, baseUrl,
  webhookSecret, watcherUrl = null, watcherToken = null,
  cryptoConfig = { enabledCoins: [], coins: {}, orderTtlMs: 1200000, jitterMax: 200, membership: { termMonths: 3, priceUsd: 47 }, productDiscountPercent: 0 },
  products = null, pricing = null, coupons = null,
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
  telegramNotifier = null,
  mailer = { sendMembershipGrantedEmail, sendProductGrantedEmail, mailerConfigured },
  rng = Math.random, now = Date.now,
}) {
  const limiter = createRateLimiter(60_000, 10);

  // --- grant side effects (reused by the webhook) ---

  async function grantProduct(order) {
    const u = store.getById(order.userId);
    if (!u) { console.error(`[crypto] grant LOST — no user uid=${order.userId} order=${order.id}`); return; }
    const r = await store.addProductEntitlement(order.userId, {
      productId: order.productId, provider: 'crypto', cryptoOrderId: order.id,
      amount: order.amount, currency: order.coin, purchasedAt: now(),
    });
    if (!r.added) return;
    const product = products && products.getById ? products.getById(order.productId) : null;
    if (u.email && product && mailer.mailerConfigured()) {
      try { await mailer.sendProductGrantedEmail(u.email, product.name, `${baseUrl}/course.html?slug=${encodeURIComponent(product.slug)}`); }
      catch (e) { console.error(`[crypto] product email FAILED uid=${order.userId}: ${e && e.message}`); }
    }
    if (telegramNotifier) {
      try { telegramNotifier.notify('course_purchase', { username: u.username || order.userId, email: u.email || '?', product: (product && product.name) || order.productId, amount: order.amount, currency: order.coin }); } catch { /* never block */ }
    }
    if (paymentsStore) await paymentsStore.addTxn(order.userId, { kind: 'crypto.product.paid', ts: now(), productId: order.productId, amount: order.amount, currency: order.coin, orderId: order.id });
  }

  async function grantMembership(order) {
    const u = store.getById(order.userId);
    if (!u) { console.error(`[crypto] membership grant LOST — no user uid=${order.userId} order=${order.id}`); return; }
    const prev = u.membership || {};
    const months = order.termMonths || 3;
    const term = months * MONTH_MS;
    // Extend from the later of "now" or an existing future expiry (stacking re-ups).
    const base = (prev.currentPeriodEnd && prev.currentPeriodEnd > now()) ? prev.currentPeriodEnd : now();
    const membership = {
      provider: 'crypto', status: 'active', interval: `${months}mo`,
      currentPeriodEnd: base + term,
      since: typeof prev.since === 'number' ? prev.since : now(),
      updatedAt: now(),
    };
    const active = hasActiveMembership({ membership });
    await store.updateUser(order.userId, { membership, hasPurchased: active });
    if (u.email && mailer.mailerConfigured()) {
      try { await mailer.sendMembershipGrantedEmail(u.email, `${baseUrl}/videos`); }
      catch (e) { console.error(`[crypto] membership email FAILED uid=${order.userId}: ${e && e.message}`); }
    }
    if (telegramNotifier) {
      try { telegramNotifier.notify('new_subscription', { username: u.username || order.userId, email: u.email || '?', interval: `${months}mo`, amount: order.amount, currency: order.coin }); } catch { /* never block */ }
    }
    if (paymentsStore) await paymentsStore.addTxn(order.userId, { kind: 'crypto.membership.paid', ts: now(), interval: `${months}mo`, amount: order.amount, currency: order.coin, orderId: order.id });
  }

  async function webhook(req, res) {
    const raw = await readRawBody(req, 65_536);
    if (raw === null) { res.writeHead(400); return res.end('Invalid payload'); }
    if (!webhookSecret) { res.writeHead(503); return res.end('Webhook not configured'); }
    if (!verifyStripeSignature(raw, req.headers['x-crypto-signature'], webhookSecret)) {
      res.writeHead(400); return res.end('Bad signature');
    }
    let evt; try { evt = JSON.parse(raw.toString('utf8')); } catch { res.writeHead(400); return res.end('Bad JSON'); }
    const orderId = evt && evt.orderId;
    if (!orderId) { res.writeHead(400); return res.end('Missing orderId'); }
    console.log(`[crypto] webhook order=${orderId} coin=${evt.coin} conf=${evt.confirmations}`);
    if (ordersStore.isCallbackProcessed(orderId)) return sendJson(res, 200, { received: true, duplicate: true });

    const order = ordersStore.get(orderId);
    if (!order) { res.writeHead(404); return res.end('No such order'); }
    if (order.status === 'granted') return sendJson(res, 200, { received: true, duplicate: true });

    try {
      await ordersStore.update(orderId, { status: 'confirmed', txid: evt.txid || null, received: evt.amount || null, confirmedAt: now() });
      if (order.kind === 'membership') await grantMembership(order);
      else await grantProduct(order);
      await ordersStore.update(orderId, { status: 'granted', grantedAt: now() });
      await ordersStore.markCallback(orderId);
    } catch (e) {
      console.error(`[crypto] webhook handler error order=${orderId}: ${e && e.message}`);
      res.writeHead(500); return res.end('Handler error'); // leave unmarked → watcher retries
    }
    return sendJson(res, 200, { received: true });
  }

  /** Route dispatch. Returns true if handled. (checkout/orderStatus added in Task 6.) */
  async function handle(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/pay/crypto/webhook') { await webhook(req, res); return true; }
    return false;
  }

  return { handle, _test: { webhook, grantProduct, grantMembership } };
}
