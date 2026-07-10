// Admin-managed comment settings, backed by data/comments-settings.json.
// Currently a single switch: whether anonymous (logged-out) visitors may post
// comments at all. Disabled by default — a missing/corrupt file means anonymous
// commenting is OFF, so a fresh deploy is locked down until the owner opts in
// from /god-community. Mirrors the lib/pricing.js config pattern.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolved per call so tests can point it at a tmp file via COMMENTS_SETTINGS_FILE.
const filePath = () => process.env.COMMENTS_SETTINGS_FILE || path.join(__dirname, '..', 'data', 'comments-settings.json');

const DEFAULT = { anonymousEnabled: false, updatedAt: 0 };

/** Normalize a raw record into the stable shape; anything non-true is false. */
function normalize(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  return {
    anonymousEnabled: r.anonymousEnabled === true,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
  };
}

/** Current comment settings. Returns defaults (without writing) until first save. */
export function getConfig() {
  try {
    return normalize(JSON.parse(fs.readFileSync(filePath(), 'utf8')));
  } catch {
    return { ...DEFAULT };
  }
}

/**
 * Merge a patch into the settings and persist. Returns { ok, config }.
 */
export function update(patch = {}) {
  const next = getConfig();
  if (patch.anonymousEnabled !== undefined) next.anonymousEnabled = patch.anonymousEnabled === true;
  next.updatedAt = Date.now();
  const f = filePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(next, null, 2));
  return { ok: true, config: getConfig() };
}
