// Crypto checkout panel: pick a coin, create an order, show address + exact amount
// + payment URI (QR when a QR lib is present), countdown, then poll order status
// until it flips to "granted". Mirrors the poll-after-return UX of course-buy.js.
import { fetchMe, postJSON } from '/js/account.js';

const COIN_LABELS = { ETH: 'Ethereum', LTC: 'Litecoin', XMR: 'Monero' };

function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function renderQR(container, payload) {
  container.innerHTML = '';
  if (typeof window.qrcode === 'function') {
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(payload);
      qr.make();
      container.innerHTML = qr.createImgTag(5, 8);
      return;
    } catch { /* fall through to text */ }
  }
  // Graceful fallback: show the wallet URI as selectable text (no QR lib loaded).
  const code = document.createElement('code');
  code.className = 'crypto-uri';
  code.textContent = payload;
  container.appendChild(code);
}

/**
 * Open a crypto order. `opts` = { kind:'product'|'membership', productId?, coin, couponCode? }.
 * `mount` is the element to render into.
 */
export async function startCryptoCheckout(opts, mount, btn = null) {
  const r = await postJSON('/api/pay/crypto/checkout', opts);
  if (r.status === 401) { location.href = `/signup.html?next=${encodeURIComponent(location.pathname)}`; return; }
  if (r.status === 403) { location.href = '/profile-setup.html'; return; }
  if (!r.ok || !r.data || !r.data.orderId) {
    mount.textContent = '';
    const err = document.createElement('p');
    err.className = 'crypto-err';
    err.textContent = (r.data && r.data.error) || 'Could not start a crypto order.';
    mount.append(err);
    if (btn) btn.disabled = false;
    return;
  }
  const { orderId, coin, address, amount, qrPayload, expiresAt } = r.data;

  mount.textContent = '';
  const wrap = document.createElement('div'); wrap.className = 'crypto-pay';

  const p1 = document.createElement('p');
  p1.append('Send exactly ');
  const amt = document.createElement('strong'); amt.className = 'crypto-amt';
  amt.textContent = `${amount} ${coin}`;
  p1.append(amt, ` (${COIN_LABELS[coin] || coin}) to:`);

  const addr = document.createElement('code'); addr.className = 'crypto-addr';
  addr.textContent = address;

  const qrBox = document.createElement('div'); qrBox.className = 'crypto-qr';

  const status = document.createElement('p'); status.className = 'crypto-status';
  status.append('Waiting for payment… ');
  const clockEl = document.createElement('span'); clockEl.className = 'crypto-clock';
  status.append(clockEl);

  const hint = document.createElement('p'); hint.className = 'crypto-hint';
  hint.textContent = 'Send the exact amount from your own wallet. This page updates automatically.';

  wrap.append(p1, addr, qrBox, status, hint);
  mount.append(wrap);

  renderQR(qrBox, qrPayload);
  const clock = clockEl;
  const statusEl = status;

  const tick = setInterval(() => { clock.textContent = fmtCountdown(expiresAt - Date.now()); }, 1000);

  while (true) {
    if (Date.now() > expiresAt) { clearInterval(tick); statusEl.textContent = '⏳ This order expired. Refresh to start over.'; return; }
    await new Promise((res) => setTimeout(res, 5000));
    let s = null;
    try { s = await (await fetch(`/api/pay/crypto/order/${encodeURIComponent(orderId)}`)).json(); } catch { s = null; }
    if (s && s.status === 'granted') {
      clearInterval(tick);
      statusEl.textContent = '✅ Payment received — unlocking your access…';
      await fetchMe();
      setTimeout(() => location.reload(), 1200);
      return;
    }
    if (s && s.status === 'underpaid') { statusEl.textContent = '⚠️ Amount didn’t match — we’ve been alerted and will sort it out.'; }
    if ((s && s.status === 'expired') || Date.now() > expiresAt) { clearInterval(tick); statusEl.textContent = '⏳ This order expired. Refresh to start over.'; return; }
  }
}

/** Fetch the server's enabled coins for building a picker. */
export async function cryptoCoinOptions() {
  try {
    const cfg = await (await fetch('/api/pay/crypto/config')).json();
    return cfg && cfg.enabled && Array.isArray(cfg.coins) ? cfg.coins : [];
  } catch { return []; }
}
