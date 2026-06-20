import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentType, parseRange } from './lib/http-util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MEDIA_DIR = path.join(__dirname, 'media');

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

const server = http.createServer(async (req, res) => {
  try {
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
