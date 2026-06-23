import { describe, it, expect } from 'vitest';
import { verifyBearerSecret } from '../lib/admin-auth.js';

const reqWith = (auth) => ({ headers: auth == null ? {} : { authorization: auth } });

describe('verifyBearerSecret', () => {
  const SECRET = 'super-secret-token-value';

  it('accepts a matching Bearer token', () => {
    expect(verifyBearerSecret(SECRET, reqWith(`Bearer ${SECRET}`))).toBe(true);
  });

  it('rejects a mismatched token', () => {
    expect(verifyBearerSecret(SECRET, reqWith('Bearer nope'))).toBe(false);
  });

  it('rejects when the server secret is unset (sync disabled)', () => {
    expect(verifyBearerSecret('', reqWith('Bearer anything'))).toBe(false);
  });

  it('rejects a malformed / missing Authorization header', () => {
    expect(verifyBearerSecret(SECRET, reqWith('Token abc'))).toBe(false);
    expect(verifyBearerSecret(SECRET, reqWith(undefined))).toBe(false);
    expect(verifyBearerSecret(SECRET, {})).toBe(false);
  });
});
