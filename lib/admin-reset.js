import crypto from 'node:crypto';
import { createUsersStore } from './users-store.js';
import { hashPassword, validatePassword } from './password.js';

export async function resetAdminPassword({ usersFile, username = 'davidbond', nextPassword }) {
  const pw = validatePassword(nextPassword);
  if (!pw.ok) return { ok: false, error: pw.error };

  const store = createUsersStore(usersFile);
  const user = store.getByUsername(username);
  if (!user) return { ok: false, error: 'Admin user not found.' };

  const updated = await store.updateUser(user.id, {
    passwordHash: hashPassword(nextPassword),
    securityStamp: crypto.randomBytes(16).toString('hex'),
  });
  if (!updated.ok) return { ok: false, error: 'Could not update admin password.' };
  await store.flush();
  return { ok: true, username };
}
