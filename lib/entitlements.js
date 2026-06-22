// One-time product entitlements — the single source of truth for "does this user
// own this product (course/bundle/digital) right now". Distinct from membership
// (lib/membership.js): membership is a recurring subscription unlocking every
// premium video; an entitlement is a permanent, one-time purchase unlocking the
// videos assigned to one specific product.
//
// Pure functions, no I/O — the state lives on the user record (user.products),
// written by the payment webhook (see lib/stripe-payments.js). This module only
// reads it, so it stays trivially unit-testable. Precedence between a course gate
// and the premium-membership gate is decided by the CALLER (see canWatchVideo in
// public/js/viewer-access.js and the media backstop in server.mjs), never here.

/** The user's owned-product list, tolerant of legacy records that predate it. */
function ownedList(user) {
  return user && Array.isArray(user.products) ? user.products : [];
}

/** Does this user own the given product? */
export function ownsProduct(user, productId) {
  if (!user || !productId) return false;
  return ownedList(user).some((p) => p && p.productId === productId);
}

/** Distinct ids of every product this user owns. [] for legacy/never-purchased. */
export function ownedProductIds(user) {
  const seen = new Set();
  for (const p of ownedList(user)) {
    if (p && p.productId) seen.add(p.productId);
  }
  return [...seen];
}

/**
 * Safe, client-facing snapshot for /api/auth/me — just product ids + when bought.
 * Never exposes the Stripe session id or amount paid.
 */
export function entitlementsSummary(user) {
  return {
    products: ownedList(user)
      .filter((p) => p && p.productId)
      .map((p) => ({ productId: p.productId, purchasedAt: typeof p.purchasedAt === 'number' ? p.purchasedAt : null })),
  };
}
