// Crypto checkout panel (BTCPay-style invoice): create an order, then render a
// clean payment panel — Ethereum mark, "Awaiting payment…" header with a live
// countdown, a scannable QR, the exact amount + wallet address (each copyable),
// and a live status driven by polling /api/pay/crypto/order/:id until it flips to
// "granted". Mirrors the poll-after-return UX of the Stripe flow.
//
// SECURITY: every dynamic value (address, amount, status text) is set via
// textContent / createElement — never innerHTML — so a malicious order payload
// can't inject markup.
import { fetchMe, postJSON } from '/js/account.js';
import { trackEvent } from '/js/analytics-client.js';

const COIN_LABELS = { ETH: 'Ethereum', LTC: 'Litecoin', XMR: 'Monero' };
const POLL_MS = 4500;

function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function truncMiddle(s, head = 10, tail = 8) {
  if (typeof s !== 'string' || s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Inline Ethereum diamond mark (brand color #627EEA). */
function ethLogo() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'crypto-logo');
  svg.setAttribute('viewBox', '0 0 256 417');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Ethereum');
  const paths = [
    ['#627EEA', 'M127.96 0l-2.8 9.5v275.7l2.8 2.8 127.96-75.6z'],
    ['#8197EE', 'M127.96 0L0 212.4l127.96 75.6V154.2z'],
    ['#627EEA', 'M127.96 312.19l-1.58 1.92v98.2l1.58 4.61L256 236.59z'],
    ['#8197EE', 'M127.96 416.92v-104.73L0 236.59z'],
    ['#3C3C3B', 'M127.96 288.0l127.96-75.6-127.96-58.2z'],
    ['#5a6da4', 'M0 212.4l127.96 75.6V154.2z'],
  ];
  for (const [fill, d] of paths) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('fill', fill);
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

function icon(paths, { stroke = true } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    if (stroke) { p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); }
    svg.appendChild(p);
  }
  return svg;
}

function renderQR(container, payload) {
  container.textContent = '';
  if (typeof window.qrcode === 'function') {
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(payload);
      qr.make();
      // createImgTag returns a trusted <img> built from the lib (no order data
      // in markup); the payload is encoded into the pixel matrix, not the DOM.
      container.innerHTML = qr.createImgTag(6, 0);
      return;
    } catch { /* fall through to text */ }
  }
  // Graceful fallback: show the wallet URI as selectable text (no QR lib loaded).
  const code = document.createElement('code');
  code.className = 'crypto-uri';
  code.textContent = payload;
  container.appendChild(code);
}

/** A labelled value row with a copy button (BTCPay-style). */
function copyField(label, displayText, copyText, { amount = false } = {}) {
  const field = document.createElement('div'); field.className = 'crypto-field';
  const lab = document.createElement('div'); lab.className = 'crypto-field-label'; lab.textContent = label;
  const row = document.createElement('div'); row.className = 'crypto-field-row';
  const val = document.createElement('span');
  val.className = `crypto-field-val${amount ? ' amount' : ''}`;
  val.textContent = displayText;
  val.title = copyText;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'crypto-copy';
  const copyIcon = icon(['M9 9h11v11H9z', 'M5 15H4V4h11v1'], { stroke: true });
  const lbl = document.createElement('span'); lbl.textContent = 'Copy';
  btn.append(copyIcon, lbl);
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(copyText); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = copyText; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    btn.classList.add('copied'); lbl.textContent = 'Copied';
    setTimeout(() => { btn.classList.remove('copied'); lbl.textContent = 'Copy'; }, 1500);
  });
  row.append(val, btn);
  field.append(lab, row);
  return field;
}

/** Build the wallet-URI QR payload from order fields (used when resuming). */
function buildQrPayload(coin, address, amount) {
  if (coin === 'ETH') return `ethereum:${address}?value=${amount}`;
  if (coin === 'LTC') return `litecoin:${address}?amount=${amount}`;
  return `monero:${address}?tx_amount=${amount}`;
}

/**
 * Start a NEW crypto order, then render the invoice panel.
 *
 * `opts` = { kind:'product'|'membership', productId?, membershipPlan?, coin, couponCode? }.
 * `mount` is the element to render into.
 * `onExpire` (optional) is called when the order expires (or the user taps
 *   "Start over") so the caller can re-open the plan choice.
 */
export async function startCryptoCheckout(opts, mount, onExpire = null) {
  mount.textContent = '';
  const loading = document.createElement('p');
  loading.className = 'crypto-status detecting';
  const sp = document.createElement('span'); sp.className = 'crypto-spinner';
  loading.append(sp, 'Creating your order…');
  mount.append(loading);

  trackEvent('checkout_started', { provider: 'crypto', productId: opts.productId || '', metadata: { kind: opts.kind || '' } });
  const r = await postJSON('/api/pay/crypto/checkout', opts);
  if (r.status === 401) {
    // Anonymous: sign up first, then resume this rail on return (&start=eth) instead
    // of landing back on the offer. Emit the error so the bounce stays measurable.
    trackEvent('checkout_error', { provider: 'crypto', productId: opts.productId || '', metadata: { kind: opts.kind || '', status: 401 } });
    const p = new URLSearchParams(location.search);
    p.set('start', 'eth');
    const here = `${location.pathname}?${p}`;
    try { localStorage.setItem('dbtv_after_auth', here); } catch { /* ignore */ }
    location.href = `/signup.html?next=${encodeURIComponent(here)}`;
    return;
  }
  if (!r.ok || !r.data || !r.data.orderId) {
    trackEvent('checkout_error', { provider: 'crypto', productId: opts.productId || '', metadata: { kind: opts.kind || '', status: r.status } });
    mount.textContent = '';
    const err = document.createElement('p');
    err.className = 'crypto-err';
    err.textContent = (r.data && r.data.error) || 'Could not start a crypto order. Please try again.';
    mount.append(err);
    return;
  }
  trackEvent('crypto_order_created', { provider: 'crypto', productId: opts.productId || '', metadata: { kind: opts.kind || '', orderId: r.data.orderId } });
  renderInvoice({ ...r.data, status: 'waiting' }, mount, onExpire);
}

/**
 * Resume an EXISTING in-flight order's invoice panel after the buyer closed the
 * page. `order` = { orderId, coin, address, amount, expiresAt, status } (from
 * GET /api/pay/crypto/order/open or ?order=<id>). Rebuilds the QR from fields.
 */
export function resumeCryptoCheckout(order, mount, onExpire = null) {
  renderInvoice(order, mount, onExpire);
}

/**
 * Render the BTCPay-style invoice panel and poll the order to completion. Shared
 * by both a fresh checkout and a resume. SECURITY: every dynamic value is set via
 * textContent / createElement — never innerHTML (except the QR lib's own <img>).
 */
function renderInvoice(order, mount, onExpire = null) {
  const { orderId, coin, address, amount, expiresAt } = order;
  const qrPayload = order.qrPayload || buildQrPayload(coin, address, amount);
  const coinName = COIN_LABELS[coin] || coin;
  // detected/confirmed = payment already seen on-chain (valid even past expiry).
  let advanced = order.status === 'detected' || order.status === 'confirmed';

  mount.textContent = '';
  const wrap = document.createElement('div'); wrap.className = 'crypto-pay crypto-flow-in';

  // Header: ETH mark + state + countdown
  wrap.append(ethLogo());
  const head = document.createElement('h3'); head.className = 'crypto-state-head';
  head.textContent = 'Awaiting payment…';
  const countdown = document.createElement('p'); countdown.className = 'crypto-countdown';
  countdown.append(icon(['M12 7v5l3 2', 'M12 21a9 9 0 100-18 9 9 0 000 18z'], { stroke: true }));
  const clock = document.createElement('span'); clock.className = 'crypto-clock';
  countdown.append('Expires in ', clock);
  wrap.append(head, countdown);

  // QR
  const qrBox = document.createElement('div'); qrBox.className = 'crypto-qr';
  wrap.append(qrBox);

  // Copyable fields: amount + address
  const fields = document.createElement('div'); fields.className = 'crypto-fields';
  fields.append(
    copyField(`Amount (${coinName})`, `${amount} ${coin}`, String(amount), { amount: true }),
    copyField('Send to address', truncMiddle(address), address),
  );
  wrap.append(fields);

  // Live status banner
  const status = document.createElement('p'); status.className = 'crypto-status';
  const setStatus = (text, kind, { spinner = false, check = false } = {}) => {
    status.className = `crypto-status${kind ? ' ' + kind : ''}`;
    status.textContent = '';
    if (spinner) { const s = document.createElement('span'); s.className = 'crypto-spinner'; status.append(s); }
    if (check) { const c = icon(['M5 13l4 4L19 7'], { stroke: true }); c.setAttribute('class', 'crypto-check'); status.append(c); }
    status.append(text);
  };
  setStatus(`Send exactly ${amount} ${coin} from your wallet to the address above.`, '');
  wrap.append(status);

  // Persistent reassurance — sets time expectations + that they can leave the page.
  const note = document.createElement('p'); note.className = 'crypto-note';
  note.textContent = 'After you send, payments usually confirm within a few minutes (up to ~10 when the network is busy). You can safely close this page — we’ll email you when it lands, and you can return to this page anytime.';
  wrap.append(note);

  mount.append(wrap);
  renderQR(qrBox, qrPayload);

  let finished = false;
  const finish = () => { finished = true; clearInterval(tick); };
  const startedAt = Date.now();

  const showExpired = () => {
    finish();
    head.textContent = 'Order expired';
    countdown.hidden = true;
    note.hidden = true;
    setStatus('This order expired — no funds were sent. Start over to get a fresh address.', 'warn');
    const restart = document.createElement('button');
    restart.type = 'button';
    restart.className = 'acc-btn acc-btn-ghost crypto-restart';
    restart.textContent = 'Start over';
    restart.addEventListener('click', () => { if (typeof onExpire === 'function') onExpire(); else location.reload(); });
    wrap.append(restart);
  };

  const showDetected = () => {
    advanced = true;
    trackEvent('payment_detected', { provider: 'crypto', metadata: { orderId } });
    head.textContent = 'Payment detected ✓';
    countdown.hidden = true; // expiry no longer applies once funds are seen
    note.textContent = 'No need to wait here — we’ve emailed you a link to come back to this page. We’ll unlock your access automatically the moment it confirms.';
    setStatus('Seen on-chain — confirming now. This usually takes a couple of minutes.', 'detecting', { spinner: true });
  };

  const tick = setInterval(() => {
    if (advanced) return; // detected: no countdown / no expiry
    const left = expiresAt - Date.now();
    clock.textContent = fmtCountdown(left);
    countdown.classList.toggle('urgent', left > 0 && left < 120000);
    if (left <= 0 && !finished) showExpired();
  }, 1000);
  clock.textContent = fmtCountdown(expiresAt - Date.now());

  if (advanced) showDetected(); // resumed straight into the detected state

  // Poll order status until terminal (fire-and-forget so resume can be sync).
  (async () => {
    let waitedMsg = false;
    while (!finished) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      if (finished) break;
      if (!advanced && Date.now() > expiresAt) { showExpired(); break; }

      let s = null;
      try { s = await (await fetch(`/api/pay/crypto/order/${encodeURIComponent(orderId)}`)).json(); }
      catch { s = null; }
      if (!s || finished) continue;

      if (s.status === 'granted') {
        finish();
        trackEvent('payment_granted', { provider: 'crypto', metadata: { orderId } });
        head.textContent = 'Payment received';
        countdown.hidden = true; note.hidden = true;
        qrBox.style.opacity = '.35';
        setStatus('Payment confirmed — unlocking your access…', 'ok', { check: true });
        await fetchMe();
        setTimeout(() => location.reload(), 1300);
        break;
      }
      if (s.status === 'detected' || s.status === 'confirmed') {
        if (!advanced) showDetected();
        continue;
      }
      if (s.status === 'underpaid') {
        finish();
        head.textContent = 'Amount didn’t match';
        countdown.hidden = true; note.hidden = true;
        setStatus('The amount didn’t match — we’ve been notified and will sort it out. Contact us on Telegram if you need a hand.', 'warn');
        break;
      }
      if (s.status === 'expired') { showExpired(); break; }
      // status === 'waiting': add one gentle reassurance after the first ~45s.
      if (!waitedMsg && !advanced && Date.now() - startedAt > 45000) {
        waitedMsg = true;
        setStatus(`Still waiting to see your transaction. If you’ve already sent the ${coin}, it can take a minute or two to appear on-chain — you can leave this page.`, '');
      }
    }
  })();
}

/** Fetch the server's enabled coins for building a picker. */
export async function cryptoCoinOptions() {
  try {
    const cfg = await (await fetch('/api/pay/crypto/config')).json();
    return cfg && cfg.enabled && Array.isArray(cfg.coins) ? cfg.coins : [];
  } catch { return []; }
}

/** Full crypto config ({ enabled, coins, membershipPlans, productDiscountPercent }) or null. */
export async function cryptoConfig() {
  try {
    const cfg = await (await fetch('/api/pay/crypto/config')).json();
    return cfg && cfg.enabled ? cfg : null;
  } catch { return null; }
}
