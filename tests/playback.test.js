import { describe, it, expect } from 'vitest';
import { PLAYBACK_RATES, nextRate, rateLabel } from '../public/js/playback.js';

describe('playback rates', () => {
  it('exposes the YouTube rate ladder', () => {
    expect(PLAYBACK_RATES).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  });
  it('steps up from normal', () => expect(nextRate(1, 1)).toBe(1.25));
  it('steps down from normal', () => expect(nextRate(1, -1)).toBe(0.75));
  it('clamps at the top', () => expect(nextRate(2, 1)).toBe(2));
  it('clamps at the bottom', () => expect(nextRate(0.25, -1)).toBe(0.25));
  it('treats an unknown rate as normal', () => expect(nextRate(1.1, 1)).toBe(1.25));
  it('labels normal speed', () => expect(rateLabel(1)).toBe('Normal'));
  it('labels other speeds', () => expect(rateLabel(1.5)).toBe('1.5'));
});
