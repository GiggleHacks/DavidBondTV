// Generic webhook HMAC verifier (Stripe-style `t=<unix>,v1=<hex>[,v1=…]` header).
// The signed payload is `${t}.${rawBody}` and the signature is HMAC-SHA256(secret,
// payload). Returns true only on a constant-time match within the timestamp
// tolerance. Never throws. Used by the self-hosted crypto watcher callback
// (lib/crypto-payments.js); previously lived in the now-removed stripe-payments.js.
import crypto from 'node:crypto';

export function verifyHmacSignature(rawBody, sigHeader, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!secret || typeof sigHeader !== 'string' || rawBody == null) return false;
  let t = null;
  const v1 = [];
  for (const kv of sigHeader.split(',')) {
    const i = kv.indexOf('=');
    if (i === -1) continue;
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1.push(v);
  }
  if (!t || v1.length === 0) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  // Replay window: reject signatures whose timestamp is too far from now.
  if (toleranceSec > 0 && Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
  const expBuf = Buffer.from(expected, 'hex');
  return v1.some((sig) => {
    let sigBuf;
    try { sigBuf = Buffer.from(sig, 'hex'); } catch { return false; }
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  });
}
