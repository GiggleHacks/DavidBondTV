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
export async function startCryptoCheckout(opts, mount) {
  const r = await postJSON('/api/pay/crypto/checkout', opts);
  if (r.status === 401) { location.href = `/signup.html?next=${encodeURIComponent(location.pathname)}`; return; }
  if (r.status === 403) { location.href = '/profile-setup.html'; return; }
  if (!r.ok || !r.data || !r.data.orderId) {
    mount.innerHTML = `<p class="crypto-err">${(r.data && r.data.error) || 'Could not start a crypto order.'}</p>`;
    return;
  }
  const { orderId, coin, address, amount, qrPayload, expiresAt } = r.data;
  mount.innerHTML = `
    <div class="crypto-pay">
      <p>Send exactly <strong class="crypto-amt">${amount} ${coin}</strong> (${COIN_LABELS[coin] || coin}) to:</p>
      <code class="crypto-addr">${address}</code>
      <div class="crypto-qr"></div>
      <p class="crypto-status">Waiting for payment… <span class="crypto-clock"></span></p>
      <p class="crypto-hint">Send the <em>exact</em> amount from your own wallet. This page updates automatically.</p>
    </div>`;
  renderQR(mount.querySelector('.crypto-qr'), qrPayload);
  const clock = mount.querySelector('.crypto-clock');
  const statusEl = mount.querySelector('.crypto-status');

  const tick = setInterval(() => { clock.textContent = fmtCountdown(expiresAt - Date.now()); }, 1000);

  while (true) {
    await new Promise((res) => setTimeout(res, 5000));
    let s;
    try { s = await (await fetch(`/api/pay/crypto/order/${encodeURIComponent(orderId)}`)).json(); }
    catch { continue; }
    if (s.status === 'granted') {
      clearInterval(tick);
      statusEl.innerHTML = '✅ Payment received — unlocking your access…';
      await fetchMe();
      setTimeout(() => location.reload(), 1200);
      return;
    }
    if (s.status === 'underpaid') { statusEl.textContent = '⚠️ Amount didn’t match — we’ve been alerted and will sort it out.'; }
    if (s.status === 'expired' || Date.now() > expiresAt) {
      clearInterval(tick);
      statusEl.innerHTML = '⏳ This order expired. Refresh to start over.';
      return;
    }
  }
}

/** Fetch the server's enabled coins for building a picker. */
export async function cryptoCoinOptions() {
  try {
    const cfg = await (await fetch('/api/pay/crypto/config')).json();
    return cfg && cfg.enabled && Array.isArray(cfg.coins) ? cfg.coins : [];
  } catch { return []; }
}
