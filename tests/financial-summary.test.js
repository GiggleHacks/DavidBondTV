import { describe, expect, it } from 'vitest';
import { buildFinancialSummary } from '../lib/financial-summary.js';

function payments(map) {
  return {
    listForUser(userId) {
      return map[userId] || [];
    },
  };
}

describe('financial summary', () => {
  it('counts active whop, crypto, and legacy stripe ledger events', () => {
    const users = [
      { id: 'u1', membership: { provider: 'whop', status: 'active', currentPeriodEnd: Date.now() + 100000 } },
      { id: 'u2', products: [{ productId: 'prod_1' }] },
      { id: 'u3', membership: { provider: 'crypto', status: 'active', currentPeriodEnd: Date.now() + 100000 } },
    ];
    const summary = buildFinancialSummary(users, payments({
      u1: [{ kind: 'whop.membership.paid', ts: Date.parse('2026-06-01T00:00:00Z'), amount: 4900, currency: 'usd' }],
      u2: [{ kind: 'crypto.product.paid', ts: Date.parse('2026-06-02T00:00:00Z'), amount: 26910, currency: 'usd' }],
      u3: [
        { kind: 'crypto.membership.paid', ts: Date.parse('2026-06-03T00:00:00Z'), amount: 5907, currency: 'usd' },
        { kind: 'stripe.invoice.paid', ts: Date.parse('2026-06-04T00:00:00Z'), amount: 1999, currency: 'usd' },
      ],
    }));

    expect(summary.revenue.total).toBe(39716);
    expect(summary.revenue.subscriptions).toBe(12806);
    expect(summary.revenue.products).toBe(26910);
    expect(summary.sales).toMatchObject({ total: 4, subscriptions: 3, products: 1 });
    expect(summary.users.paid).toBe(3);
    expect(summary.revenue.series.find((m) => m.month === '2026-06').cents).toBe(39716);
  });
});
