import { describe, it, expect } from 'vitest';
import { hasActiveMembership, stripeActive, adminActive, membershipSummary, cryptoActive } from '../lib/membership.js';

const NOW = 1_000_000;
const mk = (membership) => ({ membership });

describe('membership — stripe', () => {
  it('no membership → inactive', () => {
    expect(hasActiveMembership(null, NOW)).toBe(false);
    expect(hasActiveMembership({}, NOW)).toBe(false);
    expect(hasActiveMembership(mk(null), NOW)).toBe(false);
  });

  it('active with future period end → active', () => {
    const u = mk({ provider: 'stripe', status: 'active', currentPeriodEnd: NOW + 1000 });
    expect(stripeActive(u, NOW)).toBe(true);
    expect(hasActiveMembership(u, NOW)).toBe(true);
  });

  it('past period end → inactive even if status active', () => {
    expect(stripeActive(mk({ provider: 'stripe', status: 'active', currentPeriodEnd: NOW - 1 }), NOW)).toBe(false);
  });

  it('boundary: now === currentPeriodEnd is inactive (strictly before)', () => {
    expect(stripeActive(mk({ provider: 'stripe', status: 'active', currentPeriodEnd: NOW }), NOW)).toBe(false);
  });

  it('past_due keeps access within the paid period (dunning grace)', () => {
    expect(stripeActive(mk({ provider: 'stripe', status: 'past_due', currentPeriodEnd: NOW + 1 }), NOW)).toBe(true);
  });

  it('trialing within period → active', () => {
    expect(stripeActive(mk({ provider: 'stripe', status: 'trialing', currentPeriodEnd: NOW + 1 }), NOW)).toBe(true);
  });

  it('canceled / incomplete → inactive', () => {
    expect(stripeActive(mk({ provider: 'stripe', status: 'canceled', currentPeriodEnd: NOW + 1000 }), NOW)).toBe(false);
    expect(stripeActive(mk({ provider: 'stripe', status: 'incomplete', currentPeriodEnd: NOW + 1000 }), NOW)).toBe(false);
  });

  it('missing currentPeriodEnd → inactive', () => {
    expect(stripeActive(mk({ provider: 'stripe', status: 'active' }), NOW)).toBe(false);
  });

  it('wrong provider is not treated as stripe', () => {
    expect(stripeActive(mk({ provider: 'admin', status: 'active', currentPeriodEnd: NOW + 1 }), NOW)).toBe(false);
  });
});

describe('membership — admin comp', () => {
  it('null period end → active indefinitely', () => {
    const u = mk({ provider: 'admin', status: 'active', currentPeriodEnd: null });
    expect(adminActive(u, NOW)).toBe(true);
    expect(hasActiveMembership(u, NOW)).toBe(true);
  });

  it('future expiry active; past expiry inactive', () => {
    expect(adminActive(mk({ provider: 'admin', status: 'active', currentPeriodEnd: NOW + 1 }), NOW)).toBe(true);
    expect(adminActive(mk({ provider: 'admin', status: 'active', currentPeriodEnd: NOW - 1 }), NOW)).toBe(false);
  });

  it('non-active status → inactive', () => {
    expect(adminActive(mk({ provider: 'admin', status: 'revoked', currentPeriodEnd: null }), NOW)).toBe(false);
  });
});

describe('membershipSummary', () => {
  it('reflects active + safe fields, never exposes ids', () => {
    const u = mk({
      provider: 'stripe', status: 'active', interval: 'month',
      currentPeriodEnd: NOW + 1000, cancelAtPeriodEnd: true, stripeSubscriptionId: 'sub_x',
    });
    const s = membershipSummary(u, NOW);
    expect(s).toEqual({
      active: true, provider: 'stripe', status: 'active', interval: 'month',
      currentPeriodEnd: NOW + 1000, cancelAtPeriodEnd: true, since: null,
    });
    expect('stripeSubscriptionId' in s).toBe(false);
  });

  it('no membership → inactive shape', () => {
    expect(membershipSummary(mk(null), NOW)).toEqual({
      active: false, provider: null, status: null, interval: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, since: null,
    });
  });
});

const now = 1_000_000;

describe('cryptoActive', () => {
  it('is active when provider=crypto, status=active, and time remains', () => {
    const u = { membership: { provider: 'crypto', status: 'active', currentPeriodEnd: now + 1000 } };
    expect(cryptoActive(u, now)).toBe(true);
    expect(hasActiveMembership(u, now)).toBe(true);
  });
  it('is inactive once the paid period has ended', () => {
    const u = { membership: { provider: 'crypto', status: 'active', currentPeriodEnd: now - 1 } };
    expect(cryptoActive(u, now)).toBe(false);
    expect(hasActiveMembership(u, now)).toBe(false);
  });
  it('summary reports the crypto provider', () => {
    const u = { membership: { provider: 'crypto', status: 'active', interval: 'year', currentPeriodEnd: now + 1000, since: now } };
    const s = membershipSummary(u, now);
    expect(s.active).toBe(true);
    expect(s.provider).toBe('crypto');
    expect(s.interval).toBe('year');
  });
});
