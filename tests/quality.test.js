import { describe, it, expect } from 'vitest';
import { buildQualityOptions, qualityLabel } from '../public/js/quality.js';

// Current ladder: 480p, 720p — in master-playlist order.
const levels = [
  { height: 480, bitrate: 1600000 },
  { height: 720, bitrate: 3000000 },
];

describe('qualityLabel', () => {
  it('labels heights as "<h>p"', () => {
    expect(qualityLabel(480)).toBe('480p');
    expect(qualityLabel(720)).toBe('720p');
  });
});

describe('buildQualityOptions', () => {
  it('lists fixed levels high-to-low then Auto last', () => {
    const opts = buildQualityOptions(levels, -1, 720);
    expect(opts.map((o) => o.label)).toEqual(['720p', '480p', 'Auto']);
  });
  it('flags HD for >= 720 only', () => {
    const opts = buildQualityOptions(levels, -1, 720);
    expect(opts.find((o) => o.label === '720p').hd).toBe(true);
    expect(opts.find((o) => o.label === '480p').hd).toBe(false);
  });
  it('marks Auto active and shows current resolution', () => {
    const opts = buildQualityOptions(levels, -1, 720);
    const auto = opts.find((o) => o.label === 'Auto');
    expect(auto.active).toBe(true);
    expect(auto.index).toBe(-1);
    expect(auto.sublabel).toBe('720p');
  });
  it('marks a pinned level active and Auto inactive', () => {
    const opts = buildQualityOptions(levels, 1, 720); // index 1 == 720p
    expect(opts.find((o) => o.label === '720p').active).toBe(true);
    expect(opts.find((o) => o.label === 'Auto').active).toBe(false);
  });
  it('preserves original indices for pinning', () => {
    const opts = buildQualityOptions(levels, -1, 720);
    expect(opts.find((o) => o.label === '480p').index).toBe(0);
    expect(opts.find((o) => o.label === '720p').index).toBe(1);
  });
});
