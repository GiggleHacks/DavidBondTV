import { createHlsController } from './hls-controller.js';
import { createControls } from './controls.js';
import { createProgressBar } from './progress-bar.js';
import { createSettingsMenu } from './settings-menu.js';
import { loadStoryboard } from './storyboard.js';
import { attachKeyboard } from './keyboard.js';
import { nextRate } from './playback.js';

const $ = (id) => document.getElementById(id);
const MASTER = '/media/hls/master.m3u8';
const FPS = 30000 / 1001; // source frame rate (~29.97)

async function init() {
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

  // Buffering spinner
  video.addEventListener('waiting', () => { spinner.hidden = false; });
  video.addEventListener('playing', () => { spinner.hidden = true; });
  video.addEventListener('canplay', () => { spinner.hidden = true; });

  // Error overlay
  function showError(message) {
    errorMsg.textContent = message;
    errorOverlay.hidden = false;
    spinner.hidden = true;
  }
  retryBtn.addEventListener('click', () => { errorOverlay.hidden = true; location.reload(); });

  const storyboard = await loadStoryboard('/media/storyboard/storyboard.json');

  const settings = createSettingsMenu({ menuEl: settingsMenuEl, video, hlsController: { setLevel: (i) => hls.setLevel(i) } });

  const hls = createHlsController(video, MASTER, {
    onLevels: (levels) => settings.setLevels(levels),
    onAutoLevel: (height, autoEnabled) => settings.setAutoLevel(height, autoEnabled),
    onError: (msg) => showError(msg),
  });

  createControls({
    video, container, els,
    onToggleSettings: () => settings.toggle(),
  });
  createProgressBar({ video, els, storyboard });

  // Close settings menu when clicking elsewhere in the player
  container.addEventListener('click', (e) => {
    if (settings.isOpen() && !settingsMenuEl.contains(e.target) && e.target !== els.settingsBtn) {
      settings.close();
    }
  });

  // Keyboard actions
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

  // Start focused so keyboard works immediately
  container.focus();
}

init();
