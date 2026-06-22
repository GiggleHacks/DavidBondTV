import { describe, it, expect } from 'vitest';
import {
  generateRecoveryPhrase, normalizePhrase, hashRecoveryPhrase, verifyRecoveryPhrase,
} from '../lib/recovery-key.js';
import { WORDLIST } from '../lib/wordlist-en.js';

describe('wordlist', () => {
  it('has exactly 2048 unique lowercase words', () => {
    expect(WORDLIST).toHaveLength(2048);
    expect(new Set(WORDLIST).size).toBe(2048);
    expect(WORDLIST.every((w) => /^[a-z]+$/.test(w))).toBe(true);
  });
});

describe('generateRecoveryPhrase', () => {
  it('returns 12 words, all from the wordlist', () => {
    const pool = new Set(WORDLIST);
    const words = generateRecoveryPhrase().split(' ');
    expect(words).toHaveLength(12);
    expect(words.every((w) => pool.has(w))).toBe(true);
  });

  it('is overwhelmingly unlikely to repeat (high entropy)', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(generateRecoveryPhrase());
    expect(seen.size).toBe(50);
  });
});

describe('normalizePhrase', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizePhrase('  Orbit   CABIN\ntrophy ')).toBe('orbit cabin trophy');
    expect(normalizePhrase(null)).toBe('');
    expect(normalizePhrase(undefined)).toBe('');
  });
});

describe('hash + verify', () => {
  it('verifies a phrase against its own hash', () => {
    const phrase = generateRecoveryPhrase();
    const hash = hashRecoveryPhrase(phrase);
    expect(verifyRecoveryPhrase(phrase, hash)).toBe(true);
  });

  it('accepts the same phrase with different casing/spacing', () => {
    const phrase = generateRecoveryPhrase();
    const hash = hashRecoveryPhrase(phrase);
    expect(verifyRecoveryPhrase(`  ${phrase.toUpperCase()}  `, hash)).toBe(true);
  });

  it('rejects a wrong phrase and a null hash', () => {
    const hash = hashRecoveryPhrase(generateRecoveryPhrase());
    expect(verifyRecoveryPhrase(generateRecoveryPhrase(), hash)).toBe(false);
    expect(verifyRecoveryPhrase('anything', null)).toBe(false);
    expect(verifyRecoveryPhrase('', hash)).toBe(false);
  });
});
