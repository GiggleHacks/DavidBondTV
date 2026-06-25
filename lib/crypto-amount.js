// Exact decimal<->base-unit conversion using BigInt (never floats) so the amount
// shown to the buyer and the amount matched on-chain agree to the last digit.

export function toBaseUnits(decimalStr, decimals) {
  const [whole, frac = ''] = String(decimalStr).split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt((whole || '0') + fracPadded);
}

export function fromBaseUnits(units, decimals) {
  const s = units.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Convert a fiat amount to a unique coin amount.
 *  - base = ceil(usd / rate) at `decimals` precision (round UP so we never undercharge)
 *  - jitter adds 0..jitterMax base units so two open orders never collide
 * Returns { amount: string, baseUnits: bigint }.
 */
export function uniqueAmount({ usd, rate, decimals, jitter = 0 }) {
  if (!(rate > 0)) throw new Error('rate must be > 0');
  // Guard the float step below: at >15 decimals (usd/rate)*scale exceeds the
  // 2^53 safe-integer range and could silently undercharge. All coins here use
  // ≤12 display decimals; refuse anything that could lose precision.
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 15) {
    throw new Error(`uniqueAmount: decimals ${decimals} outside float-safe range (0–15)`);
  }
  const scale = 10 ** decimals;
  const baseUnitsNum = Math.ceil((usd / rate) * scale);
  const baseUnits = BigInt(baseUnitsNum) + BigInt(jitter);
  return { amount: fromBaseUnits(baseUnits, decimals), baseUnits };
}
