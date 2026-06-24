// Review Mode (/god-review.html) — a fast, full-screen "Tinder" moderation flow
// for unapproved draft videos. The Videos page hands off an ordered list of ids
// via sessionStorage; this page plays each ready draft one at a time and lets the
// admin Approve (👍) or Delete (👎) with a single click/keypress, auto-advancing.
//
// Decisions are DEFERRED: nothing is approved or deleted until the end-of-session
// summary is confirmed. That makes a stray keypress on a 1000-video batch safe.
// Progress is mirrored to sessionStorage after every decision so an accidental
// reload resumes mid-session instead of starting over.
import { requireAdmin } from './god-auth.js';
import { ADMIN_PATHS } from './admin-paths.js';

const $ = (id) => document.getElementById(id);
const QUEUE_KEY = 'dbtv-review-queue';     // [id, id, …] written by admin-videos
const PROGRESS_KEY = 'dbtv-review-progress'; // { sig, idx, approved:[], toDelete:[] }

// --- session state ----------------------------------------------------------
let queue = [];              // ordered, ready-only manifest entries to review
let idx = 0;                 // index of the currently shown video
let skipped = 0;             // queued ids that weren't ready (still processing/failed)
const approved = new Set();      // ids marked 👍 (committed at confirm)
const approvedFree = new Set();  // ids marked 🆓 — approve + de-blur + visibility:free
const toDelete = new Set();      // ids marked 👎 (committed at confirm)

const back = () => { location.href = ADMIN_PATHS.videos; };

// --- progress persistence (crash/reload resume) -----------------------------
const queueSig = () => queue.map((v) => v.id).join(',');

function saveProgress() {
  try {
    sessionStorage.setItem(PROGRESS_KEY, JSON.stringify({
      sig: queueSig(), idx,
      approved: [...approved], approvedFree: [...approvedFree], toDelete: [...toDelete],
    }));
  } catch { /* storage full / disabled — non-fatal */ }
}

function restoreProgress() {
  let p;
  try { p = JSON.parse(sessionStorage.getItem(PROGRESS_KEY) || 'null'); } catch { p = null; }
  if (!p || p.sig !== queueSig()) return; // different queue → ignore stale progress
  idx = Math.min(Math.max(0, p.idx | 0), queue.length);
  const live = new Set(queue.map((v) => v.id));
  (p.approved || []).forEach((id) => { if (live.has(id)) approved.add(id); });
  (p.approvedFree || []).forEach((id) => { if (live.has(id)) approvedFree.add(id); });
  (p.toDelete || []).forEach((id) => { if (live.has(id)) toDelete.add(id); });
}

// --- view -------------------------------------------------------------------
function show(which) {
  for (const name of ['empty', 'stage', 'summary']) $(`rv-${name}`).classList.toggle('hidden', name !== which);
}

// Pick the highest-quality rendition url for a ready entry.
function bestSrc(v) {
  const q = Array.isArray(v.qualityLevels) ? [...v.qualityLevels] : [];
  q.sort((a, b) => (b.height || 0) - (a.height || 0));
  return (q[0] && q[0].url) || '';
}

// What to play for review. Encoded videos play their best rendition; videos still
// awaiting encoding (the new review-first flow) stream their ORIGINAL via the
// admin-only review endpoint — so the admin watches the real footage before any
// CPU is spent encoding it.
function srcFor(v) {
  if ((v.status || 'ready') === 'ready') return bestSrc(v);
  return `/api/admin/review-source?id=${encodeURIComponent(v.id)}`;
}
// Is this entry reviewable (has something to play)?
const reviewable = (v) => ((v.status || 'ready') === 'ready' ? !!bestSrc(v) : (v.status === 'uploaded' || v.status === 'failed'));

function renderCard() {
  if (idx >= queue.length) { renderSummary(); return; }
  show('stage');
  const v = queue[idx];
  $('rv-counter').textContent = `${idx + 1} / ${queue.length}`;
  $('rv-tally-up').textContent = `👍 ${approved.size}`;
  $('rv-tally-free').textContent = `🆓 ${approvedFree.size}`;
  $('rv-tally-down').textContent = `👎 ${toDelete.size}`;
  $('rv-undo').disabled = idx === 0;
  $('rv-prev').disabled = idx === 0;
  $('rv-next').disabled = idx >= queue.length - 1;
  $('rv-title').textContent = v.title || v.id;
  const bits = [v.durLabel, v.uploaded, v.visibility === 'premium' ? 'Premium' : 'Free'].filter(Boolean);
  $('rv-sub').textContent = bits.join(' · ');
  const vid = $('rv-video');
  const src = srcFor(v);
  vid.poster = v.thumb || '';
  vid.src = src;
  vid.muted = false;
  vid.volume = 1;
  vid.currentTime = 0;
  vid.play().catch(() => { /* unmuted autoplay may be blocked until interaction — fine */ });
}

function renderSummary() {
  show('summary');
  const v = $('rv-video'); if (v) v.pause();
  $('rv-sum-up').textContent = approved.size;
  $('rv-sum-free').textContent = approvedFree.size;
  $('rv-sum-down').textContent = toDelete.size;
  $('rv-sum-skip').textContent = skipped;
  const undecided = queue.length - approved.size - approvedFree.size - toDelete.size;
  const totalApprove = approved.size + approvedFree.size;
  const freeNote = approvedFree.size ? `; ${approvedFree.size} also moved to Free and de-blurred` : '';
  const approveNote = totalApprove ? `Approved videos start encoding now${freeNote}.` : 'No videos approved.';
  $('rv-sum-warn').innerHTML = toDelete.size
    ? `<b>${toDelete.size}</b> video${toDelete.size === 1 ? '' : 's'} will be <b>rejected</b> — marked rejected and their (un-encoded) original removed. ${approveNote}`
    : approveNote;
  $('rv-sum-msg').textContent = undecided > 0 ? `${undecided} not yet reviewed (left awaiting review).` : '';
}

// --- decisions --------------------------------------------------------------
function decide(action) {
  if (idx >= queue.length) return;
  const id = queue[idx].id;
  // Buckets are mutually exclusive: a video lands in exactly one of the three.
  if (action === 'approve') { approved.add(id); approvedFree.delete(id); toDelete.delete(id); }
  else if (action === 'approve-free') { approvedFree.add(id); approved.delete(id); toDelete.delete(id); }
  else { toDelete.add(id); approved.delete(id); approvedFree.delete(id); }
  transitionTo(idx + 1, action === 'delete' ? 'delete' : 'next');
}

function undo() {
  if (idx === 0) return;
  idx -= 1;
  const id = queue[idx].id;
  approved.delete(id);
  approvedFree.delete(id);
  toDelete.delete(id);
  saveProgress();
  renderCard();
}

function transitionTo(nextIdx, mode = 'next') {
  if (nextIdx < 0 || nextIdx > queue.length || nextIdx === idx) return;
  const wrap = $('rv-video-wrap');
  wrap.classList.remove('rv-enter', 'rv-exit-next', 'rv-exit-prev', 'rv-exit-delete');
  wrap.classList.add(mode === 'prev' ? 'rv-exit-prev' : mode === 'delete' ? 'rv-exit-delete' : 'rv-exit-next');
  setTimeout(() => {
    idx = nextIdx;
    saveProgress();
    renderCard();
    wrap.classList.remove('rv-exit-next', 'rv-exit-prev', 'rv-exit-delete');
    wrap.classList.add('rv-enter');
    setTimeout(() => wrap.classList.remove('rv-enter'), 220);
  }, 180);
}

function move(delta) {
  const nextIdx = idx + delta;
  if (nextIdx < 0 || nextIdx >= queue.length) return;
  transitionTo(nextIdx, delta < 0 ? 'prev' : 'next');
}

// --- commit -----------------------------------------------------------------
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Apply one bulk action to every id, in ≤500-id batches (the /api/admin/bulk
// route caps the request body at 64 KB, ~1600 ids — stay well under it).
async function bulk(ids, action) {
  for (const batch of chunk(ids, 500)) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch('/api/admin/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: batch, action }),
    });
    if (res.status === 401) { location.reload(); return false; }
    // eslint-disable-next-line no-await-in-loop
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.ok) throw new Error(d.error || `Bulk ${action} failed.`);
  }
  return true;
}

async function confirmSession() {
  const btn = $('rv-sum-confirm');
  btn.disabled = true;
  $('rv-sum-msg').textContent = 'Applying…';
  try {
    if (approved.size) { if (!(await bulk([...approved], 'approve'))) return; }
    if (approvedFree.size) { if (!(await bulk([...approvedFree], 'approve-free'))) return; }
    if (toDelete.size) { if (!(await bulk([...toDelete], 'reject'))) return; }
    try { sessionStorage.removeItem(QUEUE_KEY); sessionStorage.removeItem(PROGRESS_KEY); } catch { /* ignore */ }
    back();
  } catch (e) {
    btn.disabled = false;
    $('rv-sum-msg').textContent = e.message || 'Something went wrong applying decisions.';
  }
}

// --- wiring -----------------------------------------------------------------
function wire() {
  $('rv-up').addEventListener('click', () => decide('approve'));
  $('rv-free').addEventListener('click', () => decide('approve-free'));
  $('rv-down').addEventListener('click', () => decide('delete'));
  $('rv-prev').addEventListener('click', () => move(-1));
  $('rv-next').addEventListener('click', () => move(1));
  $('rv-undo').addEventListener('click', undo);
  $('rv-finish').addEventListener('click', renderSummary);
  $('rv-sum-confirm').addEventListener('click', confirmSession);
  $('rv-sum-back').addEventListener('click', () => { idx = Math.max(0, queue.length ? Math.min(idx, queue.length - 1) : 0); renderCard(); });
  $('rv-empty-back').addEventListener('click', (e) => { e.preventDefault(); back(); });

  document.addEventListener('keydown', (e) => {
    if ($('rv-stage').classList.contains('hidden')) return; // only during active review
    const k = e.key.toLowerCase();
    if (e.key === 'ArrowUp' || k === 'u') { e.preventDefault(); decide('approve-free'); }
    else if (e.key === 'ArrowRight' || k === 'f') { e.preventDefault(); decide('approve'); }
    else if (e.key === 'ArrowLeft' || k === 'd') { e.preventDefault(); decide('delete'); }
    else if (k === 'n') { e.preventDefault(); move(1); }
    else if (k === 'p') { e.preventDefault(); move(-1); }
    else if (e.key === 'Backspace') { e.preventDefault(); undo(); }
    else if (e.key === ' ') { e.preventDefault(); const v = $('rv-video'); if (v.paused) v.play().catch(() => {}); else v.pause(); }
  });
}

async function main() {
  await requireAdmin();
  wire();

  let ids = [];
  try { ids = JSON.parse(sessionStorage.getItem(QUEUE_KEY) || '[]'); } catch { ids = []; }
  if (!Array.isArray(ids) || !ids.length) { show('empty'); return; }

  let all = [];
  try { all = (await (await fetch(`/api/admin/videos?_=${Date.now()}`)).json()).videos || []; } catch { all = []; }
  const byId = new Map(all.map((v) => [v.id, v]));

  // Keep the queued order; include videos awaiting review (uploaded, pre-encode)
  // and any encoded ones, skipping anything with nothing playable.
  for (const id of ids) {
    const v = byId.get(id);
    if (!v) continue;
    if (reviewable(v)) queue.push(v);
    else skipped += 1;
  }

  if (!queue.length) { show('empty'); return; }
  restoreProgress();
  renderCard();
}

main();
