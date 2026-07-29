import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as products from '../lib/products.js';

let file;
beforeEach(() => {
  file = path.join(os.tmpdir(), `products-${crypto.randomUUID()}.json`);
  process.env.PRODUCTS_FILE = file;
});
afterEach(() => {
  delete process.env.PRODUCTS_FILE;
  try { fs.unlinkSync(file); } catch { /* ignore */ }
});

describe('products store', () => {
  it('seeds the Digital Pickup course on first read (unpublished, no videos)', () => {
    const all = products.list();
    expect(all).toHaveLength(1);
    const dp = all[0];
    expect(dp.slug).toBe('digital-pickup');
    expect(dp.price).toBe(9900);
    expect(dp.published).toBe(false);
    expect(dp.videoIds).toEqual([]);
    expect(products.listPublished()).toHaveLength(0);
  });

  it('adds a product and rejects bad price + duplicate slug', () => {
    const r = products.add({ type: 'course', name: 'My Course', price: 4900 });
    expect(r.ok).toBe(true);
    expect(r.product.slug).toBe('my-course');
    expect(r.product.published).toBe(false);

    expect(products.add({ name: 'X', price: 1.5 }).ok).toBe(false); // non-integer cents
    expect(products.add({ name: 'X', price: -1 }).ok).toBe(false);
    expect(products.add({ name: 'My Course', price: 100 }).ok).toBe(false); // slug clash
  });

  it('updates fields, sets videos and branding, and publishes', () => {
    const id = products.add({ name: 'C', price: 100 }).product.id;
    expect(products.update(id, { name: 'Renamed', price: 200, published: true }).ok).toBe(true);
    expect(products.setVideos(id, ['v1', 'v2', 'v2']).product.videoIds).toEqual(['v1', 'v2']);
    expect(products.setBranding(id, { primary: '#abcdef' }).product.branding.primary).toBe('#abcdef');
    const p = products.getById(id);
    expect(p.name).toBe('Renamed');
    expect(p.published).toBe(true);
    expect(products.listPublished().some((x) => x.id === id)).toBe(true);
  });

  it('maps a video assigned to multiple products (bundle case)', () => {
    const a = products.add({ name: 'A', price: 100 }).product.id;
    const b = products.add({ name: 'B', price: 100 }).product.id;
    products.setVideos(a, ['shared', 'onlyA']);
    products.setVideos(b, ['shared']);
    const map = products.videoProductMap();
    expect(map.get('shared').sort()).toEqual([a, b].sort());
    expect(map.get('onlyA')).toEqual([a]);
    expect(products.productIdsForVideo('shared').sort()).toEqual([a, b].sort());
  });

  it('productIdsForVideo can restrict to published products', () => {
    const a = products.add({ name: 'A', price: 100 }).product.id;
    products.setVideos(a, ['v']);
    expect(products.productIdsForVideo('v', { publishedOnly: true })).toEqual([]);
    products.update(a, { published: true });
    expect(products.productIdsForVideo('v', { publishedOnly: true })).toEqual([a]);
  });

  it('removes a product', () => {
    const id = products.add({ name: 'Doomed', price: 100 }).product.id;
    expect(products.remove(id).ok).toBe(true);
    expect(products.getById(id)).toBe(null);
    expect(products.remove('nope').ok).toBe(false);
  });

  it('defaults category to "" and trailer to null, and round-trips both', () => {
    const p = products.add({ name: 'Cat Course', price: 100 }).product;
    expect(p.category).toBe('');
    expect(p.trailer).toBe(null);
    // category is stored as a free-text slug (decoupled from the video registry).
    const u = products.update(p.id, { category: 'Meeting Women', trailer: 'vid-123' }).product;
    expect(u.category).toBe('meeting-women');
    expect(u.trailer).toBe('vid-123');
    // empty/whitespace clears them
    expect(products.update(p.id, { category: '', trailer: '' }).product.category).toBe('');
    expect(products.update(p.id, { trailer: '' }).product.trailer).toBe(null);
    // accepted at creation time too
    const c = products.add({ name: 'Seeded', price: 200, category: 'dating', trailer: 't1' }).product;
    expect(c.category).toBe('dating');
    expect(c.trailer).toBe('t1');
  });

  it('publicView carries category + trailer for the storefront', () => {
    const p = products.add({ name: 'Store Course', price: 2500, category: 'meeting-women', trailer: 'tv9' }).product;
    const view = products.publicView(p);
    expect(view.category).toBe('meeting-women');
    expect(view.trailer).toBe('tv9');
  });

  it('publicView omits nothing secret but carries branding + price', () => {
    const p = products.add({ name: 'C', price: 2500, sales: { headline: 'Hi' } }).product;
    const view = products.publicView(p);
    expect(view).toMatchObject({ slug: 'c', price: 2500, currency: 'usd' });
    expect(view.sales.headline).toBe('Hi');
    expect(view.branding).toBeTruthy();
  });
});

// Per-product WHOP plan id: what turns the card rail on for a one-time course.
// Absent = crypto-only, which is how every product behaved before this existed.
describe('products — whopPlanId (card rail per product)', () => {
  it('defaults to null so an existing catalog needs no migration', () => {
    const dp = products.list()[0];
    expect(dp.whopPlanId).toBeNull();
    expect(products.publicView(dp).cardEnabled).toBe(false);
  });

  it('accepts a plan id and exposes only a boolean publicly', () => {
    const dp = products.list()[0];
    const r = products.update(dp.id, { whopPlanId: 'plan_LCecn0REAGAri' });
    expect(r.ok).toBe(true);
    expect(r.product.whopPlanId).toBe('plan_LCecn0REAGAri');
    const pub = products.publicView(r.product);
    expect(pub.cardEnabled).toBe(true);
    // The plan id itself must not leak to the client — checkout resolves it server-side.
    expect(pub.whopPlanId).toBeUndefined();
  });

  it('trims whitespace and rejects an id with unsafe characters', () => {
    const dp = products.list()[0];
    expect(products.update(dp.id, { whopPlanId: '  plan_abc123  ' }).product.whopPlanId).toBe('plan_abc123');
    const bad = products.update(dp.id, { whopPlanId: 'plan_abc/../x' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/plan id/i);
    // The rejected write left the previous value intact.
    expect(products.getById(dp.id).whopPlanId).toBe('plan_abc123');
  });

  it('blank clears it back to crypto-only', () => {
    const dp = products.list()[0];
    products.update(dp.id, { whopPlanId: 'plan_abc123' });
    const r = products.update(dp.id, { whopPlanId: '' });
    expect(r.ok).toBe(true);
    expect(r.product.whopPlanId).toBeNull();
  });

  it('survives a reload', () => {
    const dp = products.list()[0];
    products.update(dp.id, { whopPlanId: 'plan_persist' });
    expect(products.getById(dp.id).whopPlanId).toBe('plan_persist');
  });
});
