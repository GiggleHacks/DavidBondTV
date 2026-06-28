import { describe, it, expect } from 'vitest';
import { normalizeCryptoConfig } from '../lib/crypto-config.js';

describe('normalizeCryptoConfig', () => {
  it('fills defaults and keeps only coins that have an address', () => {
    const c = normalizeCryptoConfig({
      coins: { ETH: { address: '0xabc' }, LTC: { address: '' }, XMR: { address: '8x' } },
    });
    expect(c.enabledCoins).toEqual(['ETH', 'XMR']); // LTC dropped: no address
    expect(c.coins.ETH.confirmations).toBe(1);      // default
    expect(c.coins.ETH.decimals).toBe(6);
    expect(c.orderTtlMs).toBe(20 * 60 * 1000);
    expect(c.membership.plans['3mo']).toEqual({ months: 3, priceUsd: 59.07, label: '3 months' });
    expect(c.membership.plans.year.priceUsd).toBe(197);
    expect(c.productDiscountPercent).toBe(0);
  });
  it('disables everything when given nothing', () => {
    const c = normalizeCryptoConfig(null);
    expect(c.enabledCoins).toEqual([]);
  });
});
