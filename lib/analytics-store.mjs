// Watch + traffic analytics with bounded storage.
//
// Storage model:
//   • Raw event log  — data/analytics/raw/YYYY-MM-DD.jsonl (append-only),
//     pruned to the last N days. The only unbounded dimension (individual
//     events) lives here and is short-lived.
//   • Rollups (permanent, compact) — videos/countries/users/blocked JSON,
//     keyed by bounded dimensions (videos, ~250 countries, registered users)
//     with time-series sub-maps capped to a rolling window. Folded incrementally
//     in memory and flushed atomically every ~45s + on shutdown.
//
// Events are pre-filtered (bots dropped, ids validated) before record().
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (t) => new Date(t).toISOString().slice(0, 10); // YYYY-MM-DD

export function createAnalytics({ dir, rawRetentionDays = 7, dayWindow = 90 } = {}) {
  const RAW_DIR = path.join(dir, 'raw');
  const FILES = {
    videos: path.join(dir, 'videos.json'),
    countries: path.join(dir, 'countries.json'),
    users: path.join(dir, 'users.json'),
    blocked: path.join(dir, 'blocked.json'),
  };
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const load = (f, fallback) => {
    try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return fallback; }
  };
  const roll = {
    videos: load(FILES.videos, {}),
    countries: load(FILES.countries, {}),
    users: load(FILES.users, {}),
    blocked: load(FILES.blocked, { total: 0, byCountry: {}, byDay: {} }),
    totals: load(path.join(dir, 'totals.json'), { views: 0, seconds: 0 }),
  };

  // Ephemeral: distinct viewIds already counted (so heartbeats don't re-count a
  // "view"). Reset daily; a viewId continuing across a reset double-counts once.
  let countedViews = new Set();
  let countedDay = dayKey(Date.now());
  let dirty = false;

  function rollDay() {
    const today = dayKey(Date.now());
    if (today !== countedDay) { countedViews = new Set(); countedDay = today; }
  }

  function capByDay(obj) {
    const days = Object.keys(obj);
    if (days.length <= dayWindow) return;
    days.sort();
    for (const d of days.slice(0, days.length - dayWindow)) delete obj[d];
  }

  /**
   * Record a non-bot watch event:
   *   { t, video, viewId, userId|null, ip, cc|null, dt }  (dt = seconds watched)
   */
  function record(e) {
    rollDay();
    const t = e.t || Date.now();
    const day = dayKey(t);
    const dt = Math.max(0, Math.min(Number(e.dt) || 0, 300)); // clamp a single heartbeat
    const firstHeartbeat = e.viewId && !countedViews.has(e.viewId);
    if (e.viewId) countedViews.add(e.viewId);

    // per-video
    const v = (roll.videos[e.video] ||= { views: 0, totalSeconds: 0, byDay: {} });
    v.totalSeconds += dt;
    const vd = (v.byDay[day] ||= { views: 0, seconds: 0 });
    vd.seconds += dt;
    if (firstHeartbeat) { v.views += 1; vd.views += 1; }
    capByDay(v.byDay);

    // per-country
    if (e.cc) {
      const c = (roll.countries[e.cc] ||= { views: 0, seconds: 0 });
      c.seconds += dt;
      if (firstHeartbeat) c.views += 1;
    }

    // per-user (registered viewers)
    if (e.userId) {
      const u = (roll.users[e.userId] ||= { totalSeconds: 0, byVideo: {}, ips: [], views: 0, lastCountry: null, lastSeen: 0 });
      u.totalSeconds += dt;
      u.byVideo[e.video] = (u.byVideo[e.video] || 0) + dt;
      u.lastSeen = t;
      if (e.cc) u.lastCountry = e.cc;
      if (e.ip && !u.ips.includes(e.ip)) { u.ips.unshift(e.ip); u.ips = u.ips.slice(0, 5); }
      if (firstHeartbeat) u.views += 1;
    }

    // totals
    roll.totals.seconds += dt;
    if (firstHeartbeat) roll.totals.views += 1;

    dirty = true;

    // Append to the raw daily log (fire-and-forget).
    const line = JSON.stringify({ t, v: e.video, uid: e.userId || null, ip: e.ip || null, cc: e.cc || null, dt }) + '\n';
    fsp.appendFile(path.join(RAW_DIR, `${day}.jsonl`), line).catch(() => {});
  }

  /** Record a blocked access attempt (country/IP/user-blocked visitor). */
  function recordBlocked(ctx, reason) {
    rollDay();
    const day = dayKey(Date.now());
    roll.blocked.total += 1;
    roll.blocked.byDay[day] = (roll.blocked.byDay[day] || 0) + 1;
    const cc = ctx && ctx.country;
    if (cc) roll.blocked.byCountry[cc] = (roll.blocked.byCountry[cc] || 0) + 1;
    capByDay(roll.blocked.byDay);
    const line = JSON.stringify({ t: Date.now(), blocked: true, cc: cc || null, ip: (ctx && ctx.ip) || null, reason: reason || null }) + '\n';
    fsp.appendFile(path.join(RAW_DIR, `${day}.jsonl`), line).catch(() => {});
    dirty = true;
  }

  function writeAtomic(file, obj) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  }

  /** Persist all rollups atomically. No-op if nothing changed. */
  function flush(force = false) {
    if (!dirty && !force) return;
    try {
      writeAtomic(FILES.videos, roll.videos);
      writeAtomic(FILES.countries, roll.countries);
      writeAtomic(FILES.users, roll.users);
      writeAtomic(FILES.blocked, roll.blocked);
      writeAtomic(path.join(dir, 'totals.json'), roll.totals);
      dirty = false;
    } catch (err) {
      console.error('analytics flush failed:', err.message);
    }
  }

  /** Delete raw daily logs older than the retention window. */
  function pruneRaw() {
    const cutoff = Date.now() - rawRetentionDays * DAY_MS;
    let files = [];
    try { files = fs.readdirSync(RAW_DIR); } catch { return; }
    for (const f of files) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      if (new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) {
        try { fs.unlinkSync(path.join(RAW_DIR, f)); } catch { /* ignore */ }
      }
    }
  }

  // --- read accessors (return clones so callers can't mutate state) ---
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const getVideoStats = (id) => (roll.videos[id] ? clone(roll.videos[id]) : null);
  const getAllVideoStats = () => clone(roll.videos);
  const getCountryStats = () => clone(roll.countries);
  const getUserStats = (id) => (roll.users[id] ? clone(roll.users[id]) : null);
  const getAllUserStats = () => clone(roll.users);
  const getBlockedStats = () => clone(roll.blocked);
  const getTotals = () => clone(roll.totals);

  // Periodic flush + daily prune; unref so neither holds the process open.
  const flushTimer = setInterval(() => flush(), 45_000); flushTimer.unref();
  const pruneTimer = setInterval(() => pruneRaw(), 6 * 60 * 60 * 1000); pruneTimer.unref();
  pruneRaw();

  return {
    record, recordBlocked, flush, pruneRaw,
    getVideoStats, getAllVideoStats, getCountryStats,
    getUserStats, getAllUserStats, getBlockedStats, getTotals,
  };
}
