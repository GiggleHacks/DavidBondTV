// Standalone course landing page (course.html). Renders one product's branding,
// sales copy and price, and a one-time purchase button. Also the Stripe
// success_url / cancel_url target: on ?status=success the webhook may lag, so we
// poll /api/auth/me until the entitlement lands, then send the buyer to `next`
// (the video they wanted) or into the course view.
import { fetchMe } from '/js/account.js';
import { pollOwnership, fmtMoney } from '/js/course-buy.js';
import { startCryptoCheckout, resumeCryptoCheckout, cryptoCoinOptions } from '/js/crypto-checkout.js';
import { initTheme } from '/js/theme.js';

initTheme();

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const slug = params.get('slug') || '';
const status = params.get('status');
const rawNext = params.get('next');
const next = (rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//')) ? rawNext : '';

const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';

function banner(text, kind) {
  const b = $('banner');
  if (!text) { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = text;
  b.className = `cl-banner ${kind || ''}`.trim();
}

function paintBranding(product) {
  const root = $('course-root');
  const b = product.branding || {};
  root.style.setProperty('--course-primary', b.primary || '#7c3aed');
  root.style.setProperty('--course-accent', b.accent || '#22d3ee');
  // When the course ships a hero background image, paint it behind the hero so a
  // branded (e.g. black "hacker") backdrop replaces the default colour gradient.
  if (b.bgImage) {
    const hero = document.getElementById('hero');
    hero.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,.35), rgba(0,0,0,.7)), url('${b.bgImage}')`;
    hero.style.backgroundSize = 'cover';
    hero.style.backgroundPosition = 'center';
  }
  if (b.logo) { $('cl-logo').src = b.logo; $('cl-logo').hidden = false; }
  $('cl-name').textContent = product.name || 'Course';
  const sales = product.sales || {};
  $('cl-headline').textContent = sales.headline || '';
  $('cl-body').textContent = sales.body || product.description || '';
  $('cl-price').textContent = fmtMoney(product.price, product.currency);
  const benefits = (sales.bullets && sales.bullets.length)
    ? sales.bullets
    : ['Full course — every video included', 'Instant lifetime access', 'One-time payment, no membership'];
  $('cl-benefits').innerHTML = benefits
    .map((t) => `<li><span class="cl-check">${CHECK}</span><span></span></li>`).join('');
  [...$('cl-benefits').querySelectorAll('li > span:last-child')].forEach((el, i) => { el.textContent = benefits[i]; });
}

function showOwned() {
  $('buy-btn').hidden = true;
  const box = $('crypto-box');
  if (box) box.hidden = true;
  $('owned-view').hidden = false;
}

// Reveal the "Pay with crypto" picker only when the server has coins enabled.
async function setupCrypto(product) {
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
    startCryptoCheckout({ kind: 'product', productId: product.id, coin: sel.value }, mount);
  });

  // Resume an in-flight order for this course (email link ?order=id, or an open
  // order on this account) so a closed tab isn't lost.
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
      if (r && r.order && r.order.kind === 'product' && r.order.productSlug === slug) active = r.order;
    }
    if (active) { sel.hidden = true; btn.hidden = true; resumeCryptoCheckout(active, mount); }
  } catch { /* no resume — show the normal pay button */ }
}

// Load the course trailer (a free, published video) into the hero player. Pulls
// the playback manifest for the trailer id and points a native <video> at the
// best available mp4 rendition. Best-effort: any failure just leaves it hidden.
async function loadTrailer(product) {
  const trailerId = product && product.trailer;
  if (!trailerId) return;
  try {
    const res = await fetch(`/api/videos/${encodeURIComponent(trailerId)}/playback`);
    if (!res.ok) return;
    const { video } = await res.json();
    const levels = (video && Array.isArray(video.qualityLevels)) ? video.qualityLevels : [];
    if (!levels.length) return;
    // Highest-resolution rendition first (native <video> can't adapt; just pick best).
    const best = levels.slice().sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    if (!best || !best.url) return;
    const el = document.getElementById('cl-trailer-video');
    const bg = product.branding && product.branding.bgImage;
    if (bg) el.poster = bg;
    el.muted = true;       // muted autoplay is allowed by browsers
    el.autoplay = true;
    el.src = best.url;
    document.getElementById('cl-trailer').hidden = false;
    el.play().catch(() => { /* autoplay blocked → controls stay, viewer can press play */ });
  } catch { /* no trailer → hero just shows logo + copy */ }
}

async function render() {
  if (!slug) { $('notfound').hidden = false; return; }
  let product = null;
  try { product = (await (await fetch(`/api/products/${encodeURIComponent(slug)}`)).json()).product; } catch { /* below */ }
  if (!product) { $('notfound').hidden = false; return; }

  paintBranding(product);
  loadTrailer(product);
  // The owned-state "Browse the course" link must land on THIS course's lesson
  // grid, not the generic homepage.
  $('watch-link').href = `/videos?section=courses&category=${encodeURIComponent(product.slug)}`;
  $('content').hidden = false;
  document.title = `${product.name} — David Bond TV`;

  // Card rail removed — products are purchased with crypto (ETH) via the box below.
  const buy = $('buy-btn');
  if (buy) buy.hidden = true;
  setupCrypto(product);

  if (status === 'cancel') banner('Checkout canceled — no charge was made.', 'warn');

  let me = await fetchMe();
  const owns = (u) => !!(u && Array.isArray(u.ownedProductIds) && u.ownedProductIds.includes(product.id));
  const isAdmin = !!(me && Array.isArray(me.roles) && me.roles.includes('admin'));

  if (status === 'success' && !owns(me)) {
    banner('Payment received — unlocking your course…', 'ok');
    me = await pollOwnership(product.id);
  }

  if (owns(me) || isAdmin) {
    // Already owns it (or just bought it). If they came from a specific video,
    // bounce straight back; otherwise offer the course view.
    if (next) { banner('You’re all set — taking you to your video…', 'ok'); setTimeout(() => { location.href = next; }, 1000); }
    else if (status === 'success') banner('You’re all set — enjoy the course!', 'ok');
    showOwned();
  }
}

render();
