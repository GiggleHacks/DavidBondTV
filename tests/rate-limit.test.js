import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../lib/rate-limit.js';

describe('createRateLimiter', () => {
  it('allows the first hit for a key', () => {
    const limiter = createRateLimiter(60_000);
    const result = limiter.hit('key1', 1000);
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBe(0);
  });

  it('blocks an immediate second hit', () => {
    const limiter = createRateLimiter(60_000);
    limiter.hit('key1', 1000);
    const result = limiter.hit('key1', 1500); // 500ms later, within window
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
    // retryAfter should be ~60 seconds (ceiling of remaining window)
    expect(result.retryAfter).toBeLessThanOrEqual(60);
    expect(result.retryAfter).toBeGreaterThanOrEqual(59);
  });

  it('allows a hit after the window has passed', () => {
    const limiter = createRateLimiter(60_000);
    limiter.hit('key1', 1000);
    // Attempt at exactly windowMs later — should be allowed
    const result = limiter.hit('key1', 61_001);
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBe(0);
  });

  it('treats different keys independently', () => {
    const limiter = createRateLimiter(60_000);
    limiter.hit('key1', 1000);
    // key2 has never been hit — should be allowed
    const result = limiter.hit('key2', 1500);
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBe(0);
  });

  it('updates window after allowed hit post-expiry', () => {
    const limiter = createRateLimiter(60_000);
    limiter.hit('key1', 1000);
    limiter.hit('key1', 61_001); // second allowed hit, resets window
    // Immediate third hit should be blocked
    const result = limiter.hit('key1', 61_002);
    expect(result.allowed).toBe(false);
  });
});
