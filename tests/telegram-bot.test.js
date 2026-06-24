import { describe, it, expect } from 'vitest';
import { createTelegramNotifier } from '../lib/telegram-bot.js';

function mockFetch(response = { ok: true, status: 200 }) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: response.ok, status: response.status, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

const TOKEN = 'test-token';
const CHAT = '12345';

function make(fetchFn) {
  // Patch global fetch for the notifier (it uses bare fetch internally)
  const prev = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const n = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT });
  globalThis.fetch = prev;
  return n;
}

describe('createTelegramNotifier', () => {
  it('configured is true when both token and chatId are provided', () => {
    const n = createTelegramNotifier({ botToken: 'tok', chatId: '123' });
    expect(n.configured).toBe(true);
  });

  it('configured is false when botToken is missing', () => {
    const n = createTelegramNotifier({ chatId: '123' });
    expect(n.configured).toBe(false);
  });

  it('configured is false when chatId is missing', () => {
    const n = createTelegramNotifier({ botToken: 'tok' });
    expect(n.configured).toBe(false);
  });

  it('configured is false with no args', () => {
    const n = createTelegramNotifier();
    expect(n.configured).toBe(false);
  });
});

describe('formatMessage', () => {
  const n = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT });

  it('formats new_subscription with who / plan / price', () => {
    const msg = n._test.formatMessage('new_subscription', {
      username: 'Alice', email: 'alice@x.com', interval: 'month', amount: 1700, currency: 'usd',
    });
    expect(msg).toContain('🎉');
    expect(msg).toContain('NEW SALE');
    expect(msg).toContain('Alice');
    expect(msg).toContain('alice@x.com');
    expect(msg).toContain('Monthly membership');
    expect(msg).toContain('$17.00/mo');
  });

  it('formats course_purchase', () => {
    const msg = n._test.formatMessage('course_purchase', { username: 'Sam', product: 'Tracking 101', amount: 4900, currency: 'usd' });
    expect(msg).toContain('🛒');
    expect(msg).toContain('Sam');
    expect(msg).toContain('Tracking 101');
    expect(msg).toContain('$49.00');
  });

  it('formats renewal', () => {
    const msg = n._test.formatMessage('renewal', { username: 'Bob', amount: 4999, currency: 'usd' });
    expect(msg).toContain('💰');
    expect(msg).toContain('Bob');
    expect(msg).toContain('$49.99');
  });

  it('handles unknown event type gracefully', () => {
    const msg = n._test.formatMessage('unknown_event', { foo: 'bar' });
    expect(msg).toContain('unknown_event');
  });

  it('handles null amount gracefully', () => {
    const msg = n._test.formatMessage('renewal', {
      username: 'X', email: 'x@x.com', interval: 'month', amount: null, currency: null, timestamp: '2025-01-01T00:00:00Z',
    });
    expect(msg).toContain('—');
  });
});

describe('escapeHtml', () => {
  const { escapeHtml } = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT })._test;

  it('escapes &, <, >', () => {
    expect(escapeHtml('a&b<c>d')).toBe('a&amp;b&lt;c&gt;d');
  });

  it('escapes script tags', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('returns empty string for non-string input', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('');
  });
});

describe('sendMessage', () => {
  it('calls fetch with correct URL, method, and body', async () => {
    const f = mockFetch();
    globalThis.fetch = f;
    const n = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT });
    await n._test.sendMessage('hello');
    globalThis.fetch = globalThis.fetch; // restore handled by vitest

    expect(f.calls.length).toBe(1);
    expect(f.calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(f.calls[0].opts.method).toBe('POST');
    const body = JSON.parse(f.calls[0].opts.body);
    expect(body.chat_id).toBe(CHAT);
    expect(body.text).toBe('hello');
    expect(body.parse_mode).toBe('HTML');
  });
});

describe('notify', () => {
  it('is a no-op when not configured', () => {
    const f = mockFetch();
    globalThis.fetch = f;
    const n = createTelegramNotifier({});
    n.notify('new_subscription', { username: 'X', email: 'x@x.com' });
    expect(f.calls.length).toBe(0);
  });

  it('does not throw when fetch rejects', () => {
    globalThis.fetch = async () => { throw new Error('network down'); };
    const n = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT });
    expect(() => n.notify('renewal', { username: 'X', email: 'x@x.com' })).not.toThrow();
  });

  it('does not throw when fetch returns non-200', () => {
    globalThis.fetch = async () => ({ ok: false, status: 403 });
    const n = createTelegramNotifier({ botToken: TOKEN, chatId: CHAT });
    expect(() => n.notify('renewal', { username: 'X', email: 'x@x.com' })).not.toThrow();
  });
});
