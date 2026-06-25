// Cross-browser fullscreen for the player.
//
// Desktop and Android Chrome fullscreen the player *container* so our custom
// controls overlay stays visible. iPhone Safari does NOT implement
// Element.requestFullscreen at all — the only thing that can go fullscreen is the
// <video> element itself, via the non-standard `webkitEnterFullscreen()`. That's
// why the old `container.requestFullscreen()` silently did nothing on a portrait
// iPhone. We try the standard path first, fall back to the webkit video API, and
// best-effort lock to landscape inside the user gesture.

/** True if the player is currently in any fullscreen mode (standard or iOS video). */
export function isFullscreen(container, video) {
  return document.fullscreenElement === container
    || document.webkitFullscreenElement === container
    || !!(video && video.webkitDisplayingFullscreen);
}

function lockLandscape() {
  try {
    if (screen.orientation && typeof screen.orientation.lock === 'function') {
      // Promise-returning; rejects on desktop / when not allowed — ignore.
      screen.orientation.lock('landscape').catch(() => {});
    }
  } catch { /* unsupported — ignore */ }
}

function enterFullscreen(container, video) {
  if (container && container.requestFullscreen) {
    container.requestFullscreen().then(lockLandscape).catch(() => {
      // Some mobile browsers reject fullscreen on a non-video element — fall back
      // to fullscreening the <video> directly.
      if (video && video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    });
  } else if (container && container.webkitRequestFullscreen) {
    container.webkitRequestFullscreen();
    lockLandscape();
  } else if (video && video.webkitEnterFullscreen) {
    // iPhone Safari: only the video element can present fullscreen.
    video.webkitEnterFullscreen();
  }
}

function exitFullscreen(video) {
  try {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    else if (video && video.webkitExitFullscreen) video.webkitExitFullscreen();
  } catch { /* ignore */ }
  try {
    if (screen.orientation && typeof screen.orientation.unlock === 'function') screen.orientation.unlock();
  } catch { /* ignore */ }
}

/** Toggle the player in/out of fullscreen, picking the API the browser supports. */
export function toggleFullscreen(container, video) {
  if (isFullscreen(container, video) || document.fullscreenElement || document.webkitFullscreenElement) {
    exitFullscreen(video);
  } else {
    enterFullscreen(container, video);
  }
}
