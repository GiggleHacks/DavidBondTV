// Paid-membership page (membership.html): shows the premium offer to non-members
// (→ Stripe Checkout) and a "Manage billing" button to members (→ Stripe Customer
// Portal).
//
// Flow: the page may carry ?next=<video> so that after a successful checkout we
// send the user straight back to the content they wanted. Stripe redirects to
// ?status=success&session_id=<cs_…>&next=…. We activate SYNCHRONOUSLY by posting
// that session id to /api/pay/stripe/reconcile (so activation never depends on
// the webhook), then fall back to a short poll. A successful payment NEVER
// re-shows the sales offer — at worst it shows a "finalizing" state with a
// "Check again" button.
import { fetchMe, postJSON } from '/js/account.js';
import { startCryptoCheckout, cryptoCoinOptions } from '/js/crypto-checkout.js';
import { deriveBillingView } from '/js/billing-view.js';
import { initTheme } from '/js/theme.js';
import { ADMIN_PATHS } from '/js/admin-paths.js';

initTheme();

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const rawNext = params.get('next');
const next = (rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//')) ? rawNext : '';
const sessionId = params.get('session_id') || '';
let primaryInterval = 'month';

const isActive = (me) => !!(me && me.membership && me.membership.active);
const hasAccessFor = (me) => {
  const v = me ? deriveBillingView(me) : deriveBillingView(null);
  return v.kind === 'member' || v.kind === 'admin-access';
};

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
  $('pending-actions').hidden = true;
  $('member-view').hidden = false;
  const view = deriveBillingView(me);
  const title = document.querySelector('#member-view .mb-title');
  const foot = document.querySelector('#member-view .mb-foot a');
  $('member-status').textContent = view.kind === 'admin-access'
    ? 'Your admin account already has full access to every exclusive video.'
    : view.status;
  if (title) title.textContent = view.kind === 'admin-access' ? 'Admin access included.' : "You're in.";
  if (foot) foot.textContent = view.kind === 'admin-access' ? 'Back to the admin dashboard →' : 'Browse exclusive videos →';
  if (foot && view.kind === 'admin-access') foot.href = ADMIN_PATHS.dashboard;
  if (foot && view.kind !== 'admin-access') foot.href = '/';
  const manage = $('manage-btn');
  manage.hidden = view.action !== 'manage';
}

function showPlans() {
  $('member-view').hidden = true;
  $('pending-actions').hidden = true;
  $('plans-view').hidden = false;
}

/**
 * Paid, but membership not yet reflected locally. Show an honest "finalizing"
 * state with a manual re-check — NEVER the sales offer (which reads as "the
 * payment failed").
 */
function showPending() {
  $('plans-view').hidden = true;
  $('member-view').hidden = true;
  $('pending-actions').hidden = false;
  showBanner('Payment received — finalizing your access. This can take a few seconds. We’ve emailed your receipt; tap “Check again” below.', 'ok');
}

/** Synchronous server-side activation from the checkout session on the URL. */
async function reconcileSession() {
  if (!sessionId) return null;
  const r = await postJSON('/api/pay/stripe/reconcile', { sessionId });
  return r && r.ok ? r.data : null;
}

/** Surface the VIP Telegram join button for eligible members (auto-prompt). */
async function maybeShowTelegram() {
  const btn = $('tg-join');
  if (!btn) return;
  try {
    const s = await (await fetch('/api/telegram/status')).json();
    if (!s || !s.enabled || !s.eligible) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.textContent = s.linkState === 'joined' ? 'Open the VIP Telegram →' : 'Join the VIP Telegram →';
    btn.onclick = async () => {
      btn.disabled = true;
      const r = await postJSON('/api/telegram/link', {});
      btn.disabled = false;
      if (r.ok && r.data.deepLink) window.open(r.data.deepLink, '_blank', 'noopener');
      else setMsg((r.data && r.data.error) || 'Could not get your Telegram invite — try again from your account.', 'error');
    };
  } catch { btn.hidden = true; }
}

/** Render the success/member state + auto-prompt Telegram. */
function enterMember(me, { celebrate } = {}) {
  if (celebrate) showBanner('You’re all set — welcome to David Bond TV membership! 🎉', 'ok');
  showMember(me);
  maybeShowTelegram();
}

async function startCheckout(interval, btn) {
  setMsg('');
  btn.disabled = true;
  const couponCode = $('coupon-code') ? $('coupon-code').value.trim() : '';
  const r = await postJSON('/api/pay/stripe/checkout', { interval, next, couponCode });
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
  const sub = $('price-sub');
  if (intro && intro.amount > 0) {
    $('price-amount').textContent = fmtMoney(intro.amount, cur);
    $('price-per').textContent = (intro.label || 'first month').toLowerCase();
    if (sub) { sub.textContent = `then ${fmtMoney(recurring, cur)}/mo`; sub.hidden = false; }
  } else {
    $('price-amount').textContent = fmtMoney(recurring, cur);
    $('price-per').textContent = '/ mo';
    if (sub) { sub.textContent = ''; sub.hidden = true; }
  }
  const cryptoAmt = Math.round(recurring * (1 - CRYPTO_DISCOUNT));
  const cryptoPrice = $('crypto-price');
  if (cryptoPrice) cryptoPrice.textContent = fmtMoney(cryptoAmt, cur);
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

async function recheck(btn) {
  if (btn) btn.disabled = true;
  showBanner('Checking…', 'ok');
  await reconcileSession();
  const me = await fetchMe();
  if (hasAccessFor(me)) {
    enterMember(me, { celebrate: true });
  } else {
    if (btn) btn.disabled = false;
    showBanner('Still finalizing. If this keeps happening, check your email for the receipt or contact us on Telegram — your access is safe.', 'warn');
  }
}

// Reveal the crypto purchase block only when the server has coins enabled.
// Crypto membership is a single prepaid 3-month block (no month/year toggle).
async function setupCrypto() {
  const box = $('crypto-box');
  const sel = $('crypto-coin');
  const btn = $('crypto-btn');
  const mount = $('crypto-mount');
  if (!box || !sel || !btn || !mount) return;
  const coins = await cryptoCoinOptions();
  if (!coins.length) return;
  sel.innerHTML = coins.map((c) => `<option value="${c}">${c}</option>`).join('');
  box.hidden = false;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    startCryptoCheckout({ kind: 'membership', coin: sel.value }, mount);
  });
}

async function render() {
  $('pay-card').addEventListener('click', (e) => startCheckout(primaryInterval, e.currentTarget));
  const payYear = $('pay-year');
  if (payYear) payYear.addEventListener('click', (e) => startCheckout('year', e.currentTarget));
  $('manage-btn').addEventListener('click', (e) => openPortal(e.currentTarget));
  $('recheck-btn')?.addEventListener('click', (e) => recheck(e.currentTarget));

  const status = params.get('status');
  if (status === 'cancel') showBanner('Checkout canceled — no charge was made.', 'warn');

  await applyConfig();
  let me = await fetchMe();

  if (status === 'success' && !isActive(me)) {
    showBanner('Payment received — activating your membership…', 'ok');
    // 1) Synchronous activation tied to THIS user's checkout session (no webhook
    //    dependency). 2) Re-read. 3) Short poll as a backstop.
    await reconcileSession();
    me = await fetchMe();
    if (!isActive(me)) me = await pollUntilActive(4);
  }

  const hasAccess = hasAccessFor(me);

  // Member (or just activated) with a destination → straight to the content.
  if (hasAccess && next) {
    showBanner('You’re all set — taking you to your video…', 'ok');
    enterMember(me);
    setTimeout(() => { location.href = next; }, 1200);
    return;
  }

  if (hasAccess) {
    enterMember(me, { celebrate: status === 'success' });
    return;
  }

  // Not a member. A successful payment must NEVER fall back to the sales offer.
  if (status === 'success') {
    showPending();
    return;
  }
  showPlans();
  setupCrypto();
}

render();
