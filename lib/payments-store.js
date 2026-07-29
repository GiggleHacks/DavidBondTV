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
  //   processedWhopEvents: { webhookId: ts }, unresolvedPayments: [rec,…],
  //   pendingWhopCheckouts: { "<planId>:<uid>": rec } }
  let data = {
    byUser: {}, processedStripeEvents: {}, processedWhopEvents: {},
    unresolvedPayments: [], pendingWhopCheckouts: {},
  };
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
          // Added later — an existing payments.json simply has no key yet.
          unresolvedPayments: Array.isArray(parsed.unresolvedPayments) ? parsed.unresolvedPayments : [],
          pendingWhopCheckouts: parsed.pendingWhopCheckouts && typeof parsed.pendingWhopCheckouts === 'object'
            ? parsed.pendingWhopCheckouts : {},
        };
      }
    } catch { /* missing/corrupt → defaults */ }
  }
  load();

  // Cap the attention list so a stuck loop can't grow the ledger without bound.
  const MAX_UNRESOLVED = 200;

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
    /**
     * Record a "money moved but access didn't" case so it survives a restart and a
     * failed Telegram send. These used to be console.error only, which meant a paid
     * buyer with no access left no trace anyone would ever look at.
     */
    async addUnresolvedPayment(rec, now = Date.now()) {
      if (!rec || !rec.kind) return null;
      const entry = { id: `unr_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`, ts: now, resolvedAt: null, ...rec };
      data.unresolvedPayments.push(entry);
      if (data.unresolvedPayments.length > MAX_UNRESOLVED) {
        data.unresolvedPayments = data.unresolvedPayments.slice(-MAX_UNRESOLVED);
      }
      await persist();
      return clone(entry);
    },
    /**
     * Remember that this user was sent to WHOP to buy `planId`. The degraded
     * checkout fallback loses metadata AND the redirect_url, so when its webhook
     * arrives the only identifying field is the buyer's WHOP email — which may not
     * be the email on their site account. This record is the bridge.
     */
    async addPendingWhopCheckout({ userId, planId, productId = null, email = null, degraded = false }, now = Date.now()) {
      if (!userId || !planId) return null;
      const key = `${planId}:${userId}`;
      data.pendingWhopCheckouts[key] = {
        key, userId, planId, productId,
        email: email ? String(email).toLowerCase() : null,
        degraded: !!degraded, ts: now,
      };
      await persist();
      return clone(data.pendingWhopCheckouts[key]);
    },
    /**
     * Find whose checkout an unattributable WHOP event belongs to.
     *
     * Email match wins. Failing that, a SINGLE live pending record for that plan is
     * unambiguous enough to use. Two or more and we return null rather than guess —
     * granting the wrong person is worse than making David resolve it by hand.
     */
    findPendingWhopCheckout({ planId, email = null } = {}, { ttlMs = 24 * 60 * 60_000, now = Date.now() } = {}) {
      if (!planId) return null;
      const live = Object.values(data.pendingWhopCheckouts)
        .filter((r) => r.planId === planId && now - r.ts < ttlMs);
      if (!live.length) return null;
      const wanted = email ? String(email).toLowerCase() : null;
      const byEmail = wanted ? live.find((r) => r.email === wanted) : null;
      if (byEmail) return clone(byEmail);
      return live.length === 1 ? clone(live[0]) : null;
    },
    listPendingWhopCheckouts({ ttlMs = 24 * 60 * 60_000, now = Date.now() } = {}) {
      return clone(Object.values(data.pendingWhopCheckouts).filter((r) => now - r.ts < ttlMs))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    },
    /** Drop a pending record once its sale landed (or it aged out). */
    async clearPendingWhopCheckout(key) {
      if (!key || !data.pendingWhopCheckouts[key]) return false;
      delete data.pendingWhopCheckouts[key];
      await persist();
      return true;
    },
    /** Attention list, newest-first. `openOnly` hides ones already dealt with. */
    listUnresolvedPayments({ openOnly = false } = {}) {
      const list = data.unresolvedPayments.filter((r) => (openOnly ? !r.resolvedAt : true));
      return clone(list).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    },
    /** Mark an attention item handled (admin granted access / refunded). */
    async resolveUnresolvedPayment(id, now = Date.now()) {
      const rec = data.unresolvedPayments.find((r) => r.id === id);
      if (!rec || rec.resolvedAt) return false;
      rec.resolvedAt = now;
      await persist();
      return true;
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
