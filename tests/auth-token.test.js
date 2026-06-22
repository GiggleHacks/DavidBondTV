import { describe, it, expect } from 'vitest';
import { createToken, verifyToken } from '../lib/auth-token.js';

const SECRET = 'test-secret';

describe('auth-token', () => {
  it('round-trips a payload', () => {
    const t = createToken(SECRET, { purpose: 'verify', userId: 'u1' }, 60_000, 1000);
    const p = verifyToken(SECRET, t, 2000);
    expect(p).toEqual({ purpose: 'verify', userId: 'u1' });
  });

  it('rejects an expired token', () => {
    const t = createToken(SECRET, { userId: 'u1' }, 1000, 1000);
    expect(verifyToken(SECRET, t, 5000)).toBe(null);
  });

  it('rejects a tampered payload', () => {
    const t = createToken(SECRET, { userId: 'u1' }, 60_000, 1000);
    const [b64] = t.split('.');
    const forged = `${b64}xx.${t.split('.')[1]}`;
    expect(verifyToken(SECRET, forged, 2000)).toBe(null);
  });

  it('rejects a wrong secret', () => {
    const t = createToken(SECRET, { userId: 'u1' }, 60_000, 1000);
    expect(verifyToken('other-secret', t, 2000)).toBe(null);
  });

  it('never throws on garbage', () => {
    expect(verifyToken(SECRET, 'garbage', 2000)).toBe(null);
    expect(verifyToken(SECRET, '', 2000)).toBe(null);
    expect(verifyToken(SECRET, null, 2000)).toBe(null);
  });
});
