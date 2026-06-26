import { describe, it, expect } from 'vitest';
import { makeLtcEsploraAdapter } from '../lib/adapters.mjs';

describe('makeLtcEsploraAdapter', () => {
  const addr = 'ltc1qexampleaddress';
  // tip=100; tx1 at height 99 → 2 conf; tx2 at height 96 → 5 conf; tx3 in mempool → 0 conf.
  function fakeFetch(url) {
    if (url.endsWith('/blocks/tip/height')) return { ok: true, json: async () => 100 };
    if (url.includes(`/address/${addr}/txs`)) {
      return { ok: true, json: async () => ([
        { status: { confirmed: true, block_height: 99 }, vout: [
          { scriptpubkey_address: addr, value: 5000000 },     // 0.05 LTC to us
          { scriptpubkey_address: 'ltc1qother', value: 1 },   // change to someone else — ignored
        ] },
        { status: { confirmed: true, block_height: 96 }, vout: [
          { scriptpubkey_address: addr, value: 3000000 },     // 0.03 LTC to us
        ] },
        { status: { confirmed: false }, vout: [
          { scriptpubkey_address: addr, value: 9999 },         // unconfirmed — excluded
        ] },
      ]) };
    }
    throw new Error(`unexpected url ${url}`);
  }

  it('reports 8 decimals (litoshi)', () => {
    expect(makeLtcEsploraAdapter({ fetchImpl: fakeFetch }).decimals).toBe(8);
  });

  it('sums confirmed outputs to the address at >= 1 conf (litoshi), ignoring others/mempool', async () => {
    const a = makeLtcEsploraAdapter({ baseUrl: 'https://x/api', fetchImpl: fakeFetch });
    expect(await a.getReceived(addr, 1)).toBe(8000000n); // 5,000,000 + 3,000,000
  });

  it('respects minconf: only the deeper tx counts at >= 3 conf', async () => {
    const a = makeLtcEsploraAdapter({ baseUrl: 'https://x/api', fetchImpl: fakeFetch });
    expect(await a.getReceived(addr, 3)).toBe(3000000n); // only the 5-conf tx
  });

  it('throws on a non-OK explorer response', async () => {
    const a = makeLtcEsploraAdapter({ fetchImpl: async () => ({ ok: false, status: 503 }) });
    await expect(a.getReceived(addr, 1)).rejects.toThrow(/503/);
  });
});
