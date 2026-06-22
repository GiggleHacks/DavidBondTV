// Per-video like/dislike store. JSON file keyed by video id, then by user id:
//   { "<videoId>": { "<userId>": 1 | -1 } }
// Mirrors the lib/comments-store.js persistence style. Votes are deduped per
// user (one vote per user per video); re-voting the same way clears it (toggle).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

function readStore(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

function tally(votes) {
  let likes = 0;
  let dislikes = 0;
  for (const v of Object.values(votes || {})) {
    if (v === 1) likes += 1;
    else if (v === -1) dislikes += 1;
  }
  return { likes, dislikes };
}

/** Counts for a video: { likes, dislikes }. */
export function getCounts(filePath, video) {
  return tally(readStore(filePath)[video]);
}

/** A user's current vote on a video: 1, -1, or 0. */
export function getUserVote(filePath, video, userId) {
  const v = readStore(filePath)[video];
  return (v && v[userId]) || 0;
}

/**
 * Set (or toggle/clear) a user's vote. `vote` ∈ {1, -1, 0}. Passing the same
 * value the user already has clears it (toggle off). Returns { likes, dislikes, mine }.
 */
export async function setVote(filePath, video, userId, vote) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const store = readStore(filePath);
  if (!store[video] || typeof store[video] !== 'object') store[video] = {};
  const current = store[video][userId] || 0;

  let next = 0;
  if (vote === 1 || vote === -1) next = current === vote ? 0 : vote; // toggle off if repeated

  if (next === 0) delete store[video][userId];
  else store[video][userId] = next;

  await fsp.writeFile(filePath, JSON.stringify(store, null, 2), 'utf8');
  return { ...tally(store[video]), mine: next };
}
