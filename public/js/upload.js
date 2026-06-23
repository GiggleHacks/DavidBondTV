// Upload studio controller (/god-upload.html). Cookie-authenticated — the session
// cookie rides along automatically on same-origin requests. Drag-drop a batch (up
// to 50 files), uploaded ONE AT A TIME with live %/MB·s/ETA. Active and queued
// uploads are cancellable without a page refresh; failed uploads resume from the
// server's last good byte via Retry. Once an upload finishes, the server transcodes
// it and reports granular per-task progress (exact task name + % + ETA) which this
// page renders on the same bar. A notification sound plays when each job completes.
import { requireAdmin } from './god-auth.js';
import { listSounds, playSound, getSelected, setSelected, isEnabled, setEnabled, primeAudio } from './upload-sounds.js';
import { ADMIN_PATHS } from './admin-paths.js';

// Large uploads must skip Cloudflare's ~100MB proxy cap, so the upload page is
// served from a DNS-only subdomain. If we're on the main (proxied) host, hand off
// before doing any work. (No effect on localhost or the upload host itself.)
const UPLOAD_HOST = 'upload.davidbondtv.com';
const MAIN_HOSTS = ['davidbondtv.com', 'www.davidbondtv.com'];
if (MAIN_HOSTS.includes(location.hostname)) {
  location.replace(`https://${UPLOAD_HOST}${ADMIN_PATHS.upload}${location.search}`);
}

// Upload size limit (overwritten from /api/admin/status on load). 25 GB fallback.
let maxUploadBytes = 25 * 1024 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const jobsCard = $('jobs-card');
const jobsEl = $('jobs');

// --- formatting helpers ---
function fmtSize(bytes) {
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
function fmtEta(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '—';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

// Turn a raw HTTP status (or 0 for a network drop) into a clear, actionable
// message. "Retry" wording is used wherever progress is saved and resumable.
function describeUploadError(status, detail) {
  if (status === 413) return `File too large — the limit is ${fmtSize(maxUploadBytes)}.`;
  if (status === 415) return 'Only .mp4/.mov/.m4v video files are accepted.';
  if (status === 429) return 'The server is rate-limiting uploads — wait a minute, then click Retry.';
  if (status === 401) return 'Your admin session expired — reload the page and sign in again.';
  if (status === 409) return 'The upload fell out of sync with the server — Retry will resync and continue.';
  if (status === 502 || status === 503 || status === 504) {
    return `The server gateway dropped the connection (${status}). Your progress is saved — click Retry to resume.`;
  }
  if (!status) return 'Network connection lost. Your progress is saved — click Retry to resume.';
  if (status >= 500) return `The server hit an error (${status}). Your progress is saved — click Retry to resume.`;
  return detail || `Upload failed (${status}).`;
}

// --- settings readers ---
function currentVisibility() {
  const el = document.querySelector('input[name="vis"]:checked');
  return el ? el.value : 'free';
}
function currentBlur() {
  const el = $('blur');
  return el ? el.value : 'medium';
}
function currentCategory() {
  const el = $('category');
  return el ? el.value : '';
}
// Drip schedule: { interval } in ms when scheduling is on, else null.
function currentSchedule() {
  const on = document.querySelector('input[name="sched"]:checked');
  if (!on || on.value !== 'drip') return null;
  const sel = $('drip-interval');
  const interval = sel ? Number(sel.value) : 0;
  return interval > 0 ? { interval } : null;
}
// Populate the category dropdown from the registry.
async function loadCategories() {
  const sel = $('category');
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
// Per-row controls so a job can be canceled while queued or uploading.
const jobControls = new Map();

function renderJob(rowId, name) {
  jobsCard.classList.remove('hidden');
  const el = document.createElement('div');
  el.className = 'job queued';
  el.innerHTML = `
    <span class="dot"></span>
    <div class="jbody">
      <div class="jname"></div>
      <div class="jtitle">⏳ Queued…</div>
      <div class="jdesc"></div>
      <div class="bar"><i style="width:0%"></i><b class="bar-pct">0%</b></div>
      <div class="jstats"></div>
      <button type="button" class="btn ghost sm job-cancel">✕ Cancel</button>
    </div>`;
  el.querySelector('.jname').textContent = name;
  el.querySelector('.job-cancel').addEventListener('click', () => cancelJob(rowId));
  jobNodes.set(rowId, el);
  jobsEl.prepend(el);
  return el;
}
// Cancel a queued (not yet started) or in-flight upload without a page refresh.
function cancelJob(rowId) {
  const ctrl = jobControls.get(rowId);
  if (ctrl) {
    ctrl.canceled = true;                       // runUpload's loop bails on this
    if (ctrl.xhr) { try { ctrl.xhr.abort(); } catch { /* ignore */ } }
    const uploadId = ctrl.item && ctrl.item.uploadId;
    if (uploadId) fetch(`/api/admin/upload/abort?id=${encodeURIComponent(uploadId)}`, { method: 'POST' }).catch(() => {});
    setState(rowId, 'canceled', { title: '🚫 Canceled' });
    return;
  }
  // Still queued: drop it from the pending queue.
  const idx = uploadQueue.findIndex((q) => q.rowId === rowId);
  if (idx >= 0) uploadQueue.splice(idx, 1);
  setState(rowId, 'canceled', { title: '🚫 Canceled' });
}
function setProgress(rowId, pct) {
  const el = jobNodes.get(rowId);
  if (!el) return;
  const v = Math.max(0, Math.min(100, pct));
  el.querySelector('.bar > i').style.width = `${v}%`;
  const lbl = el.querySelector('.bar-pct');
  if (lbl) lbl.textContent = `${Math.round(v)}%`;
}
function setStats(rowId, text) {
  const el = jobNodes.get(rowId);
  if (el) el.querySelector('.jstats').textContent = text;
}
function setState(rowId, state, { title, desc } = {}) {
  const el = jobNodes.get(rowId);
  if (!el) return;
  el.className = `job ${state}`;
  if (title !== undefined) el.querySelector('.jtitle').textContent = title;
  // Cancel is only meaningful while queued or actively uploading.
  const cancelBtn = el.querySelector('.job-cancel');
  if (cancelBtn) cancelBtn.classList.toggle('hidden', state !== 'queued' && state !== 'uploading');
  if (state === 'ready' || state === 'failed' || state === 'canceled') {
    el.querySelector('.bar').classList.add('hidden');
    if (state === 'ready' || state === 'canceled') el.querySelector('.jstats').textContent = '';
  } else {
    el.querySelector('.bar').classList.remove('hidden');
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
  edit.href = `${ADMIN_PATHS.edit}?v=${encodeURIComponent(manifestId)}`;
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

// --- upload queue (one at a time) ---
const MAX_CONCURRENT = 1;
const MAX_BATCH = 50;
const uploadQueue = [];
let inFlight = 0;

function enqueueFiles(files) {
  primeAudio(); // unlock Web Audio within this user gesture so the done-chime can play
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
    if (file.size > maxUploadBytes) {
      setState(rowId, 'failed', { title: `Too large — ${fmtSize(file.size)} exceeds the ${fmtSize(maxUploadBytes)} upload limit.` });
      return; // never even attempt the upload
    }
    setStats(rowId, 'Waiting…');
    uploadQueue.push({ file, rowId, visibility, blur, category, publishAt });
  });
  pump();
}
function pump() {
  while (inFlight < MAX_CONCURRENT && uploadQueue.length) {
    inFlight++;
    runUpload(uploadQueue.shift());
  }
}

// Chunk size used until the server tells us its preferred size (from /init).
const CHUNK_SIZE_FALLBACK = 16 * 1024 * 1024;

// --- small XHR helpers (XHR, not fetch, so we get upload progress + abort) ---
function jsonReq(method, url, payload, ctrl) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    if (ctrl) ctrl.xhr = xhr;
    xhr.open(method, url);
    if (payload != null) xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, data: {} });
    xhr.ontimeout = () => resolve({ ok: false, status: 0, data: {} });
    xhr.onabort = () => resolve({ ok: false, status: 0, data: {}, aborted: true });
    xhr.send(payload != null ? JSON.stringify(payload) : null);
  });
}
function sendChunk(uploadId, offset, blob, ctrl, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    ctrl.xhr = xhr;
    xhr.open('POST', `/api/admin/upload/chunk?id=${encodeURIComponent(uploadId)}&offset=${offset}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded); };
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, data: {} });
    xhr.ontimeout = () => resolve({ ok: false, status: 0, data: {} });
    xhr.onabort = () => resolve({ ok: false, status: 0, data: {}, aborted: true });
    xhr.send(blob);
  });
}

// Drive one upload from init → chunks → complete. `item` is reused on Retry, so
// it carries uploadId/offset and resumes from the server's last good byte.
async function runUpload(item) {
  const { file, rowId } = item;
  const ctrl = { item, canceled: false, xhr: null };
  jobControls.set(rowId, ctrl);
  setState(rowId, 'uploading', { title: '⬆️ Uploading…' });
  setStats(rowId, item.uploadId ? 'Resuming…' : 'Starting…');

  let settled = false;
  const settle = () => { if (settled) return; settled = true; jobControls.delete(rowId); inFlight--; pump(); };
  const bail = (status, detail) => failWithRetry(rowId, item, describeUploadError(status, detail));

  try {
    // Resume: confirm the server's offset. If the session is gone, start fresh.
    if (item.uploadId) {
      const st = await jsonReq('GET', `/api/admin/upload/status?id=${encodeURIComponent(item.uploadId)}`, null, ctrl);
      if (ctrl.canceled) return;
      if (st.status === 401) { location.reload(); return; }
      if (st.ok && typeof st.data.offset === 'number') item.offset = st.data.offset;
      else { item.uploadId = null; item.offset = 0; }
    }
    // Init a brand-new session.
    if (!item.uploadId) {
      const init = await jsonReq('POST', '/api/admin/upload/init', {
        name: file.name, size: file.size, type: file.type,
        visibility: item.visibility, blur: item.blur, category: item.category, publishAt: item.publishAt,
      }, ctrl);
      if (ctrl.canceled) return;
      if (init.status === 401) { location.reload(); return; }
      if (!init.ok || !init.data.uploadId) { bail(init.status, init.data.error); return; }
      item.uploadId = init.data.uploadId;
      item.offset = init.data.offset || 0;
      item.chunkSize = init.data.chunkSize || CHUNK_SIZE_FALLBACK;
    }
    const chunkSize = item.chunkSize || CHUNK_SIZE_FALLBACK;

    // Upload chunks sequentially, with smoothed MB/s + ETA over the whole file.
    let speed = 0;
    const last = { t: performance.now(), loaded: item.offset };
    while (item.offset < file.size) {
      if (ctrl.canceled) return;
      const end = Math.min(item.offset + chunkSize, file.size);
      const blob = file.slice(item.offset, end);
      // eslint-disable-next-line no-await-in-loop, no-loop-func
      const res = await sendChunk(item.uploadId, item.offset, blob, ctrl, (loadedInChunk) => {
        const loaded = item.offset + loadedInChunk;
        const now = performance.now();
        const dt = (now - last.t) / 1000;
        if (dt > 0.15) {
          const inst = (loaded - last.loaded) / dt;
          speed = speed ? speed * 0.7 + inst * 0.3 : inst;
          last.t = now; last.loaded = loaded;
        }
        setProgress(rowId, (loaded / file.size) * 100);
        const eta = speed > 0 ? (file.size - loaded) / speed : Infinity;
        setStats(rowId, `⬆️ ${((loaded / file.size) * 100).toFixed(0)}% · ${(speed / 1e6).toFixed(1)} MB/s · ETA ${fmtEta(eta)}`);
      });
      if (ctrl.canceled) return;
      if (res.status === 401) { location.reload(); return; }
      // Server tells us its true offset on a desync — snap to it and continue.
      if (res.status === 409 && typeof res.data.expected === 'number') { item.offset = res.data.expected; continue; }
      if (!res.ok) { bail(res.status, res.data.error); return; }
      item.offset = typeof res.data.offset === 'number' ? res.data.offset : end;
    }

    // Finalize → server transcodes; hand off to the granular processing poller.
    setStats(rowId, 'Finalizing…');
    const comp = await jsonReq('POST', `/api/admin/upload/complete?id=${encodeURIComponent(item.uploadId)}`, null, ctrl);
    if (ctrl.canceled) return;
    if (comp.status === 401) { location.reload(); return; }
    if (!comp.ok || !comp.data.jobId) { bail(comp.status, comp.data.error); return; }
    setProgress(rowId, 0);
    setState(rowId, 'processing', { title: '⚙️ Processing…', desc: 'Uploaded ✓ — now processing on the server' });
    setStats(rowId, 'Starting processing…');
    pollJob(rowId, comp.data.jobId, item.publishAt);
  } catch {
    if (!ctrl.canceled) bail(0, null);
  } finally {
    settle();
  }
}

// Mark a row failed with a human-readable reason + a Retry button that resumes
// from the server's offset (the File handle is still in memory this session).
function failWithRetry(rowId, item, message) {
  setState(rowId, 'failed', { title: `❌ ${message}` });
  const el = jobNodes.get(rowId);
  if (!el || el.querySelector('.job-retry')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn sm job-retry';
  btn.textContent = item.uploadId ? '🔁 Retry (resume)' : '🔁 Retry';
  btn.addEventListener('click', () => {
    btn.remove();
    setState(rowId, 'queued', { title: '⏳ Queued…' });
    uploadQueue.unshift(item); // same item object → keeps uploadId/offset to resume
    pump();
  });
  el.querySelector('.jbody').appendChild(btn);
}

// Poll server processing status and render GRANULAR telemetry: the exact task
// name + sub-detail, an overall %, and a live ETA — driving the same bar that the
// upload used (now in its amber "processing" treatment).
async function pollJob(rowId, jobId, publishAt = 0) {
  for (let i = 0; i < 1200; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    let data;
    try {
      const res = await fetch(`/api/admin/status?job=${encodeURIComponent(jobId)}`);
      if (res.status === 401) { location.reload(); return; }
      data = await res.json();
    } catch { continue; }
    const job = data.job;
    if (!job) continue;

    if (job.status === 'processing') {
      if (typeof job.pct === 'number') setProgress(rowId, job.pct);
      const label = job.label || 'Processing…';
      const stepTag = job.steps ? `step ${job.step}/${job.steps} · ` : '';
      const detailTag = job.detail ? `${job.detail} · ` : '';
      const etaTag = job.etaSec != null ? ` · ETA ${fmtEta(job.etaSec)}` : '';
      setState(rowId, 'processing', { title: `⚙️ ${label}` });
      setStats(rowId, `${stepTag}${detailTag}${typeof job.pct === 'number' ? Math.round(job.pct) + '%' : ''}${etaTag}`.replace(/^ · /, ''));
    }
    if (job.status === 'ready') {
      const desc = publishAt ? `⏱ Scheduled for ${new Date(publishAt).toLocaleString()}` : '✓ Published';
      setState(rowId, 'ready', { title: `✅ ${job.title}`, desc });
      addRowActions(rowId, job.manifestId);
      if (isEnabled()) playSound(getSelected()); // 🔊 completion chime
      return;
    }
    if (job.status === 'failed') {
      setState(rowId, 'failed', { title: '❌ Processing failed', desc: job.detail || job.error || '' });
      return;
    }
  }
  setState(rowId, 'failed', { title: '❌ Timed out waiting for processing' });
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

// --- notification sound picker ---
function initSoundPicker() {
  const sel = $('snd-select');
  const toggle = $('snd-toggle');
  const test = $('snd-test');
  if (!sel || !toggle || !test) return;
  for (const s of listSounds()) {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = s.name;
    sel.appendChild(o);
  }
  sel.value = getSelected();
  toggle.checked = isEnabled();
  const syncDisabled = () => { sel.disabled = test.disabled = !toggle.checked; };
  syncDisabled();
  sel.addEventListener('change', () => { primeAudio(); setSelected(sel.value); playSound(sel.value); });
  toggle.addEventListener('change', () => { primeAudio(); setEnabled(toggle.checked); syncDisabled(); });
  test.addEventListener('click', () => { primeAudio(); playSound(sel.value); });
}

async function main() {
  await requireAdmin(); // shows sign-in overlay for non-admins
  initSoundPicker();
  loadCategories();
  try {
    const data = await (await fetch('/api/admin/status')).json();
    $('ffmpeg-banner').classList.toggle('hidden', data.ffmpeg !== false);
    if (typeof data.maxUploadBytes === 'number' && data.maxUploadBytes > 0) maxUploadBytes = data.maxUploadBytes;
  } catch { /* ignore */ }
}
main();
