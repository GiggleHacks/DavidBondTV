import { describe, it, expect } from 'vitest';
import { generateUsername, validateUsername, RESERVED } from '../lib/usernames.js';

describe('generateUsername', () => {
  it('derives the username from the email local part', () => {
    expect(generateUsername('jane_doe@example.com')).toBe('jane_doe');
  });

  it('strips characters outside [A-Za-z0-9_]', () => {
    expect(generateUsername('jane.doe+tv@example.com')).toBe('janedoetv');
  });

  it('truncates long local parts so a collision suffix still fits the 20-char cap', () => {
    const name = generateUsername('averyveryverylongemailname@example.com');
    expect(name).toBe('averyveryverylon'); // 16 chars
    const collided = generateUsername('averyveryverylongemailname@example.com', (c) => c === 'averyveryverylon');
    expect(collided).toMatch(/^averyveryverylon\d{2}$/);
    expect(collided.length).toBeLessThanOrEqual(20);
  });

  it('falls back to user#### for too-short or reserved local parts and null emails', () => {
    expect(generateUsername('ab@example.com')).toMatch(/^user\d{4}$/);
    expect(generateUsername('admin@example.com')).toMatch(/^user\d{4}$/);
    expect(generateUsername('Root@example.com')).toMatch(/^user\d{4}$/);
    expect(generateUsername(null)).toMatch(/^user\d{4}$/);
    expect(generateUsername('')).toMatch(/^user\d{4}$/);
  });

  it('appends digits on collision and eventually falls back to user + 8 digits', () => {
    const suffixed = generateUsername('jane@example.com', (c) => c === 'jane');
    expect(suffixed).toMatch(/^jane\d{2}$/);
    const everything = generateUsername('jane@example.com', (c) => !/^user\d{8}$/.test(c));
    expect(everything).toMatch(/^user\d{8}$/);
  });

  it('always produces a name that passes validateUsername', () => {
    for (const email of ['a@b.c', '~~~@x.y', 'jane.doe@x.y', 'admin@x.y', 'this_is_a_really_long_local_part@x.y', null]) {
      const name = generateUsername(email);
      expect(validateUsername(name).ok).toBe(true);
    }
  });
});

describe('validateUsername', () => {
  it('accepts 3-20 letters, numbers and underscores', () => {
    expect(validateUsername('abc').ok).toBe(true);
    expect(validateUsername('A_1'.repeat(6) + 'zz').ok).toBe(true); // 20 chars
  });

  it('rejects bad shapes and reserved names', () => {
    expect(validateUsername('ab').ok).toBe(false);
    expect(validateUsername('has space').ok).toBe(false);
    expect(validateUsername('x'.repeat(21)).ok).toBe(false);
    for (const r of RESERVED) expect(validateUsername(r).ok).toBe(false);
    expect(validateUsername('Admin').ok).toBe(false);
  });
});
