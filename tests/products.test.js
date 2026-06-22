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

  it('publicView omits nothing secret but carries branding + price', () => {
    const p = products.add({ name: 'C', price: 2500, sales: { headline: 'Hi' } }).product;
    const view = products.publicView(p);
    expect(view).toMatchObject({ slug: 'c', price: 2500, currency: 'usd' });
    expect(view.sales.headline).toBe('Hi');
    expect(view.branding).toBeTruthy();
  });
});
