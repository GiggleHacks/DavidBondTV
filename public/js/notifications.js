// Notification bell for the site header. Signed-in viewers only: a 401 from
// /api/notifications (logged out) means we render nothing. Shows a red unread
// badge and a dropdown panel of "new video" items with relative timestamps,
// each linking to its watch page, with per-item dismiss and a "Clear all".
// Read/dismiss state is server-tracked per account (see lib/notifications-store.js).
(() => {
  const BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.25a1.25 1.25 0 0 1 1.25 1.25v.61a6.5 6.5 0 0 1 5.25 6.38v2.27l1.36 2.72A1.1 1.1 0 0 1 19.13 17H4.87a1.1 1.1 0 0 1-.99-1.52l1.37-2.72v-2.27A6.5 6.5 0 0 1 10.75 4.1V3.5A1.25 1.25 0 0 1 12 2.25Z"/><path d="M9.5 18.5a2.5 2.5 0 0 0 5 0Z"/></svg>';

  function timeAgo(ts) {
    let s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s} seconds ago`;
    const units = [
      [60, 'minute'], [60, 'hour'], [24, 'day'], [7, 'week'], [4.34, 'month'], [12, 'year'],
    ];
    let val = s / 60; let label = 'minute';
    for (let i = 0; i < units.length; i += 1) {
      label = units[i][1];
      if (i + 1 < units.length && val >= units[i + 1][0]) val /= units[i + 1][0];
      else break;
    }
    const n = Math.floor(val);
    return `${n} ${label}${n === 1 ? '' : 's'} ago`;
  }

  async function api(path, method = 'GET') {
    const res = await fetch(path, method === 'GET' ? {} : { method });
    return res;
  }

  function build() {
    const root = document.createElement('div');
    root.className = 'hdr-bell';
    root.innerHTML = `
      <button class="hdr-bell-btn" type="button" aria-label="Notifications" aria-haspopup="true">
        ${BELL}<span class="hdr-bell-badge" hidden></span>
      </button>
      <div class="hdr-bell-panel" hidden>
        <div class="bell-head"><span>Notifications</span><button class="bell-clear" type="button">Clear all</button></div>
        <div class="bell-list"></div>
      </div>`;
    return root;
  }

  function renderBadge(badge, unread) {
    if (unread > 0) { badge.textContent = unread > 99 ? '99+' : String(unread); badge.hidden = false; }
    else badge.hidden = true;
  }

  function renderList(listEl, notifications) {
    listEl.replaceChildren();
    if (!notifications.length) {
      const empty = document.createElement('div');
      empty.className = 'bell-empty';
      empty.textContent = 'No notifications yet.';
      listEl.appendChild(empty);
      return;
    }
    for (const n of notifications) {
      const isAccount = n.kind === 'account' || (!n.videoId && !!n.title);
      const item = document.createElement('div');
      item.className = `bell-item${n.read ? '' : ' unread'}${isAccount ? ' bell-account' : ''}${n.premiumLocked ? ` bell-premium-locked blur-${n.blur || 'medium'}` : ''}`;
      const link = document.createElement('a');
      link.className = 'bell-link';
      // Account notifications link to their target (default the account page);
      // video notifications link to the watch page.
      link.href = isAccount ? (n.link || '/account.html') : `/watch?v=${encodeURIComponent(n.videoId)}`;
      const icon = isAccount
        ? '<span class="bell-thumb bell-ico">🎉</span>'
        : (n.thumb ? `<img class="bell-thumb" loading="lazy" alt="" src="${n.thumb}" />` : '<span class="bell-thumb"></span>');
      link.innerHTML = `
        ${icon}
        <span class="bell-body">
          <span class="bell-title"></span>
          ${isAccount && n.body ? '<span class="bell-sub"></span>' : ''}
          <span class="bell-time"></span>
        </span>`;
      link.querySelector('.bell-title').textContent = isAccount ? n.title : `New video: ${n.title}`;
      if (isAccount && n.body) link.querySelector('.bell-sub').textContent = n.body;
      link.querySelector('.bell-time').textContent = timeAgo(n.ts);
      const x = document.createElement('button');
      x.className = 'bell-x';
      x.type = 'button';
      x.setAttribute('aria-label', 'Dismiss');
      x.textContent = '×';
      x.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        item.remove();
        try {
          await fetch('/api/notifications/dismiss', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: n.id }),
          });
        } catch { /* best-effort */ }
        if (!listEl.querySelector('.bell-item')) renderList(listEl, []);
      });
      const img = link.querySelector('img.bell-thumb');
      if (img) img.onerror = () => { img.replaceWith(Object.assign(document.createElement('span'), { className: 'bell-thumb' })); };
      item.append(link, x);
      listEl.appendChild(item);
    }
  }

  async function init() {
    const header = document.querySelector('.site-header');
    if (!header || header.querySelector('.hdr-bell')) return;

    let data;
    try {
      const res = await api('/api/notifications');
      if (res.status === 401) return; // logged out → no bell
      if (!res.ok) return;
      data = await res.json();
    } catch { return; }

    const root = build();
    const widget = header.querySelector('.auth-widget');
    if (widget) header.insertBefore(root, widget); else header.appendChild(root);

    const btn = root.querySelector('.hdr-bell-btn');
    const badge = root.querySelector('.hdr-bell-badge');
    const panel = root.querySelector('.hdr-bell-panel');
    const listEl = root.querySelector('.bell-list');

    let notifications = data.notifications || [];
    renderBadge(badge, data.unread || 0);

    const openPanel = async () => {
      renderList(listEl, notifications);
      panel.hidden = false;
      if ((data.unread || 0) > 0) {
        badge.hidden = true; data.unread = 0;
        notifications = notifications.map((n) => ({ ...n, read: true }));
        try { await fetch('/api/notifications/seen', { method: 'POST' }); } catch { /* best-effort */ }
      }
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel.hidden) openPanel(); else panel.hidden = true;
    });
    document.addEventListener('click', (e) => { if (!root.contains(e.target)) panel.hidden = true; });

    root.querySelector('.bell-clear').addEventListener('click', async () => {
      notifications = []; renderList(listEl, []); badge.hidden = true; data.unread = 0;
      try { await fetch('/api/notifications/clear', { method: 'POST' }); } catch { /* best-effort */ }
    });

    // Light poll so the badge updates when new videos are released while the page
    // is open. Skip refresh while the panel is open (don't yank items mid-read).
    setInterval(async () => {
      if (!panel.hidden) return;
      try {
        const res = await api('/api/notifications');
        if (!res.ok) return;
        const fresh = await res.json();
        notifications = fresh.notifications || [];
        data.unread = fresh.unread || 0;
        renderBadge(badge, data.unread);
      } catch { /* ignore */ }
    }, 60_000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
