// Records local video deletions so the next "Publish to server" can propagate
// them. We track only the ids the admin explicitly deleted locally — never a
// blanket "anything not local" — so videos that live on the server for other
// reasons (e.g. uploaded directly from a phone) are NEVER touched. Tombstones
// are cleared once the server confirms the deletion.
//
// Backed by data/deleted-videos.json: { "<videoId>": <deletedAt ms>, ... }.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';

const FILE = path.join(ROOT, 'data', 'deleted-videos.json');

function read() {
  try {
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch { /* missing/corrupt */ }
  return {};
}
function write(o) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(o, null, 2));
}

/** Record that `id` was deleted locally (idempotent). `now` injectable for tests. */
export function recordDeletion(id, now = Date.now()) {
  if (!id || typeof id !== 'string') return;
  const o = read();
  if (o[id] == null) { o[id] = now; write(o); }
}

/** All pending deleted-video ids awaiting propagation. */
export function listDeletions() {
  return Object.keys(read());
}

/** Forget tombstones the server has confirmed deleted. */
export function clearDeletions(ids) {
  const o = read();
  let changed = false;
  for (const id of ids || []) {
    if (o[id] != null) { delete o[id]; changed = true; }
  }
  if (changed) write(o);
}

export function countDeletions() {
  return Object.keys(read()).length;
}
