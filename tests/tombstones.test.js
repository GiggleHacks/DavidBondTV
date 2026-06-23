import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tomb from '../lib/tombstones.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'deleted-videos.json');

// Snapshot + restore the real store file so tests never clobber live data.
const had = fs.existsSync(FILE);
const saved = had ? fs.readFileSync(FILE, 'utf8') : null;
afterEach(() => {
  if (saved !== null) fs.writeFileSync(FILE, saved);
  else fs.rmSync(FILE, { force: true });
});

describe('tombstones store', () => {
  it('records deletions idempotently and lists them', () => {
    fs.rmSync(FILE, { force: true });
    expect(tomb.listDeletions()).toEqual([]);
    tomb.recordDeletion('a');
    tomb.recordDeletion('a'); // idempotent
    tomb.recordDeletion('b');
    expect(tomb.listDeletions().sort()).toEqual(['a', 'b']);
    expect(tomb.countDeletions()).toBe(2);
  });

  it('clears only the confirmed ids', () => {
    fs.rmSync(FILE, { force: true });
    tomb.recordDeletion('a');
    tomb.recordDeletion('b');
    tomb.recordDeletion('c');
    tomb.clearDeletions(['a', 'c']);
    expect(tomb.listDeletions()).toEqual(['b']);
  });

  it('ignores empty/invalid ids and no-op clears', () => {
    fs.rmSync(FILE, { force: true });
    tomb.recordDeletion('');
    tomb.recordDeletion(null);
    expect(tomb.listDeletions()).toEqual([]);
    tomb.clearDeletions(['nope']); // no throw, no change
    expect(tomb.listDeletions()).toEqual([]);
  });
});
