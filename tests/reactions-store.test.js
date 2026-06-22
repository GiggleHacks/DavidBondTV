import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getCounts, getUserVote, setVote } from '../lib/reactions-store.js';

let file;
beforeEach(() => { file = path.join(os.tmpdir(), `reactions-${crypto.randomUUID()}.json`); });
afterEach(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

describe('reactions-store', () => {
  it('starts empty', () => {
    expect(getCounts(file, 'v1')).toEqual({ likes: 0, dislikes: 0 });
    expect(getUserVote(file, 'v1', 'u1')).toBe(0);
  });

  it('records likes and dislikes deduped per user', async () => {
    await setVote(file, 'v1', 'u1', 1);
    await setVote(file, 'v1', 'u2', 1);
    await setVote(file, 'v1', 'u3', -1);
    expect(getCounts(file, 'v1')).toEqual({ likes: 2, dislikes: 1 });
    expect(getUserVote(file, 'v1', 'u1')).toBe(1);
  });

  it('toggles a repeated vote off', async () => {
    const a = await setVote(file, 'v1', 'u1', 1);
    expect(a).toEqual({ likes: 1, dislikes: 0, mine: 1 });
    const b = await setVote(file, 'v1', 'u1', 1); // same vote again → clear
    expect(b).toEqual({ likes: 0, dislikes: 0, mine: 0 });
  });

  it('switches like → dislike', async () => {
    await setVote(file, 'v1', 'u1', 1);
    const r = await setVote(file, 'v1', 'u1', -1);
    expect(r).toEqual({ likes: 0, dislikes: 1, mine: -1 });
  });

  it('keeps videos independent', async () => {
    await setVote(file, 'v1', 'u1', 1);
    await setVote(file, 'v2', 'u1', -1);
    expect(getCounts(file, 'v1')).toEqual({ likes: 1, dislikes: 0 });
    expect(getCounts(file, 'v2')).toEqual({ likes: 0, dislikes: 1 });
  });
});
