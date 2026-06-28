import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_ENTRIES = [
  { id: 'filter_mark_firestone', phrase: 'Mark Firestone', enabled: true, createdAt: 0, updatedAt: 0 },
];

function cleanPhrase(phrase) {
  return String(phrase || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function normalizePhrase(phrase) {
  return cleanPhrase(phrase).toLowerCase();
}

export function phraseMatches(text, phrase) {
  const p = normalizePhrase(phrase);
  if (!p) return false;
  const escaped = p.split(' ').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp(`(^|\\b)${escaped}(\\b|$)`, 'i').test(String(text || ''));
}

function normalizeEntry(entry, fallbackId = '') {
  const phrase = cleanPhrase(typeof entry === 'string' ? entry : entry && entry.phrase);
  if (!phrase) return null;
  const now = Date.now();
  return {
    id: (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id) || fallbackId || `filter_${crypto.randomUUID()}`,
    phrase,
    enabled: !(entry && typeof entry === 'object' && entry.enabled === false),
    createdAt: (entry && typeof entry === 'object' && typeof entry.createdAt === 'number') ? entry.createdAt : now,
    updatedAt: (entry && typeof entry === 'object' && typeof entry.updatedAt === 'number') ? entry.updatedAt : now,
  };
}

export function createCommentFilterStore(filePath) {
  let entries = [];

  function persist() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ entries }, null, 2), 'utf8');
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const raw = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.entries) ? parsed.entries : []);
      entries = raw.map((e, i) => normalizeEntry(e, `filter_legacy_${i}`)).filter(Boolean);
    } catch {
      entries = DEFAULT_ENTRIES.map((e) => ({ ...e }));
      persist();
    }
    const hasDefault = entries.some((e) => normalizePhrase(e.phrase) === normalizePhrase('Mark Firestone'));
    if (!hasDefault) {
      entries.unshift({ ...DEFAULT_ENTRIES[0] });
      persist();
    }
  }

  load();

  const clone = (v) => JSON.parse(JSON.stringify(v));

  return {
    list() {
      return clone(entries);
    },
    match(text) {
      return clone(entries.find((e) => e.enabled && phraseMatches(text, e.phrase)) || null);
    },
    add(phrase) {
      const clean = cleanPhrase(phrase);
      if (!clean) return { ok: false, error: 'Phrase is required.' };
      if (entries.some((e) => normalizePhrase(e.phrase) === normalizePhrase(clean))) return { ok: false, error: 'That phrase already exists.' };
      const now = Date.now();
      const entry = { id: `filter_${crypto.randomUUID()}`, phrase: clean, enabled: true, createdAt: now, updatedAt: now };
      entries.push(entry);
      persist();
      return { ok: true, entry: clone(entry) };
    },
    update(id, patch = {}) {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return { ok: false, error: 'Filter not found.' };
      if (patch.phrase !== undefined) {
        const clean = cleanPhrase(patch.phrase);
        if (!clean) return { ok: false, error: 'Phrase is required.' };
        if (entries.some((e) => e.id !== id && normalizePhrase(e.phrase) === normalizePhrase(clean))) return { ok: false, error: 'That phrase already exists.' };
        entry.phrase = clean;
      }
      if (patch.enabled !== undefined) entry.enabled = !!patch.enabled;
      entry.updatedAt = Date.now();
      persist();
      return { ok: true, entry: clone(entry) };
    },
    remove(id) {
      const next = entries.filter((e) => e.id !== id);
      if (next.length === entries.length) return { ok: false, error: 'Filter not found.' };
      entries = next;
      persist();
      return { ok: true };
    },
  };
}
