import { describe, it, expect } from 'vitest';
import { createChallenge, verifyChallenge } from '../lib/challenge.js';

const SECRET = 'test-secret-abc123';

describe('createChallenge', () => {
  it('returns question, token, and answer', () => {
    const { question, token, answer } = createChallenge(SECRET);
    expect(question).toMatch(/^What is \d \+ \d\?$/);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(10);
    expect(typeof answer).toBe('number');
    expect(answer).toBeGreaterThanOrEqual(2);
    expect(answer).toBeLessThanOrEqual(18);
  });
});

describe('verifyChallenge', () => {
  it('returns true for correct answer with fresh token', () => {
    const now = Date.now();
    const { token, answer } = createChallenge(SECRET, now);
    expect(verifyChallenge(SECRET, token, answer, now)).toBe(true);
  });

  it('returns false for wrong answer', () => {
    const now = Date.now();
    const { token, answer } = createChallenge(SECRET, now);
    expect(verifyChallenge(SECRET, token, answer + 1, now)).toBe(false);
  });

  it('returns false for expired token', () => {
    const now = Date.now();
    const { token, answer } = createChallenge(SECRET, now);
    const future = now + 11 * 60 * 1000; // 11 minutes later
    expect(verifyChallenge(SECRET, token, answer, future)).toBe(false);
  });

  it('returns false for tampered token', () => {
    const now = Date.now();
    const { token, answer } = createChallenge(SECRET, now);
    // Flip a character in the middle of the token
    const tampered = token.slice(0, 10) + (token[10] === 'a' ? 'b' : 'a') + token.slice(11);
    expect(verifyChallenge(SECRET, tampered, answer, now)).toBe(false);
  });

  it('returns false for garbage token', () => {
    expect(verifyChallenge(SECRET, 'garbage!!!', 5, Date.now())).toBe(false);
  });

  it('returns false for empty token', () => {
    expect(verifyChallenge(SECRET, '', 5, Date.now())).toBe(false);
  });

  it('returns false for null/undefined token', () => {
    expect(verifyChallenge(SECRET, null, 5, Date.now())).toBe(false);
    expect(verifyChallenge(SECRET, undefined, 5, Date.now())).toBe(false);
  });
});
