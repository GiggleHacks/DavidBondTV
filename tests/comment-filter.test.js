import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCommentFilterStore, phraseMatches } from '../lib/comment-filter.js';

const files = [];
function tmpFile() {
  const f = path.join(os.tmpdir(), `comment-filter-${crypto.randomUUID()}.json`);
  files.push(f);
  return f;
}

afterEach(() => {
  for (const f of files.splice(0)) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
});

describe('comment word filter', () => {
  it('matches phrases case-insensitively across extra whitespace', () => {
    expect(phraseMatches('Please do not say MARK   FIRESTONE here', 'mark firestone')).toBe(true);
    expect(phraseMatches('Market fire stones are different', 'mark firestone')).toBe(false);
  });

  it('matches across punctuation between words (period/hyphen/quote evasion)', () => {
    expect(phraseMatches('legal name MARK. THOMAS. FIRESTONE. is living at', 'Mark Thomas Firestone')).toBe(true);
    expect(phraseMatches('he lives at Sukhumvit-81 in Bangkok', 'Sukhumvit 81')).toBe(true);
    expect(phraseMatches('at "The President Sukhumvit 81"', 'President Sukhumvit')).toBe(true);
    expect(phraseMatches('mark-"firestone"', 'mark firestone')).toBe(true);
  });

  it('matches squashed/letter-spaced evasion for long phrases only', () => {
    expect(phraseMatches('his name is MarkFirestone lol', 'Mark Firestone')).toBe(true);
    expect(phraseMatches('M.a.r.k F.i.r.e.s.t.o.n.e', 'Mark Firestone')).toBe(true);
    expect(phraseMatches('Sukhumvit81', 'Sukhumvit 81')).toBe(true);
    // Short phrases never use the squashed substring layer.
    expect(phraseMatches('that was remarkable', 'mark')).toBe(false);
  });

  it('seeds Mark Firestone as an enabled shadow-ban phrase', () => {
    const store = createCommentFilterStore(tmpFile());

    const match = store.match('I heard your legal name is Mark Firestone.');

    expect(match).toMatchObject({ phrase: 'Mark Firestone', enabled: true });
  });

  it('seeds the full-name and condo phrases on a fresh store', () => {
    const store = createCommentFilterStore(tmpFile());
    const phrases = store.list().map((e) => e.phrase);
    expect(phrases).toEqual(expect.arrayContaining([
      'Mark Firestone', 'Mark Thomas Firestone', 'Sukhumvit 81', 'President Sukhumvit',
    ]));
    expect(store.match('living at The President Sukhumvit 81 in Bangkok')).toMatchObject({ enabled: true });
  });

  it('appends missing seed phrases to an existing blocklist file', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Simulates prod: a pre-existing file that only knows the original seed.
    fs.writeFileSync(file, JSON.stringify({
      entries: [{ id: 'filter_mark_firestone', phrase: 'Mark Firestone', enabled: true, createdAt: 0, updatedAt: 0 }],
    }), 'utf8');
    const store = createCommentFilterStore(file);

    const phrases = store.list().map((e) => e.phrase);
    expect(phrases).toEqual(expect.arrayContaining([
      'Mark Firestone', 'Mark Thomas Firestone', 'Sukhumvit 81', 'President Sukhumvit',
    ]));
    // And the seeds were persisted, not just held in memory.
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.entries.length).toBe(store.list().length);
  });

  it('adds, updates, disables, enables, and removes phrases', () => {
    const store = createCommentFilterStore(tmpFile());
    const added = store.add('private phrase');
    expect(added.ok).toBe(true);
    expect(store.match('PRIVATE PHRASE')).toMatchObject({ phrase: 'private phrase' });

    const edited = store.update(added.entry.id, { phrase: 'new phrase', enabled: false });
    expect(edited.ok).toBe(true);
    expect(store.match('new phrase')).toBe(null);

    expect(store.update(added.entry.id, { enabled: true }).ok).toBe(true);
    expect(store.match('new phrase')).toMatchObject({ phrase: 'new phrase' });

    expect(store.remove(added.entry.id).ok).toBe(true);
    expect(store.match('new phrase')).toBe(null);
  });

  it('loads legacy array blocklists as enabled phrase entries', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(['old phrase']), 'utf8');
    const store = createCommentFilterStore(file);

    expect(store.match('this has OLD PHRASE')).toMatchObject({ phrase: 'old phrase' });
  });
});
