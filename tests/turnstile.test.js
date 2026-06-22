import { describe, it, expect, vi } from 'vitest';
import { createTurnstile } from '../lib/turnstile.js';

function fakeFetch(result) {
  return vi.fn().mockResolvedValue({
    ok: result.ok !== false,
    status: result.status || 200,
    json: async () => result.body,
  });
}

describe('createTurnstile', () => {
  it('is disabled (and always fails) without a secret', async () => {
    const ts = createTurnstile({});
    expect(ts.enabled).toBe(false);
    expect(await ts.verify('tok', '1.2.3.4')).toBe(false);
  });

  it('verifies a token against siteverify and returns success', async () => {
    const fetchImpl = fakeFetch({ body: { success: true } });
    const ts = createTurnstile({ secret: 's', fetchImpl });
    expect(ts.enabled).toBe(true);
    expect(await ts.verify('good-token', '9.9.9.9')).toBe(true);

    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(opts.method).toBe('POST');
    const params = new URLSearchParams(opts.body);
    expect(params.get('secret')).toBe('s');
    expect(params.get('response')).toBe('good-token');
    expect(params.get('remoteip')).toBe('9.9.9.9');
  });

  it('returns false when Cloudflare reports failure', async () => {
    const ts = createTurnstile({ secret: 's', fetchImpl: fakeFetch({ body: { success: false } }) });
    expect(await ts.verify('bad', '1.1.1.1')).toBe(false);
  });

  it('returns false on a missing token without calling the network', async () => {
    const fetchImpl = fakeFetch({ body: { success: true } });
    const ts = createTurnstile({ secret: 's', fetchImpl });
    expect(await ts.verify('', '1.1.1.1')).toBe(false);
    expect(await ts.verify(null, '1.1.1.1')).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws on a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));
    const ts = createTurnstile({ secret: 's', fetchImpl });
    expect(await ts.verify('tok', '1.1.1.1')).toBe(false);
  });

  it('omits remoteip when no ip is given', async () => {
    const fetchImpl = fakeFetch({ body: { success: true } });
    const ts = createTurnstile({ secret: 's', fetchImpl });
    await ts.verify('tok');
    const params = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
    expect(params.has('remoteip')).toBe(false);
  });
});
