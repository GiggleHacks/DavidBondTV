#!/usr/bin/env node
// Send a Telegram message (used to ping the owner when a task is fully done).
// Credentials live in data/notify-telegram.json, which is gitignored and never
// deployed — so this script carries no secret and safely no-ops if the config
// is absent (e.g. on the production server). Usage:
//   node scripts/notify.mjs "your message"
//   echo "your message" | node scripts/notify.mjs
import fs from 'node:fs';
import path from 'node:path';

const CONFIG = path.join(process.cwd(), 'data', 'notify-telegram.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return null; }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim();
}

const cfg = loadConfig();
if (!cfg || !cfg.token || !cfg.chat_id) {
  console.error('notify: no data/notify-telegram.json (token/chat_id) — skipping.');
  process.exit(0); // graceful no-op, never fail a deploy/CI
}

const text = (process.argv.slice(2).join(' ') || (await readStdin()) || 'Done.').slice(0, 4000);

const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: cfg.chat_id, text, disable_web_page_preview: true }),
});
const data = await res.json().catch(() => ({}));
if (data.ok) {
  console.log(`notify: delivered to ${data.result?.chat?.username || cfg.chat_id}`);
} else {
  console.error(`notify: failed — ${data.description || res.status}`);
  process.exit(1);
}
