import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGeoGate } from '../lib/geo-gate.mjs';

let file;
beforeEach(() => {
  file = path.join(os.tmpdir(), `geo-rules-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
});
afterEach(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

describe('geo-gate evaluate', () => {
  it('blocks a normal visitor from a blocked country', () => {
    const gate = createGeoGate(file);
    const r = gate.evaluate({ country: 'TH', isAdmin: false, bypass: false });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('country');
  });

  it('never blocks an admin, even from a blocked country', () => {
    const gate = createGeoGate(file);
    // An admin who is NOT simulating has bypass=true (set in request-context).
    const r = gate.evaluate({ country: 'TH', isAdmin: true, bypass: true });
    expect(r.blocked).toBe(false);
  });

  it('shields an admin whose own IP / user-id is on a blocklist', async () => {
    const gate = createGeoGate(file);
    await gate.blockIp('5.6.7.8');
    await gate.blockUser('admin-1');
    const r = gate.evaluate({
      ip: '5.6.7.8', user: { id: 'admin-1' }, country: 'TH', isAdmin: true, bypass: true,
    });
    expect(r.blocked).toBe(false);
  });

  it('still blocks an admin while they actively simulate a blocked country', () => {
    const gate = createGeoGate(file);
    // Simulation sets bypass=false so the preview demonstrates the gate.
    const r = gate.evaluate({ country: 'TH', isAdmin: true, bypass: false });
    expect(r.blocked).toBe(true);
  });

  it('allows a visitor from a non-blocked country', () => {
    const gate = createGeoGate(file);
    const r = gate.evaluate({ country: 'US', isAdmin: false, bypass: false });
    expect(r.blocked).toBe(false);
  });

  it('allows everyone when geoblocking is disabled', async () => {
    const gate = createGeoGate(file);
    await gate.setEnabled(false);
    expect(gate.evaluate({ country: 'TH', isAdmin: false, bypass: false }).blocked).toBe(false);
  });
});
