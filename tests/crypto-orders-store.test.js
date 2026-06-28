import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCryptoOrdersStore } from '../lib/crypto-orders-store.js';

function tmpFile() {
  return path.join(os.tmpdir(), `crypto-orders-${crypto.randomUUID()}.json`);
}

describe('crypto-orders-store', () => {
  it('creates, reads, and updates an order', async () => {
    const s = createCryptoOrdersStore(tmpFile());
    const o = await s.create({ id: 'o1', userId: 'u1', kind: 'product', productId: 'p1', coin: 'ETH', amount: '0.05', status: 'waiting' });
    expect(o.id).toBe('o1');
    expect(s.get('o1').status).toBe('waiting');
    await s.update('o1', { status: 'confirmed', txid: '0xabc' });
    expect(s.get('o1').status).toBe('confirmed');
    expect(s.get('o1').txid).toBe('0xabc');
    await s.flush();
  });

  it('de-dupes callbacks by orderId', async () => {
    const s = createCryptoOrdersStore(tmpFile());
    expect(s.isCallbackProcessed('o1')).toBe(false);
    await s.markCallback('o1');
    expect(s.isCallbackProcessed('o1')).toBe(true);
    await s.flush();
  });

  it('lists open (waiting) orders for sweeping', async () => {
    const s = createCryptoOrdersStore(tmpFile());
    await s.create({ id: 'a', status: 'waiting', expiresAt: 1 });
    await s.create({ id: 'b', status: 'granted', expiresAt: 1 });
    expect(s.listOpen().map((o) => o.id)).toEqual(['a']);
    await s.flush();
  });
});
