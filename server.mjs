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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MEDIA_DIR = path.join(__dirname, 'media');

// --- API setup ---
const SECRET = crypto.randomBytes(32).toString('hex');
const limiter = createRateLimiter(60_000);
const COMMENTS_FILE = path.join(__dirname, 'data', 'comments.json');

function resolveFile(urlPath) {
  let pathname = decodeURIComponent(urlPath.split('?')[0]);
  if (pathname === '/') pathname = '/index.html';

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

  return false; // not an API route
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

server.listen(PORT, () => {
  console.log(`▶  YouTube clone player running at http://localhost:${PORT}`);
});
