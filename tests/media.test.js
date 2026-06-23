import { describe, it, expect } from 'vitest';
import { clipWindow, variantLadder, fmtDur, encodeArgs, LIVE_PRESET } from '../lib/media.mjs';

describe('clipWindow', () => {
  it('uses the whole clip when shorter than the window', () => {
    const w = clipWindow(6, 40);
    expect(w.start).toBe(0);
    expect(w.length).toBe(6);
  });

  it('starts ~25% in for a long video and stays within bounds', () => {
    const w = clipWindow(475.43, 40); // ~8 min source
    expect(w.length).toBe(40);
    expect(w.start).toBeGreaterThan(118);
    expect(w.start).toBeLessThan(119); // ~475.43 * 0.25
    expect(w.start + w.length).toBeLessThanOrEqual(475.43);
  });

  it('never runs past the end of a medium clip', () => {
    const w = clipWindow(53.18, 40);
    expect(w.length).toBe(40);
    expect(w.start + w.length).toBeLessThanOrEqual(53.18);
  });

  it('handles a zero / invalid duration without going negative', () => {
    const w = clipWindow(0, 40);
    expect(w.start).toBe(0);
    expect(w.length).toBe(0);
  });
});

describe('variantLadder', () => {
  it('returns all tiers, highest first, for a 1080p source', () => {
    const tiers = variantLadder(1080);
    expect(tiers.map((t) => t.height)).toEqual([1080, 720, 480, 360]);
  });

  it('drops tiers taller than the source', () => {
    const tiers = variantLadder(720);
    expect(tiers.map((t) => t.height)).toEqual([720, 480, 360]);
  });

  it('always keeps at least the smallest tier for tiny sources', () => {
    const tiers = variantLadder(240);
    expect(tiers).toHaveLength(1);
    expect(tiers[0].height).toBe(360);
  });

  it('each tier carries encode + manifest fields', () => {
    for (const t of variantLadder(1080)) {
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('vbitrate');
      expect(t).toHaveProperty('maxrate');
      expect(t).toHaveProperty('bandwidth');
      expect(typeof t.bandwidth).toBe('number');
      expect(typeof t.crf).toBe('number'); // quality-based encoding
    }
  });
});

describe('encodeArgs (CRF, hardware-aware preset)', () => {
  const tier = variantLadder(480)[0]; // the 480p tier
  it('uses CRF + High profile + 96k audio + the chosen preset on the CPU path', () => {
    const a = encodeArgs('in.mp4', 'out.mp4', { start: 0, length: 10 }, tier, false);
    const s = a.join(' ');
    expect(s).toContain('libx264');
    expect(s).toContain('-profile:v high');
    expect(s).toContain(`-crf ${tier.crf}`);
    expect(s).toContain('-b:a 96k');
    expect(s).toContain(`-preset ${LIVE_PRESET}`);
    expect(s).not.toContain('-b:v'); // no fixed video bitrate on the CRF path
  });
  it('uses NVENC constant-quality on the GPU path', () => {
    const s = encodeArgs('in.mp4', 'out.mp4', { start: 0, length: 10 }, tier, true).join(' ');
    expect(s).toContain('h264_nvenc');
    expect(s).toContain('-cq');
    expect(s).toContain('-b:a 96k');
  });
  it('LIVE_PRESET is a valid libx264 preset', () => {
    expect(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']).toContain(LIVE_PRESET);
  });
});

describe('fmtDur (unchanged behaviour sanity)', () => {
  it('formats m:ss', () => {
    expect(fmtDur(40)).toBe('0:40');
    expect(fmtDur(84)).toBe('1:24');
  });
});
