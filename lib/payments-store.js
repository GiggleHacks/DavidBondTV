// Immutable-ish payment ledger, backed by data/payments.json. The user record
// (lib/users-store.js) holds the *current* membership state; this store holds the
// *history* — every Stripe invoice/event we acted on — plus the idempotency set
// that stops a redelivered webhook from being processed twice.
//
// Same persistence shape as lib/users-store.js: in-memory object, writes
// serialized through a promise chain so concurrent webhooks can't corrupt the
// whole-file rewrite.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function createPaymentsStore(filePath) {
  // { byUser: { uid: [txn,…] }, processedStripeEvents: { evtId: ts },
  //   processedWhopEvents: { webhookId: ts } }
  let data = { byUser: {}, processedStripeEvents: {}, processedWhopEvents: {} };
  let writeChain = Promise.resolve();

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = {
          byUser: parsed.byUser && typeof parsed.byUser === 'object' ? parsed.byUser : {},
          processedStripeEvents: parsed.processedStripeEvents && typeof parsed.processedStripeEvents === 'object'
            ? parsed.processedStripeEvents : {},
          processedWhopEvents: parsed.processedWhopEvents && typeof parsed.processedWhopEvents === 'object'
            ? parsed.processedWhopEvents : {},
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

  const clone = (v) => JSON.parse(JSON.stringify(v));

  return {
    /** Has this Stripe event id already been handled? (webhook idempotency) */
    isStripeEventProcessed(eventId) {
      return !!eventId && Object.prototype.hasOwnProperty.call(data.processedStripeEvents, eventId);
    },
    /** Mark a Stripe event id as handled. */
    async markStripeEvent(eventId, now = Date.now()) {
      if (!eventId) return;
      data.processedStripeEvents[eventId] = now;
      await persist();
    },
    /** Has this WHOP webhook-id already been handled? (webhook idempotency) */
    isWhopEventProcessed(eventId) {
      return !!eventId && Object.prototype.hasOwnProperty.call(data.processedWhopEvents, eventId);
    },
    /** Mark a WHOP webhook-id as handled. */
    async markWhopEvent(eventId, now = Date.now()) {
      if (!eventId) return;
      data.processedWhopEvents[eventId] = now;
      await persist();
    },
    /** Append a transaction record to a user's ledger. */
    async addTxn(userId, txn) {
      if (!userId) return;
      if (!Array.isArray(data.byUser[userId])) data.byUser[userId] = [];
      data.byUser[userId].push(txn);
      await persist();
    },
    /** A user's transactions, newest-first. */
    listForUser(userId) {
      const list = data.byUser[userId];
      return Array.isArray(list) ? clone(list).sort((a, b) => (b.ts || 0) - (a.ts || 0)) : [];
    },
    /** Wait for queued writes to flush (tests). */
    flush() {
      return writeChain;
    },
  };
}
