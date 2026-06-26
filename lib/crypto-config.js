// Static receiving addresses + tunables for crypto checkout. Backed by the
// gitignored data/crypto-config.json so addresses/keys never enter the repo.
import fs from 'node:fs';

const DEFAULTS = {
  ETH: { decimals: 6, confirmations: 1 },
  LTC: { decimals: 8, confirmations: 6 },
  XMR: { decimals: 12, confirmations: 10 },
};

const DEFAULT_PLANS = {
  '3mo': { months: 3, priceUsd: 59.07, label: '3 months' },
  year: { months: 12, priceUsd: 197, label: '1 year' },
};
function normalizeMembership(raw) {
  const src = (raw && typeof raw === 'object' && raw.plans && typeof raw.plans === 'object') ? raw.plans : {};
  const plans = {};
  for (const key of Object.keys(DEFAULT_PLANS)) {
    const p = src[key] || {};
    plans[key] = {
      months: Number.isInteger(p.months) ? p.months : DEFAULT_PLANS[key].months,
      priceUsd: typeof p.priceUsd === 'number' ? p.priceUsd : DEFAULT_PLANS[key].priceUsd,
      label: typeof p.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 40) : DEFAULT_PLANS[key].label,
    };
  }
  return { plans };
}

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
  return {
    coins,
    enabledCoins,
    membership: normalizeMembership(src.membership),
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
