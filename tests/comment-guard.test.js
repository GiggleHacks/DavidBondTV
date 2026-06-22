import { describe, it, expect } from 'vitest';
import {
  countLinks, normalizeText, contentVerdict, createCommentGuard, DEFAULT_BANNED,
} from '../lib/comment-guard.js';

const NOW = 1_000_000;
const member = { id: 'u1', verified: true, createdAt: NOW - 10 * 24 * 60 * 60 * 1000 }; // old, verified
const admin = { id: 'a1', verified: true, roles: ['admin'], createdAt: 0 };
const freshUser = { id: 'u2', verified: true, createdAt: NOW - 1000 }; // just created

describe('countLinks / normalizeText', () => {
  it('counts http and www links', () => {
    expect(countLinks('see https://a.com and www.b.com x')).toBe(2);
    expect(countLinks('no links here')).toBe(0);
  });
  it('normalizes case + whitespace', () => {
    expect(normalizeText('  Hi   THERE\nyou ')).toBe('hi there you');
  });
});

describe('contentVerdict', () => {
  it('blocks links for new/anon posters but allows for established', () => {
    expect(contentVerdict('check www.x.com', { allowLinks: false }).ok).toBe(false);
    expect(contentVerdict('check www.x.com', { allowLinks: true }).ok).toBe(true);
  });
  it('caps the number of links', () => {
    expect(contentVerdict('a https://1.com https://2.com https://3.com', { allowLinks: true, maxLinks: 2 }).ok).toBe(false);
  });
  it('has no banned words by default (feature opt-in)', () => {
    expect(DEFAULT_BANNED).toEqual([]);
    expect(contentVerdict('Buy CHEAP ViAgRa now').ok).toBe(true); // nothing blocked by default
  });
  it('blocks banned words when a list is supplied (case-insensitive)', () => {
    expect(contentVerdict('Buy CHEAP ViAgRa now', { banned: ['viagra'] }).ok).toBe(false);
    expect(contentVerdict('a normal comment', { banned: ['viagra'] }).ok).toBe(true);
  });
});

describe('createCommentGuard', () => {
  it('admins bypass everything', () => {
    const g = createCommentGuard({ now: () => NOW });
    expect(g.check({ user: admin, text: 'viagra https://1.com https://2.com https://3.com' }).ok).toBe(true);
  });

  it('detects duplicate text from the same author', () => {
    const g = createCommentGuard({ now: () => NOW });
    expect(g.check({ user: member, text: 'hello world' }).ok).toBe(true);
    const dup = g.check({ user: member, text: '  HELLO   world ' });
    expect(dup.ok).toBe(false);
    expect(dup.status).toBe(429);
  });

  it('blocks links from a brand-new account', () => {
    const g = createCommentGuard({ now: () => NOW });
    const r = g.check({ user: freshUser, text: 'visit www.spam.com' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('rate-limits a new account after newAccountMax distinct posts', () => {
    const g = createCommentGuard({ now: () => NOW, newAccountMax: 3 });
    for (let i = 0; i < 3; i++) {
      expect(g.check({ user: freshUser, text: `msg ${i}` }).ok).toBe(true);
    }
    const blocked = g.check({ user: freshUser, text: 'msg 4' });
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe(429);
  });

  it('allows GIF-only (empty text) comments through content/duplicate checks', () => {
    const g = createCommentGuard({ now: () => NOW });
    expect(g.check({ user: member, text: '' }).ok).toBe(true);
    expect(g.check({ user: member, text: '' }).ok).toBe(true); // empty isn't a "duplicate"
  });
});
