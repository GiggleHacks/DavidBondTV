import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createUsersStore, publicUser, adminUser } from '../lib/users-store.js';

let file;
beforeEach(() => {
  file = path.join(os.tmpdir(), `users-${crypto.randomUUID()}.json`);
});
afterEach(() => {
  try { fs.unlinkSync(file); } catch { /* ignore */ }
});

describe('users-store', () => {
  it('creates a user and looks it up by email (case-insensitive)', async () => {
    const store = createUsersStore(file);
    const r = await store.createUser({ email: 'Person@Example.com', passwordHash: 'h' });
    expect(r.ok).toBe(true);
    expect(r.user.verified).toBe(false);
    expect(r.user.securityStamp).toBeTruthy();
    expect(store.getByEmail('person@example.com').id).toBe(r.user.id);
  });

  it('rejects a duplicate email', async () => {
    const store = createUsersStore(file);
    await store.createUser({ email: 'a@b.com', passwordHash: 'h' });
    const dup = await store.createUser({ email: 'A@B.com', passwordHash: 'h' });
    expect(dup.ok).toBe(false);
    expect(dup.error).toBe('exists');
  });

  it('sets a username and enforces uniqueness', async () => {
    const store = createUsersStore(file);
    const a = (await store.createUser({ email: 'a@b.com', passwordHash: 'h' })).user;
    const b = (await store.createUser({ email: 'c@d.com', passwordHash: 'h' })).user;
    expect((await store.updateUser(a.id, { username: 'Cool' })).ok).toBe(true);
    expect(store.isUsernameTaken('cool')).toBe(true);
    expect(store.getByUsername('COOL').id).toBe(a.id);
    const clash = await store.updateUser(b.id, { username: 'cool' });
    expect(clash.ok).toBe(false);
    expect(clash.error).toBe('username_taken');
  });

  it('persists across reloads', async () => {
    const store = createUsersStore(file);
    const u = (await store.createUser({ email: 'a@b.com', passwordHash: 'h' })).user;
    await store.updateUser(u.id, { username: 'keeper', verified: true });
    await store.flush();

    const reopened = createUsersStore(file);
    expect(reopened.getByUsername('keeper').id).toBe(u.id);
    expect(reopened.getById(u.id).verified).toBe(true);
  });

  it('publicUser hides sensitive fields and admin role markers', async () => {
    const store = createUsersStore(file);
    const u = (await store.createUser({ email: 'a@b.com', passwordHash: 'secret' })).user;
    await store.updateUser(u.id, { username: 'public', roles: ['admin'] });
    const pub = publicUser(store.getByUsername('public'));
    expect(pub.email).toBeUndefined();
    expect(pub.passwordHash).toBeUndefined();
    expect(pub.isAdmin).toBeUndefined();
    expect(pub).toHaveProperty('username');
  });

  it('adminUser does not expose password hashes to the browser', async () => {
    const store = createUsersStore(file);
    const u = (await store.createUser({ email: 'a@b.com', passwordHash: 'secret' })).user;
    const admin = adminUser(u);
    expect(admin.hasPassword).toBe(true);
    expect(admin.passwordHash).toBeUndefined();
  });

  it('deletes a user, frees email/username, and survives reload', async () => {
    const store = createUsersStore(file);
    const u = (await store.createUser({ email: 'gone@b.com', passwordHash: 'h' })).user;
    await store.updateUser(u.id, { username: 'gone' });
    const del = await store.deleteUser(u.id);
    expect(del.ok).toBe(true);
    expect(del.user.id).toBe(u.id);
    expect(store.getById(u.id)).toBeNull();
    expect(store.getByEmail('gone@b.com')).toBeNull();
    expect(store.isUsernameTaken('gone')).toBe(false);
    // Email is reusable for a brand-new signup.
    expect((await store.createUser({ email: 'gone@b.com', passwordHash: 'h2' })).ok).toBe(true);
    await store.flush();
    const reopened = createUsersStore(file);
    expect(reopened.getById(u.id)).toBeNull();
  });

  it('deleteUser is a no-op for an unknown id', async () => {
    const store = createUsersStore(file);
    const r = await store.deleteUser('nope');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_found');
  });

  it('defaults a telegram block on new users', async () => {
    const store = createUsersStore(file);
    const u = (await store.createUser({ email: 'a@b.com', passwordHash: 'h' })).user;
    expect(u.telegram).toEqual({ userId: null, username: null, joinedAt: null, invitedAt: null, linkState: 'none' });
  });

  it('indexes a captured Telegram user id and keeps the index in sync', async () => {
    const store = createUsersStore(file);
    const u = (await store.createUser({ email: 'a@b.com', passwordHash: 'h' })).user;
    expect(store.getByTelegramUserId(555)).toBeNull();

    await store.updateUser(u.id, { telegram: { userId: 555, username: 'tg', linkState: 'joined' } });
    expect(store.getByTelegramUserId(555).id).toBe(u.id);
    expect(store.getByTelegramUserId('555').id).toBe(u.id); // string/number agnostic

    // Re-point to a new id: the old key is dropped, the new one resolves.
    await store.updateUser(u.id, { telegram: { userId: 777, linkState: 'joined' } });
    expect(store.getByTelegramUserId(555)).toBeNull();
    expect(store.getByTelegramUserId(777).id).toBe(u.id);

    // Survives a reload (rebuilt from the persisted record).
    await store.flush();
    const reopened = createUsersStore(file);
    expect(reopened.getByTelegramUserId(777).id).toBe(u.id);
  });

  it('drops the telegram index entry on delete', async () => {
    const store = createUsersStore(file);
    const u = (await store.createUser({ email: 'a@b.com', passwordHash: 'h' })).user;
    await store.updateUser(u.id, { telegram: { userId: 999, linkState: 'joined' } });
    await store.deleteUser(u.id);
    expect(store.getByTelegramUserId(999)).toBeNull();
  });

  it('handles concurrent writes without corruption', async () => {
    const store = createUsersStore(file);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.createUser({ email: `u${i}@x.com`, passwordHash: 'h' })),
    );
    await store.flush();
    const reopened = createUsersStore(file);
    for (let i = 0; i < 20; i += 1) {
      expect(reopened.getByEmail(`u${i}@x.com`)).toBeTruthy();
    }
  });
});
