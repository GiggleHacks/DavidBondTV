// Paid-membership page (membership.html): shows plan choices to non-members
// (→ Stripe Checkout) and a "Manage billing" button to members (→ Stripe Customer
// Portal). Distinct from js/subscribe.js, which is the FREE follow button. After
// a successful checkout Stripe redirects back with ?status=success; since the
// membership is written by the webhook (which may lag a beat), we poll
// /api/auth/me briefly until it flips active.
import { fetchMe, postJSON } from '/js/account.js';
import { initTheme } from '/js/theme.js';

initTheme();

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

function setMsg(text, kind) {
  const m = $('msg');
  if (!text) { m.hidden = true; return; }
  m.hidden = false;
  m.textContent = text;
  m.className = `acc-msg ${kind || ''}`.trim();
}

function showBanner(text, kind) {
  const b = $('banner');
  b.hidden = false;
  b.textContent = text;
  b.className = `sub-banner ${kind || ''}`.trim();
}

function fmtDate(ms) {
  try { return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch { return ''; }
}

function showMember(me) {
  $('plans-view').hidden = true;
  $('member-view').hidden = false;
  const m = me.membership || {};
  let status = 'You’re a member. Enjoy the exclusives!';
  if (m.cancelAtPeriodEnd && m.currentPeriodEnd) {
    status = `Your membership is set to end on ${fmtDate(m.currentPeriodEnd)}. You keep access until then.`;
  } else if (m.status === 'past_due') {
    status = 'Your last payment didn’t go through. Update your card to keep your membership active.';
  } else if (m.currentPeriodEnd) {
    status = `You’re a member${m.interval ? ` (${m.interval}ly)` : ''}. Renews on ${fmtDate(m.currentPeriodEnd)}.`;
  }
  $('member-status').textContent = status;
}

function showPlans() {
  $('member-view').hidden = true;
  $('plans-view').hidden = false;
}

async function startCheckout(interval, btn) {
  setMsg('');
  btn.disabled = true;
  const r = await postJSON('/api/pay/stripe/checkout', { interval });
  if (r.ok && r.data.url) { location.href = r.data.url; return; }
  if (r.status === 401) {
    location.href = `/login.html?next=${encodeURIComponent('/membership.html')}`;
    return;
  }
  setMsg(r.data.error || 'Could not start checkout. Please try again.', 'error');
  btn.disabled = false;
}

async function openPortal(btn) {
  setMsg('');
  btn.disabled = true;
  const r = await postJSON('/api/pay/stripe/portal', {});
  if (r.ok && r.data.url) { location.href = r.data.url; return; }
  setMsg(r.data.error || 'Could not open the billing portal.', 'error');
  btn.disabled = false;
}

/** After checkout, the webhook may lag — poll a few times for the active flag. */
async function pollUntilActive(tries = 6) {
  for (let i = 0; i < tries; i++) {
    const me = await fetchMe();
    if (me && me.membership && me.membership.active) return me;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return fetchMe();
}

async function applyConfig() {
  // Hide plan buttons that have no configured price; show a notice if payments
  // aren't switched on yet.
  let cfg = null;
  try { cfg = await (await fetch('/api/pay/stripe/config')).json(); } catch { /* default below */ }
  const monthCard = $('buy-month').closest('.plan');
  const yearCard = $('buy-year').closest('.plan');
  if (!cfg || !cfg.enabled) {
    if (monthCard) monthCard.hidden = true;
    if (yearCard) yearCard.hidden = true;
    showBanner('Memberships aren’t available just yet — check back soon.', 'warn');
    return;
  }
  if (monthCard) monthCard.hidden = !cfg.intervals.month;
  if (yearCard) yearCard.hidden = !cfg.intervals.year;
}

async function render() {
  $('buy-month').addEventListener('click', (e) => startCheckout('month', e.currentTarget));
  $('buy-year').addEventListener('click', (e) => startCheckout('year', e.currentTarget));
  $('manage-btn').addEventListener('click', (e) => openPortal(e.currentTarget));

  const status = params.get('status');
  if (status === 'cancel') showBanner('Checkout canceled — no charge was made.', 'warn');

  await applyConfig();
  let me = await fetchMe();

  if (status === 'success') {
    if (!(me && me.membership && me.membership.active)) {
      showBanner('Payment received — activating your membership…', 'ok');
      me = await pollUntilActive();
    }
    if (me && me.membership && me.membership.active) {
      showBanner('You’re all set — welcome to David Bond TV membership!', 'ok');
    }
  }

  if (me && me.membership && me.membership.active) showMember(me);
  else showPlans();
}

render();
