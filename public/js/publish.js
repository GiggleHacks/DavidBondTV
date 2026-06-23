// "Publish to server" controller (/god-videos.html). Cookie-authenticated — it
// only talks to the LOCAL server's /api/admin/publish/* routes; the SYNC_TOKEN
// and target URL live server-side and never reach the browser. The local server
// does the actual machine-to-machine push to production.
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

function showProgress(on) {
  $('publish-progress').hidden = !on;
  $('publish-progress').querySelector('.pub-bar').classList.toggle('active', on);
}
function paint(job) {
  const pct = Math.max(0, Math.min(100, job.pct || 0));
  $('pub-fill').style.width = `${pct}%`;
  $('pub-pct').textContent = `${pct}%`;
  $('pub-cur').textContent = job.current ? `⬆ ${job.current}` : (job.phase ? `${job.phase}…` : '');
  $('pub-speed').textContent = job.speed > 0 ? `${(job.speed / 1e6).toFixed(1)} MB/s` : '—';
  const remaining = (job.bytesTotal || 0) - (job.bytesSent || 0);
  $('pub-eta').textContent = job.speed > 0 ? fmtEta(remaining / job.speed) : '';
  $('pub-bytes').textContent = job.bytesTotal ? `${fmtBytes(job.bytesSent)} / ${fmtBytes(job.bytesTotal)}` : '';
  $('pub-count').textContent = job.total ? `video ${Math.min(job.done + 1, job.total)} of ${job.total}` : '';
}

let polling = null;

async function poll(jobId) {
  const { job } = await api(`/api/admin/publish/status?job=${encodeURIComponent(jobId)}`);
  if (!job) return;
  const errs = (job.errors || []).length
    ? `<div style="color:#fca5a5;margin-top:6px">${job.errors.map((e) => `${e.id ? e.id + ': ' : ''}${e.error}`).join('<br>')}</div>`
    : '';
  if (job.status === 'running') {
    showProgress(true);
    paint(job);
    setStatus(errs);
  } else {
    clearInterval(polling); polling = null;
    $('publish-btn').disabled = false;
    paint({ ...job, pct: 100 });
    $('publish-progress').querySelector('.pub-bar').classList.remove('active'); // stop the stripe
    if (job.status === 'done' && !errs) {
      const parts = [];
      if (job.total) parts.push(`published ${job.done} video${job.done === 1 ? '' : 's'}`);
      if (job.deleted) parts.push(`removed ${job.deleted}`);
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
}

async function start() {
  $('publish-btn').disabled = true;
  showProgress(true);
  paint({ pct: 0, phase: 'starting' });
  setStatus('');
  const r = await api('/api/admin/publish/start', { method: 'POST', body: '{}' });
  if (r.error) { $('publish-btn').disabled = false; showProgress(false); setStatus(`⚠ ${r.error}`); return; }
  if (polling) clearInterval(polling);
  polling = setInterval(() => poll(r.jobId).catch(() => {}), 700);
  poll(r.jobId).catch(() => {});
}

async function main() {
  await requireAdmin();
  const cfg = await api('/api/admin/publish/config').catch(() => ({}));
  if (!cfg.configured) return; // card stays hidden when sync isn't set up
  $('publish-card').hidden = false;
  if (cfg.target) $('publish-target').textContent = `Pushes processed videos (renditions, thumbnails, previews, storyboards) to ${cfg.target}. The server does no transcoding.`;
  $('publish-btn').addEventListener('click', () => start().catch(() => {}));
}
main();
