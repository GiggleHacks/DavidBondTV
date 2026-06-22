import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../lib/rate-limit.js';

describe('createRateLimiter (single hit, default)', () => {
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
    expect(result.retryAfter).toBeLessThanOrEqual(60);
    expect(result.retryAfter).toBeGreaterThanOrEqual(59);
  });

  it('allows a hit after the window has passed', () => {
    const limiter = createRateLimiter(60_000);
    limiter.hit('key1', 1000);
    const result = limiter.hit('key1', 61_001);
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBe(0);
  });

  it('treats different keys independently', () => {
    const limiter = createRateLimiter(60_000);
    limiter.hit('key1', 1000);
    const result = limiter.hit('key2', 1500);
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBe(0);
  });

  it('updates window after allowed hit post-expiry', () => {
    const limiter = createRateLimiter(60_000);
    limiter.hit('key1', 1000);
    limiter.hit('key1', 61_001);
    const result = limiter.hit('key1', 61_002);
    expect(result.allowed).toBe(false);
  });
});

describe('createRateLimiter (N hits per window)', () => {
  it('allows up to maxHits then blocks', () => {
    const limiter = createRateLimiter(60_000, 3);
    expect(limiter.hit('k', 1000).allowed).toBe(true);
    expect(limiter.hit('k', 1100).allowed).toBe(true);
    expect(limiter.hit('k', 1200).allowed).toBe(true);
    expect(limiter.hit('k', 1300).allowed).toBe(false);
  });

  it('resets the count after the window', () => {
    const limiter = createRateLimiter(10_000, 2);
    limiter.hit('k', 1000);
    limiter.hit('k', 1100);
    expect(limiter.hit('k', 1200).allowed).toBe(false);
    expect(limiter.hit('k', 12_000).allowed).toBe(true); // new window
  });

  it('prunes stale keys so the map does not grow unbounded', () => {
    const limiter = createRateLimiter(1_000, 1);
    limiter.hit('a', 1000);
    limiter.hit('b', 1000);
    expect(limiter._size()).toBe(2);
    // A much later hit triggers a prune of expired entries.
    limiter.hit('c', 1_000_000);
    expect(limiter._size()).toBe(1);
  });
});
