// In-memory registry for resumable chunked uploads.
//
// Each session accumulates an admin's video upload into a single `.part` file on
// disk. `received` is the authoritative byte offset (== the .part size), so a
// failed upload resumes by re-sending from `received` instead of restarting at 0.
// The store is intentionally in-memory: a 502 / network drop does NOT restart the
// Node process, so the session survives the kind of failure this feature targets.
// (A full server restart drops sessions; the stale-.part sweeper reclaims disk.)
//
// The validators are pure (no fs / no Date in the hot path) so they unit-test
// cleanly; the route layer owns the actual disk writes.

const sessions = new Map(); // uploadId -> session

/** Register a new upload. `fields` carries partPath/savedPath/name/size + opts. */
export function createSession(uploadId, fields, now = Date.now()) {
  const session = { id: uploadId, received: 0, lastActive: now, ...fields };
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

/**
 * Validate an incoming chunk BEFORE writing it. Returns { ok:true } or
 * { ok:false, status, error, expected? }. `expected` lets the client resync to
 * the server's true offset after a partial/duplicate chunk.
 */
export function validateChunk(session, offset, chunkLen, cap) {
  if (!session) {
    return { ok: false, status: 404, error: 'Upload session not found — start the upload again.' };
  }
  if (!Number.isFinite(offset) || offset !== session.received) {
    return {
      ok: false, status: 409,
      error: `Upload out of sync (server has ${session.received} bytes, got offset ${offset}).`,
      expected: session.received,
    };
  }
  if (!Number.isFinite(chunkLen) || chunkLen <= 0) {
    return { ok: false, status: 400, error: 'Empty or invalid chunk.' };
  }
  if (session.received + chunkLen > session.size) {
    return { ok: false, status: 400, error: 'Chunk would exceed the declared file size.' };
  }
  if (session.received + chunkLen > cap) {
    return { ok: false, status: 413, error: 'File too large.' };
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
      expected: session.received,
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
