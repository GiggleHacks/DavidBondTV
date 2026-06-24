import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as categories from '../lib/categories.js';

let file;
beforeEach(() => {
  file = path.join(os.tmpdir(), `categories-${crypto.randomUUID()}.json`);
  process.env.CATEGORIES_FILE = file;
});
afterEach(() => {
  delete process.env.CATEGORIES_FILE;
  try { fs.unlinkSync(file); } catch { /* ignore */ }
});

describe('importAll (config sync)', () => {
  it('replaces the set, hydrating visuals and de-duplicating by slug', () => {
    categories.add('Old One'); // will be wiped by the replace
    const r = categories.importAll([
      { slug: 'hacking', name: 'Hacking', icon: '💻' },
      { slug: 'colombia', name: 'Colombia', visual: { kind: 'flag', value: 'CO' } },
      { slug: 'hacking', name: 'Dupe Hacking' }, // duplicate slug → dropped
      { name: 'No slug' }, // invalid → skipped
    ]);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    const list = categories.list();
    expect(list.map((c) => c.slug)).toEqual(['hacking', 'colombia']);
    expect(list.find((c) => c.slug === 'hacking').icon).toBe('💻');
    expect(list.find((c) => c.slug === 'colombia').flag).toBe('co');
    expect(categories.has('old-one')).toBe(false); // prior set replaced
  });

  it('rejects non-array input', () => {
    expect(categories.importAll(null).ok).toBe(false);
  });
});

describe('category flags', () => {
  it('isValidFlag normalizes 2-letter codes and rejects the rest', () => {
    expect(categories.isValidFlag('CO')).toBe('co');
    expect(categories.isValidFlag(' Co ')).toBe('co');
    expect(categories.isValidFlag('usa')).toBe('');
    expect(categories.isValidFlag('1a')).toBe('');
    expect(categories.isValidFlag('')).toBe('');
    expect(categories.isValidFlag(null)).toBe('');
  });

  it('add() stores a valid flag (lowercased) and omits an invalid one', () => {
    const a = categories.add('Colombian Harem', 'CO');
    expect(a.ok).toBe(true);
    expect(a.category.flag).toBe('co');

    const b = categories.add('Travel Vlogs', 'nope');
    expect(b.ok).toBe(true);
    expect('flag' in b.category).toBe(false); // no key when no valid flag
  });

  it('setFlag sets, clears, and rejects unknown slugs', () => {
    categories.add('Beach');
    expect(categories.setFlag('beach', 'br').category.flag).toBe('br');
    // clearing removes the key entirely
    const cleared = categories.setFlag('beach', '');
    expect('flag' in cleared.category).toBe(false);
    // invalid code also clears
    categories.setFlag('beach', 'mx');
    expect('flag' in categories.setFlag('beach', 'zzz').category).toBe(false);
    expect(categories.setFlag('missing', 'co').ok).toBe(false);
  });

  it('flag survives a rename (slug stays stable)', () => {
    categories.add('Medellin', 'co');
    const r = categories.rename('medellin', 'Medellín Trips');
    expect(r.ok).toBe(true);
    expect(r.category.flag).toBe('co');
    expect(r.category.visual).toEqual({ kind: 'flag', value: 'co' });
    expect(categories.list().find((c) => c.slug === 'medellin').flag).toBe('co');
  });

  it('sidebar icon survives rename and can be cleared', () => {
    categories.add('Reviews');
    expect(categories.setIcon('reviews', '🎬').category.icon).toBe('🎬');
    expect(categories.setIcon('reviews', '🎬').category.visual).toEqual({ kind: 'emoji', value: '🎬', label: '🎬' });
    expect(categories.rename('reviews', 'Video Reviews').category.icon).toBe('🎬');
    const cleared = categories.setIcon('reviews', '');
    expect('icon' in cleared.category).toBe(false);
  });

  it('supports searchable custom icon keys through the unified visual field', () => {
    categories.add('Privacy');
    const updated = categories.setVisual('privacy', { kind: 'custom', value: 'shield', label: 'Shield' });
    expect(updated.ok).toBe(true);
    expect(updated.category.iconKey).toBe('shield');
    expect(updated.category.visual).toEqual({ kind: 'custom', value: 'shield', label: 'Shield' });
    expect(categories.rename('privacy', 'Privacy Force').category.iconKey).toBe('shield');
  });

  it('hydrates legacy records into the unified visual shape', () => {
    fs.writeFileSync(file, JSON.stringify([
      { slug: 'colombia', name: 'Colombia', flag: 'co' },
      { slug: 'hacking', name: 'Hacking', icon: '💻' },
      { slug: 'privacy', name: 'Privacy', iconKey: 'shield' },
    ], null, 2));
    const list = categories.list();
    expect(list.find((c) => c.slug === 'colombia').visual).toEqual({ kind: 'flag', value: 'co' });
    expect(list.find((c) => c.slug === 'hacking').visual).toEqual({ kind: 'emoji', value: '💻', label: '💻' });
    expect(list.find((c) => c.slug === 'privacy').visual).toEqual({ kind: 'custom', value: 'shield', label: 'shield' });
  });
});
