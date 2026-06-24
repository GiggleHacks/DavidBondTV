// Dashboard layout system. Each layout provides a different HTML structure and
// visualization philosophy for the Overview tab. All layouts expose the same
// element IDs so the data-loading code in admin-analytics.js just works.
// Layouts that add extra visual elements (gauges, meters) provide a postUpdate
// hook that runs after each data refresh.

import { ADMIN_PATHS } from './admin-paths.js';

// Shared fragments --------------------------------------------------------

const srcLine = (t) => `<div class="dsrc">${t}</div>`;
const helpQ = (t) => `<span class="q" title="${t}">?</span>`;

// Required hidden elements — if a layout doesn't surface every ID visually,
// they still must exist in the DOM so the updater doesn't error. Render them
// off-screen in a hidden div.
const HIDDEN_IDS = [
  'upd-1', 'upd-2', 'upd-3', 'upd-4',
  'vit-build', 'q-videos',
];
const hiddenBin = () => `<div style="display:none">${HIDDEN_IDS.map((id) => `<span id="${id}"></span>`).join('')}</div>`;

// SVG gauge ring helper (used by Mission Control + Analytics Grid).
function gaugeRing(id, label, color, size = 100, stroke = 8) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return `
    <div class="gauge" data-gauge="${id}" style="width:${size}px;height:${size}px">
      <svg viewBox="0 0 ${size} ${size}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="${stroke}"/>
        <circle class="gauge-arc" id="gauge-${id}" cx="${size / 2}" cy="${size / 2}" r="${r}"
          fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
          stroke-dasharray="${c}" stroke-dashoffset="${c}" transform="rotate(-90 ${size / 2} ${size / 2})"
          style="transition:stroke-dashoffset .8s ease"/>
      </svg>
      <div class="gauge-val" id="gauge-${id}-val">—</div>
      <div class="gauge-label">${label}</div>
    </div>`;
}

// Update a gauge arc to a 0–1 fraction.
export function setGauge(id, fraction) {
  const arc = document.getElementById(`gauge-${id}`);
  if (!arc) return;
  const r = parseFloat(arc.getAttribute('r'));
  const c = 2 * Math.PI * r;
  arc.style.strokeDashoffset = String(c * (1 - Math.min(1, Math.max(0, fraction))));
}

// =========================================================================
// LAYOUT 1 — Command Center (refined current)
// =========================================================================

function buildCommandCenter() {
  return `
    ${hiddenBin()}
    <div class="grid g-kpi">
      <div class="dpanel kpi">
        <div class="klabel"><span class="kemoji">👁️</span> TOTAL VIEWS</div>
        <div class="kv glow" id="kpi-views">—</div>
        <div class="ktrend flat" id="trend-views">· · ·</div>
        <svg class="kspark" id="spark-views" viewBox="0 0 120 28" preserveAspectRatio="none"></svg>
        <div class="dsrc">SOURCE: <b>analytics/raw event log</b><br>distinct viewId · 1st heartbeat · <span id="upd-1">—</span></div>
      </div>
      <div class="dpanel kpi amber">
        <div class="klabel"><span class="kemoji">⏱️</span> WATCH HOURS</div>
        <div class="kv glow" id="kpi-hours">—</div>
        <div class="ktrend flat" id="trend-hours">· · ·</div>
        <svg class="kspark" id="spark-hours" viewBox="0 0 120 28" preserveAspectRatio="none"></svg>
        <div class="dsrc">SOURCE: <b>Σ heartbeat seconds</b> ÷ 3600<br>clamped 300s/beat · <span id="upd-2">—</span></div>
      </div>
      <div class="dpanel kpi cyan">
        <div class="klabel"><span class="kemoji">👥</span> REGISTERED</div>
        <div class="kv glow" id="kpi-users">—</div>
        <div class="ktrend flat" id="trend-users">verified accounts</div>
        <svg class="kspark" id="spark-users" viewBox="0 0 120 28" preserveAspectRatio="none"></svg>
        <div class="dsrc">SOURCE: <b>data/users.json</b><br>email-verified only · <span id="upd-3">—</span></div>
      </div>
      <div class="dpanel kpi magenta">
        <div class="klabel"><span class="kemoji">🛡️</span> BLOCKED HITS</div>
        <div class="kv glow" id="kpi-blocked">—</div>
        <div class="ktrend flat" id="trend-blocked">· · ·</div>
        <svg class="kspark" id="spark-blocked" viewBox="0 0 120 28" preserveAspectRatio="none"></svg>
        <div class="dsrc">SOURCE: <b>geo-gate recordBlocked()</b><br>country / IP / user rules · <span id="upd-4">—</span></div>
      </div>
    </div>
    <div class="grid g-2 row-gap">
      <div class="dpanel">
        <div class="dp-title"><span class="dico">📈</span> VIEWS &amp; WATCH-TIME — LAST 30 DAYS ${helpQ('Daily rollups summed across every video. Times in server UTC.')}</div>
        <div class="dlegend"><span><i style="background:#818cf8"></i>Views</span><span><i style="background:#f59e0b"></i>Watch hrs</span></div>
        <svg class="dchart" id="trend-chart" viewBox="0 0 640 200" preserveAspectRatio="none" role="img" aria-label="Views and watch-time trend"></svg>
        ${srcLine('SOURCE: <b>analytics rollups</b> · 90-day retention · TZ server UTC')}
      </div>
      <div class="dpanel">
        <div class="dp-title"><span class="dico">🥧</span> TRAFFIC BY COUNTRY ${helpQ('Per-country first-heartbeat view counts from Cloudflare CF-IPCountry.')}</div>
        <svg class="dchart" id="donut" viewBox="0 0 220 160" role="img" aria-label="Traffic by country"></svg>
        <div class="dlegend" id="donut-legend" style="margin-top:8px"></div>
        ${srcLine('SOURCE: <b>GeoIP via Cloudflare</b> CF-IPCountry header')}
      </div>
    </div>
    <div class="grid g-3 row-gap">
      <div class="dpanel span2">
        <div class="dp-title"><span class="dico">🖥️</span> LIVE VISITOR FEED <span class="deck-dot" style="margin-left:4px"></span></div>
        <div class="dfeed" id="visitors"></div>
        ${srcLine('SOURCE: <b>raw/*.jsonl</b> · IP + GeoIP + watch event · 7-day retention')}
      </div>
      <div class="dpanel">
        <div class="dp-title"><span class="dico">⚙️</span> SYSTEM</div>
        <div class="dvit">
          <div><span class="k">VIDEOS</span><span class="g" id="vit-videos">—</span></div>
          <div><span class="k">LIBRARY</span><span class="g">● intact</span></div>
          <div><span class="k">BUILD</span><span class="c" id="vit-build">—</span></div>
          <div><span class="k">FFMPEG</span><span class="a" id="vit-ffmpeg">—</span></div>
        </div>
        <div style="margin-top:10px">
          <a class="dmini" href="${ADMIN_PATHS.upload}">⬆ Upload video <span class="e">— add new clips</span></a>
          <a class="dmini" href="${ADMIN_PATHS.videos}">🎬 Manage videos <span class="e" id="q-videos">—</span></a>
          <a class="dmini" href="${ADMIN_PATHS.pricing}">💲 Pricing <span class="e">— subscription &amp; intro</span></a>
        </div>
      </div>
    </div>
    <div class="grid g-3 row-gap">
      <div class="dpanel span3 mon-strip">
        <div class="mon-cell" style="--mc:#a3e635">
          <div class="mon-head"><span class="mon-name">CPU</span><span class="mon-val" id="mon-cpu-val">—</span></div>
          <svg class="mon-spark" id="graph-cpu" viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="mon-sub" id="mon-cpu-sub">—</div>
        </div>
        <div class="mon-cell" style="--mc:#ec4899">
          <div class="mon-head"><span class="mon-name">RAM</span><span class="mon-val" id="mon-ram-val">—</span></div>
          <svg class="mon-spark" id="graph-mem" viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="mon-sub" id="mon-ram-sub">—</div>
        </div>
        <div class="mon-cell" style="--mc:#22d3ee">
          <div class="mon-head"><span class="mon-name">DISK</span><span class="mon-val" id="mon-disk-val">—</span></div>
          <svg class="mon-spark" id="graph-disk" viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="mon-sub" id="mon-disk-sub">—</div>
        </div>
        <div class="mon-cell" style="--mc:#eab308">
          <div class="mon-head"><span class="mon-name">NET</span><span class="mon-val" id="mon-net-val">—</span></div>
          <svg class="mon-spark" id="graph-net" viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="mon-sub" id="mon-net-sub">—</div>
        </div>
      </div>
    </div>
    <div class="grid g-3 row-gap">
      <div class="dpanel span3">
        <div class="dp-title"><span class="dico">⏱️</span> SERVER</div>
        <div class="dvit dvit-wide" id="met-server">
          <div><span class="k">UPTIME</span><span class="g" id="met-uptime">—</span></div>
          <div><span class="k">PLATFORM</span><span class="c" id="met-platform">—</span></div>
          <div><span class="k">NODE</span><span class="a" id="met-node">—</span></div>
          <div><span class="k">PROCESSING</span><span class="c" id="met-proccount">—</span></div>
          <div><span class="k">TOTAL DISK</span><span class="g" id="met-total">—</span></div>
        </div>
      </div>
    </div>`;
}

// =========================================================================
// LAYOUT 2 — Mission Control (visual gauges + ring meters)
// =========================================================================

function buildMissionControl() {
  return `
    ${hiddenBin()}
    <!-- KPIs as big numbers in ring frames -->
    <div class="grid g-kpi mc-kpis">
      <div class="dpanel mc-kpi-card">
        <div class="mc-ring-wrap">
          <svg viewBox="0 0 80 80" class="mc-ring"><circle cx="40" cy="40" r="34" fill="none" stroke="rgba(129,140,248,.15)" stroke-width="4"/>
          <circle cx="40" cy="40" r="34" fill="none" stroke="#818cf8" stroke-width="4" stroke-dasharray="10 6" stroke-linecap="round"/></svg>
          <div class="mc-ring-val" id="kpi-views">—</div>
        </div>
        <div class="mc-kpi-label">Total Views</div>
        <div class="ktrend flat" id="trend-views">· · ·</div>
        <svg class="kspark" id="spark-views" viewBox="0 0 120 28" preserveAspectRatio="none" style="display:none"></svg>
      </div>
      <div class="dpanel mc-kpi-card">
        <div class="mc-ring-wrap">
          <svg viewBox="0 0 80 80" class="mc-ring"><circle cx="40" cy="40" r="34" fill="none" stroke="rgba(245,158,11,.15)" stroke-width="4"/>
          <circle cx="40" cy="40" r="34" fill="none" stroke="#f59e0b" stroke-width="4" stroke-dasharray="10 6" stroke-linecap="round"/></svg>
          <div class="mc-ring-val" id="kpi-hours">—</div>
        </div>
        <div class="mc-kpi-label">Watch Hours</div>
        <div class="ktrend flat" id="trend-hours">· · ·</div>
        <svg class="kspark" id="spark-hours" viewBox="0 0 120 28" preserveAspectRatio="none" style="display:none"></svg>
      </div>
      <div class="dpanel mc-kpi-card">
        <div class="mc-ring-wrap">
          <svg viewBox="0 0 80 80" class="mc-ring"><circle cx="40" cy="40" r="34" fill="none" stroke="rgba(34,211,238,.15)" stroke-width="4"/>
          <circle cx="40" cy="40" r="34" fill="none" stroke="#22d3ee" stroke-width="4" stroke-dasharray="10 6" stroke-linecap="round"/></svg>
          <div class="mc-ring-val" id="kpi-users">—</div>
        </div>
        <div class="mc-kpi-label">Registered</div>
        <div class="ktrend flat" id="trend-users">verified accounts</div>
        <svg class="kspark" id="spark-users" viewBox="0 0 120 28" preserveAspectRatio="none" style="display:none"></svg>
      </div>
      <div class="dpanel mc-kpi-card">
        <div class="mc-ring-wrap">
          <svg viewBox="0 0 80 80" class="mc-ring"><circle cx="40" cy="40" r="34" fill="none" stroke="rgba(251,113,133,.15)" stroke-width="4"/>
          <circle cx="40" cy="40" r="34" fill="none" stroke="#fb7185" stroke-width="4" stroke-dasharray="10 6" stroke-linecap="round"/></svg>
          <div class="mc-ring-val" id="kpi-blocked">—</div>
        </div>
        <div class="mc-kpi-label">Blocked Hits</div>
        <div class="ktrend flat" id="trend-blocked">· · ·</div>
        <svg class="kspark" id="spark-blocked" viewBox="0 0 120 28" preserveAspectRatio="none" style="display:none"></svg>
      </div>
    </div>

    <!-- System gauges — the centrepiece of this layout -->
    <div class="grid mc-gauges-grid row-gap">
      <div class="dpanel mc-gauge-panel">
        <div class="dp-title"><span class="dico">🧠</span> CPU LOAD</div>
        <div class="mc-gauge-row">
          ${gaugeRing('cpu', 'Load', '#818cf8', 120, 10)}
        </div>
        <div class="mc-gauge-meta">
          <span id="met-cores">—</span>
          <span>Load: <b id="met-load">—</b></span>
        </div>
      </div>
      <div class="dpanel mc-gauge-panel">
        <div class="dp-title"><span class="dico">💾</span> RAM USAGE</div>
        <div class="mc-gauge-row">
          ${gaugeRing('ram', 'RAM', '#22d3ee', 120, 10)}
        </div>
        <div class="mc-gauge-meta">
          <span>Used: <b id="met-ram">—</b></span>
          <span>Free: <b id="met-ramfree">—</b></span>
        </div>
      </div>
      <div class="dpanel mc-gauge-panel">
        <div class="dp-title"><span class="dico">📀</span> STORAGE</div>
        <div class="mc-gauge-row">
          ${gaugeRing('storage', 'Disk', '#f59e0b', 120, 10)}
        </div>
        <div class="mc-gauge-meta">
          <span>Used: <b id="met-stused">—</b> / <b id="met-stcap">—</b></span>
          <span>Available: <b id="met-stfree">—</b></span>
          <span>Our footprint: <b id="met-total">—</b></span>
          <span>Content: <b id="met-content">—</b> · Media: <b id="met-media">—</b></span>
        </div>
      </div>
    </div>

    <!-- Charts row -->
    <div class="grid g-2 row-gap">
      <div class="dpanel">
        <div class="dp-title"><span class="dico">📈</span> ACTIVITY — LAST 30 DAYS</div>
        <div class="dlegend"><span><i style="background:#818cf8"></i>Views</span><span><i style="background:#f59e0b"></i>Watch hrs</span></div>
        <svg class="dchart" id="trend-chart" viewBox="0 0 640 200" preserveAspectRatio="none"></svg>
      </div>
      <div class="dpanel">
        <div class="dp-title"><span class="dico">🥧</span> TRAFFIC BY COUNTRY</div>
        <svg class="dchart" id="donut" viewBox="0 0 220 160"></svg>
        <div class="dlegend" id="donut-legend" style="margin-top:8px"></div>
      </div>
    </div>

    <!-- Server status + visitors -->
    <div class="grid g-3 row-gap">
      <div class="dpanel span2">
        <div class="dp-title"><span class="dico">🖥️</span> LIVE FEED <span class="deck-dot" style="margin-left:4px"></span></div>
        <div class="dfeed" id="visitors"></div>
      </div>
      <div class="dpanel">
        <div class="dp-title"><span class="dico">⚙️</span> STATUS</div>
        <div class="mc-status-grid">
          <div class="mc-status-item"><span class="mc-dot mc-dot-green"></span><span>FFmpeg</span><span class="mc-sval" id="vit-ffmpeg">—</span></div>
          <div class="mc-status-item"><span class="mc-dot mc-dot-green"></span><span>Videos</span><span class="mc-sval" id="vit-videos">—</span></div>
          <div class="mc-status-item"><span class="mc-dot mc-dot-blue"></span><span>Uptime</span><span class="mc-sval" id="met-uptime">—</span></div>
          <div class="mc-status-item"><span class="mc-dot mc-dot-blue"></span><span>Platform</span><span class="mc-sval" id="met-platform">—</span></div>
          <div class="mc-status-item"><span class="mc-dot mc-dot-blue"></span><span>Node</span><span class="mc-sval" id="met-node">—</span></div>
          <div class="mc-status-item"><span class="mc-dot mc-dot-amber"></span><span>Processing</span><span class="mc-sval" id="met-proccount">—</span></div>
        </div>
        <span id="met-avg" style="display:none"></span>
      </div>
    </div>
    <div id="top-videos" style="display:none"></div>`;
}

function postMissionControl(overview, metrics) {
  if (!metrics) return;
  const cores = metrics.cpu?.cores || 1;
  const load1m = metrics.cpu?.load?.[0] || 0;
  const cpuFrac = Math.min(load1m / cores, 1);
  setGauge('cpu', cpuFrac);
  const cpuValEl = document.getElementById('gauge-cpu-val');
  if (cpuValEl) cpuValEl.textContent = `${Math.round(cpuFrac * 100)}%`;

  const memUsed = metrics.memory?.used || 0;
  const memTotal = memUsed + (metrics.memory?.free || 0);
  const ramFrac = memTotal > 0 ? memUsed / memTotal : 0;
  setGauge('ram', ramFrac);
  const ramValEl = document.getElementById('gauge-ram-val');
  if (ramValEl) ramValEl.textContent = `${Math.round(ramFrac * 100)}%`;

  // Storage gauge — real filesystem capacity when available (metrics.storage from
  // statfs); the arc shows how full the whole volume is. Falls back to our own
  // content usage against a reference only when statfs is unsupported.
  const st = metrics.storage;
  let storageFrac;
  const sValEl = document.getElementById('gauge-storage-val');
  if (st && st.total > 0) {
    storageFrac = st.used / st.total;
    if (sValEl) sValEl.textContent = `${st.pctUsed}%`;
  } else {
    const totalBytes = metrics.disk?.total || 0;
    const ref = Math.max(50 * 1024 ** 3, totalBytes * 2);
    storageFrac = ref > 0 ? totalBytes / ref : 0;
    if (sValEl) {
      const gb = totalBytes / (1024 ** 3);
      sValEl.textContent = gb >= 1 ? `${gb.toFixed(1)}G` : `${(totalBytes / (1024 ** 2)).toFixed(0)}M`;
    }
  }
  setGauge('storage', storageFrac);
}

// =========================================================================
// LAYOUT 3 — Analytics Grid (dense compact cards)
// =========================================================================

function buildAnalyticsGrid() {
  const miniCard = (icon, label, id, color) => `
    <div class="dpanel ag-card" style="border-top:2px solid ${color}">
      <div class="ag-icon">${icon}</div>
      <div class="ag-num" id="${id}">—</div>
      <div class="ag-label">${label}</div>
    </div>`;
  return `
    ${hiddenBin()}
    <div class="grid ag-grid">
      ${miniCard('👁️', 'Views', 'kpi-views', '#818cf8')}
      ${miniCard('⏱️', 'Hours', 'kpi-hours', '#f59e0b')}
      ${miniCard('👥', 'Users', 'kpi-users', '#22d3ee')}
      ${miniCard('🛡️', 'Blocked', 'kpi-blocked', '#fb7185')}
      ${miniCard('🎬', 'Videos', 'vit-videos', '#a78bfa')}
      ${miniCard('⚙️', 'FFmpeg', 'vit-ffmpeg', '#60a5fa')}
    </div>

    <!-- Trends row (hidden for JS compat) -->
    <div style="display:none">
      <span id="trend-views"></span><span id="trend-hours"></span>
      <span id="trend-users"></span><span id="trend-blocked"></span>
      <svg id="spark-views"></svg><svg id="spark-hours"></svg>
      <svg id="spark-users"></svg><svg id="spark-blocked"></svg>
    </div>

    <!-- Charts side-by-side -->
    <div class="grid g-2 row-gap">
      <div class="dpanel">
        <div class="dp-title" style="font-size:10px">VIEWS &amp; WATCH-TIME — 30 DAYS</div>
        <svg class="dchart" id="trend-chart" viewBox="0 0 640 200" preserveAspectRatio="none"></svg>
      </div>
      <div class="dpanel">
        <div class="dp-title" style="font-size:10px">TRAFFIC BY COUNTRY</div>
        <svg class="dchart" id="donut" viewBox="0 0 220 160"></svg>
        <div class="dlegend" id="donut-legend" style="margin-top:6px"></div>
      </div>
    </div>

    <!-- System meters — horizontal progress bars -->
    <div class="dpanel row-gap">
      <div class="dp-title" style="font-size:10px">SYSTEM RESOURCES</div>
      <div class="ag-meters">
        <div class="ag-meter">
          <span class="ag-m-label">CPU Load</span>
          <div class="ag-m-track"><div class="ag-m-fill" id="ag-meter-cpu" style="width:0%;background:#818cf8"></div></div>
          <span class="ag-m-val" id="met-load">—</span>
        </div>
        <div class="ag-meter">
          <span class="ag-m-label">RAM</span>
          <div class="ag-m-track"><div class="ag-m-fill" id="ag-meter-ram" style="width:0%;background:#22d3ee"></div></div>
          <span class="ag-m-val" id="met-ram">—</span>
        </div>
        <div class="ag-meter">
          <span class="ag-m-label">Storage</span>
          <div class="ag-m-track"><div class="ag-m-fill" id="ag-meter-storage" style="width:0%;background:#f59e0b"></div></div>
          <span class="ag-m-val" id="met-total">—</span>
        </div>
      </div>
      <div class="ag-sys-row">
        <span><b id="met-cores">—</b> cores</span>
        <span>Free: <b id="met-ramfree">—</b></span>
        <span>Content: <b id="met-content">—</b></span>
        <span>Media: <b id="met-media">—</b></span>
        <span>Avg orig: <b id="met-avg">—</b></span>
        <span>Uptime: <b id="met-uptime">—</b></span>
        <span><b id="met-platform">—</b></span>
        <span>Node <b id="met-node">—</b></span>
        <span><b id="met-proccount">—</b></span>
      </div>
    </div>

    <!-- Compact visitor feed -->
    <div class="dpanel row-gap">
      <div class="dp-title" style="font-size:10px">LIVE VISITORS <span class="deck-dot" style="margin-left:4px"></span></div>
      <div class="dfeed ag-feed" id="visitors"></div>
    </div>
    <div id="top-videos" style="display:none"></div>`;
}

function postAnalyticsGrid(overview, metrics) {
  if (!metrics) return;
  const cores = metrics.cpu?.cores || 1;
  const load1m = metrics.cpu?.load?.[0] || 0;
  const cpuPct = Math.min(100, Math.round((load1m / cores) * 100));
  const cpuBar = document.getElementById('ag-meter-cpu');
  if (cpuBar) cpuBar.style.width = cpuPct + '%';

  const memUsed = metrics.memory?.used || 0;
  const memTotal = memUsed + (metrics.memory?.free || 0);
  const ramPct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;
  const ramBar = document.getElementById('ag-meter-ram');
  if (ramBar) ramBar.style.width = ramPct + '%';

  const totalBytes = metrics.disk?.total || 0;
  const ref = Math.max(50 * 1024 ** 3, totalBytes * 2);
  const storagePct = ref > 0 ? Math.round((totalBytes / ref) * 100) : 0;
  const sBar = document.getElementById('ag-meter-storage');
  if (sBar) sBar.style.width = storagePct + '%';
}

// =========================================================================
// LAYOUT 4 — Executive Brief (big hero numbers, clean sections)
// =========================================================================

function buildExecutiveBrief() {
  return `
    ${hiddenBin()}
    <!-- Hero stat -->
    <div class="dpanel eb-hero">
      <div class="eb-hero-label">Total Views — All Time</div>
      <div class="eb-hero-num" id="kpi-views">—</div>
      <div class="ktrend flat eb-hero-trend" id="trend-views">· · ·</div>
      <svg class="dchart eb-hero-chart" id="trend-chart" viewBox="0 0 640 200" preserveAspectRatio="none"></svg>
    </div>

    <!-- Secondary stats -->
    <div class="grid eb-stats row-gap">
      <div class="dpanel eb-stat">
        <div class="eb-stat-label">Watch Hours</div>
        <div class="eb-stat-num" id="kpi-hours">—</div>
        <div class="ktrend flat" id="trend-hours" style="font-size:12px">· · ·</div>
      </div>
      <div class="dpanel eb-stat">
        <div class="eb-stat-label">Registered Users</div>
        <div class="eb-stat-num" id="kpi-users">—</div>
        <div class="ktrend flat" id="trend-users" style="font-size:12px">verified accounts</div>
      </div>
      <div class="dpanel eb-stat">
        <div class="eb-stat-label">Blocked Hits</div>
        <div class="eb-stat-num" id="kpi-blocked">—</div>
        <div class="ktrend flat" id="trend-blocked" style="font-size:12px">· · ·</div>
      </div>
    </div>

    <!-- Hidden sparklines for JS compat -->
    <div style="display:none">
      <svg id="spark-views"></svg><svg id="spark-hours"></svg>
      <svg id="spark-users"></svg><svg id="spark-blocked"></svg>
    </div>

    <!-- Country + visitors side by side -->
    <div class="grid g-2 row-gap">
      <div class="dpanel">
        <div class="dp-title"><span class="dico">🌍</span> TRAFFIC BY COUNTRY</div>
        <svg class="dchart" id="donut" viewBox="0 0 220 160"></svg>
        <div class="dlegend" id="donut-legend" style="margin-top:8px"></div>
      </div>
      <div class="dpanel">
        <div class="dp-title"><span class="dico">🖥️</span> LIVE VISITORS <span class="deck-dot" style="margin-left:4px"></span></div>
        <div class="dfeed" id="visitors"></div>
      </div>
    </div>

    <!-- System health — clean rows -->
    <div class="dpanel row-gap">
      <div class="dp-title"><span class="dico">⚙️</span> SYSTEM HEALTH</div>
      <div class="eb-health">
        <div class="eb-h-row">
          <div class="eb-h-item"><span class="eb-h-dot" style="background:#4ade80"></span>Server</div>
          <div class="eb-h-detail">Uptime <b id="met-uptime">—</b> · <span id="met-platform">—</span> · Node <span id="met-node">—</span></div>
        </div>
        <div class="eb-h-row">
          <div class="eb-h-item"><span class="eb-h-dot" style="background:#818cf8"></span>CPU</div>
          <div class="eb-h-detail"><span id="met-cores">—</span> · Load <span id="met-load">—</span></div>
        </div>
        <div class="eb-h-row">
          <div class="eb-h-item"><span class="eb-h-dot" style="background:#22d3ee"></span>Memory</div>
          <div class="eb-h-detail">Used <b id="met-ram">—</b> · Free <b id="met-ramfree">—</b></div>
        </div>
        <div class="eb-h-row">
          <div class="eb-h-item"><span class="eb-h-dot" style="background:#f59e0b"></span>Storage</div>
          <div class="eb-h-detail">Content <b id="met-content">—</b> · Media <b id="met-media">—</b> · Total <b id="met-total">—</b> · Avg orig <b id="met-avg">—</b></div>
        </div>
        <div class="eb-h-row">
          <div class="eb-h-item"><span class="eb-h-dot" style="background:#a78bfa"></span>Library</div>
          <div class="eb-h-detail"><span id="vit-videos">—</span> · FFmpeg <span id="vit-ffmpeg">—</span> · <span id="met-proccount">—</span></div>
        </div>
      </div>
    </div>
    <div id="top-videos" style="display:none"></div>`;
}

// =========================================================================
// Registry
// =========================================================================

export const LAYOUTS = {
  command:   { label: 'Command Center',  icon: '⌨️', build: buildCommandCenter,  postUpdate: null },
  mission:   { label: 'Mission Control', icon: '🚀', build: buildMissionControl, postUpdate: postMissionControl },
  grid:      { label: 'Analytics Grid',  icon: '📊', build: buildAnalyticsGrid,  postUpdate: postAnalyticsGrid },
  executive: { label: 'Executive Brief', icon: '📋', build: buildExecutiveBrief, postUpdate: null },
};

export const DEFAULT_LAYOUT = 'command';
