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
    expect(categories.list().find((c) => c.slug === 'medellin').flag).toBe('co');
  });
});
