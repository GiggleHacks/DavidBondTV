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
  it('throws if decimals exceeds the float-safe range (money-math guard)', () => {
    expect(() => uniqueAmount({ usd: 10, rate: 2000, decimals: 18, jitter: 0 })).toThrow();
  });
});
