// Draft-by-default uploads + review-mode moderation actions.
// Isolates the manifest in a temp CONTENT_DIR (set BEFORE importing ingest, since
// paths.js reads these env vars at module load) so we never touch real content.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtv-review-'));
process.env.CONTENT_DIR = TMP;
process.env.MEDIA_DIR = path.join(TMP, 'media');

const { bulkAction, releaseScheduled, enqueue } = await import('../lib/ingest.mjs');
const { MANIFEST } = await import('../lib/paths.js');

const seed = (entries) => {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(entries, null, 2));
};
const read = () => JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
const byId = (id) => read().find((e) => e.id === id);
const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(() => seed([]));

describe('draft-by-default uploads', () => {
  it('a new upload lands as an unapproved, unpublished draft', async () => {
    // enqueue inserts the manifest entry via the async manifest lock, then kicks
    // off processing (which only ever touches `status`, never published/approval).
    const { manifestId } = enqueue(path.join(TMP, 'media', 'nope.mp4'), 'My Video');
    await waitFor(() => !!byId(manifestId));
    const e = byId(manifestId);
    expect(e.published).toBe(false);
    expect(e.approval).toBe('unapproved');
  });
});

describe('bulkAction approval flags', () => {
  it('approve / unapprove toggle approval without publishing', async () => {
    seed([{ id: 'a', published: false, approval: 'unapproved', status: 'ready' }]);
    await bulkAction(['a'], 'approve');
    expect(byId('a').approval).toBe('approved');
    expect(byId('a').published).toBe(false); // approving never makes a video live
    await bulkAction(['a'], 'unapprove');
    expect(byId('a').approval).toBe('unapproved');
  });

  it('publish marks the video live AND approved (never left unapproved)', async () => {
    seed([{ id: 'b', published: false, approval: 'unapproved', status: 'ready' }]);
    await bulkAction(['b'], 'publish');
    const e = byId('b');
    expect(e.published).toBe(true);
    expect(e.approval).toBe('approved');
    expect(e.publishAt).toBe(null); // a manual publish cancels any pending drip
  });
});

describe('releaseScheduled honors approval', () => {
  it('releases an approved due draft but not an unapproved one', async () => {
    const past = 1; // a publishAt firmly in the past
    seed([
      { id: 'u', published: false, approval: 'unapproved', status: 'ready', publishAt: past },
      { id: 'ap', published: false, approval: 'approved', status: 'ready', publishAt: past },
    ]);
    const due = await releaseScheduled();
    const ids = due.map((d) => d.id);
    expect(ids).toContain('ap');
    expect(ids).not.toContain('u');
    expect(byId('u').published).toBe(false);
    expect(byId('ap').published).toBe(true);
  });

  it('treats a legacy entry with no approval key as approved', async () => {
    seed([{ id: 'legacy', published: false, status: 'ready', publishAt: 1 }]);
    const due = await releaseScheduled();
    expect(due.map((d) => d.id)).toContain('legacy');
    expect(byId('legacy').published).toBe(true);
  });
});
