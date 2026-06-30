import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
};

export function contentType(filePath) {
  return TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;

  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') return null;

  let start;
  let end;
  if (startStr === '') {
    const suffix = parseInt(endStr, 10);
    if (suffix === 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? size - 1 : parseInt(endStr, 10);
  }

  if (start > end || start >= size) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Baseline browser hardening headers for every response we control. Callers may
 * override an individual header by passing their own value.
 */
// HSTS tells browsers to only ever reach this host over HTTPS. Conservative
// default: ~180 days, no includeSubDomains (so other subdomains aren't forced)
// and no preload — tune via HSTS_MAX_AGE, or disable entirely with HSTS_DISABLE=1.
// Browsers ignore this header when it arrives over plain HTTP (RFC 6797), so it's
// safe to emit unconditionally; the HTTP→HTTPS redirect handles insecure hits.
const HSTS_VALUE = process.env.HSTS_DISABLE === '1'
  ? null
  : `max-age=${Number(process.env.HSTS_MAX_AGE) || 15552000}`;

// GigaBrain analytics sidecar origin (its own subdomain/host). When configured,
// public pages must be allowed to POST tracker events to it (connect-src). The
// dashboard is now native (server-side proxy, same-origin), so the sidecar no
// longer needs a frame-src allowance. Derived to a bare origin.
const GIGABRAIN_ORIGIN = (() => {
  const raw = (process.env.GIGABRAIN_PUBLIC_URL || '').trim();
  if (!raw) return '';
  try { return new URL(raw).origin; } catch { return ''; }
})();
const CONNECT_SRC = `connect-src 'self' https://challenges.cloudflare.com${GIGABRAIN_ORIGIN ? ' ' + GIGABRAIN_ORIGIN : ''}`;
const FRAME_SRC = `frame-src https://challenges.cloudflare.com`;

export function withSecurityHeaders(headers = {}) {
  return {
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; "
      + "form-action 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; "
      + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; "
      + `${CONNECT_SRC}; ${FRAME_SRC}`,
    ...(HSTS_VALUE ? { 'Strict-Transport-Security': HSTS_VALUE } : {}),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...headers,
  };
}

/** Send a JSON response. */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, withSecurityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  }));
  res.end(payload);
}

/** Read request body up to maxBytes; resolves to string, or null on overflow/error. */
export function readBody(req, maxBytes = 65536) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

/**
 * Read the request body up to maxBytes as a raw Buffer; resolves to null on
 * overflow/error. Unlike readBody (which decodes to a string), this preserves
 * the exact bytes — required for verifying a Stripe webhook signature, which is
 * computed over the raw payload.
 */
export function readRawBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

/** Extract the client IP, honouring a single x-forwarded-for hop. */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? xff.split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}
