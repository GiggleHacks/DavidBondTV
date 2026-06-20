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
export function validateComment({ name, anonymous, text }) {
  // --- text ---
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, error: 'Comment text is required.' };
  }
  const cleanText = stripControls(text);
  if (cleanText.trim().length === 0) {
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

  // Build the stored comment
  const stored = {
    id: comment.id ?? crypto.randomUUID(),
    name: comment.name,
    text: comment.text,
    ts: comment.ts ?? Date.now(),
  };

  // Read → mutate → write (synchronous read to keep things simple)
  const store = readStore(filePath);
  if (!Array.isArray(store[video])) {
    store[video] = [];
  }
  store[video].push(stored);

  await fsp.writeFile(filePath, JSON.stringify(store, null, 2), 'utf8');

  return stored;
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
