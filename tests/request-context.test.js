import { describe, expect, it } from 'vitest';
import { createRequestContext, isBotUa } from '../lib/request-context.mjs';

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

describe('bot detection', () => {
  it('isBotUa flags crawlers, AI bots, named automation, and empty UAs; passes real browsers', () => {
    const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
    expect(isBotUa('')).toBe(true);
    expect(isBotUa(undefined)).toBe(true);
    expect(isBotUa('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe(true);
    expect(isBotUa('GPTBot/1.0')).toBe(true);
    expect(isBotUa('Mozilla/5.0 (compatible; ClaudeBot/1.0)')).toBe(true);
    // Named automation agents are still flagged…
    expect(isBotUa('Mozilla/5.0 puppeteer')).toBe(true);
    expect(isBotUa('python-requests/2.31')).toBe(true);
    // …but the broad `headless` token was intentionally removed: it matched the
    // in-app preview browser and ambiguous UAs, silently dropping real visitors.
    expect(isBotUa('HeadlessChrome/126.0')).toBe(false);
    expect(isBotUa(CHROME)).toBe(false);
  });

  it('honors the Cloudflare bot-score header when present (low score = bot)', () => {
    const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
    const build = createRequestContext({ geoip: { lookup: () => null }, accounts: accounts(null), trustCloudflare: true });
    expect(build(req({ 'user-agent': CHROME, 'cf-bot-score': '5' })).isBot).toBe(true);   // low → bot
    expect(build(req({ 'user-agent': CHROME, 'cf-bot-score': '95' })).isBot).toBe(false); // high → human
    expect(build(req({ 'user-agent': CHROME, 'cf-verified-bot': 'true' })).isBot).toBe(true);
    expect(build(req({ 'user-agent': CHROME })).isBot).toBe(false); // no header → UA decides
  });
});
