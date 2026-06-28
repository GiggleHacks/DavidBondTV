// Shared helpers for the one-time course/product surfaces (browse.js modal,
// player.js watch-gate, course.js landing). Products are purchased with crypto
// (ETH) on the course page — the card rail (Stripe) was removed — so the buy
// buttons on other surfaces route to the course page where the ETH flow lives.
import { fetchMe } from '/js/account.js';

/** Format integer cents as a localized currency string (e.g. 9900 → "$99"). */
export function fmtMoney(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: (currency || 'usd').toUpperCase(),
      minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    }).format(amount / 100);
  } catch { return `$${(amount / 100).toFixed(2)}`; }
}

/**
 * Send the buyer to the course landing page, where the crypto (ETH) purchase
 * flow lives. Used by the homepage modal + watch-page gate buy buttons now that
 * the card rail is gone. `product` needs {slug}.
 */
export function goToCourse(product) {
  location.href = `/courses/${encodeURIComponent(product.slug)}`;
}

/** After checkout the webhook may lag — poll a few times for the entitlement. */
export async function pollOwnership(productId, tries = 6) {
  for (let i = 0; i < tries; i += 1) {
    const me = await fetchMe();
    if (me && Array.isArray(me.ownedProductIds) && me.ownedProductIds.includes(productId)) return me;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return fetchMe();
}
