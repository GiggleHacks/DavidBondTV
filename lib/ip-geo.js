// Best-effort city-level IP geolocation for the admin visitor dossier. The
// on-box GeoIP DB is country-only, so when an admin opens a visitor profile we
// optionally enrich it with city/region/coords from an external lookup. It is:
//   - cached on disk (keyed by IP, with a TTL) so repeat opens are instant,
//   - timeout-guarded and never throwing (the dossier renders fine without it),
//   - provider-agnostic (endpoint + a parser are injectable; default ip-api.com).
// Used ONLY behind the admin auth gate — never on the public request path.
import fs from 'node:fs';
import path from 'node:path';

function defaultParse(j) {
  if (!j || j.status !== 'success') return null;
  return {
    cc: j.countryCode || null,
    country: j.country || null,
    region: j.regionName || null,
    city: j.city || null,
    lat: typeof j.lat === 'number' ? j.lat : null,
    lon: typeof j.lon === 'number' ? j.lon : null,
    isp: j.isp || j.org || null,
  };
}

export function createIpGeo({
  cacheFile,
  ttlMs = 7 * 24 * 60 * 60 * 1000,
  timeoutMs = 1500,
  endpoint = 'http://ip-api.com/json/',
  fields = 'status,country,countryCode,regionName,city,lat,lon,isp,org,query',
  fetchImpl,
  parse = defaultParse,
  enabled = true,
} = {}) {
  let cache = {};
  if (cacheFile) { try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch { cache = {}; } }

  function persist() {
    if (!cacheFile) return;
    try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch { /* best-effort */ }
  }

  const isPrivate = (ip) => !ip
    || ip === '127.0.0.1' || ip === '::1'
    || /^10\./.test(ip) || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || /^(fc|fd)/i.test(ip);

  async function lookup(ip) {
    if (!enabled || isPrivate(ip)) return null;
    const hit = cache[ip];
    if (hit && (Date.now() - hit.ts) < ttlMs) return hit.data;
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return hit ? hit.data : null;
    try {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
      const url = `${endpoint}${encodeURIComponent(ip)}?fields=${encodeURIComponent(fields)}`;
      const res = await doFetch(url, ctl ? { signal: ctl.signal } : {});
      if (timer) clearTimeout(timer);
      const data = parse(await res.json());
      if (data) { cache[ip] = { ts: Date.now(), data }; persist(); return data; }
    } catch { /* network/timeout/parse — fall back to any stale cache */ }
    return hit ? hit.data : null;
  }

  return { lookup };
}
