import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_ENTRIES = [
  { id: 'filter_mark_firestone', phrase: 'Mark Firestone', enabled: true, createdAt: 0, updatedAt: 0 },
  { id: 'filter_mark_thomas_firestone', phrase: 'Mark Thomas Firestone', enabled: true, createdAt: 0, updatedAt: 0 },
  { id: 'filter_sukhumvit_81', phrase: 'Sukhumvit 81', enabled: true, createdAt: 0, updatedAt: 0 },
  { id: 'filter_president_sukhumvit', phrase: 'President Sukhumvit', enabled: true, createdAt: 0, updatedAt: 0 },
];

function cleanPhrase(phrase) {
  return String(phrase || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function normalizePhrase(phrase) {
  return cleanPhrase(phrase).toLowerCase();
}

// Squash to letters/digits only — the evasion-proof comparable form.
function squash(s) {
  return String(s || '').toLowerCase().replace(/[\W_]+/g, '');
}

export function phraseMatches(text, phrase) {
  const p = normalizePhrase(phrase);
  if (!p) return false;
  // Words may be separated by ANY punctuation/whitespace run ("MARK. THOMAS.
  // FIRESTONE.", "Sukhumvit-81"), not just spaces.
  const escaped = p.split(' ').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\W_]+');
  if (new RegExp(`(^|\\b)${escaped}(\\b|$)`, 'i').test(String(text || ''))) return true;
  // Squashed fallback catches letter-spacing evasion ("M.a.r.k F.i.r.e.s.t.o.n.e",
  // "MarkFirestone"). Only for phrases long enough that a substring hit can't be
  // an innocent word ("mark" must never match "remarkable").
  const squashedPhrase = squash(p);
  return squashedPhrase.length >= 10 && squash(text).includes(squashedPhrase);
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
    // Ensure every seed phrase exists — this is also how an existing prod
    // blocklist file picks up newly shipped defaults on deploy.
    let seeded = false;
    for (let i = DEFAULT_ENTRIES.length - 1; i >= 0; i -= 1) {
      const d = DEFAULT_ENTRIES[i];
      if (!entries.some((e) => normalizePhrase(e.phrase) === normalizePhrase(d.phrase))) {
        entries.unshift({ ...d });
        seeded = true;
      }
    }
    if (seeded) persist();
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
