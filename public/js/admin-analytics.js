// Central admin dashboard: site stats, quick actions, world bubble map, top
// videos, recent users, and the geo-restriction panel. Cookie-authenticated.
import { renderMap } from './admin-map.js';
import { flagEmoji } from './world-data.js';
import { requireAdmin } from './god-auth.js';

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { location.reload(); throw new Error('unauth'); }
  return res.json().catch(() => ({}));
}

let countryData = { viewers: {}, subscribers: {}, blocked: {} };

function mapCounts(mode) {
  if (mode === 'subscribers') return countryData.subscribers || {};
  if (mode === 'blocked') return countryData.blocked || {};
  const out = {};
  for (const [cc, s] of Object.entries(countryData.viewers || {})) out[cc] = s.views || 0;
  return out;
}

function drawMap(mode) {
  const counts = mapCounts(mode);
  renderMap($('map'), counts, { onHover: (t) => { $('map-hover').textContent = t; } });
  // ranked list
  const rows = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const max = rows.length ? rows[0][1] : 1;
  $('country-rank').innerHTML = rows.length
    ? rows.map(([cc, n]) => `
      <div class="rank-row">
        <span>${flagEmoji(cc)} ${cc}</span>
        <span class="bar"><i style="width:${Math.round((n / max) * 100)}%"></i></span>
        <span class="n">${n.toLocaleString()}</span>
      </div>`).join('')
    : '<p class="muted">No data yet for this view.</p>';
}

async function loadOverview() {
  const d = await api('/api/admin/analytics/overview');
  $('s-views').textContent = (d.totals.views || 0).toLocaleString();
  $('s-hours').textContent = (d.totals.hours || 0).toLocaleString();
  $('s-users').textContent = (d.userCount || 0).toLocaleString();
  $('s-blocked').textContent = (d.blocked.total || 0).toLocaleString();
  $('top-videos').innerHTML = '<div class="tr th"><span>Video</span><span class="num">Views</span><span class="num">Minutes</span></div>'
    + (d.topVideos.length
      ? d.topVideos.map((v) => `<a class="tr" href="/god-analytics.html?v=${encodeURIComponent(v.id)}"><span class="name">${esc(v.title)}</span><span class="num">${v.views}</span><span class="num">${v.minutes}</span></a>`).join('')
      : '<div class="tr"><span class="muted">No views recorded yet.</span></div>');
}

async function loadCountries(mode) {
  countryData = await api('/api/admin/analytics/countries');
  drawMap(mode);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --- geo-restriction panel ---
function chip(label, onRemove) {
  const span = document.createElement('span');
  span.className = 'chip-x';
  span.append(label);
  const x = document.createElement('button');
  x.textContent = '×'; x.title = 'Remove';
  x.addEventListener('click', onRemove);
  span.appendChild(x);
  return span;
}

async function geoMutate(op, value, action) {
  const d = await api('/api/admin/geo', { method: 'POST', body: JSON.stringify({ op, value, action }) });
  if (d.rules) renderGeo(d.rules);
}

function renderGeo(rules) {
  $('geo-enabled').checked = !!rules.enabled;
  const fill = (elId, list, removeOp) => {
    const box = $(elId); box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<span class="muted">None</span>'; return; }
    for (const v of list) box.appendChild(chip(elId === 'cc-chips' ? `${flagEmoji(v)} ${v}` : v, () => geoMutate(removeOp, v, 'remove')));
  };
  fill('cc-chips', rules.blockedCountries, 'country');
  fill('ip-chips', rules.blockedIps, 'ip');
  fill('allow-chips', rules.allowIps, 'allow');
}

async function loadGeo() {
  const d = await api('/api/admin/geo');
  renderGeo(d.rules);
  const det = d.detected;
  const src = det.countrySource ? ` (${det.countrySource})` : '';
  $('geo-detect').innerHTML = `This device — IP <b>${esc(det.ip)}</b>, country <b>${det.country ? flagEmoji(det.country) + ' ' + det.country : 'unknown'}</b>${src}. `
    + `Bypass: <b>${det.bypass ? 'active ✓' : 'OFF'}</b>. Cloudflare: <b>${det.trustCloudflare ? 'trusted' : 'off'}</b>.`;
}

function wireGeo() {
  $('geo-enabled').addEventListener('change', (e) => geoMutate('enabled', e.target.checked));
  $('cc-add').addEventListener('click', () => { const v = $('cc-input').value.trim(); if (v) { geoMutate('country', v, 'block'); $('cc-input').value = ''; } });
  $('ip-add').addEventListener('click', () => { const v = $('ip-input').value.trim(); if (v) { geoMutate('ip', v, 'block'); $('ip-input').value = ''; } });
  $('allow-add').addEventListener('click', () => { const v = $('allow-input').value.trim(); if (v) { geoMutate('allow', v, 'add'); $('allow-input').value = ''; } });
  $('allow-me').addEventListener('click', () => geoMutate('allow', '', 'add')); // server uses detected IP
  $('sim-set').addEventListener('click', async () => {
    const cc = $('sim-input').value.trim();
    await api('/api/admin/geo/simulate', { method: 'POST', body: JSON.stringify({ cc }) });
    location.reload(); // re-evaluate this session as a visitor from cc
  });
  $('sim-clear').addEventListener('click', async () => {
    await api('/api/admin/geo/simulate', { method: 'POST', body: JSON.stringify({ cc: '' }) });
    location.reload();
  });
}

// Quick-action counts + recent-users widget on the dashboard.
async function loadExtras() {
  try {
    const vids = await (await fetch('/thumbs/videos.json')).json();
    $('q-videos').textContent = `${vids.length} videos`;
  } catch { /* ignore */ }
  const d = await api('/api/admin/users');
  const users = d.users || [];
  $('q-users').textContent = `${users.length} registered`;
  const recent = users.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 6);
  $('recent-users').innerHTML = recent.length
    ? recent.map((u) => `<a class="ru" href="/god-users.html">
        <span class="ru-name">${esc(u.username || '—')}</span>
        <span class="ru-em">${esc(u.email || '')}</span>
        <span class="ru-w">${u.minutesWatched || 0}m</span></a>`).join('')
    : '<p class="muted">No users yet.</p>';
}

function wireMapModes() {
  $('map-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    [...$('map-mode').children].forEach((b) => b.classList.toggle('active', b === btn));
    drawMap(btn.dataset.mode);
  });
}

async function main() {
  await requireAdmin(); // sign-in overlay for non-admins
  wireMapModes(); wireGeo();
  try {
    await Promise.all([loadOverview(), loadCountries('viewers'), loadGeo(), loadExtras()]);
  } catch { /* a 401 mid-flight reloads into the gate */ }
}
main();
