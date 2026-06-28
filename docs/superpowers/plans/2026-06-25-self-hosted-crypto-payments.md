# Self-Hosted Crypto Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept ETH + Litecoin (Phase 1) and Monero (Phase 2) on davidbondtv.com for one-time products *and* fixed-term membership, with no third-party processor, no fees, and no KYC.

**Architecture:** A small **watcher service** on the Unraid box (`cccbox`, behind the existing Cloudflare Tunnel) is the only component that touches chains/wallets. The main app creates an order, shows the buyer a static receiving address + a **unique amount** + QR, and registers a "watch" with the watcher. The watcher polls each chain via a per-coin adapter (litecoind watch-only RPC for LTC, public JSON-RPC for ETH, monero-wallet-rpc for XMR), detects the matching received-amount delta at N confirmations, and POSTs an **HMAC-signed callback** to the main app's `/api/pay/crypto/webhook`. The main app verifies the signature, de-dupes per order, and grants the product/membership through the **existing** entitlement + email + Telegram pipeline. No private keys ever live on a server (ETH/LTC use public addresses; XMR uses a view-only wallet).

**Tech Stack:** Node 22 ESM (no framework), vitest, `node:crypto` HMAC, CoinGecko free price API, Docker on Unraid, Cloudflare Tunnel.

**Key reuse (do not reinvent):**
- `verifyStripeSignature(rawBody, sigHeader, secret)` — `lib/stripe-payments.js:46` — generic `t=,v1=` HMAC verifier; reuse verbatim for the crypto callback.
- `store.addProductEntitlement(uid, entry)` — `lib/users-store.js:313` — atomic, deduped by `productId` (gives one-time idempotency for crypto too).
- `membershipSummary` / `hasActiveMembership` — `lib/membership.js` — provider-agnostic; `/api/auth/me` already surfaces them via `selfUser` (`lib/users-store.js:70`), so **no `/api/auth/me` change is needed**.
- `sendJson`, `readBody`, `readRawBody` — `lib/http-util.js`. `createRateLimiter(windowMs, max)` — `lib/rate-limit.js`.
- `coupons.validate(code, { userId })` / `coupons.recordRedemption(rec)` — `lib/coupons.js:228`.
- `pricing.getConfig()` — `lib/pricing.js:84` — membership cents for month/year.
- `telegramNotifier.notify(type, payload)` — `lib/telegram-bot.js`.
- Mailer: `sendProductGrantedEmail`, `sendMembershipGrantedEmail`, `mailerConfigured` — `lib/mailer.js`.

**Conventions to match:** stores are factory functions returning method objects with a write-chain `persist()` + `flush()` (see `lib/payments-store.js`); modules expose a `handle(req,res,url)` returning `true` when handled and a `_test` export for unit tests; logs are prefixed (`[crypto]`). Data files live under `data/` (already gitignored).

---

## File Structure

**New — main app**
- `lib/crypto-orders-store.js` — atomic order ledger + per-order callback idempotency (mirrors `payments-store.js`).
- `lib/crypto-config.js` — load/validate `data/crypto-config.json` (addresses, enabled coins, confirmations, TTLs, jitter, watcher URL/token).
- `lib/crypto-payments.js` — `createCryptoPayments({...})`: `checkout`, `webhook`, `orderStatus`, `applyCryptoMembership`, `handle`, `_test`.
- `public/js/crypto-checkout.js` — coin picker + address/amount/QR panel + status polling.
- `public/vendor/qrcode.min.js` — tiny local QR generator (no CDN).
- `tests/crypto-orders-store.test.js`, `tests/crypto-payments.test.js`, additions to `tests/membership.test.js`.

**New — watcher service (deployed to cccbox)**
- `services/crypto-watcher/package.json`
- `services/crypto-watcher/index.mjs` — HTTP server: `GET /quote`, `POST /watch`, `GET /health`.
- `services/crypto-watcher/lib/matcher.mjs` — generic received-amount matcher (pure, unit-tested).
- `services/crypto-watcher/lib/adapters.mjs` — per-coin `getReceived(address, minconf)` adapters (LTC, ETH; XMR in Phase 2).
- `services/crypto-watcher/lib/callback.mjs` — signed callback sender with backoff.
- `services/crypto-watcher/Dockerfile`
- `services/crypto-watcher/tests/matcher.test.js`

**Modified**
- `lib/membership.js` — add `cryptoActive`, OR into `hasActiveMembership`.
- `server.mjs` — construct `createCryptoPayments({...})`; dispatch `cryptoPayments.handle` right after the Stripe block (~line 2320).
- `.env.example` — `CRYPTO_WEBHOOK_SECRET`, `CRYPTO_WATCHER_URL`, `CRYPTO_WATCHER_TOKEN`.
- `data/crypto-orders.json` — superset schema (the existing placeholder stays compatible).

---

## Shared contract (reference for all tasks)

**Order record** (`data/crypto-orders.json`):
```jsonc
{
  "orders": {
    "<orderId>": {
      "id": "<orderId>", "userId": "<uuid>",
      "kind": "product" | "membership",
      "productId": "prod_…",            // kind=product
      "termMonths": 3,                  // kind=membership (fixed prepaid block)
      "expectedFiat": 47, "currency": "usd",
      "coin": "ETH"|"LTC"|"XMR",
      "address": "0x…/ltc1…/8…",
      "amount": "0.0834217",            // unique locked amount (string, exact)
      "confirmations": 6,
      "rateLockedAt": 0, "expiresAt": 0,
      "status": "waiting"|"underpaid"|"confirmed"|"granted"|"expired",
      "txid": null, "received": null, "createdAt": 0,
      "confirmedAt": null, "grantedAt": null, "alerted": false, "lastPolledAt": 0
    }
  },
  "processedCallbacks": { "<orderId>": 0 }
}
```

**HTTP endpoints**
- Frontend → main app: `POST /api/pay/crypto/checkout` `{ kind, productId?, coin, couponCode?, next? }` → `{ orderId, coin, address, amount, qrPayload, expiresAt }`. Membership is a single fixed 3-month block (no term param); products get a flat crypto discount.

**Crypto pricing (decided):**
- **Membership:** a single prepaid **3-month** block for **$47** (no auto-renew). Buying again **stacks** another 3 months onto the current expiry.
- **Products:** flat **10% off** the catalog price when paying in crypto (e.g. $299 → $269.10).
- Both live in `data/crypto-config.json`: `membership.termMonths`, `membership.priceUsd`, `productDiscountPercent`.
- Frontend → main app: `GET /api/pay/crypto/order/:id` → `{ status, coin, amount, address, expiresAt, membership? , ownsProduct? }`.
- Watcher → main app: `POST /api/pay/crypto/webhook` body `{ orderId, coin, txid, amount, confirmations }`, header `x-crypto-signature: t=<unix>,v1=<hmac>` over `${t}.${rawBody}` with `CRYPTO_WEBHOOK_SECRET`.
- Main app → watcher: `POST /watch` (bearer `CRYPTO_WATCHER_TOKEN`) `{ orderId, coin, address, expectedAmount, confirmations, expiresAt, callbackUrl }`.
- Main app → watcher: `GET /quote?coin=eth&usd=299` (bearer) → `{ coin, usd, amount, rate, ts }`.

**Coin precision** (decimals used for display + jitter): `{ ETH: 6, LTC: 8, XMR: 12 }`. Amounts are handled as **strings** end-to-end to avoid float drift; the matcher compares using integer base units.

---

# PHASE 1 — ETH + LTC, end to end

## Task 1: Crypto orders store

**Files:**
- Create: `lib/crypto-orders-store.js`
- Test: `tests/crypto-orders-store.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/crypto-orders-store.test.js
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCryptoOrdersStore } from '../lib/crypto-orders-store.js';

function tmpFile() {
  return path.join(os.tmpdir(), `crypto-orders-${crypto.randomUUID()}.json`);
}

describe('crypto-orders-store', () => {
  it('creates, reads, and updates an order', async () => {
    const s = createCryptoOrdersStore(tmpFile());
    const o = await s.create({ id: 'o1', userId: 'u1', kind: 'product', productId: 'p1', coin: 'ETH', amount: '0.05', status: 'waiting' });
    expect(o.id).toBe('o1');
    expect(s.get('o1').status).toBe('waiting');
    await s.update('o1', { status: 'confirmed', txid: '0xabc' });
    expect(s.get('o1').status).toBe('confirmed');
    expect(s.get('o1').txid).toBe('0xabc');
    await s.flush();
  });

  it('de-dupes callbacks by orderId', async () => {
    const s = createCryptoOrdersStore(tmpFile());
    expect(s.isCallbackProcessed('o1')).toBe(false);
    await s.markCallback('o1');
    expect(s.isCallbackProcessed('o1')).toBe(true);
    await s.flush();
  });

  it('lists open (waiting) orders for sweeping', async () => {
    const s = createCryptoOrdersStore(tmpFile());
    await s.create({ id: 'a', status: 'waiting', expiresAt: 1 });
    await s.create({ id: 'b', status: 'granted', expiresAt: 1 });
    expect(s.listOpen().map((o) => o.id)).toEqual(['a']);
    await s.flush();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/crypto-orders-store.test.js`
Expected: FAIL — `createCryptoOrdersStore` is not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

```javascript
// lib/crypto-orders-store.js
// Crypto order ledger, backed by data/crypto-orders.json. Same persistence shape
// as lib/payments-store.js: in-memory object, writes serialized through a promise
// chain so concurrent callbacks can't corrupt the whole-file rewrite. Holds the
// per-order callback idempotency set (mirrors processedStripeEvents).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function createCryptoOrdersStore(filePath) {
  let data = { orders: {}, processedCallbacks: {} };
  let writeChain = Promise.resolve();

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = {
          orders: parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {},
          processedCallbacks: parsed.processedCallbacks && typeof parsed.processedCallbacks === 'object'
            ? parsed.processedCallbacks : {},
        };
      }
    } catch { /* missing/corrupt → defaults */ }
  }
  load();

  function persist() {
    writeChain = writeChain
      .then(async () => {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
      })
      .catch(() => {});
    return writeChain;
  }

  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

  return {
    async create(order) {
      data.orders[order.id] = { ...order };
      await persist();
      return clone(data.orders[order.id]);
    },
    get(id) { return clone(data.orders[id]); },
    async update(id, patch) {
      const o = data.orders[id];
      if (!o) return null;
      Object.assign(o, patch, { updatedAt: patch.updatedAt ?? o.updatedAt });
      await persist();
      return clone(o);
    },
    listOpen() {
      return Object.values(data.orders).filter((o) => o.status === 'waiting').map(clone);
    },
    isCallbackProcessed(id) {
      return !!id && Object.prototype.hasOwnProperty.call(data.processedCallbacks, id);
    },
    async markCallback(id, now = Date.now()) {
      if (!id) return;
      data.processedCallbacks[id] = now;
      await persist();
    },
    flush() { return writeChain; },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/crypto-orders-store.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/crypto-orders-store.js tests/crypto-orders-store.test.js
git commit -m "feat(crypto): order ledger store with callback idempotency"
```

---

## Task 2: `cryptoActive` membership gate

**Files:**
- Modify: `lib/membership.js`
- Test: `tests/membership.test.js` (create if absent)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/membership.test.js
import { describe, it, expect } from 'vitest';
import { cryptoActive, hasActiveMembership, membershipSummary } from '../lib/membership.js';

const now = 1_000_000;

describe('cryptoActive', () => {
  it('is active when provider=crypto, status=active, and time remains', () => {
    const u = { membership: { provider: 'crypto', status: 'active', currentPeriodEnd: now + 1000 } };
    expect(cryptoActive(u, now)).toBe(true);
    expect(hasActiveMembership(u, now)).toBe(true);
  });
  it('is inactive once the paid period has ended', () => {
    const u = { membership: { provider: 'crypto', status: 'active', currentPeriodEnd: now - 1 } };
    expect(cryptoActive(u, now)).toBe(false);
    expect(hasActiveMembership(u, now)).toBe(false);
  });
  it('summary reports the crypto provider', () => {
    const u = { membership: { provider: 'crypto', status: 'active', interval: 'year', currentPeriodEnd: now + 1000, since: now } };
    const s = membershipSummary(u, now);
    expect(s.active).toBe(true);
    expect(s.provider).toBe('crypto');
    expect(s.interval).toBe('year');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/membership.test.js`
Expected: FAIL — `cryptoActive` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `lib/membership.js`, add this function after `adminActive` (after line 34):

```javascript
/**
 * Active crypto-paid membership? Crypto can't auto-renew, so this is a fixed term:
 * status 'active' with time left on currentPeriodEnd. Written by the crypto webhook
 * (lib/crypto-payments.js), read here. Same shape as stripeActive/adminActive.
 */
export function cryptoActive(user, now = Date.now()) {
  const m = user && user.membership;
  if (!m || m.provider !== 'crypto') return false;
  if (m.status !== 'active') return false;
  return typeof m.currentPeriodEnd === 'number' && now < m.currentPeriodEnd;
}
```

Then change `hasActiveMembership` (line 43) from:

```javascript
  return stripeActive(user, now) || adminActive(user, now); // future: || cryptoActive(...)
```

to:

```javascript
  return stripeActive(user, now) || adminActive(user, now) || cryptoActive(user, now);
```

(`membershipSummary` already reads `m.provider`/`m.interval` generically — no change needed there.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/membership.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/membership.js tests/membership.test.js
git commit -m "feat(crypto): cryptoActive membership gate"
```

---

## Task 3: Crypto config loader

**Files:**
- Create: `lib/crypto-config.js`
- Create (sample, gitignored): `data/crypto-config.json`
- Test: `tests/crypto-config.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/crypto-config.test.js
import { describe, it, expect } from 'vitest';
import { normalizeCryptoConfig } from '../lib/crypto-config.js';

describe('normalizeCryptoConfig', () => {
  it('fills defaults and keeps only coins that have an address', () => {
    const c = normalizeCryptoConfig({
      coins: { ETH: { address: '0xabc' }, LTC: { address: '' }, XMR: { address: '8x' } },
    });
    expect(c.enabledCoins).toEqual(['ETH', 'XMR']); // LTC dropped: no address
    expect(c.coins.ETH.confirmations).toBe(6);      // default
    expect(c.coins.ETH.decimals).toBe(6);
    expect(c.orderTtlMs).toBe(20 * 60 * 1000);
    expect(c.membership).toEqual({ termMonths: 3, priceUsd: 47 });
    expect(c.productDiscountPercent).toBe(0);
  });
  it('disables everything when given nothing', () => {
    const c = normalizeCryptoConfig(null);
    expect(c.enabledCoins).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/crypto-config.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```javascript
// lib/crypto-config.js
// Static receiving addresses + tunables for crypto checkout. Backed by the
// gitignored data/crypto-config.json so addresses/keys never enter the repo.
import fs from 'node:fs';

const DEFAULTS = {
  ETH: { decimals: 6, confirmations: 6 },
  LTC: { decimals: 8, confirmations: 6 },
  XMR: { decimals: 12, confirmations: 10 },
};

export function normalizeCryptoConfig(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const coinsIn = src.coins && typeof src.coins === 'object' ? src.coins : {};
  const coins = {};
  for (const sym of Object.keys(DEFAULTS)) {
    const c = coinsIn[sym] || {};
    coins[sym] = {
      address: typeof c.address === 'string' ? c.address.trim() : '',
      decimals: Number.isInteger(c.decimals) ? c.decimals : DEFAULTS[sym].decimals,
      confirmations: Number.isInteger(c.confirmations) ? c.confirmations : DEFAULTS[sym].confirmations,
      enabled: c.enabled !== false,
    };
  }
  const enabledCoins = Object.keys(coins).filter((s) => coins[s].address && coins[s].enabled);
  const mem = src.membership && typeof src.membership === 'object' ? src.membership : {};
  return {
    coins,
    enabledCoins,
    // Crypto membership: a single prepaid block (no auto-renew). Re-buying stacks.
    membership: {
      termMonths: Number.isInteger(mem.termMonths) ? mem.termMonths : 3,
      priceUsd: typeof mem.priceUsd === 'number' ? mem.priceUsd : 47,
    },
    // Flat % off a product's catalog price when paying in crypto (0 = no discount).
    productDiscountPercent: typeof src.productDiscountPercent === 'number' ? src.productDiscountPercent : 0,
    orderTtlMs: Number.isInteger(src.orderTtlMs) ? src.orderTtlMs : 20 * 60 * 1000,
    quoteTtlMs: Number.isInteger(src.quoteTtlMs) ? src.quoteTtlMs : 60 * 1000,
    // jitter base units added to the displayed amount to keep concurrent same-coin
    // orders unique (in last-decimal units, e.g. 0..200 → up to 200 * 10^-decimals).
    jitterMax: Number.isInteger(src.jitterMax) ? src.jitterMax : 200,
  };
}

export function loadCryptoConfig(filePath) {
  try { return normalizeCryptoConfig(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
  catch { return normalizeCryptoConfig(null); }
}
```

Also create the sample `data/crypto-config.json` (real addresses filled in by David before launch):

```json
{
  "coins": {
    "ETH": { "address": "0xYOUR_ETH_ADDRESS", "confirmations": 6, "decimals": 6 },
    "LTC": { "address": "ltc1YOUR_LTC_ADDRESS", "confirmations": 6, "decimals": 8 },
    "XMR": { "address": "", "enabled": false, "confirmations": 10, "decimals": 12 }
  },
  "membership": { "termMonths": 3, "priceUsd": 47 },
  "productDiscountPercent": 10,
  "orderTtlMs": 1200000,
  "quoteTtlMs": 60000,
  "jitterMax": 200
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/crypto-config.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/crypto-config.js tests/crypto-config.test.js data/crypto-config.json
git commit -m "feat(crypto): config loader for addresses + tunables"
```
(Note: `data/` is gitignored — `git add -f data/crypto-config.json` only if you want the *sample* tracked; otherwise leave it untracked and document it in `.env.example`. Recommended: keep it untracked.)

---

## Task 4: Amount math helper (quote → unique amount)

**Files:**
- Create: `lib/crypto-amount.js`
- Test: `tests/crypto-amount.test.js`

This is pure and the riskiest correctness surface (float drift), so it is isolated and fully tested.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/crypto-amount.test.js
import { describe, it, expect } from 'vitest';
import { toBaseUnits, fromBaseUnits, uniqueAmount } from '../lib/crypto-amount.js';

describe('crypto-amount', () => {
  it('round-trips a decimal string through base units without float drift', () => {
    expect(toBaseUnits('0.10', 8)).toBe(10000000n);
    expect(fromBaseUnits(10000000n, 8)).toBe('0.1');
    expect(fromBaseUnits(123450000n, 8)).toBe('1.2345');
  });
  it('computes a base amount from usd + rate at the coin precision', () => {
    // $299 at $2000/coin → 0.1495 coin, 6 decimals
    const r = uniqueAmount({ usd: 299, rate: 2000, decimals: 6, jitter: 0 });
    expect(r.amount).toBe('0.1495');
    expect(r.baseUnits).toBe(149500n);
  });
  it('adds jitter in last-decimal units for uniqueness', () => {
    const r = uniqueAmount({ usd: 299, rate: 2000, decimals: 6, jitter: 7 });
    expect(r.baseUnits).toBe(149507n);
    expect(r.amount).toBe('0.149507');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/crypto-amount.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```javascript
// lib/crypto-amount.js
// Exact decimal<->base-unit conversion using BigInt (never floats) so the amount
// shown to the buyer and the amount matched on-chain agree to the last digit.

export function toBaseUnits(decimalStr, decimals) {
  const [whole, frac = ''] = String(decimalStr).split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt((whole || '0') + fracPadded);
}

export function fromBaseUnits(units, decimals) {
  const s = units.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Convert a fiat amount to a unique coin amount.
 *  - base = ceil(usd / rate) at `decimals` precision (round UP so we never undercharge)
 *  - jitter adds 0..jitterMax base units so two open orders never collide
 * Returns { amount: string, baseUnits: bigint }.
 */
export function uniqueAmount({ usd, rate, decimals, jitter = 0 }) {
  if (!(rate > 0)) throw new Error('rate must be > 0');
  const scale = 10 ** decimals;
  const baseUnitsNum = Math.ceil((usd / rate) * scale);
  const baseUnits = BigInt(baseUnitsNum) + BigInt(jitter);
  return { amount: fromBaseUnits(baseUnits, decimals), baseUnits };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/crypto-amount.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/crypto-amount.js tests/crypto-amount.test.js
git commit -m "feat(crypto): BigInt-exact amount + jitter math"
```

---

## Task 5: `createCryptoPayments` — webhook (grant on confirmed payment)

This is the core integration. Build it webhook-first (the grant path) so it reuses the Stripe pipeline, then add checkout.

**Files:**
- Create: `lib/crypto-payments.js`
- Test: `tests/crypto-payments.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/crypto-payments.test.js
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

    // Redelivered callback: no double grant, no double email.
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/crypto-payments.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation (webhook + grant; checkout added in Task 6)**

```javascript
// lib/crypto-payments.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/crypto-payments.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/crypto-payments.js tests/crypto-payments.test.js
git commit -m "feat(crypto): signed webhook that grants product/membership (deduped)"
```

---

## Task 6: `createCryptoPayments` — checkout + order status

**Files:**
- Modify: `lib/crypto-payments.js`
- Modify: `tests/crypto-payments.test.js`

- [ ] **Step 1: Write the failing test (append to the existing describe block)**

```javascript
// append to tests/crypto-payments.test.js
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
      cryptoConfig: { enabledCoins: ['ETH'], coins: { ETH: { address: '0xabc', decimals: 6, confirmations: 6 } }, orderTtlMs: 1200000, jitterMax: 100, membership: { termMonths: 3, priceUsd: 47 }, productDiscountPercent: 10 },
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

  it('reports order status', async () => {
    const { cp, orders } = makeWithWatcher({ id: 'u1', profileComplete: true, products: [] });
    await orders.create({ id: 'o9', userId: 'u1', kind: 'product', productId: 'p1', coin: 'ETH', amount: '0.1', address: '0xabc', status: 'waiting', expiresAt: 9 });
    const res = fakeRes();
    await cp._test.orderStatus({ method: 'GET', headers: {} }, res, 'o9', { id: 'u1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('waiting');
  });
});
```

(Note: the checkout reads the body via `readBody`; in this test `currentUser` is injected directly, so the handler must call `currentUser(req)` — the fake returns the closed-over `user`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/crypto-payments.test.js`
Expected: FAIL — `cp._test.checkout` / `orderStatus` undefined.

- [ ] **Step 3: Write the implementation (add to `lib/crypto-payments.js` before `handle`)**

```javascript
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
      // Membership in crypto is a single prepaid block (default 3 months / $47).
      // Buying again stacks onto the current expiry (see grantMembership).
      termMonths = cryptoConfig.membership.termMonths;
      expectedFiatCents = Math.round(cryptoConfig.membership.priceUsd * 100);
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
```

Then update `handle` to route them:

```javascript
  async function handle(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/pay/crypto/webhook') { await webhook(req, res); return true; }
    if (req.method === 'POST' && url.pathname === '/api/pay/crypto/checkout') { await checkout(req, res); return true; }
    const m = url.pathname.match(/^\/api\/pay\/crypto\/order\/([A-Za-z0-9_]+)$/);
    if (req.method === 'GET' && m) { await orderStatus(req, res, m[1]); return true; }
    return false;
  }

  return { handle, enabledCoins: cryptoConfig.enabledCoins, _test: { webhook, checkout, orderStatus, grantProduct, grantMembership } };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/crypto-payments.test.js`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/crypto-payments.js tests/crypto-payments.test.js
git commit -m "feat(crypto): checkout (quote + unique amount + watch) and order status"
```

---

## Task 7: Wire into `server.mjs`

**Files:**
- Modify: `server.mjs` (construct ~line 232, dispatch ~line 2320)
- Modify: `.env.example`

- [ ] **Step 1: Add imports near the other lib imports (top of `server.mjs`)**

```javascript
import { createCryptoOrdersStore } from './lib/crypto-orders-store.js';
import { createCryptoPayments } from './lib/crypto-payments.js';
import { loadCryptoConfig } from './lib/crypto-config.js';
```

- [ ] **Step 2: Construct the store + module right after the `stripePayments` block (after line 232)**

```javascript
const CRYPTO_ORDERS_FILE = path.join(__dirname, 'data', 'crypto-orders.json');
const CRYPTO_CONFIG_FILE = path.join(__dirname, 'data', 'crypto-config.json');
const cryptoOrdersStore = createCryptoOrdersStore(CRYPTO_ORDERS_FILE);
const cryptoConfig = loadCryptoConfig(CRYPTO_CONFIG_FILE);
const cryptoPayments = createCryptoPayments({
  store: accounts.store,
  currentUser: accounts.currentUser,
  ordersStore: cryptoOrdersStore,
  paymentsStore,
  baseUrl: BASE_URL,
  webhookSecret: process.env.CRYPTO_WEBHOOK_SECRET,
  watcherUrl: process.env.CRYPTO_WATCHER_URL || null,
  watcherToken: process.env.CRYPTO_WATCHER_TOKEN || null,
  cryptoConfig,
  products,
  pricing,
  coupons,
  telegramNotifier,
});
console.log(`[crypto] enabled coins: ${cryptoConfig.enabledCoins.join(', ') || '(none)'}`);
```

- [ ] **Step 3: Dispatch right after the Stripe handler (after line 2320, before telegramAccess)**

```javascript
  // Self-hosted crypto payments (/api/pay/crypto/*). Public webhook (HMAC-signed
  // by the watcher) shares the pre-accounts slot like the Stripe webhook.
  if (await cryptoPayments.handle(req, res, url)) return true;
```

- [ ] **Step 4: Add env vars to `.env.example`**

```bash
# --- Self-hosted crypto payments ---
# HMAC secret the cccbox watcher uses to sign payment-confirmed callbacks. Generate: openssl rand -hex 32
CRYPTO_WEBHOOK_SECRET=
# Base URL of the watcher service on cccbox (via Cloudflare Tunnel), e.g. https://crypto.davidbondtv.com
CRYPTO_WATCHER_URL=
# Bearer token the main app uses to call the watcher's /quote and /watch. Generate: openssl rand -hex 32
CRYPTO_WATCHER_TOKEN=
```

- [ ] **Step 5: Verify the server boots and the route is mounted**

Run: `node --env-file-if-exists=.env -e "import('./server.mjs')"` is not how it boots; instead run the full test suite and a boot smoke check:

Run: `npx vitest run` — Expected: PASS (all suites including the new crypto ones).
Run: `node --check server.mjs` — Expected: no syntax errors.

- [ ] **Step 6: Commit**

```bash
git add server.mjs .env.example
git commit -m "feat(crypto): mount crypto payments routes + config in server"
```

---

## Task 8: Frontend — coin picker, address/QR panel, status polling

**Files:**
- Create: `public/js/crypto-checkout.js`
- Create: `public/vendor/qrcode.min.js` (vendor a tiny MIT QR lib, e.g. `qrcode-generator` minified — no CDN at runtime)
- Modify: `public/course.html` and `public/membership.html` (add a "Pay with crypto" entry point + a mount node)

- [ ] **Step 1: Vendor the QR library**

Download `qrcode-generator` (MIT) minified to `public/vendor/qrcode.min.js`. It exposes a global `qrcode(typeNumber, errorCorrectionLevel)`. (Commit the file as-is; no build step.)

- [ ] **Step 2: Implement the crypto checkout module**

```javascript
// public/js/crypto-checkout.js
// Crypto checkout panel: pick a coin, create an order, show address + exact amount
// + QR + countdown, then poll order status until it flips to "granted". Mirrors the
// poll-after-return UX of course-buy.js / membership.js.
import { fetchMe, postJSON } from '/js/account.js';

const COIN_LABELS = { ETH: 'Ethereum', LTC: 'Litecoin', XMR: 'Monero' };

function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function renderQR(container, payload) {
  container.innerHTML = '';
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(payload);
    qr.make();
    container.innerHTML = qr.createImgTag(5, 8);
  } catch { container.textContent = payload; }
}

/**
 * Open a crypto order. `opts` = { kind:'product'|'membership', productId?, coin, couponCode? }.
 * `mount` is the element to render into. Returns when granted or expired.
 */
export async function startCryptoCheckout(opts, mount) {
  const r = await postJSON('/api/pay/crypto/checkout', opts);
  if (r.status === 401) { location.href = `/signup.html?next=${encodeURIComponent(location.pathname)}`; return; }
  if (r.status === 403) { location.href = '/profile-setup.html'; return; }
  if (!r.ok || !r.data || !r.data.orderId) {
    mount.innerHTML = `<p class="crypto-err">${(r.data && r.data.error) || 'Could not start a crypto order.'}</p>`;
    return;
  }
  const { orderId, coin, address, amount, qrPayload, expiresAt } = r.data;
  mount.innerHTML = `
    <div class="crypto-pay">
      <p>Send exactly <strong class="crypto-amt">${amount} ${coin}</strong> (${COIN_LABELS[coin] || coin}) to:</p>
      <code class="crypto-addr">${address}</code>
      <div class="crypto-qr"></div>
      <p class="crypto-status">Waiting for payment… <span class="crypto-clock"></span></p>
      <p class="crypto-hint">Send the <em>exact</em> amount from your own wallet. This page updates automatically.</p>
    </div>`;
  renderQR(mount.querySelector('.crypto-qr'), qrPayload);
  const clock = mount.querySelector('.crypto-clock');
  const statusEl = mount.querySelector('.crypto-status');

  const tick = setInterval(() => { clock.textContent = fmtCountdown(expiresAt - Date.now()); }, 1000);

  // Poll status every 5s until granted/expired.
  while (true) {
    await new Promise((res) => setTimeout(res, 5000));
    let s;
    try { s = await (await fetch(`/api/pay/crypto/order/${encodeURIComponent(orderId)}`)).json(); }
    catch { continue; }
    if (s.status === 'granted') {
      clearInterval(tick);
      statusEl.innerHTML = '✅ Payment received — unlocking your access…';
      await fetchMe();
      setTimeout(() => location.reload(), 1200);
      return;
    }
    if (s.status === 'underpaid') { statusEl.textContent = '⚠️ Amount didn’t match — we’ve been alerted and will sort it out.'; }
    if (s.status === 'expired' || Date.now() > expiresAt) {
      clearInterval(tick);
      statusEl.innerHTML = '⏳ This order expired. <button class="crypto-retry">Start over</button>';
      return;
    }
  }
}

/** Build a simple coin <select> from the server's enabled coins. */
export async function cryptoCoinOptions() {
  try {
    const cfg = await (await fetch('/api/pay/crypto/config')).json();
    return Array.isArray(cfg.coins) ? cfg.coins : [];
  } catch { return []; }
}
```

- [ ] **Step 3: Add a public config endpoint so the UI knows which coins are live**

In `lib/crypto-payments.js`, add a `config` handler and route it (mirrors Stripe's `/api/pay/stripe/config`):

```javascript
  async function config(req, res) {
    sendJson(res, 200, { enabled: cryptoConfig.enabledCoins.length > 0, coins: cryptoConfig.enabledCoins });
  }
```
And in `handle`, before the POST checks:
```javascript
    if (req.method === 'GET' && url.pathname === '/api/pay/crypto/config') { await config(req, res); return true; }
```

- [ ] **Step 4: Add the entry point to the product + membership pages**

In `public/course.html`, near the existing buy button, add:
```html
<button id="buy-crypto" class="btn-secondary" type="button">Pay with crypto</button>
<div id="crypto-mount"></div>
```
In `public/js/course.js` (where the Stripe buy button is wired), add:
```javascript
import { startCryptoCheckout } from '/js/crypto-checkout.js';
const cryptoBtn = document.getElementById('buy-crypto');
if (cryptoBtn) cryptoBtn.addEventListener('click', () => {
  // coin chosen via a prompt/select; minimal first pass uses the first enabled coin
  startCryptoCheckout({ kind: 'product', productId: PRODUCT.id, coin: document.getElementById('crypto-coin')?.value || 'ETH' },
    document.getElementById('crypto-mount'));
});
```
Add the vendored QR script to both pages' `<head>` or before the module script:
```html
<script src="/vendor/qrcode.min.js"></script>
```
Mirror the same wiring in `public/membership.html` / `public/js/membership.js` with `{ kind: 'membership', coin }` — crypto membership is a single 3-month block, so surface it as one button (e.g. “3 months in crypto — $47”), not a month/year toggle.

- [ ] **Step 5: Verify in the browser (see Verification section).** Commit:

```bash
git add public/js/crypto-checkout.js public/vendor/qrcode.min.js public/course.html public/membership.html public/js/course.js public/js/membership.js lib/crypto-payments.js
git commit -m "feat(crypto): checkout UI (coin picker, address/QR panel, status polling)"
```

---

## Task 9: Watcher service — scaffold + generic matcher (unit-tested)

**Files:**
- Create: `services/crypto-watcher/package.json`
- Create: `services/crypto-watcher/lib/matcher.mjs`
- Create: `services/crypto-watcher/tests/matcher.test.js`

- [ ] **Step 1: package.json**

```json
{
  "name": "dbtv-crypto-watcher",
  "private": true,
  "type": "module",
  "scripts": { "start": "node index.mjs", "test": "vitest run" },
  "devDependencies": { "vitest": "^2.1.0" }
}
```

- [ ] **Step 2: Write the failing matcher test**

```javascript
// services/crypto-watcher/tests/matcher.test.js
import { describe, it, expect } from 'vitest';
import { matchReceived } from '../lib/matcher.mjs';

describe('matchReceived', () => {
  const watch = { baselineBaseUnits: 100n, expectedBaseUnits: 50n };
  it('no match until the delta reaches the expected amount', () => {
    expect(matchReceived(watch, 120n)).toEqual({ matched: false, status: 'waiting' });
  });
  it('exact match → confirmed', () => {
    expect(matchReceived(watch, 150n)).toEqual({ matched: true, status: 'confirmed' });
  });
  it('overpayment still confirms', () => {
    expect(matchReceived(watch, 170n)).toEqual({ matched: true, status: 'confirmed' });
  });
  it('a partial delta is reported underpaid (a payment arrived but is short)', () => {
    expect(matchReceived(watch, 130n)).toEqual({ matched: false, status: 'underpaid' });
  });
});
```

- [ ] **Step 3: Implement the matcher**

```javascript
// services/crypto-watcher/lib/matcher.mjs
// Pure decision: given a watch (baseline + expected, in base units) and the
// current total received (base units) at the required confirmations, decide
// whether the order is satisfied. Overpay confirms; a nonzero-but-short delta is
// "underpaid" (surfaced for manual handling); zero delta stays "waiting".
export function matchReceived(watch, currentReceivedBaseUnits) {
  const delta = currentReceivedBaseUnits - watch.baselineBaseUnits;
  if (delta <= 0n) return { matched: false, status: 'waiting' };
  if (delta >= watch.expectedBaseUnits) return { matched: true, status: 'confirmed' };
  return { matched: false, status: 'underpaid' };
}
```

- [ ] **Step 4: Run the test**

Run: `cd services/crypto-watcher && npm install && npx vitest run`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/crypto-watcher/package.json services/crypto-watcher/lib/matcher.mjs services/crypto-watcher/tests/matcher.test.js
git commit -m "feat(watcher): scaffold + pure received-amount matcher"
```

---

## Task 10: Watcher — coin adapters (LTC via litecoind, ETH via JSON-RPC)

**Files:**
- Create: `services/crypto-watcher/lib/adapters.mjs`

Each adapter exposes `getReceived(address, minconf) → bigint` (total received at `minconf` confirmations, in base units) and `getDecimals()`. The matcher consumes the delta, so adapters never need tx parsing.

- [ ] **Step 1: Implement adapters**

```javascript
// services/crypto-watcher/lib/adapters.mjs
// Per-coin "how much has this address received at >= minconf confirmations".
// LTC: litecoind watch-only wallet (importaddress once), getreceivedbyaddress.
// ETH: public JSON-RPC, balance-delta (works with unique-amount matching). For ETH,
// "confirmations" is enforced by reading balance at (latest - confirmations) blocks.

const E = (n) => 10n ** BigInt(n);

async function rpc(url, method, params, auth = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

export function makeLtcAdapter({ rpcUrl, rpcUser, rpcPass }) {
  const decimals = 8;
  const imported = new Set();
  return {
    decimals,
    async ensureWatch(address) {
      if (imported.has(address)) return;
      // rescan=false: we only care about funds arriving AFTER import (our baseline).
      try { await rpc(rpcUrl, 'importaddress', [address, 'dbtv', false], `${rpcUser}:${rpcPass}`); } catch { /* already imported */ }
      imported.add(address);
    },
    async getReceived(address, minconf) {
      await this.ensureWatch(address);
      const ltc = await rpc(rpcUrl, 'getreceivedbyaddress', [address, minconf], `${rpcUser}:${rpcPass}`); // returns a number in LTC
      // Convert the decimal LTC number to base units without float drift.
      const [w, f = ''] = String(ltc).split('.');
      return BigInt(w) * E(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals));
    },
  };
}

export function makeEthAdapter({ rpcUrl }) {
  const decimals = 18; // wei; matcher works in wei, main app quotes to 6 display decimals
  return {
    decimals,
    async _blockNumber() { return BigInt(await rpc(rpcUrl, 'eth_blockNumber', [])); },
    async getReceived(address, minconf) {
      const latest = await this._blockNumber();
      const at = latest > BigInt(minconf) ? latest - BigInt(minconf) : 0n;
      const hex = '0x' + at.toString(16);
      const balWei = BigInt(await rpc(rpcUrl, 'eth_getBalance', [address, hex]));
      return balWei; // base units = wei
    },
  };
}
```

**Note on ETH base units:** the adapter works in wei (18 decimals) but the main app quotes/display at 6 decimals. The watcher converts the order's `expectedAmount` string → wei using 18 decimals when building the watch (see Task 11), so baseline/expected/received are all in wei and the matcher stays exact.

- [ ] **Step 2: Commit** (covered by Task 11's tests via the server)

```bash
git add services/crypto-watcher/lib/adapters.mjs
git commit -m "feat(watcher): LTC (litecoind) + ETH (JSON-RPC) received adapters"
```

---

## Task 11: Watcher — HTTP server, quote, watch loop, signed callback

**Files:**
- Create: `services/crypto-watcher/lib/callback.mjs`
- Create: `services/crypto-watcher/index.mjs`

- [ ] **Step 1: Signed callback sender**

```javascript
// services/crypto-watcher/lib/callback.mjs
import crypto from 'node:crypto';

export function signBody(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

/** POST the callback, retrying with backoff until a 2xx. Returns true on success. */
export async function sendCallback(callbackUrl, payload, secret, { tries = 8 } = {}) {
  const raw = JSON.stringify(payload);
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-crypto-signature': signBody(raw, secret) },
        body: raw,
      });
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, Math.min(60_000, 1000 * 2 ** i)));
  }
  return false;
}
```

- [ ] **Step 2: The server + poll loop**

```javascript
// services/crypto-watcher/index.mjs
// Watches David's static receiving addresses for the exact amounts the main app
// registers, then fires a signed callback. The ONLY component with chain access.
import http from 'node:http';
import { makeLtcAdapter, makeEthAdapter } from './lib/adapters.mjs';
import { matchReceived } from './lib/matcher.mjs';
import { sendCallback } from './lib/callback.mjs';

const PORT = Number(process.env.PORT || 8745);
const TOKEN = process.env.CRYPTO_WATCHER_TOKEN;
const CALLBACK_SECRET = process.env.CRYPTO_WEBHOOK_SECRET;
const POLL_MS = Number(process.env.POLL_MS || 20_000);

const adapters = {};
if (process.env.LTC_RPC_URL) adapters.LTC = makeLtcAdapter({ rpcUrl: process.env.LTC_RPC_URL, rpcUser: process.env.LTC_RPC_USER, rpcPass: process.env.LTC_RPC_PASS });
if (process.env.ETH_RPC_URL) adapters.ETH = makeEthAdapter({ rpcUrl: process.env.ETH_RPC_URL });

const COIN_DISPLAY_DECIMALS = { ETH: 6, LTC: 8, XMR: 12 };

function toBaseUnits(decimalStr, decimals) {
  const [w, f = ''] = String(decimalStr).split('.');
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals));
}

// In-memory watch list (orders are short-lived; main app is the source of truth).
const watches = new Map(); // orderId → { coin, address, expectedBaseUnits, baselineBaseUnits, confirmations, expiresAt, callbackUrl }

async function coinGeckoRate(coin) {
  const id = { ETH: 'ethereum', LTC: 'litecoin', XMR: 'monero' }[coin];
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
  const j = await r.json();
  return j[id].usd;
}

function authed(req) {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

async function readJson(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
    if (!authed(req)) { res.writeHead(401); return res.end('unauthorized'); }

    if (req.method === 'GET' && url.pathname === '/quote') {
      const coin = url.searchParams.get('coin').toUpperCase();
      const usd = Number(url.searchParams.get('usd'));
      const rate = await coinGeckoRate(coin);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ coin, usd, rate, amount: (usd / rate).toFixed(COIN_DISPLAY_DECIMALS[coin]), ts: Date.now() }));
    }

    if (req.method === 'POST' && url.pathname === '/watch') {
      const w = await readJson(req);
      const adapter = adapters[w.coin];
      if (!adapter) { res.writeHead(400); return res.end('coin not supported'); }
      // Baseline = funds already at the address now; we only credit NEW arrivals.
      const baseline = await adapter.getReceived(w.address, w.confirmations);
      watches.set(w.orderId, {
        coin: w.coin, address: w.address,
        expectedBaseUnits: toBaseUnits(w.expectedAmount, adapter.decimals),
        baselineBaseUnits: baseline, confirmations: w.confirmations,
        expiresAt: w.expiresAt, callbackUrl: w.callbackUrl,
      });
      console.log(`[watcher] watching ${w.orderId} ${w.coin} ${w.expectedAmount}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { console.error(`[watcher] ${e.message}`); res.writeHead(500); res.end('error'); }
});

async function pollOnce() {
  const now = Date.now();
  for (const [orderId, w] of [...watches]) {
    if (now > w.expiresAt) { watches.delete(orderId); continue; }
    try {
      const received = await adapters[w.coin].getReceived(w.address, w.confirmations);
      const r = matchReceived(w, received);
      if (r.matched) {
        const display = (Number(w.expectedBaseUnits) / 10 ** adapters[w.coin].decimals);
        const ok = await sendCallback(w.callbackUrl, { orderId, coin: w.coin, txid: null, amount: String(display), confirmations: w.confirmations }, CALLBACK_SECRET);
        if (ok) { watches.delete(orderId); console.log(`[watcher] paid ${orderId}`); }
      }
    } catch (e) { console.error(`[watcher] poll ${orderId}: ${e.message}`); }
  }
}

setInterval(pollOnce, POLL_MS);
server.listen(PORT, () => console.log(`[watcher] listening on ${PORT}, coins: ${Object.keys(adapters).join(', ')}`));
```

- [ ] **Step 3: Smoke-check it parses and serves health**

Run: `cd services/crypto-watcher && node --check index.mjs` — Expected: no syntax error.
Run (manual): `CRYPTO_WATCHER_TOKEN=x CRYPTO_WEBHOOK_SECRET=y node index.mjs &` then `curl localhost:8745/health` → `ok`.

- [ ] **Step 4: Commit**

```bash
git add services/crypto-watcher/lib/callback.mjs services/crypto-watcher/index.mjs
git commit -m "feat(watcher): http server, coingecko quote, poll loop, signed callback"
```

---

## Task 12: Watcher — Dockerfile + Unraid/Cloudflare deployment notes

**Files:**
- Create: `services/crypto-watcher/Dockerfile`
- Create: `services/crypto-watcher/README.md`

- [ ] **Step 1: Dockerfile**

```dockerfile
# services/crypto-watcher/Dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev || true
COPY . .
ENV PORT=8745
EXPOSE 8745
CMD ["node", "index.mjs"]
```

- [ ] **Step 2: README with the exact cccbox setup**

Document, in `services/crypto-watcher/README.md`:
- Build/run on Unraid:
  ```bash
  docker build -t dbtv-crypto-watcher /mnt/user/appdata/dbtv-crypto-watcher
  docker run -d --name dbtv-crypto-watcher --restart unless-stopped \
    -e CRYPTO_WATCHER_TOKEN=<same as main app> \
    -e CRYPTO_WEBHOOK_SECRET=<same as main app> \
    -e ETH_RPC_URL=https://ethereum-rpc.publicnode.com \
    -e LTC_RPC_URL=http://litecoind:9332 -e LTC_RPC_USER=<u> -e LTC_RPC_PASS=<p> \
    -p 8745:8745 dbtv-crypto-watcher
  ```
- Litecoind container (watch-only wallet, txindex not required for `getreceivedbyaddress`): run `nicolasdorier/docker-bitcoin`-style or `uphold/litecoin` image with RPC enabled; create a wallet; the watcher calls `importaddress` automatically.
- Cloudflare Tunnel: in the existing `CloudflaredTunnel` config, add an ingress rule mapping `crypto.davidbondtv.com` → `http://dbtv-crypto-watcher:8745` (or `http://<unraid-ip>:8745`). Set `CRYPTO_WATCHER_URL=https://crypto.davidbondtv.com` on the main app. No inbound ports are opened.
- On the main app (VPS systemd drop-in): set `CRYPTO_WEBHOOK_SECRET`, `CRYPTO_WATCHER_URL`, `CRYPTO_WATCHER_TOKEN`; fill `data/crypto-config.json` with David's real ETH + LTC addresses.

- [ ] **Step 3: Commit**

```bash
git add services/crypto-watcher/Dockerfile services/crypto-watcher/README.md
git commit -m "feat(watcher): dockerfile + cccbox/cloudflare deployment notes"
```

---

# PHASE 2 — Monero (fast-follow)

## Task 13: Monero adapter + view-only wallet

**Files:**
- Modify: `services/crypto-watcher/lib/adapters.mjs`
- Modify: `services/crypto-watcher/index.mjs` (register XMR adapter)
- Modify: `data/crypto-config.json` (enable XMR with the primary address)

- [ ] **Step 1: Add the Monero adapter** (uses `monero-wallet-rpc`, view-only wallet; matches by amount received to the primary address using `get_transfers`):

```javascript
// add to services/crypto-watcher/lib/adapters.mjs
export function makeXmrAdapter({ walletRpcUrl }) {
  const decimals = 12; // atomic units
  async function wrpc(method, params = {}) {
    const r = await fetch(`${walletRpcUrl}/json_rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }
  return {
    decimals,
    async getReceived(address, minconf) {
      // Sum confirmed incoming transfers (view-only wallet sees all inbound).
      const res = await wrpc('get_transfers', { in: true, pending: false, pool: false });
      const height = (await wrpc('get_height')).height;
      let total = 0n;
      for (const t of (res.in || [])) {
        if ((height - t.height) >= minconf) total += BigInt(t.amount);
      }
      return total; // base units = atomic units
    },
  };
}
```

(Phase-2 refinement: for true per-order isolation, create a subaddress per order via `create_address` and filter transfers by `subaddr_index`; the amount-match path above is sufficient to ship.)

- [ ] **Step 2: Register it in `index.mjs`**

```javascript
import { makeLtcAdapter, makeEthAdapter, makeXmrAdapter } from './lib/adapters.mjs';
// ...
if (process.env.XMR_WALLET_RPC_URL) adapters.XMR = makeXmrAdapter({ walletRpcUrl: process.env.XMR_WALLET_RPC_URL });
```

- [ ] **Step 3: Deploy monero-wallet-rpc (view-only) on cccbox** — document in README:
  - Run a `monero-wallet-rpc` container with `--view-only` wallet generated from David's primary address + secret view key (spend key never leaves his wallet), pointed at a remote node (`--daemon-address node.community:18089`) or a local `monerod`.
  - Set `XMR_WALLET_RPC_URL=http://monero-wallet-rpc:18083` on the watcher container.
  - Enable XMR in `data/crypto-config.json` (`"XMR": { "address": "<primary>", "enabled": true }`).

- [ ] **Step 4: Commit**

```bash
git add services/crypto-watcher/lib/adapters.mjs services/crypto-watcher/index.mjs services/crypto-watcher/README.md
git commit -m "feat(watcher): monero view-only adapter (phase 2)"
```

---

## Verification (end to end)

Run after Phase 1, before enabling on real products.

1. **All unit suites pass:**
   Run: `npx vitest run` (main app) and `cd services/crypto-watcher && npx vitest run`.
   Expected: PASS — `crypto-orders-store`, `crypto-amount`, `crypto-config`, `membership` (cryptoActive), `crypto-payments` (webhook + checkout), `matcher`.

2. **Webhook idempotency (already covered by Task 5 test)** — re-confirm: a redelivered callback grants once, emails/Telegram once.

3. **Watcher unit (Task 9)** — the matcher confirms exact + overpay, flags underpay, ignores partial-below.

4. **Local integration (testnet):**
   - Point the watcher at LTC testnet (litecoind `-testnet`) and ETH Sepolia (`ETH_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com`).
   - Set `data/crypto-config.json` to testnet receiving addresses.
   - Create a product order via the UI; send the exact displayed amount from a testnet wallet.
   - Confirm: order status flips `waiting → granted`, the course unlocks (`/api/auth/me` shows the product in `ownedProductIds`), confirmation email lands in `data/outbox/`, Telegram fires.
   - Repeat for a membership term; confirm `membershipSummary().active === true` and `provider === 'crypto'`, and that re-upping extends `currentPeriodEnd`.

5. **Browser checks (preview):** load `course.html`, click "Pay with crypto", verify the address/amount/QR render, the countdown ticks, and polling flips to "unlocking" after payment. Check console for errors and `/api/pay/crypto/*` network calls.

6. **Live smoke:** with real mainnet addresses, run one low-value real order per coin (reuse the `$5` `prod_crypto_test` product) before exposing crypto on `prod_digital_pickup`.

7. **Telegram completion ping:** when the full feature is verified end to end, run `node scripts/notify.mjs "✅ Crypto payments (ETH+LTC) live and verified"`.
