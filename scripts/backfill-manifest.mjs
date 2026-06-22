// One-time manifest migration: ensure every entry has the fields the homepage
// sorting + publish/premium layers rely on. Idempotent — safe to re-run.
//
//   uploadedAt : machine ms timestamp (drives "Recently Uploaded" sort + NEW badge)
//                derived from the `uploaded` date string, else spaced out by
//                reverse manifest order so legacy ordering is preserved.
//   published  : default true (legacy entries were all public)
//   visibility : default 'free'
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(__dirname, '..', 'public', 'thumbs', 'videos.json');

const arr = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));

// Base for synthetic timestamps: spread legacy entries 1 minute apart, newest
// first (top of the manifest = most recent), all safely in the past so they
// never trip the 3-day NEW badge.
const BASE = Date.parse('2026-06-01T00:00:00Z');
const MINUTE = 60_000;

let changed = 0;
arr.forEach((e, i) => {
  if (typeof e.uploadedAt !== 'number') {
    const parsed = e.uploaded ? Date.parse(e.uploaded) : NaN;
    // Keep manifest order stable: earlier index → newer, so subtract by index.
    e.uploadedAt = Number.isFinite(parsed) ? parsed - i * 1000 : BASE - i * MINUTE;
    changed++;
  }
  if (typeof e.published !== 'boolean') { e.published = true; changed++; }
  if (e.visibility !== 'premium' && e.visibility !== 'free') { e.visibility = 'free'; changed++; }
});

fs.writeFileSync(MANIFEST, JSON.stringify(arr, null, 2));
console.log(`Backfilled ${changed} field(s) across ${arr.length} entries.`);
