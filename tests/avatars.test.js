import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AVATARS, isDefaultAvatar, validateAvatarValue, avatarUrl, initialAvatarDataUri,
} from '../lib/avatars.js';

describe('avatars', () => {
  it('offers 3 human-style avatars and not the owner image', () => {
    expect(DEFAULT_AVATARS).toEqual(['person-glasses', 'hacker', 'hoodie']);
    expect(isDefaultAvatar('hoodie')).toBe(true);
    expect(isDefaultAvatar('david-bond')).toBe(false);
  });

  it('validates picker avatars but rejects the owner image', () => {
    expect(validateAvatarValue('default:hacker').ok).toBe(true);
    expect(validateAvatarValue('default:nope').ok).toBe(false);
    expect(validateAvatarValue('default:david-bond').ok).toBe(false);
  });

  it('validates upload avatar values and blocks traversal', () => {
    expect(validateAvatarValue('upload:/media/avatars/abc.png').ok).toBe(true);
    expect(validateAvatarValue('upload:/media/avatars/../../etc.png').ok).toBe(false);
    expect(validateAvatarValue('upload:/etc/passwd').ok).toBe(false);
  });

  it('rejects blank/garbage', () => {
    expect(validateAvatarValue('').ok).toBe(false);
    expect(validateAvatarValue(null).ok).toBe(false);
  });

  it('resolves known avatar URLs', () => {
    expect(avatarUrl('default:hacker')).toBe('/avatars/hacker.svg');
    expect(avatarUrl('upload:/media/avatars/x.png')).toBe('/media/avatars/x.png');
    // The owner image is no longer pickable, but still resolves for the admin account.
    expect(avatarUrl('default:david-bond')).toBe('/avatars/david-bond.svg');
  });

  it('falls back to a generated initial avatar for no/unknown avatar', () => {
    expect(avatarUrl(undefined, 'Alice')).toMatch(/^data:image\/svg\+xml/);
    expect(avatarUrl('default:nft-04', 'Bob')).toMatch(/^data:image\/svg\+xml/);
    // Letter is derived from the name, uppercased.
    expect(decodeURIComponent(avatarUrl(undefined, 'alice'))).toContain('>A<');
  });

  it('generates a stable initial avatar with the first letter', () => {
    const a = initialAvatarDataUri('Charlie');
    expect(a).toBe(initialAvatarDataUri('Charlie')); // deterministic
    expect(decodeURIComponent(a)).toContain('>C<');
    expect(decodeURIComponent(initialAvatarDataUri(''))).toContain('>?<');
  });
});
