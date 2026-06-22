// User management: searchable list → click a user for a detail page with
// profile, IPs, country, subscription, viewing history, watch time, the (scrypt,
// irreversible) password hash, a password-reset form, and block/unblock.
import { flagEmoji } from './world-data.js';
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

let allUsers = [];

function statusBadge(u) {
  if (u.blocked) return '<span class="badge blk">Blocked</span>';
  if (u.subscribed) return '<span class="badge sub">Subscriber</span>';
  return '<span class="badge none">Free</span>';
}

function renderList(filter = '') {
  const f = filter.toLowerCase();
  const rows = allUsers.filter((u) => !f || (u.username || '').toLowerCase().includes(f) || (u.email || '').toLowerCase().includes(f));
  $('ucount').textContent = `(${rows.length})`;
  $('user-list').innerHTML = rows.length ? '' : '<p class="muted">No users.</p>';
  for (const u of rows) {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <span class="name">${esc(u.username || '—')}</span>
      <span class="em">${esc(u.email || '')}</span>
      <span>${u.country ? flagEmoji(u.country) + ' ' + u.country : '—'}</span>
      <span>${u.videosWatched} vids · ${u.minutesWatched}m</span>
      <span>${statusBadge(u)}</span>`;
    row.addEventListener('click', () => showDetail(u.id));
    $('user-list').appendChild(row);
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

  $('detail').innerHTML = `
    <h2>${esc(u.username || 'Unnamed user')} ${d.blocked ? '<span class="badge blk">Blocked</span>' : ''}</h2>
    <div class="kv" style="margin:12px 0 18px">
      <b>Email</b><span>${esc(u.email || '—')}</span>
      <b>Country</b><span>${s.lastCountry ? flagEmoji(s.lastCountry) + ' ' + s.lastCountry : '—'}</span>
      <b>IP addresses</b><span class="mono">${(s.ips || []).map(esc).join(', ') || '—'}</span>
      <b>Subscription</b><span>${u.hasPurchased || (u.purchases && u.purchases.length) ? 'Subscriber' : 'Free'}</span>
      <b>Verified</b><span>${u.verified ? 'Yes' : 'No'}</span>
      <b>Joined</b><span>${fmtDate(u.createdAt)}</span>
      <b>Last seen</b><span>${fmtDate(s.lastSeen)}</span>
      <b>About</b><span>${esc(u.about || '—')}</span>
      <b>Password hash</b><span class="mono">${esc(u.passwordHash || '—')}</span>
    </div>
    <p class="muted" style="margin:-10px 0 18px">scrypt is a one-way function — this hash cannot be reversed. Use “Reset password” below to set a new one.</p>

    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="stat"><b>${s.videosWatched}</b><span>Videos watched</span></div>
      <div class="stat"><b>${s.minutes}</b><span>Minutes watched</span></div>
      <div class="stat"><b>${s.hours}</b><span>Hours watched</span></div>
    </div>

    <h3 style="margin-top:18px">Viewing history</h3>
    <div class="tbl">${history}</div>

    <h3 style="margin-top:18px">Account actions</h3>
    <div class="addrow" style="margin-bottom:10px">
      <input id="newpw" type="text" placeholder="New password (min 4 chars)" />
      <button id="reset-pw" class="btn sm">Reset password</button>
      <span id="pw-msg" class="muted"></span>
    </div>
    <button id="toggle-block" class="btn sm ghost">${d.blocked ? 'Unblock user' : 'Block user'}</button>
  `;

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
}

async function loadList() {
  const d = await api('/api/admin/users');
  allUsers = d.users || [];
  renderList($('search').value);
}

async function main() {
  await requireAdmin();
  $('to-list').addEventListener('click', () => { $('detail-view').classList.add('hidden'); $('list-view').classList.remove('hidden'); });
  $('search').addEventListener('input', (e) => renderList(e.target.value));
  try { await loadList(); } catch { /* a 401 reloads into the gate */ }
}
main();
