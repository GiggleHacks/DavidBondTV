// Upload page (/god-upload.html). Cookie-authenticated (no bearer tokens) — the
// session cookie is sent automatically with same-origin requests. Drag-drop a
// batch (up to 30), 3 uploads in parallel, with live %/MB/s/ETA on a retro bar.
import { requireAdmin } from './god-auth.js';

const $ = (id) => document.getElementById(id);
const jobsCard = $('jobs-card');
const jobsEl = $('jobs');

function currentVisibility() {
  const el = document.querySelector('input[name="vis"]:checked');
  return el ? el.value : 'free';
}
function currentBlur() {
  const el = document.getElementById('blur');
  return el ? el.value : 'medium';
}
function currentCategory() {
  const el = document.getElementById('category');
  return el ? el.value : '';
}
// Drip schedule: { interval } in ms when scheduling is on, else null.
function currentSchedule() {
  const on = document.querySelector('input[name="sched"]:checked');
  if (!on || on.value !== 'drip') return null;
  const sel = document.getElementById('drip-interval');
  const interval = sel ? Number(sel.value) : 0;
  return interval > 0 ? { interval } : null;
}
// Populate the category dropdown from the registry.
async function loadCategories() {
  const sel = document.getElementById('category');
  if (!sel) return;
  try {
    const { categories } = await (await fetch('/api/categories')).json();
    for (const c of categories || []) {
      const o = document.createElement('option');
      o.value = c.slug; o.textContent = c.name;
      sel.appendChild(o);
    }
  } catch { /* leave Uncategorized only */ }
}

// --- jobs UI ---
const jobNodes = new Map();

function renderJob(rowId, name) {
  jobsCard.classList.remove('hidden');
  const el = document.createElement('div');
  el.className = 'job queued';
  el.innerHTML = `
    <span class="dot"></span>
    <div class="jbody">
      <div class="jname"></div>
      <div class="jtitle">Queued…</div>
      <div class="jdesc"></div>
      <div class="retrobar"><i style="width:0%"></i></div>
      <div class="jstats"></div>
    </div>`;
  el.querySelector('.jname').textContent = name;
  jobNodes.set(rowId, el);
  jobsEl.prepend(el);
  return el;
}
function setProgress(rowId, pct) {
  const el = jobNodes.get(rowId);
  if (el) el.querySelector('.retrobar > i').style.width = `${Math.max(0, Math.min(100, pct))}%`;
}
function setStats(rowId, text) {
  const el = jobNodes.get(rowId);
  if (el) el.querySelector('.jstats').textContent = text;
}
function setState(rowId, state, { title, desc } = {}) {
  const el = jobNodes.get(rowId);
  if (!el) return;
  el.className = `job ${state}`;
  if (title) el.querySelector('.jtitle').textContent = title;
  if (state === 'ready' || state === 'failed') {
    el.querySelector('.retrobar').classList.add('hidden');
    if (state === 'ready') el.querySelector('.jstats').textContent = '';
  }
  if (desc !== undefined) el.querySelector('.jdesc').textContent = desc || '';
}
// On a completed upload, surface quick View + Edit actions (and a thumbnail).
function addRowActions(rowId, manifestId) {
  const el = jobNodes.get(rowId);
  if (!el || !manifestId || el.querySelector('.job-actions')) return;
  const body = el.querySelector('.jbody');

  const actions = document.createElement('div');
  actions.className = 'job-actions';
  const view = document.createElement('a');
  view.className = 'btn ghost sm';
  view.href = `/watch?v=${encodeURIComponent(manifestId)}`;
  view.target = '_blank';
  view.rel = 'noopener';
  view.textContent = 'View';
  const edit = document.createElement('a');
  edit.className = 'btn sm';
  edit.href = `/god-edit.html?v=${encodeURIComponent(manifestId)}`;
  edit.textContent = 'Edit';
  actions.append(view, edit);
  body.appendChild(actions);

  // Small generated-thumbnail preview (hidden if the thumb didn't render).
  const thumb = document.createElement('img');
  thumb.className = 'job-thumb';
  thumb.alt = '';
  thumb.loading = 'lazy';
  thumb.src = `/thumbs/thumb-${manifestId}.jpg`;
  thumb.onerror = () => thumb.remove();
  el.insertBefore(thumb, body);
}

// --- upload queue (max 3 concurrent) ---
const MAX_CONCURRENT = 3;
const MAX_BATCH = 50;
const uploadQueue = [];
let inFlight = 0;

function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return '—';
  sec = Math.round(sec);
  const m = Math.floor(sec / 60); const s = sec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

function enqueueFiles(files) {
  let list = [...files].filter((f) => /\.(mp4|mov|m4v)$/i.test(f.name));
  if (!list.length) return;
  if (list.length > MAX_BATCH) {
    alert(`You selected ${list.length} files. Only the first ${MAX_BATCH} will be uploaded this batch.`);
    list = list.slice(0, MAX_BATCH);
  }
  const visibility = currentVisibility();
  const blur = currentBlur();
  const category = currentCategory();
  // Drip schedule: first file publishes now, each subsequent one releases a
  // further `interval` later. One baseline per dropped batch keeps the cadence
  // stable regardless of how long each upload takes.
  const sched = currentSchedule();
  const base = Date.now();
  list.forEach((file, i) => {
    const publishAt = sched && i > 0 ? base + i * sched.interval : 0;
    const rowId = `row-${Date.now()}-${Math.round(performance.now())}-${Math.random().toString(36).slice(2, 6)}`;
    const tag = visibility === 'premium' ? '  · Premium' : '';
    const when = publishAt ? `  · ⏱ ${new Date(publishAt).toLocaleString()}` : '';
    renderJob(rowId, `${file.name}${tag}${when}`);
    setStats(rowId, 'Waiting…');
    uploadQueue.push({ file, rowId, visibility, blur, category, publishAt });
  });
  pump();
}
function pump() {
  while (inFlight < MAX_CONCURRENT && uploadQueue.length) {
    inFlight++;
    startUpload(uploadQueue.shift());
  }
}
function startUpload({ file, rowId, visibility, blur, category, publishAt }) {
  setState(rowId, 'uploading', { title: 'Uploading…' });
  const last = { t: performance.now(), loaded: 0 };
  let speed = 0;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/admin/upload?name=${encodeURIComponent(file.name)}&visibility=${visibility}&blur=${encodeURIComponent(blur || 'medium')}&category=${encodeURIComponent(category || '')}&publishAt=${publishAt || 0}`);
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const now = performance.now();
    const dt = (now - last.t) / 1000;
    if (dt > 0.15) {
      const inst = (e.loaded - last.loaded) / dt;
      speed = speed ? speed * 0.7 + inst * 0.3 : inst;
      last.t = now; last.loaded = e.loaded;
    }
    const pct = (e.loaded / e.total) * 100;
    setProgress(rowId, pct);
    const eta = speed > 0 ? (e.total - e.loaded) / speed : Infinity;
    setStats(rowId, `${pct.toFixed(0)}% · ${(speed / 1e6).toFixed(1)} MB/s · ETA ${fmtEta(eta)}`);
  };
  const done = () => { inFlight--; pump(); };
  xhr.onload = () => {
    done();
    if (xhr.status === 401) { location.reload(); return; }
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
    if (xhr.status === 202 && data.jobId) {
      setProgress(rowId, 100);
      setStats(rowId, 'Uploaded · processing on server');
      setState(rowId, 'processing', { title: 'Processing…' });
      pollJob(rowId, data.jobId, publishAt);
    } else {
      setState(rowId, 'failed', { title: data.error || `Upload failed (${xhr.status})` });
    }
  };
  xhr.onerror = () => { done(); setState(rowId, 'failed', { title: 'Network error during upload' }); };
  xhr.send(file);
}
async function pollJob(rowId, jobId, publishAt = 0) {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    let data;
    try {
      const res = await fetch(`/api/admin/status?job=${encodeURIComponent(jobId)}`);
      if (res.status === 401) { location.reload(); return; }
      data = await res.json();
    } catch { continue; }
    const job = data.job;
    if (!job) continue;
    if (job.phase && job.status === 'processing') setStats(rowId, `Processing · ${job.phase}`);
    if (job.status === 'ready') {
      const desc = publishAt ? `⏱ Scheduled for ${new Date(publishAt).toLocaleString()}` : '✓ Published';
      setState(rowId, 'ready', { title: job.title, desc });
      addRowActions(rowId, job.manifestId);
      return;
    }
    if (job.status === 'failed') { setState(rowId, 'failed', { title: 'Processing failed', desc: job.error || '' }); return; }
  }
  setState(rowId, 'failed', { title: 'Timed out waiting for processing' });
}

// --- wiring ---
const drop = $('drop');
const fileInput = $('file');
drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { enqueueFiles(fileInput.files); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', (e) => enqueueFiles(e.dataTransfer?.files || []));

// Thumbnail blur only affects Premium thumbnails, so only show it for Premium.
const blurRow = $('blur-row');
function syncBlurRow() { if (blurRow) blurRow.classList.toggle('hidden', currentVisibility() !== 'premium'); }
document.querySelectorAll('input[name="vis"]').forEach((r) => r.addEventListener('change', syncBlurRow));
syncBlurRow();

// Drip interval picker + hint only show when "Schedule release" is chosen.
function syncScheduleRow() {
  const drip = !!currentSchedule();
  $('drip-interval')?.classList.toggle('hidden', !drip);
  $('drip-hint')?.classList.toggle('hidden', !drip);
}
document.querySelectorAll('input[name="sched"]').forEach((r) => r.addEventListener('change', syncScheduleRow));
syncScheduleRow();

async function main() {
  await requireAdmin(); // shows sign-in overlay for non-admins
  loadCategories();
  try {
    const data = await (await fetch('/api/admin/status')).json();
    $('ffmpeg-banner').classList.toggle('hidden', data.ffmpeg !== false);
  } catch { /* ignore */ }
}
main();
