// Paid-membership page (membership.html): shows the premium offer to non-members
// (→ Stripe Checkout) and a "Manage billing" button to members (→ Stripe Customer
// Portal). Distinct from js/subscribe.js, which is the FREE follow button.
//
// Flow: the page may carry ?next=<video> so that after a successful checkout we
// send the user straight back to the content they wanted. Stripe redirects to
// ?status=success&next=…; since the webhook may lag, we poll /api/auth/me until
// the membership flips active, then redirect to `next`.
import { fetchMe, postJSON } from '/js/account.js';
import { initTheme } from '/js/theme.js';

initTheme();

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const rawNext = params.get('next');
const next = (rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//')) ? rawNext : '';
let primaryInterval = 'month';

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

function fmtMoney(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: (currency || 'usd').toUpperCase(),
      minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    }).format(amount / 100);
  } catch { return `$${(amount / 100).toFixed(2)}`; }
}

function showMember(me) {
  $('plans-view').hidden = true;
  $('member-view').hidden = false;
  const m = me.membership || {};
  let status = 'You have full access to every exclusive video. Enjoy the show!';
  if (m.cancelAtPeriodEnd && m.currentPeriodEnd) {
    status = `Your membership ends on ${fmtDate(m.currentPeriodEnd)} — you keep access until then.`;
  } else if (m.status === 'past_due') {
    status = 'Your last payment didn’t go through. Update your card to keep your membership active.';
  } else if (m.currentPeriodEnd) {
    status = `Active${m.interval ? ` · billed ${m.interval}ly` : ''} · renews ${fmtDate(m.currentPeriodEnd)}.`;
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
  const r = await postJSON('/api/pay/stripe/checkout', { interval, next });
  if (r.ok && r.data.url) { location.href = r.data.url; return; }
  if (r.status === 401) {
    // Not signed in → sign up/in first, then return to this offer (with next intact).
    const here = location.pathname + location.search;
    try { localStorage.setItem('dbtv_after_auth', here); } catch { /* ignore */ }
    location.href = `/signup.html?next=${encodeURIComponent(here)}`;
    return;
  }
  if (r.status === 403) {
    location.href = `/profile-setup.html`;
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
  let cfg = null;
  try { cfg = await (await fetch('/api/pay/stripe/config')).json(); } catch { /* default below */ }
  if (!cfg || !cfg.enabled) {
    $('buy-month').disabled = true;
    $('buy-year').hidden = true;
    showBanner('Memberships aren’t available just yet — check back soon.', 'warn');
    return;
  }
  const prices = cfg.prices || {};
  // Headline price: prefer monthly; fall back to yearly if monthly isn't offered.
  if (cfg.intervals.month && prices.month) {
    $('price-amount').textContent = fmtMoney(prices.month.amount, prices.month.currency);
    $('price-per').textContent = '/ month';
    primaryInterval = 'month';
    $('buy-year').hidden = !cfg.intervals.year;
    if (cfg.intervals.year && prices.year) {
      $('buy-year').textContent = `Or pay ${fmtMoney(prices.year.amount, prices.year.currency)}/year`;
    }
  } else if (cfg.intervals.year && prices.year) {
    $('price-amount').textContent = fmtMoney(prices.year.amount, prices.year.currency);
    $('price-per').textContent = '/ year';
    primaryInterval = 'year';
    $('buy-year').hidden = true;
  }
}

async function render() {
  $('buy-month').addEventListener('click', (e) => startCheckout(primaryInterval, e.currentTarget));
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
  }

  const active = !!(me && me.membership && me.membership.active);

  // Already a member (or just became one) and we have somewhere to send them back
  // to → go straight to the content they wanted.
  if (active && next) {
    showBanner('You’re all set — taking you to your video…', 'ok');
    setTimeout(() => { location.href = next; }, 1000);
    showMember(me);
    return;
  }

  if (active) {
    if (status === 'success') showBanner('You’re all set — welcome to David Bond TV membership!', 'ok');
    showMember(me);
  } else {
    showPlans();
  }
}

render();
