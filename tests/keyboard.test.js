import { describe, it, expect, vi } from 'vitest';
import { resolveAction, dispatchAction } from '../public/js/keyboard.js';

const k = (key, shiftKey = false) => ({ key, shiftKey });

describe('resolveAction', () => {
  it('space and k toggle play', () => {
    expect(resolveAction(k(' '))).toEqual({ type: 'togglePlay' });
    expect(resolveAction(k('k'))).toEqual({ type: 'togglePlay' });
  });
  it('m toggles mute', () => expect(resolveAction(k('m'))).toEqual({ type: 'toggleMute' }));
  it('j/l seek by 10s', () => {
    expect(resolveAction(k('j'))).toEqual({ type: 'seekBy', delta: -10 });
    expect(resolveAction(k('l'))).toEqual({ type: 'seekBy', delta: 10 });
  });
  it('arrows seek by 5s', () => {
    expect(resolveAction(k('ArrowLeft'))).toEqual({ type: 'seekBy', delta: -5 });
    expect(resolveAction(k('ArrowRight'))).toEqual({ type: 'seekBy', delta: 5 });
  });
  it('up/down change volume by 0.05', () => {
    expect(resolveAction(k('ArrowUp'))).toEqual({ type: 'volumeBy', delta: 0.05 });
    expect(resolveAction(k('ArrowDown'))).toEqual({ type: 'volumeBy', delta: -0.05 });
  });
  it('digits seek to percentages', () => {
    expect(resolveAction(k('0'))).toEqual({ type: 'seekToPercent', percent: 0 });
    expect(resolveAction(k('5'))).toEqual({ type: 'seekToPercent', percent: 0.5 });
    expect(resolveAction(k('9'))).toEqual({ type: 'seekToPercent', percent: 0.9 });
  });
  it('Home/End jump to start/end', () => {
    expect(resolveAction(k('Home'))).toEqual({ type: 'seekToPercent', percent: 0 });
    expect(resolveAction(k('End'))).toEqual({ type: 'seekToEnd' });
  });
  it('period/comma frame-step', () => {
    expect(resolveAction(k('.'))).toEqual({ type: 'frameStep', dir: 1 });
    expect(resolveAction(k(','))).toEqual({ type: 'frameStep', dir: -1 });
  });
  it('shifted >/< step speed', () => {
    expect(resolveAction(k('>', true))).toEqual({ type: 'speedStep', dir: 1 });
    expect(resolveAction(k('<', true))).toEqual({ type: 'speedStep', dir: -1 });
  });
  it('f toggles fullscreen', () => expect(resolveAction(k('f'))).toEqual({ type: 'toggleFullscreen' }));
  it('returns null for out-of-scope keys', () => {
    expect(resolveAction(k('c'))).toBeNull();
    expect(resolveAction(k('i'))).toBeNull();
    expect(resolveAction(k('t'))).toBeNull();
    expect(resolveAction(k('/'))).toBeNull();
  });
});

describe('dispatchAction', () => {
  it('calls the matching action callback with args', () => {
    const actions = {
      togglePlay: vi.fn(), seekBy: vi.fn(), volumeBy: vi.fn(),
      seekToPercent: vi.fn(), seekToEnd: vi.fn(), frameStep: vi.fn(),
      speedStep: vi.fn(), toggleMute: vi.fn(), toggleFullscreen: vi.fn(),
    };
    dispatchAction({ type: 'seekBy', delta: 10 }, actions);
    expect(actions.seekBy).toHaveBeenCalledWith(10);
    dispatchAction({ type: 'seekToPercent', percent: 0.5 }, actions);
    expect(actions.seekToPercent).toHaveBeenCalledWith(0.5);
    dispatchAction({ type: 'togglePlay' }, actions);
    expect(actions.togglePlay).toHaveBeenCalledOnce();
  });
});
