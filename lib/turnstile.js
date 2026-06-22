// Cloudflare Turnstile server-side verification. A privacy-friendly, free CAPTCHA
// replacement for the home-rolled math challenge — it actually resists scripted
// mass signup, which a scrape of /api/challenge does not. Fetch-based (Node 18+),
// no dependency. When no secret is configured the module reports `enabled:false`
// and callers fall back to the math challenge, so local dev + tests keep working.
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function createTurnstile({ secret, fetchImpl } = {}) {
  const enabled = Boolean(secret);
  const doFetch = fetchImpl || ((...a) => fetch(...a));

  /**
   * Verify a widget response token with Cloudflare. Returns a boolean and never
   * throws — a network/parse failure is treated as a failed challenge.
   */
  async function verify(token, ip) {
    if (!enabled) return false;
    if (!token || typeof token !== 'string') return false;
    try {
      const form = new URLSearchParams({ secret, response: token });
      if (ip) form.set('remoteip', ip);
      const res = await doFetch(SITEVERIFY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data && data.success === true;
    } catch {
      return false;
    }
  }

  return { enabled, verify };
}
