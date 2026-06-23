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

describe('validateChunk', () => {
  const CAP = 10_000;

  it('rejects an unknown session with 404', () => {
    const r = uploads.validateChunk(null, 0, 100, CAP);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it('accepts a chunk at the current offset', () => {
    const s = makeSession('c', 1000);
    expect(uploads.validateChunk(s, 0, 200, CAP)).toEqual({ ok: true });
  });

  it('rejects an offset mismatch with 409 and reports the true offset', () => {
    const s = makeSession('d', 1000);
    s.received = 200;
    const r = uploads.validateChunk(s, 0, 100, CAP);
    expect(r).toMatchObject({ ok: false, status: 409, expected: 200 });
  });

  it('rejects an empty/invalid chunk with 400', () => {
    const s = makeSession('e', 1000);
    expect(uploads.validateChunk(s, 0, 0, CAP)).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects a chunk that would exceed the declared file size with 400', () => {
    const s = makeSession('f', 1000);
    s.received = 900;
    expect(uploads.validateChunk(s, 900, 200, CAP)).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects a chunk that would exceed the global cap with 413', () => {
    const s = makeSession('g', 20_000); // size under cap-check only because received small
    s.received = 9_900;
    expect(uploads.validateChunk(s, 9_900, 200, CAP)).toMatchObject({ ok: false, status: 413 });
  });
});

describe('validateComplete', () => {
  it('rejects an unknown session', () => {
    expect(uploads.validateComplete(null)).toMatchObject({ ok: false, status: 404 });
  });

  it('rejects when bytes received != declared size', () => {
    const s = makeSession('h', 1000);
    s.received = 800;
    expect(uploads.validateComplete(s)).toMatchObject({ ok: false, status: 400, expected: 800 });
  });

  it('accepts when the full file has arrived', () => {
    const s = makeSession('i', 1000);
    s.received = 1000;
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
