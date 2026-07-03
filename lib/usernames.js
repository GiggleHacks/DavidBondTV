// Username rules shared by signup (auto-generation), profile rename and the
// users store. Kept dependency-free so both lib/accounts.js and
// lib/users-store.js can import it without cycles.
import crypto from 'node:crypto';

export const RESERVED = new Set(['admin', 'anonymous', 'administrator', 'root', 'support', 'dbtv', 'davidbond']);

export function validateUsername(username) {
  if (typeof username !== 'string') return { ok: false, error: 'Username is required.' };
  const t = username.trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(t)) {
    return { ok: false, error: 'Username must be 3-20 letters, numbers or underscores.' };
  }
  if (RESERVED.has(t.toLowerCase())) return { ok: false, error: 'That username is reserved.' };
  return { ok: true, value: t };
}

const randomDigits = (n) => String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');

/**
 * Derive a username from an email so accounts are usable the moment they're
 * created (no profile-setup step). jane.doe@x.com → jane_doe, with random-digit
 * suffixes on collision. `isTaken(candidate)` is the caller's uniqueness probe.
 * Always returns a value that passes validateUsername().
 */
export function generateUsername(email, isTaken = () => false) {
  const local = String(email || '').split('@')[0];
  // Keep base ≤ 16 so a 2-digit collision suffix always fits the 20-char cap.
  let base = local.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  if (base.length < 3 || RESERVED.has(base.toLowerCase())) base = `user${randomDigits(4)}`;
  let candidate = base;
  for (let attempt = 0; isTaken(candidate); attempt++) {
    if (attempt >= 20) return `user${randomDigits(8)}`; // practically collision-free
    candidate = `${base}${randomDigits(2)}`;
  }
  return candidate;
}
