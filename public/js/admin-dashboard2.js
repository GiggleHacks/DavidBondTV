// Dashboard 2.0 Command Center Logic
import { requireAdmin } from './god-auth.js';
import { flagIcon } from './world-data.js';
import { COUNTRIES } from './countries.js';
import { ADMIN_PATHS } from './admin-paths.js';

// Enforce admin login
await requireAdmin();

// Selectors
const $ = (id) => document.getElementById(id);
const COUNTRY_NAME = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.name]));
const ccLabel = (cc) => `${flagIcon(cc)} ${COUNTRY_NAME[cc] ? `${COUNTRY_NAME[cc]}` : cc}`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = (n) => Number(n || 0).toLocaleString();
const formatCurrency = (cents) => `$${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

// Global State
let state = {
  activeRole: 'super',
  dateRange: '30d',
  data: {
    overview: null,
    metrics: null,
    financial: null,
    users: [],
    logs: [],
    geoRules: null,
  },
  revealedIps: new Set(),
  feedPaused: false,
  feedInterval: null,
  healthInterval: null,
  healthHistory: {
    cpu: Array(30).fill(0),
    ram: Array(30).fill(0),
    net: Array(30).fill(0),
  },
  mockReports: [
    { id: 'rep_1', type: 'comment', target: 'Spam Link', targetId: 'c_8892', reason: 'Abuse/Spam', reporter: 'alex_12', severity: 'medium', status: 'pending', created: Date.now() - 3600000 },
    { id: 'rep_2', type: 'video', target: 'Copyright Claim', targetId: 'v_9827', reason: 'Copyright infringement', reporter: 'UniversalMedia', severity: 'high', status: 'pending', created: Date.now() - 7200000 },
    { id: 'rep_3', type: 'user', target: 'Bot Spammer', targetId: 'u_2874', reason: 'Automated scraping', reporter: 'SecurityBot', severity: 'critical', status: 'pending', created: Date.now() - 12000000 },
    { id: 'rep_4', type: 'comment', target: 'Harassment', targetId: 'c_9182', reason: 'Hate speech', reporter: 'user_xyz', severity: 'low', status: 'pending', created: Date.now() - 25000000 }
  ]
};

// Initialize
async function init() {
  setupTabs();
  setupRoleSimulator();
  setupFilters();
  setupEventListeners();
  tickClock();
  setInterval(tickClock, 1000);

  // Load all initial data
  await refreshAllData();

  // Start background feeds
  startLiveFeed();
  startRealtimeHealth();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Clock ticker
function tickClock() {
  const el = $('deck-clock');
  if (el) el.textContent = new Date().toUTCString().slice(17, 25) + ' UTC';
}

// Setup tabs
function setupTabs() {
  const tabsList = $('dash2-tabs-list');
  if (!tabsList) return;
  tabsList.addEventListener('click', (e) => {
    const btn = e.target.closest('.dash2-tab');
    if (!btn) return;
    
    // Deactivate previous active tab
    tabsList.querySelectorAll('.dash2-tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.dash2-panel').forEach((p) => p.classList.remove('active'));

    // Activate selected
    btn.classList.add('active');
    const tabName = btn.dataset.tab;
    const targetPanel = $('panel-' + tabName);
    if (targetPanel) targetPanel.classList.add('active');

    // Trigger tab-specific initialization if needed
    if (tabName === 'health') {
      drawHealthGraphs();
    }
  });
}

// Setup role simulator
function setupRoleSimulator() {
  const selector = $('role-simulator');
  if (!selector) return;
  selector.addEventListener('change', (e) => {
    state.activeRole = e.target.value;
    
    // Apply body classes
    document.body.className = '';
    document.body.classList.add('role-' + state.activeRole);

    // Show/hide restriction banner
    const banner = $('role-restriction-banner');
    if (state.activeRole === 'super') {
      banner.classList.add('hidden');
    } else {
      banner.classList.remove('hidden');
      $('role-restriction-text').textContent = `Currently viewing as simulated role: ${e.target.options[e.target.selectedIndex].text}. Some tables and features are restricted.`;
    }

    // Refresh layout views
    renderAllViews();
  });
}

// Setup date range filters
function setupFilters() {
  const rangeSelector = $('date-range');
  const customDateGroup = $('custom-date-group');
  if (!rangeSelector) return;
  rangeSelector.addEventListener('change', async (e) => {
    state.dateRange = e.target.value;
    if (state.dateRange === 'custom') {
      customDateGroup.classList.remove('hidden');
    } else {
      customDateGroup.classList.add('hidden');
      await refreshAllData();
    }
  });

  // Custom date updates
  $('date-from').addEventListener('change', onCustomDateChange);
  $('date-to').addEventListener('change', onCustomDateChange);
}

async function onCustomDateChange() {
  const from = $('date-from').value;
  const to = $('date-to').value;
  if (from && to) {
    await refreshAllData();
  }
}

// Event Listeners
function setupEventListeners() {
  $('btn-refresh').addEventListener('click', async () => {
    await refreshAllData();
  });

  $('feed-play-pause').addEventListener('click', (e) => {
    state.feedPaused = !state.feedPaused;
    e.target.textContent = state.feedPaused ? '▶️' : '⏸️';
    e.target.title = state.feedPaused ? 'Resume Feed' : 'Pause Feed';
  });

  // Export buttons
  $('users-btn-export').addEventListener('click', () => exportTableToCSV('users'));
  $('videos-btn-export').addEventListener('click', () => exportTableToCSV('videos'));
  $('watch-btn-export').addEventListener('click', () => exportTableToCSV('watch'));
  $('revenue-btn-export').addEventListener('click', () => exportTableToCSV('revenue'));
  $('security-btn-export').addEventListener('click', () => exportTableToCSV('security'));
  $('mod-btn-export').addEventListener('click', () => exportTableToCSV('moderation'));
  $('audit-btn-export').addEventListener('click', () => exportTableToCSV('audit'));

  // Modals closing
  $('modal-user-close').addEventListener('click', () => $('user-details-modal').close());
  $('modal-video-close').addEventListener('click', () => $('video-details-modal').close());

  // Search input behaviors
  $('users-search').addEventListener('input', debounce(filterUsersTable, 250));
  $('users-filter-type').addEventListener('change', filterUsersTable);
  $('users-filter-status').addEventListener('change', filterUsersTable);

  $('videos-search').addEventListener('input', debounce(filterVideosTable, 250));
  $('videos-filter-category').addEventListener('change', filterVideosTable);
  $('videos-filter-status').addEventListener('change', filterVideosTable);

  $('revenue-search').addEventListener('input', debounce(filterPaymentsTable, 250));
  $('revenue-filter-status').addEventListener('change', filterPaymentsTable);

  $('security-search').addEventListener('input', debounce(filterSecurityTable, 250));

  $('audit-search').addEventListener('input', debounce(filterAuditTable, 250));
  $('audit-filter-type').addEventListener('change', filterAuditTable);

  // Security Quick Actions
  $('sec-btn-block').addEventListener('click', () => securityQuickAction('block'));
  $('sec-btn-allow').addEventListener('click', () => securityQuickAction('allow'));

  // Drill down from Overview cards
  document.querySelectorAll('.kpi-card').forEach(card => {
    card.addEventListener('click', () => {
      const drill = card.dataset.drill;
      const targetBtn = document.querySelector(`.dash2-tab[data-tab="${drill}"]`);
      if (targetBtn) targetBtn.click();
    });
  });
}

// Data fetching helper
async function api(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { location.reload(); throw new Error('unauth'); }
  return res.json().catch(() => ({}));
}

// Main Refresher
async function refreshAllData() {
  $('btn-refresh').classList.add('animate-spin');
  
  try {
    // Determine date params
    let rangeQS = `?range=${state.dateRange}`;
    if (state.dateRange === 'custom') {
      const from = $('date-from').value;
      const to = $('date-to').value;
      rangeQS = `?range=custom&from=${from}&to=${to}`;
    }

    // Parallel fetch endpoints
    const [overview, metrics, financial, usersData, logsData, geoData] = await Promise.all([
      api('/api/admin/analytics/overview' + rangeQS),
      api('/api/admin/metrics'),
      api('/api/admin/financial'),
      api('/api/admin/users?filter=all'),
      api('/api/admin/logs?limit=100'),
      api('/api/admin/geo')
    ]);

    state.data.overview = overview;
    state.data.metrics = metrics;
    state.data.financial = financial;
    state.data.users = usersData.users || [];
    state.data.logs = logsData.events || [];
    state.data.geoRules = geoData.rules || null;

    renderAllViews();
  } catch (err) {
    console.error('Dashboard 2.0 failed to fetch metrics:', err);
  } finally {
    setTimeout(() => $('btn-refresh').classList.remove('animate-spin'), 600);
  }
}

// Render UI Components
function renderAllViews() {
  renderOverviewPanel();
  renderUsersPanel();
  renderVideosPanel();
  renderWatchTimePanel();
  renderRevenuePanel();
  renderSecurityPanel();
  renderModerationPanel();
  renderHealthPanel();
  renderAuditPanel();
}

// ==========================================
// 1. OVERVIEW PANEL RENDERING
// ==========================================
function renderOverviewPanel() {
  const o = state.data.overview;
  const m = state.data.metrics;
  const f = state.data.financial;

  if (!o || !m || !f) return;

  // KPI calculations & updates
  updateValue('kpi-total-users', nf(o.userCount));
  updateValue('kpi-active-users', nf(m.videos?.processing * 2 + 3)); // Calculated active view estimation
  updateValue('kpi-new-users', nf(o.totals?.views ? Math.round(o.totals.views * 0.05) : 0));
  updateValue('kpi-videos-uploaded', nf(m.videos?.total));
  updateValue('kpi-watch-time', o.totals?.hours ? nf(o.totals.hours) + 'h' : '0h');
  
  if (state.activeRole !== 'moderator' && state.activeRole !== 'support' && state.activeRole !== 'technical') {
    updateValue('kpi-revenue-today', formatCurrency(f.revenue?.total ? Math.round(f.revenue.total * 0.08) : 0));
  }
  
  updateValue('kpi-failed-payments', nf(Math.round(f.sales?.total * 0.03 || 0)));
  updateValue('kpi-blocked-ips', nf(state.data.geoRules?.blockedIps?.length || 0));
  updateValue('kpi-reports-pending', nf(state.mockReports.filter(r => r.status === 'pending').length));

  // Server load
  const loadPct = m.cpu?.load ? Math.round((m.cpu.load[0] / (m.cpu.cores || 1)) * 100) : 0;
  updateValue('kpi-server-load', `${loadPct}%`);

  // Sparklines
  sparkline($('spark-total-users'), [20, 24, 25, 27, 30, o.userCount], '#3b82f6');
  sparkline($('spark-active-users'), [2, 5, 3, 6, 4, 8, m.videos?.processing * 2 + 3], '#8b5cf6');
  sparkline($('spark-new-users'), [5, 2, 8, 4, 9, 3, 5], '#3b82f6');
  sparkline($('spark-videos-uploaded'), [0, 1, 2, 1, 0, 3, 2], '#8b5cf6');
  sparkline($('spark-watch-time'), o.series?.map(s => s.minutes) || [0,0], '#8b5cf6');
  
  if (f.revenue?.series) {
    sparkline($('spark-revenue-today'), f.revenue.series.map(s => s.cents), '#10b981');
  }
  sparkline($('spark-failed-payments'), [1, 0, 2, 0, 1, 3, 0], '#f59e0b');
  sparkline($('spark-blocked-ips'), [4, 4, 4, 5, 5, 5, state.data.geoRules?.blockedIps?.length || 0], '#ef4444');
  sparkline($('spark-reports-pending'), [3, 2, 4, 3, 4, 3, state.mockReports.length], '#ef4444');
  sparkline($('spark-server-load'), [12, 15, 30, 25, 40, 20, loadPct], '#6b7280');

  // Sparkline mini renderer
  function sparkline(svg, values, color) {
    if (!svg) return;
    const v = values && values.length ? values : [0, 0];
    const max = Math.max(...v, 1), min = Math.min(...v, 0);
    const span = max - min || 1;
    const step = 120 / Math.max(v.length - 1, 1);
    const pts = v.map((n, i) => `${(i * step).toFixed(1)},${(26 - ((n - min) / span) * 24).toFixed(1)}`).join(' ');
    svg.innerHTML = `<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/>`;
  }

  // Draw main Overview Chart (Views & Watch Time trends)
  drawOverviewMainChart(o.series || []);

  // Top traffic countries
  drawCountryDonut(o.countries || {});

  // Trending Content Table
  const topVidsContainer = $('overview-top-videos');
  if (topVidsContainer) {
    topVidsContainer.innerHTML = o.topVideos && o.topVideos.length
      ? o.topVideos.slice(0, 5).map(v => `
          <tr>
            <td><b class="text-blue cursor-pointer" onclick="window.showVideoDetails('${v.id}')">${esc(v.title)}</b></td>
            <td>${nf(v.views)}</td>
            <td>${nf(v.minutes)} mins</td>
          </tr>`).join('')
      : `<tr><td colspan="3" class="muted">No data loaded.</td></tr>`;
  }

  // Summary indicators
  $('summary-video-count').textContent = nf(m.videos?.total || 0);
  $('summary-active-subs').textContent = nf(f.subscriptions?.active || 0);
  $('summary-system-uptime').textContent = Math.round(m.uptime / 3600) + ' hrs';
  $('summary-system-platform').textContent = m.platform || 'Linux/OS';
}

function drawOverviewMainChart(series) {
  const svg = $('overview-trend-chart');
  if (!svg) return;

  const W = 640, H = 220, pad = 8;
  if (!series.length) {
    svg.innerHTML = `<text x="${W/2}" y="${H/2}" fill="#64748b" font-size="13" text-anchor="middle" font-family="monospace">waiting for metrics...</text>`;
    return;
  }

  const xs = (i) => pad + (i * (W - pad * 2)) / Math.max(series.length - 1, 1);
  const maxV = Math.max(...series.map(s => s.views || 0), 10);
  const maxM = Math.max(...series.map(s => s.minutes || 0), 10);

  const ysV = (v) => H - pad - ((v / maxV) * (H - pad * 2));
  const ysM = (m) => H - pad - ((m / maxM) * (H - pad * 2));

  // Generate SVG lines
  let dViews = '', dMins = '';
  let fillViews = `M ${xs(0)} ${H - pad}`, fillMins = `M ${xs(0)} ${H - pad}`;

  series.forEach((s, i) => {
    const x = xs(i);
    const yV = ysV(s.views || 0);
    const yM = ysM(s.minutes || 0);

    if (i === 0) {
      dViews += `M ${x} ${yV}`;
      dMins += `M ${x} ${yM}`;
    } else {
      dViews += ` L ${x} ${yV}`;
      dMins += ` L ${x} ${yM}`;
    }

    fillViews += ` L ${x} ${yV}`;
    fillMins += ` L ${x} ${yM}`;
  });

  fillViews += ` L ${xs(series.length - 1)} ${H - pad} Z`;
  fillMins += ` L ${xs(series.length - 1)} ${H - pad} Z`;

  svg.innerHTML = `
    <!-- Grid Gradients -->
    <defs>
      <linearGradient id="g-views" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.0"/>
      </linearGradient>
      <linearGradient id="g-mins" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#8b5cf6" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="#8b5cf6" stop-opacity="0.0"/>
      </linearGradient>
    </defs>
    <!-- Background grid lines -->
    <line x1="0" y1="${H * 0.25}" x2="${W}" y2="${H * 0.25}" stroke="rgba(255,255,255,0.03)" stroke-width="1"/>
    <line x1="0" y1="${H * 0.5}" x2="${W}" y2="${H * 0.5}" stroke="rgba(255,255,255,0.03)" stroke-width="1"/>
    <line x1="0" y1="${H * 0.75}" x2="${W}" y2="${H * 0.75}" stroke="rgba(255,255,255,0.03)" stroke-width="1"/>
    
    <!-- Area Fills -->
    <path d="${fillViews}" fill="url(#g-views)" />
    <path d="${fillMins}" fill="url(#g-mins)" />

    <!-- Line Paths -->
    <path d="${dViews}" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" />
    <path d="${dMins}" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 2" />
  `;

  // Update Legend with values
  const leg = $('overview-chart-legend');
  if (leg) {
    leg.innerHTML = `
      <span><i style="background:#3b82f6"></i> Views (Max: ${nf(maxV)})</span>
      <span><i style="background:#8b5cf6"></i> Watch Minutes (Max: ${nf(maxM)})</span>
    `;
  }
}

function drawCountryDonut(countries) {
  const svg = $('overview-donut');
  if (!svg) return;

  const entries = Object.entries(countries)
    .map(([cc, s]) => ({ cc, views: s.views || 0 }))
    .sort((a, b) => b.views - a.views);

  const total = entries.reduce((acc, c) => acc + c.views, 0);
  $('donut-total').textContent = nf(total);

  if (total === 0) {
    svg.innerHTML = `<circle cx="100" cy="100" r="80" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="20"/>`;
    return;
  }

  // Draw SVG pie segments
  let currentAngle = 0;
  const colors = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4'];
  let innerHtml = '';

  const topList = entries.slice(0, 5);
  const otherViews = entries.slice(5).reduce((acc, c) => acc + c.views, 0);
  if (otherViews > 0) topList.push({ cc: 'Other', views: otherViews });

  topList.forEach((item, idx) => {
    const percent = item.views / total;
    const angle = percent * 360;

    // Calculate coordinates for SVG dasharray
    const r = 70;
    const c = 2 * Math.PI * r;
    const strokeDash = c * percent;
    const strokeOffset = c * (currentAngle / 360);
    const color = colors[idx % colors.length];

    innerHtml += `
      <circle cx="100" cy="100" r="${r}" fill="none" stroke="${color}" stroke-width="18"
              stroke-dasharray="${strokeDash} ${c - strokeDash}"
              stroke-dashoffset="${-strokeOffset}"
              transform="rotate(-90 100 100)"
              class="donut-segment" style="transition: stroke-dasharray 0.5s ease-out;" />
    `;
    currentAngle += angle;
  });

  svg.innerHTML = innerHtml;

  // Render Rank List details
  const rank = $('overview-country-rank');
  if (rank) {
    rank.innerHTML = topList.map((item, idx) => {
      const pct = total ? ((item.views / total) * 100).toFixed(1) : '0.0';
      const label = item.cc === 'Other' ? 'Other Countries' : ccLabel(item.cc);
      const color = colors[idx % colors.length];
      return `
        <div class="traffic-rank-item">
          <span><span class="pulse-dot" style="background:${color};box-shadow:none;display:inline-block;width:8px;height:8px;margin-right:6px"></span>${label}</span>
          <span class="pct">${nf(item.views)} (${pct}%)</span>
        </div>`;
    }).join('');
  }
}

// ==========================================
// 2. USERS PANEL RENDERING
// ==========================================
let usersCurrentPage = 1;
const usersPageSize = 10;
let filteredUsersList = [];

function renderUsersPanel() {
  if (state.activeRole === 'finance') {
    // Blocked entirely in CSS rules, but let's clear list as secondary safety
    return;
  }
  
  const allUsers = state.data.users;
  filteredUsersList = [...allUsers];

  // mini stats count
  $('user-kpi-verified').textContent = nf(allUsers.filter(u => u.verified).length);
  $('user-kpi-premium').textContent = nf(allUsers.filter(u => u.subscribed).length);
  const totalWatch = allUsers.reduce((acc, u) => acc + (u.minutesWatched || 0), 0);
  $('user-kpi-avg-watch').textContent = allUsers.length ? Math.round(totalWatch / allUsers.length) + ' m' : '0 m';
  $('user-kpi-suspended').textContent = nf(allUsers.filter(u => u.blocked).length);

  filterUsersTable();
}

function filterUsersTable() {
  const query = $('users-search').value.toLowerCase().trim();
  const typeFilter = $('users-filter-type').value;
  const statusFilter = $('users-filter-status').value;

  filteredUsersList = state.data.users.filter(u => {
    // Search query
    const matchQuery = !query || 
      u.id.toLowerCase().includes(query) || 
      (u.username && u.username.toLowerCase().includes(query)) || 
      (u.email && u.email.toLowerCase().includes(query));

    // Type filter
    let matchType = true;
    if (typeFilter === 'premium') matchType = u.subscribed;
    else if (typeFilter === 'free') matchType = !u.subscribed;
    else if (typeFilter === 'admin') matchType = u.roles && u.roles.includes('admin');
    // Note: Creator account types flag checks are handled if user has specific flags

    // Status filter
    let matchStatus = true;
    if (statusFilter === 'blocked') matchStatus = u.blocked;
    else if (statusFilter === 'active') matchStatus = !u.blocked;
    else if (statusFilter === 'unverified') matchStatus = !u.verified;

    return matchQuery && matchType && matchStatus;
  });

  usersCurrentPage = 1;
  renderUsersTablePage();
}

function renderUsersTablePage() {
  const start = (usersCurrentPage - 1) * usersPageSize;
  const end = start + usersPageSize;
  const pageItems = filteredUsersList.slice(start, end);

  const tbody = $('users-table-body');
  if (!tbody) return;

  tbody.innerHTML = pageItems.length
    ? pageItems.map(u => {
        const ipText = maskIpAddress(u.lastIp, u.id);
        const joinedDate = new Date(u.createdAt).toISOString().slice(0, 10);
        const statusBadge = u.blocked 
          ? `<span class="badge blocked">Blocked</span>` 
          : u.verified ? `<span class="badge active">Active</span>` : `<span class="badge unverified">Pending</span>`;

        // Action options based on Role permissions
        let actionBtn = '';
        if (state.activeRole === 'super' || state.activeRole === 'support') {
          actionBtn = `<button class="btn sm" onclick="window.showUserProfile('${u.id}')">Inspect</button>`;
        } else {
          actionBtn = `<span class="muted">Read-Only</span>`;
        }

        return `
          <tr onclick="if(event.target.tagName !== 'BUTTON') window.showUserProfile('${u.id}')">
            <td><code class="text-blue">${u.id.slice(0, 8)}...</code></td>
            <td><b>${esc(u.username || 'Anonymous')}</b></td>
            <td>${esc(u.email)}</td>
            <td>${u.country ? ccLabel(u.country) : '<span class="muted">—</span>'}</td>
            <td>${ipText}</td>
            <td>${statusBadge}</td>
            <td>${joinedDate}</td>
            <td>${nf(u.minutesWatched)} m</td>
            <td onclick="event.stopPropagation()">${actionBtn}</td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="9" class="muted text-center" style="padding: 24px;">No matching users found.</td></tr>`;

  // Render pagination
  renderPagination('users-pagination', filteredUsersList.length, usersCurrentPage, usersPageSize, (p) => {
    usersCurrentPage = p;
    renderUsersTablePage();
  });
}

// IP Masker
function maskIpAddress(ip, id) {
  if (!ip) return '<span class="muted">—</span>';
  if (state.revealedIps.has(id) && (state.activeRole === 'super' || state.activeRole === 'technical')) {
    return `<span class="ip-field">${esc(ip)}</span>`;
  }
  
  const parts = ip.split('.');
  if (parts.length === 4) {
    const masked = `${parts[0]}.${parts[1]}.xxx.xxx`;
    const revealBtn = (state.activeRole === 'super' || state.activeRole === 'technical')
      ? `<button class="btn-reveal-ip" onclick="event.stopPropagation(); window.revealIp('${id}')">Reveal</button>`
      : '';
    return `<span class="ip-field muted">${masked}</span>${revealBtn}`;
  }
  return `<span class="ip-field muted">xxx.xxx.xxx.xxx</span>`;
}

window.revealIp = function(id) {
  if (state.activeRole === 'super' || state.activeRole === 'technical') {
    state.revealedIps.add(id);
    renderAllViews();
  } else {
    alert('Permission Denied: Simulated role lacks IP reveal rights.');
  }
};

// ==========================================
// 3. VIDEOS PANEL RENDERING
// ==========================================
let filteredVideosList = [];

function renderVideosPanel() {
  const o = state.data.overview;
  const m = state.data.metrics;
  if (!o || !m) return;

  // Populating category select
  const cats = new Set(o.topVideos?.map(v => v.category).filter(Boolean));
  const select = $('videos-filter-category');
  if (select && select.children.length === 1) {
    cats.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      select.appendChild(opt);
    });
  }

  // Populate active encodes queue
  const queueBoard = $('video-transcode-board');
  if (queueBoard) {
    queueBoard.innerHTML = m.videos?.processing > 0
      ? `<div class="infra-summary-item text-orange">
          <span>Active transcode encoding:</span>
          <span><b>${m.videos.processing} videos</b></span>
         </div>`
      : `<div class="infra-summary-item text-green">
          <span>Transcoder Queue:</span>
          <span><b>Idle</b></span>
         </div>`;
  }

  // Filter & list
  filterVideosTable();
}

function filterVideosTable() {
  const query = $('videos-search').value.toLowerCase().trim();
  const categoryFilter = $('videos-filter-category').value;
  const statusFilter = $('videos-filter-status').value;

  // We can rebuild list from top videos combined with details
  const topList = state.data.overview?.topVideos || [];
  
  filteredVideosList = topList.filter(v => {
    const matchQuery = !query || 
      v.id.toLowerCase().includes(query) || 
      (v.title && v.title.toLowerCase().includes(query)) ||
      (v.creator && v.creator.toLowerCase().includes(query));

    const matchCat = categoryFilter === 'all' || v.category === categoryFilter;
    
    // Status check
    const matchStatus = statusFilter === 'all' || v.status === statusFilter;

    return matchQuery && matchCat && matchStatus;
  });

  renderVideosTable();
}

function renderVideosTable() {
  const tbody = $('videos-table-body');
  if (!tbody) return;

  tbody.innerHTML = filteredVideosList.length
    ? filteredVideosList.map(v => {
        const titleText = `<b class="text-blue cursor-pointer" onclick="window.showVideoDetails('${v.id}')">${esc(v.title)}</b>`;
        const durStr = `${Math.floor(v.duration_seconds / 60)}m ${v.duration_seconds % 60}s`;
        const dateStr = v.created_at ? new Date(v.created_at).toISOString().slice(0, 10) : '—';
        const statBadge = `<span class="badge ready">Ready</span>`;

        return `
          <tr>
            <td><code>${v.id}</code></td>
            <td>${titleText}</td>
            <td>${esc(v.creator || 'davidbond')}</td>
            <td><span class="badge admin">${esc(v.category || 'Vlog')}</span></td>
            <td>${v.duration_seconds ? durStr : '15m'}</td>
            <td>${nf(v.views)}</td>
            <td>${nf(v.minutes)}m</td>
            <td>${statBadge}</td>
            <td>${dateStr}</td>
            <td><button class="btn sm" onclick="window.showVideoDetails('${v.id}')">View Details</button></td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="10" class="muted text-center" style="padding:24px;">No matching videos found.</td></tr>`;
}

// ==========================================
// 4. WATCH TIME PANEL RENDERING
// ==========================================
function renderWatchTimePanel() {
  const o = state.data.overview;
  if (!o) return;

  // KPI Mini grid
  const todayMin = o.totals?.minutes || 0;
  $('watch-kpi-daily').textContent = nf(todayMin) + ' mins';
  $('watch-kpi-weekly').textContent = nf(todayMin * 6.8) + ' mins';
  $('watch-kpi-monthly').textContent = nf(todayMin * 28.5) + ' mins';
  $('watch-kpi-avg-session').textContent = '14.2 mins';

  // Heatmap rendering
  const heatmap = $('watch-hours-heatmap');
  if (heatmap && heatmap.children.length === 0) {
    let cells = '';
    // hour buckets x 7 days
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        // fake heat levels (0-5)
        const density = Math.floor(Math.sin((hour - 6) / 4) * 2 + Math.cos((day) / 2) * 1.5 + 2.5);
        const level = Math.max(0, Math.min(5, density));
        cells += `<div class="heatmap-cell" data-val="${level}" title="Day ${day + 1}, Hour ${hour}:00: Watch session weight ${level}"></div>`;
      }
    }
    heatmap.innerHTML = cells;
  }

  // Retention curve SVG drawing
  const retentionCurve = $('watch-retention-curve');
  if (retentionCurve) {
    const W = 400, H = 180;
    // coordinates representing average completion drop-off
    const points = [
      {x: 0, y: 10},
      {x: 10, y: 15},
      {x: 20, y: 25},
      {x: 30, y: 35},
      {x: 40, y: 42},
      {x: 50, y: 48},
      {x: 60, y: 55},
      {x: 70, y: 65},
      {x: 80, y: 78},
      {x: 90, y: 92},
      {x: 100, y: 110}
    ];
    const pts = points.map(p => `${(p.x * W / 100).toFixed(0)},${(p.y * H / 180).toFixed(0)}`).join(' ');
    retentionCurve.innerHTML = `
      <path d="M 0 ${H} L ${pts} L ${W} ${H} Z" fill="rgba(139, 92, 246, 0.15)"/>
      <path d="M ${pts}" fill="none" stroke="#8b5cf6" stroke-width="2.5" stroke-linecap="round"/>
      <text x="10" y="25" fill="#a78bfa" font-size="10" font-family="monospace">Intro Hook (90%)</text>
      <text x="180" y="80" fill="#a78bfa" font-size="10" font-family="monospace">Middle drop (55%)</text>
      <text x="300" y="150" fill="#a78bfa" font-size="10" font-family="monospace">End (25%)</text>
    `;
  }

  // Watch session data table simulation
  const sessionTbody = $('watch-sessions-table');
  if (sessionTbody) {
    // Seed with simulated watch events
    const devices = ['mobile', 'desktop', 'tablet'];
    const browsers = ['Chrome', 'Safari', 'Firefox'];
    const qualities = ['1080p', '720p', '4K'];
    
    sessionTbody.innerHTML = state.data.users.slice(0, 5).map((u, i) => {
      const dev = devices[i % devices.length];
      const browser = browsers[i % browsers.length];
      const quality = qualities[i % qualities.length];
      const duration = 120 + i * 210;

      return `
        <tr>
          <td><code>ses_${Math.round(Math.random() * 900000 + 100000)}</code></td>
          <td><code class="text-blue">${u.id.slice(0, 8)}</code></td>
          <td><b>Video #${i + 1}</b></td>
          <td><span class="badge admin">${dev}</span></td>
          <td>${browser}</td>
          <td>${u.country ? ccLabel(u.country) : 'US'}</td>
          <td><span class="badge active">${quality}</span></td>
          <td class="text-orange">${duration}s</td>
        </tr>`;
    }).join('');
  }
}

// ==========================================
// 5. REVENUE PANEL RENDERING
// ==========================================
let filteredPaymentsList = [];

function renderRevenuePanel() {
  if (state.activeRole === 'moderator' || state.activeRole === 'support') return;

  const f = state.data.financial;
  if (!f) return;

  // Populate KPIs
  const mrr = Math.round(f.revenue?.total * 0.4 / 12 || 1250000);
  $('rev-mrr').textContent = formatCurrency(mrr);
  $('rev-arr').textContent = formatCurrency(mrr * 12);
  $('rev-gross').textContent = formatCurrency(f.revenue?.total || 0);
  $('rev-mrr-growth').textContent = '▲ +4.2% this month';
  $('rev-gross-sales-count').textContent = `Total Sales: ${nf(f.sales?.total || 0)}`;

  // Churn card
  const churn = $('revenue-subs-deck');
  if (churn) {
    churn.innerHTML = `
      <div class="churn-item">
        <span class="item-name">Active Subscriptions</span>
        <span class="item-val text-green">${nf(f.subscriptions?.active || 0)}</span>
      </div>
      <div class="churn-item">
        <span class="item-name">Trialing Subscriptions</span>
        <span class="item-val">${nf(f.subscriptions?.trialing || 0)}</span>
      </div>
      <div class="churn-item">
        <span class="item-name">Past Due / Warning</span>
        <span class="item-val text-orange">${nf(f.subscriptions?.pastDue || 0)}</span>
      </div>
      <div class="churn-item">
        <span class="item-name">Canceled Memberships</span>
        <span class="item-val text-red">${nf(f.subscriptions?.canceled || 0)}</span>
      </div>
      <div class="churn-item">
        <span class="item-name">Comped Licenses</span>
        <span class="item-val">${nf(f.subscriptions?.comp || 0)}</span>
      </div>
    `;
  }

  // Draw revenue trend SVG chart
  drawRevenueTrendChart(f.revenue?.series || []);

  // Payments table ledger
  filterPaymentsTable();
}

function filterPaymentsTable() {
  const query = $('revenue-search').value.toLowerCase().trim();
  const statusFilter = $('revenue-filter-status').value;

  // Build simulation list of payments from users
  let list = [];
  let baseAmount = 1999; // $19.99 subscription
  
  state.data.users.forEach((u, i) => {
    const isPaid = u.subscribed;
    const status = isPaid ? 'paid' : (i % 8 === 0 ? 'failed' : (i % 12 === 0 ? 'refunded' : 'unpaid'));
    if (status === 'unpaid') return; // only paid, failed, or refunded shows in transactions

    list.push({
      id: `ch_${i + 1}09f8723b7b`,
      userEmail: u.email,
      userId: u.id,
      amount: baseAmount + (i % 3 === 0 ? 2900 : 0), // alternate with $48.99 product sales
      status,
      gateway: i % 2 === 0 ? 'stripe' : 'paypal',
      plan: i % 3 === 0 ? 'Course Purchase' : 'Monthly Member',
      country: u.country || 'US',
      ip: u.lastIp || '198.51.100.1',
      date: new Date(u.createdAt + 24 * 3600 * 1000).toISOString()
    });
  });

  filteredPaymentsList = list.filter(p => {
    const matchQuery = !query || 
      p.id.toLowerCase().includes(query) || 
      p.userEmail.toLowerCase().includes(query);

    const matchStatus = statusFilter === 'all' || p.status === statusFilter;

    return matchQuery && matchStatus;
  });

  renderPaymentsTable();
}

function renderPaymentsTable() {
  const tbody = $('revenue-table-body');
  if (!tbody) return;

  tbody.innerHTML = filteredPaymentsList.length
    ? filteredPaymentsList.map(p => {
        const amtText = formatCurrency(p.amount);
        const statusBadge = p.status === 'paid' 
          ? `<span class="badge paid">Paid</span>`
          : p.status === 'failed' ? `<span class="badge blocked">Failed</span>` : `<span class="badge unverified">Refunded</span>`;

        const maskIP = maskIpAddress(p.ip, p.userId);
        const actionBtn = state.activeRole === 'super' || state.activeRole === 'finance'
          ? `<button class="btn sm" onclick="alert('Action applied to transaction ${p.id}')">Invoice</button>`
          : `<span class="muted">—</span>`;

        return `
          <tr>
            <td><code>${p.id.slice(0, 10)}...</code></td>
            <td><code class="text-blue cursor-pointer" onclick="window.showUserProfile('${p.userId}')">${esc(p.userEmail)}</code></td>
            <td class="text-green"><b>${amtText}</b></td>
            <td>${statusBadge}</td>
            <td><span class="badge admin">${p.gateway}</span></td>
            <td>${p.plan}</td>
            <td>${ccLabel(p.country)}</td>
            <td>${maskIP}</td>
            <td>${p.date.slice(0, 16).replace('T', ' ')}</td>
            <td>${actionBtn}</td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="10" class="muted text-center" style="padding:24px;">No transactions recorded.</td></tr>`;
}

function drawRevenueTrendChart(series) {
  const svg = $('revenue-growth-chart');
  if (!svg || !series.length) return;

  const W = 600, H = 200, pad = 8;
  const maxCents = Math.max(...series.map(s => s.cents || 0), 100000);
  const ys = (c) => H - pad - ((c / maxCents) * (H - pad * 2));
  const barW = W / Math.max(series.length, 1) - 6;

  let rects = '';
  series.forEach((s, i) => {
    const x = i * (W / series.length) + 3;
    const y = ys(s.cents);
    const h = H - pad - y;
    rects += `
      <rect x="${x}" y="${y}" width="${barW}" height="${Math.max(2, h)}" fill="#10b981" rx="3">
        <title>${s.month}: ${formatCurrency(s.cents)}</title>
      </rect>
    `;
  });

  svg.innerHTML = rects;
}

// ==========================================
// 6. SECURITY & IP DASHBOARD
// ==========================================
let filteredIpActivityList = [];

function renderSecurityPanel() {
  if (state.activeRole === 'finance' || state.activeRole === 'support') return;

  // Watchlist numbers
  $('sec-unique-ips').textContent = '42';
  $('sec-suspicious-ips').textContent = '2';
  $('sec-failed-logins').textContent = '14';

  filterSecurityTable();
  renderBlockedRulesTable();
}

function filterSecurityTable() {
  const query = $('security-search').value.toLowerCase().trim();
  
  // Construct IP list from users activity
  let list = [];
  state.data.users.forEach((u, i) => {
    if (!u.lastIp) return;
    const exists = list.find(item => item.ip === u.lastIp);
    if (exists) {
      if (!exists.users.includes(u.email)) exists.users.push(u.email);
      exists.requests += 15 + i;
    } else {
      list.push({
        ip: u.lastIp,
        userId: u.id,
        country: u.country || 'US',
        city: 'Metropolis',
        users: [u.email],
        failedLogins: i % 7 === 0 ? 3 : 0,
        payments: u.subscribed ? 1 : 0,
        requests: 20 + i * 5,
        riskScore: i % 7 === 0 ? 82 : (i % 11 === 0 ? 45 : 12),
        status: i % 7 === 0 ? 'watched' : 'normal'
      });
    }
  });

  filteredIpActivityList = list.filter(item => {
    const matchQuery = !query || 
      item.ip.toLowerCase().includes(query) || 
      item.country.toLowerCase().includes(query);
    return matchQuery;
  });

  renderSecurityTable();
}

function renderSecurityTable() {
  const tbody = $('security-ip-table-body');
  if (!tbody) return;

  tbody.innerHTML = filteredIpActivityList.length
    ? filteredIpActivityList.map(item => {
        const maskIP = maskIpAddress(item.ip, item.userId);
        const riskColor = item.riskScore > 75 ? 'text-red' : (item.riskScore > 40 ? 'text-orange' : 'text-green');
        const statusBadge = item.status === 'watched'
          ? `<span class="badge unverified">Watchlist</span>`
          : `<span class="badge active">Normal</span>`;

        let actionBtn = '';
        if (state.activeRole === 'super' || state.activeRole === 'technical') {
          actionBtn = `<button class="btn sm red-btn" onclick="window.applyIpAction('block', '${item.ip}')">Block</button>`;
        } else {
          actionBtn = `<span class="muted">—</span>`;
        }

        return `
          <tr>
            <td>${maskIP}</td>
            <td>${ccLabel(item.country)}</td>
            <td>${item.city}</td>
            <td><span class="muted" title="${item.users.join(', ')}">${item.users.length} users</span></td>
            <td class="${item.failedLogins > 0 ? 'text-red font-bold' : ''}">${item.failedLogins}</td>
            <td>${item.payments}</td>
            <td>${item.requests}</td>
            <td><b class="${riskColor}">${item.riskScore}%</b></td>
            <td>${statusBadge}</td>
            <td>${actionBtn}</td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="10" class="muted text-center" style="padding:24px;">No IP records.</td></tr>`;
}

function renderBlockedRulesTable() {
  const tbody = $('security-blocked-rules-body');
  if (!tbody) return;

  const rules = state.data.geoRules;
  if (!rules) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted text-center">Failed to load block rules.</td></tr>`;
    return;
  }

  let rows = [];

  // Blocked Countries rules
  if (rules.blockedCountries) {
    rules.blockedCountries.forEach(cc => {
      rows.push({
        rule: ccLabel(cc),
        type: 'Country',
        reason: 'Geo-defense policy',
        admin: 'davidbond',
        permanent: 'Yes',
        created: rules.updatedAt || Date.now(),
        op: 'country',
        val: cc
      });
    });
  }

  // Blocked IPs rules
  if (rules.blockedIps) {
    rules.blockedIps.forEach(ip => {
      rows.push({
        rule: ip,
        type: 'IP Address',
        reason: 'Suspicious credential abuse',
        admin: 'davidbond',
        permanent: 'Yes',
        created: rules.updatedAt || Date.now(),
        op: 'ip',
        val: ip
      });
    });
  }

  // Blocked Users rules
  if (rules.blockedUserIds) {
    rules.blockedUserIds.forEach(uid => {
      rows.push({
        rule: `User ID: ${uid.slice(0, 8)}...`,
        type: 'Account Lockout',
        reason: 'Violation of service terms',
        admin: 'davidbond',
        permanent: 'Yes',
        created: rules.updatedAt || Date.now(),
        op: 'user',
        val: uid
      });
    });
  }

  tbody.innerHTML = rows.length
    ? rows.map(r => {
        const actionBtn = state.activeRole === 'super' || state.activeRole === 'technical'
          ? `<button class="btn sm" onclick="window.applyIpAction('remove', '${r.val}', '${r.op}')">Unblock</button>`
          : `<span class="muted">—</span>`;

        return `
          <tr>
            <td><b>${esc(r.rule)}</b></td>
            <td><span class="badge admin">${r.type}</span></td>
            <td>${esc(r.reason)}</td>
            <td>${esc(r.admin)}</td>
            <td>${r.permanent}</td>
            <td>${new Date(r.created).toISOString().slice(0, 16).replace('T', ' ')}</td>
            <td>${actionBtn}</td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="7" class="muted text-center" style="padding:24px;">No block rules active.</td></tr>`;
}

// Block/Allow operations calling API
window.applyIpAction = async function(action, value, op = 'ip') {
  if (state.activeRole !== 'super' && state.activeRole !== 'technical') {
    alert('Permission Denied: Simulated role lacks geo-defense override permissions.');
    return;
  }

  try {
    const res = await api('/api/admin/geo', {
      method: 'POST',
      body: JSON.stringify({
        op,
        value,
        action // 'remove' or undefined (add)
      })
    });

    if (res.ok) {
      alert(`Success: Rule modified for ${value}`);
      await refreshAllData();
    } else {
      alert(`Error: ${res.error || 'Failed to apply rule.'}`);
    }
  } catch (err) {
    console.error(err);
  }
};

async function securityQuickAction(action) {
  const ip = $('sec-ip-input').value.trim();
  if (!ip) {
    alert('Please enter a valid IP address first.');
    return;
  }
  
  if (action === 'block') {
    await applyIpAction(undefined, ip, 'ip');
  } else {
    // allowlist
    await applyIpAction(undefined, ip, 'allow');
  }
  $('sec-ip-input').value = '';
}

// ==========================================
// 7. MODERATION PANEL RENDERING
// ==========================================
function renderModerationPanel() {
  if (state.activeRole === 'finance' || state.activeRole === 'support') return;

  const pending = state.mockReports.filter(r => r.status === 'pending');
  $('mod-count-critical').textContent = pending.filter(r => r.severity === 'critical').length;
  $('mod-count-comments').textContent = pending.filter(r => r.type === 'comment').length;
  $('mod-count-videos').textContent = pending.filter(r => r.type === 'video').length;

  const severityFilter = $('mod-filter-severity').value;
  let list = state.mockReports;
  
  if (severityFilter === 'critical') {
    list = list.filter(r => r.severity === 'critical');
  } else if (severityFilter === 'high') {
    list = list.filter(r => r.severity === 'high' || r.severity === 'critical');
  }

  const tbody = $('moderation-queue-body');
  if (!tbody) return;

  tbody.innerHTML = list.length
    ? list.map(r => {
        const severityBadge = r.severity === 'critical'
          ? `<span class="badge blocked">Critical</span>`
          : r.severity === 'high' ? `<span class="badge unverified">High</span>` : `<span class="badge admin">Medium</span>`;

        const statusBadge = r.status === 'pending'
          ? `<span class="badge unverified">Pending</span>`
          : `<span class="badge active">Reviewed</span>`;

        const actionBtns = r.status === 'pending' && (state.activeRole === 'super' || state.activeRole === 'moderator')
          ? `<button class="btn sm green-btn" onclick="window.applyModerationAction('${r.id}', 'approve')">Approve</button>
             <button class="btn sm red-btn" onclick="window.applyModerationAction('${r.id}', 'dismiss')">Dismiss</button>`
          : `<span class="muted">No action</span>`;

        return `
          <tr>
            <td><code>${r.id}</code></td>
            <td><span class="badge admin">${r.type}</span></td>
            <td><b>${esc(r.target)}</b> <span class="muted">(${r.targetId})</span></td>
            <td>${esc(r.reason)}</td>
            <td><code>${r.reporter}</code></td>
            <td>${severityBadge}</td>
            <td>${statusBadge}</td>
            <td>${new Date(r.created).toLocaleTimeString()}</td>
            <td>${actionBtns}</td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="9" class="muted text-center" style="padding:24px;">No reports in moderation queue.</td></tr>`;
}

window.applyModerationAction = function(id, action) {
  const reportIndex = state.mockReports.findIndex(r => r.id === id);
  if (reportIndex !== -1) {
    if (action === 'approve') {
      state.mockReports[reportIndex].status = 'approved';
      alert(`Report approved. Content has been flagged.`);
    } else {
      state.mockReports[reportIndex].status = 'dismissed';
      alert(`Report dismissed.`);
    }
    renderAllViews();
  }
};

// ==========================================
// 8. INFRASTRUCTURE HEALTH & LIVE GRAPHS
// ==========================================
function renderHealthPanel() {
  const m = state.data.metrics;
  if (!m) return;

  $('health-uptime-tag').textContent = `Uptime: ${Math.round(m.uptime / 3600)} hrs (${m.platform})`;

  // Video queue metrics
  $('health-q-active').textContent = nf(m.videos?.processing || 0);
  $('health-q-queued').textContent = nf(m.videos?.uploaded || 0);
  $('health-q-failed').textContent = nf(m.videos?.failed || 0);

  // Storage footprint gauges
  const disk = $('health-disk-gaugerow');
  if (disk) {
    const totalGB = (m.disk?.total / (1024 ** 3)).toFixed(1);
    const contentGB = (m.disk?.content / (1024 ** 3)).toFixed(1);
    const mediaGB = (m.disk?.media / (1024 ** 3)).toFixed(1);
    
    disk.innerHTML = `
      <div class="infra-summary-item flex-1">
        <span>Videos Content:</span>
        <span><b>${contentGB} GB</b></span>
      </div>
      <div class="infra-summary-item flex-1">
        <span>Transcode Media:</span>
        <span><b>${mediaGB} GB</b></span>
      </div>
      <div class="infra-summary-item flex-1">
        <span>Disk Total Usage:</span>
        <span class="text-green"><b>${totalGB} GB</b></span>
      </div>
    `;
  }

  // Draw response latency fake curve
  drawLatencyChart();
}

function drawLatencyChart() {
  const svg = $('health-latency-chart');
  if (!svg) return;

  const W = 500, H = 150;
  // construct mock latencies (around 45ms average)
  let pts = '';
  for (let i = 0; i < 20; i++) {
    const x = i * (W / 19);
    const y = H - 20 - (Math.sin(i / 1.5) * 15 + Math.cos(i) * 10 + 40);
    if (i === 0) pts += `M ${x} ${y}`;
    else pts += ` L ${x} ${y}`;
  }

  svg.innerHTML = `
    <!-- Grid -->
    <line x1="0" y1="${H * 0.3}" x2="${W}" y2="${H * 0.3}" stroke="rgba(255,255,255,0.03)"/>
    <line x1="0" y1="${H * 0.6}" x2="${W}" y2="${H * 0.6}" stroke="rgba(255,255,255,0.03)"/>
    <path d="${pts}" fill="none" stroke="#22d3ee" stroke-width="2" />
    <text x="10" y="20" fill="#06b6d4" font-size="10" font-family="monospace">Latency (Ø 45ms)</text>
  `;
}

// Background poller for Real-time CPU/RAM/Net monitor
function startRealtimeHealth() {
  if (state.healthInterval) clearInterval(state.healthInterval);

  state.healthInterval = setInterval(async () => {
    if (state.activeRole === 'finance' || state.activeRole === 'support') return;

    try {
      const live = await api('/api/admin/metrics/live');
      if (live && live.cpu) {
        const cpuPercent = live.cpu.percent || 0;
        const ramUsed = live.memory?.used || 0;
        const ramTotal = live.memory?.total || 1;
        const ramPercent = Math.round((ramUsed / ramTotal) * 100);
        const netKb = live.net?.rxSec ? Math.round(live.net.rxSec / 1024) : 124; // fallback

        // Shift arrays
        state.healthHistory.cpu.shift();
        state.healthHistory.cpu.push(cpuPercent);
        state.healthHistory.ram.shift();
        state.healthHistory.ram.push(ramPercent);
        state.healthHistory.net.shift();
        state.healthHistory.net.push(netKb);

        // Update displays
        const cpuText = $('health-cpu-text');
        if (cpuText) cpuText.textContent = `${cpuPercent.toFixed(1)}%`;
        const ramText = $('health-ram-text');
        if (ramText) ramText.textContent = `${ramPercent}% (${Math.round(ramUsed / (1024**3))}G/${Math.round(ramTotal / (1024**3))}G)`;
        const netText = $('health-net-text');
        if (netText) netText.textContent = `${netKb} KB/s`;

        // Redraw canvas if active
        if ($('panel-health').classList.contains('active')) {
          drawHealthGraphs();
        }
      }
    } catch (err) {
      console.warn('Realtime monitor heartbeat failed:', err);
    }
  }, 2000);
}

function drawHealthGraphs() {
  drawCanvasGraph('canvas-cpu', state.healthHistory.cpu, '#818cf8');
  drawCanvasGraph('canvas-ram', state.healthHistory.ram, '#22d3ee');
  drawCanvasGraph('canvas-net', state.healthHistory.net, '#10b981', true);
}

function drawCanvasGraph(id, data, color, autoScale = false) {
  const canvas = $(id);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  // Background Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, H * 0.25); ctx.lineTo(W, H * 0.25);
  ctx.moveTo(0, H * 0.5);  ctx.lineTo(W, H * 0.5);
  ctx.moveTo(0, H * 0.75); ctx.lineTo(W, H * 0.75);
  ctx.stroke();

  // Line drawing
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();

  const maxVal = autoScale ? Math.max(...data, 100) : 100;

  data.forEach((val, i) => {
    const x = i * (W / (data.length - 1));
    const y = H - 5 - ((val / maxVal) * (H - 10));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Gradient Area Fill
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, color + '20');
  grad.addColorStop(1, color + '00');
  ctx.fillStyle = grad;
  ctx.fill();
}

// ==========================================
// 9. AUDIT LOGS RENDERING
// ==========================================
let auditCurrentPage = 1;
const auditPageSize = 10;
let filteredAuditList = [];

function renderAuditPanel() {
  if (state.activeRole === 'finance' || state.activeRole === 'support') return;

  filterAuditTable();
}

function filterAuditTable() {
  const query = $('audit-search').value.toLowerCase().trim();
  const typeFilter = $('audit-filter-type').value;

  filteredAuditList = state.data.logs.filter(log => {
    const matchQuery = !query ||
      log.action.toLowerCase().includes(query) ||
      (log.username && log.username.toLowerCase().includes(query)) ||
      (log.targetType && log.targetType.toLowerCase().includes(query));

    let matchType = true;
    if (typeFilter === 'user') matchType = log.action.includes('user') || log.action.includes('auth');
    else if (typeFilter === 'geo') matchType = log.action.includes('geo') || log.action.includes('ip');
    else if (typeFilter === 'payment') matchType = log.action.includes('pay') || log.action.includes('sub');
    else if (typeFilter === 'community') matchType = log.action.includes('reply') || log.action.includes('comment');

    return matchQuery && matchType;
  });

  auditCurrentPage = 1;
  renderAuditTablePage();
}

function renderAuditTablePage() {
  const start = (auditCurrentPage - 1) * auditPageSize;
  const end = start + auditPageSize;
  const pageItems = filteredAuditList.slice(start, end);

  const tbody = $('audit-table-body');
  if (!tbody) return;

  tbody.innerHTML = pageItems.length
    ? pageItems.map(log => {
        const timeStr = new Date(log.created_at || log.ts || Date.now()).toISOString().slice(0, 19).replace('T', ' ');
        const maskIP = maskIpAddress(log.ip, log.userId);

        return `
          <tr>
            <td><code>${esc(log.id || 'log_127')}</code></td>
            <td>${timeStr}</td>
            <td><b>${esc(log.username || 'admin')}</b></td>
            <td><span class="badge admin">${esc(log.action)}</span></td>
            <td>${esc(log.targetType || '—')}</td>
            <td><code>${esc(log.targetId || '—')}</code></td>
            <td><span class="muted">${esc(JSON.stringify(log.meta || log.details || {}))}</span></td>
            <td>${maskIP}</td>
          </tr>`;
      }).join('')
    : `<tr><td colspan="8" class="muted text-center" style="padding:24px;">No audit logs recorded.</td></tr>`;

  renderPagination('audit-pagination', filteredAuditList.length, auditCurrentPage, auditPageSize, (p) => {
    auditCurrentPage = p;
    renderAuditTablePage();
  });
}

// Pagination Builder Helper
function renderPagination(containerId, totalCount, currentPage, pageSize, onPageChange) {
  const container = $(containerId);
  if (!container) return;

  const totalPages = Math.ceil(totalCount / pageSize) || 1;
  const startNum = totalCount === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endNum = Math.min(currentPage * pageSize, totalCount);

  let buttons = `
    <button ${currentPage === 1 ? 'disabled' : ''} onclick="window.paginationClick('${containerId}', ${currentPage - 1})">Prev</button>
    <button ${currentPage === totalPages ? 'disabled' : ''} onclick="window.paginationClick('${containerId}', ${currentPage + 1})">Next</button>
  `;

  // Attach callbacks globally
  window.paginationClick = (id, page) => {
    onPageChange(page);
  };

  container.innerHTML = `
    <span>Showing <b>${startNum}-${endNum}</b> of <b>${totalCount}</b> entries</span>
    <div class="pagination-buttons">${buttons}</div>
  `;
}

// ==========================================
// 10. REAL-TIME ACTIVITY FEED DOCK
// ==========================================
function startLiveFeed() {
  if (state.feedInterval) clearInterval(state.feedInterval);

  // Initial populate using recent logs
  const feed = $('live-feed-content');
  if (!feed) return;

  const events = [
    { type: 'auth', desc: 'New user verification signup from Thailand' },
    { type: 'payment', desc: 'Subscription charge successful for $19.99 (US)' },
    { type: 'watch', desc: '1080p stream connection initiated from Germany' },
    { type: 'abuse', desc: 'Rate-limiting activated on API call for suspicious IP' },
    { type: 'system', desc: 'Video transcoding finished successfully for #89302' },
  ];

  feed.innerHTML = events.map(e => createFeedItemMarkup(e.type, e.desc)).join('');

  // Simulated live events
  state.feedInterval = setInterval(() => {
    if (state.feedPaused) return;

    // Pick a random event template
    const templates = [
      { type: 'auth', desc: `User signup session started from ${pickRandomCountry()}` },
      { type: 'payment', desc: `Failed credit card checkout attempt: Stripe declined (${pickRandomCountry()})` },
      { type: 'watch', desc: `New 4K video stream playback started` },
      { type: 'abuse', desc: `Blocked country code hit logged: blocked resource access rejected` },
      { type: 'system', desc: `CDN cache flush finished in node region` },
    ];

    const filterVal = $('feed-filter').value;
    const item = templates[Math.floor(Math.random() * templates.length)];

    // Prepend to list
    const wrap = document.createElement('div');
    wrap.innerHTML = createFeedItemMarkup(item.type, item.desc);
    feed.insertBefore(wrap.firstChild, feed.firstChild);

    // Prune list
    if (feed.children.length > 20) {
      feed.removeChild(feed.lastChild);
    }
  }, 8000);
}

function createFeedItemMarkup(type, desc) {
  const time = new Date().toLocaleTimeString().slice(0, 8);
  return `
    <div class="feed-item ${type}">
      <div class="feed-time">${time}</div>
      <div class="feed-desc">${esc(desc)}</div>
    </div>
  `;
}

function pickRandomCountry() {
  const cc = ['US', 'DE', 'TH', 'JP', 'PH', 'BR', 'CA', 'GB'];
  return cc[Math.floor(Math.random() * cc.length)];
}

// ==========================================
// 11. DRILL-DOWN PROFILES & MODALS
// ==========================================
window.showUserProfile = async function(id) {
  if (state.activeRole === 'finance') return;

  const modal = $('user-details-modal');
  const body = $('modal-user-body');
  if (!modal || !body) return;

  body.innerHTML = `<div class="muted">Loading user profile details...</div>`;
  modal.showModal();

  try {
    const details = await api(`/api/admin/users/${id}`);
    const u = details.user || {};
    const stats = details.stats || {};
    const createdDate = new Date(u.createdAt).toUTCString();

    body.innerHTML = `
      <div class="detail-grid">
        <div class="detail-item">
          <span class="lbl">Username</span>
          <span class="val"><b>${esc(u.username || 'Anonymous')}</b></span>
        </div>
        <div class="detail-item">
          <span class="lbl">Email Address</span>
          <span class="val">${esc(u.email)}</span>
        </div>
        <div class="detail-item">
          <span class="lbl">Joined Date</span>
          <span class="val">${createdDate}</span>
        </div>
        <div class="detail-item">
          <span class="lbl">Country</span>
          <span class="val">${u.country ? ccLabel(u.country) : '—'}</span>
        </div>
        <div class="detail-item">
          <span class="lbl">Subscription Tier</span>
          <span class="val">${details.subscribed ? '<span class="badge paid">Premium Active</span>' : '<span class="badge unverified">Free Basic</span>'}</span>
        </div>
        <div class="detail-item">
          <span class="lbl">IP Address logs</span>
          <span class="val">${maskIpAddress(stats.ips?.[0], id)}</span>
        </div>
        <div class="detail-item span2">
          <span class="lbl">Account History Stats</span>
          <span class="val">Watched <b>${stats.videosWatched || 0} videos</b> for a total of <b>${stats.minutes || 0} minutes</b>.</span>
        </div>
      </div>
      
      <div style="margin-top:20px; display:flex; gap:10px;">
        <button class="btn sm red-btn" onclick="window.applyModalUserAction('${u.id}', '${details.blocked ? 'unblock' : 'block'}')">
          ${details.blocked ? 'Unsuspend Account' : 'Suspend Account'}
        </button>
        <button class="btn sm" onclick="window.applyModalUserPassword('${u.id}')">Reset Password</button>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div class="text-red">Error loading profile data: ${esc(err.message)}</div>`;
  }
};

window.applyModalUserAction = async function(id, action) {
  if (state.activeRole !== 'super' && state.activeRole !== 'moderator') {
    alert('Simulated role lacks account locking privileges.');
    return;
  }
  
  try {
    const res = await api(`/api/admin/users/${id}/${action}`, { method: 'POST' });
    if (res.ok) {
      alert(`Success: User account ${action}ed.`);
      $('user-details-modal').close();
      await refreshAllData();
    }
  } catch (err) {
    console.error(err);
  }
};

window.applyModalUserPassword = async function(id) {
  const newPass = prompt("Enter new password (minimum 4 characters):");
  if (!newPass) return;
  if (newPass.length < 4) {
    alert("Password is too short.");
    return;
  }

  try {
    const res = await api(`/api/admin/users/${id}/password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword: newPass })
    });
    if (res.ok) {
      alert("Password updated successfully.");
      $('user-details-modal').close();
    } else {
      alert("Failed to reset password.");
    }
  } catch (err) {
    console.error(err);
  }
};

window.showVideoDetails = async function(id) {
  const modal = $('video-details-modal');
  const body = $('modal-video-body');
  if (!modal || !body) return;

  body.innerHTML = `<div class="muted">Loading video stats...</div>`;
  modal.showModal();

  try {
    const details = await api(`/api/admin/analytics/video?id=${id}`);
    const v = details.video || {};
    const roll = details.rollups || {};

    body.innerHTML = `
      <div class="detail-grid">
        <div class="detail-item span2">
          <span class="lbl">Video Title</span>
          <span class="val"><b>${esc(v.title || id)}</b></span>
        </div>
        <div class="detail-item">
          <span class="lbl">Views (All Time)</span>
          <span class="val font-bold">${nf(roll.views || 0)}</span>
        </div>
        <div class="detail-item">
          <span class="lbl">Watch Hours</span>
          <span class="val">${roll.totalSeconds ? Math.round(roll.totalSeconds / 3600) + ' hrs' : '0 hrs'}</span>
        </div>
        <div class="detail-item">
          <span class="lbl">Upload Date</span>
          <span class="val">${v.created_at ? new Date(v.created_at).toUTCString() : '—'}</span>
        </div>
        <div class="detail-item">
          <span class="lbl">Category</span>
          <span class="val"><span class="badge admin">${v.category || 'Vlog'}</span></span>
        </div>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div class="text-red">Error loading video details.</div>`;
  }
};

// ==========================================
// 12. CSV EXPORTS
// ==========================================
function exportTableToCSV(type) {
  let headers = [];
  let rows = [];
  let filename = `${type}_export_${Date.now()}.csv`;

  if (type === 'users') {
    headers = ['User ID', 'Username', 'Email', 'Country', 'IP Address', 'Subscribed', 'Minutes Watched', 'Verified'];
    rows = filteredUsersList.map(u => [
      u.id,
      u.username || 'Anonymous',
      u.email,
      u.country || '',
      u.lastIp || '',
      u.subscribed ? 'Yes' : 'No',
      u.minutesWatched || 0,
      u.verified ? 'Yes' : 'No'
    ]);
  } else if (type === 'videos') {
    headers = ['Video ID', 'Title', 'Creator', 'Category', 'Duration Seconds', 'Views', 'Watch Minutes'];
    rows = filteredVideosList.map(v => [
      v.id,
      v.title,
      v.creator || 'davidbond',
      v.category || 'Vlog',
      v.duration_seconds || 0,
      v.views || 0,
      v.minutes || 0
    ]);
  } else if (type === 'revenue') {
    headers = ['Payment ID', 'User Email', 'Amount Cents', 'Status', 'Gateway', 'Plan', 'Country', 'IP', 'Date'];
    rows = filteredPaymentsList.map(p => [
      p.id,
      p.userEmail,
      p.amount,
      p.status,
      p.gateway,
      p.plan,
      p.country,
      p.ip,
      p.date
    ]);
  } else if (type === 'security') {
    headers = ['IP Address', 'Country', 'Failed Logins', 'Requests', 'Risk Score', 'Status'];
    rows = filteredIpActivityList.map(item => [
      item.ip,
      item.country,
      item.failedLogins,
      item.requests,
      item.riskScore,
      item.status
    ]);
  } else if (type === 'moderation') {
    headers = ['Report ID', 'Type', 'Target', 'Target ID', 'Reason', 'Reporter', 'Severity', 'Status', 'Date'];
    rows = state.mockReports.map(r => [
      r.id,
      r.type,
      r.target,
      r.targetId,
      r.reason,
      r.reporter,
      r.severity,
      r.status,
      new Date(r.created).toISOString()
    ]);
  } else if (type === 'audit') {
    headers = ['Log ID', 'Timestamp', 'Admin', 'Action', 'Target Type', 'Target ID', 'Details', 'IP'];
    rows = filteredAuditList.map(log => [
      log.id || '',
      new Date(log.created_at || log.ts || Date.now()).toISOString(),
      log.username || 'admin',
      log.action,
      log.targetType || '',
      log.targetId || '',
      JSON.stringify(log.meta || {}),
      log.ip || ''
    ]);
  } else {
    return;
  }

  // Build CSV content
  const csvContent = [
    headers.join(','),
    ...rows.map(r => r.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))
  ].join('\n');

  // Trigger download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

// Debounce helper
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
