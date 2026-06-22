// Paid membership — the single source of truth for "is this user an active
// paying member right now". Distinct from lib/subscribers.js, which is the FREE
// "Subscribe" (follow) button for the channel. A member unlocks every video
// marked visibility:'premium'.
//
// Pure functions, no I/O — the membership state lives on the user record
// (user.membership) and is written by the payment webhooks. This module only
// reads it, so it stays trivially unit-testable and a second payment rail (e.g.
// crypto) can be OR'd into hasActiveMembership() later without touching callers.

// Stripe subscription statuses that still grant access. `past_due` is kept on
// purpose: during dunning the subscriber keeps access until the paid period
// actually ends — the currentPeriodEnd ceiling below bounds it either way.
const ACTIVE_STRIPE = new Set(['active', 'trialing', 'past_due']);

/** Active Stripe membership? Requires an allowed status AND time left on the paid period. */
export function stripeActive(user, now = Date.now()) {
  const m = user && user.membership;
  if (!m || m.provider !== 'stripe') return false;
  if (!ACTIVE_STRIPE.has(m.status)) return false;
  return typeof m.currentPeriodEnd === 'number' && now < m.currentPeriodEnd;
}

/**
 * Active admin-granted comp membership? Set via the admin "grant" tool — a
 * manual override independent of Stripe. currentPeriodEnd === null means an
 * indefinite comp (no expiry); a number means it lapses at that time.
 */
export function adminActive(user, now = Date.now()) {
  const m = user && user.membership;
  if (!m || m.provider !== 'admin') return false;
  if (m.status !== 'active') return false;
  if (m.currentPeriodEnd == null) return true;
  return typeof m.currentPeriodEnd === 'number' && now < m.currentPeriodEnd;
}

/**
 * Is this user an active member right now? The one check every gate uses.
 * (Site admins are handled separately in the request context — admin always
 * unlocks — but an admin-granted comp on a normal user resolves here.)
 */
export function hasActiveMembership(user, now = Date.now()) {
  if (!user) return false;
  return stripeActive(user, now) || adminActive(user, now); // future: || cryptoActive(...)
}

/**
 * Safe, client-facing snapshot of membership state for /api/auth/me. Never
 * exposes Stripe customer/subscription IDs — just what the UI needs to render.
 */
export function membershipSummary(user, now = Date.now()) {
  const m = user && user.membership;
  const active = hasActiveMembership(user, now);
  if (!m) return { active: false, provider: null, status: null, interval: null, currentPeriodEnd: null, cancelAtPeriodEnd: false };
  return {
    active,
    provider: m.provider || null,
    status: m.status || null,
    interval: m.interval || null,
    currentPeriodEnd: typeof m.currentPeriodEnd === 'number' ? m.currentPeriodEnd : null,
    cancelAtPeriodEnd: !!m.cancelAtPeriodEnd,
  };
}
