// Password hashing using node:crypto scrypt (no external dependency).
// Stored format: "scrypt$<saltHex>$<hashHex>". Verification is constant-time.
import crypto from 'node:crypto';

const KEYLEN = 64;
const SALT_BYTES = 16;

/** Hash a plaintext password. Returns "scrypt$<salt>$<hash>". */
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password required');
  }
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/** Verify a plaintext password against a stored hash. Boolean; never throws. */
export function verifyPassword(password, stored) {
  try {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, salt, hashHex] = parts;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Validate password strength. Returns { ok } or { ok:false, error }.
 * Kept deliberately simple: min 4 chars, max 200 (scrypt DoS guard).
 */
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 4) {
    return { ok: false, error: 'Password must be at least 4 characters.' };
  }
  if (password.length > 200) {
    return { ok: false, error: 'Password is too long (max 200 characters).' };
  }
  return { ok: true };
}
