// Admin-managed coupon (discount code) registry + redemption ledger. The local
// store is the SOURCE OF TRUTH for management/validation/tracking; the actual
// discount math is done by Stripe (a derived Stripe coupon is attached to the
// Checkout Session — see lib/stripe-payments.js ensureStripeCoupon). Small,
// low-frequency lists → synchronous read/write, same shape as lib/categories.js.
//
// A coupon is percentage-off only (owner's choice). Limits: a global redemption
// cap, one-per-customer, and an expiry date. Codes apply to any purchase
// (membership or product) — no per-product scoping.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolved per call so tests can point them at tmp files.
const couponsPath = () => process.env.COUPONS_FILE || path.join(__dirname, '..', 'data', 'coupons.json');
const redemptionsPath = () => process.env.COUPON_REDEMPTIONS_FILE || path.join(__dirname, '..', 'data', 'coupon-redemptions.json');

const DURATIONS = ['once', 'forever', 'repeating'];

/** Normalize a user-entered code: uppercase, trim, allow [A-Z0-9_-], 3–40 chars. */
export function normalizeCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return /^[A-Z0-9_-]{3,40}$/.test(c) ? c : '';
}

// --- low-level read/write (atomic write via temp + rename) ---
function readArr(file) {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(arr)) return arr;
  } catch { /* missing/corrupt */ }
  return [];
}
function writeArr(file, arr) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, file);
}

const readCoupons = () => readArr(couponsPath());
const writeCoupons = (arr) => writeArr(couponsPath(), arr);
const readRedemptions = () => readArr(redemptionsPath());
const writeRedemptions = (arr) => writeArr(redemptionsPath(), arr);

// Signature of the fields baked into the (immutable) Stripe coupon. When these
// change we must recreate the Stripe coupon, so updates clear stripeSig/Id.
function discountSig(c) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([c.percentOff, c.duration, c.durationInMonths || 0, c.maxRedemptions || 0, c.expiresAt || 0]))
    .digest('hex')
    .slice(0, 16);
}

// Coerce/validate the editable fields shared by create + update. Returns
// { ok, fields } or { ok:false, error }. `partial` allows update to omit keys.
function cleanFields(input, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (!partial || has('percentOff')) {
    const p = Math.round(Number(input.percentOff));
    if (!Number.isInteger(p) || p < 1 || p > 100) return { ok: false, error: 'Percent off must be 1–100.' };
    out.percentOff = p;
  }
  if (!partial || has('duration')) {
    const d = DURATIONS.includes(input.duration) ? input.duration : 'once';
    out.duration = d;
    if (d === 'repeating') {
      const m = Math.round(Number(input.durationInMonths));
      if (!Number.isInteger(m) || m < 1 || m > 36) return { ok: false, error: 'Repeating months must be 1–36.' };
      out.durationInMonths = m;
    } else {
      out.durationInMonths = null;
    }
  }
  if (!partial || has('label')) out.label = String(input.label || '').trim().slice(0, 80);
  if (!partial || has('maxRedemptions')) {
    if (input.maxRedemptions == null || input.maxRedemptions === '') out.maxRedemptions = null;
    else {
      const n = Math.round(Number(input.maxRedemptions));
      if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'Redemption cap must be a positive whole number.' };
      out.maxRedemptions = n;
    }
  }
  if (!partial || has('oncePerCustomer')) out.oncePerCustomer = !!input.oncePerCustomer;
  if (!partial || has('expiresAt')) {
    if (input.expiresAt == null || input.expiresAt === '') out.expiresAt = null;
    else {
      const t = Number(input.expiresAt);
      if (!Number.isFinite(t) || t <= 0) return { ok: false, error: 'Invalid expiry date.' };
      out.expiresAt = t;
    }
  }
  if (!partial || has('active')) out.active = input.active === undefined ? true : !!input.active;
  return { ok: true, fields: out };
}

/** All coupons (raw records). */
export function list() {
  return readCoupons();
}

export function getById(id) {
  return readCoupons().find((c) => c.id === id) || null;
}

export function getByCode(code) {
  const norm = normalizeCode(code);
  if (!norm) return null;
  return readCoupons().find((c) => c.code === norm) || null;
}

/** Create a coupon. Returns { ok, coupon } or { ok:false, error }. */
export function create(input = {}) {
  const code = normalizeCode(input.code);
  if (!code) return { ok: false, error: 'Code must be 3–40 chars: letters, numbers, - or _.' };
  const arr = readCoupons();
  if (arr.some((c) => c.code === code)) return { ok: false, error: 'That code already exists.' };
  const cleaned = cleanFields(input, { partial: false });
  if (!cleaned.ok) return cleaned;
  const now = Date.now();
  const coupon = {
    id: `cpn_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    code,
    ...cleaned.fields,
    timesRedeemed: 0,
    stripeCouponId: null,
    stripeSig: null,
    createdAt: now,
    updatedAt: now,
  };
  arr.push(coupon);
  writeCoupons(arr);
  return { ok: true, coupon };
}

/** Update editable fields. Clears the Stripe coupon link if discount fields change. */
export function update(id, patch = {}) {
  const arr = readCoupons();
  const c = arr.find((x) => x.id === id);
  if (!c) return { ok: false, error: 'Coupon not found.' };
  const cleaned = cleanFields(patch, { partial: true });
  if (!cleaned.ok) return cleaned;
  const before = discountSig(c);
  Object.assign(c, cleaned.fields);
  c.updatedAt = Date.now();
  // If anything baked into the Stripe coupon changed, drop the link so the next
  // checkout recreates it (Stripe coupons are immutable).
  if (discountSig(c) !== before) { c.stripeCouponId = null; c.stripeSig = null; }
  writeCoupons(arr);
  return { ok: true, coupon: c };
}

/** Enable/disable a coupon. */
export function setActive(id, active) {
  return update(id, { active: !!active });
}

/** Persist the derived Stripe coupon id + signature after creating it on Stripe. */
export function setStripeCoupon(id, stripeCouponId) {
  const arr = readCoupons();
  const c = arr.find((x) => x.id === id);
  if (!c) return { ok: false, error: 'Coupon not found.' };
  c.stripeCouponId = stripeCouponId || null;
  c.stripeSig = stripeCouponId ? discountSig(c) : null;
  writeCoupons(arr);
  return { ok: true, coupon: c };
}

/** True if the stored Stripe coupon still matches the current discount fields. */
export function stripeCouponFresh(c) {
  return !!(c && c.stripeCouponId && c.stripeSig && c.stripeSig === discountSig(c));
}

export function remove(id) {
  const arr = readCoupons();
  const next = arr.filter((c) => c.id !== id);
  if (next.length === arr.length) return { ok: false, error: 'Coupon not found.' };
  writeCoupons(next);
  return { ok: true };
}

/**
 * Validate a code for use by `userId`. Checks: exists, active, not expired, under
 * the global cap, and (if oncePerCustomer) not already redeemed by this user.
 * Returns { ok, coupon } or { ok:false, error }.
 */
export function validate(code, { userId } = {}) {
  const c = getByCode(code);
  if (!c) return { ok: false, error: 'That code isn’t valid.' };
  if (!c.active) return { ok: false, error: 'That code is no longer active.' };
  if (typeof c.expiresAt === 'number' && c.expiresAt <= Date.now()) return { ok: false, error: 'That code has expired.' };
  if (typeof c.maxRedemptions === 'number' && (c.timesRedeemed || 0) >= c.maxRedemptions) {
    return { ok: false, error: 'That code has reached its redemption limit.' };
  }
  if (c.oncePerCustomer && userId) {
    const used = readRedemptions().some((r) => r.couponId === c.id && r.userId === userId);
    if (used) return { ok: false, error: 'You’ve already used this code.' };
  }
  return { ok: true, coupon: c };
}

/**
 * Record a redemption (called from the Stripe webhook on a completed checkout).
 * Idempotent on (couponId, userId, sessionId) so a redelivered webhook can't
 * double-count. Increments the coupon's timesRedeemed mirror.
 */
export function recordRedemption(rec = {}) {
  const c = rec.couponId ? getById(rec.couponId) : getByCode(rec.code);
  if (!c) return { ok: false, error: 'Coupon not found.' };
  const redemptions = readRedemptions();
  if (rec.sessionId && redemptions.some((r) => r.couponId === c.id && r.userId === rec.userId && r.sessionId === rec.sessionId)) {
    return { ok: true, duplicate: true };
  }
  redemptions.push({
    couponId: c.id,
    code: c.code,
    userId: rec.userId || null,
    ts: rec.ts || Date.now(),
    kind: rec.kind === 'product' ? 'product' : 'membership',
    productId: rec.productId || null,
    amountDiscount: typeof rec.amountDiscount === 'number' ? rec.amountDiscount : null,
    currency: rec.currency || null,
    sessionId: rec.sessionId || null,
  });
  writeRedemptions(redemptions);
  // Bump the running count mirror on the coupon record.
  const arr = readCoupons();
  const live = arr.find((x) => x.id === c.id);
  if (live) { live.timesRedeemed = (live.timesRedeemed || 0) + 1; writeCoupons(arr); }
  return { ok: true };
}

/** All redemptions for a coupon, newest first. */
export function listRedemptions(id) {
  return readRedemptions().filter((r) => r.couponId === id).sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

/** Aggregate stats for a coupon: total redemptions, unique users, total discount. */
export function usageStats(id) {
  const rows = readRedemptions().filter((r) => r.couponId === id);
  const users = new Set(rows.map((r) => r.userId).filter(Boolean));
  const totalDiscount = rows.reduce((s, r) => s + (typeof r.amountDiscount === 'number' ? r.amountDiscount : 0), 0);
  return { timesRedeemed: rows.length, uniqueUsers: users.size, totalDiscount };
}

/** Coupon list with usage stats merged in — for the admin list view. */
export function listWithStats() {
  return readCoupons().map((c) => ({ ...c, stats: usageStats(c.id) }));
}
