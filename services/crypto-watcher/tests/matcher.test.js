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
