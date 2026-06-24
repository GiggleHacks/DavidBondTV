#!/usr/bin/env node
// One-off recovery: re-encode every video stuck in status 'failed' from its
// retained original. Drives the same startEncode() path the admin "Approve"
// action uses, but in-process so it needs no admin auth. Run with the local
// server STOPPED to avoid concurrent manifest writes:
//   node --env-file-if-exists=.env scripts/recover-failed.mjs
import fs from 'node:fs';
import { startEncode } from '../lib/ingest.mjs';
import { MANIFEST } from '../lib/paths.js';

const read = () => { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return []; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failed = read().filter((v) => v.status === 'failed');
if (!failed.length) { console.log('No failed videos to recover.'); process.exit(0); }

const ids = failed.map((v) => v.id);
console.log(`Recovering ${ids.length} failed video(s):`);
failed.forEach((v) => console.log(`  • ${v.title || v.id} (${v.id})`));

const r = await startEncode(ids);
console.log(`\nstartEncode queued ${r.count} of ${ids.length}.\n`);

const target = new Set(ids);
const TIMEOUT_MS = 30 * 60_000; // 30 min ceiling for all of them
const t0 = Date.now();
const done = new Map(); // id -> final status

while (done.size < target.size) {
  if (Date.now() - t0 > TIMEOUT_MS) { console.error('Timed out waiting for encodes.'); break; }
  await sleep(3000);
  const m = read();
  for (const id of target) {
    if (done.has(id)) continue;
    const e = m.find((x) => x.id === id);
    if (!e) continue;
    if (e.status === 'ready') { done.set(id, 'ready'); console.log(`  ✓ ready  ${e.title || id}`); }
    else if (e.status === 'failed') { done.set(id, 'failed'); console.log(`  ✗ FAILED ${e.title || id}`); }
  }
}

const ok = [...done.values()].filter((s) => s === 'ready').length;
const bad = [...done.values()].filter((s) => s === 'failed').length;
const stuck = target.size - done.size;
console.log(`\nDone: ${ok} ready, ${bad} failed, ${stuck} still in progress/unknown.`);
process.exit(bad || stuck ? 1 : 0);
