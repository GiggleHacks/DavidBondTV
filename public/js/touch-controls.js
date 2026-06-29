const SKIP_SECONDS = 10;
const IDLE_MS = 3000;
const DBL_TAP_MS = 300;

export function attachTouchControls(container, video) {
  let lastTap = 0;
  let lastTapX = -Infinity;
  let idleTimer = null;

  function isCustomFullscreen() {
    return document.fullscreenElement === container
      || document.webkitFullscreenElement === container;
  }

  function showControls() {
    container.classList.remove('idle-hide');
  }

  function scheduleHide() {
    clearTimeout(idleTimer);
    if (!video.paused) {
      idleTimer = setTimeout(() => {
        if (isCustomFullscreen()) container.classList.add('idle-hide');
      }, IDLE_MS);
    }
  }

  function onFullscreenChange() {
    if (isCustomFullscreen()) { showControls(); scheduleHide(); }
    else { clearTimeout(idleTimer); container.classList.remove('idle-hide'); }
  }

  function flashIndicator(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 700);
  }

  container.addEventListener('touchend', (e) => {
    if (!isCustomFullscreen()) return;
    const touch = e.changedTouches[0];
    const now = Date.now();
    const x = touch.clientX;
    const rect = container.getBoundingClientRect();
    const isRight = x > rect.left + rect.width / 2;
    const onControls = document.getElementById('controls')?.contains(e.target);
    const elapsed = now - lastTap;
    const sameZone = Math.abs(x - lastTapX) < rect.width / 2;

    if (!onControls && elapsed < DBL_TAP_MS && sameZone) {
      e.preventDefault();
      const delta = isRight ? SKIP_SECONDS : -SKIP_SECONDS;
      video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta));
      flashIndicator(isRight ? 'skip-forward' : 'skip-backward');
      lastTap = 0;
    } else {
      showControls();
      lastTap = now;
      lastTapX = x;
    }
    scheduleHide();
  }, { passive: false });

  container.addEventListener('touchstart', () => {
    if (!isCustomFullscreen()) return;
    showControls();
  }, { passive: true });

  container.addEventListener('mousemove', () => {
    if (!isCustomFullscreen()) return;
    showControls();
    scheduleHide();
  });

  video.addEventListener('pause', () => {
    if (isCustomFullscreen()) { clearTimeout(idleTimer); showControls(); }
  });

  video.addEventListener('play', () => {
    if (isCustomFullscreen()) scheduleHide();
  });

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
}
