// User management: searchable list → click a user for a detail page with
// profile, IPs, country, subscription, viewing history, watch time, password/
// recovery status, a password-reset form, and block/unblock.
import { flagIcon } from './world-data.js';
import { requireAdmin } from './god-auth.js';

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { location.reload(); throw new Error('unauth'); }
  return res.json().catch(() => ({}));
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString() : '—');
function fmtAgo(t) {
  if (!t) return 'Never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

let allUsers = [];
let hiddenUnverified = 0;
let currentFilter = 'verified';

// Deterministic avatar tint from a name so each user has a stable colour chip.
function tint(str) {
  let h = 0; const s = String(str || '?');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h} 52% 42%)`;
}
function avatar(u, cls = '') {
  const name = u.username || u.email || '?';
  const initial = esc((name.trim().charAt(0) || '?').toUpperCase());
  return `<span class="uavatar ${cls}" style="background:${tint(name)}">${initial}</span>`;
}
function statusBadges(u, { admin = false } = {}) {
  const out = [];
  if (admin) out.push('<span class="badge adm">Admin</span>');
  if (u.blocked) out.push('<span class="badge blk">Blocked</span>');
  if (u.subscribed) out.push('<span class="badge sub">Member</span>');
  else out.push('<span class="badge none">Free</span>');
  if (u.verified === false) out.push('<span class="badge warn">Unverified</span>');
  return out.join(' ');
}

function renderList(filter = '') {
  const f = filter.toLowerCase();
  const rows = allUsers.filter((u) => !f || (u.username || '').toLowerCase().includes(f) || (u.email || '').toLowerCase().includes(f));
  $('ucount').textContent = `(${rows.length})`;
  const totalMinutes = allUsers.reduce((sum, u) => sum + (u.minutesWatched || 0), 0);
  $('ui-total').textContent = allUsers.length.toLocaleString();
  $('ui-members').textContent = allUsers.filter((u) => u.subscribed).length.toLocaleString();
  $('ui-blocked').textContent = allUsers.filter((u) => u.blocked).length.toLocaleString();
  $('ui-watch').textContent = `${totalMinutes.toLocaleString()}m`;
  const list = $('user-list');
  if (!rows.length) { list.innerHTML = '<p class="muted">No users.</p>'; return; }
  list.innerHTML = '';
  for (const u of rows) {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      ${avatar(u)}
      <span class="uname" data-label="User"><span class="un-main">${esc(u.username || '—')}</span><span class="un-sub">${esc(u.email || '')} · ${fmtAgo(u.lastSeen)}</span></span>
      <span class="ucountry" data-label="Country">${u.country ? flagIcon(u.country) + ' ' + u.country : '<span class="muted">—</span>'}</span>
      <span class="uwatched" data-label="Watched">${u.videosWatched} vids · ${u.minutesWatched}m</span>
      <span class="ustatus" data-label="Status">${statusBadges(u)}</span>`;
    row.addEventListener('click', () => showDetail(u.id));
    list.appendChild(row);
  }
}

async function showDetail(id) {
  $('list-view').classList.add('hidden');
  $('detail-view').classList.remove('hidden');
  $('detail').innerHTML = '<p class="muted">Loading…</p>';
  const d = await api(`/api/admin/users/${encodeURIComponent(id)}`);
  const u = d.user; const s = d.stats;
  const history = d.history.length
    ? d.history.map((h) => `<div class="tr"><span class="name"><a href="/watch?v=${encodeURIComponent(h.id)}" target="_blank">${esc(h.title)}</a></span><span class="num">${h.minutes}m</span></div>`).join('')
    : '<div class="tr"><span class="muted">No viewing history.</span></div>';
  const activity = (d.activity || []).length
    ? (d.activity || []).map((a) => `<div class="activity-row"><span class="badge ${a.type === 'blocked' ? 'blk' : a.type === 'watch' ? 'sub' : 'none'}">${esc(a.type)}</span><b>${esc(a.videoTitle || a.reason || a.ip || 'Activity')}</b><small>${fmtAgo(a.t)} · ${esc(a.city || a.cc || '')}</small></div>`).join('')
    : '<p class="muted">No recent activity.</p>';

  const isAdmin = Array.isArray(u.roles) && u.roles.includes('admin');
  const ipChips = (s.ips || []).length
    ? (s.ips || []).map((ip) => `<span class="ipchip"><code>${esc(ip)}</code>`
        + `<a class="ip-btn" href="https://ipinfo.io/${encodeURIComponent(ip)}" target="_blank" rel="noopener" title="Look up ${esc(ip)} on ipinfo.io">lookup ↗</a>`
        + `<button type="button" class="ip-btn ip-copy" data-ip="${esc(ip)}" title="Copy IP">copy</button></span>`).join('')
    : '<span class="muted">—</span>';
  const deviceChips = (s.devices || []).length
    ? (s.devices || []).map((dev) => `<span class="device-chip"><b>${esc(dev.label || 'Device')}</b><code>${esc(dev.id || '')}</code><small>${fmtAgo(dev.lastSeen)}</small></span>`).join('')
    : '<span class="muted">No devices recorded.</span>';

  $('detail').innerHTML = `
    <div class="u-head">
      ${avatar(u, 'lg')}
      <div class="u-head-main">
        <h2>${esc(u.username || 'Unnamed user')}</h2>
        <div class="u-head-badges">${statusBadges({ blocked: d.blocked, subscribed: d.subscribed, verified: u.verified }, { admin: isAdmin })}</div>
        <div class="u-head-sub">${esc(u.email || '—')} · joined ${fmtDate(u.createdAt)} · last seen ${fmtDate(s.lastSeen)}</div>
      </div>
    </div>

    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="stat"><b>${s.videosWatched}</b><span>Videos watched</span></div>
      <div class="stat"><b>${s.minutes}</b><span>Minutes watched</span></div>
      <div class="stat"><b>${s.hours}</b><span>Hours watched</span></div>
    </div>

    <div class="u-grid">
      <section class="u-sec">
        <h3>👤 Identity</h3>
        <div class="kv">
          <b>Country</b><span>${s.lastCountry ? flagIcon(s.lastCountry) + ' ' + s.lastCountry : '—'}</span>
          <b>Membership</b><span>${membershipLabel(d.subscribed, u.membership)}</span>
          <b>Verified</b><span>${u.verified ? 'Yes ✓' : 'No'}</span>
          <b>About</b><span>${esc(u.about || '—')}</span>
        </div>
        <div class="ip-block">
          <div class="ip-label">IP addresses</div>
          <div class="ipchips">${ipChips}</div>
        </div>
        <div class="ip-block">
          <div class="ip-label">Devices</div>
          <div class="device-chips">${deviceChips}</div>
        </div>
      </section>
      <section class="u-sec">
        <h3>🔐 Security</h3>
        <div class="kv">
          <b>Password sign-in</b><span>${u.hasPassword ? 'Enabled' : 'Not set'}</span>
          <b>Recovery key</b><span>${u.hasRecoveryKey ? `Set${u.recoveryKeySetAt ? ` · ${fmtDate(u.recoveryKeySetAt)}` : ''}` : 'Not set'}</span>
        </div>
        <div class="addrow" style="margin-top:12px">
          <input id="newpw" type="text" placeholder="New password (min 4 chars)" />
          <button id="reset-pw" class="btn sm">Reset password</button>
        </div>
        <span id="pw-msg" class="muted"></span>
        <p class="muted" style="margin:8px 0 0;font-size:12px">Password hashes are never exposed in the browser.</p>
      </section>
    </div>

    <section class="u-sec">
      <h3>🎬 Viewing history</h3>
      <div class="tbl">${history}</div>
    </section>

    <section class="u-sec">
      <h3>Activity timeline</h3>
      <div class="activity-list">${activity}</div>
    </section>

    <section class="u-sec">
      <h3>🛠️ Actions</h3>
      <div class="u-actions">
        <button id="toggle-block" class="btn sm ghost">${d.blocked ? 'Unblock user' : 'Block user'}</button>
        ${membershipButton(d.subscribed, u.membership)}
        <button id="delete-user" class="btn sm danger" style="margin-left:auto">Delete user</button>
      </div>
      <h4 style="margin:18px 0 4px">Product access</h4>
      <p class="muted" style="margin:0 0 10px">Grant or revoke access to a specific course/product, independent of membership.</p>
      <div id="product-access"><p class="muted">Loading products…</p></div>
    </section>
  `;
  renderProductAccess(id, u.ownedProductIds || []);
  $('detail').querySelectorAll('.ip-copy').forEach((b) => b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.ip);
      const prev = b.textContent; b.textContent = 'copied ✓';
      setTimeout(() => { b.textContent = prev; }, 1200);
    } catch { /* clipboard blocked */ }
  }));

  $('reset-pw').addEventListener('click', async () => {
    const np = $('newpw').value;
    if (!np || np.length < 4) { $('pw-msg').textContent = 'Min 4 characters.'; return; }
    $('reset-pw').disabled = true; $('pw-msg').textContent = 'Saving…';
    const r = await api(`/api/admin/users/${encodeURIComponent(id)}/password`, { method: 'POST', body: JSON.stringify({ newPassword: np }) });
    $('pw-msg').textContent = r.ok ? 'Password reset · their sessions ended.' : (r.error || 'Failed.');
    $('reset-pw').disabled = false; $('newpw').value = '';
  });
  $('toggle-block').addEventListener('click', async () => {
    const action = d.blocked ? 'unblock' : 'block';
    await api(`/api/admin/users/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
    await loadList();
    showDetail(id);
  });
  $('delete-user').addEventListener('click', async () => {
    const label = u.username || u.email || 'this user';
    if (!confirm(`Permanently delete ${label}? This removes the account and cannot be undone. Viewing history and any payment records are kept for accounting but will no longer link to a live user.`)) return;
    const r = await api(`/api/admin/users/${encodeURIComponent(id)}/delete`, { method: 'POST', body: '{}' });
    if (r && r.error) { alert(r.error); return; }
    $('detail-view').classList.add('hidden');
    $('list-view').classList.remove('hidden');
    await loadList();
  });
  const memBtn = $('toggle-member');
  if (memBtn) {
    memBtn.addEventListener('click', async () => {
      const action = d.subscribed ? 'revoke' : 'grant';
      const r = await api(`/api/admin/users/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
      if (r && r.error) { alert(r.error); return; }
      await loadList();
      showDetail(id);
    });
  }
}

// Render the per-product grant/revoke controls for the open user. `owned` is the
// user's ownedProductIds. Fetches the catalog and wires each row's button.
async function renderProductAccess(userId, owned) {
  const box = $('product-access');
  if (!box) return;
  let products = [];
  try { products = (await api('/api/admin/products')).products || []; } catch { /* ignore */ }
  if (!products.length) { box.innerHTML = '<p class="muted">No products defined yet.</p>'; return; }
  const ownedSet = new Set(owned);
  box.innerHTML = products.map((p) => {
    const has = ownedSet.has(p.id);
    return `<div class="tr" style="align-items:center">
      <span class="name">${esc(p.name || p.slug || p.id)} ${has ? '<span class="badge sub">Owns</span>' : ''}</span>
      <button class="btn sm ${has ? 'danger' : ''}" data-pid="${esc(p.id)}" data-op="${has ? 'revoke' : 'grant'}">${has ? 'Revoke' : 'Grant access'}</button>
    </div>`;
  }).join('');
  box.querySelectorAll('button[data-pid]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await api(`/api/admin/users/${encodeURIComponent(userId)}/product`, {
        method: 'POST', body: JSON.stringify({ productId: btn.dataset.pid, op: btn.dataset.op }),
      });
      if (r && r.error) { alert(r.error); btn.disabled = false; return; }
      showDetail(userId); // re-render with the updated ownership
    });
  });
}

/** Human-readable membership state for the detail view. */
function membershipLabel(active, m) {
  if (!active) return 'Free';
  const provider = m && m.provider;
  if (provider === 'admin') return 'Member (comped)';
  if (provider === 'stripe') return `Member (Stripe${m.cancelAtPeriodEnd ? ', ending' : ''})`;
  return 'Member';
}

/** Grant/revoke membership button (works for every provider). */
function membershipButton(active, m) {
  const label = active ? 'Revoke membership' : 'Grant membership';
  return `<button id="toggle-member" class="btn sm ghost">${label}</button>`;
}

async function loadList() {
  const d = await api(`/api/admin/users?filter=${encodeURIComponent(currentFilter)}`);
  allUsers = d.users || [];
  hiddenUnverified = d.unverifiedCount || 0;
  const vn = $('tab-verified-n'); if (vn) vn.textContent = `· ${d.verifiedCount || 0}`;
  const un = $('tab-unverified-n'); if (un) un.textContent = `· ${d.unverifiedCount || 0}`;
  renderList($('search').value);
}

function wireTabs() {
  document.querySelectorAll('.user-tabs button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      currentFilter = btn.dataset.filter;
      document.querySelectorAll('.user-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      try { await loadList(); } catch { /* 401 reloads */ }
    });
  });
}

async function main() {
  await requireAdmin();
  $('to-list').addEventListener('click', () => { $('detail-view').classList.add('hidden'); $('list-view').classList.remove('hidden'); });
  $('search').addEventListener('input', (e) => renderList(e.target.value));
  wireTabs();
  try { await loadList(); } catch { /* a 401 reloads into the gate */ }
}
main();
