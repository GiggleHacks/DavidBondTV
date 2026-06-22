// Account recovery key: a Bitcoin-seed-style 12-word phrase that lets a user
// regain access if they lose both their password and their email. The phrase is
// shown to the user exactly once at generation and stored ONLY as a scrypt hash
// (reusing lib/password.js), so a server/DB breach can never reveal it.
//
// Entropy: 12 words from a 2048-word list = 132 bits — brute force is infeasible.
import crypto from 'node:crypto';
import { WORDLIST } from './wordlist-en.js';
import { hashPassword, verifyPassword } from './password.js';

const PHRASE_WORDS = 12;

/** Generate a fresh 12-word recovery phrase (space-separated, lowercase). */
export function generateRecoveryPhrase() {
  const words = [];
  for (let i = 0; i < PHRASE_WORDS; i++) {
    words.push(WORDLIST[crypto.randomInt(0, WORDLIST.length)]); // unbiased
  }
  return words.join(' ');
}

/**
 * Normalise a user-entered phrase so trivial differences (case, extra/leading/
 * trailing whitespace, line breaks) still verify against the stored hash.
 */
export function normalizePhrase(input) {
  return String(input == null ? '' : input).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Hash a phrase for storage. Returns a scrypt string (same format as passwords). */
export function hashRecoveryPhrase(phrase) {
  return hashPassword(normalizePhrase(phrase));
}

/** Verify a user-entered phrase against a stored hash. Boolean; never throws. */
export function verifyRecoveryPhrase(phrase, storedHash) {
  if (!storedHash) return false;
  return verifyPassword(normalizePhrase(phrase), storedHash);
}
