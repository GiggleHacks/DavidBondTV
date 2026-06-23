// Central admin dashboard: site stats, quick actions, world bubble map, top
// videos, recent users, and the geo-restriction panel. Cookie-authenticated.
import { renderMap } from './admin-map.js';
import { flagIcon } from './world-data.js';
import { COUNTRIES } from './countries.js';
import { requireAdmin } from './god-auth.js';
import { ADMIN_PATHS } from './admin-paths.js';

const $ = (id) => document.getElementById(id);
const COUNTRY_NAME = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.name]));
const ccLabel = (cc) => `${flagIcon(cc)} ${COUNTRY_NAME[cc] ? `${COUNTRY_NAME[cc]} (${cc})` : cc}`;

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
  renderMap($('map'), counts, { onHover: (t) => { $('map-hover').innerHTML = t; } });
  // ranked list
  const rows = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const max = rows.length ? rows[0][1] : 1;
  $('country-rank').innerHTML = rows.length
    ? rows.map(([cc, n]) => `
      <div class="rank-row">
        <span>${flagIcon(cc)} ${cc}</span>
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
      ? d.topVideos.map((v) => `<a class="tr" href="${ADMIN_PATHS.analytics}?v=${encodeURIComponent(v.id)}"><span class="name">${esc(v.title)}</span><span class="num">${v.views}</span><span class="num">${v.minutes}</span></a>`).join('')
      : '<div class="tr"><span class="muted">No views recorded yet.</span></div>');
}

async function loadCountries(mode) {
  countryData = await api('/api/admin/analytics/countries');
  drawMap(mode);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --- geo-restriction panel ---
function chip(label, onRemove, { html = false } = {}) {
  const span = document.createElement('span');
  span.className = 'chip-x';
  if (html) { const inner = document.createElement('span'); inner.innerHTML = label; span.appendChild(inner); }
  else span.append(label);
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

let blockedCountrySet = new Set();

function renderGeo(rules) {
  $('geo-enabled').checked = !!rules.enabled;
  const fill = (elId, list, removeOp) => {
    const box = $(elId); box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<span class="muted">None</span>'; return; }
    const isCC = elId === 'cc-chips';
    for (const v of list) box.appendChild(chip(isCC ? ccLabel(v) : v, () => geoMutate(removeOp, v, 'remove'), { html: isCC }));
  };
  fill('cc-chips', rules.blockedCountries, 'country');
  fill('ip-chips', rules.blockedIps, 'ip');
  fill('allow-chips', rules.allowIps, 'allow');
  blockedCountrySet = new Set(rules.blockedCountries);
  renderCountryResults();
}

async function loadGeo() {
  const d = await api('/api/admin/geo');
  renderGeo(d.rules);
  const det = d.detected;
  const src = det.countrySource ? ` (${det.countrySource})` : '';
  $('geo-detect').innerHTML = `This device — IP <b>${esc(det.ip)}</b>, country <b>${det.country ? flagIcon(det.country) + ' ' + det.country : 'unknown'}</b>${src}. `
    + `Bypass: <b>${det.bypass ? 'active ✓' : 'OFF'}</b>. Cloudflare: <b>${det.trustCloudflare ? 'trusted' : 'off'}</b>.`;
}

// --- searchable country picker (replaces manual 2-letter code entry) ---
let countryQuery = '';
function matchingCountries() {
  const q = countryQuery.trim().toLowerCase();
  const pool = COUNTRIES.filter((c) => !blockedCountrySet.has(c.code));
  if (!q) return pool.slice(0, 60);
  return pool.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q).slice(0, 60);
}
function renderCountryResults() {
  const menu = $('cc-results');
  if (!menu) return;
  const list = matchingCountries();
  if (!list.length) { menu.innerHTML = '<div class="none">No matching countries.</div>'; return; }
  menu.replaceChildren(...list.map((c) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'country-opt';
    b.innerHTML = `${flagIcon(c.code)} <span>${esc(c.name)}</span> <span class="cc">${c.code}</span>`;
    b.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus so the menu doesn't blur-close first
      geoMutate('country', c.code, 'block');
      $('cc-search').value = ''; countryQuery = '';
    });
    return b;
  }));
}
function wireCountryPicker() {
  const input = $('cc-search'); const menu = $('cc-results');
  if (!input || !menu) return;
  const open = () => { menu.classList.remove('hidden'); renderCountryResults(); };
  input.addEventListener('focus', open);
  input.addEventListener('input', () => { countryQuery = input.value; open(); });
  input.addEventListener('blur', () => { setTimeout(() => menu.classList.add('hidden'), 120); });
}

function wireGeo() {
  $('geo-enabled').addEventListener('change', (e) => geoMutate('enabled', e.target.checked));
  wireCountryPicker();
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
    const vids = (await (await fetch('/api/admin/videos')).json()).videos || [];
    $('q-videos').textContent = `${vids.length} videos`;
  } catch { /* ignore */ }
  const d = await api('/api/admin/users');
  const users = d.users || [];
  $('q-users').textContent = `${users.length} registered`;
  const recent = users.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 6);
  $('recent-users').innerHTML = recent.length
    ? recent.map((u) => `<a class="ru" href="${ADMIN_PATHS.users}">
        <span class="ru-name">${esc(u.username || '—')}</span>
        <span class="ru-em">${esc(u.email || '')}</span>
        <span class="ru-w">${u.minutesWatched || 0}m</span></a>`).join('')
    : '<p class="muted">No users yet.</p>';
}

// Recent individual viewer events — time, IP, country, user, video, watched.
function fmtAgo(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

async function loadVisitors() {
  const box = $('visitors');
  if (!box) return;
  const d = await api('/api/admin/analytics/visitors?limit=200');
  const events = d.events || [];
  const head = '<div class="tr th"><span>When</span><span>IP</span><span>Location</span><span>User</span><span>Video</span><span class="num">Watched</span></div>';
  if (!events.length) { box.innerHTML = head + '<div class="tr"><span class="muted">No visitor activity recorded yet.</span></div>'; return; }
  box.innerHTML = head + events.map((e) => {
    const loc = e.cc ? `${flagIcon(e.cc)} ${e.cc}` : '—';
    const who = e.blocked ? '<span class="badge blk">blocked</span>' : (e.user ? esc(e.user) : '<span class="muted">guest</span>');
    const vid = e.video ? esc(e.video) : (e.reason ? esc(e.reason) : '—');
    const watched = e.seconds ? `${e.seconds}s` : '—';
    return `<div class="tr">
      <span title="${new Date(e.t).toLocaleString()}">${fmtAgo(e.t)}</span>
      <span class="mono">${esc(e.ip || '—')}</span>
      <span>${loc}</span>
      <span class="name">${who}</span>
      <span class="name">${vid}</span>
      <span class="num">${watched}</span>
    </div>`;
  }).join('');
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
    await Promise.all([loadOverview(), loadCountries('viewers'), loadGeo(), loadExtras(), loadVisitors()]);
  } catch { /* a 401 mid-flight reloads into the gate */ }
}
main();
