// Geo-restriction gate. Evaluates a request context against data/geo-rules.json
// (blocked countries / IPs / users + an IP allowlist) and decides whether to
// serve the site or the "Under Construction" page. Atomic, serialized writes
// like the other stores. The admin is protected from self-lockout upstream
// (bypass cookie, allowlist, unconditional /admin carve-out).
import fs from 'node:fs';
import path from 'node:path';

// Seeded with the four countries the owner asked to block.
const DEFAULTS = {
  enabled: true,
  blockedCountries: ['BR', 'CO', 'TH', 'PH'],
  blockedIps: [],
  blockedUserIds: [],
  allowIps: [],
  updatedAt: 0,
};

const normCC = (cc) => {
  const up = String(cc == null ? '' : cc).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(up) ? up : null;
};

export function createGeoGate(filePath) {
  let rules = load();
  let writeChain = Promise.resolve();

  function load() {
    try {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function persist() {
    rules = { ...rules, updatedAt: Date.now() };
    const snapshot = rules;
    writeChain = writeChain.then(() => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
      fs.renameSync(tmp, filePath);
    }).catch((e) => console.error('geo-rules write failed:', e.message));
    return writeChain.then(() => getRules());
  }

  // Seed the file on first run so the owner can see/edit the defaults.
  if (!fs.existsSync(filePath)) persist();

  /**
   * Decide a request. Returns { blocked, reason }. Allow order: disabled →
   * admin/bypass → allowlisted IP → then block checks (user, ip, country).
   */
  function evaluate(ctx) {
    if (!rules.enabled) return { blocked: false };
    // Admins / the David Bond account are NEVER geoblocked. `ctx.bypass` is true
    // for an admin except while they're actively simulating a visitor country
    // (the dashboard preview tool), so simulation still demonstrates the gate.
    // This is checked before the IP/user/country blocklists, so it also shields
    // an admin whose own IP or user-id happens to be on a blocklist.
    if (ctx.bypass) return { blocked: false };
    if (ctx.ip && rules.allowIps.includes(ctx.ip)) return { blocked: false };
    if (ctx.user && rules.blockedUserIds.includes(ctx.user.id)) return { blocked: true, reason: 'user' };
    if (ctx.ip && rules.blockedIps.includes(ctx.ip)) return { blocked: true, reason: 'ip' };
    if (ctx.country && rules.blockedCountries.includes(ctx.country)) return { blocked: true, reason: 'country' };
    return { blocked: false };
  }

  const getRules = () => ({
    enabled: rules.enabled,
    blockedCountries: [...rules.blockedCountries],
    blockedIps: [...rules.blockedIps],
    blockedUserIds: [...rules.blockedUserIds],
    allowIps: [...rules.allowIps],
    updatedAt: rules.updatedAt,
  });

  const addTo = (key, val) => {
    if (val && !rules[key].includes(val)) { rules = { ...rules, [key]: [...rules[key], val] }; }
    return persist();
  };
  const removeFrom = (key, val) => {
    rules = { ...rules, [key]: rules[key].filter((x) => x !== val) };
    return persist();
  };

  return {
    evaluate,
    getRules,
    setEnabled: (on) => { rules = { ...rules, enabled: !!on }; return persist(); },
    addBlockedCountry: (cc) => { const c = normCC(cc); return c ? addTo('blockedCountries', c) : persist(); },
    removeBlockedCountry: (cc) => removeFrom('blockedCountries', normCC(cc)),
    blockIp: (ip) => addTo('blockedIps', String(ip || '').trim()),
    unblockIp: (ip) => removeFrom('blockedIps', String(ip || '').trim()),
    blockUser: (id) => addTo('blockedUserIds', String(id || '').trim()),
    unblockUser: (id) => removeFrom('blockedUserIds', String(id || '').trim()),
    allowIp: (ip) => addTo('allowIps', String(ip || '').trim()),
    disallowIp: (ip) => removeFrom('allowIps', String(ip || '').trim()),
  };
}
