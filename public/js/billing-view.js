import { isAdminUser } from './viewer-access.js';

function fmtDate(ms) {
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return '';
  }
}

export function deriveBillingView(user) {
  const membership = user && user.membership ? user.membership : null;

  // Admin access wins over a paid membership: an admin already has full access,
  // so never show them the member billing-portal flow (even if they also happen
  // to hold an active subscription).
  if (isAdminUser(user)) {
    return {
      kind: 'admin-access',
      status: 'Your admin account already has full access. Billing is not required.',
      action: null,
    };
  }

  if (membership && membership.active) {
    let status = 'Active member.';
    if (membership.cancelAtPeriodEnd && membership.currentPeriodEnd) {
      status = `Membership ends ${fmtDate(membership.currentPeriodEnd)} — you keep access until then.`;
    } else if (membership.status === 'past_due') {
      status = 'Payment failed — please update your card to keep your membership.';
    } else if (membership.currentPeriodEnd) {
      status = `Active${membership.interval ? ` · billed ${membership.interval}ly` : ''} · renews ${fmtDate(membership.currentPeriodEnd)}.`;
    }
    return { kind: 'member', status, action: 'manage' };
  }

  return {
    kind: 'prospect',
    status: 'You’re not a member yet. Unlock all exclusive videos.',
    action: 'join',
  };
}
