// Offline IP->country lookup over a preprocessed MaxMind GeoLite2-Country table
// (built by scripts/build-geoip.mjs into data/geoip-country.json). Binary search
// over sorted IPv4 and IPv6 range tables. Zero dependency. If the data file is
// missing, lookup() simply returns null and the UI omits the flag.
import fs from 'node:fs';

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

export function ipv6ToBigInt(ip) {
  const clean = ip.split('%')[0];
  let hextets;
  if (clean.includes('::')) {
    if (clean.indexOf('::') !== clean.lastIndexOf('::')) return null;
    const [head, tail] = clean.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const missing = 8 - (h.length + t.length);
    if (missing < 0) return null;
    hextets = [...h, ...Array(missing).fill('0'), ...t];
  } else {
    hextets = clean.split(':');
  }
  if (hextets.length !== 8) return null;
  let n = 0n;
  for (const hx of hextets) {
    if (hx === '') return null;
    const v = parseInt(hx, 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    n = (n << 16n) | BigInt(v);
  }
  return n;
}

// Binary search a [start, end, cc] table (sorted by start) for value.
function search(table, value) {
  let lo = 0;
  let hi = table.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end, cc] = table[mid];
    if (value < start) hi = mid - 1;
    else if (value > end) lo = mid + 1;
    else return cc;
  }
  return null;
}

export function createGeoip(filePath) {
  let v4 = [];
  let v6 = [];
  let loaded = false;

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    v4 = Array.isArray(data.v4) ? data.v4 : [];
    // v6 ranges are stored as decimal strings; hydrate to BigInt for comparison.
    v6 = (Array.isArray(data.v6) ? data.v6 : []).map(([s, e, cc]) => [BigInt(s), BigInt(e), cc]);
    loaded = v4.length > 0 || v6.length > 0;
  } catch {
    loaded = false;
  }

  function lookup(ip) {
    if (!loaded || typeof ip !== 'string' || !ip) return null;
    let addr = ip.trim();
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(addr);
    if (mapped) addr = mapped[1];
    if (addr.includes(':')) {
      const big = ipv6ToBigInt(addr);
      return big === null ? null : search(v6, big);
    }
    const int = ipv4ToInt(addr);
    return int === null ? null : search(v4, int);
  }

  return { lookup, loaded: () => loaded };
}
