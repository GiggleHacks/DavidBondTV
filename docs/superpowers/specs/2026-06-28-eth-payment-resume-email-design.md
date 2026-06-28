# ETH payment UX: reassurance, resume, and detection email

**Date:** 2026-06-28
**Status:** Approved (design)

## Problem

The ETH (crypto) checkout shows a bare "Awaiting payment… / Expires in 19:46"
panel. Three gaps hurt the buyer experience:

1. **No reassurance / time expectation.** Buyers don't know an on-chain payment
   takes minutes, so the wait feels broken.
2. **No way to resume.** The `orderId` lives only in the open tab. Close it and
   the live progress (and the address/amount) is lost, even though the order is
   still valid server-side.
3. **No email.** Only the final "access granted" email fires; nothing tells the
   buyer their payment was seen while it confirms.

Applies to **both** crypto rails: membership and product orders (they share
`public/js/crypto-checkout.js`). ETH is the only enabled coin today.

## What already exists (reused, not rebuilt)

- Orders persist server-side (`data/crypto-orders.json`) with `userId` and the
  lifecycle `waiting → detected → confirmed → granted` (+ `underpaid`, `expired`).
- The watcher already posts a `detected` callback (first-block / mempool) →
  `lib/crypto-payments.js` sets the order to `detected`.
- `GET /api/pay/crypto/order/:id` is auth-gated by `userId` and returns
  `{status, coin, amount, address, expiresAt}` — enough to re-render a panel.
- `crypto-checkout.js` already renders the invoice and polls, and already has a
  `detected` UI branch.

## Design

### 1. Reassuring, time-aware messaging — `public/js/crypto-checkout.js` (copy)

- **Waiting:** keep the "Awaiting payment…" header; enrich the status line with:
  "After you send, your transaction usually confirms within a few minutes (up to
  ~10 when the network is busy). You can safely close this page — we'll email you
  when it lands, and you can return anytime." Add light progressive reassurance
  the longer it sits in `waiting`.
- **Detected:** header → "Payment detected ✓"; body → "Seen on-chain — waiting
  for confirmation, usually a couple minutes. We've emailed you a link to track
  it." (Copy sets first-block expectation, not instant mempool — see Caveat.)

### 2. Resume an in-progress payment — server + client

- **Store:** add `findActiveByUser(userId)` to `lib/crypto-orders-store.js` —
  returns the most recent order for the user whose status ∈ {waiting, detected,
  confirmed} and `now <= expiresAt`, else null.
- **Endpoint:** `GET /api/pay/crypto/order/open` (auth-gated) → that order as
  `{orderId, coin, amount, address, expiresAt, status, kind, productSlug?}`, or
  `{order: null}` if none. Registered in `crypto-payments.js` `handle()`.
- **Client refactor:** in `crypto-checkout.js`, split the existing
  `startCryptoCheckout` so the "render invoice panel + poll loop" is a private
  `renderInvoice(order, mount, onExpire)` reused by:
  - fresh checkout (POST `/checkout`, then `renderInvoice`), and
  - **resume** (`resumeCryptoCheckout(order, mount)`), which rebuilds `qrPayload`
    from `coin`+`address`+`amount` (`ethereum:<addr>?value=<amt>`).
- **Entry points:**
  - `public/js/membership.js`: on load, if `?order=<id>` is present, fetch that
    order; else call `/api/pay/crypto/order/open`. If an active order exists,
    render the resume panel (into the existing ETH mount) instead of the plan
    picker. A `?order=<id>` that's already granted just shows the member state.
  - `public/js/course.js`: same, for product orders.

### 3. Email on detection — server + `lib/mailer.js`

- New `sendCryptoPaymentDetectedEmail(email, { coin, amount, resumeUrl })` in
  `lib/mailer.js` (same style/transport as the existing granted emails).
- In `crypto-payments.js` webhook `detected` branch: when an order first flips to
  `detected`, look up the buyer (`store.getById(order.userId)`) and send the
  email once. Guard with an order flag `detectedEmailedAt` so repeat `detected`
  callbacks don't re-send. Best-effort (never blocks the webhook).
- `resumeUrl` = `${baseUrl}/membership.html?order=<id>` for membership, or
  `${baseUrl}/course.html?slug=<slug>&order=<id>` for products.
- The existing "access granted" email on grant is unchanged.

## Data flow

Unchanged core (checkout → watcher → webhook → grant). Adds: (a) a read path
`order/open` for resume; (b) one best-effort email on first `detected`.

## Testing (`tests/crypto-payments.test.js`, `tests/crypto-orders-store.test.js`)

- `findActiveByUser`: returns active order; ignores granted/expired/other users;
  picks the most recent when several.
- `GET /api/pay/crypto/order/open`: 401 unauth; `{order:null}` when none; returns
  the active order for the owner only.
- Webhook `detected`: sends the detected email exactly once across repeated
  `detected` callbacks; sets `detectedEmailedAt`; never throws if the mailer is
  unconfigured.

## Caveat

Instant *mempool* detection needs an RPC that exposes pending txs; publicnode may
not, so `detected` typically appears when the tx lands in the first block
(~15s–2 min), not the instant the user sends. Copy reflects this. A mempool-capable
RPC can be swapped in later for true instant detection (no code change beyond env).

## Out of scope

- On-order-creation email (decided: email only on detection).
- SMS / push. Telegram owner alerts are unchanged.
- New coins (ETH only today).
