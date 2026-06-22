// Site-wide notification feed + per-user read state. One JSON file:
//   { feed:  [ { id, videoId, title, thumb, ts } … newest first, capped ],
//     reads: { "<userId>": { seenTs, dismissed: [ids] } } }
// A single global feed (one entry per published video) keeps storage tiny; each
// signed-in user gets their own seen marker + dismissed set so the unread badge
// is personal. Mirrors the lib/reactions-store.js persistence style (sync read,
// async atomic write). Imported by lib/ingest.mjs (writes) + server.mjs (API).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'notifications.json');
const FEED_CAP = 100; // keep the feed small; old items age out

// Serialize writes so a release-burst (scheduler) can't clobber a concurrent
// mark-seen/dismiss from the API.
let lock = Promise.resolve();

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { feed: Array.isArray(parsed.feed) ? parsed.feed : [], reads: parsed.reads || {} };
    }
  } catch { /* missing/corrupt → empty */ }
  return { feed: [], reads: {} };
}

function update(mutator) {
  lock = lock.then(async () => {
    const store = readStore();
    const result = mutator(store);
    await fsp.mkdir(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
    await fsp.rename(tmp, FILE);
    return result;
  }).catch((e) => { console.error('notifications update failed:', e.message); });
  return lock;
}

/** Append a "new video" notification to the global feed. Best-effort. */
export function addNotification({ videoId, title, thumb } = {}) {
  if (!videoId || typeof videoId !== 'string') return Promise.resolve();
  return update((store) => {
    // Don't double-post the same video (e.g. a re-publish).
    if (store.feed.some((n) => n.videoId === videoId)) return;
    store.feed.unshift({
      id: crypto.randomUUID(),
      videoId,
      title: String(title || 'New video').slice(0, 200),
      thumb: typeof thumb === 'string' ? thumb : '',
      ts: Date.now(),
    });
    if (store.feed.length > FEED_CAP) store.feed.length = FEED_CAP;
  });
}

/**
 * The feed for one user, with their read state applied:
 *   { notifications: [ { …, read } ], unread }
 * Dismissed items are dropped entirely; unread = newer than the seen marker.
 *
 * `validVideoIds` (optional Set) restricts the feed to videos that still exist
 * and are published — so notifications for deleted/unpublished videos never show
 * or inflate the badge, even if their feed entries linger.
 */
export function listForUser(userId, validVideoIds = null) {
  const store = readStore();
  const r = (userId && store.reads[userId]) || { seenTs: 0, dismissed: [] };
  const seenTs = r.seenTs || 0;
  const dismissed = new Set(r.dismissed || []);
  const notifications = store.feed
    .filter((n) => !dismissed.has(n.id))
    .filter((n) => !validVideoIds || validVideoIds.has(n.videoId))
    .map((n) => ({ ...n, read: n.ts <= seenTs }));
  const unread = notifications.reduce((c, n) => c + (n.read ? 0 : 1), 0);
  return { notifications, unread };
}

/** Remove a video's feed entry when it's deleted, so it can't linger as a stale notification. */
export function removeNotificationForVideo(videoId) {
  if (!videoId) return Promise.resolve();
  return update((store) => {
    store.feed = store.feed.filter((n) => n.videoId !== videoId);
  });
}

/** Mark everything currently in the feed as seen for this user (clears badge). */
export function markSeen(userId) {
  if (!userId) return Promise.resolve();
  return update((store) => {
    const r = store.reads[userId] || (store.reads[userId] = { seenTs: 0, dismissed: [] });
    r.seenTs = Date.now();
  });
}

/** Hide a single notification for this user. */
export function dismiss(userId, id) {
  if (!userId || !id) return Promise.resolve();
  return update((store) => {
    const r = store.reads[userId] || (store.reads[userId] = { seenTs: 0, dismissed: [] });
    if (!r.dismissed.includes(id)) r.dismissed.push(id);
    // Prune dismissed ids that have aged out of the feed so it can't grow forever.
    const live = new Set(store.feed.map((n) => n.id));
    r.dismissed = r.dismissed.filter((x) => live.has(x));
  });
}

/** Dismiss every currently-visible notification for this user. */
export function clearAll(userId) {
  if (!userId) return Promise.resolve();
  return update((store) => {
    const r = store.reads[userId] || (store.reads[userId] = { seenTs: 0, dismissed: [] });
    r.dismissed = store.feed.map((n) => n.id);
    r.seenTs = Date.now();
  });
}
