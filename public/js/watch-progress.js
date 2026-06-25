// YouTube-style "continue watching" progress.
//
// Stores each video's last playback position locally (per device) so we can:
//   1. paint a red progress bar across the bottom of its thumbnail, and
//   2. resume the video from where the viewer left off.
//
// Local-first by design: it works for anonymous free viewers and members alike,
// renders instantly with no per-thumbnail server round-trip, and never sends PII.
// A video counts as "watched" once the viewer passes WATCHED_PCT of its duration.

const KEY = 'dbtv_watch_progress';
export const WATCHED_PCT = 0.22;     // ~20–25% → considered "watched"
const MIN_RESUME_SEC = 5;            // don't bother resuming the first few seconds
const RESUME_MAX_PCT = 0.95;         // basically finished → start fresh, don't resume
const MAX_ENTRIES = 500;             // cap stored videos; prune oldest beyond this
const SAVE_THROTTLE_MS = 4000;       // how often to persist during playback

function loadMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch { return {}; }
}

function saveMap(map) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* quota/full — ignore */ }
}

/** Saved progress for one video, or null. Shape: { pos, dur, pct, watched, t }. */
export function getProgress(id) {
  if (!id) return null;
  const e = loadMap()[id];
  return e && typeof e.pos === 'number' ? e : null;
}

/**
 * Record a playback position. pct/watched are derived; "watched" is sticky — once
 * a video crosses the threshold it stays marked even if the viewer later scrubs
 * back to the start. Prunes the oldest entries when the store grows too large.
 */
export function recordProgress(id, pos, dur) {
  if (!id || typeof pos !== 'number' || pos < 0) return;
  const map = loadMap();
  const prev = map[id] || {};
  const duration = typeof dur === 'number' && dur > 0 ? dur : (prev.dur || 0);
  const pct = duration > 0 ? Math.min(1, Math.max(0, pos / duration)) : 0;
  map[id] = {
    pos: Math.round(pos),
    dur: Math.round(duration),
    pct,
    watched: !!prev.watched || pct >= WATCHED_PCT,
    t: Date.now(),
  };
  const ids = Object.keys(map);
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => (map[a].t || 0) - (map[b].t || 0));
    for (const old of ids.slice(0, ids.length - MAX_ENTRIES)) delete map[old];
  }
  saveMap(map);
}

/**
 * Wire a <video> for resume + progress saving. On metadata load it seeks to the
 * saved position (when meaningfully mid-video); during playback it persists the
 * position on a throttle and at every natural stopping point.
 */
export function attachWatchProgress(video, id) {
  if (!video || !id) return;

  // Resume to the saved position. The MP4-quality / HLS controllers can swap the
  // <video> source during initial load (resetting currentTime to 0 AFTER our first
  // seek), so a one-shot seek loses the race. Instead we keep nudging to the target
  // across a short window right after load — but stop the moment the viewer scrubs
  // themselves, so we never fight them. Our own seeks are flagged so the user-seek
  // detector ignores them.
  const target = (() => {
    const p = getProgress(id);
    return (p && p.pos > MIN_RESUME_SEC) ? p.pos : 0;
  })();
  let stopResume = !target;
  let selfSeek = false;
  const tryResume = () => {
    if (stopResume) return;
    const dur = video.duration || 0;
    if (dur && target >= dur * RESUME_MAX_PCT) { stopResume = true; return; } // basically finished
    if (video.currentTime >= target - 1) return; // already at/past the resume point
    selfSeek = true;
    try { video.currentTime = target; } catch { /* not seekable yet — retry next tick */ }
  };
  // A 'seeking' we didn't trigger means the viewer moved the playhead → back off.
  video.addEventListener('seeking', () => {
    if (selfSeek) { selfSeek = false; return; }
    stopResume = true;
  });
  ['loadedmetadata', 'loadeddata', 'canplay'].forEach((ev) => video.addEventListener(ev, tryResume));
  if (target) {
    let ticks = 0;
    const iv = setInterval(() => { tryResume(); if (stopResume || (ticks += 1) > 24) clearInterval(iv); }, 250); // ~6s window
  }

  let lastSave = 0;
  const save = () => { recordProgress(id, video.currentTime || 0, video.duration || 0); lastSave = Date.now(); };
  video.addEventListener('timeupdate', () => {
    if (video.paused || video.seeking) return;
    if (Date.now() - lastSave >= SAVE_THROTTLE_MS) save();
  });
  ['pause', 'seeked'].forEach((ev) => video.addEventListener(ev, save));
  // Count a finished video as fully watched.
  video.addEventListener('ended', () => recordProgress(id, video.duration || 0, video.duration || 0));
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  window.addEventListener('pagehide', save);
}

/**
 * Paint (or update) the progress bar on a thumbnail element (the `.vthumb` div).
 * No bar is shown for videos with no recorded progress. Safe to call repeatedly.
 */
export function renderThumbProgress(thumbEl, id) {
  if (!thumbEl) return;
  const p = getProgress(id);
  let bar = thumbEl.querySelector('.vprogress');
  if (!p || !p.pct) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'vprogress';
    bar.innerHTML = '<i></i>';
    thumbEl.appendChild(bar);
  }
  bar.classList.toggle('is-watched', !!p.watched);
  bar.querySelector('i').style.width = `${Math.min(100, Math.round(p.pct * 100))}%`;
  bar.setAttribute('title', p.watched ? 'Watched' : 'Keep watching');
}
