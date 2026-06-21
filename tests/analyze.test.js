import { describe, it, expect } from 'vitest';
import {
  hashId,
  parseDjiName,
  timeOfDayBucket,
  classifyVisual,
  vibeWord,
  extractKeywords,
  transcriptUsable,
  firstSentence,
  buildFeatures,
  composeTitle,
  composeDescription,
  ensureUniqueTitle,
} from '../lib/analyze.mjs';

describe('hashId', () => {
  it('is deterministic and stable', () => {
    expect(hashId('abc')).toBe(hashId('abc'));
    expect(hashId('abc')).not.toBe(hashId('abd'));
    expect(hashId('')).toBe(hashId(''));
  });
});

describe('parseDjiName', () => {
  it('parses a DJI filename into date + seq', () => {
    const r = parseDjiName('DJI_20260620130918_0155_D');
    expect(r).not.toBeNull();
    expect(r.seq).toBe(155);
    expect(r.date.getFullYear()).toBe(2026);
    expect(r.date.getMonth()).toBe(5); // June (0-indexed)
    expect(r.date.getDate()).toBe(20);
    expect(r.date.getHours()).toBe(13);
  });
  it('returns null for non-DJI names', () => {
    expect(parseDjiName('vacation-clip')).toBeNull();
    expect(parseDjiName('')).toBeNull();
    expect(parseDjiName(undefined)).toBeNull();
  });
});

describe('timeOfDayBucket', () => {
  it('buckets across the day boundaries', () => {
    expect(timeOfDayBucket(3)).toBe('Night');
    expect(timeOfDayBucket(5)).toBe('Morning');
    expect(timeOfDayBucket(11)).toBe('Afternoon');
    expect(timeOfDayBucket(16)).toBe('Golden-Hour');
    expect(timeOfDayBucket(19)).toBe('Evening');
    expect(timeOfDayBucket(22)).toBe('Night');
  });
});

describe('classifyVisual', () => {
  it('classifies a bright, calm, muted clip and ignores hue when muted', () => {
    const c = classifyVisual({ brightness: 180, saturation: 10, hue: 50, sceneRate: 0.02 });
    expect(c.light).toBe('bright');
    expect(c.muted).toBe(true);
    expect(c.color).toBeNull(); // muted ⇒ ignore hue
    expect(c.motion).toBe('calm');
  });
  it('classifies a dark, vivid, violet, dynamic clip', () => {
    const c = classifyVisual({ brightness: 25, saturation: 90, hue: 290, sceneRate: 0.4 });
    expect(c.light).toBe('night');
    expect(c.vivid).toBe(true);
    expect(c.color).toBe('violet');
    expect(c.motion).toBe('dynamic');
    expect(vibeWord(c)).toBe('Neon-Lit');
  });
  it('uses safe defaults for missing input', () => {
    const c = classifyVisual(undefined);
    expect(c.light).toBe('soft');
    expect(c.motion).toBe('lively');
  });
});

describe('extractKeywords', () => {
  it('drops stopwords and ranks by frequency', () => {
    const kws = extractKeywords('We went to the market and the market was huge, a huge market!');
    expect(kws[0]).toBe('market');
    expect(kws).not.toContain('the');
    expect(kws).not.toContain('and');
  });
  it('returns [] for empty/garbage', () => {
    expect(extractKeywords('')).toEqual([]);
    expect(extractKeywords(null)).toEqual([]);
  });
});

describe('transcriptUsable', () => {
  it('rejects short text', () => {
    expect(transcriptUsable('hello there friend')).toBe(false);
  });
  it('rejects known hallucinations', () => {
    expect(transcriptUsable('Thank you. Thank you. Thank you for watching and please subscribe now.')).toBe(false);
  });
  it('rejects single-token dominance', () => {
    expect(transcriptUsable('go go go go go go go go go go go go go go')).toBe(false);
  });
  it('accepts a real sentence', () => {
    expect(transcriptUsable('Welcome to Chatuchak weekend market, the biggest open air market in Bangkok today')).toBe(true);
  });
});

describe('firstSentence', () => {
  it('returns the first sentence', () => {
    expect(firstSentence('Hello world. Second one here.')).toBe('Hello world.');
  });
  it('truncates very long single sentences', () => {
    const long = 'word '.repeat(60);
    const out = firstSentence(long, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('composeTitle / composeDescription', () => {
  const silentFeatures = (id) => buildFeatures({
    id,
    meta: { duration: 50 },
    visual: { brightness: 180, saturation: 10, hue: 0, sceneRate: 0.02 },
    transcript: '',
  });

  it('produces a non-empty, deterministic title', () => {
    const f = silentFeatures('DJI_20260620130918_0155_D');
    const t1 = composeTitle(f);
    const t2 = composeTitle(silentFeatures('DJI_20260620130918_0155_D'));
    expect(t1.length).toBeGreaterThan(0);
    expect(t1).toBe(t2);
  });

  it('gives different ids different templates (variety)', () => {
    const titles = new Set();
    for (const id of [
      'DJI_20260620130918_0155_D',
      'DJI_20260620172159_0170_D',
      'DJI_20260620192040_0177_D',
      'DJI_20260620203734_0187_D',
    ]) titles.add(composeTitle(silentFeatures(id)));
    expect(titles.size).toBeGreaterThan(1);
  });

  it('prefers a keyword title when speech is usable', () => {
    const f = buildFeatures({
      id: 'DJI_20260620130918_0155_D',
      meta: { duration: 50 },
      visual: { brightness: 120, saturation: 40, hue: 0, sceneRate: 0.1 },
      transcript: 'Welcome to Chatuchak weekend market, the biggest market in Bangkok with amazing street food everywhere',
    });
    const title = composeTitle(f);
    expect(title.toLowerCase()).toContain('market');
  });

  it('description is never empty and mentions the date', () => {
    const f = silentFeatures('DJI_20260620130918_0155_D');
    const d = composeDescription(f);
    expect(d.length).toBeGreaterThan(0);
    expect(d).toContain('2026');
    expect(d).toContain('aerial');
  });

  it('handles emoji / odd ids without throwing', () => {
    const f = buildFeatures({ id: '✨weird🎥', mtime: Date.parse('2026-06-20T13:00:00'),
      meta: { duration: 12 }, visual: {}, transcript: '' });
    expect(typeof composeTitle(f)).toBe('string');
    expect(composeTitle(f).length).toBeGreaterThan(0);
  });
});

describe('ensureUniqueTitle', () => {
  it('passes through when no collision', () => {
    expect(ensureUniqueTitle('A', '3:12 PM', new Set())).toBe('A');
  });
  it('appends a natural disambiguator on collision', () => {
    const taken = new Set(['A']);
    expect(ensureUniqueTitle('A', '3:12 PM', taken)).toBe('A · 3:12 PM');
  });
  it('falls back to a numeric suffix if the disambiguator also collides', () => {
    const taken = new Set(['A', 'A · 3:12 PM']);
    expect(ensureUniqueTitle('A', '3:12 PM', taken)).toBe('A (2)');
  });
});
