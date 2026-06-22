import { formatTime } from './format.js';

export function createProgressBar({ video, els, storyboard }) {
  function ratioFromEvent(e) {
    const rect = els.progress.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  function renderProgress() {
    if (!video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    els.played.style.width = `${pct}%`;
    els.scrubber.style.left = `${pct}%`;
  }

  function renderBuffered() {
    if (!video.duration || video.buffered.length === 0) return;
    const end = video.buffered.end(video.buffered.length - 1);
    els.buffered.style.width = `${(end / video.duration) * 100}%`;
  }

  function showThumb(e) {
    if (!video.duration) return;
    const ratio = ratioFromEvent(e);
    const time = ratio * video.duration;
    const rect = els.progress.getBoundingClientRect();

    els.thumb.hidden = false;
    els.thumb.style.left = `${Math.min(rect.width - 80, Math.max(80, ratio * rect.width))}px`;
    els.thumbTime.textContent = formatTime(time);

    if (storyboard) {
      const loc = storyboard.locate(time);
      els.thumbImg.style.backgroundImage = `url("${storyboard.sheetUrl(loc.sheet)}")`;
      els.thumbImg.style.backgroundPosition = `-${loc.x}px -${loc.y}px`;
    }
  }

  function seekToEvent(e) {
    if (!video.duration) return;
    video.currentTime = ratioFromEvent(e) * video.duration;
    renderProgress();
  }

  let scrubbing = false;
  els.progress.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    els.progress.setPointerCapture(e.pointerId);
    seekToEvent(e);
  });
  els.progress.addEventListener('pointermove', (e) => {
    if (scrubbing) seekToEvent(e);
    else showThumb(e);
  });
  els.progress.addEventListener('pointerup', (e) => {
    scrubbing = false;
    els.progress.releasePointerCapture(e.pointerId);
  });
  els.progress.addEventListener('pointerleave', () => { els.thumb.hidden = true; });

  video.addEventListener('timeupdate', renderProgress);
  video.addEventListener('progress', renderBuffered);
  video.addEventListener('loadedmetadata', () => { renderProgress(); renderBuffered(); });

  return { renderProgress, renderBuffered };
}
