// Per-video analytics page (/god-analytics.html?v=<id>). Cookie-authenticated.
// Pulls one video's stats from GET /api/admin/analytics/video?id=<id> and shows
// headline numbers + a daily views bar chart (last 30 days).
import { requireAdmin } from './god-auth.js';

const $ = (id) => document.getElementById(id);
const videoId = new URLSearchParams(location.search).get('v') || '';

const fmtMmSs = (secs) => {
  const s = Math.max(0, Math.round(secs || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
// "2026-06-20" → "Jun 20"
const shortDay = (d) => {
  const dt = new Date(`${d}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? d
    : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

function renderChart(byDay) {
  const bars = $('va-bars');
  const days = (byDay || []).slice(-30);
  if (!days.length) { bars.classList.add('hidden'); $('va-empty').classList.remove('hidden'); return; }
  const max = Math.max(1, ...days.map((d) => d.views));
  bars.replaceChildren(...days.map((d) => {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.title = `${shortDay(d.day)}: ${d.views} view${d.views === 1 ? '' : 's'}, ${d.minutes} min`;
    const i = document.createElement('i');
    i.style.height = `${Math.round((d.views / max) * 100)}%`;
    const label = document.createElement('span');
    label.className = 'bday';
    label.textContent = shortDay(d.day);
    bar.append(i, label);
    return bar;
  }));
}

async function main() {
  await requireAdmin();
  if (!videoId) { $('va-title').textContent = 'No video selected'; return; }
  let d;
  try {
    const res = await fetch(`/api/admin/analytics/video?id=${encodeURIComponent(videoId)}`);
    if (res.status === 401) { location.reload(); return; }
    d = await res.json();
  } catch { $('va-title').textContent = 'Could not load analytics'; return; }

  $('va-title').textContent = d.title || videoId;
  document.title = `Analytics · ${d.title || videoId} — David Bond TV`;
  $('va-views').textContent = (d.views || 0).toLocaleString();
  $('va-minutes').textContent = (d.minutes || 0).toLocaleString();
  $('va-avg').textContent = fmtMmSs(d.avgSeconds);
  $('va-view').href = `/watch?v=${encodeURIComponent(videoId)}`;
  $('va-edit').href = `/god-edit.html?v=${encodeURIComponent(videoId)}`;
  renderChart(d.byDay);
}
main();
