// Customer-facing gate copy — the membership "unlock" offer and the free-view
// signup gate on the watch page. Edited from /god-pricing and served by
// /api/membership/config (pricing.publicConfig()). The config is fetched once
// and cached for the page; each getter falls back to its default copy if the
// request fails, so a gate never renders a blank headline or button.
export const DEFAULT_OFFER = {
  badge: '★ Members only',
  headline: 'Get instant access to the full library',
  body: 'Unlock this video — and the entire David Bond TV exclusive library — the moment you join. New drops first, no ads, cancel anytime.',
  ctaLabel: 'Unlock Now',
};

// Mirrors lib/pricing.js DEFAULT_FREE_VIEWS.
export const DEFAULT_FREE_VIEWS = {
  limit: 2,
  headline: 'Create a free account to keep watching',
  body: 'Create a free account to continue watching and receive updates from David Bond TV.',
  ctaLabel: 'Create free account',
};

let configCache = null;
function getConfig() {
  if (!configCache) {
    configCache = fetch('/api/membership/config')
      .then((r) => r.json())
      .catch(() => null);
  }
  return configCache;
}

export function getOfferCopy() {
  return getConfig().then((d) => ({ ...DEFAULT_OFFER, ...(d && typeof d.offer === 'object' ? d.offer : {}) }));
}

export function getFreeViewsCopy() {
  return getConfig().then((d) => ({ ...DEFAULT_FREE_VIEWS, ...(d && typeof d.freeViews === 'object' ? d.freeViews : {}) }));
}
