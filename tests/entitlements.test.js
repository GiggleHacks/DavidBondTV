import { describe, expect, it } from 'vitest';
import { ownsProduct, ownedProductIds, entitlementsSummary } from '../lib/entitlements.js';

const userWith = (products) => ({ id: 'u1', products });

describe('entitlements', () => {
  it('ownsProduct is true only for owned ids', () => {
    const u = userWith([{ productId: 'p1', stripeSessionId: 's1' }]);
    expect(ownsProduct(u, 'p1')).toBe(true);
    expect(ownsProduct(u, 'p2')).toBe(false);
    expect(ownsProduct(null, 'p1')).toBe(false);
    expect(ownsProduct(u, '')).toBe(false);
  });

  it('ownedProductIds dedupes and tolerates legacy records', () => {
    const u = userWith([{ productId: 'p1' }, { productId: 'p1' }, { productId: 'p2' }]);
    expect(ownedProductIds(u).sort()).toEqual(['p1', 'p2']);
    expect(ownedProductIds({ id: 'x' })).toEqual([]); // no products field
    expect(ownedProductIds(null)).toEqual([]);
  });

  it('does NOT consult membership (a member owns nothing by default)', () => {
    const member = { id: 'u2', membership: { provider: 'stripe', status: 'active', currentPeriodEnd: Date.now() + 1e9 } };
    expect(ownedProductIds(member)).toEqual([]);
    expect(ownsProduct(member, 'p1')).toBe(false);
  });

  it('entitlementsSummary exposes only id + purchasedAt (never the session id)', () => {
    const u = userWith([{ productId: 'p1', stripeSessionId: 'cs_secret', amount: 9900, purchasedAt: 123 }]);
    const s = entitlementsSummary(u);
    expect(s.products).toEqual([{ productId: 'p1', purchasedAt: 123 }]);
    expect(JSON.stringify(s)).not.toContain('cs_secret');
  });
});
