// DataBond GigaBrain — the native admin dashboard. Cookie-authenticated like
// every other god page. Renders GigaBrain's first-party analytics (visitors,
// sources, behaviour, real-time, geo) plus David Bond TV's own business KPIs,
// using hand-rolled SVG charts (no chart library — zero-dependency build).
//
// All GigaBrain data is read through this app's own server-side proxy
// (/api/admin/databond/*, see lib/gigabrain-proxy.js) — the browser never talks
// to the analytics sidecar directly. Business data comes from the existing
// /api/admin/financial and /api/admin/analytics/overview endpoints.
import { flagIcon, flagFor } from './world-data.js';
import { osIcon, browserIcon, deviceIcon } from './device-icons.js';
import { COUNTRIES } from './countries.js';
import { requireAdmin } from './god-auth.js';
import { ADMIN_PATHS } from './admin-paths.js';
import {
  nf, esc, fmtMoney, fmtAgo, fmtDur, deltaChip,
  drawTraffic, drawDonut, barList, drawColumns, countUp,
} from './admin-charts.js';

const $ = (id) => document.getElementById(id);
const COUNTRY_NAME = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.name]));

// ---------- state ----------
let currentRange = '7d';
let includeBots = false;
let lastVisitorList = [];      // for CSV export
let configured = true;         // sidecar reachable + configured

// ---------- generic same-origin API ----------
async function api(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { location.reload(); throw new Error('unauth'); }
  return res.json().catch(() => ({}));
}

// GigaBrain proxy fetch. Returns null when the sidecar isn't configured/reachable
// (503/502) and flips the dashboard into the "not connected" state.
async function gb(path) {
  const res = await fetch(`/api/admin/databond/${path}`);
  if (res.status === 401) { location.reload(); throw new Error('unauth'); }
  if (res.status === 503 || res.status === 502) { setConfigured(false); return null; }
  const json = await res.json().catch(() => ({}));
  if (json && json.error) { setConfigured(false); return null; }
  setConfigured(true);
  return json;
}

function setConfigured(ok) {
  configured = ok;
  const notice = $('db-notice');
  if (!notice) return;
  notice.hidden = ok;
  if (!ok && !notice.dataset.filled) {
    notice.dataset.filled = '1';
    notice.innerHTML = `
      <strong>DataBond GigaBrain isn't connected yet.</strong>
      Set <code>GIGABRAIN_PUBLIC_URL</code> and <code>GIGABRAIN_SESSION_SECRET</code> (equal to the
      sidecar's <code>ADMIN_SESSION_SECRET</code>) on the server and restart — no separate password,
      your admin login is the only gate. The <b>Business</b> tab below still works — it uses this site's own data.`;
  }
}

const rangeQuery = () => `range=${encodeURIComponent(currentRange)}&bots=${includeBots ? 1 : 0}`;
function stamp() { const el = $('db-stamp'); if (el) el.textContent = 'updated ' + new Date().toUTCString().slice(17, 25) + ' UTC'; }

// ---------- tabs ----------
function wireTabs() {
  const bar = $('deck-tabs');
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.deck-tab');
    if (!btn) return;
    const tab = btn.dataset.tab;
    bar.querySelectorAll('.deck-tab').forEach((b) => b.classList.toggle('on', b === btn));
    document.querySelectorAll('.deck-panel-tab').forEach((p) => p.classList.toggle('on', p.dataset.panel === tab));
    if (tab === 'traffic') loadMap().catch(() => {});
    if (tab === 'business') loadBusiness().catch(() => {});
    if (tab === 'realtime') loadRealtime().catch(() => {});
    if (tab === 'overview') loadHealth().catch(() => {});
    if (tab === 'geo') { loadGeoControl().catch(() => {}); loadGeoAttempts().catch(() => {}); }
  });
}

function wireControls() {
  $('db-range').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-range]');
    if (!btn) return;
    currentRange = btn.dataset.range;
    [...$('db-range').children].forEach((b) => b.classList.toggle('active', b === btn));
    refreshRangeBound();
  });
  $('db-bots').addEventListener('change', (e) => { includeBots = e.target.checked; refreshRangeBound(); });
}

// Reload everything that depends on the range / bots filter.
function refreshRangeBound() {
  loadStats().catch(() => {});
  loadMap().catch(() => {});
  loadGeoAttempts().catch(() => {});
}

// ========== STATS (Overview + Traffic sources + Visitors + Behavior) ==========
async function loadStats() {
  const d = await gb(`stats?${rangeQuery()}`);
  if (!d) return;
  stamp();
  const ov = d.overview || {};

  // Overview KPIs — numeric ones animate up; formatted ones set directly.
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const setNum = (id, v) => countUp($(id), v);
  setNum('kpi-visitors', ov.visitors);
  setNum('kpi-pageviews', ov.pageviews);
  setNum('kpi-sessions', ov.sessions);
  setNum('kpi-conversions', ov.conversions);
  set('kpi-engage', fmtDur(ov.avgEngagementSec));
  set('kpi-bounce', `${ov.bounceRate || 0}%`);
  setNum('kpi-new', ov.newVisitors);
  setNum('kpi-ret', ov.returningVisitors);
  const bots = d.bots || {};
  setNum('kpi-bots', bots.bots);
  setNum('kpi-humans', bots.humans);
  const dl = ov.deltas || {};
  setDelta('d-visitors', dl.visitors);
  setDelta('d-pageviews', dl.pageviews);
  setDelta('d-sessions', dl.sessions);
  setDelta('d-conversions', dl.conversions);
  setDelta('d-engage', dl.avgEngagementSec);
  setDelta('d-bounce', dl.bounceRate, true); // lower bounce is better

  drawTraffic($('db-traffic'), ov.series);
  drawDonut($('db-channels'), $('db-channels-legend'),
    (d.sources && d.sources.channels || []).map((c) => ({ label: c.channel, value: c.sessions })), 'SESSIONS');
  drawDonut($('db-newret'), $('db-newret-legend'),
    [{ label: 'New', value: ov.newVisitors || 0 }, { label: 'Returning', value: ov.returningVisitors || 0 }], 'VISITORS');

  // Traffic sources
  const src = d.sources || {};
  barList($('db-referrers'), (src.referrers || []).map((r) => ({ label: r.domain, value: r.sessions })), { empty: 'No referrers yet.' });
  barList($('db-keywords'), (src.keywords || []).map((k) => ({ label: k.keyword, value: k.hits })), { accent: '#34d399', empty: 'No search keywords yet.' });
  barList($('db-social'), (src.social || []).map((s) => ({ label: s.source, value: s.sessions })), { accent: '#a78bfa', empty: 'No social/video referrals yet.' });
  barList($('db-campaigns'), (src.campaigns || []).map((c) => ({ label: c.campaign, value: c.sessions, sub: [c.source, c.medium].filter(Boolean).join(' · ') })), { accent: '#f59e0b', empty: 'No UTM campaigns yet.' });
  barList($('db-youtube'), (src.youtube || []).map((y) => ({ label: y.video, value: y.sessions })), { accent: '#fb7185', empty: 'No YouTube referrals yet.' });

  // Visitors breakdowns — now with brand-tinted OS/browser glyphs + SVG flags.
  const vis = d.visitors || {};
  barList($('db-devices'), (vis.devices || []).map((x) => ({ label: x.key, value: x.value, icon: deviceIcon(x.key) })));
  barList($('db-os'), (vis.os || []).map((x) => ({ label: x.key, value: x.value, icon: osIcon(x.key) })), { accent: '#22d3ee' });
  barList($('db-browsers'), (vis.browsers || []).map((x) => ({ label: x.key, value: x.value, icon: browserIcon(x.key) })), { accent: '#a78bfa' });
  barList($('db-countries'), (vis.countries || []).map((x) => ({ label: x.name, value: x.value, icon: flagIcon(x.code) })), { accent: '#38bdf8' });
  barList($('db-cities'), (vis.cities || []).map((x) => ({ label: x.city, value: x.value, sub: x.country || '', icon: flagFor(x.country) })), { accent: '#fbbf24' });
  drawDonut($('db-vpn'), $('db-vpn-legend'), (vis.vpnRatio || []).map((v) => ({ label: v.name, value: v.value })), 'VISITORS');
  barList($('db-vpnisps'), (vis.vpnIsps || []).map((v) => ({ label: v.label, value: v.value })), { accent: '#fb7185', empty: 'No VPN/proxy ISPs detected.' });
  // New: device-mix donut + visitors-by-hour columns (hours derived from the visitor list).
  drawDonut($('db-devmix'), $('db-devmix-legend'), (vis.devices || []).map((x) => ({ label: x.key, value: x.value })), 'DEVICES');

  // Visitors list + Behavior
  lastVisitorList = d.visitorList || [];
  renderVisitorTable(lastVisitorList);
  drawHourHistogram(lastVisitorList);
  const beh = d.behavior || {};
  renderPagesTable(beh.topPages || []);
  barList($('db-entry'), (beh.entry || []).map((p) => ({ label: p.path, value: p.n })), { empty: 'No entry pages yet.' });
  barList($('db-exit'), (beh.exit || []).map((p) => ({ label: p.path, value: p.n })), { accent: '#fb7185', empty: 'No exit pages yet.' });
}

function setDelta(id, pct, goodWhenDown = false) {
  const el = $(id);
  if (!el) return;
  const { cls, text } = deltaChip(pct, goodWhenDown);
  el.className = 'ktrend ' + cls;
  el.textContent = `${text} vs prev`;
}

// ---------- visitor + page tables ----------
function locLabel(v) {
  return [v.city, v.countryName].filter(Boolean).join(', ') || 'Unknown';
}
function renderVisitorTable(rows) {
  const el = $('db-visitors');
  if (!el) return;
  const head = `<div class="dbt-h" style="grid-template-columns:72px 1.4fr 1.3fr 70px 90px 1.1fr 120px">
    <span>When</span><span>Location</span><span>Page</span><span>On&nbsp;page</span><span>Device</span><span>OS · Browser</span><span>IP</span></div>`;
  if (!rows.length) { el.innerHTML = head + '<div class="dbt-r"><span class="muted" style="grid-column:1/-1">No visitor activity yet.</span></div>'; return; }
  el.innerHTML = head + rows.map((v) => `
    <div class="dbt-r dbt-click" data-vid="${esc(v.visitorId)}" tabindex="0" role="button" style="grid-template-columns:72px 1.4fr 1.3fr 70px 90px 1.1fr 120px">
      <span class="muted" title="${new Date(v.ts).toLocaleString()}">${fmtAgo(v.ts)}</span>
      <span class="cell-flag">${flagFor(v.country, v.countryName)} ${esc(locLabel(v))}${v.isMe ? ' <span class="me-tag">you</span>' : ''}</span>
      <span class="mono">${esc(v.path)}</span>
      <span>${fmtDur(v.onPageSec)}</span>
      <span class="cell-ico">${deviceIcon(v.device)} ${esc(v.device || '—')}</span>
      <span class="muted cell-ico">${v.os ? osIcon(v.os) : ''}${v.browser ? browserIcon(v.browser) : ''} ${esc([v.os, v.browser].filter(Boolean).join(' · ') || '—')}</span>
      <span class="mono muted">${esc(v.ip || '—')}</span>
    </div>`).join('');
}

// Visitors-by-hour (UTC) histogram, derived from the visitor list timestamps so
// it works without any extra payload from the sidecar.
function drawHourHistogram(rows) {
  const svg = $('db-hours');
  if (!svg) return;
  const hours = Array.from({ length: 24 }, (_, h) => ({ label: String(h).padStart(2, '0'), value: 0 }));
  for (const v of rows || []) {
    const hh = new Date(v.ts).getUTCHours();
    if (!Number.isNaN(hh)) hours[hh].value++;
  }
  drawColumns(svg, hours, { accent: '#a78bfa', labelEvery: 3, empty: 'awaiting visitor timestamps' });
}
function renderPagesTable(rows) {
  const el = $('db-pages');
  if (!el) return;
  const head = `<div class="dbt-h" style="grid-template-columns:2fr 90px 90px 110px"><span>Page</span><span>Views</span><span>Visitors</span><span>Avg time</span></div>`;
  if (!rows.length) { el.innerHTML = head + '<div class="dbt-r"><span class="muted" style="grid-column:1/-1">No page views yet.</span></div>'; return; }
  el.innerHTML = head + rows.map((p) => `
    <div class="dbt-r" style="grid-template-columns:2fr 90px 90px 110px">
      <span class="mono">${esc(p.path)}</span>
      <span>${nf(p.views)}</span>
      <span>${nf(p.visitors)}</span>
      <span class="muted">${fmtDur(p.avgSec)}</span>
    </div>`).join('');
}

// ---------- visitor drawer (full journey) ----------
let drawer = null;
function ensureDrawer() {
  if (drawer) return drawer;
  drawer = document.createElement('div');
  drawer.className = 'db-drawer';
  drawer.hidden = true;
  drawer.innerHTML = `<div class="db-drawer-scrim"></div><aside class="db-drawer-panel"><button class="db-drawer-x" aria-label="Close">×</button><div class="db-drawer-body"></div></aside>`;
  document.body.appendChild(drawer);
  drawer.querySelector('.db-drawer-scrim').addEventListener('click', closeDrawer);
  drawer.querySelector('.db-drawer-x').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  return drawer;
}
function closeDrawer() { if (drawer) drawer.hidden = true; }
async function openVisitor(vid) {
  ensureDrawer();
  const body = drawer.querySelector('.db-drawer-body');
  body.innerHTML = '<p class="muted">Loading…</p>';
  drawer.hidden = false;
  const d = await gb(`visitor?id=${encodeURIComponent(vid)}`);
  if (!d) { body.innerHTML = '<p class="muted">Unavailable.</p>'; return; }
  const events = d.events || [];
  const vpn = d.vpn || {};
  const first = events[0] || {};
  const vpnBadge = vpn.isVpn ? `<span class="tag warn">${esc((vpn.type || 'vpn').toUpperCase())}</span>` : '<span class="tag ok">Clean</span>';
  body.innerHTML = `
    <h3>Visitor journey</h3>
    <div class="db-kv">
      <b>Visitor</b><span class="mono">${esc(vid)}</span>
      <b>Location</b><span>${first.country ? flagIcon(first.country) : ''} ${esc([first.city, first.country].filter(Boolean).join(', ') || 'Unknown')}</span>
      <b>IP</b><span class="mono">${esc(first.ip || '—')}</span>
      <b>Device</b><span>${esc([first.device, first.os, first.browser].filter(Boolean).join(' · ') || '—')}</span>
      <b>Connection</b><span>${vpnBadge} ${esc(vpn.isp || vpn.org || vpn.asName || '')}</span>
    </div>
    <div class="dp-title" style="margin-top:14px"><span class="dico">🧭</span> ${events.length} EVENTS</div>
    <div class="db-table">${events.map((e) => `
      <div class="dbt-r" style="grid-template-columns:72px 70px 1fr">
        <span class="muted" title="${new Date(e.ts).toLocaleString()}">${fmtAgo(e.ts)}</span>
        <span class="tag ${e.type}">${esc(e.type)}</span>
        <span class="mono">${esc(e.cta_label || e.path || '—')}</span>
      </div>`).join('') || '<p class="muted">No events.</p>'}</div>`;
}

function wireVisitorClicks() {
  $('db-visitors').addEventListener('click', (e) => {
    const row = e.target.closest('.dbt-click'); if (row) openVisitor(row.dataset.vid);
  });
  $('db-visitors').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.dbt-click'); if (row) { e.preventDefault(); openVisitor(row.dataset.vid); }
  });
  $('db-export-visitors').addEventListener('click', exportVisitorsCsv);
}
function exportVisitorsCsv() {
  const cols = ['ts', 'visitorId', 'country', 'city', 'path', 'onPageSec', 'device', 'os', 'browser', 'channel', 'source', 'ip'];
  const lines = [cols.join(',')].concat(lastVisitorList.map((v) =>
    cols.map((c) => {
      const val = c === 'ts' ? new Date(v.ts).toISOString() : (v[c] == null ? '' : v[c]);
      return `"${String(val).replace(/"/g, '""')}"`;
    }).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `databond-visitors-${currentRange}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ========== MAP (Traffic tab) ==========
let mapCtl = null, mapCtlView = null;
let renderGlobe = null, renderFlatMap = null;
let mapMarkers = [], mapCounts = {};
let selectedMarker = null;
let mapView = (() => { try { return localStorage.getItem('dbtv_map_view') === '3d' ? '3d' : '2d'; } catch { return '2d'; } })();

async function ensureMapModule() {
  if (mapView === '3d') {
    if (!renderGlobe) { try { ({ renderGlobe } = await import('./admin-map.js')); } catch { renderGlobe = null; } }
    if (!renderGlobe) mapView = '2d';
  }
  if (mapView === '2d' && !renderFlatMap) {
    try { ({ renderFlatMap } = await import('./admin-map-2d.js')); } catch { renderFlatMap = null; }
  }
}
function markerLabel(m) {
  return `${m.cc ? flagIcon(m.cc) : ''} ${esc([m.city, m.countryName].filter(Boolean).join(', ') || 'Unknown')} · ${nf(m.value)} visitor${m.value === 1 ? '' : 's'}`;
}
function renderMarkerDetail(m) {
  selectedMarker = m || null;
  const box = $('traffic-detail');
  if (!box) return;
  if (!m) { box.innerHTML = '<p class="muted">Select a city marker to inspect its visitor count and location.</p>'; return; }
  box.innerHTML = `
    <div class="ti-head"><b>${m.cc ? flagIcon(m.cc) : ''} ${esc(m.city || m.countryName || 'Unknown')}</b></div>
    <div class="kv">
      <b>Country</b><span>${esc(m.countryName || '—')}</span>
      <b>Visitors</b><span>${nf(m.value)}</span>
      <b>Coordinates</b><span>${m.lat != null ? `${m.lat.toFixed(2)}, ${m.lon.toFixed(2)}` : '—'}</span>
    </div>`;
}
function drawMap() {
  const factory = mapView === '3d' ? renderGlobe : renderFlatMap;
  if (factory) {
    if (mapCtl && mapCtlView !== mapView) { try { mapCtl.dispose(); } catch { /* ignore */ } mapCtl = null; }
    if (!mapCtl) {
      mapCtl = factory($('map'), mapMarkers, {
        counts: mapCounts, mode: 'viewers',
        onHover: (m) => { const h = $('map-hover'); if (h) h.innerHTML = m ? markerLabel(m) : ''; },
        onSelect: renderMarkerDetail,
      });
      mapCtlView = mapView;
    } else {
      mapCtl.update(mapMarkers, { counts: mapCounts, mode: 'viewers' });
    }
  } else {
    const map = $('map');
    if (map) map.innerHTML = '<div class="globe-fallback"><p class="muted">Map unavailable. Country ranking remains below.</p></div>';
  }
  const rows = Object.entries(mapCounts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const max = rows.length ? rows[0][1] : 1;
  $('country-rank').innerHTML = rows.length
    ? rows.map(([cc, n]) => `
      <div class="rank-row">
        <span class="rk-name">${flagIcon(cc)}<span>${esc(COUNTRY_NAME[cc] || cc)}</span></span>
        <span class="bar"><i style="width:${Math.round((n / max) * 100)}%;background:#38bdf8"></i></span>
        <span class="n">${nf(n)}</span>
      </div>`).join('')
    : '<p class="muted">No country traffic yet.</p>';
  if (!mapMarkers.includes(selectedMarker)) renderMarkerDetail(mapMarkers[0] || null);
}
async function loadMap() {
  await ensureMapModule();
  const [stats, geo] = await Promise.all([gb(`stats?${rangeQuery()}`), gb(`geo?range=${encodeURIComponent(currentRange)}`)]);
  if (!stats && !geo) return;
  mapCounts = {};
  for (const c of (stats && stats.visitors && stats.visitors.countries) || []) mapCounts[c.code] = c.value;
  mapMarkers = ((geo && geo.cities) || [])
    .filter((c) => typeof c.lat === 'number' && typeof c.lon === 'number')
    .map((c) => ({ lat: c.lat, lon: c.lon, cc: c.country, city: c.city, countryName: c.countryName, value: c.value, username: `${c.value} visitor${c.value === 1 ? '' : 's'}` }));
  drawMap();
}
function wireMapView() {
  const view = $('map-view');
  [...view.children].forEach((b) => b.classList.toggle('active', b.dataset.view === mapView));
  view.addEventListener('click', async (e) => {
    const btn = e.target.closest('button'); if (!btn || btn.dataset.view === mapView) return;
    mapView = btn.dataset.view === '3d' ? '3d' : '2d';
    try { localStorage.setItem('dbtv_map_view', mapView); } catch { /* ignore */ }
    await ensureMapModule();
    [...view.children].forEach((b) => b.classList.toggle('active', b.dataset.view === mapView));
    drawMap();
  });
}

// ========== REAL-TIME ==========
// Sourced from THIS site's native presence engine (/api/admin/analytics/realtime),
// so it works even when the GigaBrain sidecar is down/unconfigured.
async function loadRealtime() {
  let d;
  try { d = await api('/api/admin/analytics/realtime'); } catch { d = null; }
  if (!d) return;
  const badge = $('rt-active');
  const active = Number(d.active || 0);
  if (badge) badge.innerHTML = `${nf(active)} <span class="deck-dot"></span>live`;
  const el = $('rt-list');
  const rows = d.visitors || [];
  const head = `<div class="dbt-h" style="grid-template-columns:72px 1.4fr 1.3fr 70px 1fr 90px"><span>When</span><span>Location</span><span>Page</span><span>On&nbsp;page</span><span>Channel</span><span>Device</span></div>`;
  if (!el) return;
  if (!rows.length) { el.innerHTML = head + '<div class="dbt-r"><span class="muted" style="grid-column:1/-1">No active visitors in the last few minutes.</span></div>'; return; }
  el.innerHTML = head + rows.map((v) => `
    <div class="dbt-r" style="grid-template-columns:72px 1.4fr 1.3fr 70px 1fr 90px">
      <span class="muted">${fmtAgo(v.ts)}</span>
      <span class="cell-flag">${flagFor(v.country, v.countryName)} ${esc([v.city, v.countryName].filter(Boolean).join(', ') || 'Unknown')}${v.isMe ? ' <span class="me-tag">you</span>' : ''}</span>
      <span class="mono">${esc(v.path)}</span>
      <span>${fmtDur(v.onPageSec)}</span>
      <span class="muted">${esc(v.channel || 'direct')}${v.keyword ? ' · ' + esc(v.keyword) : ''}</span>
      <span class="cell-ico">${deviceIcon(v.device)} ${esc(v.device || '—')}</span>
    </div>`).join('');
}

// ========== ANALYTICS HEALTH (native, sidecar-independent) ==========
async function loadHealth() {
  const el = $('health-grid');
  if (!el) return;
  let d;
  try { d = await api('/api/admin/analytics/health'); } catch { el.innerHTML = '<p class="muted">Health check unavailable.</p>'; return; }
  const t = d.tracking || {};
  const dot = (ok, warn) => `<span class="hdot ${ok ? 'ok' : warn ? 'warn' : 'bad'}"></span>`;
  const ageTxt = (ms) => (ms == null ? 'never' : fmtAgo(ms));
  const fresh = d.lastEventAt != null && (Date.now() - d.lastEventAt) < 6 * 3600 * 1000;
  const tiles = [
    { k: 'Live visitors now', v: nf(d.activeNow || 0), ok: (d.activeNow || 0) > 0, warn: true, sub: 'native presence' },
    { k: 'Last tracked event', v: ageTxt(d.lastEventAt), ok: fresh, warn: d.lastEventAt != null, sub: 'page-visit beacon' },
    { k: 'Counted (24h)', v: nf(t.counted || 0), ok: (t.counted || 0) > 0, warn: true, sub: `${nf(t.pageviews || 0)} pageviews` },
    { k: 'Bot-filtered (24h)', v: nf(t.bots || 0), ok: true, warn: false, sub: 'excluded from stats' },
    { k: 'Rate-limited (24h)', v: nf(t.rateLimited || 0), ok: (t.rateLimited || 0) === 0, warn: true, sub: 'dropped as 204' },
    { k: 'Rollups fresh', v: d.rollupsFresh ? 'yes' : 'stale', ok: !!d.rollupsFresh, warn: false, sub: ageTxt(d.rollupUpdatedAt) },
    { k: 'Client tracker', v: d.trackerInjected ? 'injected' : 'missing', ok: !!d.trackerInjected, warn: false, sub: 'visit-tracker.js' },
    { k: 'GigaBrain sidecar', v: d.sidecar === 'ok' ? 'connected' : d.sidecar === 'unconfigured' ? 'off' : 'unreachable', ok: d.sidecar === 'ok', warn: d.sidecar === 'unconfigured', sub: 'secondary source' },
  ];
  el.innerHTML = tiles.map((x) => `
    <div class="htile">
      <div class="hk">${dot(x.ok, x.warn)} ${esc(x.k)}</div>
      <div class="hv">${esc(x.v)}</div>
      <div class="hs">${esc(x.sub)}</div>
    </div>`).join('');
  const verdict = $('health-verdict');
  if (verdict) {
    const trackingUp = fresh && (t.counted || 0) > 0;
    verdict.className = 'health-verdict ' + (trackingUp ? 'ok' : 'bad');
    verdict.textContent = trackingUp
      ? 'Tracking is live — events are flowing and rollups are fresh. Any drop reflects real traffic, not a tracking outage.'
      : 'No recent tracked events. Traffic may be genuinely low, or the tracker/rollups need attention — check the tiles above.';
  }
}

// ========== BUSINESS (David Bond TV's own data) ==========
function drawRevenueChart(svg, series, currency) {
  if (!svg) return;
  const data = Array.isArray(series) ? series : [];
  const W = 640, H = 200, pad = 10;
  if (!data.length || !data.some((d) => d.cents > 0)) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" fill="#64748b" font-size="13" text-anchor="middle" font-family="monospace">no revenue recorded yet</text>`;
    return;
  }
  const max = Math.max(1, ...data.map((d) => d.cents));
  const bw = (W - pad * 2) / data.length;
  svg.innerHTML = data.map((d, i) => {
    const h = Math.round((d.cents / max) * (H - pad * 2));
    const x = pad + i * bw;
    return `<rect x="${(x + bw * 0.16).toFixed(1)}" y="${H - pad - h}" width="${(bw * 0.68).toFixed(1)}" height="${h}" rx="2" fill="#34d399" opacity="0.85"><title>${d.month}: ${fmtMoney(d.cents, currency)}</title></rect>`;
  }).join('');
}
async function loadBusiness() {
  let d;
  try { d = await api('/api/admin/financial'); } catch { return; }
  if (d && d.revenue) {
    const cur = d.currency || 'usd';
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('biz-revenue', fmtMoney(d.revenue.total, cur));
    set('biz-revenue-sub', `subs ${fmtMoney(d.revenue.subscriptions, cur)} · courses ${fmtMoney(d.revenue.products, cur)}`);
    set('biz-sales', nf(d.sales.total));
    set('biz-sales-sub', `${nf(d.sales.subscriptions)} subscription · ${nf(d.sales.products)} course`);
    const s = d.subscriptions;
    set('biz-subs', nf(s.active + s.trialing + s.comp + s.pastDue));
    set('biz-subs-sub', `${nf(s.trialing)} trialing · ${nf(s.canceling)} canceling`);
    set('biz-paid', nf(d.users.paid));
    set('biz-paid-sub', `${nf(d.users.free)} free · ${d.users.conversion}% conversion`);
    drawRevenueChart($('biz-chart'), d.revenue.series, cur);
    const rows = [
      ['Active', s.active, '#34d399'], ['Trialing', s.trialing, '#f59e0b'],
      ['Past due', s.pastDue, '#fb7185'], ['Comp (admin)', s.comp, '#818cf8'],
      ['Canceling', s.canceling, '#22d3ee'], ['Canceled', s.canceled, '#64748b'],
    ];
    const max = Math.max(1, ...rows.map((r) => r[1]));
    const el = $('biz-subs-breakdown');
    if (el) el.innerHTML = rows.map(([label, n, c]) => `
      <div class="rank-row"><span>${esc(label)}</span>
      <span class="bar"><i style="width:${Math.round((n / max) * 100)}%;background:${c}"></i></span>
      <span class="n">${nf(n)}</span></div>`).join('');
  }
  try {
    const ov = await api('/api/admin/analytics/overview?range=30d');
    const vids = ov.topVideos || [];
    barList($('biz-videos'), vids.map((v) => ({ label: `🎬 ${v.title}`, value: v.views })), { empty: 'No views recorded yet.' });
  } catch { /* ignore */ }
}

// ========== GEO-DEFENSE (DBTV control + GigaBrain attempts) ==========
const ccLabel = (cc) => `${flagIcon(cc)} ${COUNTRY_NAME[cc] ? `${COUNTRY_NAME[cc]} (${cc})` : cc}`;
let blockedCountrySet = new Set();
let countryQuery = '';

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
async function loadGeoControl() {
  const d = await api('/api/admin/geo');
  renderGeo(d.rules);
  const det = d.detected || {};
  const srcTxt = det.countrySource ? ` (${det.countrySource})` : '';
  $('geo-detect').innerHTML = `This device — IP <b>${esc(det.ip)}</b>, country <b>${det.country ? flagIcon(det.country) + ' ' + det.country : 'unknown'}</b>${srcTxt}. `
    + `Bypass: <b>${det.bypass ? 'active ✓' : 'OFF'}</b>. Cloudflare: <b>${det.trustCloudflare ? 'trusted' : 'off'}</b>.`;
}
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
    b.addEventListener('mousedown', (e) => { e.preventDefault(); geoMutate('country', c.code, 'block'); $('cc-search').value = ''; countryQuery = ''; });
    return b;
  }));
}
function wireGeo() {
  $('geo-enabled').addEventListener('change', (e) => geoMutate('enabled', e.target.checked));
  const input = $('cc-search'); const menu = $('cc-results');
  const open = () => { menu.classList.remove('hidden'); renderCountryResults(); };
  input.addEventListener('focus', open);
  input.addEventListener('input', () => { countryQuery = input.value; open(); });
  input.addEventListener('blur', () => { setTimeout(() => menu.classList.add('hidden'), 120); });
  $('ip-add').addEventListener('click', () => { const v = $('ip-input').value.trim(); if (v) { geoMutate('ip', v, 'block'); $('ip-input').value = ''; } });
  $('allow-add').addEventListener('click', () => { const v = $('allow-input').value.trim(); if (v) { geoMutate('allow', v, 'add'); $('allow-input').value = ''; } });
  $('allow-me').addEventListener('click', () => geoMutate('allow', '', 'add'));
  $('sim-set').addEventListener('click', async () => { await api('/api/admin/geo/simulate', { method: 'POST', body: JSON.stringify({ cc: $('sim-input').value.trim() }) }); location.reload(); });
  $('sim-clear').addEventListener('click', async () => { await api('/api/admin/geo/simulate', { method: 'POST', body: JSON.stringify({ cc: '' }) }); location.reload(); });
}
async function loadGeoAttempts() {
  const d = await gb(`geo?range=${encodeURIComponent(currentRange)}`);
  if (!d) return;
  barList($('geo-summary'), (d.summary || []).map((s) => ({ label: s.name, value: s.attempts, icon: flagFor(s.code || s.cc || s.country, s.name), sub: s.lastTs ? `last ${fmtAgo(s.lastTs)}` : '' })), { accent: '#fb7185', empty: 'No blocked attempts recorded.' });
  const log = d.log || [];
  const el = $('geo-log');
  const head = `<div class="dbt-h" style="grid-template-columns:72px 80px 1.2fr 1fr"><span>When</span><span>Country</span><span>Path</span><span>Reason</span></div>`;
  el.innerHTML = head + (log.length ? log.slice(0, 50).map((r) => `
    <div class="dbt-r" style="grid-template-columns:72px 80px 1.2fr 1fr">
      <span class="muted">${fmtAgo(r.ts)}</span>
      <span class="cell-flag">${flagFor(r.country)} ${esc(r.country || '—')}</span>
      <span class="mono">${esc(r.path)}</span>
      <span class="muted">${esc(r.reason || '—')}</span>
    </div>`).join('') : '<div class="dbt-r"><span class="muted" style="grid-column:1/-1">No blocked requests.</span></div>');
}

// ========== boot ==========
async function main() {
  await requireAdmin();
  wireTabs();
  wireControls();
  wireMapView();
  wireGeo();
  wireVisitorClicks();
  const hr = $('health-refresh');
  if (hr) hr.addEventListener('click', () => loadHealth().catch(() => {}));

  // Periodic refresh for whichever live views are open.
  setInterval(() => { loadStats().catch(() => {}); }, 15000);
  setInterval(() => {
    const rt = document.querySelector('.deck-panel-tab[data-panel="realtime"]');
    if (rt && rt.classList.contains('on')) loadRealtime().catch(() => {});
  }, 10000);
  // Health tiles refresh while the Overview tab is showing.
  setInterval(() => {
    const ov = document.querySelector('.deck-panel-tab[data-panel="overview"]');
    if (ov && ov.classList.contains('on')) loadHealth().catch(() => {});
  }, 20000);

  // Initial load: stats + native health (both use this site's own data) + business + geo control.
  try { await Promise.all([loadStats(), loadHealth(), loadBusiness(), loadGeoControl()]); } catch { /* a 401 mid-flight reloads into the gate */ }
}
main();
