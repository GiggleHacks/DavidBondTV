// Paid-membership page (membership.html): shows the premium offer to non-members
// and a "Manage billing" button to members.
//
// The "Card" method points at WHOP (the card rail that replaced suspended Stripe):
// clicking it creates a WHOP checkout server-side and redirects to WHOP's hosted
// page. "Ethereum" is the self-hosted crypto rail. Either may be hidden if the
// server reports it disabled.
//
// Flow: the page may carry ?next=<video> so that after a successful checkout we
// send the user straight back to the content they wanted. WHOP redirects to
// ?status=success&next=…. We activate SYNCHRONOUSLY by posting to
// /api/pay/whop/reconcile (so activation never depends on the webhook), then fall
// back to a short poll. A successful payment NEVER re-shows the sales offer — at
// worst it shows a "finalizing" state with a "Check again" button.
import { fetchMe, postJSON } from '/js/account.js';
import { startCryptoCheckout, resumeCryptoCheckout, cryptoConfig } from '/js/crypto-checkout.js';
import { deriveBillingView } from '/js/billing-view.js';
import { initTheme } from '/js/theme.js';
import { ADMIN_PATHS } from '/js/admin-paths.js';

initTheme();

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const rawNext = params.get('next');
const next = (rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//')) ? rawNext : '';
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
  // No in-app billing portal anymore (Stripe removed): WHOP members manage their
  // subscription on whop.com; crypto memberships are prepaid with no auto-renew.
  const manage = $('manage-btn');
  if (manage) manage.hidden = true;
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

/**
 * WHOP redirect carries no session id, so on return we ask the server to pull the
 * buyer's membership straight from WHOP and grant it — the webhook's safety net.
 */
async function reconcileWhop() {
  const r = await postJSON('/api/pay/whop/reconcile', {});
  return r && r.ok ? r.data : null;
}

/** Start a WHOP checkout for the membership plan and redirect to the hosted page. */
async function startWhopCheckout(btn) {
  setMsg('');
  btn.disabled = true;
  const r = await postJSON('/api/pay/whop/checkout', { next });
  if (r.ok && r.data.url) { location.href = r.data.url; return; }
  if (r.status === 401) {
    // Not signed in → sign up/in first, then return to this offer (with next intact).
    const here = location.pathname + location.search;
    try { localStorage.setItem('dbtv_after_auth', here); } catch { /* ignore */ }
    location.href = `/signup.html?next=${encodeURIComponent(here)}`;
    return;
  }
  if (r.status === 403) { location.href = `/profile-setup.html`; return; }
  if (r.status === 409) {
    setMsg('You already have an active membership.', 'ok');
    btn.disabled = false;
    return;
  }
  setMsg((r.data && r.data.error) || 'Could not start checkout. Please try again.', 'error');
  btn.disabled = false;
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
  // Lead with the ongoing monthly price; when the first charge differs (WHOP bills a
  // higher first month), note it accurately underneath instead of mislabeling it /mo.
  $('price-amount').textContent = fmtMoney(recurring, cur);
  $('price-per').textContent = '/ mo';
  if (!sub) return;
  if (intro && intro.amount > 0 && intro.amount !== recurring) {
    sub.textContent = `${fmtMoney(intro.amount, cur)} for your first month, then ${fmtMoney(recurring, cur)}/mo`;
    sub.hidden = false;
  } else {
    sub.textContent = '';
    sub.hidden = true;
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
  try { cfg = await (await fetch('/api/pay/whop/config')).json(); } catch { /* default below */ }
  // cardEnabled is the explicit card-rail flag; fall back to legacy `enabled`.
  cardEnabled = !!(cfg && (cfg.cardEnabled !== undefined ? cfg.cardEnabled : cfg.enabled));
  // Card off: don't paint card pricing or show a discouraging banner here — ETH
  // may still be available; setupPaymentMethods() decides the final layout.
  if (!cardEnabled) return;
  // WHOP bills a higher first charge ($28) then the recurring monthly ($19.69). Lead
  // with the recurring price; pass the first charge as the "intro" so the sub-line
  // reads "$28 for your first month, then $19.69/mo". The plan is monthly → no yearly.
  const cur = cfg.currency || 'usd';
  const first = cfg && typeof cfg.price === 'number' ? cfg.price : null;          // first charge
  const recurring = cfg && typeof cfg.renewalPrice === 'number' ? cfg.renewalPrice : first; // ongoing
  if (recurring !== null) {
    setCardPricing(
      { amount: Math.round(recurring * 100), currency: cur },
      (first !== null && first !== recurring) ? { amount: Math.round(first * 100) } : null,
    );
  }
  setYearly(null, null);
}

async function recheck(btn) {
  if (btn) btn.disabled = true;
  showBanner('Checking…', 'ok');
  await reconcileWhop();
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

/**
 * Per-plan marketing framing (display only). `baseMonthly` is the cheapest per-month
 * rate across plans (the 3-month); the annual's "N months free" + dollar saving are
 * derived from it so the numbers are always honest and self-consistent.
 */
function ethPlanFraming(plan, baseMonthly) {
  const months = plan.months || 1;
  const perMo = fmtUsd(Number((plan.priceUsd / months).toFixed(2)));
  if (months >= 12) {
    const saved = Math.max(0, Math.round(baseMonthly * months - plan.priceUsd));
    const monthsFree = baseMonthly > 0 ? Math.round((baseMonthly * months - plan.priceUsd) / baseMonthly) : 0;
    return {
      best: true,
      ribbon: 'Best value',
      pill: monthsFree > 0 ? `${monthsFree} months free` : 'Best deal',
      meta: saved > 0 ? `Just ${perMo}/mo · save $${saved}/yr` : `Just ${perMo}/mo`,
    };
  }
  return { best: false, tag: months <= 3 ? 'Minimum' : '', meta: `${perMo}/mo · no signup fee` };
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

  // Re-open the plan choice (clears the invoice) — used by the panel's "Start over".
  const showPlanChoice = () => { mount.textContent = ''; plansEl.hidden = false; };

  const startOrder = (plan) => {
    plansEl.hidden = true;
    startCryptoCheckout(
      { kind: 'membership', membershipPlan: plan.key, coin: 'ETH' },
      mount,
      showPlanChoice,
    );
  };

  plansEl.textContent = '';
  // Standard (undiscounted) monthly rate = the HIGHEST per-month across plans, i.e. the
  // short 3-month plan's rate. The annual is cheaper per month, so its savings are
  // measured against this — not against itself (Math.min would zero the discount out).
  const baseMonthly = Math.max(...plans.map((p) => p.priceUsd / (p.months || 1)));
  // Best value (most months) first so the annual anchors the choice.
  const ordered = plans.slice().sort((a, b) => (b.months || 0) - (a.months || 0));
  for (const plan of ordered) {
    const f = ethPlanFraming(plan, baseMonthly);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = f.best ? 'mb-eth-plan mb-eth-plan--best' : 'mb-eth-plan';
    if (f.ribbon) {
      const ribbon = document.createElement('span');
      ribbon.className = 'mb-eth-ribbon'; ribbon.textContent = f.ribbon;
      btn.append(ribbon);
    }
    const left = document.createElement('span'); left.className = 'mb-eth-plan-l';
    const name = document.createElement('span'); name.className = 'mb-eth-plan-name';
    name.textContent = plan.label || `${plan.months} months`;
    const meta = document.createElement('span'); meta.className = 'mb-eth-plan-meta'; meta.textContent = f.meta;
    left.append(name, meta);
    const right = document.createElement('span'); right.className = 'mb-eth-plan-r';
    if (f.pill) { const pill = document.createElement('span'); pill.className = 'mb-eth-plan-save'; pill.textContent = f.pill; right.append(pill); }
    else if (f.tag) { const tag = document.createElement('span'); tag.className = 'mb-eth-plan-min'; tag.textContent = f.tag; right.append(tag); }
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

  // Resume an in-flight ETH order so a closed tab isn't lost — via the email link
  // (?order=<id>) or any open order on this account. Takes over the ETH panel.
  try {
    const orderParam = params.get('order');
    let active = null;
    if (orderParam) {
      const s = await (await fetch(`/api/pay/crypto/order/${encodeURIComponent(orderParam)}`)).json();
      if (s && ['waiting', 'detected', 'confirmed'].includes(s.status)) {
        active = { orderId: orderParam, coin: s.coin, address: s.address, amount: s.amount, expiresAt: s.expiresAt, status: s.status };
      }
    } else {
      const r = await (await fetch('/api/pay/crypto/order/open')).json();
      if (r && r.order && r.order.kind === 'membership') active = r.order;
    }
    if (active) {
      selectMethod('eth');
      plansEl.hidden = true;
      resumeCryptoCheckout(active, mount, showPlanChoice);
    }
  } catch { /* no resume — fall back to the normal plan chooser */ }
}

async function render() {
  // The Card button now starts a WHOP checkout (Stripe is suspended). WHOP's plan
  // is monthly-only, so the yearly button isn't shown.
  $('pay-card').addEventListener('click', (e) => startWhopCheckout(e.currentTarget));
  $('recheck-btn')?.addEventListener('click', (e) => recheck(e.currentTarget));

  const status = params.get('status');
  if (status === 'cancel') showBanner('Checkout canceled — no charge was made.', 'warn');

  await applyConfig();
  let me = await fetchMe();

  if (status === 'success' && !isActive(me)) {
    showBanner('Payment received — activating your membership…', 'ok');
    // Synchronous activation, no webhook dependency: ask the server to pull the
    // membership straight from WHOP, re-read, then short-poll as a backstop while
    // the webhook catches up.
    await reconcileWhop();
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
