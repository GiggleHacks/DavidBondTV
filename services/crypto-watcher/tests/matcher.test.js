import { describe, it, expect } from 'vitest';
import { matchReceived } from '../lib/matcher.mjs';

describe('matchReceived', () => {
  const watch = { baselineBaseUnits: 100n, expectedBaseUnits: 50n };
  it('stays waiting when nothing new has arrived (delta 0)', () => {
    expect(matchReceived(watch, 100n)).toEqual({ matched: false, status: 'waiting' });
  });
  it('exact match → confirmed', () => {
    expect(matchReceived(watch, 150n)).toEqual({ matched: true, status: 'confirmed' });
  });
  it('overpayment still confirms', () => {
    expect(matchReceived(watch, 170n)).toEqual({ matched: true, status: 'confirmed' });
  });
  it('any positive-but-short delta is underpaid (flag for manual handling)', () => {
    expect(matchReceived(watch, 130n)).toEqual({ matched: false, status: 'underpaid' });
    expect(matchReceived(watch, 120n)).toEqual({ matched: false, status: 'underpaid' });
  });
});
