import { describe, expect, it } from 'vitest';
import { canUserWatchPremium, isAdminUser, canWatchVideo, ownsAnyProduct } from '../public/js/viewer-access.js';

describe('viewer access helpers', () => {
  it('recognizes admins by role', () => {
    expect(isAdminUser({ roles: ['admin'] })).toBe(true);
    expect(isAdminUser({ roles: ['member'] })).toBe(false);
    expect(isAdminUser(null)).toBe(false);
  });

  it('allows admins to watch premium videos', () => {
    expect(canUserWatchPremium({ roles: ['admin'] })).toBe(true);
  });

  it('allows active members to watch premium videos', () => {
    expect(canUserWatchPremium({ membership: { active: true } })).toBe(true);
  });

  it('denies anonymous or inactive viewers', () => {
    expect(canUserWatchPremium(null)).toBe(false);
    expect(canUserWatchPremium({ membership: { active: false } })).toBe(false);
    expect(canUserWatchPremium({})).toBe(false);
  });
});

describe('canWatchVideo (precedence: admin > course-ownership > premium > free)', () => {
  const member = { membership: { active: true } };
  const owner = { ownedProductIds: ['p1'] };
  const free = { id: 'v', visibility: 'free' };
  const premium = { id: 'v', visibility: 'premium' };

  it('admins watch everything', () => {
    expect(canWatchVideo({ roles: ['admin'] }, premium, ['p1'])).toBe(true);
  });

  it('free videos (no course) play for anyone', () => {
    expect(canWatchVideo(null, free, [])).toBe(true);
  });

  it('premium-only videos require membership', () => {
    expect(canWatchVideo(member, premium, [])).toBe(true);
    expect(canWatchVideo({}, premium, [])).toBe(false);
  });

  it('course-assigned videos require ownership — membership does NOT count', () => {
    expect(canWatchVideo(owner, premium, ['p1'])).toBe(true);    // owns the course
    expect(canWatchVideo(member, premium, ['p1'])).toBe(false);  // member but not owner → still locked
    expect(canWatchVideo({}, free, ['p1'])).toBe(false);         // even a "free" course video is gated
  });

  it('ownsAnyProduct matches any owned id', () => {
    expect(ownsAnyProduct(owner, ['p2', 'p1'])).toBe(true);
    expect(ownsAnyProduct(owner, ['p2'])).toBe(false);
    expect(ownsAnyProduct(null, ['p1'])).toBe(false);
  });
});
