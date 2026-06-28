import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { createIpGeo } from '../lib/ip-geo.js';

const tmp = () => path.join(os.tmpdir(), `ipgeo-${Math.random().toString(36).slice(2)}.json`);

describe('ip-geo lookup', () => {
  it('parses a successful provider response and caches it', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { json: async () => ({ status: 'success', countryCode: 'MY', country: 'Malaysia', regionName: 'Selangor', city: 'Petaling Jaya', lat: 3.1, lon: 101.6, isp: 'TM' }) }; };
    const geo = createIpGeo({ cacheFile: tmp(), fetchImpl });
    const a = await geo.lookup('58.27.98.75');
    expect(a).toMatchObject({ cc: 'MY', city: 'Petaling Jaya', region: 'Selangor', lat: 3.1, isp: 'TM' });
    const b = await geo.lookup('58.27.98.75');
    expect(b.city).toBe('Petaling Jaya');
    expect(calls).toBe(1); // second call served from cache
  });

  it('returns null (never throws) when the provider fails', async () => {
    const fetchImpl = async () => { throw new Error('network down'); };
    const geo = createIpGeo({ cacheFile: tmp(), fetchImpl });
    await expect(geo.lookup('8.8.8.8')).resolves.toBeNull();
  });

  it('skips private / loopback IPs without calling out', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { json: async () => ({ status: 'success' }) }; };
    const geo = createIpGeo({ cacheFile: tmp(), fetchImpl });
    expect(await geo.lookup('127.0.0.1')).toBeNull();
    expect(await geo.lookup('192.168.1.5')).toBeNull();
    expect(await geo.lookup('')).toBeNull();
    expect(calls).toBe(0);
  });

  it('honors enabled:false', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { json: async () => ({ status: 'success', countryCode: 'US' }) }; };
    const geo = createIpGeo({ cacheFile: tmp(), fetchImpl, enabled: false });
    expect(await geo.lookup('8.8.8.8')).toBeNull();
    expect(calls).toBe(0);
  });
});
