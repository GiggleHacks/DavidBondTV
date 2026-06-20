import { describe, it, expect } from 'vitest';
import { formatTime } from '../public/js/format.js';

describe('formatTime', () => {
  it('formats zero', () => expect(formatTime(0)).toBe('0:00'));
  it('pads seconds', () => expect(formatTime(5)).toBe('0:05'));
  it('formats minutes', () => expect(formatTime(65)).toBe('1:05'));
  it('formats the sample duration', () => expect(formatTime(428)).toBe('7:08'));
  it('formats hours', () => expect(formatTime(3661)).toBe('1:01:01'));
  it('floors fractional seconds', () => expect(formatTime(5.9)).toBe('0:05'));
  it('treats NaN as zero', () => expect(formatTime(NaN)).toBe('0:00'));
  it('treats negatives as zero', () => expect(formatTime(-10)).toBe('0:00'));
});
