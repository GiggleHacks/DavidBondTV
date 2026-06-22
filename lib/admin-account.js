// Persisted administrator account ("David Bond"). Unlike the legacy
// ADMIN_PASSWORD env gate, this stores a hashed password + a security
// question/answer (for recovery) in data/admin.json. Reuses the same scrypt
// hashing as user accounts (lib/password.js) and atomic tmp+rename writes.
//
// The account is seeded once on first boot with a freshly generated strong
// password (printed + written to data/admin-credentials.txt). No email — the
// only recovery path is the security question.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from './password.js';

const DEFAULT_USERNAME = 'davidbond';
const DEFAULT_QUESTION = 'What did Larry put in his butt?';
// Seeded answer. Normalized to "megaman" (spaces removed, lowercased), so
// matching is case-insensitive and space-insensitive.
const DEFAULT_ANSWER = 'megaman';

/**
 * Normalize a security answer before hashing/compare: trim, strip ALL internal
 * whitespace, and lowercase. So "Mega Man", "MEGAMAN", "megaman" all match.
 */
export function normalizeAnswer(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
}

/** Generate a strong ~24-char password from a mixed charset (no ambiguous chars). */
export function generateStrongPassword(len = 24) {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += charset[bytes[i] % charset.length];
  return out;
}

/**
 * createAdminAccount({ filePath, credentialsFile })
 * Returns an account object with verify/set methods. Loads lazily.
 */
export function createAdminAccount({ filePath, credentialsFile }) {
  let cache = null; // in-memory copy of the JSON record (or null if unloaded/absent)

  function load() {
    if (cache) return cache;
    try {
      cache = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      cache = null;
    }
    return cache;
  }

  function writeAtomic(record) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, filePath);
    cache = record;
  }

  function isConfigured() {
    const r = load();
    return !!(r && r.passwordHash);
  }

  /**
   * Seed the account on first boot if missing. Returns the generated plaintext
   * password (so the caller can surface it once) or null if already seeded.
   */
  function ensureSeeded() {
    if (isConfigured()) return null;
    const password = generateStrongPassword();
    const now = Date.now();
    const record = {
      username: DEFAULT_USERNAME,
      passwordHash: hashPassword(password),
      securityQuestion: DEFAULT_QUESTION,
      securityAnswerHash: hashPassword(normalizeAnswer(DEFAULT_ANSWER)),
      securityStamp: crypto.randomBytes(16).toString('hex'),
      createdAt: now,
      passwordChangedAt: now,
    };
    writeAtomic(record);
    // Stash the plaintext once for retrieval (gitignored data dir).
    if (credentialsFile) {
      try {
        fs.mkdirSync(path.dirname(credentialsFile), { recursive: true });
        fs.writeFileSync(credentialsFile,
          `David Bond TV — administrator credentials\n` +
          `Generated: ${new Date(now).toISOString()}\n\n` +
          `Username: ${DEFAULT_USERNAME}\n` +
          `Password: ${password}\n\n` +
          `Security question: ${DEFAULT_QUESTION}\n` +
          `Security answer:   ${DEFAULT_ANSWER}\n\n` +
          `Keep this file safe. It is the only copy of the generated password.\n`);
      } catch { /* best effort */ }
    }
    return password;
  }

  function verify(password) {
    const r = load();
    if (!r || !r.passwordHash) return false;
    return verifyPassword(password, r.passwordHash);
  }

  function setPassword(next) {
    const r = load();
    if (!r) return { ok: false, error: 'Admin account not initialized.' };
    if (typeof next !== 'string' || next.length < 4) {
      return { ok: false, error: 'Password must be at least 4 characters.' };
    }
    if (next.length > 200) return { ok: false, error: 'Password is too long.' };
    writeAtomic({
      ...r,
      passwordHash: hashPassword(next),
      passwordChangedAt: Date.now(),
      securityStamp: crypto.randomBytes(16).toString('hex'),
    });
    return { ok: true };
  }

  function getSecurityQuestion() {
    const r = load();
    return (r && r.securityQuestion) || null;
  }

  function verifySecurityAnswer(answer) {
    const r = load();
    if (!r || !r.securityAnswerHash) return false;
    return verifyPassword(normalizeAnswer(answer), r.securityAnswerHash);
  }

  function setSecurityQuestion(question, answer) {
    const r = load();
    if (!r) return { ok: false, error: 'Admin account not initialized.' };
    if (typeof question !== 'string' || question.trim().length < 4) {
      return { ok: false, error: 'Question is too short.' };
    }
    if (normalizeAnswer(answer).length < 1) {
      return { ok: false, error: 'Answer cannot be empty.' };
    }
    writeAtomic({
      ...r,
      securityQuestion: question.trim(),
      securityAnswerHash: hashPassword(normalizeAnswer(answer)),
    });
    return { ok: true };
  }

  /** The stored password hash (for one-time migration into the user record). */
  function passwordHash() {
    const r = load();
    return r && r.passwordHash ? r.passwordHash : null;
  }

  /** Non-sensitive info for the admin UI. Never returns hashes. */
  function publicInfo() {
    const r = load();
    if (!r) return null;
    return {
      username: r.username,
      securityQuestion: r.securityQuestion,
      createdAt: r.createdAt,
      passwordChangedAt: r.passwordChangedAt,
    };
  }

  return {
    ensureSeeded,
    isConfigured,
    verify,
    setPassword,
    passwordHash,
    getSecurityQuestion,
    verifySecurityAnswer,
    setSecurityQuestion,
    publicInfo,
  };
}
