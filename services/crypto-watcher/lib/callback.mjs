import crypto from 'node:crypto';

export function signBody(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

/** POST the callback, retrying with backoff until a 2xx. Returns true on success. */
export async function sendCallback(callbackUrl, payload, secret, { tries = 8 } = {}) {
  const raw = JSON.stringify(payload);
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-crypto-signature': signBody(raw, secret) },
        body: raw,
      });
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, Math.min(60_000, 1000 * 2 ** i)));
  }
  return false;
}
