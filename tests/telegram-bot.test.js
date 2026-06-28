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

  it('new_subscription shows charged-today, ongoing price, fee + net, and coupon', () => {
    const msg = n._test.formatMessage('new_subscription', {
      username: 'Alice', email: 'alice@x.com', interval: 'month',
      recurringAmount: 1700, chargedToday: 100, currency: 'usd',
      couponCode: 'LAUNCH', couponPercentOff: 50,
    });
    expect(msg).toContain('Charged today');
    expect(msg).toContain('$1.00');           // intro charged today
    expect(msg).toContain('Ongoing');
    expect(msg).toContain('$17.00/mo');        // ongoing recurring
    expect(msg).toContain('LAUNCH');
    expect(msg).toContain('50%');
    expect(msg).toContain('net deposited');
    // net of $1.00 after ~2.9% + 30¢ ≈ $0.67
    expect(msg).toContain('$0.67');
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

  it('formats crypto_membership with coin amount + USD value, no Stripe-fee language', () => {
    const msg = n._test.formatMessage('crypto_membership', {
      username: 'Cara', email: 'cara@x.com', interval: '3mo', coinAmount: '0.0834', coin: 'ETH', usd: 59.07,
    });
    expect(msg).toContain('Cara');
    expect(msg).toContain('cara@x.com');
    expect(msg).toContain('0.0834 ETH');   // the actual coin amount paid
    expect(msg).toContain('$59.07');        // the USD value
    expect(msg).toContain('3mo');           // the prepaid term
    expect(msg).not.toMatch(/stripe/i);     // crypto sale must NOT mention Stripe
    expect(msg).not.toMatch(/fee/i);        // no processor fee on a direct-to-wallet payment
    expect(msg).not.toContain('—');         // never a blank amount
  });

  it('formats crypto_course with coin amount + USD value', () => {
    const msg = n._test.formatMessage('crypto_course', {
      username: 'Dan', product: 'Digital Pickup 2.0', coinAmount: '0.1346', coin: 'ETH', usd: 269.1,
    });
    expect(msg).toContain('Dan');
    expect(msg).toContain('Digital Pickup 2.0');
    expect(msg).toContain('0.1346 ETH');
    expect(msg).toContain('$269.10');
    expect(msg).not.toMatch(/stripe/i);
    expect(msg).not.toContain('—');
  });

  it('formats whop_membership with who / plan / charged amount', () => {
    const msg = n._test.formatMessage('whop_membership', {
      username: 'Eve', email: 'eve@x.com', interval: 'month', amount: 100, currency: 'usd',
    });
    expect(msg).toContain('WHOP');
    expect(msg).toContain('Eve');
    expect(msg).toContain('eve@x.com');
    expect(msg).toContain('month membership');
    expect(msg).toContain('$1.00');         // charged amount (cents → dollars)
    expect(msg).not.toMatch(/stripe/i);     // WHOP sale must NOT mention Stripe
  });

  it('whop_membership tolerates a missing amount', () => {
    const msg = n._test.formatMessage('whop_membership', {
      username: 'Eve', email: 'eve@x.com', interval: 'month', amount: null, currency: 'usd',
    });
    expect(msg).toContain('WHOP');
    expect(msg).toContain('Eve');
  });

  it('handles unknown event type gracefully', () => {
    const msg = n._test.formatMessage('unknown_event', { foo: 'bar' });
    expect(msg).toContain('unknown_event');
  });

  it('formats a new comment with who/where/what + a clickable link', () => {
    const msg = n._test.formatMessage('comment', {
      username: 'DavidQuake', tag: 'member', text: 'great vid', ip: '8.8.8.8',
      cc: 'US', country: 'United States', url: 'https://davidbondtv.com/videos/jess-at-a-gogo',
    });
    expect(msg).toContain('New comment');
    expect(msg).toContain('DavidQuake');
    expect(msg).toContain('United States (US)');
    expect(msg).toContain('8.8.8.8');
    expect(msg).toContain('great vid');
    expect(msg).toContain('<a href="https://davidbondtv.com/videos/jess-at-a-gogo">View page</a>');
  });

  it('flags a hidden (filtered) comment and escapes HTML in user text', () => {
    const msg = n._test.formatMessage('comment', {
      username: 'Anonymous', tag: 'anonymous', text: '<script>x</script>', ip: '1.1.1.1',
      hidden: true, hiddenReason: 'Firestone', parentId: 'p1',
    });
    expect(msg).toContain('New reply');
    expect(msg).toContain('Hidden from public');
    expect(msg).toContain('Firestone');
    expect(msg).toContain('&lt;script&gt;');
    expect(msg).not.toContain('<script>');
  });

  it('estimateStripeNet applies ~2.9% + 30¢', () => {
    const { estimateStripeNet } = n._test;
    expect(estimateStripeNet(1700)).toEqual({ fee: Math.round(1700 * 0.029) + 30, net: 1700 - (Math.round(1700 * 0.029) + 30) });
    expect(estimateStripeNet(0)).toEqual({ fee: 0, net: 0 });
    expect(estimateStripeNet(null)).toEqual({ fee: 0, net: 0 });
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
