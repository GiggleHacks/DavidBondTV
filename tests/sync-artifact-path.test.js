import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256File } from '../lib/hash-file.mjs';
import { resolveAssetPath } from '../lib/paths.js';

describe('sha256File', () => {
  let file;
  beforeEach(() => { file = path.join(os.tmpdir(), `hf-${crypto.randomUUID()}.bin`); });
  afterEach(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

  it('matches node crypto over the same bytes', async () => {
    const data = Buffer.from('david bond tv artifact payload \u{1F525}');
    fs.writeFileSync(file, data);
    const expected = crypto.createHash('sha256').update(data).digest('hex');
    expect(await sha256File(file)).toBe(expected);
  });

  it('rejects (does not resolve) for a missing file', async () => {
    await expect(sha256File(path.join(os.tmpdir(), 'definitely-missing-xyz.bin'))).rejects.toBeTruthy();
  });
});

describe('resolveAssetPath guards artifact destinations', () => {
  it('resolves allowed content paths under a root', () => {
    expect(resolveAssetPath('/thumbs/thumb-v1-1.jpg')).toBeTruthy();
    expect(resolveAssetPath('/videos/v1/720p.mp4')).toBeTruthy();
    expect(resolveAssetPath('/storyboards/v1/storyboard.json')).toBeTruthy();
  });

  it('rejects path traversal that escapes the root', () => {
    expect(resolveAssetPath('/thumbs/../../etc/passwd')).toBeNull();
    expect(resolveAssetPath('/videos/../../../secret')).toBeNull();
  });
});
