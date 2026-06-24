import { describe, expect, it } from 'vitest';
import { createRequestContext } from '../lib/request-context.mjs';

function req(headers = {}, url = '/watch?v=x') {
  return {
    url,
    socket: { remoteAddress: '10.0.0.5' },
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  };
}

function accounts(user = null) {
  return { currentUser: () => user };
}

describe('request context enrichment', () => {
  it('uses trusted Cloudflare city and coordinates for admin analytics', () => {
    const build = createRequestContext({
      geoip: { lookup: () => 'DE' },
      accounts: accounts({ id: 'u1', username: 'david', membership: { active: true } }),
      trustCloudflare: true,
    });

    const ctx = build(req({
      'cf-connecting-ip': '203.0.113.5',
      'cf-ipcountry': 'US',
      'cf-ipcity': 'Fresno',
      'cf-region': 'California',
      'cf-iplatitude': '36.7378',
      'cf-iplongitude': '-119.7871',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
      'sec-ch-ua-platform': '"Windows"',
      'sec-ch-ua-mobile': '?0',
    }));

    expect(ctx.ip).toBe('203.0.113.5');
    expect(ctx.country).toBe('US');
    expect(ctx.geo).toMatchObject({
      countryCode: 'US',
      city: 'Fresno',
      region: 'California',
      lat: 36.7378,
      lon: -119.7871,
    });
    expect(ctx.device).toMatchObject({ type: 'desktop', os: 'Windows', browser: 'Chrome' });
  });

  it('ignores Cloudflare location detail when Cloudflare is not trusted', () => {
    const build = createRequestContext({
      geoip: { lookup: () => 'DE' },
      accounts: accounts(null),
      trustCloudflare: false,
    });

    const ctx = build(req({
      'cf-ipcountry': 'US',
      'cf-ipcity': 'Fresno',
      'cf-iplatitude': '36.7378',
      'cf-iplongitude': '-119.7871',
      'user-agent': 'curl/8.0',
    }));

    expect(ctx.country).toBe('DE');
    expect(ctx.geo).toMatchObject({ countryCode: 'DE' });
    expect(ctx.geo.city).toBeNull();
    expect(ctx.geo.lat).toBeNull();
    expect(ctx.isBot).toBe(true);
  });
});
