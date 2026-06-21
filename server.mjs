import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { contentType, parseRange } from './lib/http-util.js';
import { createChallenge, verifyChallenge } from './lib/challenge.js';
import { createRateLimiter } from './lib/rate-limit.js';
import { validateComment, addComment, listComments } from './lib/comments-store.js';
import { login, requireAdmin, adminConfigured } from './lib/admin-auth.js';
import {
  enqueue, getJob, listJobs, newUploadTarget, acceptableUpload, bootSweep, deleteVideo,
} from './lib/ingest.mjs';
import { hasFfmpeg } from './lib/media.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MEDIA_DIR = path.join(__dirname, 'media');

// --- API setup ---
const SECRET = crypto.randomBytes(32).toString('hex');
// Admin token signing key. Set ADMIN_SECRET to keep tokens valid across restarts;
// otherwise a fresh random key logs admins out on each restart (fine for one admin).
const ADMIN_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(32).toString('hex');
const limiter = createRateLimiter(60_000);
const loginLimiter = createRateLimiter(1_000); // throttle login hammering, allow retries
const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB cap
const COMMENTS_FILE = path.join(__dirname, 'data', 'comments.json');

function resolveFile(urlPath) {
  let pathname = decodeURIComponent(urlPath.split('?')[0]);
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';

  const isMedia = pathname.startsWith('/media/');
  const root = isMedia ? MEDIA_DIR : PUBLIC_DIR;
  const rel = isMedia ? pathname.slice('/media'.length) : pathname;
  const filePath = path.normalize(path.join(root, rel));

  // Traversal guard: resolved path must stay within its root.
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;
  return filePath;
}

/** Send a JSON response. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Read request body up to maxBytes, resolve with string or null on overflow/error. */
function readBody(req, maxBytes = 65536) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

/** Extract client IP from request. */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? xff.split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

/** Handle API routes. Returns true if the request was handled, false to fall through. */
async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');

  // GET /api/challenge
  if (req.method === 'GET' && url.pathname === '/api/challenge') {
    try {
      const { question, token } = createChallenge(SECRET);
      sendJson(res, 200, { question, token });
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // GET /api/comments?video=<id>
  if (req.method === 'GET' && url.pathname === '/api/comments') {
    try {
      const video = url.searchParams.get('video') || 'bikinis';
      const comments = listComments(COMMENTS_FILE, video);
      sendJson(res, 200, { comments });
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // POST /api/comments
  if (req.method === 'POST' && url.pathname === '/api/comments') {
    try {
      // 1. Rate limit
      const ip = clientIp(req);
      const rl = limiter.hit(ip);
      if (!rl.allowed) {
        sendJson(res, 429, {
          error: "You're posting too fast. Please wait a moment.",
          retryAfter: rl.retryAfter,
        });
        return true;
      }

      // 2. Read + parse body
      const raw = await readBody(req, 65536);
      if (raw === null) {
        sendJson(res, 400, { error: 'Invalid request' });
        return true;
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'Invalid request' });
        return true;
      }

      const { video, name, anonymous, text, answer, token } = body;

      // 3. Challenge
      if (!verifyChallenge(SECRET, token, answer)) {
        sendJson(res, 400, { error: 'Incorrect answer to the verification question.' });
        return true;
      }

      // 4. Validate
      const validation = validateComment({ name, anonymous, text });
      if (!validation.ok) {
        sendJson(res, 400, { error: validation.error });
        return true;
      }

      // 5. Store
      const stored = await addComment(
        COMMENTS_FILE,
        video || 'bikinis',
        { name: validation.value.name, text: validation.value.text },
      );
      sendJson(res, 200, { ok: true, comment: stored });
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // POST /api/admin/login  { password } → { ok, token }
  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    try {
      if (!adminConfigured()) {
        sendJson(res, 503, { error: 'Admin uploads are not configured on this server.' });
        return true;
      }
      if (!loginLimiter.hit(clientIp(req)).allowed) {
        sendJson(res, 429, { error: 'Too many attempts. Try again shortly.' });
        return true;
      }
      const raw = await readBody(req, 4096);
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      const result = login(ADMIN_SECRET, body && body.password);
      if (!result.ok) {
        sendJson(res, 401, { error: 'Incorrect password.' });
        return true;
      }
      sendJson(res, 200, { ok: true, token: result.token });
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // GET /api/admin/status[?job=<id>]  → ffmpeg availability + job(s)
  if (req.method === 'GET' && url.pathname === '/api/admin/status') {
    if (!requireAdmin(ADMIN_SECRET, req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const jobId = url.searchParams.get('job');
    if (jobId) {
      sendJson(res, 200, { job: getJob(jobId), ffmpeg: hasFfmpeg() });
    } else {
      sendJson(res, 200, { jobs: listJobs(), ffmpeg: hasFfmpeg() });
    }
    return true;
  }

  // POST /api/admin/delete  { id } → { ok }
  if (req.method === 'POST' && url.pathname === '/api/admin/delete') {
    if (!requireAdmin(ADMIN_SECRET, req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    try {
      const raw = await readBody(req, 4096);
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      const result = await deleteVideo(body && body.id);
      sendJson(res, result.ok ? 200 : 404, result);
    } catch {
      sendJson(res, 500, { error: 'Server error' });
    }
    return true;
  }

  // POST /api/admin/upload?name=<file>  (raw video body) → { jobId, manifestId }
  if (req.method === 'POST' && url.pathname === '/api/admin/upload') {
    if (!requireAdmin(ADMIN_SECRET, req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const name = url.searchParams.get('name') || '';
    if (!acceptableUpload(name, req.headers['content-type'])) {
      sendJson(res, 415, { error: 'Only video files (.mp4/.mov/.m4v) are accepted.' });
      return true;
    }
    await streamUpload(req, res, name);
    return true;
  }

  return false; // not an API route
}

/** Stream a raw request body to disk (bypassing readBody), then enqueue ingestion. */
function streamUpload(req, res, name) {
  return new Promise((resolve) => {
    const { savedPath, partPath } = newUploadTarget(name);
    const out = fs.createWriteStream(partPath);
    let total = 0;
    let aborted = false;

    const fail = (status, error) => {
      if (aborted) return;
      aborted = true;
      try { req.destroy(); } catch { /* ignore */ }
      out.destroy();
      fsp.unlink(partPath).catch(() => {});
      sendJson(res, status, { error });
      resolve();
    };

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > UPLOAD_MAX_BYTES) fail(413, 'File too large.');
    });
    out.on('error', () => fail(500, 'Write failed.'));
    req.on('error', () => fail(400, 'Upload interrupted.'));
    req.on('aborted', () => fail(400, 'Upload aborted.'));

    req.pipe(out);

    out.on('close', () => {
      if (aborted) return;
      if (total === 0) { fail(400, 'Empty upload.'); return; }
      fsp.rename(partPath, savedPath)
        .then(() => {
          const { jobId, manifestId } = enqueue(savedPath, name);
          sendJson(res, 202, { ok: true, jobId, manifestId });
          resolve();
        })
        .catch(() => fail(500, 'Could not finalize upload.'));
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // API routes take priority
    if (req.url.startsWith('/api/')) {
      const handled = await handleApi(req, res);
      if (handled) return;
    }

    // Static file serving (unchanged)
    const filePath = resolveFile(req.url);
    if (!filePath) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      res.writeHead(404);
      return res.end('Not found');
    }
    if (stat.isDirectory()) {
      res.writeHead(404);
      return res.end('Not found');
    }

    const headers = {
      'Content-Type': contentType(filePath),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };

    const range = parseRange(req.headers.range, stat.size);
    if (range && range.invalid) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }

    if (range) {
      const { start, end } = range;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      headers['Content-Length'] = stat.size;
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch {
    res.writeHead(500);
    res.end('Server error');
  }
});

server.listen(PORT, async () => {
  console.log(`▶  BondTV running at http://localhost:${PORT}`);
  console.log(`   admin uploads: ${adminConfigured() ? 'enabled' : 'DISABLED (set ADMIN_PASSWORD)'} · ffmpeg: ${hasFfmpeg() ? 'ok' : 'MISSING'}`);
  await bootSweep(); // any interrupted "processing" entries → "failed"
});
