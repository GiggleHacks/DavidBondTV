// Crypto order ledger, backed by data/crypto-orders.json. Same persistence shape
// as lib/payments-store.js: in-memory object, writes serialized through a promise
// chain so concurrent callbacks can't corrupt the whole-file rewrite. Holds the
// per-order callback idempotency set (mirrors processedStripeEvents).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function createCryptoOrdersStore(filePath) {
  let data = { orders: {}, processedCallbacks: {} };
  let writeChain = Promise.resolve();

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = {
          orders: parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {},
          processedCallbacks: parsed.processedCallbacks && typeof parsed.processedCallbacks === 'object'
            ? parsed.processedCallbacks : {},
        };
      }
    } catch { /* missing/corrupt → defaults */ }
  }
  load();

  function persist() {
    writeChain = writeChain
      .then(async () => {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
      })
      .catch(() => {});
    return writeChain;
  }

  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

  return {
    async create(order) {
      data.orders[order.id] = { ...order };
      await persist();
      return clone(data.orders[order.id]);
    },
    get(id) { return clone(data.orders[id]); },
    async update(id, patch) {
      const o = data.orders[id];
      if (!o) return null;
      Object.assign(o, patch, { updatedAt: patch.updatedAt ?? o.updatedAt });
      await persist();
      return clone(o);
    },
    listOpen() {
      return Object.values(data.orders).filter((o) => o.status === 'waiting').map(clone);
    },
    /**
     * The user's current in-flight order for resuming a closed checkout page.
     * In-flight = detected/confirmed (payment seen — valid even past the window),
     * or waiting within its expiry. Newest wins. null if none.
     */
    findActiveByUser(userId, nowTs = Date.now()) {
      const inFlight = (o) => o.status === 'detected' || o.status === 'confirmed'
        || (o.status === 'waiting' && (!o.expiresAt || nowTs <= o.expiresAt));
      const mine = Object.values(data.orders).filter((o) => o.userId === userId && inFlight(o));
      if (!mine.length) return null;
      mine.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return clone(mine[0]);
    },
    isCallbackProcessed(id) {
      return !!id && Object.prototype.hasOwnProperty.call(data.processedCallbacks, id);
    },
    async markCallback(id, now = Date.now()) {
      if (!id) return;
      data.processedCallbacks[id] = now;
      await persist();
    },
    flush() { return writeChain; },
  };
}
