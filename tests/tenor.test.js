import { describe, it, expect } from 'vitest';
import { isTenorGifUrl, createTenor } from '../lib/tenor.js';
import { validateComment } from '../lib/comments-store.js';

describe('isTenorGifUrl', () => {
  it('accepts https Tenor media gif URLs', () => {
    expect(isTenorGifUrl('https://media.tenor.com/abc123/funny.gif')).toBe(true);
    expect(isTenorGifUrl('https://media1.tenor.com/x/y.gif')).toBe(true);
    expect(isTenorGifUrl('https://c.tenor.com/x/y.GIF')).toBe(true);
    expect(isTenorGifUrl('https://tenor.com/view/a.gif')).toBe(true);
  });
  it('rejects non-Tenor, non-https, non-gif, and junk', () => {
    expect(isTenorGifUrl('https://evil.com/x.gif')).toBe(false);
    expect(isTenorGifUrl('https://media.tenor.com.evil.com/x.gif')).toBe(false);
    expect(isTenorGifUrl('http://media.tenor.com/x.gif')).toBe(false);
    expect(isTenorGifUrl('https://media.tenor.com/x/y.png')).toBe(false);
    expect(isTenorGifUrl('javascript:alert(1)//x.gif')).toBe(false);
    expect(isTenorGifUrl('')).toBe(false);
    expect(isTenorGifUrl(null)).toBe(false);
  });
});

describe('createTenor', () => {
  it('is disabled with no key and returns empty results', async () => {
    const t = createTenor({});
    expect(t.enabled).toBe(false);
    expect(await t.trending()).toEqual([]);
    expect(await t.search('cats')).toEqual([]);
  });
  it('shapes + filters results, applying the content filter', async () => {
    let calledUrl = '';
    const fetchImpl = async (url) => {
      calledUrl = url;
      return {
        ok: true,
        json: async () => ({ results: [
          { id: '1', content_description: 'cat', media_formats: { gif: { url: 'https://media.tenor.com/a/b.gif' }, tinygif: { url: 'https://media.tenor.com/a/t.gif' } } },
          { id: '2', media_formats: { gif: { url: 'https://evil.com/x.gif' } } }, // dropped (not tenor)
        ] }),
      };
    };
    const t = createTenor({ apiKey: 'k', fetchImpl });
    const out = await t.search('cat');
    expect(out).toEqual([{ id: '1', url: 'https://media.tenor.com/a/b.gif', preview: 'https://media.tenor.com/a/t.gif', desc: 'cat' }]);
    expect(calledUrl).toContain('contentfilter=high');
    expect(calledUrl).toContain('q=cat');
  });
});

describe('validateComment with GIF', () => {
  it('allows empty text when a gif is attached', () => {
    expect(validateComment({ text: '', hasGif: true }).ok).toBe(true);
    expect(validateComment({ text: '   ', hasGif: true }).ok).toBe(true);
  });
  it('still requires text or a gif', () => {
    expect(validateComment({ text: '', hasGif: false }).ok).toBe(false);
  });
});
