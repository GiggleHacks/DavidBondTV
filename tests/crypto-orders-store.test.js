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

  describe('findActiveByUser (resume an in-progress order)', () => {
    it('returns the most recent in-flight order for the user', async () => {
      const s = createCryptoOrdersStore(tmpFile());
      const NOW = 1_000_000;
      await s.create({ id: 'old', userId: 'u1', status: 'waiting', createdAt: 100, expiresAt: NOW + 1000 });
      await s.create({ id: 'new', userId: 'u1', status: 'waiting', createdAt: 200, expiresAt: NOW + 1000 });
      expect(s.findActiveByUser('u1', NOW).id).toBe('new');
      await s.flush();
    });

    it('treats detected/confirmed as in-flight even past expiry; ignores granted/expired-waiting', async () => {
      const s = createCryptoOrdersStore(tmpFile());
      const NOW = 1_000_000;
      await s.create({ id: 'granted', userId: 'u1', status: 'granted', createdAt: 500, expiresAt: NOW + 1000 });
      await s.create({ id: 'staleWait', userId: 'u1', status: 'waiting', createdAt: 400, expiresAt: NOW - 1 });
      await s.create({ id: 'detectedLate', userId: 'u1', status: 'detected', createdAt: 300, expiresAt: NOW - 1 });
      expect(s.findActiveByUser('u1', NOW).id).toBe('detectedLate');
      await s.flush();
    });

    it('returns null when the user has no in-flight order, and never another user’s', async () => {
      const s = createCryptoOrdersStore(tmpFile());
      const NOW = 1_000_000;
      await s.create({ id: 'other', userId: 'u2', status: 'waiting', createdAt: 100, expiresAt: NOW + 1000 });
      expect(s.findActiveByUser('u1', NOW)).toBe(null);
      await s.flush();
    });
  });
});
