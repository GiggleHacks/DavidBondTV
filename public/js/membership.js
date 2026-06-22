// Paid-membership page (membership.html): shows the premium offer to non-members
// (→ Stripe Checkout) and a "Manage billing" button to members (→ Stripe Customer
// Portal). Distinct from js/subscribe.js, which is the FREE follow button.
//
// Flow: the page may carry ?next=<video> so that after a successful checkout we
// send the user straight back to the content they wanted. Stripe redirects to
// ?status=success&next=…; since the webhook may lag, we poll /api/auth/me until
// the membership flips active, then redirect to `next`.
import { fetchMe, postJSON } from '/js/account.js';
import { deriveBillingView } from '/js/billing-view.js';
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
  const view = deriveBillingView(me);
  const title = document.querySelector('#member-view .mb-title');
  const foot = document.querySelector('#member-view .mb-foot a');
  $('member-status').textContent = view.kind === 'admin-access'
    ? 'Your admin account already has full access to every exclusive video.'
    : view.status;
  if (title) title.textContent = view.kind === 'admin-access' ? 'Admin access included.' : "You're in.";
  if (foot) foot.textContent = view.kind === 'admin-access' ? 'Back to the admin dashboard →' : 'Browse exclusive videos →';
  if (foot && view.kind === 'admin-access') foot.href = '/god';
  if (foot && view.kind !== 'admin-access') foot.href = '/';
  const manage = $('manage-btn');
  manage.hidden = view.action !== 'manage';
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

// Crypto is priced 20% below the card price (paid direct, no processor fees).
const CRYPTO_DISCOUNT = 0.20;

/**
 * Render the monthly card headline from live config. With an intro price we show
 * "<intro> first month" + a "then <recurring>/mo" note; otherwise the flat
 * monthly price. The crypto card always reflects the recurring monthly price.
 */
function setCardPricing(month, intro) {
  const recurring = month.amount;
  const cur = month.currency;
  const note = document.querySelector('.pay-opt.normie .pay-note');
  if (intro && intro.amount > 0) {
    $('price-amount').textContent = fmtMoney(intro.amount, cur);
    $('price-per').textContent = (intro.label || 'first month').toLowerCase();
    if (note) note.textContent = `then ${fmtMoney(recurring, cur)}/mo`;
  } else {
    $('price-amount').textContent = fmtMoney(recurring, cur);
    $('price-per').textContent = '/ mo';
    if (note) note.textContent = 'Standard price';
  }
  const cryptoAmt = Math.round(recurring * (1 - CRYPTO_DISCOUNT));
  $('crypto-was').textContent = fmtMoney(recurring, cur);
  $('crypto-amount').textContent = fmtMoney(cryptoAmt, cur);
}

/** Show/populate the yearly option (with its discount vs 12× monthly), or hide it. */
function setYearly(year, month) {
  const row = $('year-row');
  if (!row) return;
  if (!year) { row.hidden = true; return; }
  row.hidden = false;
  $('year-amount').textContent = fmtMoney(year.amount, year.currency);
  const saveEl = $('year-save');
  if (saveEl && month && month.amount > 0 && year.amount < month.amount * 12) {
    const pct = Math.round((1 - year.amount / (month.amount * 12)) * 100);
    saveEl.textContent = `save ${pct}%`;
    saveEl.hidden = false;
  } else if (saveEl) {
    saveEl.hidden = true;
  }
}

async function applyConfig() {
  let cfg = null;
  try { cfg = await (await fetch('/api/pay/stripe/config')).json(); } catch { /* default below */ }
  if (!cfg || !cfg.enabled) {
    $('pay-card').disabled = true;
    showBanner('Memberships aren’t available just yet — check back soon.', 'warn');
    return;
  }
  const prices = cfg.prices || {};
  // Headline price: prefer monthly (with optional intro); fall back to yearly.
  if (cfg.intervals.month && prices.month) {
    primaryInterval = 'month';
    setCardPricing(prices.month, cfg.intro);
    setYearly(cfg.intervals.year ? prices.year : null, prices.month);
  } else if (cfg.intervals.year && prices.year) {
    primaryInterval = 'year';
    $('price-amount').textContent = fmtMoney(prices.year.amount, prices.year.currency);
    $('price-per').textContent = '/ yr';
    setYearly(null, null);
  }
}

async function render() {
  $('pay-card').addEventListener('click', (e) => startCheckout(primaryInterval, e.currentTarget));
  const payYear = $('pay-year');
  if (payYear) payYear.addEventListener('click', (e) => startCheckout('year', e.currentTarget));
  $('pay-crypto').addEventListener('click', () => {
    // Crypto checkout (self-hosted ETH/XMR/LTC/BCH) isn't live yet — graceful note.
    showBanner('🚀 GigaChad crypto checkout (ETH · XMR · LTC · BCH) is landing soon — 20% off when it goes live. Card works now.', 'ok');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
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

  const view = me ? deriveBillingView(me) : deriveBillingView(null);
  const hasAccess = view.kind === 'member' || view.kind === 'admin-access';

  // Already a member (or just became one) and we have somewhere to send them back
  // to → go straight to the content they wanted.
  if (hasAccess && next) {
    showBanner('You’re all set — taking you to your video…', 'ok');
    setTimeout(() => { location.href = next; }, 1000);
    showMember(me);
    return;
  }

  if (hasAccess) {
    if (status === 'success') showBanner('You’re all set — welcome to David Bond TV membership!', 'ok');
    showMember(me);
  } else {
    showPlans();
  }
}

render();
