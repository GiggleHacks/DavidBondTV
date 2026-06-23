// Synthesized upload notification sounds (Web Audio API — no audio files).
// Each sound is a recipe of oscillator notes + gain envelopes scheduled on a
// shared AudioContext. Selection + on/off persist per-admin in localStorage.

const LS_SOUND = 'dbtv_upload_sound';
const LS_ON = 'dbtv_upload_sound_on';

let ctx = null;
function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  // Browsers suspend the context until a user gesture; resume on demand.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Schedule a single tone. type: oscillator waveform; t0 offset in seconds from now;
// dur seconds; peak gain; optional end frequency for a glide.
function tone(c, { freq, t0 = 0, dur = 0.18, type = 'sine', gain = 0.18, freqEnd }) {
  const start = c.currentTime + t0;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, start + dur);
  // Quick attack, smooth exponential decay — avoids clicks.
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g).connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

// Play a sequence of notes (each note merges with the shared defaults).
function seq(c, notes, base = {}) {
  for (const n of notes) tone(c, { ...base, ...n });
}

// --- Sound library (12 distinct recipes) ---
const SOUNDS = [
  { id: 'chime', name: '🔔 Chime', play: (c) => seq(c, [
      { freq: 880, t0: 0, dur: 0.5, type: 'sine', gain: 0.2 },
      { freq: 1320, t0: 0.04, dur: 0.55, type: 'sine', gain: 0.12 },
    ]) },
  { id: 'ding', name: '🛎️ Ding', play: (c) => seq(c, [
      { freq: 1568, dur: 0.6, type: 'triangle', gain: 0.22 },
    ]) },
  { id: 'bloop', name: '💧 Bloop', play: (c) => seq(c, [
      { freq: 320, dur: 0.22, type: 'sine', gain: 0.28, freqEnd: 760 },
    ]) },
  { id: 'arpUp', name: '🎶 Arpeggio Up', play: (c) => seq(c, [
      { freq: 523, t0: 0 }, { freq: 659, t0: 0.09 },
      { freq: 784, t0: 0.18 }, { freq: 1047, t0: 0.27, dur: 0.3 },
    ], { type: 'triangle', dur: 0.16, gain: 0.18 }) },
  { id: 'successTrio', name: '✅ Success Trio', play: (c) => seq(c, [
      { freq: 659, t0: 0 }, { freq: 880, t0: 0.12 },
      { freq: 1175, t0: 0.24, dur: 0.4 },
    ], { type: 'sine', dur: 0.18, gain: 0.2 }) },
  { id: 'coin', name: '🪙 Coin', play: (c) => seq(c, [
      { freq: 988, t0: 0, dur: 0.08, type: 'square', gain: 0.16 },
      { freq: 1319, t0: 0.08, dur: 0.35, type: 'square', gain: 0.16 },
    ]) },
  { id: 'marimba', name: '🎵 Marimba', play: (c) => seq(c, [
      { freq: 587, t0: 0 }, { freq: 880, t0: 0.1 }, { freq: 1175, t0: 0.2, dur: 0.5 },
    ], { type: 'sine', dur: 0.4, gain: 0.22 }) },
  { id: 'bell', name: '🔕 Bell', play: (c) => seq(c, [
      { freq: 1047, dur: 0.9, type: 'sine', gain: 0.2 },
      { freq: 2093, t0: 0.01, dur: 0.5, type: 'sine', gain: 0.06 },
    ]) },
  { id: 'pop', name: '🎈 Pop', play: (c) => seq(c, [
      { freq: 440, dur: 0.12, type: 'sine', gain: 0.3, freqEnd: 1200 },
    ]) },
  { id: 'laser', name: '🛸 Laser Zap', play: (c) => seq(c, [
      { freq: 1800, dur: 0.3, type: 'sawtooth', gain: 0.16, freqEnd: 220 },
    ]) },
  { id: 'softPad', name: '🌙 Soft Pad', play: (c) => seq(c, [
      { freq: 392, dur: 0.9, type: 'sine', gain: 0.16 },
      { freq: 587, t0: 0.05, dur: 0.9, type: 'sine', gain: 0.12 },
      { freq: 784, t0: 0.1, dur: 0.9, type: 'sine', gain: 0.08 },
    ]) },
  { id: 'fanfare', name: '🎺 Retro Fanfare', play: (c) => seq(c, [
      { freq: 523, t0: 0, dur: 0.12 }, { freq: 523, t0: 0.13, dur: 0.12 },
      { freq: 523, t0: 0.26, dur: 0.12 }, { freq: 698, t0: 0.4, dur: 0.5 },
    ], { type: 'square', gain: 0.16 }) },
];

const byId = new Map(SOUNDS.map((s) => [s.id, s]));
const DEFAULT_ID = 'chime';

export function listSounds() {
  return SOUNDS.map(({ id, name }) => ({ id, name }));
}

export function getSelected() {
  try {
    const v = localStorage.getItem(LS_SOUND);
    if (v && byId.has(v)) return v;
  } catch { /* ignore */ }
  return DEFAULT_ID;
}

export function setSelected(id) {
  if (!byId.has(id)) return;
  try { localStorage.setItem(LS_SOUND, id); } catch { /* ignore */ }
}

export function isEnabled() {
  try { return localStorage.getItem(LS_ON) !== '0'; } catch { return true; }
}

export function setEnabled(on) {
  try { localStorage.setItem(LS_ON, on ? '1' : '0'); } catch { /* ignore */ }
}

// Play a sound by id (defaults to current selection). Safe to call anytime —
// no-ops if Web Audio is unavailable.
export function playSound(id = getSelected()) {
  const c = ac();
  const s = byId.get(id) || byId.get(DEFAULT_ID);
  if (!c || !s) return;
  try { s.play(c); } catch { /* ignore */ }
}

// Resume the AudioContext on a user gesture so later programmatic plays work.
export function primeAudio() { ac(); }
