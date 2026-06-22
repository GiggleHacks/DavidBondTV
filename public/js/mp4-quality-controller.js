// Manual quality switching for videos served as discrete MP4 renditions (no
// HLS). Mirrors the createHlsController API so the settings menu can drive it
// unchanged: it reports levels via onLevels([{height,bitrate}]) and accepts a
// setLevel(index) where index is the position in that array (or -1 for "Auto",
// which maps to the highest rendition). Switching swaps video.src while
// preserving the current time and play/pause state.
export function createMp4QualityController(video, qualityLevels, { onLevels, onAutoLevel, onError }) {
  // Highest first, so index 0 is the best quality.
  const levels = [...qualityLevels].sort((a, b) => b.height - a.height);
  let current = 0;

  function load(index, { resume } = {}) {
    const level = levels[index];
    if (!level) return;
    current = index;

    const t = video.currentTime || 0;
    const wasPlaying = resume !== undefined ? resume : !video.paused;

    const restore = () => {
      video.removeEventListener('loadedmetadata', restore);
      if (t > 0) { try { video.currentTime = t; } catch { /* ignore */ } }
      if (wasPlaying) { const p = video.play(); if (p && p.catch) p.catch(() => {}); }
    };
    video.addEventListener('loadedmetadata', restore);
    video.src = level.url;
    video.load();
  }

  video.addEventListener('error', () => {
    if (video.error) onError('This video could not be played.');
  });

  // Report the ladder to the menu, default to the highest rendition, and tell
  // the menu what "Auto" currently resolves to (so it reads e.g. "Auto (1080p)").
  onLevels(levels.map((l) => ({ height: l.height, bitrate: l.bitrate })));
  if (onAutoLevel) onAutoLevel(levels[0].height, true);
  load(0, { resume: false });

  return {
    setLevel(index) {
      const target = index === -1 ? 0 : index; // Auto → best
      if (target === current) return;
      load(target);
    },
    destroy() { video.removeAttribute('src'); video.load(); },
    get isNative() { return true; },
  };
}
