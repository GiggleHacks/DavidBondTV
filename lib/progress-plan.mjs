// Pure helpers for the server-side ingest progress model. No I/O — these compute
// the weighted overall percentage and ETA that the upload UI renders, and are
// unit-tested directly (lib/media.mjs does the real ffmpeg streaming).

// Fixed pipeline phases and their share of the overall bar. The encode phases
// share ENC_POOL, split proportionally to tier height so a 720p encode (the
// slow part) counts for more than a 360p one. Weights need not sum to exactly 1
// — overallPct() normalises by the actual total.
const FIXED = [
  { key: 'probe', label: 'Reading video info (ffprobe)', weight: 0.03 },
  { key: 'thumbs', label: 'Generating thumbnails', weight: 0.10 },
  { key: 'preview', label: 'Building hover preview (H.264)', weight: 0.12 },
  { key: 'storyboard', label: 'Building scrub storyboard sprites', weight: 0.10 },
];
const ENC_POOL = 0.65;

/**
 * Build the ordered phase list for a set of quality tiers. `encoderLabel` is a
 * human string like "NVENC GPU" or "libx264 CPU" shown in the active-task label.
 * Returns [{ key, label, detail, weight }, ...].
 */
export function buildPhases(tiers, encoderLabel = 'libx264 CPU') {
  const list = Array.isArray(tiers) ? tiers : [];
  const hSum = list.reduce((s, t) => s + (t.height || 1), 0) || 1;
  const encs = list.map((t) => ({
    key: `enc-${t.name}`,
    label: `Compressing video → ${t.name} (${encoderLabel})`,
    detail: `${t.vbitrate} · ${t.height}p · H.264`,
    weight: ENC_POOL * ((t.height || 1) / hSum),
  }));
  return [...FIXED.map((p) => ({ ...p })), ...encs];
}

/**
 * Overall completion percentage (0–100): all phases before `activeIndex` count
 * as fully done, plus `fraction` (0–1) of the active phase's weight.
 */
export function overallPct(phases, activeIndex, fraction = 0) {
  const arr = Array.isArray(phases) ? phases : [];
  const total = arr.reduce((s, p) => s + (p.weight || 0), 0) || 1;
  const before = arr.slice(0, Math.max(0, activeIndex)).reduce((s, p) => s + (p.weight || 0), 0);
  const cur = arr[activeIndex];
  const f = Math.max(0, Math.min(1, fraction));
  const w = before + (cur ? (cur.weight || 0) * f : 0);
  return Math.max(0, Math.min(100, (w / total) * 100));
}

/**
 * Estimate seconds remaining from elapsed wall time and overall pct, assuming
 * roughly uniform throughput. Returns null until there's enough signal (>2%).
 */
export function etaFrom(elapsedSec, pct) {
  const frac = pct / 100;
  if (!(elapsedSec > 0) || frac <= 0.02 || frac >= 1) return null;
  return Math.max(0, Math.round(elapsedSec / frac - elapsedSec));
}
