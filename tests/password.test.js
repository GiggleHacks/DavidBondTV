import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, validatePassword } from '../lib/password.js';

describe('password hashing', () => {
  it('hashes and verifies a correct password', () => {
    const stored = hashPassword('correct horse battery');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct horse battery', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('hunter2hunter2');
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('produces a unique salt per hash', () => {
    const a = hashPassword('samePassword1');
    const b = hashPassword('samePassword1');
    expect(a).not.toBe(b);
  });

  it('never throws on garbage input', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword(null, null)).toBe(false);
    expect(verifyPassword('x', 'scrypt$only-two')).toBe(false);
  });

  it('validates strength rules', () => {
    expect(validatePassword('abc').ok).toBe(false); // < 4 chars
    expect(validatePassword('abcd').ok).toBe(true); // 4 chars OK
    expect(validatePassword('x'.repeat(201)).ok).toBe(false);
  });
});
