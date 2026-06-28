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

  it('seeds Mark Firestone as an enabled shadow-ban phrase', () => {
    const store = createCommentFilterStore(tmpFile());

    const match = store.match('I heard your legal name is Mark Firestone.');

    expect(match).toMatchObject({ phrase: 'Mark Firestone', enabled: true });
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
