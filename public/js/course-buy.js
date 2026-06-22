// Shared one-time course/product purchase flow, used by the homepage grid modal
// (browse.js), the watch-page course gate (player.js) and the course landing page
// (course.js). Mirrors membership.js startCheckout: POST → redirect to Stripe;
// 401 → sign up first (returning to the course page); 403 → finish profile.
import { fetchMe, postJSON } from '/js/account.js';

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
 * Begin a one-time purchase of `product` (needs {id, slug}). `next` is the
 * same-origin path to return to after a successful purchase (e.g. the video).
 * Redirects the browser to Stripe Checkout on success; routes unauthenticated /
 * incomplete-profile users into the right onboarding step first. Returns the
 * response object on a soft error so the caller can surface the message.
 */
export async function startPurchase(product, next, btn) {
  if (btn) btn.disabled = true;
  const r = await postJSON('/api/pay/stripe/buy', { productId: product.id, next: next || '' });
  if (r.ok && r.data && r.data.url) { location.href = r.data.url; return r; }
  if (r.status === 401) {
    // Not signed in → sign up/in first, then land on this course's page to buy.
    const dest = `/course.html?slug=${encodeURIComponent(product.slug)}`;
    try { localStorage.setItem('dbtv_after_auth', dest); } catch { /* ignore */ }
    location.href = `/signup.html?next=${encodeURIComponent(dest)}`;
    return r;
  }
  if (r.status === 403) { location.href = '/profile-setup.html'; return r; }
  if (r.status === 409) { location.reload(); return r; } // already owns it
  if (btn) btn.disabled = false;
  return r;
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
