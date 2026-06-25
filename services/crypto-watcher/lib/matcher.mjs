// Pure decision: given a watch (baseline + expected, in base units) and the
// current total received (base units) at the required confirmations, decide
// whether the order is satisfied. Overpay confirms; ANY positive-but-short delta
// is "underpaid" (surfaced for manual handling); only a zero/negative delta
// stays "waiting".
export function matchReceived(watch, currentReceivedBaseUnits) {
  const delta = currentReceivedBaseUnits - watch.baselineBaseUnits;
  if (delta <= 0n) return { matched: false, status: 'waiting' };
  if (delta >= watch.expectedBaseUnits) return { matched: true, status: 'confirmed' };
  return { matched: false, status: 'underpaid' };
}
