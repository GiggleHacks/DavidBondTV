import { describe, expect, it } from 'vitest';
import { deriveBillingView } from '../public/js/billing-view.js';

describe('deriveBillingView', () => {
  it('treats admins without a paid membership as already having access', () => {
    expect(deriveBillingView({ roles: ['admin'], membership: { active: false } })).toMatchObject({
      action: null,
      kind: 'admin-access',
      status: 'Your admin account already has full access. Billing is not required.',
    });
  });

  it('treats an admin WITH an active subscription as admin-access (admin wins)', () => {
    expect(deriveBillingView({
      roles: ['admin'],
      membership: { active: true, status: 'active', interval: 'month', currentPeriodEnd: 1_800_000_000_000 },
    })).toMatchObject({ kind: 'admin-access', action: null });
  });

  it('shows active members as members', () => {
    expect(deriveBillingView({
      membership: { active: true, status: 'active', interval: 'month', currentPeriodEnd: 1_800_000_000_000 },
      roles: [],
    }).kind).toBe('member');
  });

  it('shows non-members as prospects', () => {
    expect(deriveBillingView({ roles: [], membership: null })).toMatchObject({
      action: 'join',
      kind: 'prospect',
    });
  });
});
