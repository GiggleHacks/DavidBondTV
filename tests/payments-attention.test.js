// The "money moved but access didn't unlock" list. Before this existed those cases
// were console.error only, so a buyer sitting on a charge with no access left no
// trace anyone would ever look at — and a failed Telegram send erased it entirely.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPaymentsStore } from '../lib/payments-store.js';

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtv-pay-'));
  file = path.join(dir, 'payments.json');
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('payments store — unresolved payments', () => {
  it('records an unresolved payment and lists it newest-first', async () => {
    const s = createPaymentsStore(file);
    await s.addUnresolvedPayment({ kind: 'whop.grant.unresolvable', email: 'a@b.c' }, 1000);
    await s.addUnresolvedPayment({ kind: 'crypto.underpaid', reference: 'cry_1' }, 2000);
    await s.flush();
    const list = s.listUnresolvedPayments();
    expect(list.map((r) => r.kind)).toEqual(['crypto.underpaid', 'whop.grant.unresolvable']);
    expect(list[0].resolvedAt).toBeNull();
    expect(list[0].id).toBeTruthy();
  });

  it('ignores a record with no kind', async () => {
    const s = createPaymentsStore(file);
    expect(await s.addUnresolvedPayment({ email: 'a@b.c' })).toBeNull();
    expect(s.listUnresolvedPayments()).toHaveLength(0);
  });

  it('resolves once and only once', async () => {
    const s = createPaymentsStore(file);
    const rec = await s.addUnresolvedPayment({ kind: 'whop.grant.lost' });
    expect(await s.resolveUnresolvedPayment(rec.id)).toBe(true);
    expect(await s.resolveUnresolvedPayment(rec.id)).toBe(false);   // already handled
    expect(await s.resolveUnresolvedPayment('unr_nope')).toBe(false);
    expect(s.listUnresolvedPayments({ openOnly: true })).toHaveLength(0);
    expect(s.listUnresolvedPayments()).toHaveLength(1);
  });

  it('survives a reload — the whole point of not using console.error', async () => {
    const s1 = createPaymentsStore(file);
    await s1.addUnresolvedPayment({ kind: 'crypto.grant.stuck', reference: 'cry_9' });
    await s1.flush();
    const s2 = createPaymentsStore(file);
    expect(s2.listUnresolvedPayments().map((r) => r.reference)).toEqual(['cry_9']);
  });

  it('loads an existing ledger that predates the field, without dropping data', async () => {
    fs.writeFileSync(file, JSON.stringify({
      byUser: { u1: [{ kind: 'whop.membership.paid', ts: 1 }] },
      processedWhopEvents: { msg_1: 1 },
    }), 'utf8');
    const s = createPaymentsStore(file);
    expect(s.listUnresolvedPayments()).toEqual([]);
    expect(s.listForUser('u1')).toHaveLength(1);
    expect(s.isWhopEventProcessed('msg_1')).toBe(true);
    // And it can take new records on top.
    await s.addUnresolvedPayment({ kind: 'whop.grant.lost' });
    expect(s.listUnresolvedPayments()).toHaveLength(1);
  });

  it('caps the list so a stuck loop cannot grow the ledger without bound', async () => {
    const s = createPaymentsStore(file);
    for (let i = 0; i < 210; i++) await s.addUnresolvedPayment({ kind: 'crypto.underpaid', reference: `r${i}` });
    const list = s.listUnresolvedPayments();
    expect(list).toHaveLength(200);
    // Oldest dropped, newest kept.
    expect(list.some((r) => r.reference === 'r209')).toBe(true);
    expect(list.some((r) => r.reference === 'r0')).toBe(false);
  });
});
