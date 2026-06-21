// Admin upload page: password gate → token, then per-file XHR uploads with a
// progress bar, then poll each job until its auto-generated title/description
// land. Token lives in sessionStorage so a refresh keeps you signed in.
const TOKEN_KEY = 'bondtv_admin_token';

const $ = (id) => document.getElementById(id);
const gate = $('gate');
const app = $('app');
const jobsCard = $('jobs-card');
const jobsEl = $('jobs');

let token = sessionStorage.getItem(TOKEN_KEY) || '';

function authHeaders() {
  return { Authorization: `Bearer ${token}` };
}

function showApp(yes) {
  gate.classList.toggle('hidden', yes);
  app.classList.toggle('hidden', !yes);
  jobsCard.classList.toggle('hidden', !yes);
  $('manage-card').classList.toggle('hidden', !yes);
  if (yes) loadLibrary();
}

// --- login ---
async function login() {
  const err = $('login-err');
  err.classList.add('hidden');
  const password = $('pw').value;
  $('login-btn').disabled = true;
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      err.textContent = data.error || 'Sign in failed.';
      err.classList.remove('hidden');
      return;
    }
    token = data.token;
    sessionStorage.setItem(TOKEN_KEY, token);
    $('pw').value = '';
    await enter();
  } catch {
    err.textContent = 'Network error.';
    err.classList.remove('hidden');
  } finally {
    $('login-btn').disabled = false;
  }
}

// Verify an existing token + load ffmpeg status; returns true if authed.
async function enter() {
  try {
    const res = await fetch('/api/admin/status', { headers: authHeaders() });
    if (res.status === 401) { signOut(); return false; }
    const data = await res.json().catch(() => ({}));
    showApp(true);
    $('ffmpeg-banner').classList.toggle('hidden', data.ffmpeg !== false);
    return true;
  } catch {
    return false;
  }
}

function signOut() {
  token = '';
  sessionStorage.removeItem(TOKEN_KEY);
  showApp(false);
}

// --- jobs UI ---
const jobOrder = []; // jobId, newest first
const jobNodes = new Map();

function renderJob(jobId, name) {
  const el = document.createElement('div');
  el.className = 'job processing';
  el.innerHTML = `
    <span class="dot"></span>
    <div class="jbody">
      <div class="jname"></div>
      <div class="jtitle">Uploading…</div>
      <div class="jdesc"></div>
      <div class="bar"><i></i></div>
    </div>`;
  el.querySelector('.jname').textContent = name;
  jobNodes.set(jobId, el);
  jobOrder.unshift(jobId);
  jobsEl.prepend(el);
  return el;
}

function setProgress(jobId, pct) {
  const el = jobNodes.get(jobId);
  if (el) el.querySelector('.bar > i').style.width = `${pct}%`;
}

function setState(jobId, state, { title, desc } = {}) {
  const el = jobNodes.get(jobId);
  if (!el) return;
  el.className = `job ${state}`;
  if (title) el.querySelector('.jtitle').textContent = title;
  if (state === 'ready') el.querySelector('.bar').classList.add('hidden');
  if (state === 'processing' && !title) el.querySelector('.jtitle').textContent = 'Analyzing…';
  el.querySelector('.jdesc').textContent = desc || '';
}

// --- upload ---
function uploadFile(file) {
  // Provisional client-side id just for the UI row; real ids come from the server.
  const rowId = `row-${Date.now()}-${Math.round(performance.now())}`;
  renderJob(rowId, file.name);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/admin/upload?name=${encodeURIComponent(file.name)}`);
  xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) setProgress(rowId, Math.round((e.loaded / e.total) * 100));
  };
  xhr.onload = () => {
    if (xhr.status === 401) { signOut(); return; }
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
    if (xhr.status === 202 && data.jobId) {
      setProgress(rowId, 100);
      setState(rowId, 'processing');
      pollJob(rowId, data.jobId);
    } else {
      setState(rowId, 'failed', { title: data.error || `Upload failed (${xhr.status})` });
    }
  };
  xhr.onerror = () => setState(rowId, 'failed', { title: 'Network error during upload' });
  xhr.send(file);
}

async function pollJob(rowId, jobId) {
  for (let i = 0; i < 600; i++) { // up to ~20 min
    await new Promise((r) => setTimeout(r, 2000));
    let data;
    try {
      const res = await fetch(`/api/admin/status?job=${encodeURIComponent(jobId)}`, { headers: authHeaders() });
      if (res.status === 401) { signOut(); return; }
      data = await res.json();
    } catch { continue; }
    const job = data.job;
    if (!job) continue;
    if (job.status === 'ready') {
      setState(rowId, 'ready', { title: job.title, desc: '✨ Auto-generated · processed' });
      loadLibrary(); // surface the new video in the manage list
      return;
    }
    if (job.status === 'failed') {
      setState(rowId, 'failed', { title: 'Processing failed', desc: job.error || '' });
      return;
    }
  }
  setState(rowId, 'failed', { title: 'Timed out waiting for processing' });
}

// --- library (manage / delete) ---
async function loadLibrary() {
  const lib = $('library');
  try {
    const res = await fetch(`/thumbs/videos.json?_=${Date.now()}`);
    const videos = await res.json();
    $('vcount').textContent = `(${videos.length})`;
    lib.replaceChildren(...videos.map(libRow));
    if (!videos.length) lib.innerHTML = '<p class="muted">No videos yet.</p>';
  } catch {
    lib.innerHTML = '<p class="muted">Could not load the library.</p>';
  }
}

function libRow(v) {
  const row = document.createElement('div');
  row.className = 'lib-row';
  row.innerHTML = `
    ${v.thumb ? `<img alt="" src="${v.thumb}" />` : '<img alt="" />'}
    <div class="lt"><b></b><span></span></div>
    <button class="btn-del" type="button">Delete</button>`;
  row.querySelector('b').textContent = v.title || v.id;
  row.querySelector('span').textContent = `${v.durLabel || ''} · ${v.uploaded || ''}`.replace(/^ · | · $/g, '');
  const btn = row.querySelector('.btn-del');
  btn.addEventListener('click', () => deleteVideo(v, row, btn));
  return row;
}

async function deleteVideo(v, row, btn) {
  if (!confirm(`Delete "${v.title || v.id}"? This removes it from the site and deletes its files.`)) return;
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    const res = await fetch('/api/admin/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ id: v.id }),
    });
    if (res.status === 401) { signOut(); return; }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      row.remove();
      const n = $('library').querySelectorAll('.lib-row').length;
      $('vcount').textContent = `(${n})`;
    } else {
      alert(data.error || 'Delete failed.');
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  } catch {
    alert('Network error.');
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
}

// --- wiring ---
$('login-btn').addEventListener('click', login);
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('logout').addEventListener('click', signOut);

const drop = $('drop');
const fileInput = $('file');
drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  [...fileInput.files].forEach(uploadFile);
  fileInput.value = '';
});
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.add('drag');
}));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.remove('drag');
}));
drop.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.(mp4|mov|m4v)$/i.test(f.name));
  files.forEach(uploadFile);
});

// Resume an existing session on load.
if (token) enter();
