// Reports actual watch time to /api/track via small heartbeats. Measures real
// played seconds (accumulated from timeupdate deltas, so pauses and seeks don't
// inflate it) and flushes every 15s plus on pause / end / tab-hide / unload.
// The server attaches IP / country / user — the client sends no PII.
export function initWatchTracker(video, videoId) {
  if (!video || !videoId) return;
  const viewId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2);
  const sessionId = (() => {
    try {
      const key = 'dbtv_watch_session_id';
      let id = sessionStorage.getItem(key);
      if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); sessionStorage.setItem(key, id); }
      return id;
    } catch { return viewId; }
  })();
  const deviceId = (() => {
    try {
      const key = 'dbtv_device_id';
      let id = localStorage.getItem(key);
      if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); localStorage.setItem(key, id); }
      return id;
    } catch { return null; }
  })();
  let acc = 0;       // unsent watched seconds
  let last = null;   // previous currentTime sample

  video.addEventListener('timeupdate', () => {
    if (video.paused || video.seeking) { last = video.currentTime; return; }
    if (last == null) { last = video.currentTime; return; }
    const d = video.currentTime - last;
    last = video.currentTime;
    if (d > 0 && d < 4) acc += d; // ignore seeks / large jumps
  });

  function send() {
    if (acc <= 0) return;
    const dt = acc; acc = 0;
    const payload = JSON.stringify({
      v: videoId, vid: viewId, sid: sessionId, did: deviceId,
      dt: Math.round(dt * 100) / 100,
      pos: Math.round(video.currentTime || 0), dur: Math.round(video.duration || 0),
      vp: `${window.innerWidth || 0}x${window.innerHeight || 0}`,
      devType: window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop',
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/track', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/track', { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' }, keepalive: true });
      }
    } catch { /* tracking is best-effort */ }
  }

  const timer = setInterval(send, 15000);
  ['pause', 'ended'].forEach((ev) => video.addEventListener(ev, send));
  document.addEventListener('visibilitychange', () => { if (document.hidden) send(); });
  window.addEventListener('pagehide', send);
  window.addEventListener('beforeunload', () => { clearInterval(timer); send(); });
}
