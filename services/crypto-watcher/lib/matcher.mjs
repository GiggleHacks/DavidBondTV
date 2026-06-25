// Pure decision: given a watch (baseline + expected, in base units) and the
// current total received (base units) at the required confirmations, decide
// whether the order is satisfied. Overpay confirms; a nonzero-but-short delta is
// "underpaid" (surfaced for manual handling); zero delta stays "waiting".
// A delta below half the expected amount is treated as noise / not yet a real
// payment signal and stays "waiting"; a partial-but-meaningful delta is "underpaid".
export function matchReceived(watch, currentReceivedBaseUnits) {
  const delta = currentReceivedBaseUnits - watch.baselineBaseUnits;
  if (delta >= watch.expectedBaseUnits) return { matched: true, status: 'confirmed' };
  if (delta >= watch.expectedBaseUnits / 2n + 1n) return { matched: false, status: 'underpaid' };
  return { matched: false, status: 'waiting' };
}
