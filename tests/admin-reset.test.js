import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsersStore } from '../lib/users-store.js';
import { verifyPassword } from '../lib/password.js';
import { resetAdminPassword } from '../lib/admin-reset.js';

let file;

beforeEach(() => {
  file = path.join(os.tmpdir(), `admin-reset-${crypto.randomUUID()}.json`);
});

afterEach(() => {
  try { fs.unlinkSync(file); } catch { /* ignore */ }
});

describe('resetAdminPassword', () => {
  it('updates the admin password hash and rotates the security stamp', async () => {
    const store = createUsersStore(file);
    const created = await store.createUser({ email: 'admin@example.com', passwordHash: 'old-hash' });
    await store.updateUser(created.user.id, {
      username: 'davidbond',
      usernameLower: 'davidbond',
      verified: true,
      roles: ['admin'],
      securityStamp: 'before',
    });

    const result = await resetAdminPassword({ usersFile: file, nextPassword: 'CorrectHorseBatteryStaple1!' });
    expect(result).toEqual({ ok: true, username: 'davidbond' });

    const reopened = createUsersStore(file);
    const admin = reopened.getByUsername('davidbond');
    expect(admin.securityStamp).not.toBe('before');
    expect(verifyPassword('CorrectHorseBatteryStaple1!', admin.passwordHash)).toBe(true);
  });
});
