// Streamed SHA-256 of a file on disk. Used by the local→server publish flow to
// declare a per-artifact checksum the receiver re-verifies before committing.
import fs from 'node:fs';
import crypto from 'node:crypto';

/** Resolve to the lowercase hex SHA-256 of the file at `filePath`. */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
