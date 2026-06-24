import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as coupons from '../lib/coupons.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtv-coupons-'));
  process.env.COUPONS_FILE = path.join(dir, 'coupons.json');
  process.env.COUPON_REDEMPTIONS_FILE = path.join(dir, 'coupon-redemptions.json');
});

afterEach(() => {
  delete process.env.COUPONS_FILE;
  delete process.env.COUPON_REDEMPTIONS_FILE;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('importAll (config sync)', () => {
  it('imports coupon definitions and preserves an existing code\'s redemption count + Stripe link', () => {
    // Production already has SUMMER_25 with redemptions + a Stripe link.
    const made = coupons.create({ code: 'SUMMER_25', percentOff: 25, duration: 'once' });
    coupons.update(made.coupon.id, {}); // no-op to bump updatedAt
    const arr = coupons.list();
    arr[0].timesRedeemed = 7;
    arr[0].stripeCouponId = 'stripe_abc';
    arr[0].stripeSig = 'sig';
    fs.writeFileSync(process.env.COUPONS_FILE, JSON.stringify(arr));

    const r = coupons.importAll([
      { code: 'SUMMER_25', percentOff: 25, duration: 'once' }, // existing → keep runtime fields
      { code: 'WELCOME10', percentOff: 10, duration: 'forever' }, // new
      { code: 'bad', percentOff: 999, duration: 'once' }, // invalid percent → skipped
    ]);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);

    const summer = coupons.getByCode('SUMMER_25');
    expect(summer.timesRedeemed).toBe(7); // preserved from prod
    expect(summer.stripeCouponId).toBe('stripe_abc'); // prod's Stripe link kept

    const welcome = coupons.getByCode('WELCOME10');
    expect(welcome.timesRedeemed).toBe(0);
    expect(welcome.stripeCouponId).toBe(null); // new code derives its own later
  });
});

describe('coupon registry', () => {
  it('creates, normalizes, disables, updates, and removes percent-off coupons', () => {
    const created = coupons.create({
      code: ' summer_25 ',
      label: 'Summer promo',
      percentOff: 25,
      duration: 'once',
      maxRedemptions: 10,
      oncePerCustomer: true,
    });

    expect(created.ok).toBe(true);
    expect(created.coupon.code).toBe('SUMMER_25');
    expect(created.coupon.percentOff).toBe(25);
    expect(created.coupon.active).toBe(true);

    expect(coupons.setActive(created.coupon.id, false).coupon.active).toBe(false);
    const updated = coupons.update(created.coupon.id, { percentOff: 30, active: true });
    expect(updated.coupon.percentOff).toBe(30);
    expect(updated.coupon.stripeCouponId).toBe(null);

    expect(coupons.remove(created.coupon.id).ok).toBe(true);
    expect(coupons.getByCode('SUMMER_25')).toBe(null);
  });

  it('reports validation states for missing, disabled, expired, capped, and already-used coupons', () => {
    const expired = coupons.create({ code: 'OLD', percentOff: 10, duration: 'once', expiresAt: Date.now() - 1000 }).coupon;
    const disabled = coupons.create({ code: 'OFF', percentOff: 10, duration: 'once', active: false }).coupon;
    const capped = coupons.create({ code: 'CAP', percentOff: 10, duration: 'once', maxRedemptions: 1 }).coupon;
    const once = coupons.create({ code: 'ONCE', percentOff: 10, duration: 'once', oncePerCustomer: true }).coupon;
    coupons.recordRedemption({ couponId: capped.id, userId: 'u1', sessionId: 'cs_cap' });
    coupons.recordRedemption({ couponId: once.id, userId: 'u1', sessionId: 'cs_once' });

    expect(coupons.validate('missing', { userId: 'u1' }).error).toMatch(/valid/i);
    expect(coupons.validate(disabled.code, { userId: 'u1' }).error).toMatch(/active/i);
    expect(coupons.validate(expired.code, { userId: 'u1' }).error).toMatch(/expired/i);
    expect(coupons.validate(capped.code, { userId: 'u2' }).error).toMatch(/limit/i);
    expect(coupons.validate(once.code, { userId: 'u1' }).error).toMatch(/already/i);
  });

  it('tracks redemption history and stats idempotently by checkout session', () => {
    const coupon = coupons.create({ code: 'TRACK20', percentOff: 20, duration: 'once' }).coupon;
    const first = coupons.recordRedemption({
      couponId: coupon.id,
      userId: 'u1',
      sessionId: 'cs_123',
      kind: 'product',
      productId: 'p1',
      amountDiscount: 500,
      currency: 'usd',
    });
    const dup = coupons.recordRedemption({ couponId: coupon.id, userId: 'u1', sessionId: 'cs_123' });

    expect(first.ok).toBe(true);
    expect(dup.duplicate).toBe(true);
    expect(coupons.listRedemptions(coupon.id)).toHaveLength(1);
    expect(coupons.usageStats(coupon.id)).toEqual({ timesRedeemed: 1, uniqueUsers: 1, totalDiscount: 500 });
    expect(coupons.listWithStats()[0].stats.timesRedeemed).toBe(1);
  });
});
