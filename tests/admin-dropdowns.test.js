import { describe, expect, it, vi } from 'vitest';
import { closeAfterAction, togglePanel } from '../public/js/admin-dropdowns.js';

function fakeButton() {
  const attrs = new Map();
  return {
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.get(name); },
  };
}

function fakePanel(hidden = true) {
  return { hidden };
}

describe('togglePanel', () => {
  it('opens a hidden panel and marks the trigger expanded', () => {
    const btn = fakeButton();
    const panel = fakePanel(true);
    const closeOthers = vi.fn();

    const opened = togglePanel(btn, panel, closeOthers);

    expect(opened).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(closeOthers).toHaveBeenCalledWith(panel);
  });

  it('closes an open panel when the same trigger is used again', () => {
    const btn = fakeButton();
    const panel = fakePanel(false);
    const closeOthers = vi.fn();

    const opened = togglePanel(btn, panel, closeOthers);

    expect(opened).toBe(false);
    expect(panel.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(closeOthers).toHaveBeenCalledWith(null);
  });
});

describe('closeAfterAction', () => {
  it('runs the action and then closes popovers', () => {
    const calls = [];
    const handler = closeAfterAction(
      () => calls.push('apply'),
      () => calls.push('close'),
    );

    handler();

    expect(calls).toEqual(['apply', 'close']);
  });
});
