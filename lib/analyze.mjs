// Local, offline content analyzer for a video file → { title, description }.
// Zero-dependency: signal collection only spawns ffmpeg/ffprobe (and optionally
// a whisper binary, off by default). The composition layer is pure and unit-
// tested. Designed for DJI drone clips that are usually silent, so the real
// signal is visual + metadata; speech transcript is lowest-trust and optional.
import { run, probeDurationAsync } from './media.mjs';

// ----------------------------------------------------------------------------
// Pure helpers (no IO — covered by test/analyze.test.js)
// ----------------------------------------------------------------------------

/** Deterministic 32-bit FNV-1a hash of a string (stable across runs). */
export function hashId(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Parse a DJI filename id → { date, seq } or null. */
export function parseDjiName(id) {
  const m = /DJI_(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)_(\d+)_/.exec(id || '');
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S, seq] = m;
  const date = new Date(Number(Y), Number(Mo) - 1, Number(D), Number(H), Number(Mi), Number(S));
  if (Number.isNaN(date.getTime())) return null;
  return { date, seq: Number(seq) };
}

/** Map an hour (0-23) to a coarse time-of-day bucket. */
export function timeOfDayBucket(h) {
  if (h < 5) return 'Night';
  if (h < 11) return 'Morning';
  if (h < 16) return 'Afternoon';
  if (h < 19) return 'Golden-Hour';
  if (h < 22) return 'Evening';
  return 'Night';
}

/** Classify averaged visual stats into descriptive buckets. */
export function classifyVisual(v) {
  const { brightness = 120, saturation = 40, hue = 0, sceneRate = 0.1 } = v || {};

  let light;
  if (brightness < 40) light = 'night';
  else if (brightness < 95) light = 'lowlight';
  else if (brightness < 160) light = 'soft';
  else light = 'bright';

  const muted = saturation < 25;
  const vivid = saturation > 70;

  // Only name a colour when there's enough saturation for hue to be meaningful.
  let color = null;
  if (!muted) {
    const h = ((hue % 360) + 360) % 360;
    if (h >= 40 && h < 70) color = 'golden';
    else if (h >= 70 && h < 170) color = 'green';
    else if (h >= 170 && h < 260) color = 'blue';
    else if (h >= 260 && h < 320) color = 'violet';
    else color = 'red';
  }

  let motion;
  if (sceneRate > 0.25) motion = 'dynamic';
  else if (sceneRate >= 0.08) motion = 'lively';
  else motion = 'calm';

  return { light, muted, vivid, color, motion };
}

const pick = (arr, hash) => arr[hash % arr.length];

/**
 * A single evocative "vibe" word from the visual classification. `hash` rotates
 * through honest synonyms so a batch of similar clips doesn't read identically.
 * (Default hash=0 → the first, canonical word.)
 */
export function vibeWord(c, hash = 0) {
  if (c.light === 'night') return c.vivid ? pick(['Neon-Lit', 'City-Lights', 'Glowing'], hash) : pick(['Nighttime', 'Moonlit', 'After-Dark'], hash);
  if (c.light === 'lowlight') return pick(['Indoor', 'Dim', 'Low-Light', 'Shaded'], hash);
  if (c.color === 'golden') return pick(['Golden', 'Sun-Kissed', 'Amber'], hash);
  if (c.color === 'green') return pick(['Lush', 'Verdant', 'Leafy'], hash);
  if (c.color === 'violet') return pick(['Pastel', 'Lilac', 'Dusky'], hash);
  if (c.color === 'red') return pick(['Warm', 'Crimson', 'Sunset'], hash);
  if (c.color === 'blue') return c.light === 'bright' ? pick(['Open-Sky', 'Azure', 'Clear-Sky'], hash) : pick(['Cool-Toned', 'Cool-Blue', 'Steel'], hash);
  return c.light === 'bright' ? pick(['Bright', 'Sun-Soaked', 'Wide-Open'], hash) : pick(['Soft', 'Hazy', 'Mellow', 'Muted'], hash);
}

const MOTION_WORD = { dynamic: 'Flythrough', lively: 'Roaming', calm: 'Drifting' };
const MOTION_ADJ = { dynamic: 'sweeping', lively: 'roaming', calm: 'drifting' };

/** A short phrase describing the dominant tones, for the description sentence. */
export function vibePhrase(c) {
  if (c.light === 'night') return c.vivid ? 'glowing city-light' : 'moody nighttime';
  if (c.light === 'lowlight') return 'cozy indoor';
  if (c.color === 'golden') return 'warm golden';
  if (c.color === 'green') return 'lush green';
  if (c.color === 'violet') return 'soft pastel';
  if (c.color === 'red') return 'warm, saturated';
  if (c.color === 'blue') return c.light === 'bright' ? 'bright, open-sky' : 'cool blue';
  return c.light === 'bright' ? 'bright, open-sky' : 'soft, natural';
}

const STOPWORDS = new Set(('a an the and or but if then else of to in on at for from with by as is are was were ' +
  'be been being it its this that these those i you he she we they me him her us them my your our their ' +
  'so just like really very okay ok yeah yes no not do does did done can could will would should shall ' +
  'have has had get got go going gonna wanna im ive id ill its theyre were here there what when where ' +
  'who how why all out up down over about into your youre').split(/\s+/));

const HALLUCINATIONS = [
  /thank you/i, /thanks for watching/i, /please subscribe/i, /subscribe/i,
  /like and subscribe/i, /see you next time/i, /\[music\]/i, /\bbye bye\b/i,
];

/** Frequency-ranked content keywords from free text (stopwords removed). */
export function extractKeywords(text) {
  if (!text || typeof text !== 'string') return [];
  const words = text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
  const freq = new Map();
  for (const w of words) {
    const k = w.replace(/'/g, '');
    if (STOPWORDS.has(k) || k.length < 3) continue;
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map((e) => e[0]);
}

/** Whether a transcript is trustworthy enough to title from (anti-hallucination). */
export function transcriptUsable(text) {
  if (!text || typeof text !== 'string') return false;
  const words = text.toLowerCase().match(/[a-z']+/g) || [];
  if (words.length < 12) return false;
  for (const re of HALLUCINATIONS) if (re.test(text)) return false;
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  const max = Math.max(...freq.values());
  if (max / words.length > 0.4) return false; // one token dominates → garbage
  return true;
}

/** First sentence of a transcript, trimmed to a tidy length. */
export function firstSentence(text, maxLen = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const m = /^(.+?[.!?])(\s|$)/.exec(clean);
  let s = m ? m[1] : clean;
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).replace(/\s+\S*$/, '') + '…';
  return s;
}

const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);
const monthDay = (d) => (d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
const fullDate = (d) => (d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '');

/** Subject noun phrase, varied by hash / duration / location. */
function subjectWord(f) {
  if (f.duration && f.duration > 0 && f.duration < 8) return 'Quick Aerial';
  if (f.hasLocation) return 'On-Location Aerial';
  return ['Aerial', 'Drone', "Bird's-Eye"][f.hash % 3];
}

/**
 * Assemble a deterministic, non-empty title from a features object.
 * Prefers a transcript-derived title when speech is trustworthy.
 */
export function composeTitle(f) {
  const md = monthDay(f.date);

  if (f.usableTranscript && f.keywords && f.keywords.length) {
    const kw = f.keywords.slice(0, 3).map(cap).join(' ');
    if (kw) return md ? `${kw} — ${md}` : kw;
  }

  const c = f.visual;
  const vibe = vibeWord(c, f.hash);
  const motion = MOTION_WORD[c.motion];
  const subject = subjectWord(f);
  const tod = timeOfDayBucket(f.hour);

  const templates = md
    ? [
        `${vibe} ${subject} ${motion} — ${md}`,
        `${tod} ${vibe} Flyover (${md})`,
        `${subject} ${motion}: ${vibe} ${tod} Skies`,
        `${vibe} Views from Above · ${md}`,
      ]
    : [
        `${vibe} ${subject} ${motion}`,
        `${tod} ${vibe} Flyover`,
        `${subject} ${motion}: ${vibe} ${tod} Skies`,
        `${vibe} Views from Above`,
      ];

  const title = templates[f.hash % templates.length];
  return title || `Untitled clip${md ? ` — ${md}` : ''}`;
}

/** Assemble a one-sentence description from a features object. */
export function composeDescription(f) {
  if (f.usableTranscript && f.transcriptSentence) return f.transcriptSentence;

  const c = f.visual;
  const adj = MOTION_ADJ[c.motion];
  const tod = timeOfDayBucket(f.hour).toLowerCase().replace('-', ' ');
  const phrase = vibePhrase(c);
  const fd = fullDate(f.date);
  const where = f.hasLocation ? ' on location' : '';
  return `A ${adj} aerial view captured${where} in the ${tod}, full of ${phrase} tones.` +
    (fd ? ` Filmed ${fd}.` : '');
}

/**
 * Combine raw signals into the features object consumed by the composers.
 * `mtime` (ms) is used only when the filename has no embedded timestamp.
 */
export function buildFeatures({ id, mtime, meta = {}, visual = {}, transcript = '' }) {
  const parsed = parseDjiName(id);
  let date = parsed ? parsed.date : null;
  if (!date && meta.creationTime) {
    const d = new Date(meta.creationTime);
    if (!Number.isNaN(d.getTime())) date = d;
  }
  if (!date && mtime) {
    const d = new Date(mtime);
    if (!Number.isNaN(d.getTime())) date = d;
  }

  const hash = hashId(id || '');
  const seq = parsed ? parsed.seq : hash % 1000;
  const hour = date ? date.getHours() : hash % 24;

  const usable = transcriptUsable(transcript);

  return {
    id,
    hash,
    seq,
    date,
    hour,
    visual: classifyVisual(visual),
    duration: meta.duration || 0,
    hasLocation: !!meta.hasLocation,
    usableTranscript: usable,
    keywords: usable ? extractKeywords(transcript).slice(0, 6) : [],
    transcriptSentence: usable ? firstSentence(transcript) : '',
  };
}

/**
 * Append a natural disambiguator when a generated title collides with one
 * already taken. `disambig` should be a short, honest string (e.g. the capture
 * clock time "3:12 PM"); falls back to a numeric suffix if that still collides.
 */
export function ensureUniqueTitle(title, disambig, taken) {
  if (!taken || !taken.has(title)) return title;
  if (disambig) {
    const candidate = `${title} · ${disambig}`;
    if (!taken.has(candidate)) return candidate;
  }
  let n = 2;
  let candidate = `${title} (${n})`;
  while (taken.has(candidate)) candidate = `${title} (${++n})`;
  return candidate;
}

// ----------------------------------------------------------------------------
// Impure collectors (spawn ffmpeg/ffprobe/whisper; never throw)
// ----------------------------------------------------------------------------

const avg = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null);

function numMatches(text, re) {
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Circular mean of hue angles (degrees), robust across the 0/360 wrap. */
function circularMeanHue(angles) {
  if (!angles.length) return 0;
  let x = 0;
  let y = 0;
  for (const a of angles) {
    const r = (a * Math.PI) / 180;
    x += Math.cos(r);
    y += Math.sin(r);
  }
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** ffprobe: duration, creation_time tag, and whether any location tag is present. */
export async function probeMeta(file) {
  const def = { duration: 0, creationTime: null, hasLocation: false };
  try {
    const o = await run('ffprobe', ['-v', 'error', '-print_format', 'json',
      '-show_entries', 'format=duration:format_tags', file]);
    const j = JSON.parse(o.stdout || '{}');
    const fmt = j.format || {};
    const tags = fmt.tags || {};
    const lk = Object.keys(tags).map((k) => k.toLowerCase());
    const hasLocation = lk.some((k) => k.includes('location') || k.includes('iso6709') || k.includes('gps'));
    return {
      duration: parseFloat(fmt.duration) || 0,
      creationTime: tags.creation_time || null,
      hasLocation,
    };
  } catch {
    return def;
  }
}

/** ffmpeg signalstats + scene detection → averaged visual signals. */
export async function probeVisual(file, duration = 0) {
  const def = { brightness: 120, saturation: 40, hue: 0, sceneRate: 0.1 };
  try {
    const stats = await run('ffmpeg', ['-hide_banner', '-i', file, '-an',
      '-vf', 'fps=1/2,signalstats,metadata=print:file=-', '-f', 'null', '-']);
    const text = `${stats.stdout}\n${stats.stderr}`;
    const brightness = avg(numMatches(text, /signalstats\.YAVG=([-\d.]+)/g));
    const saturation = avg(numMatches(text, /signalstats\.SATAVG=([-\d.]+)/g));
    const hue = circularMeanHue(numMatches(text, /signalstats\.HUEAVG=([-\d.]+)/g));

    // Lower threshold than a hard cut: drone footage changes smoothly, so 0.1
    // captures content/camera movement and lets "calm vs dynamic" actually vary.
    const dur = duration > 0 ? duration : await probeDurationAsync(file);
    const scene = await run('ffmpeg', ['-hide_banner', '-i', file, '-an',
      '-vf', "select='gt(scene,0.1)',metadata=print:file=-", '-f', 'null', '-']);
    const sceneText = `${scene.stdout}\n${scene.stderr}`;
    const sceneCount = (sceneText.match(/scene_score=/g) || []).length;
    const sceneRate = dur > 0 ? sceneCount / dur : 0.1;

    return {
      brightness: brightness == null ? def.brightness : brightness,
      saturation: saturation == null ? def.saturation : saturation,
      hue,
      sceneRate,
    };
  } catch {
    return def;
  }
}

/** Optional speech transcript via whisper.cpp; '' unless WHISPER_BIN+WHISPER_MODEL are set. */
export async function transcribe(file) {
  const bin = process.env.WHISPER_BIN;
  const model = process.env.WHISPER_MODEL;
  if (!bin || !model) return '';
  try {
    const wav = `${file}.16k.wav`;
    const ex = await run('ffmpeg', ['-y', '-hide_banner', '-i', file,
      '-ar', '16000', '-ac', '1', '-f', 'wav', wav]);
    if (ex.status !== 0) return '';
    // whisper.cpp prints the transcript to stdout with -nt (no timestamps).
    const r = await run(bin, ['-m', model, '-f', wav, '-nt']);
    try { (await import('node:fs')).unlinkSync(wav); } catch { /* ignore */ }
    return (r.stdout || '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Full analysis of one video file → { title, description, autoGenerated }.
 * Never throws; falls back to metadata-only titles if ffmpeg is unavailable.
 */
export async function analyze(file, { id, mtime } = {}) {
  const meta = await probeMeta(file);
  const visual = await probeVisual(file, meta.duration);
  const transcript = await transcribe(file);
  const features = buildFeatures({ id, mtime, meta, visual, transcript });
  return {
    title: composeTitle(features),
    description: composeDescription(features),
    autoGenerated: true,
  };
}
