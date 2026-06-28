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
const CSV_COLUMNS = [
  'timestamp', 'type', 'username', 'userId', 'subscriber', 'ip', 'country', 'countryCode',
  'city', 'region', 'content', 'videoId', 'device', 'deviceId', 'sessionId', 'viewId',
  'seconds', 'position', 'duration', 'reason',
];

export function createAnalytics({ dir, rawRetentionDays = 30, dayWindow = 365 } = {}) {
  const RAW_DIR = path.join(dir, 'raw');
  const FILES = {
    videos: path.join(dir, 'videos.json'),
    countries: path.join(dir, 'countries.json'),
    users: path.join(dir, 'users.json'),
    blocked: path.join(dir, 'blocked.json'),
    pages: path.join(dir, 'pages.json'),
    visitors: path.join(dir, 'visitors.json'),
    funnel: path.join(dir, 'funnel.json'),
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
    pages: load(FILES.pages, {}),
    visitors: load(FILES.visitors, { byDay: {}, seenByDay: {} }),
    funnel: load(FILES.funnel, { byDay: {} }),
  };
  if (!roll.visitors.byDay) roll.visitors.byDay = {};
  if (!roll.visitors.seenByDay) roll.visitors.seenByDay = {};
  if (!roll.funnel.byDay) roll.funnel.byDay = {};

  // Ephemeral: distinct viewIds already counted (so heartbeats don't re-count a
  // "view"). Reset daily; a viewId continuing across a reset double-counts once.
  let countedViews = new Set();
  // Distinct deviceIds seen as page visitors today (for unique-visitor counting).
  let countedDevices = new Set();
  let countedDay = dayKey(Date.now());
  let dirty = false;

  function rollDay() {
    const today = dayKey(Date.now());
    if (today !== countedDay) { countedViews = new Set(); countedDevices = new Set(); countedDay = today; }
  }

  function capByDay(obj) {
    const days = Object.keys(obj);
    if (days.length <= dayWindow) return;
    days.sort();
    for (const d of days.slice(0, days.length - dayWindow)) delete obj[d];
  }

  function cleanString(v, max = 220) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s ? s.slice(0, max) : null;
  }

  function cleanNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function deviceSummary(device = {}) {
    const parts = [device.type, device.os, device.browser, device.viewport].map((v) => cleanString(v, 80)).filter(Boolean);
    return parts.join(' · ') || null;
  }

  function normalizeEvent(e = {}, type = 'watch') {
    const geo = e.geo || {};
    const device = e.device || {};
    const cc = cleanString(e.cc || e.countryCode || geo.cc || geo.countryCode, 2);
    return {
      t: cleanNum(e.t) || Date.now(),
      type,
      videoId: cleanString(e.video || e.videoId, 260),
      videoTitle: cleanString(e.videoTitle || e.title, 260),
      path: cleanString(e.path, 240),
      referrer: cleanString(e.referrer || e.ref, 500),
      eventType: cleanString(e.eventType, 80),
      productId: cleanString(e.productId, 160),
      provider: cleanString(e.provider, 80),
      visitorId: cleanString(e.visitorId, 160),
      viewId: cleanString(e.viewId || e.vid, 120),
      sessionId: cleanString(e.sessionId || e.sid, 120),
      userId: cleanString(e.userId || e.uid, 120),
      username: cleanString(e.username || e.user, 160),
      subscriber: !!e.subscriber,
      ip: cleanString(e.ip, 160),
      cc: cc ? cc.toUpperCase() : null,
      country: cleanString(e.countryName || e.country || geo.countryName || geo.country, 160),
      city: cleanString(e.city || geo.city, 160),
      region: cleanString(e.region || geo.region, 160),
      lat: cleanNum(e.lat ?? geo.lat),
      lon: cleanNum(e.lon ?? geo.lon),
      seconds: Math.max(0, Math.min(cleanNum(e.seconds ?? e.dt) || 0, 300)),
      position: cleanNum(e.position ?? e.pos),
      duration: cleanNum(e.duration ?? e.dur),
      deviceId: cleanString(e.deviceId || device.id, 160),
      device: {
        id: cleanString(device.id || e.deviceId, 160),
        type: cleanString(device.type, 80),
        os: cleanString(device.os, 80),
        browser: cleanString(device.browser, 80),
        viewport: cleanString(device.viewport, 80),
        ua: cleanString(device.ua, 260),
      },
      reason: cleanString(e.reason, 160),
      meta: e.meta && typeof e.meta === 'object' ? e.meta : {},
    };
  }

  function writeRaw(ev) {
    const day = dayKey(ev.t);
    try { fs.appendFileSync(path.join(RAW_DIR, `${day}.jsonl`), JSON.stringify(ev) + '\n'); } catch { /* analytics is best-effort */ }
  }

  /**
   * Record a non-bot watch event:
   *   { t, video, viewId, userId|null, ip, cc|null, dt }  (dt = seconds watched)
   */
  function record(e) {
    rollDay();
    const ev = normalizeEvent(e, 'watch');
    const t = ev.t;
    const day = dayKey(t);
    const dt = ev.seconds; // clamp a single heartbeat
    const firstHeartbeat = ev.viewId && !countedViews.has(ev.viewId);
    if (ev.viewId) countedViews.add(ev.viewId);

    // per-video
    const v = (roll.videos[ev.videoId] ||= { views: 0, totalSeconds: 0, byDay: {} });
    v.totalSeconds += dt;
    const vd = (v.byDay[day] ||= { views: 0, seconds: 0 });
    vd.seconds += dt;
    if (firstHeartbeat) { v.views += 1; vd.views += 1; }
    capByDay(v.byDay);

    // per-country
    if (ev.cc) {
      const c = (roll.countries[ev.cc] ||= { views: 0, seconds: 0 });
      c.seconds += dt;
      if (firstHeartbeat) c.views += 1;
    }

    // per-user (registered viewers)
    if (ev.userId) {
      const u = (roll.users[ev.userId] ||= { totalSeconds: 0, byVideo: {}, ips: [], devices: [], views: 0, lastCountry: null, lastSeen: 0 });
      u.totalSeconds += dt;
      u.byVideo[ev.videoId] = (u.byVideo[ev.videoId] || 0) + dt;
      u.lastSeen = t;
      if (ev.cc) u.lastCountry = ev.cc;
      if (ev.ip && !u.ips.includes(ev.ip)) { u.ips.unshift(ev.ip); u.ips = u.ips.slice(0, 8); }
      if (ev.deviceId && !u.devices.some((d) => d.id === ev.deviceId)) {
        u.devices.unshift({ id: ev.deviceId, label: deviceSummary(ev.device), lastSeen: t });
        u.devices = u.devices.slice(0, 8);
      }
      if (firstHeartbeat) u.views += 1;
    }

    // totals
    roll.totals.seconds += dt;
    if (firstHeartbeat) roll.totals.views += 1;

    dirty = true;

    writeRaw(ev);
  }

  /** Record a blocked access attempt (country/IP/user-blocked visitor). */
  function recordBlocked(ctx, reason) {
    if (ctx && ctx.isBot) return; // bots excluded from analytics everywhere
    rollDay();
    const day = dayKey(Date.now());
    roll.blocked.total += 1;
    roll.blocked.byDay[day] = (roll.blocked.byDay[day] || 0) + 1;
    const cc = ctx && ctx.country;
    if (cc) roll.blocked.byCountry[cc] = (roll.blocked.byCountry[cc] || 0) + 1;
    capByDay(roll.blocked.byDay);
    writeRaw(normalizeEvent({
      t: Date.now(),
      cc: cc || null,
      ip: (ctx && ctx.ip) || null,
      reason: reason || null,
      userId: ctx && ctx.user && ctx.user.id,
      username: ctx && ctx.user && (ctx.user.username || ctx.user.email),
      subscriber: !!(ctx && ctx.isMember),
      geo: ctx && ctx.geo,
      device: ctx && ctx.device,
    }, 'blocked'));
    dirty = true;
  }

  function recordActivity(type, e = {}) {
    writeRaw(normalizeEvent(e, type || 'activity'));
  }

  /** Record a page visit (non-bot, client-beacon verified). */
  function recordVisit(e = {}) {
    rollDay();
    const t = cleanNum(e.t) || Date.now();
    const day = dayKey(t);
    const visitPath = cleanString(e.path, 200) || '/';
    const deviceId = cleanString(e.deviceId, 64);
    const visitorId = cleanString(e.visitorId, 160);
    const sessionId = cleanString(e.sessionId, 120);

    // per-page rollup
    const p = (roll.pages[visitPath] ||= { visits: 0, byDay: {} });
    p.visits += 1;
    p.byDay[day] = (p.byDay[day] || 0) + 1;
    capByDay(p.byDay);

    // daily visitor totals
    const vd = (roll.visitors.byDay[day] ||= { pageViews: 0, uniqueVisitors: 0 });
    vd.pageViews += 1;
    const distinctKey = visitorId || deviceId;
    const seen = new Set(Array.isArray(roll.visitors.seenByDay[day]) ? roll.visitors.seenByDay[day] : []);
    if (distinctKey && !seen.has(distinctKey)) {
      seen.add(distinctKey);
      roll.visitors.seenByDay[day] = [...seen];
      if (day === countedDay) countedDevices.add(distinctKey);
      vd.uniqueVisitors += 1;
    }
    capByDay(roll.visitors.byDay);
    capByDay(roll.visitors.seenByDay);

    dirty = true;
    writeRaw({
      t, type: 'visit',
      ip: cleanString(e.ip, 160),
      cc: cleanString(e.cc || e.country, 2) ? String(e.cc || '').toUpperCase() || null : null,
      country: cleanString(e.country, 160),
      city: cleanString(e.city, 160),
      region: cleanString(e.region, 160),
      path: visitPath,
      referrer: cleanString(e.referrer, 500),
      visitorId,
      deviceId,
      sessionId,
      device: e.device && typeof e.device === 'object'
        ? {
            id: deviceId,
            type: cleanString(e.device.type, 80),
            os: cleanString(e.device.os, 80),
            browser: cleanString(e.device.browser, 80),
            viewport: cleanString(e.device.viewport, 80),
            ua: cleanString(e.device.ua, 260),
          }
        : {},
      userId: cleanString(e.userId, 120),
      username: cleanString(e.username, 160),
    });
  }

  function recordFunnelEvent(e = {}) {
    rollDay();
    const eventType = cleanString(e.eventType, 80);
    if (!eventType) return;
    const t = cleanNum(e.t) || Date.now();
    const day = dayKey(t);
    const d = (roll.funnel.byDay[day] ||= {});
    d[eventType] = (d[eventType] || 0) + 1;
    capByDay(roll.funnel.byDay);
    dirty = true;
    writeRaw(normalizeEvent({
      ...e,
      t,
      meta: e.metadata || e.meta || {},
    }, `funnel.${eventType}`));
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
      writeAtomic(FILES.pages, roll.pages);
      writeAtomic(FILES.visitors, roll.visitors);
      writeAtomic(FILES.funnel, roll.funnel);
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

  /**
   * Most recent raw events across the retained daily logs (newest first).
   * Each: { t, video, userId, ip, cc, dt, blocked, reason }. Used by the admin
   * analytics panel to surface individual viewer locations + IP addresses.
   */
  function decodeRaw(e) {
    if (e.type || e.videoId || e.seconds != null || e.deviceId) {
      const ev = normalizeEvent(e, e.type || (e.blocked ? 'blocked' : 'watch'));
      if (e.blocked) ev.type = 'blocked';
      if (e.reason) ev.reason = e.reason;
      return ev;
    }
    return normalizeEvent({
      t: e.t, video: e.v, userId: e.uid, ip: e.ip, cc: e.cc, dt: e.dt,
      reason: e.reason,
    }, e.blocked ? 'blocked' : 'watch');
  }

  function readRawEvents() {
    let files = [];
    try { files = fs.readdirSync(RAW_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse(); }
    catch { return []; }
    const out = [];
    for (const f of files) {
      let lines = [];
      try { lines = fs.readFileSync(path.join(RAW_DIR, f), 'utf-8').split('\n'); } catch { continue; }
      // Walk newest-first within each (chronological) file.
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i].trim();
        if (!ln) continue;
        let e; try { e = JSON.parse(ln); } catch { continue; }
        out.push(decodeRaw(e));
      }
    }
    return out;
  }

  /**
   * Collapse a view's per-heartbeat 'watch' rows into ONE "watched" entry so the
   * activity feed shows a single line per view instead of a fresh row every few
   * seconds while someone keeps watching. Heartbeats are grouped by viewId (or, for
   * older events without one, by ip+video+device). The most-recent heartbeat is kept
   * as the representative (so it sorts to the top while the view is live) and the
   * watched-seconds of the whole group are summed onto it; the furthest position is
   * retained. Non-watch events (blocked, etc.) pass through untouched. Input and
   * output are both newest-first. Never mutates the cached raw events.
   */
  function collapseWatchEvents(events) {
    const out = [];
    const groupIndex = new Map(); // dedup key -> index of the representative in `out`
    for (const e of events) {
      if (e.type !== 'watch') { out.push(e); continue; }
      const key = e.viewId ? `v:${e.viewId}`
        : (e.ip || e.videoId || e.deviceId) ? `f:${e.ip || ''}|${e.videoId || ''}|${e.deviceId || ''}`
          : null;
      if (key == null) { out.push(e); continue; } // nothing to group on — keep as-is
      const at = groupIndex.get(key);
      if (at == null) {
        groupIndex.set(key, out.length);
        out.push({ ...e }); // copy so we never touch the cached raw event
      } else {
        const rep = out[at];
        rep.seconds = (rep.seconds || 0) + (e.seconds || 0);
        const pos = cleanNum(e.position);
        if (pos != null && (rep.position == null || pos > rep.position)) rep.position = pos;
        if (rep.duration == null && cleanNum(e.duration) != null) rep.duration = e.duration;
      }
    }
    return out;
  }

  function getRecentEvents(limit = 200) {
    return collapseWatchEvents(readRawEvents()).slice(0, limit).map((e) => ({
      t: e.t, video: e.videoId || null, videoTitle: e.videoTitle || null, userId: e.userId || null,
      username: e.username || null, subscriber: !!e.subscriber,
      ip: e.ip || null, cc: e.cc || null, country: e.country || null, city: e.city || null, region: e.region || null,
      lat: e.lat, lon: e.lon, dt: e.seconds || 0, seconds: e.seconds || 0,
      position: e.position, duration: e.duration,
      deviceId: e.deviceId || null, device: e.device || {},
      sessionId: e.sessionId || null, viewId: e.viewId || null,
      blocked: e.type === 'blocked', type: e.type, reason: e.reason || null,
    }));
  }

  function boundsFromFilters(filters = {}) {
    const from = filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from) ? Date.parse(`${filters.from}T00:00:00.000Z`) : null;
    const to = filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to) ? Date.parse(`${filters.to}T23:59:59.999Z`) : null;
    return { from, to };
  }

  function eventMatches(e, filters = {}) {
    const { from, to } = boundsFromFilters(filters);
    if (from != null && e.t < from) return false;
    if (to != null && e.t > to) return false;
    if (filters.type && e.type !== filters.type) return false;
    if (filters.userId && e.userId !== filters.userId) return false;
    if (filters.videoId && e.videoId !== filters.videoId) return false;
    if (filters.ip && e.ip !== filters.ip) return false;
    if (filters.cc && e.cc !== String(filters.cc).toUpperCase()) return false;
    if (filters.subscriber != null && String(filters.subscriber) !== '' && e.subscriber !== (filters.subscriber === true || filters.subscriber === 'true' || filters.subscriber === '1')) return false;
    const q = cleanString(filters.q, 160);
    if (q) {
      const hay = [
        e.type, e.username, e.userId, e.ip, e.cc, e.country, e.city, e.region,
        e.videoTitle, e.videoId, e.deviceId, deviceSummary(e.device), e.reason,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  }

  function publicLogEvent(e) {
    return {
      t: e.t,
      timestamp: new Date(e.t).toISOString(),
      type: e.type,
      username: e.username || null,
      userId: e.userId || null,
      subscriber: !!e.subscriber,
      ip: e.ip || null,
      country: e.country || null,
      cc: e.cc || null,
      city: e.city || null,
      region: e.region || null,
      lat: e.lat,
      lon: e.lon,
      videoId: e.videoId || null,
      videoTitle: e.videoTitle || null,
      path: e.path || null,
      referrer: e.referrer || null,
      eventType: e.eventType || (e.type && e.type.startsWith('funnel.') ? e.type.slice('funnel.'.length) : null),
      productId: e.productId || null,
      provider: e.provider || null,
      visitorId: e.visitorId || null,
      device: e.device || {},
      deviceLabel: deviceSummary(e.device),
      deviceId: e.deviceId || null,
      sessionId: e.sessionId || null,
      viewId: e.viewId || null,
      seconds: e.seconds || 0,
      position: e.position,
      duration: e.duration,
      reason: e.reason || null,
      meta: e.meta || {},
    };
  }

  function queryLogs(filters = {}) {
    const limit = Math.min(Math.max(parseInt(filters.limit || '200', 10) || 200, 1), 1000);
    const start = Math.max(parseInt(filters.cursor || '0', 10) || 0, 0);
    const raw = readRawEvents();
    // Filter first, then collapse repeated heartbeats into one "watched" row so the
    // logs view isn't flooded with a line every few seconds per live viewer. The
    // cursor paginates over the collapsed list (it's an opaque offset to callers).
    const matched = raw.filter((e) => eventMatches(e, filters));
    const collapsed = collapseWatchEvents(matched);
    const events = collapsed.slice(start, start + limit).map(publicLogEvent);
    const nextCursor = start + limit < collapsed.length ? String(start + limit) : null;
    return { events, nextCursor, totalScanned: raw.length };
  }

  function csvCell(v) {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportLogsCsv(filters = {}) {
    const rows = queryLogs({ ...filters, limit: 10000 }).events;
    const lines = [CSV_COLUMNS.join(',')];
    for (const e of rows) {
      lines.push(CSV_COLUMNS.map((col) => {
        if (col === 'timestamp') return csvCell(e.timestamp);
        if (col === 'countryCode') return csvCell(e.cc);
        if (col === 'content') return csvCell(e.videoTitle);
        if (col === 'device') return csvCell(e.deviceLabel);
        return csvCell(e[col]);
      }).join(','));
    }
    return `${lines.join('\n')}\n`;
  }

  function getTrafficMarkers(filters = {}) {
    const raw = readRawEvents().filter((e) => e.type === 'watch' || e.type === 'blocked').filter((e) => eventMatches(e, filters));
    const seenCoords = new Map();
    return raw.map((e, index) => {
      let lat = cleanNum(e.lat);
      let lon = cleanNum(e.lon);
      // Reject failed-geo coordinates so they don't plot in the ocean: 0,0 ("Null
      // Island", Gulf of Guinea) and anything out of range. These fall through to
      // the country-centroid path in the traffic endpoint instead.
      const precise = lat != null && lon != null
        && !(Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01)
        && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
      if (!precise) return null;
      const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
      const dupe = seenCoords.get(key) || 0;
      seenCoords.set(key, dupe + 1);
      if (dupe) {
        const angle = dupe * 2.399963;
        lat += Math.sin(angle) * 0.035;
        lon += Math.cos(angle) * 0.035;
      }
      return {
        id: `${e.t}-${index}`,
        type: e.type,
        lat, lon, precise,
        city: e.city || null,
        region: e.region || null,
        country: e.country || null,
        cc: e.cc || null,
        username: e.username || null,
        userId: e.userId || null,
        subscriber: !!e.subscriber,
        ip: e.ip || null,
        videoId: e.videoId || null,
        videoTitle: e.videoTitle || null,
        deviceId: e.deviceId || null,
        device: e.device || {},
        sessionId: e.sessionId || null,
        viewId: e.viewId || null,
        seconds: e.seconds || 0,
        t: e.t,
        reason: e.reason || null,
      };
    }).filter(Boolean);
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

  /** Per-page visit counts for a date range (fromDay/toDay as YYYY-MM-DD strings). */
  function getPageStats(fromDay, toDay) {
    return Object.entries(roll.pages).map(([p, s]) => {
      let visits = 0;
      for (const [day, n] of Object.entries(s.byDay || {})) {
        if (fromDay && day < fromDay) continue;
        if (toDay && day > toDay) continue;
        visits += n || 0;
      }
      if (!visits) return null;
      return { path: p, visits };
    }).filter(Boolean).sort((a, b) => b.visits - a.visits);
  }

  /** Aggregate page views + unique visitors for a date range. */
  function getVisitorStats(fromDay, toDay) {
    let pageViews = 0, uniqueVisitors = 0;
    for (const [day, d] of Object.entries(roll.visitors.byDay || {})) {
      if (fromDay && day < fromDay) continue;
      if (toDay && day > toDay) continue;
      pageViews += d.pageViews || 0;
      uniqueVisitors += d.uniqueVisitors || 0;
    }
    return { pageViews, uniqueVisitors };
  }

  function getVisitorSeries(fromDay, toDay) {
    return Object.entries(roll.visitors.byDay || {})
      .filter(([day]) => (!fromDay || day >= fromDay) && (!toDay || day <= toDay))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, d]) => ({ day, pageViews: d.pageViews || 0, uniqueVisitors: d.uniqueVisitors || 0 }));
  }

  function getFunnelStats(fromDay, toDay) {
    const totals = {};
    const series = Object.entries(roll.funnel.byDay || {})
      .filter(([day]) => (!fromDay || day >= fromDay) && (!toDay || day <= toDay))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, d]) => {
        const row = { day };
        for (const [k, n] of Object.entries(d || {})) {
          row[k] = n || 0;
          totals[k] = (totals[k] || 0) + (n || 0);
        }
        return row;
      });
    const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : 0);
    const buys = totals.buy_click || 0;
    const starts = totals.checkout_started || 0;
    const grants = totals.payment_granted || 0;
    return {
      totals,
      conversion: {
        buyToCheckout: pct(starts, buys),
        checkoutToGrant: pct(grants, starts),
        buyToGrant: pct(grants, buys),
      },
      series,
    };
  }

  function getVisitorProfile(visitorId, { comments = [] } = {}) {
    const vid = cleanString(visitorId, 160);
    if (!vid) return null;
    const rawActivity = readRawEvents()
      .filter((e) => e.visitorId === vid)
      .map(publicLogEvent);
    const commentRows = (Array.isArray(comments) ? comments : [])
      .filter((c) => c && c.visitorId === vid)
      .map((c) => ({ ...c, type: 'comment', t: c.ts || 0 }));
    const activity = rawActivity
      .map((e) => ({ ...e, type: e.type === 'funnel' && e.eventType ? `funnel.${e.eventType}` : e.type }))
      .sort((a, b) => (b.t || 0) - (a.t || 0));
    const ips = [...new Set(rawActivity.map((e) => e.ip).filter(Boolean))];
    const devices = [];
    const seenDevices = new Map();
    for (const e of rawActivity) {
      const d = e.device || {};
      const id = e.deviceId || d.id;
      const key = id || e.deviceLabel;
      if (!key) continue;
      const next = { id: id || null, type: d.type || null, os: d.os || null, browser: d.browser || null, viewport: d.viewport || null, ua: d.ua || null, label: e.deviceLabel || null };
      const existing = seenDevices.get(key);
      if (existing) {
        for (const [k, v] of Object.entries(next)) if (!existing[k] && v) existing[k] = v;
      } else {
        seenDevices.set(key, next);
        devices.push(next);
      }
    }
    // Where they're based: the dominant country across all events, with the
    // finest-grained region/city/coords we ever captured for that country.
    // (Best-effort; the visitor endpoint may further enrich this from the IP.)
    const ccTally = {};
    for (const e of rawActivity) if (e.cc) ccTally[e.cc] = (ccTally[e.cc] || 0) + 1;
    const cc = Object.entries(ccTally).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    let location = null;
    const sortedDesc = [...rawActivity].sort((a, b) => (b.t || 0) - (a.t || 0));
    for (const e of sortedDesc) {
      if (cc && e.cc && e.cc !== cc) continue;
      location ||= { cc: cc || e.cc || null, country: null, region: null, city: null, lat: null, lon: null };
      if (!location.country && e.country) location.country = e.country;
      if (!location.region && e.region) location.region = e.region;
      if (!location.city && e.city) location.city = e.city;
      if (location.lat == null && e.lat != null) { location.lat = e.lat; location.lon = e.lon; }
    }
    const times = rawActivity.map((e) => e.t || 0).filter(Boolean);
    return {
      visitorId: vid,
      summary: {
        pageViews: rawActivity.filter((e) => e.type === 'visit').length,
        watches: rawActivity.filter((e) => e.type === 'watch').length,
        funnelEvents: rawActivity.filter((e) => e.type && e.type.startsWith('funnel.')).length,
        comments: commentRows.length,
      },
      location,
      firstSeen: times.length ? Math.min(...times) : null,
      lastSeen: times.length ? Math.max(...times) : null,
      ips,
      devices,
      comments: commentRows.sort((a, b) => (b.t || 0) - (a.t || 0)),
      activity,
    };
  }

  // Periodic flush + daily prune; unref so neither holds the process open.
  const flushTimer = setInterval(() => flush(), 45_000); flushTimer.unref();
  const pruneTimer = setInterval(() => pruneRaw(), 6 * 60 * 60 * 1000); pruneTimer.unref();
  pruneRaw();

  return {
    config: { rawRetentionDays, dayWindow },
    record, recordBlocked, recordActivity, recordVisit, recordFunnelEvent, flush, pruneRaw,
    getVideoStats, getAllVideoStats, getCountryStats,
    getUserStats, getAllUserStats, getBlockedStats, getTotals,
    getPageStats, getVisitorStats, getVisitorSeries, getFunnelStats, getVisitorProfile,
    getRecentEvents, queryLogs, exportLogsCsv, getTrafficMarkers,
  };
}
