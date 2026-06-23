// In-memory registry for resumable chunked uploads with parallel chunk support.
//
// Each session tracks received byte ranges so chunks can arrive out of order.
// The .part file is pre-allocated to the declared size on init (caller's job);
// the chunk handler does positional writes at exact offsets. `received` is the
// total bytes across all ranges; `contiguousBytes()` returns the largest N
// where [0,N) is fully covered (used by the status endpoint for resume).

const sessions = new Map(); // uploadId -> session

/** Register a new upload. `fields` carries partPath/savedPath/name/size + opts. */
export function createSession(uploadId, fields, now = Date.now()) {
  const session = { id: uploadId, received: 0, ranges: [], lastActive: now, ...fields };
  sessions.set(uploadId, session);
  return session;
}

export function getSession(uploadId) {
  return sessions.get(uploadId) || null;
}

export function touch(session, now = Date.now()) {
  if (session) session.lastActive = now;
}

export function deleteSession(uploadId) {
  sessions.delete(uploadId);
}

export function count() {
  return sessions.size;
}

/** Merge a [start, end) range into a sorted, non-overlapping range list. */
function mergeRange(ranges, start, end) {
  const merged = [];
  let i = 0;
  // Add all ranges that end before the new range starts.
  while (i < ranges.length && ranges[i][1] < start) merged.push(ranges[i++]);
  // Merge overlapping/adjacent ranges.
  let s = start, e = end;
  while (i < ranges.length && ranges[i][0] <= e) {
    s = Math.min(s, ranges[i][0]);
    e = Math.max(e, ranges[i][1]);
    i++;
  }
  merged.push([s, e]);
  // Add remaining ranges.
  while (i < ranges.length) merged.push(ranges[i++]);
  return merged;
}

/** Record that bytes [start, end) have been received. Updates ranges + total. */
export function addRange(session, start, end) {
  session.ranges = mergeRange(session.ranges, start, end);
  session.received = session.ranges.reduce((sum, r) => sum + (r[1] - r[0]), 0);
}

/** Check if [start, end) is already fully covered by received ranges. */
export function isRangeReceived(session, start, end) {
  for (const [rs, re] of session.ranges) {
    if (rs <= start && re >= end) return true;
  }
  return false;
}

/** Largest N where [0, N) is fully received. Used for resume offset. */
export function contiguousBytes(session) {
  if (!session.ranges.length || session.ranges[0][0] !== 0) return 0;
  return session.ranges[0][1];
}

/**
 * Validate an incoming chunk BEFORE writing it. Accepts out-of-order chunks.
 * Returns { ok:true, skip?:true } or { ok:false, status, error }.
 * `skip:true` means the chunk is already received (idempotent — no write needed).
 */
export function validateChunk(session, offset, chunkLen, cap) {
  if (!session) {
    return { ok: false, status: 404, error: 'Upload session not found — start the upload again.' };
  }
  if (!Number.isFinite(offset) || offset < 0) {
    return { ok: false, status: 400, error: 'Invalid chunk offset.' };
  }
  if (!Number.isFinite(chunkLen) || chunkLen <= 0) {
    return { ok: false, status: 400, error: 'Empty or invalid chunk.' };
  }
  if (offset + chunkLen > session.size) {
    return { ok: false, status: 400, error: 'Chunk would exceed the declared file size.' };
  }
  if (offset + chunkLen > cap) {
    return { ok: false, status: 413, error: 'File too large.' };
  }
  if (isRangeReceived(session, offset, offset + chunkLen)) {
    return { ok: true, skip: true };
  }
  return { ok: true };
}

/** Confirm the full file has arrived before finalizing. */
export function validateComplete(session) {
  if (!session) {
    return { ok: false, status: 404, error: 'Upload session not found — start the upload again.' };
  }
  if (session.received !== session.size) {
    return {
      ok: false, status: 400,
      error: `Upload incomplete — server has ${session.received} of ${session.size} bytes.`,
      expected: contiguousBytes(session),
    };
  }
  return { ok: true };
}

/**
 * Remove sessions idle longer than `maxIdleMs`. Returns the removed sessions so
 * the caller can unlink their `.part` files. Pure w.r.t. fs.
 */
export function sweepStale(maxIdleMs, now = Date.now()) {
  const removed = [];
  for (const [id, s] of sessions) {
    if (now - s.lastActive > maxIdleMs) {
      removed.push(s);
      sessions.delete(id);
    }
  }
  return removed;
}
