import { formatTime } from './format.js';
import { ICONS } from './icons.js';

export function createControls({ video, container, els, onToggleSettings }) {
  function renderPlay() {
    const playing = !video.paused;
    els.playBtn.innerHTML = playing ? ICONS.pause : ICONS.play;
    els.bigPlay.innerHTML = ICONS.play;
    els.bigPlay.hidden = playing;
    container.classList.toggle('paused', video.paused);
  }

  function renderVolume() {
    const muted = video.muted || video.volume === 0;
    els.muteBtn.innerHTML = muted ? ICONS.volMute : ICONS.volHigh;
    const ratio = muted ? 0 : video.volume;
    els.volFill.style.width = `${ratio * 100}%`;
    els.volKnob.style.left = `${ratio * 100}%`;
  }

  function renderTime() {
    els.timeLabel.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  }

  function renderFullscreen() {
    const fs = document.fullscreenElement === container;
    els.fullscreenBtn.innerHTML = fs ? ICONS.exitFullscreen : ICONS.enterFullscreen;
  }

  function togglePlay() {
    if (video.paused) video.play(); else video.pause();
  }

  function setVolumeFromEvent(e) {
    const rect = els.volSlider.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    video.volume = ratio;
    video.muted = ratio === 0;
  }

  // Button wiring
  els.playBtn.addEventListener('click', togglePlay);
  els.bigPlay.addEventListener('click', togglePlay);
  els.muteBtn.addEventListener('click', () => { video.muted = !video.muted; });
  els.settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); onToggleSettings(); });
  els.fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement === container) document.exitFullscreen();
    else container.requestFullscreen();
  });

  // Volume drag
  let draggingVol = false;
  els.volSlider.addEventListener('pointerdown', (e) => {
    draggingVol = true;
    els.volSlider.setPointerCapture(e.pointerId);
    setVolumeFromEvent(e);
  });
  els.volSlider.addEventListener('pointermove', (e) => { if (draggingVol) setVolumeFromEvent(e); });
  els.volSlider.addEventListener('pointerup', (e) => {
    draggingVol = false;
    els.volSlider.releasePointerCapture(e.pointerId);
  });

  // Video state -> UI
  video.addEventListener('play', renderPlay);
  video.addEventListener('pause', renderPlay);
  video.addEventListener('volumechange', renderVolume);
  video.addEventListener('timeupdate', renderTime);
  video.addEventListener('loadedmetadata', renderTime);
  document.addEventListener('fullscreenchange', renderFullscreen);

  // Initial paint
  renderPlay();
  renderVolume();
  renderTime();
  renderFullscreen();

  return { renderPlay, renderVolume, renderTime };
}
