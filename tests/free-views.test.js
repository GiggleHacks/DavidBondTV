import { describe, it, expect } from 'vitest';
import { readFreeViews, evaluateFreeView, FREE_VIEWS_COOKIE } from '../lib/free-views.js';

const SECRET = 'test-secret';
const LIMIT = 2;

const reqWith = (cookieHeader) => ({ headers: cookieHeader ? { cookie: cookieHeader } : {} });

/** Run one playback attempt and hand back the request for the next one. */
function attempt(req, videoId) {
  const r = evaluateFreeView({ req, videoId, limit: LIMIT, secret: SECRET });
  // The Set-Cookie's first segment ("name=value") is exactly what the browser
  // echoes back in the Cookie header on the next request.
  const nextReq = r.setCookie ? reqWith(r.setCookie.split(';')[0]) : req;
  return { ...r, nextReq };
}

describe('free-view quota', () => {
  it('no cookie → empty set', () => {
    expect(readFreeViews(reqWith(null), SECRET)).toEqual([]);
  });

  it('allows up to the limit of distinct videos, then blocks', () => {
    const a = attempt(reqWith(null), 'vid-a');
    expect(a.allowed).toBe(true);
    expect(a.setCookie).toContain(FREE_VIEWS_COOKIE);
    expect(a.setCookie).toContain('HttpOnly');

    const b = attempt(a.nextReq, 'vid-b');
    expect(b.allowed).toBe(true);
    expect(b.videos).toEqual(['vid-a', 'vid-b']);

    const c = attempt(b.nextReq, 'vid-c');
    expect(c.allowed).toBe(false);
    expect(c.setCookie).toBeNull();
  });

  it('rewatching a consumed video stays allowed and issues no new cookie', () => {
    const a = attempt(reqWith(null), 'vid-a');
    const b = attempt(a.nextReq, 'vid-b');
    const again = attempt(b.nextReq, 'vid-a');
    expect(again.allowed).toBe(true);
    expect(again.setCookie).toBeNull();
    // …and the quota is still enforced for a third distinct video.
    expect(attempt(b.nextReq, 'vid-c').allowed).toBe(false);
  });

  it('a tampered cookie is treated as empty (quota restarts, never crashes)', () => {
    const a = attempt(reqWith(null), 'vid-a');
    const b = attempt(a.nextReq, 'vid-b');
    const cookieVal = (b.nextReq.headers.cookie || '').split('=').slice(1).join('=');
    const forged = reqWith(`${FREE_VIEWS_COOKIE}=${cookieVal.slice(0, -4)}beef`);
    expect(readFreeViews(forged, SECRET)).toEqual([]);
    expect(attempt(forged, 'vid-c').allowed).toBe(true);
  });

  it('a cookie signed with a different secret is rejected', () => {
    const a = attempt(reqWith(null), 'vid-a');
    expect(readFreeViews(a.nextReq, 'other-secret')).toEqual([]);
  });
});
