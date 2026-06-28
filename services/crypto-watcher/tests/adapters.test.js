import { describe, it, expect } from 'vitest';
import { makeLtcEsploraAdapter, findIncomingTx } from '../lib/adapters.mjs';

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

describe('findIncomingTx', () => {
  const A = '0xF79bDf638dAA104e4975aF4B5f23eEc486bc24bb';
  const wei = (eth) => BigInt(Math.round(eth * 1e6)) * 10n ** 12n; // eth->wei via 6-dp
  const blk = (txs) => ({ transactions: txs });
  it('matches an incoming tx to the address (case-insensitive) with enough value', () => {
    const r = findIncomingTx(blk([{ to: A.toLowerCase(), value: '0x' + wei(0.05).toString(16), hash: '0xaa' }]), A, wei(0.05));
    expect(r).toMatchObject({ txid: '0xaa', enough: true });
  });
  it('detects a SELF-SEND (from === to === address) — the bug balance-delta missed', () => {
    const v = '0x' + wei(0.05).toString(16);
    const r = findIncomingTx(blk([{ from: A, to: A, value: v, hash: '0xself' }]), A, wei(0.05));
    expect(r).toMatchObject({ txid: '0xself', enough: true });
  });
  it('flags a short payment as not-enough', () => {
    const r = findIncomingTx(blk([{ to: A, value: '0x' + wei(0.03).toString(16), hash: '0xbb' }]), A, wei(0.05));
    expect(r).toMatchObject({ txid: '0xbb', enough: false });
  });
  it('ignores txs to other addresses and zero-value txs', () => {
    expect(findIncomingTx(blk([{ to: '0xother', value: '0x' + wei(1).toString(16), hash: '0xcc' }]), A, wei(0.05))).toBeNull();
    expect(findIncomingTx(blk([{ to: A, value: '0x0', hash: '0xdd' }]), A, wei(0.05))).toBeNull();
  });
});
