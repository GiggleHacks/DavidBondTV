import { describe, it, expect, afterAll } from 'vitest';
import { validateComment, addComment, listComments, threadComments, deleteComment } from '../lib/comments-store.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Temp file for persistence tests
const TMP_DIR = path.join(os.tmpdir(), 'comments-store-test-' + Date.now());
const TMP_FILE = path.join(TMP_DIR, 'comments.json');

afterAll(() => {
  // Clean up
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

describe('validateComment', () => {
  it('rejects empty text', () => {
    const r = validateComment({ name: 'Alice', text: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('rejects whitespace-only text', () => {
    const r = validateComment({ name: 'Alice', text: '   \t  ' });
    expect(r.ok).toBe(false);
  });

  it('rejects text over 1000 chars', () => {
    const r = validateComment({ name: 'Alice', text: 'x'.repeat(1001) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/long/i);
  });

  it('accepts text at exactly 1000 chars', () => {
    const r = validateComment({ name: 'Alice', text: 'x'.repeat(1000) });
    expect(r.ok).toBe(true);
  });

  it('strips ASCII control chars from text (except newline/tab)', () => {
    const r = validateComment({ name: 'Alice', text: 'hello\x01world\x1Ftest' });
    expect(r.ok).toBe(true);
    expect(r.value.text).toBe('helloworldtest');
  });

  it('preserves newlines and tabs in text', () => {
    const r = validateComment({ name: 'Alice', text: 'line1\nline2\ttabbed' });
    expect(r.ok).toBe(true);
    expect(r.value.text).toBe('line1\nline2\ttabbed');
  });

  it('sets name to "Anonymous" when anonymous is truthy', () => {
    const r = validateComment({ name: 'Alice', anonymous: true, text: 'hello' });
    expect(r.ok).toBe(true);
    expect(r.value.name).toBe('Anonymous');
  });

  it('sets name to "Anonymous" when name is blank', () => {
    const r = validateComment({ name: '   ', text: 'hello' });
    expect(r.ok).toBe(true);
    expect(r.value.name).toBe('Anonymous');
  });

  it('truncates name to 60 chars (not an error)', () => {
    const longName = 'A'.repeat(80);
    const r = validateComment({ name: longName, text: 'hello' });
    expect(r.ok).toBe(true);
    expect(r.value.name.length).toBe(60);
  });

  it('strips control chars from name', () => {
    const r = validateComment({ name: 'Al\x01ice', text: 'hello' });
    expect(r.ok).toBe(true);
    expect(r.value.name).toBe('Alice');
  });
});

describe('addComment + listComments (persistence)', () => {
  it('returns [] for missing file', () => {
    const result = listComments(TMP_FILE + '.nonexistent', 'testvideo');
    expect(result).toEqual([]);
  });

  it('round-trip: add two comments and list newest-first', async () => {
    const c1 = await addComment(TMP_FILE, 'testvideo', {
      name: 'Alice',
      text: 'First comment',
      ts: 1000,
    });
    expect(c1.id).toBeTruthy();
    expect(c1.name).toBe('Alice');
    expect(c1.ts).toBe(1000);

    const c2 = await addComment(TMP_FILE, 'testvideo', {
      name: 'Bob',
      text: 'Second comment',
      ts: 2000,
    });
    expect(c2.name).toBe('Bob');

    const comments = listComments(TMP_FILE, 'testvideo');
    expect(comments.length).toBe(2);
    // Newest first (highest ts first)
    expect(comments[0].name).toBe('Bob');
    expect(comments[1].name).toBe('Alice');
  });

  it('different videos are independent', async () => {
    await addComment(TMP_FILE, 'video2', { name: 'Carol', text: 'On video2', ts: 500 });
    const v2 = listComments(TMP_FILE, 'video2');
    expect(v2.length).toBe(1);
    expect(v2[0].name).toBe('Carol');

    // testvideo still has 2 from previous test
    const v1 = listComments(TMP_FILE, 'testvideo');
    expect(v1.length).toBe(2);
  });

  it('generates id and ts if not provided', async () => {
    const c = await addComment(TMP_FILE, 'video3', { name: 'Dave', text: 'Auto-id' });
    expect(typeof c.id).toBe('string');
    expect(c.id.length).toBeGreaterThan(0);
    expect(typeof c.ts).toBe('number');
    expect(c.ts).toBeGreaterThan(0);
  });
});

describe('replies (parentId threading)', () => {
  const FILE = path.join(TMP_DIR, 'replies.json');
  const V = 'vid';

  it('addComment persists parentId for a reply to a root', async () => {
    const root = await addComment(FILE, V, { name: 'Root', text: 'top', ts: 1000 });
    const reply = await addComment(FILE, V, { name: 'Rep', text: 'a reply', ts: 2000, parentId: root.id });
    expect(reply.parentId).toBe(root.id);
  });

  it('ignores a parentId that does not exist (stays top-level)', async () => {
    const c = await addComment(FILE, V, { name: 'Ghost', text: 'orphan', ts: 3000, parentId: 'nope' });
    expect(c.parentId).toBeUndefined();
  });

  it('collapses a reply-to-a-reply onto the thread root (single-level)', async () => {
    const root = await addComment(FILE, V, { name: 'R', text: 'root2', ts: 4000 });
    const reply = await addComment(FILE, V, { name: 'A', text: 'r1', ts: 5000, parentId: root.id });
    const nested = await addComment(FILE, V, { name: 'B', text: 'r2', ts: 6000, parentId: reply.id });
    expect(nested.parentId).toBe(root.id); // not reply.id
  });

  it('threadComments nests roots newest-first with replies oldest-first', async () => {
    const FILE2 = path.join(TMP_DIR, 'thread.json');
    const r1 = await addComment(FILE2, V, { name: 'R1', text: 'first root', ts: 100 });
    const r2 = await addComment(FILE2, V, { name: 'R2', text: 'second root', ts: 200 });
    await addComment(FILE2, V, { name: 'A', text: 'reply A', ts: 150, parentId: r1.id });
    await addComment(FILE2, V, { name: 'B', text: 'reply B', ts: 180, parentId: r1.id });

    const threaded = threadComments(listComments(FILE2, V));
    expect(threaded.length).toBe(2);
    expect(threaded[0].id).toBe(r2.id); // newest root first
    expect(threaded[0].replyCount).toBe(0);
    expect(threaded[1].id).toBe(r1.id);
    expect(threaded[1].replyCount).toBe(2);
    expect(threaded[1].replies.map((x) => x.name)).toEqual(['A', 'B']); // oldest-first
  });

  it('deleteComment on a root cascades to its replies', async () => {
    const FILE3 = path.join(TMP_DIR, 'cascade.json');
    const root = await addComment(FILE3, V, { name: 'Root', text: 'parent', ts: 10 });
    await addComment(FILE3, V, { name: 'A', text: 'child a', ts: 20, parentId: root.id });
    await addComment(FILE3, V, { name: 'B', text: 'child b', ts: 30, parentId: root.id });
    expect(listComments(FILE3, V).length).toBe(3);

    const result = await deleteComment(FILE3, V, root.id);
    expect(result.ok).toBe(true);
    expect(listComments(FILE3, V).length).toBe(0); // root + both replies gone
  });
});
