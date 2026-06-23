// Chrome-free build of the watch player for iframe embedding (course trailers).
// Reuses the exact same control/quality/progress/storyboard modules as the full
// watch page (js/player.js) — just without comments, reactions, gating, meta or
// admin controls. Plays whatever ?v=<id> points at, assuming it's a free video.
import { createMp4QualityController } from './mp4-quality-controller.js';
import { createControls } from './controls.js';
import { createProgressBar } from './progress-bar.js';
import { createSettingsMenu } from './settings-menu.js';
import { loadStoryboard } from './storyboard.js';
import { attachKeyboard } from './keyboard.js';
import { nextRate } from './playback.js';
import { initTheme } from './theme.js';

const $ = (id) => document.getElementById(id);
const FPS = 30000 / 1001;

async function loadEntry(id) {
  try {
    const res = await fetch('/thumbs/videos.json');
    const videos = await res.json();
    return videos.find((v) => v.id === id) || null;
  } catch {
    return null;
  }
}

(async function init() {
  initTheme();
  const video = $('video');
  const container = $('player');
  const els = {
    playBtn: $('play-btn'), bigPlay: $('big-play'), muteBtn: $('mute-btn'),
    volSlider: $('vol-slider'), volFill: $('vol-fill'), volKnob: $('vol-knob'),
    timeLabel: $('time'), settingsBtn: $('settings-btn'), fullscreenBtn: $('fullscreen-btn'),
    progress: $('progress'), played: $('played'), buffered: $('buffered'), scrubber: $('scrubber'),
    thumb: $('thumb'), thumbImg: $('thumb-img'), thumbTime: $('thumb-time'),
  };
  const spinner = $('spinner');
  const errorOverlay = $('error');
  const errorMsg = $('error-msg');
  const retryBtn = $('retry-btn');
  const settingsMenuEl = $('settings-menu');

  video.addEventListener('waiting', () => { spinner.hidden = false; });
  video.addEventListener('playing', () => { spinner.hidden = true; });
  video.addEventListener('canplay', () => { spinner.hidden = true; });
  function showError(message) { errorMsg.textContent = message; errorOverlay.hidden = false; spinner.hidden = true; }
  retryBtn.addEventListener('click', () => { errorOverlay.hidden = true; location.reload(); });

  const id = new URLSearchParams(location.search).get('v') || '';
  const entry = id ? await loadEntry(id) : null;
  if (!entry) { showError('Video unavailable.'); return; }
  if (entry.thumb) video.poster = entry.thumb;

  const hlsRef = { ctrl: null };
  const settings = createSettingsMenu({
    menuEl: settingsMenuEl, video,
    hlsController: { setLevel: (i) => hlsRef.ctrl && hlsRef.ctrl.setLevel(i) },
  });

  let storyboard = null;
  if (entry.storyboard) storyboard = await loadStoryboard(entry.storyboard);
  if (Array.isArray(entry.qualityLevels) && entry.qualityLevels.length) {
    hlsRef.ctrl = createMp4QualityController(video, entry.qualityLevels, {
      onLevels: (l) => settings.setLevels(l),
      onAutoLevel: (h, a) => settings.setAutoLevel(h, a),
      onError: (m) => showError(m),
    });
  } else if (entry.preview) {
    video.src = entry.preview;
    video.addEventListener('error', () => showError('This video could not be played.'));
    settings.setLevels([]);
  } else {
    showError('This video is unavailable.');
    return;
  }

  createControls({ video, container, els, onToggleSettings: () => settings.toggle() });
  createProgressBar({ video, els, storyboard });
  container.addEventListener('click', (e) => {
    if (settings.isOpen() && !settingsMenuEl.contains(e.target) && e.target !== els.settingsBtn) settings.close();
  });
  attachKeyboard(container, {
    togglePlay: () => { if (video.paused) video.play(); else video.pause(); },
    toggleMute: () => { video.muted = !video.muted; },
    seekBy: (d) => { video.currentTime = Math.min(video.duration || 0, Math.max(0, video.currentTime + d)); },
    volumeBy: (d) => { video.muted = false; video.volume = Math.min(1, Math.max(0, video.volume + d)); },
    seekToPercent: (p) => { if (video.duration) video.currentTime = p * video.duration; },
    seekToEnd: () => { if (video.duration) video.currentTime = video.duration; },
    frameStep: (dir) => { if (!video.paused) video.pause(); video.currentTime += dir / FPS; },
    speedStep: (dir) => { video.playbackRate = nextRate(video.playbackRate, dir); },
    toggleFullscreen: () => {
      if (document.fullscreenElement === container) document.exitFullscreen();
      else container.requestFullscreen();
    },
  });
})();
