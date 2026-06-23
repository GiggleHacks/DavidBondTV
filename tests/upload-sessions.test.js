import { describe, it, expect, afterEach } from 'vitest';
import * as uploads from '../lib/upload-sessions.mjs';

// The session store is a module-level Map; clean it between tests.
afterEach(() => {
  for (const s of uploads.sweepStale(-1)) { void s; } // negative idle → remove all
});

function makeSession(id = 'u1', size = 1000) {
  return uploads.createSession(id, { partPath: `/tmp/${id}.part`, savedPath: `/tmp/${id}.mp4`, name: 'v.mp4', size }, 0);
}

describe('upload-sessions store', () => {
  it('creates, fetches, and deletes sessions', () => {
    const s = makeSession('a', 500);
    expect(s.received).toBe(0);
    expect(s.ranges).toEqual([]);
    expect(uploads.getSession('a')).toBe(s);
    expect(uploads.count()).toBe(1);
    uploads.deleteSession('a');
    expect(uploads.getSession('a')).toBe(null);
    expect(uploads.count()).toBe(0);
  });

  it('touch updates lastActive', () => {
    const s = makeSession('b');
    uploads.touch(s, 12345);
    expect(s.lastActive).toBe(12345);
  });
});

describe('validateChunk (parallel)', () => {
  const CAP = 10_000;

  it('rejects an unknown session with 404', () => {
    const r = uploads.validateChunk(null, 0, 100, CAP);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it('accepts a chunk at offset 0', () => {
    const s = makeSession('c', 1000);
    expect(uploads.validateChunk(s, 0, 200, CAP)).toEqual({ ok: true });
  });

  it('accepts out-of-order chunks', () => {
    const s = makeSession('d', 1000);
    expect(uploads.validateChunk(s, 500, 200, CAP)).toEqual({ ok: true });
    expect(uploads.validateChunk(s, 0, 200, CAP)).toEqual({ ok: true });
  });

  it('returns skip:true for already-received chunks', () => {
    const s = makeSession('d2', 1000);
    uploads.addRange(s, 0, 200);
    const r = uploads.validateChunk(s, 0, 200, CAP);
    expect(r).toEqual({ ok: true, skip: true });
  });

  it('rejects an empty/invalid chunk with 400', () => {
    const s = makeSession('e', 1000);
    expect(uploads.validateChunk(s, 0, 0, CAP)).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects a chunk that would exceed the declared file size with 400', () => {
    const s = makeSession('f', 1000);
    expect(uploads.validateChunk(s, 900, 200, CAP)).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects a chunk that would exceed the global cap with 413', () => {
    const s = makeSession('g', 20_000);
    expect(uploads.validateChunk(s, 9_900, 200, CAP)).toMatchObject({ ok: false, status: 413 });
  });

  it('rejects negative offset with 400', () => {
    const s = makeSession('h', 1000);
    expect(uploads.validateChunk(s, -1, 100, CAP)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('addRange and contiguousBytes', () => {
  it('tracks sequential ranges', () => {
    const s = makeSession('r1', 1000);
    uploads.addRange(s, 0, 200);
    expect(s.received).toBe(200);
    expect(s.ranges).toEqual([[0, 200]]);
    expect(uploads.contiguousBytes(s)).toBe(200);
  });

  it('merges adjacent ranges', () => {
    const s = makeSession('r2', 1000);
    uploads.addRange(s, 0, 200);
    uploads.addRange(s, 200, 400);
    expect(s.received).toBe(400);
    expect(s.ranges).toEqual([[0, 400]]);
    expect(uploads.contiguousBytes(s)).toBe(400);
  });

  it('tracks non-contiguous ranges', () => {
    const s = makeSession('r3', 1000);
    uploads.addRange(s, 0, 200);
    uploads.addRange(s, 500, 700);
    expect(s.received).toBe(400);
    expect(s.ranges).toEqual([[0, 200], [500, 700]]);
    expect(uploads.contiguousBytes(s)).toBe(200);
  });

  it('fills gaps and merges', () => {
    const s = makeSession('r4', 1000);
    uploads.addRange(s, 0, 200);
    uploads.addRange(s, 500, 700);
    uploads.addRange(s, 200, 500);
    expect(s.received).toBe(700);
    expect(s.ranges).toEqual([[0, 700]]);
    expect(uploads.contiguousBytes(s)).toBe(700);
  });

  it('returns 0 contiguous when first range starts after 0', () => {
    const s = makeSession('r5', 1000);
    uploads.addRange(s, 200, 400);
    expect(uploads.contiguousBytes(s)).toBe(0);
  });
});

describe('isRangeReceived', () => {
  it('returns true for fully covered range', () => {
    const s = makeSession('ir1', 1000);
    uploads.addRange(s, 0, 500);
    expect(uploads.isRangeReceived(s, 100, 300)).toBe(true);
  });

  it('returns false for uncovered range', () => {
    const s = makeSession('ir2', 1000);
    uploads.addRange(s, 0, 200);
    expect(uploads.isRangeReceived(s, 100, 300)).toBe(false);
  });
});

describe('validateComplete', () => {
  it('rejects an unknown session', () => {
    expect(uploads.validateComplete(null)).toMatchObject({ ok: false, status: 404 });
  });

  it('rejects when bytes received != declared size', () => {
    const s = makeSession('h', 1000);
    uploads.addRange(s, 0, 800);
    expect(uploads.validateComplete(s)).toMatchObject({ ok: false, status: 400 });
  });

  it('accepts when the full file has arrived', () => {
    const s = makeSession('i', 1000);
    uploads.addRange(s, 0, 1000);
    expect(uploads.validateComplete(s)).toEqual({ ok: true });
  });

  it('accepts when full file arrived via non-contiguous chunks', () => {
    const s = makeSession('j', 1000);
    uploads.addRange(s, 0, 300);
    uploads.addRange(s, 700, 1000);
    uploads.addRange(s, 300, 700);
    expect(uploads.validateComplete(s)).toEqual({ ok: true });
  });
});

describe('sweepStale', () => {
  it('removes only sessions idle beyond the threshold and returns them', () => {
    const fresh = uploads.createSession('fresh', { partPath: '/tmp/fresh.part', size: 1 }, 1000);
    uploads.createSession('old', { partPath: '/tmp/old.part', size: 1 }, 0);
    const removed = uploads.sweepStale(500, 1000); // now=1000: 'old' idle 1000ms, 'fresh' idle 0
    expect(removed.map((s) => s.id)).toEqual(['old']);
    expect(uploads.getSession('old')).toBe(null);
    expect(uploads.getSession('fresh')).toBe(fresh);
  });
});
