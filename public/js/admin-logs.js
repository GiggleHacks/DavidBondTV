import { requireAdmin } from './god-auth.js';
import { flagIcon } from './world-data.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let cursor = null;
let events = [];
let selected = null;
let timer = null;

async function api(path) {
  const res = await fetch(path);
  if (res.status === 401) { location.reload(); throw new Error('unauth'); }
  return res.json().catch(() => ({}));
}

function filters({ includeCursor = false } = {}) {
  const p = new URLSearchParams();
  const set = (key, id) => { const v = $(id)?.value; if (v) p.set(key, v); };
  set('q', 'log-q'); set('type', 'log-type'); set('subscriber', 'log-subscriber');
  set('from', 'log-from'); set('to', 'log-to');
  p.set('limit', '80');
  if (includeCursor && cursor) p.set('cursor', cursor);
  return p;
}

function fmtAgo(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function typeLabel(e) {
  if (e.type === 'watch') return 'Watch';
  if (e.type === 'blocked') return 'Blocked';
  if (String(e.type || '').startsWith('admin.')) return e.type.replace(/^admin\./, '').replace(/\./g, ' ');
  return e.type || 'Activity';
}

function locationLabel(e) {
  const parts = [e.city, e.region, e.country || e.cc].filter(Boolean);
  return `${e.cc ? flagIcon(e.cc) : ''} ${esc(parts.join(', ') || 'Unknown')}`;
}

function row(e) {
  const active = selected && selected.t === e.t && selected.ip === e.ip && selected.type === e.type;
  return `<button class="log-row ${active ? 'active' : ''}" type="button" data-t="${e.t}" data-ip="${esc(e.ip || '')}" data-type="${esc(e.type || '')}">
    <span><b>${fmtAgo(e.t)}</b><small>${esc(new Date(e.t).toLocaleString())}</small></span>
    <span><b>${esc(e.username || 'Guest')}</b><small>${esc(e.ip || 'No IP')}</small></span>
    <span>${locationLabel(e)}</span>
    <span><b>${esc(typeLabel(e))}</b><small>${esc(e.videoTitle || e.reason || e.sessionId || '')}</small></span>
    <span><b>${esc(e.deviceLabel || e.device?.type || 'Unknown')}</b><small>${esc(e.deviceId || '')}</small></span>
  </button>`;
}

function renderList() {
  const list = $('logs-list');
  if (!events.length) {
    list.innerHTML = '<div class="logs-empty">No activity matches these filters.</div>';
  } else {
    list.innerHTML = events.map(row).join('');
  }
  const devices = new Set(events.map((e) => e.deviceId).filter(Boolean));
  $('log-count').textContent = events.length.toLocaleString();
  $('log-watch').textContent = events.filter((e) => e.type === 'watch').length.toLocaleString();
  $('log-blocked').textContent = events.filter((e) => e.type === 'blocked').length.toLocaleString();
  $('log-devices').textContent = devices.size.toLocaleString();
  $('logs-more').hidden = !cursor;
}

function kv(label, value) {
  return `<div class="log-kv"><b>${esc(label)}</b><span>${value || '<span class="muted">—</span>'}</span></div>`;
}

function renderDetail(e) {
  selected = e;
  if (!e) {
    $('log-detail').innerHTML = '<div class="log-empty">Select an event to inspect visitor, device, session, and content details.</div>';
    return;
  }
  const lookup = e.ip
    ? `<a class="ip-btn" href="https://ipinfo.io/${encodeURIComponent(e.ip)}" target="_blank" rel="noopener">Lookup</a><button class="ip-btn" id="copy-ip" type="button" data-ip="${esc(e.ip)}">Copy</button>`
    : '';
  $('log-detail').innerHTML = `
    <div class="log-detail-head">
      <span class="log-type">${esc(typeLabel(e))}</span>
      <b>${esc(e.username || 'Guest visitor')}</b>
      <small>${esc(new Date(e.t).toLocaleString())}</small>
    </div>
    <div class="log-detail-grid">
      ${kv('IP address', `${esc(e.ip || '')} ${lookup}`)}
      ${kv('Location', locationLabel(e))}
      ${kv('Content', esc(e.videoTitle || e.videoId || ''))}
      ${kv('Watch time', e.seconds ? `${Math.round(e.seconds)}s` : '')}
      ${kv('Playback', e.duration ? `${e.position || 0}s / ${e.duration}s` : '')}
      ${kv('Subscriber', e.subscriber ? '<span class="badge sub">Subscriber</span>' : '<span class="badge none">No</span>')}
      ${kv('Device', esc(e.deviceLabel || e.device?.type || ''))}
      ${kv('Device ID', `<code>${esc(e.deviceId || '')}</code>`)}
      ${kv('Session', `<code>${esc(e.sessionId || '')}</code>`)}
      ${kv('View ID', `<code>${esc(e.viewId || '')}</code>`)}
      ${kv('Reason', esc(e.reason || ''))}
    </div>`;
  $('copy-ip')?.addEventListener('click', async (ev) => {
    try {
      await navigator.clipboard.writeText(ev.currentTarget.dataset.ip);
      ev.currentTarget.textContent = 'Copied';
      setTimeout(() => { ev.currentTarget.textContent = 'Copy'; }, 1000);
    } catch { /* ignore */ }
  });
  renderList();
}

async function load({ append = false } = {}) {
  const d = await api(`/api/admin/logs?${filters({ includeCursor: append })}`);
  cursor = d.nextCursor || null;
  events = append ? events.concat(d.events || []) : (d.events || []);
  renderList();
  if (!append) renderDetail(events[0] || null);
}

function scheduleLoad() {
  clearTimeout(timer);
  timer = setTimeout(() => { cursor = null; load().catch(() => {}); }, 180);
}

async function main() {
  await requireAdmin();
  for (const id of ['log-q', 'log-type', 'log-subscriber', 'log-from', 'log-to']) {
    $(id).addEventListener(id === 'log-q' ? 'input' : 'change', scheduleLoad);
  }
  $('logs-more').addEventListener('click', () => load({ append: true }).catch(() => {}));
  $('log-export').addEventListener('click', () => {
    location.href = `/api/admin/logs/export?${filters()}`;
  });
  $('logs-list').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.log-row');
    if (!btn) return;
    const e = events.find((x) => String(x.t) === btn.dataset.t && String(x.ip || '') === btn.dataset.ip && String(x.type || '') === btn.dataset.type);
    renderDetail(e || null);
  });
  await load();
}

main().catch(() => {});
