import { createHlsController } from './hls-controller.js';
import { createMp4QualityController } from './mp4-quality-controller.js';
import { createControls } from './controls.js';
import { createProgressBar } from './progress-bar.js';
import { createSettingsMenu } from './settings-menu.js';
import { loadStoryboard } from './storyboard.js';
import { attachKeyboard } from './keyboard.js';
import { nextRate } from './playback.js';
import { initTheme } from './theme.js';
import { initComments } from './comments.js';
import { initReactions } from './reactions.js';
import { initWatchTracker } from './watch-tracker.js';

const $ = (id) => document.getElementById(id);
const FPS = 30000 / 1001; // source frame rate (~29.97)

/** Read the video id from /watch?v=<id>. */
function getVideoId() {
  return new URLSearchParams(window.location.search).get('v') || '';
}

/** True if the signed-in viewer may watch premium content (admin OR active member). */
async function viewerCanWatchPremium() {
  try {
    const me = (await (await fetch('/api/auth/me')).json()).user;
    if (!me) return false;
    if (Array.isArray(me.roles) && me.roles.includes('admin')) return true;
    return !!(me.membership && me.membership.active);
  } catch {
    return false;
  }
}

// Polished gold padlock used on the premium teaser. `sfx` keeps gradient ids
// unique when more than one instance can render on a page.
const PREMIUM_LOCK = (sfx) => `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <defs><linearGradient id="lk-${sfx}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe7a3"/><stop offset="1" stop-color="#f4a300"/></linearGradient></defs>
  <path d="M16 22v-5a8 8 0 0 1 16 0v5" stroke="url(#lk-${sfx})" stroke-width="3.6" stroke-linecap="round"/>
  <rect x="9.5" y="21.5" width="29" height="20" rx="5.5" fill="url(#lk-${sfx})"/>
  <circle cx="24" cy="29.5" r="3.2" fill="#3a2600"/><rect x="22.5" y="30.5" width="3" height="6.5" rx="1.5" fill="#3a2600"/>
</svg>`;

/**
 * Route a viewer who wants to unlock premium content. Logged-in → straight to the
 * membership offer; logged-out → sign up first, then land back on the offer (which
 * carries `next` back to the original video). Stashes the post-auth destination so
 * the email-verify / profile-setup onboarding chain returns here too.
 */
async function goToUnlock(videoUrl) {
  const membershipUrl = `/membership.html?next=${encodeURIComponent(videoUrl)}`;
  let me = null;
  try { me = (await (await fetch('/api/auth/me')).json()).user; } catch { /* treat as logged out */ }
  if (me) { location.href = membershipUrl; return; }
  try { localStorage.setItem('dbtv_after_auth', membershipUrl); } catch { /* ignore */ }
  location.href = `/signup.html?next=${encodeURIComponent(membershipUrl)}`;
}

/** Replace the player surface with a premium teaser + unlock prompt. */
function showPremiumGate(container, entry) {
  const spinner = document.getElementById('spinner');
  const bigPlay = document.getElementById('big-play');
  if (spinner) spinner.hidden = true;
  if (bigPlay) bigPlay.style.display = 'none';
  const gate = document.createElement('div');
  gate.className = 'premium-gate';
  if (entry.thumb) gate.style.backgroundImage = `url("${entry.thumb}")`;
  gate.innerHTML = `
    <div class="pg-inner">
      <span class="pg-badge">★ Members only</span>
      <div class="pg-lock">${PREMIUM_LOCK('pg')}</div>
      <h2>You're one tap from the good stuff</h2>
      <p>Unlock this video — and the entire David Bond TV exclusive library — the moment you join. New drops first, no ads, cancel anytime.</p>
      <button class="pg-sub gold-cta">Unlock Now</button>
      <a class="pg-alt" href="#">Already a member? Sign in</a>
    </div>`;
  container.appendChild(gate);
  const videoUrl = location.pathname + location.search;
  const membershipUrl = `/membership.html?next=${encodeURIComponent(videoUrl)}`;
  gate.querySelector('.pg-sub').addEventListener('click', () => goToUnlock(videoUrl));
  gate.querySelector('.pg-alt').addEventListener('click', (e) => {
    e.preventDefault();
    location.href = `/login.html?next=${encodeURIComponent(membershipUrl)}`;
  });
}

/** Look up a video's manifest entry by id. */
async function loadEntry(id) {
  try {
    const res = await fetch('/thumbs/videos.json');
    const videos = await res.json();
    return videos.find((v) => v.id === id) || null;
  } catch {
    return null;
  }
}

async function init() {
  // Apply the saved theme before anything paints (avoids a flash of the default).
  initTheme();

  const video = $('video');
  const container = $('player');
  video.muted = false; // start with sound; the user clicked through to watch

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

  function showError(message) {
    errorMsg.textContent = message;
    errorOverlay.hidden = false;
    spinner.hidden = true;
  }
  retryBtn.addEventListener('click', () => { errorOverlay.hidden = true; location.reload(); });

  // Resolve which video to play + its metadata.
  const videoId = getVideoId();
  const entry = videoId ? await loadEntry(videoId) : null;
  // No such video (empty/bad ?v=, or the record was removed). There is no demo
  // stream to fall back to, so return the viewer to the homepage grid.
  if (!entry) { location.replace('/'); return; }
  const commentVideo = entry.id;

  // Is this a premium video the current viewer can't watch? If so we keep the
  // page generic (no title/description/edu hints) so the locked "Unlock Now"
  // screen never reveals what's behind the paywall.
  const locked = entry.visibility === 'premium' && !(await viewerCanWatchPremium());

  // Fill the meta row (generic for a locked premium video).
  $('v-title').textContent = locked ? 'Members-only video' : (entry.title || 'David Bond TV');
  $('v-desc').textContent = locked ? '' : (entry.description || '');
  $('v-date').textContent = (!locked && entry.uploaded) ? entry.uploaded : '';
  document.title = locked
    ? 'Members only — David Bond TV'
    : (entry.title ? `${entry.title} — David Bond TV` : 'David Bond TV');

  // Educational disclaimer for hacking / cybersecurity content. Shows when the
  // admin flags the video (entry.educational) or its category/title mentions
  // cyber-security / hacking. Rendered once, just under the description. Skipped
  // when locked (it would otherwise hint at the hidden video's topic).
  const eduRe = /cyber|hack|security|infosec|pentest/i;
  const isEdu = !locked && entry && (entry.educational === true
    || eduRe.test(entry.category || '') || eduRe.test(entry.title || ''));
  if (isEdu && !document.getElementById('v-edu-note')) {
    const note = document.createElement('p');
    note.id = 'v-edu-note';
    note.className = 'v-edu-note';
    note.innerHTML = '<strong>For educational purposes only.</strong> '
      + 'This cybersecurity content is provided for education and awareness — '
      + 'not an endorsement of, or instruction to carry out, any unlawful activity. '
      + 'See our <a href="/terms">Terms</a>.';
    const desc = $('v-desc');
    desc.parentNode.insertBefore(note, desc.nextSibling);
  }

  // Poster = this video's own thumbnail (grabbed from the same clip), so the
  // freeze-frame shown before playback matches the content.
  if (entry.thumb) video.poster = entry.thumb;

  // Premium gate: exclusive videos play for admins only; everyone else sees a
  // lock + subscribe prompt instead of the stream (the server 403s the media too).
  if (locked) {
    showPremiumGate(container, entry);
    initReactions(commentVideo);
    initComments(commentVideo);
    return;
  }

  // hls.js controller is created lazily; the settings menu reaches it via this ref.
  const hlsRef = { ctrl: null };
  const settings = createSettingsMenu({
    menuEl: settingsMenuEl,
    video,
    hlsController: { setLevel: (i) => hlsRef.ctrl && hlsRef.ctrl.setLevel(i) },
  });

  // Choose the source: a real HLS stream if the entry has one, otherwise play the
  // per-video preview MP4 natively. If the entry has no playable rendition yet
  // (still processing, or processing failed) we show a clear message — there is
  // no demo stream to fall back to.
  let storyboard = null;
  if (entry && entry.storyboard) storyboard = await loadStoryboard(entry.storyboard);
  if (entry && entry.hls) {
    hlsRef.ctrl = createHlsController(video, entry.hls, {
      onLevels: (levels) => settings.setLevels(levels),
      onAutoLevel: (h, auto) => settings.setAutoLevel(h, auto),
      onError: (msg) => showError(msg),
    });
  } else if (entry && Array.isArray(entry.qualityLevels) && entry.qualityLevels.length) {
    // Real per-video renditions (Low/Medium/High) served as discrete MP4s.
    hlsRef.ctrl = createMp4QualityController(video, entry.qualityLevels, {
      onLevels: (levels) => settings.setLevels(levels),
      onAutoLevel: (h, auto) => settings.setAutoLevel(h, auto),
      onError: (msg) => showError(msg),
    });
  } else if (entry && entry.preview) {
    video.src = entry.preview; // native MP4 playback (no adaptive levels)
    video.addEventListener('error', () => showError('This video could not be played.'));
    settings.setLevels([]); // hide the quality menu — single quality
  } else {
    // Entry exists but has no playable rendition — still encoding, or encoding
    // failed. No demo fallback; tell the viewer plainly.
    showError(entry.status === 'processing'
      ? 'This video is still processing. Check back soon.'
      : 'This video is currently unavailable.');
  }

  createControls({ video, container, els, onToggleSettings: () => settings.toggle() });
  createProgressBar({ video, els, storyboard });

  // Close settings menu when clicking elsewhere in the player
  container.addEventListener('click', (e) => {
    if (settings.isOpen() && !settingsMenuEl.contains(e.target) && e.target !== els.settingsBtn) {
      settings.close();
    }
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

  // Per-video social features
  initReactions(commentVideo);
  initComments(commentVideo);

  // Watch-time analytics (only for real manifest videos, not the legacy demo).
  if (entry) initWatchTracker(video, entry.id);

  // Admin-only creator controls (YouTube-style) in the meta row: Analytics + Edit.
  if (await viewerIsAdmin()) {
    const sub = document.querySelector('.v-subrow');
    if (sub && !sub.querySelector('.creator-controls')) {
      const grp = document.createElement('div');
      grp.className = 'creator-controls';
      const vid = encodeURIComponent(entry.id);
      grp.innerHTML = `
        <a class="creator-btn" href="/god-analytics.html?v=${vid}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13h4v8H3zM10 3h4v18h-4zM17 9h4v12h-4z"/></svg>Analytics</a>
        <a class="creator-btn primary" href="/god-edit.html?v=${vid}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>Edit video</a>`;
      sub.appendChild(grp);
    }
  }

  container.focus();
}

init();
