// Free "Subscribe" (follow) store for the single David Bond TV channel. Backed by
// data/subscribers.json: { "<userId>": <subscribedAt ms>, ... }. Small + low
// frequency → synchronous read/write. The growth series is derived from the
// stored subscribe timestamps (cumulative count per day), so no separate rollup.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'subscribers.json');

function read() {
  try {
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch { /* missing/corrupt */ }
  return {};
}
function write(o) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(o, null, 2));
}

export function isSubscribed(userId) {
  if (!userId) return false;
  return Object.prototype.hasOwnProperty.call(read(), userId);
}

export function count() {
  return Object.keys(read()).length;
}

/** Subscribe a user (idempotent). `now` injectable for tests. Returns { subscribed, count }. */
export function subscribe(userId, now = Date.now()) {
  if (!userId) return { subscribed: false, count: count() };
  const o = read();
  if (!o[userId]) { o[userId] = now; write(o); }
  return { subscribed: true, count: Object.keys(o).length };
}

/** Unsubscribe a user (idempotent). Returns { subscribed:false, count }. */
export function unsubscribe(userId) {
  const o = read();
  if (o[userId]) { delete o[userId]; write(o); }
  return { subscribed: false, count: Object.keys(o).length };
}

/**
 * Cumulative subscriber count for each of the last `days` days (oldest→newest),
 * derived from subscribe timestamps. Returns [{ day:'YYYY-MM-DD', count }].
 * `now` injectable for tests.
 */
export function series(days = 28, now = Date.now()) {
  const stamps = Object.values(read()).sort((a, b) => a - b);
  const out = [];
  const DAY = 86400000;
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const dayEnd = todayStart.getTime() - (i - 1) * DAY; // end-of-day boundary
    const d = new Date(todayStart.getTime() - i * DAY);
    const key = d.toISOString().slice(0, 10);
    // cumulative count of subs whose timestamp is before this day's end
    let c = 0;
    for (const t of stamps) { if (t < dayEnd) c += 1; else break; }
    out.push({ day: key, count: c });
  }
  return out;
}
