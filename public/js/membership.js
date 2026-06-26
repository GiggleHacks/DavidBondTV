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
import { startCryptoCheckout, cryptoConfig } from '/js/crypto-checkout.js';
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
// Card rail availability (server may hard-disable it, e.g. Stripe suspended). When
// false the Card option is hidden and Ethereum becomes the sole payment method.
let cardEnabled = true;

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

/**
 * Render the monthly card headline from live config. With an intro price we show
 * "<intro> first month" + a "then <recurring>/mo" note; otherwise the flat
 * monthly price.
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
    // Express the discount as "N months free" when it lands within ~half a month
    // of a whole-month saving (the usual framing); otherwise fall back to a %.
    const monthsFree = (month.amount * 12 - year.amount) / month.amount;
    const rounded = Math.round(monthsFree);
    if (rounded >= 1 && Math.abs(monthsFree - rounded) <= 0.5) {
      saveEl.textContent = `${rounded} month${rounded === 1 ? '' : 's'} free`;
    } else {
      saveEl.textContent = `save ${Math.round((1 - year.amount / (month.amount * 12)) * 100)}%`;
    }
    saveEl.hidden = false;
  } else if (saveEl) {
    saveEl.hidden = true;
  }
}

async function applyConfig() {
  let cfg = null;
  try { cfg = await (await fetch('/api/pay/stripe/config')).json(); } catch { /* default below */ }
  // cardEnabled is the explicit card-rail flag; fall back to legacy `enabled`.
  cardEnabled = !!(cfg && (cfg.cardEnabled !== undefined ? cfg.cardEnabled : cfg.enabled));
  // Card off: don't paint card pricing or show a discouraging banner here — ETH
  // may still be available; setupPaymentMethods() decides the final layout.
  if (!cardEnabled) return;
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

// USD formatter for crypto prepay plans (priceUsd comes as a plain number).
function fmtUsd(n) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: 'USD',
      minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    }).format(n);
  } catch { return `$${Number(n).toFixed(2)}`; }
}

/** Per-plan framing copy ("$19.69 × 3", "2 months free") — display only. */
function ethPlanFraming(plan) {
  if (plan.key === '3mo') {
    const per = plan.priceUsd / (plan.months || 3);
    return { meta: `${fmtUsd(Number(per.toFixed(2)))} × ${plan.months || 3} months · prepaid`, save: '' };
  }
  if (plan.key === 'year') {
    return { meta: 'Prepaid for 12 months', save: '2 months free' };
  }
  return { meta: `Prepaid for ${plan.months} months`, save: '' };
}

/**
 * Switch the active payment method tile + reveal its flow panel. `which` is
 * 'card' | 'eth'. The non-selected flow is hidden so only one is ever live.
 */
function selectMethod(which) {
  const cardTile = $('method-card');
  const ethTile = $('method-eth');
  const cardFlow = $('flow-card');
  const ethFlow = $('flow-eth');
  const on = (tile, sel) => { if (tile) { tile.classList.toggle('selected', sel); tile.setAttribute('aria-checked', sel ? 'true' : 'false'); } };
  on(cardTile, which === 'card');
  on(ethTile, which === 'eth');
  if (cardFlow) { cardFlow.hidden = which !== 'card'; if (which === 'card') cardFlow.classList.add('mb-flow-in'); }
  if (ethFlow) { ethFlow.hidden = which !== 'eth'; if (which === 'eth') ethFlow.classList.add('mb-flow-in'); }
}

/**
 * Build the ETH plan chooser from /api/pay/crypto/config and wire each plan to
 * start a crypto order. Only reveals the Ethereum method tile when the server
 * has crypto enabled with ETH in its coin list.
 */
async function setupPaymentMethods() {
  if (cardEnabled) {
    // Wire the Card tile and default-select it so a flow is visible on load.
    $('method-card')?.addEventListener('click', () => selectMethod('card'));
    selectMethod('card');
  } else {
    // Card rail is off (e.g. Stripe suspended) — hide all card chrome so nobody is
    // funnelled toward a dead processor. Also hide the card-specific price headline
    // and the auto-renew consent copy (ETH is a one-time prepay, no renewal).
    const hide = (el) => { if (el) el.hidden = true; };
    hide($('method-card')); hide($('flow-card'));
    hide(document.querySelector('#plans-view .mb-pricing'));
    hide(document.querySelector('#plans-view .mb-consent'));
  }

  const cfg = await cryptoConfig();
  const ethEnabled = cfg && Array.isArray(cfg.coins) && cfg.coins.includes('ETH');
  if (!ethEnabled) {
    // Nothing left to offer if the card rail is also off.
    if (!cardEnabled) showBanner('Payments are temporarily unavailable — please check back soon.', 'warn');
    return;
  }

  const ethTile = $('method-eth');
  const plansEl = $('eth-plans');
  const mount = $('crypto-mount');
  if (!ethTile || !plansEl || !mount) return;

  const plans = Array.isArray(cfg.membershipPlans) ? cfg.membershipPlans : [];
  if (!plans.length) return;

  const couponVal = () => ($('coupon-code') ? $('coupon-code').value.trim() : '');

  // Re-open the plan choice (clears the invoice) — used by the panel's "Start over".
  const showPlanChoice = () => { mount.textContent = ''; plansEl.hidden = false; };

  const startOrder = (plan) => {
    plansEl.hidden = true;
    startCryptoCheckout(
      { kind: 'membership', membershipPlan: plan.key, coin: 'ETH', couponCode: couponVal() },
      mount,
      showPlanChoice,
    );
  };

  plansEl.textContent = '';
  for (const plan of plans) {
    const { meta, save } = ethPlanFraming(plan);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'mb-eth-plan';
    const left = document.createElement('span'); left.className = 'mb-eth-plan-l';
    const name = document.createElement('span'); name.className = 'mb-eth-plan-name'; name.textContent = plan.label || `${plan.months} months`;
    const sub = document.createElement('span'); sub.className = 'mb-eth-plan-meta'; sub.textContent = meta;
    left.append(name, sub);
    const right = document.createElement('span'); right.className = 'mb-eth-plan-r';
    if (save) { const tag = document.createElement('span'); tag.className = 'mb-eth-plan-save'; tag.textContent = save; right.append(tag); }
    const price = document.createElement('span'); price.className = 'mb-eth-plan-price'; price.textContent = fmtUsd(plan.priceUsd);
    right.append(price);
    btn.append(left, right);
    btn.addEventListener('click', () => startOrder(plan));
    plansEl.append(btn);
  }

  ethTile.hidden = false;
  ethTile.addEventListener('click', () => { selectMethod('eth'); showPlanChoice(); });

  // Card off → Ethereum is the only rail: drop the now-pointless one-option picker
  // and open the ETH plan chooser straight away.
  if (!cardEnabled) {
    const picker = document.querySelector('#plans-view .mb-pay');
    if (picker) picker.hidden = true;
    selectMethod('eth');
    showPlanChoice();
  }
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
  setupPaymentMethods();
}

render();
