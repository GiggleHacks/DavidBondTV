import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGeoip, ipv6ToBigInt } from '../lib/geoip.js';

let file;
beforeAll(() => {
  file = path.join(os.tmpdir(), `geoip-${crypto.randomUUID()}.json`);
  // 8.8.8.0/24 -> US ; 1.1.1.0/24 -> AU ; an IPv6 block -> DE
  const v4 = [
    [ipv4(1, 1, 1, 0), ipv4(1, 1, 1, 255), 'AU'],
    [ipv4(8, 8, 8, 0), ipv4(8, 8, 8, 255), 'US'],
  ].sort((a, b) => a[0] - b[0]);
  const start6 = ipv6ToBigInt('2a02:8000::');
  const end6 = start6 + (1n << 96n) - 1n;
  const v6 = [[start6.toString(), end6.toString(), 'DE']];
  fs.writeFileSync(file, JSON.stringify({ v4, v6 }), 'utf8');
});
afterAll(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

function ipv4(a, b, c, d) { return ((a * 256 + b) * 256 + c) * 256 + d; }

describe('geoip', () => {
  it('resolves IPv4 addresses', () => {
    const g = createGeoip(file);
    expect(g.lookup('8.8.8.8')).toBe('US');
    expect(g.lookup('1.1.1.42')).toBe('AU');
  });

  it('returns null for unknown / loopback / garbage', () => {
    const g = createGeoip(file);
    expect(g.lookup('203.0.113.5')).toBe(null);
    expect(g.lookup('127.0.0.1')).toBe(null);
    expect(g.lookup('not-an-ip')).toBe(null);
    expect(g.lookup('')).toBe(null);
  });

  it('unwraps IPv4-mapped IPv6 addresses', () => {
    const g = createGeoip(file);
    expect(g.lookup('::ffff:8.8.8.8')).toBe('US');
  });

  it('resolves IPv6 addresses', () => {
    const g = createGeoip(file);
    expect(g.lookup('2a02:8000::1')).toBe('DE');
  });

  it('degrades gracefully when data file is missing', () => {
    const g = createGeoip(path.join(os.tmpdir(), 'does-not-exist.json'));
    expect(g.loaded()).toBe(false);
    expect(g.lookup('8.8.8.8')).toBe(null);
  });
});
