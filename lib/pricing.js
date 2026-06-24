// Admin-managed SUBSCRIPTION pricing, backed by data/pricing.json. The single
// source of truth for what the membership costs — monthly recurring, an optional
// introductory first-period price, and a yearly plan. Course/bundle/digital
// pricing lives per-product in lib/products.js; this module is only the
// recurring-membership side.
//
// All amounts are integer CENTS. The admin panel edits these and the change is
// effective immediately for new checkouts and everywhere prices are displayed
// (Stripe builds prices on the fly from these values via price_data — no
// pre-created Stripe Price objects). NOTE: changing a price never re-bills
// EXISTING subscribers; Stripe holds each subscription at its signup rate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolved per call so tests can point it at a tmp file via PRICING_FILE.
const filePath = () => process.env.PRICING_FILE || path.join(__dirname, '..', 'data', 'pricing.json');

// Defaults are deliberately intro-free (introAmount 0 = no intro) so a fresh
// deploy preserves "just bill the monthly price" until the owner sets an intro.
// On prod the monthly/yearly amounts are backfilled from the existing Stripe
// prices at boot (see server.mjs) so nothing changes silently.
// Customer-facing "unlock" offer screen copy (the membership gate shown on the
// watch page + the browse paywall modal). Editable from /god-pricing so the
// owner can tune the sales pitch and preview it before it goes live. Mirrors the
// historical hardcoded copy so nothing changes until the owner edits it.
const DEFAULT_OFFER = {
  badge: '★ Members only',
  headline: 'Get instant access to the full library',
  body: 'Unlock this video — and the entire David Bond TV exclusive library — the moment you join. New drops first, no ads, cancel anytime.',
  ctaLabel: 'Unlock Now',
};

const DEFAULT = {
  currency: 'usd',
  monthly: { amount: 1700, introAmount: 0, introLabel: 'First month' },
  yearly: { enabled: true, amount: 12000 },
  offer: { ...DEFAULT_OFFER },
  updatedAt: 0,
};

const isCents = (n) => Number.isInteger(n) && n >= 0;

// Trim a free-text offer field to a sane max, falling back to the default copy
// when blank so the live gate never renders an empty headline/button.
const cleanOfferText = (val, fallback, max) => {
  const s = typeof val === 'string' ? val.trim() : '';
  return (s ? s.slice(0, max) : fallback);
};

function normalizeOffer(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  return {
    badge: cleanOfferText(o.badge, DEFAULT_OFFER.badge, 40),
    headline: cleanOfferText(o.headline, DEFAULT_OFFER.headline, 120),
    body: cleanOfferText(o.body, DEFAULT_OFFER.body, 400),
    ctaLabel: cleanOfferText(o.ctaLabel, DEFAULT_OFFER.ctaLabel, 40),
  };
}

/** Normalize a raw record into the stable shape, clamping bad values to defaults. */
function normalize(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const m = (r.monthly && typeof r.monthly === 'object') ? r.monthly : {};
  const y = (r.yearly && typeof r.yearly === 'object') ? r.yearly : {};
  return {
    currency: typeof r.currency === 'string' && /^[a-z]{3}$/.test(r.currency.toLowerCase()) ? r.currency.toLowerCase() : DEFAULT.currency,
    monthly: {
      amount: isCents(m.amount) ? m.amount : DEFAULT.monthly.amount,
      introAmount: isCents(m.introAmount) ? m.introAmount : 0,
      introLabel: typeof m.introLabel === 'string' && m.introLabel.trim() ? m.introLabel.trim().slice(0, 60) : 'First month',
    },
    yearly: {
      enabled: y.enabled !== false,
      amount: isCents(y.amount) ? y.amount : DEFAULT.yearly.amount,
    },
    offer: normalizeOffer(r.offer),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
  };
}

/** Current pricing config. Returns defaults (without writing) until first save. */
export function getConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return normalize(parsed);
  } catch {
    return normalize(DEFAULT);
  }
}

/** Has the owner (or boot backfill) persisted real pricing yet? */
export function isConfigured() {
  try { fs.accessSync(filePath()); return true; } catch { return false; }
}

function write(cfg) {
  const f = filePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
}

/**
 * Merge a patch into the config and persist. Validates amounts (integer cents
 * ≥ 0). Returns { ok, config } or { ok:false, error }.
 */
export function update(patch = {}) {
  const cur = getConfig();
  const next = { ...cur };
  if (patch.currency !== undefined) {
    const c = String(patch.currency).toLowerCase();
    if (!/^[a-z]{3}$/.test(c)) return { ok: false, error: 'Currency must be a 3-letter code.' };
    next.currency = c;
  }
  if (patch.monthly !== undefined) {
    const m = patch.monthly || {};
    const amount = m.amount === undefined ? cur.monthly.amount : m.amount;
    const introAmount = m.introAmount === undefined ? cur.monthly.introAmount : (m.introAmount || 0);
    if (!isCents(amount)) return { ok: false, error: 'Monthly price must be a whole number of cents (≥ 0).' };
    if (!isCents(introAmount)) return { ok: false, error: 'Intro price must be a whole number of cents (≥ 0).' };
    next.monthly = {
      amount,
      introAmount,
      introLabel: m.introLabel === undefined ? cur.monthly.introLabel : (String(m.introLabel || '').trim().slice(0, 60) || 'First month'),
    };
  }
  if (patch.yearly !== undefined) {
    const y = patch.yearly || {};
    const amount = y.amount === undefined ? cur.yearly.amount : y.amount;
    if (!isCents(amount)) return { ok: false, error: 'Yearly price must be a whole number of cents (≥ 0).' };
    next.yearly = { enabled: y.enabled === undefined ? cur.yearly.enabled : !!y.enabled, amount };
  }
  if (patch.offer !== undefined) {
    // Merge field-by-field so a partial patch only touches the sent fields.
    next.offer = normalizeOffer({ ...cur.offer, ...(patch.offer || {}) });
  }
  next.updatedAt = Date.now();
  write(normalize(next));
  return { ok: true, config: getConfig() };
}

/**
 * One-time backfill from the legacy env Stripe prices so a deploy keeps charging
 * the same amount. Only writes when pricing isn't configured yet. `amounts` is
 * { month: cents|null, year: cents|null }.
 */
export function seedFrom(amounts = {}) {
  if (isConfigured()) return;
  const cfg = normalize(DEFAULT);
  if (isCents(amounts.month)) cfg.monthly.amount = amounts.month;
  // Only offer yearly if the legacy env actually had a yearly price — otherwise
  // disable it, so backfilling a monthly-only prod doesn't surface a brand-new
  // (arbitrary-priced) yearly plan. The owner enables it in /god-pricing.
  if (isCents(amounts.year)) { cfg.yearly.amount = amounts.year; cfg.yearly.enabled = true; }
  else { cfg.yearly.enabled = false; }
  cfg.updatedAt = Date.now();
  write(cfg);
}

/**
 * Client/Stripe-facing view. Keeps the historical /api/pay/stripe/config shape
 * (intervals + prices.month/year) so existing frontend keeps working, and adds
 * `intro` for the new "first month then recurring" display.
 */
export function publicConfig() {
  const c = getConfig();
  const monthOffered = c.monthly.amount > 0;
  const yearOffered = c.yearly.enabled && c.yearly.amount > 0;
  return {
    currency: c.currency,
    intervals: { month: monthOffered, year: yearOffered },
    prices: {
      month: monthOffered ? { amount: c.monthly.amount, currency: c.currency, interval: 'month' } : null,
      year: yearOffered ? { amount: c.yearly.amount, currency: c.currency, interval: 'year' } : null,
    },
    intro: (monthOffered && c.monthly.introAmount > 0)
      ? { amount: c.monthly.introAmount, label: c.monthly.introLabel, currency: c.currency }
      : null,
    offer: c.offer,
  };
}
