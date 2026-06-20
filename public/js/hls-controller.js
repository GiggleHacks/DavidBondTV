// Wraps hls.js (global `Hls` from /vendor/hls.min.js). Falls back to native
// HLS (Safari) where hls.js is unsupported.
export function createHlsController(video, src, { onLevels, onAutoLevel, onError }) {
  const Hls = window.Hls;

  if (Hls && Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true });
    hls.loadSource(src);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      const levels = hls.levels.map((l) => ({ height: l.height, bitrate: l.bitrate }));
      onLevels(levels);
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      const level = hls.levels[data.level];
      if (level) onAutoLevel(level.height, hls.autoLevelEnabled);
    });

    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          hls.startLoad();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          hls.recoverMediaError();
          break;
        default:
          onError('This video could not be played.');
          hls.destroy();
      }
    });

    return {
      setLevel(index) { hls.currentLevel = index; },
      destroy() { hls.destroy(); },
      get isNative() { return false; },
    };
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS: the browser manages ABR; levels are not enumerable.
    video.src = src;
    video.addEventListener('loadedmetadata', () => onLevels([]));
    video.addEventListener('error', () => onError('This video could not be played.'));
    return {
      setLevel() {},
      destroy() { video.removeAttribute('src'); video.load(); },
      get isNative() { return true; },
    };
  }

  onError('HLS is not supported in this browser.');
  return { setLevel() {}, destroy() {}, get isNative() { return true; } };
}
