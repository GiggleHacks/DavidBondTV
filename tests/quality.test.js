import { describe, it, expect } from 'vitest';
import { buildQualityOptions } from '../public/js/quality.js';

const levels = [
  { height: 360, bitrate: 900000 },
  { height: 720, bitrate: 3000000 },
  { height: 1080, bitrate: 5350000 },
];

describe('buildQualityOptions', () => {
  it('lists fixed levels high-to-low then Auto last', () => {
    const opts = buildQualityOptions(levels, -1, 720);
    expect(opts.map((o) => o.label)).toEqual(['1080p', '720p', '360p', 'Auto']);
  });
  it('flags HD for >= 720', () => {
    const opts = buildQualityOptions(levels, -1, 720);
    expect(opts.find((o) => o.label === '1080p').hd).toBe(true);
    expect(opts.find((o) => o.label === '720p').hd).toBe(true);
    expect(opts.find((o) => o.label === '360p').hd).toBe(false);
  });
  it('marks Auto active and shows current resolution', () => {
    const opts = buildQualityOptions(levels, -1, 720);
    const auto = opts.find((o) => o.label === 'Auto');
    expect(auto.active).toBe(true);
    expect(auto.index).toBe(-1);
    expect(auto.sublabel).toBe('720p');
  });
  it('marks a pinned level active and Auto inactive', () => {
    const opts = buildQualityOptions(levels, 2, 720); // index 2 == 1080p
    expect(opts.find((o) => o.label === '1080p').active).toBe(true);
    expect(opts.find((o) => o.label === 'Auto').active).toBe(false);
  });
  it('preserves original indices for pinning', () => {
    const opts = buildQualityOptions(levels, -1, 720);
    expect(opts.find((o) => o.label === '360p').index).toBe(0);
    expect(opts.find((o) => o.label === '1080p').index).toBe(2);
  });
});
