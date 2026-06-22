// Watch-page Subscribe (free follow) button. Shows current state from
// /api/subscribe/status; toggles via /api/subscribe / /api/unsubscribe. Visible to
// everyone (anonymous users are prompted to sign in on click).
import { fetchMe } from './account.js';

const btn = document.getElementById('sub-btn');
const countEl = document.getElementById('sub-count');
if (btn) {
  let subscribed = false;
  let signedIn = false;

  const fmt = (n) => (n === 1 ? '1 subscriber' : `${n.toLocaleString()} subscribers`);

  function paint(count) {
    btn.hidden = false;
    btn.textContent = subscribed ? 'Subscribed' : 'Subscribe';
    btn.classList.toggle('is-subbed', subscribed);
    if (countEl && typeof count === 'number') countEl.textContent = fmt(count);
  }

  async function refresh() {
    try {
      const s = await (await fetch('/api/subscribe/status')).json();
      subscribed = !!s.subscribed;
      paint(s.count);
    } catch { btn.hidden = false; paint(); }
  }

  btn.addEventListener('click', async () => {
    if (!signedIn) { window.location.href = '/login.html'; return; }
    btn.disabled = true;
    try {
      const path = subscribed ? '/api/unsubscribe' : '/api/subscribe';
      const r = await (await fetch(path, { method: 'POST' })).json();
      if (r && r.ok) { subscribed = r.subscribed; paint(r.count); }
    } catch { /* ignore */ } finally { btn.disabled = false; }
  });

  (async () => {
    const me = await fetchMe();
    signedIn = !!me;
    await refresh();
  })();
}
