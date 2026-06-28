import { hasActiveMembership } from './membership.js';

const SUBSCRIPTION_KINDS = new Set([
  'stripe.invoice.paid',
  'whop.membership.paid',
  'crypto.membership.paid',
]);

const PRODUCT_KINDS = new Set([
  'stripe.product.paid',
  'crypto.product.paid',
]);

function txnCents(t) {
  const n = Number(t.amountCents ?? t.expectedFiatCents ?? t.fiatCents ?? t.amount);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

export function buildFinancialSummary(users = [], paymentsStore) {
  let revenueCents = 0; let subsRevenue = 0; let productRevenue = 0;
  let subSales = 0; let productSales = 0; let currency = 'usd';
  const byMonth = {};

  for (const u of users) {
    const txns = paymentsStore && typeof paymentsStore.listForUser === 'function'
      ? paymentsStore.listForUser(u.id) : [];
    for (const t of txns) {
      const isSub = SUBSCRIPTION_KINDS.has(t.kind);
      const isProduct = PRODUCT_KINDS.has(t.kind);
      if (!isSub && !isProduct) continue;
      const amt = txnCents(t);
      revenueCents += amt;
      const fiatCurrency = t.fiatCurrency || (!String(t.kind || '').startsWith('crypto.') ? t.currency : null);
      if (fiatCurrency && String(fiatCurrency).length === 3) currency = String(fiatCurrency).toLowerCase();
      if (isSub) { subsRevenue += amt; subSales += 1; }
      else { productRevenue += amt; productSales += 1; }
      const d = new Date(t.ts || 0);
      if (!Number.isNaN(d.getTime())) {
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        byMonth[key] = (byMonth[key] || 0) + amt;
      }
    }
  }

  const subs = { active: 0, trialing: 0, pastDue: 0, comp: 0, canceling: 0, canceled: 0 };
  let paidUsers = 0;
  for (const u of users) {
    const m = u.membership || null;
    const active = hasActiveMembership(u);
    const ownsProduct = Array.isArray(u.products) && u.products.length > 0;
    if (active || ownsProduct) paidUsers += 1;
    if (!m) continue;
    if (active) {
      if (m.provider === 'admin') subs.comp += 1;
      else if (m.status === 'trialing') subs.trialing += 1;
      else if (m.status === 'past_due') subs.pastDue += 1;
      else subs.active += 1;
      if (m.cancelAtPeriodEnd) subs.canceling += 1;
    } else {
      subs.canceled += 1;
    }
  }

  const series = [];
  const dn = new Date();
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(dn.getUTCFullYear(), dn.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    series.push({ month: key, cents: byMonth[key] || 0 });
  }
  for (const key of Object.keys(byMonth)) {
    if (!series.some((m) => m.month === key)) series.push({ month: key, cents: byMonth[key] });
  }
  series.sort((a, b) => (a.month < b.month ? -1 : 1));

  const total = users.length;
  const free = Math.max(0, total - paidUsers);
  return {
    currency,
    revenue: { total: revenueCents, subscriptions: subsRevenue, products: productRevenue, series },
    sales: { total: subSales + productSales, subscriptions: subSales, products: productSales },
    subscriptions: subs,
    users: { total, paid: paidUsers, free, conversion: total ? Math.round((paidUsers / total) * 1000) / 10 : 0 },
    generatedAt: Date.now(),
  };
}
