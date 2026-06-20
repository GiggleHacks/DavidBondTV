export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function nextRate(current, dir) {
  let i = PLAYBACK_RATES.indexOf(current);
  if (i === -1) i = PLAYBACK_RATES.indexOf(1);
  const next = Math.min(PLAYBACK_RATES.length - 1, Math.max(0, i + dir));
  return PLAYBACK_RATES[next];
}

export function rateLabel(rate) {
  return rate === 1 ? 'Normal' : String(rate);
}
