// "Publish to server" controller (/god-videos.html). Cookie-authenticated — it
// only talks to the LOCAL server's /api/admin/publish/* routes; the SYNC_TOKEN
// and target URL live server-side and never reach the browser. The local server
// does the actual machine-to-machine push to production.
//
// The UI shows a per-video breakdown (size, progress, status), an overall bar
// with live speed + ETA + videos-remaining, and Pause / Cancel controls. Cancel
// leaves uploaded bytes on the server, so the next Publish resumes from there.
import { requireAdmin } from './god-auth.js';

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { location.reload(); throw new Error('unauth'); }
  return res.json().catch(() => ({}));
}

function setStatus(html) { $('publish-status').innerHTML = html; }

const fmtBytes = (b) => {
  if (!b && b !== 0) return '';
  const gb = b / 1e9; if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = b / 1e6; if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(b / 1e3).toFixed(0)} KB`;
};
const fmtEta = (s) => {
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s < 60) return `ETA ${Math.ceil(s)}s`;
  const m = Math.floor(s / 60); const sec = Math.round(s % 60);
  return `ETA ${m}m ${sec}s`;
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Per-status presentation for a video row.
const ROW = {
  pending: { glyph: '○', label: 'Queued' },
  active: { glyph: '⬆', label: 'Uploading' },
  done: { glyph: '✓', label: 'Done' },
  error: { glyph: '✕', label: 'Failed' },
};

let polling = null;
let jobId = null;

function showProgress(on) {
  $('publish-progress').hidden = !on;
  $('publish-progress').querySelector('.pub-bar').classList.toggle('active', on);
}

// Toggle the action buttons for a given run state.
function setControls(state) {
  const running = state === 'running' || state === 'paused';
  $('publish-btn').hidden = running;
  $('publish-btn').disabled = running;
  $('pub-pause').hidden = !running;
  $('pub-cancel').hidden = !running;
  $('pub-pause').textContent = state === 'paused' ? '▶ Resume' : '⏸ Pause';
  $('pub-pause').dataset.action = state === 'paused' ? 'resume' : 'pause';
}

function rowHtml(v) {
  const meta = ROW[v.status] || ROW.pending;
  const pct = v.bytesTotal ? Math.min(100, Math.round((v.bytesSent / v.bytesTotal) * 100)) : (v.status === 'done' ? 100 : 0);
  const right = v.status === 'error'
    ? `<span class="pub-row-err">${esc(v.error || 'failed')}</span>`
    : `<span class="pub-row-size">${esc(fmtBytes(v.bytesTotal))}</span>`;
  return `<li class="pub-row" data-id="${esc(v.id)}" data-status="${esc(v.status)}">
    <div class="pub-row-top">
      <span class="pub-row-ico" aria-hidden="true">${meta.glyph}</span>
      <span class="pub-row-title">${esc(v.title)}</span>
      <span class="pub-row-state">${meta.label}</span>
      ${right}
    </div>
    <div class="pub-row-bar"><i style="width:${pct}%"></i></div>
  </li>`;
}

function paint(job) {
  const pct = Math.max(0, Math.min(100, job.pct || 0));
  $('pub-fill').style.width = `${pct}%`;
  $('pub-pct').textContent = `${pct}%`;
  const phaseLabel = job.paused ? 'Paused'
    : job.current ? `⬆ ${job.current}`
    : (job.phase && job.phase !== 'pushing' ? `${job.phase}…` : '');
  $('pub-cur').textContent = phaseLabel;
  $('pub-speed').textContent = job.paused ? 'paused' : (job.speed > 0 ? `${(job.speed / 1e6).toFixed(1)} MB/s` : '—');
  const remaining = (job.bytesTotal || 0) - (job.bytesSent || 0);
  $('pub-eta').textContent = (!job.paused && job.speed > 0) ? fmtEta(remaining / job.speed) : '';
  $('pub-bytes').textContent = job.bytesTotal ? `${fmtBytes(job.bytesSent)} / ${fmtBytes(job.bytesTotal)}` : '';
  const left = Math.max(0, (job.total || 0) - (job.done || 0));
  $('pub-count').textContent = job.total ? `${job.done}/${job.total} done · ${left} to go` : '';

  const list = $('pub-list');
  if (Array.isArray(job.videos) && job.videos.length) {
    list.innerHTML = job.videos.map(rowHtml).join('');
    list.hidden = false;
  } else {
    list.hidden = true;
  }
  $('publish-progress').querySelector('.pub-bar').classList.toggle('paused', !!job.paused);
}

function finish(job) {
  clearInterval(polling); polling = null;
  jobId = null;
  setControls('idle');
  $('publish-progress').querySelector('.pub-bar').classList.remove('active', 'paused');

  if (job.status === 'cancelled') {
    paint(job);
    setStatus(`⏹ Cancelled — pushed ${job.done}/${job.total}. Uploaded bytes are kept; hit Publish to resume.`);
    return;
  }
  paint({ ...job, pct: 100, current: '' });
  const errs = (job.errors || []).length
    ? `<div class="pub-errors">${job.errors.map((e) => `${e.id ? esc(e.id) + ': ' : ''}${esc(e.error)}`).join('<br>')}</div>`
    : '';
  if (job.status === 'done' && !errs) {
    const parts = [];
    if (job.total) parts.push(`published ${job.done} video${job.done === 1 ? '' : 's'}`);
    if (job.deleted) parts.push(`removed ${job.deleted}`);
    if (job.config && (job.config.categories || job.config.coupons)) {
      parts.push(`synced ${job.config.categories} categories · ${job.config.coupons} coupons`);
    }
    if (parts.length) {
      setStatus(`✅ ${parts.join(' · ')} on the server.`);
    } else {
      setStatus('✅ Server is already in sync — nothing to push or remove.');
      showProgress(false);
    }
  } else {
    setStatus(`⚠ Finished with issues — pushed ${job.done}/${job.total}${job.deleted ? `, removed ${job.deleted}` : ''}.${errs}`);
  }
}

async function poll(id) {
  const { job } = await api(`/api/admin/publish/status?job=${encodeURIComponent(id)}`);
  if (!job) return;
  if (job.status === 'running') {
    showProgress(true);
    setControls(job.paused ? 'paused' : 'running');
    paint(job);
    if ((job.errors || []).length) {
      setStatus(`<div class="pub-errors">${job.errors.map((e) => `${e.id ? esc(e.id) + ': ' : ''}${esc(e.error)}`).join('<br>')}</div>`);
    } else {
      setStatus('');
    }
  } else {
    finish(job);
  }
}

function track(id) {
  jobId = id;
  if (polling) clearInterval(polling);
  polling = setInterval(() => poll(id).catch(() => {}), 700);
  poll(id).catch(() => {});
}

async function start() {
  setControls('running');
  showProgress(true);
  paint({ pct: 0, phase: 'starting', videos: [] });
  setStatus('');
  const r = await api('/api/admin/publish/start', { method: 'POST', body: '{}' });
  if (r.error) { setControls('idle'); showProgress(false); setStatus(`⚠ ${r.error}`); return; }
  track(r.jobId);
}

async function control(action) {
  if (!jobId) return;
  await api('/api/admin/publish/control', { method: 'POST', body: JSON.stringify({ job: jobId, action }) });
  poll(jobId).catch(() => {});
}

async function main() {
  await requireAdmin();
  const cfg = await api('/api/admin/publish/config').catch(() => ({}));
  if (!cfg.configured) return; // card stays hidden when sync isn't set up
  $('publish-card').hidden = false;
  if (cfg.target) $('publish-target').textContent = `Pushes only the videos the server is missing or that changed (renditions, thumbnails, previews, storyboards) to ${cfg.target}. The server does no transcoding.`;

  $('publish-btn').addEventListener('click', () => start().catch(() => {}));
  $('pub-pause').addEventListener('click', () => control($('pub-pause').dataset.action || 'pause').catch(() => {}));
  $('pub-cancel').addEventListener('click', () => control('cancel').catch(() => {}));

  // Reconnect to a publish already running (e.g. after a page reload).
  const { job } = await api('/api/admin/publish/status?job=latest').catch(() => ({}));
  if (job && job.status === 'running') { showProgress(true); track(job.jobId); }
}
main();
