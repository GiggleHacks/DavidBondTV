// Server-authority merge: a local→server publish must never revert a visibility
// (Free/Premium) edit made on the live admin. Isolates the manifest in a temp
// CONTENT_DIR (set BEFORE importing ingest, since paths.js reads these env vars at
// module load) so we never touch real content.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtv-merge-'));
process.env.CONTENT_DIR = TMP;
process.env.MEDIA_DIR = path.join(TMP, 'media');

const { mergeManifestEntry } = await import('../lib/ingest.mjs');
const { MANIFEST } = await import('../lib/paths.js');

const seed = (entries) => {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(entries, null, 2));
};
const read = () => JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
const byId = (id) => read().find((e) => e.id === id);

beforeEach(() => seed([]));

describe('mergeManifestEntry — live server owns visibility', () => {
  it('keeps the server visibility when a deploy pushes a different one', async () => {
    seed([{ id: 'a', title: 'Old', visibility: 'premium', status: 'ready', published: true }]);
    // Local still has this video as free with an edited title.
    await mergeManifestEntry({ id: 'a', title: 'New', visibility: 'free', status: 'ready', published: true });
    const e = byId('a');
    expect(e.visibility).toBe('premium'); // server wins
    expect(e.title).toBe('New');          // other fields still follow local
  });

  it('uses the local visibility for a brand-new video (no server entry yet)', async () => {
    await mergeManifestEntry({ id: 'z', title: 'Fresh', visibility: 'premium', status: 'ready', published: true });
    expect(byId('z').visibility).toBe('premium');
  });
});
