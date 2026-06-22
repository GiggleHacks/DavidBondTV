import { describe, it, expect } from 'vitest';
import { parseCookies, serializeCookie } from '../lib/cookies.js';

describe('parseCookies', () => {
  it('parses multiple cookies', () => {
    expect(parseCookies('a=1; b=2; sid=abc')).toEqual({ a: '1', b: '2', sid: 'abc' });
  });
  it('url-decodes values', () => {
    expect(parseCookies('x=a%20b')).toEqual({ x: 'a b' });
  });
  it('returns {} for empty/missing header', () => {
    expect(parseCookies('')).toEqual({});
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe('serializeCookie', () => {
  it('builds an httpOnly session cookie', () => {
    const c = serializeCookie('sid', 'tok', { httpOnly: true, maxAge: 3600 });
    expect(c).toContain('sid=tok');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Max-Age=3600');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
  });
  it('adds Secure when requested', () => {
    expect(serializeCookie('a', 'b', { secure: true })).toContain('Secure');
  });
});
