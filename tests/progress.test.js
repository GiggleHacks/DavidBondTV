import { describe, it, expect } from 'vitest';
import { makeProgressScanner, hmsToSec } from '../lib/media.mjs';
import { buildPhases, overallPct, etaFrom } from '../lib/progress-plan.mjs';

describe('hmsToSec', () => {
  it('parses HH:MM:SS.ms to seconds', () => {
    expect(hmsToSec('00:00:12.345')).toBeCloseTo(12.345, 3);
    expect(hmsToSec('01:02:03')).toBe(3723);
  });
  it('returns null for junk', () => {
    expect(hmsToSec('nope')).toBe(null);
    expect(hmsToSec('')).toBe(null);
  });
});

describe('makeProgressScanner', () => {
  it('emits one snapshot per progress block, using out_time_us', () => {
    const sc = makeProgressScanner();
    const evs = sc.push('frame=10\nout_time_us=2000000\nspeed=1.5x\nprogress=continue\n');
    expect(evs).toHaveLength(1);
    expect(evs[0].outSec).toBeCloseTo(2, 6);
    expect(evs[0].speed).toBeCloseTo(1.5, 6);
    expect(evs[0].done).toBe(false);
  });

  it('flags the terminal block as done', () => {
    const sc = makeProgressScanner();
    const evs = sc.push('out_time=00:00:30.000\nprogress=end\n');
    expect(evs).toHaveLength(1);
    expect(evs[0].outSec).toBeCloseTo(30, 6);
    expect(evs[0].done).toBe(true);
  });

  it('handles chunk boundaries split mid-line', () => {
    const sc = makeProgressScanner();
    expect(sc.push('out_time_us=10000')).toHaveLength(0); // no progress= yet
    const evs = sc.push('00\nprogress=continue\n');
    expect(evs).toHaveLength(1);
    expect(evs[0].outSec).toBeCloseTo(1, 6); // 1_000_000 us
  });

  it('ignores blocks with no time', () => {
    const sc = makeProgressScanner();
    expect(sc.push('progress=continue\n')).toHaveLength(0);
  });
});

describe('buildPhases', () => {
  const tiers = [
    { name: '720p', height: 720, vbitrate: '2800k' },
    { name: '360p', height: 360, vbitrate: '800k' },
  ];

  it('lists fixed phases then one encode phase per tier', () => {
    const phases = buildPhases(tiers, 'libx264 CPU');
    expect(phases.map((p) => p.key)).toEqual([
      'probe', 'thumbs', 'preview', 'storyboard', 'enc-720p', 'enc-360p',
    ]);
    expect(phases.find((p) => p.key === 'enc-720p').label).toContain('720p');
    expect(phases.find((p) => p.key === 'enc-720p').label).toContain('libx264 CPU');
  });

  it('weights taller encodes more than shorter ones', () => {
    const phases = buildPhases(tiers, 'NVENC GPU');
    const w720 = phases.find((p) => p.key === 'enc-720p').weight;
    const w360 = phases.find((p) => p.key === 'enc-360p').weight;
    expect(w720).toBeGreaterThan(w360);
  });
});

describe('overallPct', () => {
  const phases = buildPhases([
    { name: '720p', height: 720, vbitrate: '2800k' },
    { name: '360p', height: 360, vbitrate: '800k' },
  ], 'libx264 CPU');

  it('is 0 at the first phase start and rises monotonically across phases', () => {
    expect(overallPct(phases, 0, 0)).toBeCloseTo(0, 5);
    const atThumbsStart = overallPct(phases, 1, 0);
    const atPreviewStart = overallPct(phases, 2, 0);
    expect(atPreviewStart).toBeGreaterThan(atThumbsStart);
  });

  it('reaches 100 at the end of the last phase', () => {
    expect(overallPct(phases, phases.length - 1, 1)).toBeCloseTo(100, 5);
  });

  it('clamps fraction to [0,1]', () => {
    const a = overallPct(phases, 2, 5);
    const b = overallPct(phases, 2, 1);
    expect(a).toBeCloseTo(b, 5);
  });
});

describe('etaFrom', () => {
  it('returns null before there is enough signal', () => {
    expect(etaFrom(0, 50)).toBe(null);
    expect(etaFrom(10, 1)).toBe(null); // <2%
    expect(etaFrom(10, 100)).toBe(null); // done
  });
  it('estimates remaining time from elapsed and pct', () => {
    // 10s elapsed at 25% → ~30s remaining.
    expect(etaFrom(10, 25)).toBe(30);
  });
});
