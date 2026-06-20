import { describe, it, expect } from 'vitest';
import { spriteLocation } from '../public/js/storyboard.js';

const meta = {
  interval: 2,
  tileWidth: 160,
  tileHeight: 90,
  columns: 5,
  rows: 5,
  tilesPerSheet: 25,
  count: 30,
  sheets: ['sprite-1.jpg', 'sprite-2.jpg'],
};

describe('spriteLocation', () => {
  it('maps t=0 to the first tile of the first sheet', () => {
    expect(spriteLocation(0, meta)).toEqual({
      sheet: 'sprite-1.jpg', x: 0, y: 0, width: 160, height: 90,
    });
  });
  it('maps within the interval to the same tile', () => {
    expect(spriteLocation(1.9, meta).x).toBe(0);
  });
  it('advances one tile per interval (column step)', () => {
    expect(spriteLocation(2, meta)).toMatchObject({ x: 160, y: 0 });
  });
  it('wraps to the next row after the last column', () => {
    // index 5 -> row 1, col 0  => x 0, y 90
    expect(spriteLocation(10, meta)).toMatchObject({ x: 0, y: 90 });
  });
  it('rolls over to the next sheet', () => {
    // index 25 -> sheet 2, tile 0
    expect(spriteLocation(50, meta)).toMatchObject({ sheet: 'sprite-2.jpg', x: 0, y: 0 });
  });
  it('clamps past the end to the last thumbnail', () => {
    // count 30 -> last index 29 -> sheet 2, within 4 -> col 4 row 0
    expect(spriteLocation(9999, meta)).toMatchObject({ sheet: 'sprite-2.jpg', x: 640, y: 0 });
  });
});
