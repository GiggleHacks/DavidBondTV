import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = path.join(os.tmpdir(), 'comments-settings-test-' + Date.now());
const TMP_FILE = path.join(TMP_DIR, 'comments-settings.json');
process.env.COMMENTS_SETTINGS_FILE = TMP_FILE;

const { getConfig, update } = await import('../lib/comments-settings.js');

beforeEach(() => {
  try { fs.rmSync(TMP_FILE, { force: true }); } catch {}
});

afterAll(() => {
  delete process.env.COMMENTS_SETTINGS_FILE;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

describe('comments settings', () => {
  it('defaults to anonymous comments DISABLED when no file exists', () => {
    expect(getConfig()).toEqual({ anonymousEnabled: false, updatedAt: 0 });
    // Reading never creates the file.
    expect(fs.existsSync(TMP_FILE)).toBe(false);
  });

  it('persists an update and reads it back', () => {
    const r = update({ anonymousEnabled: true });
    expect(r.ok).toBe(true);
    expect(r.config.anonymousEnabled).toBe(true);
    expect(getConfig().anonymousEnabled).toBe(true);

    update({ anonymousEnabled: false });
    expect(getConfig().anonymousEnabled).toBe(false);
  });

  it('normalizes garbage values to disabled', () => {
    update({ anonymousEnabled: 'yes please' });
    expect(getConfig().anonymousEnabled).toBe(false);

    fs.writeFileSync(TMP_FILE, '{not json');
    expect(getConfig().anonymousEnabled).toBe(false);

    fs.writeFileSync(TMP_FILE, JSON.stringify({ anonymousEnabled: 1 }));
    expect(getConfig().anonymousEnabled).toBe(false);
  });
});
