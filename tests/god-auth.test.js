import { describe, expect, it } from 'vitest';
import { applyAdminGateState, releaseAdminGateState } from '../public/js/god-auth.js';

function makeElement() {
  const attrs = new Map();
  const classes = new Set();
  return {
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    setAttribute: (name, value) => attrs.set(name, String(value)),
    getAttribute: (name) => attrs.get(name) ?? null,
    removeAttribute: (name) => attrs.delete(name),
    hasAttribute: (name) => attrs.has(name),
  };
}

describe('admin gate state helpers', () => {
  it('hides the protected app while the gate is shown', () => {
    const appRoot = makeElement();
    const body = makeElement();

    applyAdminGateState(appRoot, body);

    expect(appRoot.getAttribute('aria-hidden')).toBe('true');
    expect(appRoot.hasAttribute('inert')).toBe(true);
    expect(body.classList.contains('admin-gated')).toBe(true);
  });

  it('restores the protected app when the gate is removed', () => {
    const appRoot = makeElement();
    const body = makeElement();

    applyAdminGateState(appRoot, body);
    releaseAdminGateState(appRoot, body);

    expect(appRoot.hasAttribute('aria-hidden')).toBe(false);
    expect(appRoot.hasAttribute('inert')).toBe(false);
    expect(body.classList.contains('admin-gated')).toBe(false);
  });
});
