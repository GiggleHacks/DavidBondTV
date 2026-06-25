import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { announceBoot } from '../lib/deploy-notify.mjs';

let dir, stateFile;

beforeEach(async () => {
  // A non-git temp dir so currentGitSha() returns null → deterministic (version-only).
  dir = path.join(os.tmpdir(), `deploy-${crypto.randomUUID()}`);
  await fsp.mkdir(dir, { recursive: true });
  stateFile = path.join(dir, 'boot-state.json');
});

afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

function spies() {
  const admin = [];
  const tg = [];
  return { admin, tg, notifyAdmins: (p) => admin.push(p), sendTelegram: (t) => tg.push(t) };
}

describe('announceBoot', () => {
  it('first boot is silent and just records state', async () => {
    const s = spies();
    const r = await announceBoot({ version: '1.0.0', cwd: dir, stateFile, notifyAdmins: s.notifyAdmins, sendTelegram: s.sendTelegram });
    expect(r.kind).toBe('first');
    expect(s.admin).toHaveLength(0);
    expect(s.tg).toHaveLength(0);
  });

  it('same version on next boot is a quiet reboot (bell only, no telegram)', async () => {
    await announceBoot({ version: '1.0.0', cwd: dir, stateFile, notifyAdmins: () => {} });
    const s = spies();
    const r = await announceBoot({ version: '1.0.0', cwd: dir, stateFile, notifyAdmins: s.notifyAdmins, sendTelegram: s.sendTelegram });
    expect(r.kind).toBe('reboot');
    expect(s.admin).toHaveLength(1);
    expect(s.admin[0].kind).toBe('server');
    expect(s.tg).toHaveLength(0);
  });

  it('version change is an update: system bell + telegram summary', async () => {
    await announceBoot({ version: '1.0.0', cwd: dir, stateFile, notifyAdmins: () => {} });
    const s = spies();
    const r = await announceBoot({ version: '1.1.0', cwd: dir, stateFile, notifyAdmins: s.notifyAdmins, sendTelegram: s.sendTelegram });
    expect(r.kind).toBe('update');
    expect(s.admin[0].kind).toBe('system');
    expect(s.admin[0].title).toContain('1.1.0');
    expect(s.tg).toHaveLength(1);
    expect(s.tg[0]).toContain('1.0.0');
    expect(s.tg[0]).toContain('1.1.0');
  });
});
