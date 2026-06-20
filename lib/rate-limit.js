/**
 * createRateLimiter(windowMs)
 * Returns an object with hit(key, now?) → { allowed: boolean, retryAfter: number }
 *
 * Strategy: fixed-window per key.
 * - First hit (or hit after window expires) → allowed, record timestamp.
 * - Any hit within windowMs of the last ALLOWED hit → blocked.
 * - retryAfter = whole seconds until the window expires (ceil); 0 when allowed.
 */
export function createRateLimiter(windowMs) {
  // Map of key → timestamp of last allowed hit
  const store = new Map();

  return {
    hit(key, now = Date.now()) {
      const last = store.get(key);

      if (last === undefined) {
        // First ever hit for this key
        store.set(key, now);
        return { allowed: true, retryAfter: 0 };
      }

      const elapsed = now - last;

      if (elapsed >= windowMs) {
        // Window has passed — allow and reset
        store.set(key, now);
        return { allowed: true, retryAfter: 0 };
      }

      // Within window — block
      const remainingMs = windowMs - elapsed;
      const retryAfter = Math.ceil(remainingMs / 1000);
      return { allowed: false, retryAfter };
    },
  };
}
