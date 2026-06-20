import crypto from 'node:crypto';

/**
 * Encode a Buffer to base64url (URL-safe base64, no padding).
 */
function toBase64url(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Decode a base64url string to a plain string.
 * Returns null on failure.
 */
function fromBase64url(str) {
  if (typeof str !== 'string') return null;
  try {
    // Re-pad to standard base64
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Compute HMAC-SHA256 of `message` with `secret`, returning a hex string.
 */
function hmac(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * createChallenge(secret, now?)
 * Returns { question, token, answer }
 * token = base64url("<expiresAt>.<answer>.<hmac>")
 */
export function createChallenge(secret, now = Date.now()) {
  const a = Math.floor(Math.random() * 9) + 1; // 1-9
  const b = Math.floor(Math.random() * 9) + 1; // 1-9
  const answer = a + b;
  const expiresAt = now + 10 * 60 * 1000;

  const payload = `${expiresAt}.${answer}`;
  const sig = hmac(secret, payload);
  const raw = `${payload}.${sig}`;
  const token = toBase64url(Buffer.from(raw, 'utf8'));

  return {
    question: `What is ${a} + ${b}?`,
    token,
    answer,
  };
}

/**
 * verifyChallenge(secret, token, submittedAnswer, now?)
 * Returns boolean — never throws.
 */
export function verifyChallenge(secret, token, submittedAnswer, now = Date.now()) {
  try {
    const raw = fromBase64url(token);
    if (!raw) return false;

    const parts = raw.split('.');
    if (parts.length !== 3) return false;

    const [expiresAtStr, answerStr, providedHmac] = parts;

    const expiresAt = Number(expiresAtStr);
    const answer = Number(answerStr);

    if (!Number.isFinite(expiresAt) || !Number.isFinite(answer)) return false;

    // Constant-time HMAC compare
    const payload = `${expiresAtStr}.${answerStr}`;
    const expectedHmac = hmac(secret, payload);

    if (providedHmac.length !== expectedHmac.length) return false;
    const hmacBuf = Buffer.from(providedHmac, 'hex');
    const expectedBuf = Buffer.from(expectedHmac, 'hex');
    if (hmacBuf.length !== expectedBuf.length) return false;
    if (!crypto.timingSafeEqual(hmacBuf, expectedBuf)) return false;

    // Check expiry
    if (now > expiresAt) return false;

    // Check answer
    if (Number(submittedAnswer) !== answer) return false;

    return true;
  } catch {
    return false;
  }
}
