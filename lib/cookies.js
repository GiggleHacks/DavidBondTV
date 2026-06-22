// Tiny cookie helpers (no dependency). parseCookies reads a Cookie header;
// serializeCookie builds a Set-Cookie value.

/** Parse a raw Cookie header into a { name: value } object. */
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || header.length === 0) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    let value = part.slice(idx + 1).trim();
    try { value = decodeURIComponent(value); } catch { /* keep raw */ }
    out[name] = value;
  }
  return out;
}

/**
 * serializeCookie(name, value, opts)
 * opts: { maxAge (seconds), path, httpOnly, sameSite, secure, expires (Date) }
 */
export function serializeCookie(name, value, opts = {}) {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${opts.path || '/'}`);
  if (typeof opts.maxAge === 'number') segments.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires instanceof Date) segments.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly) segments.push('HttpOnly');
  segments.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure) segments.push('Secure');
  return segments.join('; ');
}
