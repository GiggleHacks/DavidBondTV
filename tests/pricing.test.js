import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as pricing from '../lib/pricing.js';

let file;
beforeEach(() => {
  file = path.join(os.tmpdir(), `pricing-${crypto.randomUUID()}.json`);
  process.env.PRICING_FILE = file;
});
afterEach(() => {
  delete process.env.PRICING_FILE;
  try { fs.unlinkSync(file); } catch { /* ignore */ }
});

describe('pricing store', () => {
  it('returns intro-free defaults without writing a file', () => {
    const c = pricing.getConfig();
    expect(c.monthly.amount).toBe(1700);
    expect(c.monthly.introAmount).toBe(0); // no intro by default → no behavior change on deploy
    expect(c.yearly.enabled).toBe(true);
    expect(pricing.isConfigured()).toBe(false); // getConfig must not persist
  });

  it('updates monthly + intro and persists', () => {
    const r = pricing.update({ monthly: { amount: 1700, introAmount: 4700, introLabel: 'First month' } });
    expect(r.ok).toBe(true);
    expect(pricing.isConfigured()).toBe(true);
    const c = pricing.getConfig();
    expect(c.monthly.amount).toBe(1700);
    expect(c.monthly.introAmount).toBe(4700);
  });

  it('rejects non-integer / negative amounts', () => {
    expect(pricing.update({ monthly: { amount: 17.5 } }).ok).toBe(false);
    expect(pricing.update({ monthly: { amount: -1 } }).ok).toBe(false);
    expect(pricing.update({ yearly: { amount: 1.2 } }).ok).toBe(false);
    expect(pricing.update({ currency: 'dollars' }).ok).toBe(false);
  });

  it('seedFrom backfills amounts only when unconfigured', () => {
    pricing.seedFrom({ month: 100, year: 1000 });
    let c = pricing.getConfig();
    expect(c.monthly.amount).toBe(100);
    expect(c.yearly.amount).toBe(1000);
    expect(c.monthly.introAmount).toBe(0);
    // Second call must NOT overwrite a now-configured file.
    pricing.seedFrom({ month: 999, year: 9999 });
    c = pricing.getConfig();
    expect(c.monthly.amount).toBe(100);
  });

  it('seedFrom disables yearly when the legacy env had no yearly price', () => {
    pricing.seedFrom({ month: 100, year: null }); // monthly-only prod
    const c = pricing.getConfig();
    expect(c.monthly.amount).toBe(100);
    expect(c.yearly.enabled).toBe(false);
    expect(pricing.publicConfig().intervals.year).toBe(false);
  });

  it('publicConfig keeps the legacy shape and adds intro when set', () => {
    pricing.update({ monthly: { amount: 1700, introAmount: 4700 }, yearly: { enabled: true, amount: 12000 } });
    const pub = pricing.publicConfig();
    expect(pub.intervals).toEqual({ month: true, year: true });
    expect(pub.prices.month).toMatchObject({ amount: 1700, interval: 'month' });
    expect(pub.prices.year).toMatchObject({ amount: 12000, interval: 'year' });
    expect(pub.intro).toMatchObject({ amount: 4700 });
  });

  it('publicConfig omits intro when introAmount is 0, and hides a disabled yearly', () => {
    pricing.update({ monthly: { amount: 1700, introAmount: 0 }, yearly: { enabled: false, amount: 12000 } });
    const pub = pricing.publicConfig();
    expect(pub.intro).toBe(null);
    expect(pub.intervals.year).toBe(false);
    expect(pub.prices.year).toBe(null);
  });

  it('exposes editable offer copy with sane defaults', () => {
    const c = pricing.getConfig();
    expect(c.offer.badge).toBe('★ Members only');
    expect(c.offer.ctaLabel).toBe('Unlock Now');
    expect(pricing.publicConfig().offer).toMatchObject({ headline: c.offer.headline });
  });

  it('updates offer copy field-by-field, trims, and falls back blanks to default', () => {
    let r = pricing.update({ offer: { headline: '  Unlock This Video  ', ctaLabel: 'Join now' } });
    expect(r.ok).toBe(true);
    expect(r.config.offer.headline).toBe('Unlock This Video'); // trimmed
    expect(r.config.offer.ctaLabel).toBe('Join now');
    expect(r.config.offer.body).toBe(pricing.getConfig().offer.body); // untouched field preserved
    // A blank field reverts to the default copy (never renders empty).
    r = pricing.update({ offer: { headline: '   ' } });
    expect(r.config.offer.headline).toBe("You're one tap from the good stuff");
    // Updating offer must not disturb prices.
    expect(pricing.getConfig().monthly.amount).toBe(1700);
  });

  it('clamps over-long offer copy to its max length', () => {
    const r = pricing.update({ offer: { headline: 'x'.repeat(500) } });
    expect(r.config.offer.headline.length).toBe(120);
  });
});
