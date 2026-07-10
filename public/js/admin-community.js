// Community inbox: every comment across all videos in one searchable, filterable
// feed with video context + moderation actions (reply, delete, ban). Admin-only.
import { flagIcon, CENTROIDS, project } from './world-data.js';
import { WORLD_LAND } from './world-map-paths.js';
import { COUNTRIES } from './countries.js';
import { requireAdmin } from './god-auth.js';

const COUNTRY_NAME = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.name]));
const nf = (n) => (Number(n) || 0).toLocaleString();

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
let profileModal = null;

function badge(c) {
  if (c.moderation && c.moderation.shadow) return '<span class="badge filt">Filtered</span>';
  if (c.isAdmin) return '<span class="badge adm">Admin</span>';
  if (c.isMember) return '<span class="badge sub">Member</span>';
  if (c.username) return '<span class="badge none">User</span>';
  return '<span class="badge anon">Anon</span>';
}

function rowEl(c) {
  const row = document.createElement('div');
  row.className = 'comm-row';
  row.tabIndex = 0;
  row.role = 'button';
  row.title = 'Open visitor profile';
  const flag = c.country ? `<span title="${esc(c.country)}">${flagIcon(c.country)}</span> ` : '';
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
        ${c.moderation && c.moderation.shadow ? `<div class="filter-note">Shadow filtered: ${esc(c.moderation.phrase || c.moderation.reason || 'word filter')}</div>` : ''}
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
  const openProfile = () => showVisitorProfile(c.id);
  row.addEventListener('click', (e) => {
    if (e.target.closest('button,a,input')) return;
    openProfile();
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProfile(); }
  });
  return row;
}

function ensureProfileModal() {
  if (profileModal) return profileModal;
  profileModal = document.createElement('div');
  profileModal.className = 'visitor-modal';
  profileModal.hidden = true;
  profileModal.innerHTML = `
    <div class="visitor-sheet" role="dialog" aria-modal="true" aria-label="Visitor profile">
      <button class="visitor-close" type="button" aria-label="Close">×</button>
      <div id="visitor-profile-body" class="visitor-profile-body"></div>
    </div>`;
  document.body.appendChild(profileModal);
  profileModal.addEventListener('click', (e) => { if (e.target === profileModal || e.target.closest('.visitor-close')) profileModal.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && profileModal && !profileModal.hidden) profileModal.hidden = true; });
  return profileModal;
}

// Per-event-type presentation for the activity timeline (emoji + colour lane).
function actMeta(type) {
  if (type && type.startsWith('funnel.')) return { emoji: '🎯', label: type.slice(7).replace(/_/g, ' '), cls: 'violet' };
  return ({
    visit: { emoji: '👁️', label: 'Visit', cls: 'cyan' },
    watch: { emoji: '▶️', label: 'Watch', cls: 'amber' },
    comment: { emoji: '💬', label: 'Comment', cls: 'green' },
  })[type] || { emoji: '•', label: type || 'event', cls: 'slate' };
}

// Equirectangular mini-map (0..360 x 0..180) with a pulsing geo-ping. Uses the
// visitor's precise coords when known, else the country centroid.
const GRATICULE = [60, 120, 180, 240, 300].map((gx) => `<line x1="${gx}" y1="0" x2="${gx}" y2="180" class="vp-grat"/>`).join('')
  + [45, 90, 135].map((gy) => `<line x1="0" y1="${gy}" x2="360" y2="${gy}" class="vp-grat"/>`).join('');

function miniMap(loc) {
  let lat = loc && loc.lat;
  let lon = loc && loc.lon;
  const cc = loc && loc.cc;
  if ((lat == null || lon == null) && cc && CENTROIDS[cc]) { [lat, lon] = CENTROIDS[cc]; }
  if (lat == null || lon == null) return '<div class="vp-map vp-map--empty">📡 No location signal</div>';
  const { x, y } = project(lat, lon);
  return `
    <svg class="vp-map" viewBox="0 0 360 180" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Approximate visitor location">
      <defs><radialGradient id="vpGlow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#fbbf24" stop-opacity=".55"/><stop offset="100%" stop-color="#fbbf24" stop-opacity="0"/>
      </radialGradient></defs>
      <rect width="360" height="180" fill="#070d1a"/>
      ${GRATICULE}
      <path d="${WORLD_LAND}" class="vp-land"/>
      <line x1="0" y1="${y.toFixed(1)}" x2="360" y2="${y.toFixed(1)}" class="vp-cross"/>
      <line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="180" class="vp-cross"/>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="34" fill="url(#vpGlow)"/>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" class="vp-ping-ring"/>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" class="vp-ping-ring vp-ping-ring--2"/>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" class="vp-ping-core"/>
    </svg>`;
}

const fact = (k, vHtml) => `<span class="k">${esc(k)}</span><span class="v">${vHtml}</span>`;
const stat = (ic, label, n, cls) => `<div class="vp-stat ${cls}"><span class="vp-stat-ic">${ic}</span><b>${nf(n)}</b><span>${esc(label)}</span></div>`;
const seenLabel = (ts) => (ts ? timeAgo(ts) : '—');

async function showVisitorProfile(commentId) {
  const modal = ensureProfileModal();
  const body = modal.querySelector('#visitor-profile-body');
  modal.hidden = false;
  body.innerHTML = '<div class="vp-loading">📡 Pulling visitor dossier…</div>';
  const d = await api(`/api/admin/comments/${encodeURIComponent(commentId)}/visitor`);
  if (!d.profile) { body.innerHTML = `<div class="vp-loading">${esc(d.error || 'No visitor profile available.')}</div>`; return; }
  const p = d.profile;
  const dev = (p.devices && p.devices[0]) || {};
  const loc = p.location || null;
  const cc = loc && loc.cc;
  const flag = cc ? flagIcon(cc) : '🌐';
  const countryName = (loc && loc.country) || (cc && COUNTRY_NAME[cc]) || cc || 'Unknown';
  const place = [loc && loc.city, loc && loc.region].filter(Boolean).join(' · ') || '—';
  const coords = (loc && loc.lat != null) ? `${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`
    : (cc && CENTROIDS[cc]) ? `~${CENTROIDS[cc][0]}, ${CENTROIDS[cc][1]}` : '—';
  const s = p.summary || {};
  const devEmoji = dev.type === 'mobile' ? '📱' : dev.type === 'tablet' ? '📲' : '🖥️';
  const activity = (p.activity || []).slice(0, 24);
  body.innerHTML = `
    <div class="vp">
      <header class="vp-head">
        <div class="vp-id">
          <div class="vp-avatar">${cc ? flagIcon(cc) : '🕵️'}</div>
          <div>
            <span class="vp-eyebrow">● Visitor dossier</span>
            <h2>${flag} ${esc(countryName)} visitor</h2>
            <code class="vp-uid">${esc(p.visitorId)}</code>
          </div>
        </div>
        <div class="vp-seen">
          <span><b>First seen</b>${esc(seenLabel(p.firstSeen))}</span>
          <span><b>Last seen</b>${esc(seenLabel(p.lastSeen))}</span>
        </div>
      </header>

      <div class="vp-stats">
        ${stat('👁️', 'Page views', s.pageViews, 'cyan')}
        ${stat('▶️', 'Watches', s.watches, 'amber')}
        ${stat('💬', 'Comments', s.comments, 'green')}
        ${stat('🎯', 'Funnel', s.funnelEvents, 'violet')}
      </div>

      <div class="vp-grid">
        <section class="vp-card vp-geo">
          <div class="vp-card-h">🗺️ <b>Geolocation</b><span class="vp-tag">${loc && loc.city ? 'City-level' : 'Country-level'}</span></div>
          ${miniMap(loc)}
          <div class="vp-facts">
            ${fact('Country', `${flag} ${esc(countryName)}${cc ? ` (${esc(cc)})` : ''}`)}
            ${fact('Region · City', esc(place))}
            ${fact('Coordinates', esc(coords))}
            ${fact('ISP · Org', esc((loc && loc.isp) || '—'))}
          </div>
        </section>

        <div class="vp-side">
          <section class="vp-card">
            <div class="vp-card-h">${devEmoji} <b>Device</b></div>
            <div class="vp-facts">
              ${fact('Type', esc(dev.type || '—'))}
              ${fact('OS', esc(dev.os || '—'))}
              ${fact('Browser', esc(dev.browser || '—'))}
              ${fact('Viewport', esc(dev.viewport || '—'))}
            </div>
            <div class="vp-ua">${esc(dev.ua || '—')}</div>
          </section>
          <section class="vp-card">
            <div class="vp-card-h">🌐 <b>Network</b></div>
            <div class="vp-ips">${(p.ips || []).length ? p.ips.map((ip) => `<code>${esc(ip)}</code>`).join('') : '<span class="vp-muted">—</span>'}</div>
          </section>
        </div>
      </div>

      <section class="vp-card vp-activity-card">
        <div class="vp-card-h">⏱️ <b>Activity log</b><span class="vp-tag">${activity.length} events</span></div>
        <div class="vp-timeline">
          ${activity.length ? activity.map((a) => {
            const m = actMeta(a.type);
            const target = a.path || a.videoTitle || a.productId || (a.text ? `“${a.text.slice(0, 70)}”` : '') || a.ip || '';
            return `<div class="vp-ev ${m.cls}">
              <span class="vp-ev-ic">${m.emoji}</span>
              <span class="vp-ev-type">${esc(m.label)}</span>
              <span class="vp-ev-t">${esc(new Date(a.t).toLocaleString())}</span>
              <span class="vp-ev-tg">${esc(target)}</span>
            </div>`;
          }).join('') : '<p class="vp-muted">No retained activity for this visitor.</p>'}
        </div>
      </section>
    </div>`;
}

function renderSummary(s) {
  $('summary').innerHTML = `
    <div class="stat"><b>${s.total}</b><span>Total comments</span></div>
    <div class="stat"><b>${s.registered}</b><span>From accounts</span></div>
    <div class="stat"><b>${s.anon}</b><span>Anonymous</span></div>
    <div class="stat"><b>${s.withGif}</b><span>With a GIF</span></div>
    <div class="stat"><b>${s.filtered || 0}</b><span>Filtered</span></div>`;
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

async function loadFilters() {
  const box = $('filter-list');
  if (!box) return;
  const d = await api('/api/admin/comment-filters');
  const filters = d.filters || [];
  if (!filters.length) { box.innerHTML = '<p class="muted">No filter phrases configured.</p>'; return; }
  box.innerHTML = '';
  for (const f of filters) {
    const row = document.createElement('div');
    row.className = `filter-row${f.enabled ? '' : ' off'}`;
    row.innerHTML = `
      <input class="filter-edit" value="${esc(f.phrase)}" />
      <label><input class="filter-enabled" type="checkbox" ${f.enabled ? 'checked' : ''} /> Enabled</label>
      <button class="btn sm save" type="button">Save</button>
      <button class="btn sm ghost del" type="button">Delete</button>`;
    row.querySelector('.save').addEventListener('click', async () => {
      const phrase = row.querySelector('.filter-edit').value.trim();
      const enabled = row.querySelector('.filter-enabled').checked;
      const r = await api(`/api/admin/comment-filters/${encodeURIComponent(f.id)}`, { method: 'POST', body: JSON.stringify({ phrase, enabled }) });
      if (!r.ok) alert(r.error || 'Could not save filter.');
      else reportSwept(r.swept);
      await loadFilters();
    });
    row.querySelector('.filter-enabled').addEventListener('change', async (e) => {
      const r = await api(`/api/admin/comment-filters/${encodeURIComponent(f.id)}`, { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) });
      reportSwept(r.swept);
      await loadFilters();
    });
    row.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`Delete "${f.phrase}" from the filter list?`)) return;
      await fetch(`/api/admin/comment-filters/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
      await loadFilters();
    });
    box.appendChild(row);
  }
}

// A phrase change retroactively shadow-hides matching stored comments — tell the
// admin how many were caught and refresh the inbox so the badges update.
function reportSwept(n) {
  if (!n) return;
  alert(`Shadow-hid ${n} existing comment${n === 1 ? '' : 's'} matching the filters.`);
  load();
}

function wireFilters() {
  const form = $('filter-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('filter-phrase');
    const phrase = input.value.trim();
    if (!phrase) return;
    const r = await api('/api/admin/comment-filters', { method: 'POST', body: JSON.stringify({ phrase }) });
    if (!r.ok) alert(r.error || 'Could not add filter.');
    else { input.value = ''; reportSwept(r.swept); }
    await loadFilters();
  });
}

// "Allow anonymous comments" kill switch (off by default server-side).
async function loadSettings() {
  const toggle = $('anon-comments-toggle');
  const status = $('anon-comments-status');
  if (!toggle) return;
  const d = await api('/api/admin/comments-settings');
  toggle.checked = !!(d.config && d.config.anonymousEnabled);
  toggle.disabled = false;
  toggle.addEventListener('change', async () => {
    toggle.disabled = true;
    status.textContent = 'Saving…';
    const r = await api('/api/admin/comments-settings', { method: 'POST', body: JSON.stringify({ anonymousEnabled: toggle.checked }) });
    if (r.ok) {
      status.textContent = toggle.checked ? 'Saved — visitors can post anonymously.' : 'Saved — visitors must sign in to comment.';
    } else {
      toggle.checked = !toggle.checked; // revert
      status.textContent = '';
      alert(r.error || 'Could not save the setting.');
    }
    toggle.disabled = false;
  });
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
  wireFilters();
  try { await Promise.all([load(), loadFilters(), loadSettings()]); } catch { /* 401 reloads into the gate */ }
}
main();
