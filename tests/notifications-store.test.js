import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addNotification, addAccountNotification, listForUser, markSeen, dismiss,
} from '../lib/notifications-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'notifications.json');

const had = fs.existsSync(FILE);
const saved = had ? fs.readFileSync(FILE, 'utf8') : null;
beforeEach(() => { fs.rmSync(FILE, { force: true }); });
afterEach(() => {
  if (saved !== null) fs.writeFileSync(FILE, saved);
  else fs.rmSync(FILE, { force: true });
});

describe('notifications store — account + video notifications', () => {
  it('delivers an account notification only to its target user', async () => {
    await addAccountNotification('alice', { title: 'Membership activated', body: 'Enjoy', link: '/account.html' });
    const a = listForUser('alice');
    const b = listForUser('bob');
    expect(a.notifications).toHaveLength(1);
    expect(a.notifications[0]).toMatchObject({ kind: 'account', title: 'Membership activated', body: 'Enjoy', link: '/account.html' });
    expect(a.unread).toBe(1);
    expect(b.notifications).toHaveLength(0); // bob never sees alice's personal notification
  });

  it('keeps global video notifications visible to everyone (and gates by valid ids)', async () => {
    await addNotification({ videoId: 'v1', title: 'Cool clip', thumb: '/t.jpg' });
    expect(listForUser('alice').notifications).toHaveLength(1);
    expect(listForUser('bob').notifications).toHaveLength(1);
    // A video filter still applies to video notifications…
    expect(listForUser('alice', new Set(['other'])).notifications).toHaveLength(0);
    // …but never hides account notifications:
    await addAccountNotification('alice', { title: 'Access granted' });
    expect(listForUser('alice', new Set(['other'])).notifications).toHaveLength(1);
  });

  it('marks account notifications read after seen, and dismiss hides them', async () => {
    await addAccountNotification('alice', { title: 'One' });
    await addAccountNotification('alice', { title: 'Two' });
    expect(listForUser('alice').unread).toBe(2);
    await markSeen('alice');
    expect(listForUser('alice').unread).toBe(0);
    const first = listForUser('alice').notifications[0];
    await dismiss('alice', first.id);
    expect(listForUser('alice').notifications.find((n) => n.id === first.id)).toBeUndefined();
  });

  it('ignores account notifications with no title', async () => {
    await addAccountNotification('alice', { body: 'no title' });
    expect(listForUser('alice').notifications).toHaveLength(0);
  });
});
