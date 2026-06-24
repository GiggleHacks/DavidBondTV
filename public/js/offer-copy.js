// Customer-facing "unlock" offer copy — the membership gate on the watch page
// and the paywall modal on the browse grid. Edited from /god-pricing and served
// inside /api/pay/stripe/config (pricing.publicConfig().offer). Fetched once and
// cached for the page; falls back to the historical default copy if the request
// fails, so the gate never renders a blank headline or button.
export const DEFAULT_OFFER = {
  badge: '★ Members only',
  headline: "You're one tap from the good stuff",
  body: 'Unlock this video — and the entire David Bond TV exclusive library — the moment you join. New drops first, no ads, cancel anytime.',
  ctaLabel: 'Unlock Now',
};

let cache = null;

export function getOfferCopy() {
  if (cache) return cache;
  cache = fetch('/api/pay/stripe/config')
    .then((r) => r.json())
    .then((d) => ({ ...DEFAULT_OFFER, ...(d && typeof d.offer === 'object' ? d.offer : {}) }))
    .catch(() => ({ ...DEFAULT_OFFER }));
  return cache;
}
