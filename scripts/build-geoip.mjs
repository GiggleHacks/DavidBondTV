// Preprocess the MaxMind GeoLite2-Country CSV export into a compact lookup table
// (data/geoip-country.json) consumed by lib/geoip.js at runtime. Keeps the server
// zero-dependency: no .mmdb reader needed.
//
// Usage:  node scripts/build-geoip.mjs <dir-containing-GeoLite2-Country-CSVs>
//
// Expects these files in <dir> (free download from a MaxMind account):
//   GeoLite2-Country-Locations-en.csv
//   GeoLite2-Country-Blocks-IPv4.csv
//   GeoLite2-Country-Blocks-IPv6.csv
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'geoip-country.json');

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/build-geoip.mjs <csv-dir>');
  process.exit(1);
}

// Minimal CSV line parser (handles quoted fields with embedded commas).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function readCsv(file) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  return { header, rows: lines.slice(1).map(parseCsvLine) };
}

// 1) geoname_id -> ISO country code
const loc = readCsv('GeoLite2-Country-Locations-en.csv');
const gnIdx = loc.header.indexOf('geoname_id');
const isoIdx = loc.header.indexOf('country_iso_code');
const geoToIso = new Map();
for (const r of loc.rows) {
  if (r[isoIdx]) geoToIso.set(r[gnIdx], r[isoIdx]);
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
}
function ipv6ToBigInt(ip) {
  let hextets;
  if (ip.includes('::')) {
    const [head, tail] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    hextets = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  } else hextets = ip.split(':');
  let n = 0n;
  for (const hx of hextets) n = (n << 16n) | BigInt(parseInt(hx || '0', 16));
  return n;
}

function buildBlocks(file, isV6) {
  const csv = readCsv(file);
  const netIdx = csv.header.indexOf('network');
  const gIdx = csv.header.indexOf('geoname_id');
  const rgIdx = csv.header.indexOf('registered_country_geoname_id');
  const ranges = [];
  for (const r of csv.rows) {
    const cc = geoToIso.get(r[gIdx]) || geoToIso.get(r[rgIdx]);
    if (!cc) continue;
    const [addr, prefixStr] = r[netIdx].split('/');
    const prefix = Number(prefixStr);
    if (isV6) {
      const start = ipv6ToBigInt(addr);
      const end = start + (1n << BigInt(128 - prefix)) - 1n;
      ranges.push([start.toString(), end.toString(), cc]);
    } else {
      const start = ipv4ToInt(addr);
      const end = start + 2 ** (32 - prefix) - 1;
      ranges.push([start, end, cc]);
    }
  }
  return ranges;
}

const v4 = buildBlocks('GeoLite2-Country-Blocks-IPv4.csv', false)
  .sort((a, b) => a[0] - b[0]);
const v6 = buildBlocks('GeoLite2-Country-Blocks-IPv6.csv', true)
  .sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ v4, v6 }), 'utf8');
console.log(`Wrote ${v4.length} IPv4 + ${v6.length} IPv6 ranges to ${OUT}`);
