/**
 * createRateLimiter(windowMs, maxHits = 1)
 * Returns an object with hit(key, now?) → { allowed: boolean, retryAfter: number }
 *
 * Strategy: fixed-window counter per key.
 * - A window opens on the first hit (or first hit after the previous window
 *   expired). Up to `maxHits` hits are allowed within that window.
 * - The (maxHits + 1)th hit inside the window is blocked.
 * - retryAfter = whole seconds until the window expires (ceil); 0 when allowed.
 *
 * Defaulting maxHits to 1 preserves the original single-hit-per-window behaviour.
 * Stale keys are pruned periodically so the Map cannot grow unbounded at scale.
 */
export function createRateLimiter(windowMs, maxHits = 1) {
  // Map of key → { start: windowStartMs, count: hitsThisWindow }
  const store = new Map();
  let lastPrune = 0;

  function prune(now) {
    for (const [key, entry] of store) {
      if (now - entry.start >= windowMs) store.delete(key);
    }
    lastPrune = now;
  }

  return {
    hit(key, now = Date.now()) {
      // Opportunistic cleanup: at most once per window.
      if (now - lastPrune >= windowMs) prune(now);

      const entry = store.get(key);

      if (entry === undefined || now - entry.start >= windowMs) {
        // Open a fresh window.
        store.set(key, { start: now, count: 1 });
        return { allowed: true, retryAfter: 0 };
      }

      if (entry.count < maxHits) {
        entry.count += 1;
        return { allowed: true, retryAfter: 0 };
      }

      const remainingMs = windowMs - (now - entry.start);
      return { allowed: false, retryAfter: Math.ceil(remainingMs / 1000) };
    },

    // Test/introspection helper.
    _size() {
      return store.size;
    },
  };
}
