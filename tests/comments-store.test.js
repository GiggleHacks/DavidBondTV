import { describe, it, expect, afterAll } from 'vitest';
import { validateComment, addComment, listComments } from '../lib/comments-store.js';
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
