import { describe, it, expect } from 'vitest';
import { contentType, parseRange, withSecurityHeaders } from '../lib/http-util.js';

describe('contentType', () => {
  it('maps streaming types', () => {
    expect(contentType('/x/master.m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(contentType('/x/seg_001.ts')).toBe('video/mp2t');
  });
  it('maps web + image types', () => {
    expect(contentType('/index.html')).toBe('text/html; charset=utf-8');
    expect(contentType('/js/player.js')).toBe('text/javascript; charset=utf-8');
    expect(contentType('/storyboard/sprite-1.jpg')).toBe('image/jpeg');
    expect(contentType('/storyboard.json')).toBe('application/json; charset=utf-8');
  });
  it('falls back to octet-stream', () => {
    expect(contentType('/file.unknown')).toBe('application/octet-stream');
  });
});

describe('parseRange', () => {
  it('returns null without a header', () => expect(parseRange(undefined, 1000)).toBeNull());
  it('parses a closed range', () => expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 }));
  it('parses an open-ended range', () => expect(parseRange('bytes=100-', 1000)).toEqual({ start: 100, end: 999 }));
  it('parses a suffix range', () => expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 }));
  it('clamps end to file size', () => expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 }));
  it('flags an unsatisfiable range', () => expect(parseRange('bytes=2000-', 1000)).toEqual({ invalid: true }));
  it('returns null on malformed input', () => expect(parseRange('rows=0-9', 1000)).toBeNull());
});

describe('withSecurityHeaders', () => {
  it('adds baseline browser hardening headers', () => {
    expect(withSecurityHeaders({})).toMatchObject({
      'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
  });

  it('asserts HSTS so browsers stay on HTTPS', () => {
    expect(withSecurityHeaders({})['Strict-Transport-Security']).toMatch(/^max-age=\d+/);
  });

  it('preserves explicit response headers', () => {
    expect(withSecurityHeaders({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN' })).toMatchObject({
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'SAMEORIGIN',
      'X-Content-Type-Options': 'nosniff',
    });
  });
});
