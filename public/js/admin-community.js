// Community inbox: every comment across all videos in one searchable, filterable
// feed with video context + moderation actions (reply, delete, ban). Admin-only.
import { flagEmoji } from './world-data.js';
import { requireAdmin } from './god-auth.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { location.reload(); throw new Error('unauth'); }
  return res.json().catch(() => ({}));
}

// "3 days ago" style relative time.
function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  const u = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [name, secs] of u) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

function isTenorGif(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && (x.hostname === 'tenor.com' || x.hostname.endsWith('.tenor.com')) && x.pathname.toLowerCase().endsWith('.gif'); } catch { return false; }
}

let debounce = null;
let videosLoaded = false;

function badge(c) {
  if (c.isAdmin) return '<span class="badge adm">Admin</span>';
  if (c.isMember) return '<span class="badge sub">Member</span>';
  if (c.username) return '<span class="badge none">User</span>';
  return '<span class="badge anon">Anon</span>';
}

function rowEl(c) {
  const row = document.createElement('div');
  row.className = 'comm-row';
  const flag = c.country ? `<span title="${esc(c.country)}">${flagEmoji(c.country)}</span> ` : '';
  const avatar = c.avatar
    ? `<img class="comm-av" src="${esc(c.avatar)}" alt="" />`
    : `<div class="comm-av ph">${esc((c.name || '?').trim().charAt(0).toUpperCase() || '?')}</div>`;
  const gif = (c.gifUrl && isTenorGif(c.gifUrl)) ? `<img class="comm-gif" src="${esc(c.gifUrl)}" alt="GIF" loading="lazy" />` : '';
  const thumb = c.video.thumb ? `<img src="${esc(c.video.thumb)}" alt="" />` : '<div class="comm-thumb-ph"></div>';

  row.innerHTML = `
    <div class="comm-main">
      ${avatar}
      <div class="comm-body">
        <div class="comm-meta">${flag}<b>${esc(c.username || c.name)}</b> ${badge(c)} <span class="muted">· ${timeAgo(c.ts)}</span></div>
        <div class="comm-text">${esc(c.text)}</div>
        ${gif}
        <div class="comm-actions">
          <button class="btn sm reply">Reply</button>
          <button class="btn sm ghost del">Delete</button>
          ${c.userId && !c.isAdmin ? '<button class="btn sm ghost ban">Ban author</button>' : ''}
          <a class="btn sm ghost" href="/watch?v=${encodeURIComponent(c.video.id)}" target="_blank">Open</a>
        </div>
        <div class="comm-replybox" hidden>
          <input class="reply-input" placeholder="Reply as David Bond…" />
          <button class="btn sm send">Send</button>
        </div>
      </div>
    </div>
    <a class="comm-content" href="/watch?v=${encodeURIComponent(c.video.id)}" target="_blank">
      <div class="comm-thumb">${thumb}</div>
      <span class="comm-vtitle">${esc(c.video.title)}</span>
    </a>`;

  row.querySelector('.reply').addEventListener('click', () => {
    const box = row.querySelector('.comm-replybox');
    box.hidden = !box.hidden;
    if (!box.hidden) row.querySelector('.reply-input').focus();
  });
  row.querySelector('.send').addEventListener('click', async () => {
    const input = row.querySelector('.reply-input');
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    const r = await api('/api/admin/community/reply', { method: 'POST', body: JSON.stringify({ video: c.video.id, to: c.username || '', text }) });
    if (r.ok) { input.value = ''; row.querySelector('.comm-replybox').hidden = true; load(); }
    else { alert(r.error || 'Could not post reply.'); input.disabled = false; }
  });
  row.querySelector('.del').addEventListener('click', async () => {
    if (!confirm('Delete this comment?')) return;
    await fetch(`/api/comments?video=${encodeURIComponent(c.video.id)}&id=${encodeURIComponent(c.id)}`, { method: 'DELETE' });
    row.remove();
  });
  const banBtn = row.querySelector('.ban');
  if (banBtn) banBtn.addEventListener('click', async () => {
    if (!confirm(`Ban ${c.username || 'this user'}? They’ll be blocked and their comments hidden.`)) return;
    await api(`/api/admin/users/${encodeURIComponent(c.userId)}/block`, { method: 'POST', body: '{}' });
    load();
  });
  return row;
}

function renderSummary(s) {
  $('summary').innerHTML = `
    <div class="stat"><b>${s.total}</b><span>Total comments</span></div>
    <div class="stat"><b>${s.registered}</b><span>From accounts</span></div>
    <div class="stat"><b>${s.anon}</b><span>Anonymous</span></div>
    <div class="stat"><b>${s.withGif}</b><span>With a GIF</span></div>`;
}

function fillVideoDropdown(videos) {
  if (videosLoaded) return;
  const sel = $('video');
  for (const v of videos) {
    const o = document.createElement('option');
    o.value = v.id; o.textContent = `${v.title} (${v.count})`;
    sel.appendChild(o);
  }
  videosLoaded = true;
}

async function load() {
  const params = new URLSearchParams({
    q: $('search').value.trim(), video: $('video').value, author: $('author').value, sort: $('sort').value,
  });
  const d = await api(`/api/admin/community?${params.toString()}`);
  renderSummary(d.summary || { total: 0, registered: 0, anon: 0, withGif: 0 });
  fillVideoDropdown(d.videos || []);
  $('ccount').textContent = `(${d.matched || 0})`;
  const list = $('comm-list');
  list.innerHTML = '';
  if (!d.comments || !d.comments.length) { list.innerHTML = '<p class="muted">No comments match these filters.</p>'; return; }
  for (const c of d.comments) list.appendChild(rowEl(c));
}

async function main() {
  await requireAdmin();
  $('search').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(load, 250); });
  $('video').addEventListener('change', load);
  $('author').addEventListener('change', load);
  $('sort').addEventListener('change', load);
  $('clear').addEventListener('click', () => {
    $('search').value = ''; $('video').value = ''; $('author').value = 'all'; $('sort').value = 'new'; load();
  });
  try { await load(); } catch { /* 401 reloads into the gate */ }
}
main();
