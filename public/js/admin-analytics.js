// Control Deck — admin dashboard. Cookie-authenticated. Loads site analytics
// and renders KPI cards, hand-rolled SVG charts (no chart library — keeps the
// zero-dependency build), a live visitor feed, the viewer world map, and the
// geo-restriction panel, organised into tabs. Every panel cites its data source.
//
// The Overview tab supports swappable *layouts* (Command Center, Mission Control,
// Analytics Grid, Executive Brief) — each a different visualization philosophy
// showing the same underlying data. See dashboard-layouts.js for the builders.
import { flagIcon } from './world-data.js';
import { COUNTRIES } from './countries.js';
import { requireAdmin } from './god-auth.js';
import { ADMIN_PATHS } from './admin-paths.js';
import { LAYOUTS, DEFAULT_LAYOUT, setGauge } from './dashboard-layouts.js';

const $ = (id) => document.getElementById(id);
const COUNTRY_NAME = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.name]));
const ccLabel = (cc) => `${flagIcon(cc)} ${COUNTRY_NAME[cc] ? `${COUNTRY_NAME[cc]} (${cc})` : cc}`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = (n) => Number(n || 0).toLocaleString();

// ---------- layout ----------
// The redesign settled on a single clean Command Center layout that matches the
// rest of the admin theme; the swappable-layout picker was removed.
const currentLayout = DEFAULT_LAYOUT;
let rawMetrics = null;

function applyLayoutHook() {
  const hook = LAYOUTS[currentLayout]?.postUpdate;
  if (hook) hook(null, rawMetrics);
}

function updateValue(id, newValue) {
  const el = $(id);
  if (!el) return;
  if (el.textContent !== newValue) {
    el.textContent = newValue;
    el.classList.remove('update-pulse');
    void el.offsetWidth;
    el.classList.add('update-pulse');
  }
}

async function api(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { location.reload(); throw new Error('unauth'); }
  return res.json().catch(() => ({}));
}

// ---------- live clock ----------
function tickClock() {
  const el = $('deck-clock');
  if (el) el.textContent = new Date().toUTCString().slice(17, 25) + ' UTC';
}

// ---------- tabs ----------
function wireTabs() {
  const bar = $('deck-tabs');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.deck-tab');
    if (!btn) return;
    const tab = btn.dataset.tab;
    bar.querySelectorAll('.deck-tab').forEach((b) => b.classList.toggle('on', b === btn));
    document.querySelectorAll('.deck-panel-tab').forEach((p) => p.classList.toggle('on', p.dataset.panel === tab));
    if (tab === 'financial') loadFinancial().catch(() => {});
  });
}

// ---------- charts (pure SVG) ----------
function trendPct(arr) {
  if (!arr || arr.length < 2) return null;
  const last = arr.slice(-7).reduce((a, b) => a + b, 0);
  const prev = arr.slice(-14, -7).reduce((a, b) => a + b, 0);
  if (!prev) return last > 0 ? 100 : null;
  return Math.round(((last - prev) / prev) * 1000) / 10;
}
function setTrend(id, pct) {
  const el = $(id);
  if (!el) return;
  if (pct == null) { el.className = 'ktrend flat'; el.textContent = '— no prior data'; return; }
  const up = pct >= 0;
  el.className = 'ktrend ' + (pct === 0 ? 'flat' : up ? 'up' : 'down');
  el.textContent = `${up ? '▲' : '▼'} ${Math.abs(pct)}% vs prev 7d`;
}
function sparkline(svg, values, color) {
  if (!svg) return;
  const v = values && values.length ? values : [0, 0];
  const max = Math.max(...v, 1), min = Math.min(...v, 0);
  const span = max - min || 1;
  const step = 120 / Math.max(v.length - 1, 1);
  const pts = v.map((n, i) => `${(i * step).toFixed(1)},${(26 - ((n - min) / span) * 24).toFixed(1)}`).join(' ');
  svg.innerHTML = `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/>`;
}
function drawTrend(svg, series) {
  if (!svg) return;
  const W = 640, H = 200, pad = 6;
  if (!series.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" fill="#64748b" font-size="13" text-anchor="middle" font-family="monospace">awaiting data…</text>`; return; }
  const xs = (i) => pad + (i * (W - pad * 2)) / Math.max(series.length - 1, 1);
  const line = (key, color, dash, fill) => {
    const vals = series.map((d) => d[key] || 0);
    const max = Math.max(...vals, 1);
    const ys = (n) => H - pad - (n / max) * (H - pad * 2);
    const pts = series.map((d, i) => `${xs(i).toFixed(1)},${ys(d[key] || 0).toFixed(1)}`).join(' ');
    let out = '';
    if (fill) out += `<polygon points="${pad},${H - pad} ${pts} ${W - pad},${H - pad}" fill="${color}" opacity="0.08"/>`;
    out += `<polyline fill="none" stroke="${color}" stroke-width="2" ${dash ? 'stroke-dasharray="5 4"' : ''} points="${pts}"/>`;
    return out;
  };
  let grid = '';
  for (let i = 1; i < 4; i++) grid += `<line x1="0" y1="${(H / 4) * i}" x2="${W}" y2="${(H / 4) * i}" stroke="#1e2030" stroke-width="0.5"/>`;
  svg.innerHTML = grid + line('views', '#818cf8', false, true) + line('minutes', '#f59e0b', true, false);
}
function drawDonut(svg, legendEl, countries) {
  const entries = Object.entries(countries || {})
    .map(([cc, s]) => [cc, s.views || 0]).filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!svg) return;
  if (!entries.length) { svg.innerHTML = `<text x="110" y="80" fill="#64748b" font-size="13" text-anchor="middle" font-family="monospace">no traffic yet</text>`; if (legendEl) legendEl.innerHTML = ''; return; }
  const top = entries.slice(0, 4);
  const otherN = entries.slice(4).reduce((a, [, n]) => a + n, 0);
  const slices = top.slice();
  if (otherN > 0) slices.push(['others', otherN]);
  const total = slices.reduce((a, [, n]) => a + n, 0) || 1;
  const colors = ['#818cf8', '#22d3ee', '#f59e0b', '#a78bfa', '#60a5fa'];
  const cx = 110, cy = 78, r = 58, rin = 36;
  let a0 = -Math.PI / 2, paths = '';
  slices.forEach(([, n], i) => {
    const a1 = a0 + (n / total) * Math.PI * 2;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const xi1 = cx + rin * Math.cos(a1), yi1 = cy + rin * Math.sin(a1);
    const xi0 = cx + rin * Math.cos(a0), yi0 = cy + rin * Math.sin(a0);
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    paths += `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${xi1.toFixed(1)},${yi1.toFixed(1)} A${rin},${rin} 0 ${large} 0 ${xi0.toFixed(1)},${yi0.toFixed(1)} Z" fill="${colors[i % colors.length]}" stroke="#0e0f14" stroke-width="1.5"/>`;
    a0 = a1;
  });
  svg.innerHTML = paths + `<text x="${cx}" y="${cy - 2}" fill="#e2e8f0" font-size="18" text-anchor="middle" font-family="monospace">${nf(total)}</text><text x="${cx}" y="${cy + 12}" fill="#64748b" font-size="9" text-anchor="middle" font-family="monospace">VIEWS</text>`;
  if (legendEl) {
    legendEl.innerHTML = slices.map(([cc, n], i) => {
      const pct = Math.round((n / total) * 100);
      const lab = cc === 'others' ? 'others' : `${flagIcon(cc)} ${cc}`;
      return `<span><i style="background:${colors[i % colors.length]}"></i>${lab} ${pct}%</span>`;
    }).join('');
  }
}

// ---------- data loaders ----------
let countryData = { viewers: {}, subscribers: {}, blocked: {} };
let trafficMarkers = [];
let globeCtl = null;       // { dispose, update } from renderGlobe
let currentMapMode = 'viewers';
let selectedTrafficMarker = null;
let renderGlobe = null;

// ---------- date-range filter ----------
const RANGES = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: 'custom', label: 'Custom' },
];
let currentRange = '30d';
let customFrom = '';
let customTo = '';

function rangeQuery() {
  if (currentRange === 'custom' && customFrom && customTo) {
    return `?range=custom&from=${encodeURIComponent(customFrom)}&to=${encodeURIComponent(customTo)}`;
  }
  return `?range=${encodeURIComponent(currentRange)}`;
}

// Inject the segmented range control + custom date inputs at the top of the
// Overview panel and re-load on change.
function mountRangeBar() {
  const panel = document.querySelector('[data-panel="overview"]');
  if (!panel || $('range-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'range-bar';
  bar.className = 'range-bar';
  const today = new Date().toISOString().slice(0, 10);
  if (!customTo) customTo = today;
  if (!customFrom) customFrom = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  bar.innerHTML = `
    <span class="range-label">📅 Range</span>
    <span class="seg" id="range-seg">${RANGES.map((r) => `<button type="button" data-range="${r.key}"${r.key === currentRange ? ' class="active"' : ''}>${r.label}</button>`).join('')}</span>
    <span class="range-custom" id="range-custom" ${currentRange === 'custom' ? '' : 'hidden'}>
      <input type="date" id="range-from" value="${customFrom}" max="${today}" />
      <span class="range-dash">→</span>
      <input type="date" id="range-to" value="${customTo}" max="${today}" />
    </span>
    <span class="range-note muted" id="range-note"></span>`;
  panel.insertBefore(bar, panel.firstChild);
  $('range-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-range]');
    if (!btn) return;
    currentRange = btn.dataset.range;
    [...$('range-seg').children].forEach((b) => b.classList.toggle('active', b === btn));
    $('range-custom').hidden = currentRange !== 'custom';
    if (currentRange !== 'custom' || (customFrom && customTo)) loadOverview().catch(() => {});
  });
  const onCustom = () => {
    customFrom = $('range-from').value || customFrom;
    customTo = $('range-to').value || customTo;
    if (currentRange === 'custom' && customFrom && customTo) loadOverview().catch(() => {});
  };
  $('range-from').addEventListener('change', onCustom);
  $('range-to').addEventListener('change', onCustom);
}

async function loadOverview() {
  const d = await api('/api/admin/analytics/overview' + rangeQuery());
  const series = d.series || [];
  const note = $('range-note');
  if (note) {
    note.textContent = d.granularity === 'hour'
      ? 'hourly · last 24h'
      : (d.from ? `${d.from} → ${d.to}` : '');
  }
  updateValue('kpi-views', nf(d.totals.views));
  updateValue('kpi-hours', nf(d.totals.hours));
  updateValue('kpi-users', nf(d.userCount));
  updateValue('kpi-blocked', nf((d.blocked && d.blocked.total) || 0));
  setTrend('trend-views', trendPct(series.map((s) => s.views)));
  setTrend('trend-hours', trendPct(series.map((s) => s.minutes)));
  setTrend('trend-blocked', trendPct(series.map((s) => s.blocked)));
  sparkline($('spark-views'), series.map((s) => s.views), '#818cf8');
  sparkline($('spark-hours'), series.map((s) => s.minutes), '#f59e0b');
  sparkline($('spark-blocked'), series.map((s) => s.blocked), '#fb7185');
  sparkline($('spark-users'), series.map((_, i) => i + 1), '#22d3ee');
  drawTrend($('trend-chart'), series);
  const stamp = new Date(d.generatedAt || Date.now()).toUTCString().slice(17, 25) + ' UTC';
  ['upd-1', 'upd-2', 'upd-3', 'upd-4'].forEach((id) => { const el = $(id); if (el) el.textContent = 'UPDATED ' + stamp; });
  const max = d.topVideos.length ? d.topVideos[0].views || 1 : 1;
  const tvEl = $('top-videos');
  if (tvEl) tvEl.innerHTML = d.topVideos.length
    ? d.topVideos.map((v) => `<div class="b"><div><a href="${ADMIN_PATHS.analytics}?v=${encodeURIComponent(v.id)}"><div class="lab">🎬 ${esc(v.title)}</div><div class="track"><div class="fill" style="width:${Math.max(3, Math.round((v.views / max) * 100))}%"></div></div></a></div><div class="n">${nf(v.views)}</div></div>`).join('')
    : '<p class="muted">No views recorded yet.</p>';
  applyLayoutHook();
}

function mapCounts(mode) {
  if (mode === 'subscribers') return countryData.subscribers || {};
  if (mode === 'blocked') return countryData.blocked || {};
  const out = {};
  for (const [cc, s] of Object.entries(countryData.viewers || {})) out[cc] = s.views || 0;
  return out;
}
function trafficLabel(m) {
  if (!m) return '';
  const loc = [m.city, m.region, m.country || m.cc].filter(Boolean).join(', ') || 'Unknown';
  return `${m.cc ? flagIcon(m.cc) : ''} ${esc(loc)} · ${esc(m.username || 'guest')}`;
}
function renderTrafficDetail(m) {
  selectedTrafficMarker = m || null;
  const box = $('traffic-detail');
  if (!box) return;
  if (!m) { box.innerHTML = '<p class="muted">Select a marker to inspect visitor, subscriber, device, and session details.</p>'; return; }
  const ip = m.ip ? `<code>${esc(m.ip)}</code> <a class="ip-btn" href="https://ipinfo.io/${encodeURIComponent(m.ip)}" target="_blank" rel="noopener">lookup</a>` : '—';
  box.innerHTML = `
    <div class="ti-head"><span class="badge ${m.type === 'blocked' ? 'blk' : m.subscriber ? 'sub' : 'none'}">${esc(m.type === 'blocked' ? 'Blocked' : m.subscriber ? 'Subscriber' : 'Viewer')}</span><b>${esc(m.username || 'Guest')}</b></div>
    <div class="kv">
      <b>Location</b><span>${trafficLabel(m)}</span>
      <b>Precision</b><span>${m.precise === false ? 'Country-level estimate' : 'City / coordinate'}</span>
      <b>IP</b><span>${ip}</span>
      <b>Content</b><span>${esc(m.videoTitle || m.reason || '—')}</span>
      <b>Device</b><span>${esc(m.deviceId || m.device?.type || '—')}</span>
      <b>Session</b><span><code>${esc(m.sessionId || '—')}</code></span>
      <b>Watched</b><span>${m.seconds ? Math.round(m.seconds) + 's' : '—'}</span>
    </div>`;
}
function drawMap(mode) {
  currentMapMode = mode;
  const counts = mapCounts(mode);
  const markers = mode === 'blocked'
    ? trafficMarkers.filter((m) => m.type === 'blocked')
    : mode === 'subscribers'
      ? trafficMarkers.filter((m) => m.subscriber && m.type !== 'blocked')
      : trafficMarkers.filter((m) => m.type !== 'blocked');
  if (renderGlobe) {
    // Create once, then update markers in place on live refresh / mode switch so the
    // camera, auto-rotation, and WebGL context persist (no flicker, no reset).
    if (!globeCtl) {
      globeCtl = renderGlobe($('map'), markers, {
        onHover: (m) => { $('map-hover').innerHTML = m ? trafficLabel(m) : ''; },
        onSelect: renderTrafficDetail,
      });
    } else {
      globeCtl.update(markers);
    }
  } else {
    const map = $('map');
    if (map) map.innerHTML = '<div class="globe-fallback"><p class="muted">Traffic globe is unavailable. Marker details remain available below.</p></div>';
  }
  const markerCounts = {};
  for (const m of markers) {
    const key = m.city ? `${m.city}, ${m.region || m.cc || ''}` : (m.cc || 'Unknown');
    markerCounts[key] = (markerCounts[key] || 0) + 1;
  }
  const rows = Object.entries(markerCounts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const max = rows.length ? rows[0][1] : 1;
  $('country-rank').innerHTML = rows.length
    ? rows.map(([label, n]) => `
      <div class="rank-row">
        <span>${esc(label)}</span>
        <span class="bar"><i style="width:${Math.round((n / max) * 100)}%"></i></span>
        <span class="n">${nf(n)}</span>
      </div>`).join('')
    : '<p class="muted">No precise marker data yet for this view.</p>';
  if (!markers.includes(selectedTrafficMarker)) renderTrafficDetail(markers[0] || null);
}
async function loadCountries(mode) {
  if (!renderGlobe) {
    try { ({ renderGlobe } = await import('./admin-map.js')); } catch { renderGlobe = null; }
  }
  const [countries, traffic] = await Promise.all([
    api('/api/admin/analytics/countries'),
    api('/api/admin/analytics/traffic?limit=1000'),
  ]);
  countryData = countries;
  trafficMarkers = traffic.markers || [];
  drawMap(mode);
  drawDonut($('donut'), $('donut-legend'), countryData.viewers);
}

// Live globe: refetch just the traffic markers and update the globe in place
// (no rebuild) so new visitors appear in near-real-time. Only runs once the
// globe has been created by the first loadCountries().
async function refreshTraffic() {
  if (!globeCtl) return;
  const traffic = await api(`/api/admin/analytics/traffic?limit=1000&mode=${encodeURIComponent(currentMapMode)}`);
  trafficMarkers = traffic.markers || [];
  drawMap(currentMapMode);
}

// ---------- financial ----------
function fmtMoney(cents, currency) {
  const v = (cents || 0) / 100;
  const cur = (currency || 'usd').toUpperCase();
  const body = v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur === 'USD' ? `$${body}` : `${body} ${cur}`;
}

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

async function loadFinancial() {
  let d;
  try { d = await api('/api/admin/financial'); } catch { return; }
  if (!d || !d.revenue) return;
  const cur = d.currency || 'usd';
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('fin-revenue', fmtMoney(d.revenue.total, cur));
  set('fin-revenue-sub', `subs ${fmtMoney(d.revenue.subscriptions, cur)} · courses ${fmtMoney(d.revenue.products, cur)}`);
  set('fin-sales', nf(d.sales.total));
  set('fin-sales-sub', `${nf(d.sales.subscriptions)} subscription · ${nf(d.sales.products)} course`);
  const s = d.subscriptions;
  set('fin-subs', nf(s.active + s.trialing + s.comp + s.pastDue));
  set('fin-subs-sub', `${nf(s.trialing)} trialing · ${nf(s.canceling)} canceling`);
  set('fin-paid', nf(d.users.paid));
  set('fin-paid-sub', `${nf(d.users.free)} free · ${d.users.conversion}% conversion`);
  drawRevenueChart($('fin-chart'), d.revenue.series, cur);
  const rows = [
    ['Active', s.active, '#34d399'],
    ['Trialing', s.trialing, '#f59e0b'],
    ['Past due', s.pastDue, '#fb7185'],
    ['Comp (admin)', s.comp, '#818cf8'],
    ['Canceling', s.canceling, '#22d3ee'],
    ['Canceled', s.canceled, '#64748b'],
  ];
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const el = $('fin-subs-breakdown');
  if (el) {
    el.innerHTML = rows.map(([label, n, c]) => `
      <div class="rank-row"><span>${esc(label)}</span>
      <span class="bar"><i style="width:${Math.round((n / max) * 100)}%;background:${c}"></i></span>
      <span class="n">${nf(n)}</span></div>`).join('');
  }
}

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
  const d = await api('/api/admin/analytics/visitors?limit=400');
  const events = d.events || [];
  const head = `<div class="h"><span>When</span><span>IP</span><span>Country</span><span>User · video</span><span><a href="${ADMIN_PATHS.logs}">Logs →</a></span></div>`;
  if (!events.length) {
    if (!box.innerHTML.includes('No visitor activity')) box.innerHTML = head + '<div class="row"><span class="ts">—</span><span></span><span></span><span class="who">No visitor activity recorded yet.</span><span></span></div>';
    return;
  }
  const newHTML = head + events.map((e) => {
    const cname = e.country || COUNTRY_NAME[e.cc] || e.cc || '';
    const flag = e.cc ? `<span class="cflag" title="${esc(cname || e.cc)}">${flagIcon(e.cc)}</span>` : '';
    const who = e.blocked ? '<span class="blk">⛔ blocked</span>' : (e.user ? esc(e.user) : 'guest');
    // Server resolves videoTitle (null when unknown) — never shows the raw UUID.
    const vidLabel = e.video ? esc(e.video) : (e.videoId ? '(removed video)' : '');
    const vid = vidLabel ? ' · ' + vidLabel : (e.reason ? ' · ' + esc(e.reason) : '');
    return `<div class="row">
      <span class="ts" title="${new Date(e.t).toLocaleString()}">${fmtAgo(e.t)}</span>
      <span class="ip">${esc(e.ip || '—')}</span>
      <span class="cc">${flag}<span class="cn">${esc(cname || '—')}</span></span>
      <span class="who">${who}${vid}</span>
      <span class="sec">${e.seconds ? e.seconds + 's' : '—'}</span>
    </div>`;
  }).join('');
  if (box.innerHTML !== newHTML) box.innerHTML = newHTML;
}

async function loadExtras() {
  try {
    const vids = (await (await fetch('/api/admin/videos')).json()).videos || [];
    const vc = $('vit-videos'); if (vc) vc.textContent = `${vids.length} live`;
    const qv = $('q-videos'); if (qv) qv.textContent = `— ${vids.length} in library`;
  } catch { /* ignore */ }
  try {
    const s = await (await fetch('/api/admin/status')).json();
    const ff = $('vit-ffmpeg'); if (ff) ff.textContent = s.ffmpeg ? `ready · ${(s.jobs || []).length} jobs` : 'unavailable';
  } catch { /* ignore */ }
  const vb = $('vit-build');
  if (vb) { const m = document.querySelector('.version-badge'); vb.textContent = m ? m.textContent.trim() : 'live'; }
  const d = await api('/api/admin/users');
  const users = d.users || [];
  const recent = users.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 10);
  const ru = $('recent-users');
  if (ru) ru.innerHTML = recent.length
    ? recent.map((u) => `<a class="dmini" href="${ADMIN_PATHS.users}">${esc(u.username || '—')} <span class="e">${esc(u.email || '')} · ${u.minutesWatched || 0}m${u.lastIp ? ' · ' + esc(u.lastIp) : ''}</span></a>`).join('')
    : '<p class="muted">No users yet.</p>';
}

// ---------- geo-restriction panel ----------
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
      e.preventDefault();
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
  $('allow-me').addEventListener('click', () => geoMutate('allow', '', 'add'));
  $('sim-set').addEventListener('click', async () => {
    const cc = $('sim-input').value.trim();
    await api('/api/admin/geo/simulate', { method: 'POST', body: JSON.stringify({ cc }) });
    location.reload();
  });
  $('sim-clear').addEventListener('click', async () => {
    await api('/api/admin/geo/simulate', { method: 'POST', body: JSON.stringify({ cc: '' }) });
    location.reload();
  });
}

function wireMapModes() {
  $('map-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    [...$('map-mode').children].forEach((b) => b.classList.toggle('active', b === btn));
    drawMap(btn.dataset.mode);
  });
}

// ---------- system metrics panel ----------
function fmtBytes(b) {
  if (b == null) return '—';
  const gb = b / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = b / (1024 ** 2);
  return `${mb.toFixed(0)} MB`;
}
function fmtUptime(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
// ---------- live server monitoring (compact CPU/RAM/Disk/Net strip) ----------
const MON_CAP = 60; // ~2.5 min of history at 2.5s
const metHist = { cpu: [], mem: [], disk: [], net: [] };

// Per-cell accent (matches the markup --mc) — graph + value use it; CPU/RAM/Disk
// shift toward red as they fill so a hot resource still reads at a glance.
const MON_TINT = { cpu: '#a3e635', ram: '#ec4899', disk: '#22d3ee', net: '#eab308' };
function loadColor(pct) {
  if (pct == null) return '#64748b';
  if (pct >= 90) return '#fb7185';
  if (pct >= 75) return '#f59e0b';
  return null; // use the cell's own tint
}
function fmtRate(bps) {
  if (bps == null) return '0 B/s';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} MB/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

// Filled area spark, newest on the right. maxVal fixes the y-scale (100 for %),
// or null to auto-scale (network throughput).
function monGraph(svg, values, color, maxVal) {
  if (!svg) return;
  const W = 200, H = 44;
  const v = values.length ? values : [0];
  const max = maxVal != null ? maxVal : Math.max(...v, 1);
  const step = v.length > 1 ? W / (v.length - 1) : W;
  const y = (val) => Math.round(H - (Math.min(max, val) / (max || 1)) * (H - 4) - 2);
  const pts = v.map((val, i) => [Math.round(i * step), y(val)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0]} ${H} L${pts[0][0]} ${H} Z`;
  svg.innerHTML = `<path d="${area}" fill="${color}" fill-opacity="0.18"/>`
    + `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`;
}

// Update one cell: big value, colour, sublabel.
function setCell(key, valueText, color, sub) {
  const v = $(`mon-${key}-val`); if (v) { v.textContent = valueText; if (color) v.style.color = color; }
  const s = $(`mon-${key}-sub`); if (s && sub != null) s.textContent = sub;
}

async function loadLive() {
  try {
    const m = await api('/api/admin/metrics/live');
    const cpuPct = (m.cpu && typeof m.cpu.percent === 'number') ? m.cpu.percent : null;
    const memPct = (m.memory && m.memory.total) ? Math.round((m.memory.used / m.memory.total) * 100) : null;
    if (cpuPct != null) { metHist.cpu.push(cpuPct); if (metHist.cpu.length > MON_CAP) metHist.cpu.shift(); }
    if (memPct != null) { metHist.mem.push(memPct); if (metHist.mem.length > MON_CAP) metHist.mem.shift(); }
    const cpuCol = loadColor(cpuPct) || MON_TINT.cpu;
    const ramCol = loadColor(memPct) || MON_TINT.ram;
    setCell('cpu', cpuPct == null ? '—' : `${cpuPct}%`, cpuCol, `${(m.cpu && m.cpu.cores) || '—'} cores`);
    setCell('ram', memPct == null ? '—' : `${memPct}%`, ramCol,
      m.memory ? `${fmtBytes(m.memory.used)} / ${fmtBytes(m.memory.total)}` : '—');
    monGraph($('graph-cpu'), metHist.cpu, cpuCol, 100);
    monGraph($('graph-mem'), metHist.mem, ramCol, 100);
    const net = m.net || {};
    const rx = typeof net.rxPerSec === 'number' ? net.rxPerSec : null;
    const tx = typeof net.txPerSec === 'number' ? net.txPerSec : null;
    const total = (rx || 0) + (tx || 0);
    if (rx != null || tx != null) { metHist.net.push(total); if (metHist.net.length > MON_CAP) metHist.net.shift(); }
    setCell('net', (rx == null && tx == null) ? '—' : fmtRate(total), MON_TINT.net, `↓ ${fmtRate(rx)} · ↑ ${fmtRate(tx)}`);
    monGraph($('graph-net'), metHist.net, MON_TINT.net, null);
  } catch { /* ignore */ }
}

async function loadMetrics() {
  try {
    const m = await api('/api/admin/metrics');
    rawMetrics = m;
    if (m.storage) {
      const dp = m.storage.pctUsed;
      metHist.disk.push(dp); if (metHist.disk.length > MON_CAP) metHist.disk.shift();
      const col = loadColor(dp) || MON_TINT.disk;
      setCell('disk', `${dp}%`, col, `${fmtBytes(m.storage.used)} / ${fmtBytes(m.storage.total)}`);
      monGraph($('graph-disk'), metHist.disk, col, 100);
    }
    const s = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    s('met-content', fmtBytes(m.disk?.content));
    s('met-media', fmtBytes(m.disk?.media));
    s('met-total', fmtBytes(m.disk?.total));
    s('met-avg', fmtBytes(m.videos?.avgOriginalSize));
    // Real filesystem capacity (statfs). Falls back to em-dash when unavailable.
    s('met-stused', m.storage ? `${fmtBytes(m.storage.used)} (${m.storage.pctUsed}%)` : '—');
    s('met-stcap', m.storage ? fmtBytes(m.storage.total) : '—');
    s('met-stfree', m.storage ? fmtBytes(m.storage.available) : '—');
    s('met-cores', `${m.cpu?.cores || '—'} × ${(m.cpu?.model || '').split(/\s+/).slice(0, 3).join(' ')}`);
    const ld = m.cpu?.load;
    s('met-load', ld ? ld.map((l) => l.toFixed(2)).join(' / ') : '—');
    s('met-ram', fmtBytes(m.memory?.used));
    s('met-ramfree', fmtBytes(m.memory?.free));
    s('met-uptime', fmtUptime(m.uptime));
    s('met-platform', m.platform || '—');
    s('met-node', m.nodeVersion || '—');
    s('met-proccount', `${m.videos?.processing || 0} active · ${m.videos?.failed || 0} failed`);
    applyLayoutHook();
  } catch { /* ignore */ }
}

async function main() {
  await requireAdmin();

  // Build the initial overview layout.
  const sec = document.querySelector('[data-panel="overview"]');
  if (sec) {
    sec.innerHTML = LAYOUTS[currentLayout].build();
    sec.dataset.layout = currentLayout;
  }

  mountRangeBar();
  wireTabs(); wireMapModes(); wireGeo();
  tickClock(); setInterval(tickClock, 1000);
  setInterval(() => { loadOverview().catch(() => {}); }, 10000);
  setInterval(() => { loadVisitors().catch(() => {}); }, 10000);
  setInterval(() => { loadMetrics().catch(() => {}); }, 10000);
  setInterval(() => { loadLive().catch(() => {}); }, 2500); // live CPU/memory graphs
  setInterval(() => { refreshTraffic().catch(() => {}); }, 12000); // live globe markers
  setInterval(() => {
    const p = document.querySelector('.deck-panel-tab[data-panel="financial"]');
    if (p && p.classList.contains('on')) loadFinancial().catch(() => {});
  }, 20000); // auto-refresh financial while its tab is open
  try {
    await Promise.all([loadOverview(), loadCountries('viewers'), loadGeo(), loadExtras(), loadVisitors(), loadMetrics(), loadLive()]);
  } catch { /* a 401 mid-flight reloads into the gate */ }
}
main();
