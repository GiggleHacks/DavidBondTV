import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as subs from '../lib/subscribers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'subscribers.json');

// Snapshot + restore the real store file so tests never clobber live data.
const had = fs.existsSync(FILE);
const saved = had ? fs.readFileSync(FILE, 'utf8') : null;
afterEach(() => {
  if (saved !== null) fs.writeFileSync(FILE, saved);
  else fs.rmSync(FILE, { force: true });
});

describe('subscribers store', () => {
  it('subscribe is idempotent and counts uniquely', () => {
    fs.rmSync(FILE, { force: true });
    expect(subs.count()).toBe(0);
    expect(subs.subscribe('u1').count).toBe(1);
    expect(subs.subscribe('u1').count).toBe(1); // idempotent
    expect(subs.subscribe('u2').count).toBe(2);
    expect(subs.isSubscribed('u1')).toBe(true);
    expect(subs.isSubscribed('nope')).toBe(false);
  });

  it('unsubscribe removes and is idempotent', () => {
    fs.rmSync(FILE, { force: true });
    subs.subscribe('u1');
    expect(subs.unsubscribe('u1').count).toBe(0);
    expect(subs.unsubscribe('u1').count).toBe(0);
    expect(subs.isSubscribed('u1')).toBe(false);
  });

  it('series returns cumulative counts over the window', () => {
    fs.rmSync(FILE, { force: true });
    const now = Date.parse('2026-06-10T12:00:00Z');
    const day = 86400000;
    subs.subscribe('old', now - 5 * day);
    subs.subscribe('mid', now - 2 * day);
    subs.subscribe('new', now - 1 * day);
    const s = subs.series(7, now);
    expect(s).toHaveLength(7);
    expect(s[s.length - 1].count).toBeGreaterThanOrEqual(s[0].count); // non-decreasing
    expect(s[s.length - 1].count).toBe(3); // all three counted by the latest day
  });
});
