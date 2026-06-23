#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { resetAdminPassword } from '../lib/admin-reset.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');

async function readPassword() {
  if (!input.isTTY) {
    let raw = '';
    for await (const chunk of input) raw += chunk;
    return raw.trim();
  }
  const rl = createInterface({ input, output });
  try {
    return (await rl.question('New admin password: ')).trim();
  } finally {
    rl.close();
  }
}

const nextPassword = await readPassword();
const result = await resetAdminPassword({ usersFile: USERS_FILE, nextPassword });
if (!result.ok) {
  console.error(result.error || 'Admin password reset failed.');
  process.exit(1);
}
console.log(`Admin password reset for ${result.username}.`);
