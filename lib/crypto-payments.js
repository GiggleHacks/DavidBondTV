// Self-hosted crypto payment rail. The watcher service (on cccbox / the VPS) POSTs
// an HMAC-signed callback when a payment confirms; we verify, de-dupe per order,
// and grant via the SAME entitlement/membership + email + Telegram pipeline. No
// keys live here — only public addresses.
import { sendJson, readBody, readRawBody } from './http-util.js';
import { createRateLimiter } from './rate-limit.js';
import { verifyHmacSignature } from './webhook-signature.js'; // generic t=,v1= HMAC verifier
import { hasActiveMembership, membershipSummary } from './membership.js';
import { ownsProduct } from './entitlements.js';
import { sendMembershipGrantedEmail, sendProductGrantedEmail, mailerConfigured } from './mailer.js';
import { uniqueAmount } from './crypto-amount.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export function createCryptoPayments({
  store, ordersStore, currentUser, paymentsStore, baseUrl,
  webhookSecret, watcherUrl = null, watcherToken = null,
  cryptoConfig = { enabledCoins: [], coins: {}, orderTtlMs: 1200000, jitterMax: 200, membership: { plans: { '3mo': { months: 3, priceUsd: 59.07, label: '3 months' }, year: { months: 12, priceUsd: 197, label: '1 year' } } }, productDiscountPercent: 0 },
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
      try { telegramNotifier.notify('crypto_course', { username: u.username || order.userId, email: u.email || '?', product: (product && product.name) || order.productId, coinAmount: order.amount, coin: order.coin, usd: order.expectedFiat }); } catch { /* never block */ }
    }
    if (paymentsStore) await paymentsStore.addTxn(order.userId, { kind: 'crypto.product.paid', ts: now(), productId: order.productId, amount: order.amount, currency: order.coin, orderId: order.id });
  }

  async function grantMembership(order) {
    const u = store.getById(order.userId);
    if (!u) { console.error(`[crypto] membership grant LOST — no user uid=${order.userId} order=${order.id}`); return; }
    const prev = u.membership || {};
    // Idempotent per order: if this exact order already granted, do nothing (the
    // outer webhook guards usually catch duplicates, but this closes the narrow
    // window where the grant succeeded but the 'granted' status-write failed).
    if (prev.lastCryptoOrderId && prev.lastCryptoOrderId === order.id) return;
    const months = order.termMonths || 3;
    const term = months * MONTH_MS;
    // Extend from the later of "now" or an existing future expiry (stacking re-ups).
    const base = (prev.currentPeriodEnd && prev.currentPeriodEnd > now()) ? prev.currentPeriodEnd : now();
    const membership = {
      provider: 'crypto', status: 'active', interval: `${months}mo`,
      lastCryptoOrderId: order.id,
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
      try { telegramNotifier.notify('crypto_membership', { username: u.username || order.userId, email: u.email || '?', interval: `${months}mo`, coinAmount: order.amount, coin: order.coin, usd: order.expectedFiat }); } catch { /* never block */ }
    }
    if (paymentsStore) await paymentsStore.addTxn(order.userId, { kind: 'crypto.membership.paid', ts: now(), interval: `${months}mo`, amount: order.amount, currency: order.coin, orderId: order.id });
  }

  async function webhook(req, res) {
    const raw = await readRawBody(req, 65_536);
    if (raw === null) { res.writeHead(400); return res.end('Invalid payload'); }
    if (!webhookSecret) { res.writeHead(503); return res.end('Webhook not configured'); }
    if (!verifyHmacSignature(raw, req.headers['x-crypto-signature'], webhookSecret)) {
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

    // Broadcast detection (pre-confirmation): mark the order so the UI can show
    // "payment detected, confirming…". Do NOT grant and do NOT mark processed —
    // the confirmed callback (>=1 conf) is what grants.
    if (evt.outcome === 'detected') {
      if (order.status === 'waiting') {
        await ordersStore.update(orderId, { status: 'detected', txid: evt.txid || null });
      }
      return sendJson(res, 200, { received: true, detected: true });
    }

    // Underpayment: a short deposit arrived. Flag + alert the owner once; do NOT
    // grant and do NOT mark the callback processed (a later top-up that reaches the
    // full amount still sends a confirmed callback that grants).
    if (evt.outcome === 'underpaid') {
      if (!order.alerted) {
        await ordersStore.update(orderId, { status: 'underpaid', received: evt.amount || null, alerted: true });
        if (telegramNotifier) {
          try { telegramNotifier.notify('crypto_underpaid', { orderId, coin: order.coin, amount: order.amount, kind: order.kind }); } catch { /* never block */ }
        }
        console.warn(`[crypto] UNDERPAID order=${orderId} coin=${order.coin} expected=${order.amount}`);
      }
      return sendJson(res, 200, { received: true, underpaid: true });
    }

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

  // --- quote + watcher client ---
  async function getQuote(coin, usd) {
    if (!watcherUrl || !fetchImpl) throw new Error('watcher not configured');
    const r = await fetchImpl(`${watcherUrl}/quote?coin=${encodeURIComponent(coin.toLowerCase())}&usd=${encodeURIComponent(usd)}`, {
      headers: { Authorization: `Bearer ${watcherToken}` },
    });
    if (!r.ok) throw new Error(`quote failed ${coin}`);
    return r.json();
  }
  async function registerWatch(payload) {
    if (!watcherUrl || !fetchImpl) throw new Error('watcher not configured');
    const r = await fetchImpl(`${watcherUrl}/watch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${watcherToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error('watch registration failed');
    return r.json();
  }

  function newOrderId() {
    // url-safe short id, deterministic-friendly for tests via injected rng.
    return 'cry_' + Array.from({ length: 16 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rng() * 36)]).join('');
  }

  async function checkout(req, res) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    if (!user.profileComplete) return sendJson(res, 403, { error: 'Finish setting up your profile first.' });
    if (!limiter.hit(user.id).allowed) return sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });

    const raw = await readBody(req, 4096);
    let body; try { body = JSON.parse(raw); } catch { body = null; }
    const coin = body && typeof body.coin === 'string' ? body.coin.toUpperCase() : '';
    if (!cryptoConfig.enabledCoins.includes(coin)) return sendJson(res, 400, { error: 'That coin isn’t available.' });
    const coinCfg = cryptoConfig.coins[coin];
    const kind = body && body.kind === 'membership' ? 'membership' : 'product';

    // Resolve the fiat amount from our own catalog/pricing (never the client).
    let expectedFiatCents, productId = null, termMonths = null;
    if (kind === 'product') {
      productId = body && typeof body.productId === 'string' ? body.productId : '';
      const product = productId && products ? products.getById(productId) : null;
      if (!product || !product.published) return sendJson(res, 404, { error: 'That product isn’t available.' });
      if (!Number.isInteger(product.price) || product.price <= 0) return sendJson(res, 400, { error: 'That product isn’t purchasable.' });
      if (ownsProduct(user, product.id)) return sendJson(res, 409, { error: 'You already own this.' });
      // Crypto product discount (no fees, no chargebacks) — flat % off the catalog price.
      const pct = cryptoConfig.productDiscountPercent || 0;
      expectedFiatCents = Math.max(1, Math.round(product.price * (1 - pct / 100)));
    } else {
      // Crypto membership: pick a prepaid plan (e.g. '3mo' or 'year'). No auto-renew;
      // buying again stacks onto the current expiry (see grantMembership).
      const planKey = (body && typeof body.membershipPlan === 'string' && cryptoConfig.membership.plans[body.membershipPlan]) ? body.membershipPlan : '3mo';
      const plan = cryptoConfig.membership.plans[planKey];
      if (!plan) return sendJson(res, 400, { error: 'That plan isn’t available.' });
      termMonths = plan.months;
      expectedFiatCents = Math.round(plan.priceUsd * 100);
      if (!Number.isInteger(expectedFiatCents) || expectedFiatCents <= 0) return sendJson(res, 400, { error: 'That plan isn’t available.' });
    }

    // Optional coupon (percent off the fiat amount before quoting).
    if (coupons && body && body.couponCode) {
      const valid = coupons.validate(body.couponCode, { userId: user.id });
      if (!valid.ok) return sendJson(res, 400, { error: valid.error || 'That code is not valid.' });
      expectedFiatCents = Math.max(1, Math.round(expectedFiatCents * (1 - (valid.coupon.percentOff || 0) / 100)));
    }

    const usd = expectedFiatCents / 100;
    try {
      const quote = await getQuote(coin, usd);
      const jitter = Math.floor(rng() * (cryptoConfig.jitterMax + 1));
      const { amount } = uniqueAmount({ usd, rate: quote.rate, decimals: coinCfg.decimals, jitter });
      const t = now();
      const order = {
        id: newOrderId(), userId: user.id, kind, productId, termMonths,
        expectedFiat: usd, currency: 'usd', coin, address: coinCfg.address, amount,
        confirmations: coinCfg.confirmations, rateLockedAt: t, expiresAt: t + cryptoConfig.orderTtlMs,
        status: 'waiting', txid: null, received: null, createdAt: t, confirmedAt: null, grantedAt: null,
        alerted: false, lastPolledAt: t,
      };
      await ordersStore.create(order);
      await registerWatch({
        orderId: order.id, coin, address: coinCfg.address, expectedAmount: amount,
        confirmations: coinCfg.confirmations, expiresAt: order.expiresAt,
        callbackUrl: `${baseUrl}/api/pay/crypto/webhook`,
      });
      console.log(`[crypto] order ${order.id} ${kind} ${coin} ${amount} uid=${user.id}`);
      const qrPayload = coin === 'ETH'
        ? `ethereum:${coinCfg.address}?value=${amount}`
        : coin === 'LTC' ? `litecoin:${coinCfg.address}?amount=${amount}`
        : `monero:${coinCfg.address}?tx_amount=${amount}`;
      return sendJson(res, 200, { orderId: order.id, coin, address: coinCfg.address, amount, qrPayload, expiresAt: order.expiresAt });
    } catch (e) {
      console.error(`[crypto] checkout FAILED uid=${user.id} coin=${coin}: ${e && e.message}`);
      return sendJson(res, 502, { error: 'Could not start a crypto order. Please try again.' });
    }
  }

  async function orderStatus(req, res, orderId, user) {
    const u = user || currentUser(req);
    if (!u) return sendJson(res, 401, { error: 'Please sign in.' });
    const order = ordersStore.get(orderId);
    if (!order || order.userId !== u.id) return sendJson(res, 404, { error: 'No such order.' });
    // Lazy expiry: a waiting order past its window is reported expired.
    let status = order.status;
    if (status === 'waiting' && order.expiresAt && now() > order.expiresAt) {
      status = 'expired';
      await ordersStore.update(orderId, { status });
    }
    const fresh = store.getById(u.id) || u;
    return sendJson(res, 200, {
      status, coin: order.coin, amount: order.amount, address: order.address, expiresAt: order.expiresAt,
      membership: membershipSummary(fresh),
      ownsProduct: order.kind === 'product' ? ownsProduct(fresh, order.productId) : undefined,
    });
  }

  async function config(req, res) {
    const plans = cryptoConfig.membership && cryptoConfig.membership.plans ? cryptoConfig.membership.plans : {};
    sendJson(res, 200, {
      enabled: cryptoConfig.enabledCoins.length > 0,
      coins: cryptoConfig.enabledCoins,
      membershipPlans: Object.keys(plans).map((key) => ({ key, ...plans[key] })),
      productDiscountPercent: cryptoConfig.productDiscountPercent || 0,
    });
  }

  async function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/pay/crypto/config') { await config(req, res); return true; }
    if (req.method === 'POST' && url.pathname === '/api/pay/crypto/webhook') { await webhook(req, res); return true; }
    if (req.method === 'POST' && url.pathname === '/api/pay/crypto/checkout') { await checkout(req, res); return true; }
    const m = url.pathname.match(/^\/api\/pay\/crypto\/order\/([A-Za-z0-9_]+)$/);
    if (req.method === 'GET' && m) { await orderStatus(req, res, m[1]); return true; }
    return false;
  }

  return { handle, enabledCoins: cryptoConfig.enabledCoins, _test: { webhook, checkout, orderStatus, config, grantProduct, grantMembership } };
}
