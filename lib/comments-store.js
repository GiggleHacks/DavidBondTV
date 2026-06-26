import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Strip ASCII control chars (0x00–0x1F, 0x7F) EXCEPT newline (0x0A) and tab (0x09).
 */
function stripControls(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * validateComment({ name, anonymous, text })
 * Returns { ok: true, value: { name, text } } or { ok: false, error: string }
 */
export function validateComment({ name, anonymous, text, hasGif = false }) {
  // --- text --- (a GIF-only comment may have empty text)
  const rawText = typeof text === 'string' ? text : '';
  const cleanText = stripControls(rawText);
  if (cleanText.trim().length === 0 && !hasGif) {
    return { ok: false, error: 'Comment text is required.' };
  }
  if (cleanText.length > 1000) {
    return { ok: false, error: 'Comment is too long (max 1000 characters).' };
  }

  // --- name ---
  let cleanName;
  if (anonymous) {
    cleanName = 'Anonymous';
  } else {
    const raw = typeof name === 'string' ? stripControls(name).trim() : '';
    if (raw.length === 0) {
      cleanName = 'Anonymous';
    } else {
      cleanName = raw.slice(0, 60);
    }
  }

  return { ok: true, value: { name: cleanName, text: cleanText } };
}

/**
 * Read the comments JSON file, defaulting to {} if missing or corrupt.
 */
function readStore(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * addComment(filePath, video, comment)
 * Appends the comment to the video's array in the JSON store.
 * Returns the stored comment (with generated id/ts if not provided).
 */
export async function addComment(filePath, video, comment) {
  // Ensure directory exists
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });

  // Build the stored comment. Identity/flag fields are optional so old comments
  // (which lack them) keep working and simply render as anonymous, no flag.
  const stored = {
    id: comment.id ?? crypto.randomUUID(),
    name: comment.name,
    text: comment.text,
    ts: comment.ts ?? Date.now(),
  };
  if (comment.userId) stored.userId = comment.userId;
  if (comment.username) stored.username = comment.username;
  if (comment.admin) stored.admin = true; // site administrator → shows a badge
  if (comment.gifUrl) stored.gifUrl = comment.gifUrl; // validated Tenor GIF (optional)
  if (comment.avatar) stored.avatar = comment.avatar; // resolved URL for registered users
  if (comment.avatarSeed) stored.avatarSeed = comment.avatarSeed; // anon avatar variation
  if (comment.country) stored.country = comment.country; // ISO-2 code

  // Read → mutate → write (synchronous read to keep things simple)
  const store = readStore(filePath);
  if (!Array.isArray(store[video])) {
    store[video] = [];
  }

  // Replies carry a parentId pointing at their ROOT comment. Threads are kept
  // single-level: if someone replies to a reply, re-home the new comment under
  // that reply's own root so the tree never grows past one level deep. parentId
  // is only stored when it resolves to a real comment in this video.
  if (comment.parentId) {
    const parent = store[video].find((c) => c && c.id === comment.parentId);
    if (parent) stored.parentId = parent.parentId || parent.id;
  }

  store[video].push(stored);

  await fsp.writeFile(filePath, JSON.stringify(store, null, 2), 'utf8');

  return stored;
}

/**
 * readAllComments(filePath)
 * Returns the whole store as { videoId: [comment, …] } (admin community inbox).
 */
export function readAllComments(filePath) {
  return readStore(filePath);
}

/**
 * listComments(filePath, video)
 * Returns the video's comments newest-first (by ts), or [].
 */
export function listComments(filePath, video) {
  const store = readStore(filePath);
  const comments = store[video];
  if (!Array.isArray(comments)) return [];
  return [...comments].sort((a, b) => b.ts - a.ts);
}

/**
 * threadComments(flat)
 * Groups a flat comment array into a single-level thread: returns the root
 * comments (no parentId) newest-first, each decorated with `replies` (its replies
 * oldest-first, YouTube order) and `replyCount`. Pure — no I/O.
 */
export function threadComments(flat) {
  const list = Array.isArray(flat) ? flat : [];
  const roots = [];
  const repliesByParent = new Map();
  for (const c of list) {
    if (!c) continue;
    if (c.parentId) {
      if (!repliesByParent.has(c.parentId)) repliesByParent.set(c.parentId, []);
      repliesByParent.get(c.parentId).push(c);
    } else {
      roots.push(c);
    }
  }
  roots.sort((a, b) => b.ts - a.ts);
  return roots.map((root) => {
    const replies = (repliesByParent.get(root.id) || []).slice().sort((a, b) => a.ts - b.ts);
    return { ...root, replies, replyCount: replies.length };
  });
}

/**
 * deleteComment(filePath, video, commentId)
 * Removes a single comment by id from the video's array. Admin moderation.
 * Deleting a root comment also removes all of its replies (cascade).
 * Returns { ok: true } or { ok: false, error }.
 */
export async function deleteComment(filePath, video, commentId) {
  const store = readStore(filePath);
  const list = store[video];
  if (!Array.isArray(list)) return { ok: false, error: 'Not found' };
  const idx = list.findIndex((c) => c && c.id === commentId);
  if (idx === -1) return { ok: false, error: 'Not found' };
  // Drop the comment itself plus any replies parented to it.
  store[video] = list.filter((c) => c && c.id !== commentId && c.parentId !== commentId);
  await fsp.writeFile(filePath, JSON.stringify(store, null, 2), 'utf8');
  return { ok: true };
}
