import { describe, it, expect } from 'vitest';
import { computeMissing, pushDeletions } from '../lib/sync-client.mjs';

function stubFetch(responder) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const { status = 200, body = {} } = responder(url, opts) || {};
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

describe('computeMissing', () => {
  const entries = [
    { id: 'a', fingerprint: 'fa', extra: 'ignored' },
    { id: 'b', fingerprint: 'fb' },
  ];

  it('POSTs to /api/sync/diff with bearer auth + {id,fingerprint} only, and returns missing∪changed', async () => {
    const fetchImpl = stubFetch(() => ({ body: { present: ['a'], changed: ['b'], missing: ['c'] } }));
    const ids = await computeMissing('https://srv', 'tok', entries, fetchImpl);

    expect(ids).toEqual(['c', 'b']); // missing then changed
    const call = fetchImpl.calls[0];
    expect(call.url).toBe('https://srv/api/sync/diff');
    expect(call.opts.method).toBe('POST');
    expect(call.opts.headers.Authorization).toBe('Bearer tok');
    const sent = JSON.parse(call.opts.body);
    expect(sent.videos).toEqual([{ id: 'a', fingerprint: 'fa' }, { id: 'b', fingerprint: 'fb' }]);
  });

  it('throws on a non-OK diff response', async () => {
    const fetchImpl = stubFetch(() => ({ status: 401, body: { error: 'Unauthorized' } }));
    await expect(computeMissing('https://srv', 'tok', entries, fetchImpl)).rejects.toThrow(/diff failed/);
  });
});

describe('pushDeletions', () => {
  it('POSTs the ids and returns deleted ∪ notFound (all safe to clear)', async () => {
    const fetchImpl = stubFetch(() => ({ body: { deleted: ['a'], notFound: ['b'] } }));
    const handled = await pushDeletions('https://srv', 'tok', ['a', 'b'], fetchImpl);
    expect(handled.sort()).toEqual(['a', 'b']);
    const call = fetchImpl.calls[0];
    expect(call.url).toBe('https://srv/api/sync/delete');
    expect(JSON.parse(call.opts.body).ids).toEqual(['a', 'b']);
    expect(call.opts.headers.Authorization).toBe('Bearer tok');
  });

  it('no-ops (no request) when there is nothing to delete', async () => {
    const fetchImpl = stubFetch(() => ({ body: {} }));
    const handled = await pushDeletions('https://srv', 'tok', [], fetchImpl);
    expect(handled).toEqual([]);
    expect(fetchImpl.calls).toHaveLength(0);
  });
});
