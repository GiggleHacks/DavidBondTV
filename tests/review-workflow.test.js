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

describe('review-first encoding (upload → review → approve → encode)', () => {
  it('reject marks the video rejected, clears sourcePath, and deletes the original', async () => {
    const src = path.join(TMP, 'media', 'reject-me.mp4');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'fake video bytes');
    seed([{ id: 'r', published: false, approval: 'unapproved', status: 'uploaded', sourcePath: src }]);

    await bulkAction(['r'], 'reject');
    const e = byId('r');
    expect(e.status).toBe('rejected');
    expect(e.published).toBe(false);
    expect('sourcePath' in e).toBe(false); // cleared
    expect(fs.existsSync(src)).toBe(false); // un-encoded original reclaimed
  });

  it('approve on an uploaded video flips it to approved and out of the uploaded state (encoding begins)', async () => {
    const src = path.join(TMP, 'media', 'approve-me.mp4');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'fake video bytes');
    seed([{ id: 'a2', published: false, approval: 'unapproved', status: 'uploaded', sourcePath: src }]);

    await bulkAction(['a2'], 'approve');
    const e = byId('a2');
    expect(e.approval).toBe('approved');            // approval is the durable decision
    expect(e.published).toBe(false);                // approving never publishes
    expect(e.status).not.toBe('uploaded');          // left the review queue → encoding (or failed w/o ffmpeg)
    expect(['encoding', 'failed', 'ready']).toContain(e.status);
  });

  it('approve re-encodes a FAILED video from its stored original (restart-recovery)', async () => {
    // A previous encode died (e.g. server restart mid-ffmpeg) → status 'failed',
    // but the original is still on disk. Approving it must re-queue the encode.
    const src = path.join(TMP, 'media', 'retry-me.mp4');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'fake video bytes');
    seed([{ id: 'f1', published: false, approval: 'approved', status: 'failed', sourcePath: src }]);

    const r = await bulkAction(['f1'], 'approve');
    expect(r.count).toBe(1);                         // it WAS sent back into the pipeline
    expect(byId('f1').status).not.toBe('uploaded');
    expect(['encoding', 'failed', 'ready']).toContain(byId('f1').status);
  });
});

describe('approve-free combines visibility, blur, and approval', () => {
  it('on a ready premium+blurred video: free + de-blurred + approved, category intact', async () => {
    seed([{
      id: 'af', published: false, approval: 'unapproved', status: 'ready',
      visibility: 'premium', blur: 'strong', category: 'colombia-harem',
    }]);
    await bulkAction(['af'], 'approve-free');
    const e = byId('af');
    expect(e.visibility).toBe('free');
    expect(e.blur).toBe('off');
    expect(e.approval).toBe('approved');
    expect(e.published).toBe(false);          // approving never publishes
    expect(e.category).toBe('colombia-harem'); // topic category untouched
  });

  it('on an uploaded video: sets flags AND starts encoding (flags survive startEncode)', async () => {
    const src = path.join(TMP, 'media', 'af-up.mp4');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, 'fake video bytes');
    seed([{
      id: 'afu', published: false, approval: 'unapproved', status: 'uploaded',
      visibility: 'premium', blur: 'strong', sourcePath: src,
    }]);
    await bulkAction(['afu'], 'approve-free');
    const e = byId('afu');
    expect(e.visibility).toBe('free');         // not clobbered by startEncode
    expect(e.blur).toBe('off');
    expect(e.status).not.toBe('uploaded');     // entered the encode pipeline
    expect(['encoding', 'failed', 'ready']).toContain(e.status);
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
