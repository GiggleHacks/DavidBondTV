import { describe, it, expect } from 'vitest';
import { diffManifest, artifactUrlsForEntry, metaFingerprintForEntry } from '../lib/sync-diff.mjs';

describe('diffManifest', () => {
  const server = [
    { id: 'a', fingerprint: 'fa' },
    { id: 'b', fingerprint: 'fb' },
  ];

  it('classifies present / changed / missing', () => {
    const r = diffManifest(server, [
      { id: 'a', fingerprint: 'fa' }, // present
      { id: 'b', fingerprint: 'fb2' }, // changed
      { id: 'c', fingerprint: 'fc' }, // missing
    ]);
    expect(r.present).toEqual(['a']);
    expect(r.changed).toEqual(['b']);
    expect(r.missing).toEqual(['c']);
  });

  it('treats an id absent on the server as missing', () => {
    expect(diffManifest([], [{ id: 'x', fingerprint: 'f' }]).missing).toEqual(['x']);
  });

  it('handles empty/garbage inputs', () => {
    expect(diffManifest(null, null)).toEqual({ present: [], changed: [], missing: [] });
  });

  it('flags a settings-only change (e.g. blur) as changed even when the file is identical', () => {
    const serverEntry = { id: 'a', fingerprint: 'fa', visibility: 'premium', blur: 'medium' };
    const sameMeta = metaFingerprintForEntry(serverEntry);
    const blurChanged = metaFingerprintForEntry({ ...serverEntry, blur: 'strongest' });

    // Same file, same settings → present (skip).
    expect(diffManifest([serverEntry], [{ id: 'a', fingerprint: 'fa', metaFingerprint: sameMeta }]).present).toEqual(['a']);
    // Same file, blur edited → changed (re-sync the entry; artifacts short-circuit).
    expect(diffManifest([serverEntry], [{ id: 'a', fingerprint: 'fa', metaFingerprint: blurChanged }]).changed).toEqual(['a']);
  });

  it('ignores metaFingerprint when the client omits it (legacy clients)', () => {
    const server = [{ id: 'a', fingerprint: 'fa', blur: 'off' }];
    expect(diffManifest(server, [{ id: 'a', fingerprint: 'fa' }]).present).toEqual(['a']);
  });
});

describe('metaFingerprintForEntry', () => {
  it('is stable for the same settings and changes when a synced setting changes', () => {
    const base = { id: 'v', title: 'T', visibility: 'premium', blur: 'medium', published: true };
    expect(metaFingerprintForEntry(base)).toBe(metaFingerprintForEntry({ ...base }));
    expect(metaFingerprintForEntry(base)).not.toBe(metaFingerprintForEntry({ ...base, blur: 'off' }));
    expect(metaFingerprintForEntry(base)).not.toBe(metaFingerprintForEntry({ ...base, visibility: 'free' }));
  });

  it('ignores fields that are not part of the publishable settings', () => {
    const base = { id: 'v', title: 'T', blur: 'medium' };
    // fingerprint / originalSize are not synced settings — they must not affect the hash.
    expect(metaFingerprintForEntry(base)).toBe(metaFingerprintForEntry({ ...base, fingerprint: 'xyz', originalSize: 999 }));
  });
});

describe('artifactUrlsForEntry', () => {
  it('collects thumb, candidates, preview, renditions, storyboard — deduped', () => {
    const urls = artifactUrlsForEntry({
      id: 'v1',
      thumb: '/thumbs/thumb-v1-1.jpg',
      thumbCandidates: ['/thumbs/thumb-v1-0.jpg', '/thumbs/thumb-v1-1.jpg'], // dup of thumb
      preview: '/previews/preview-v1.mp4',
      storyboard: '/storyboards/v1/storyboard.json',
      qualityLevels: [
        { height: 360, url: '/videos/v1/360p.mp4' },
        { height: 720, url: '/videos/v1/720p.mp4' },
      ],
    });
    expect(urls).toContain('/thumbs/thumb-v1-1.jpg');
    expect(urls).toContain('/thumbs/thumb-v1-0.jpg');
    expect(urls).toContain('/previews/preview-v1.mp4');
    expect(urls).toContain('/storyboards/v1/storyboard.json');
    expect(urls).toContain('/videos/v1/360p.mp4');
    expect(urls).toContain('/videos/v1/720p.mp4');
    // De-duplicated: thumb-v1-1.jpg appears once despite being in both fields.
    expect(urls.filter((u) => u === '/thumbs/thumb-v1-1.jpg')).toHaveLength(1);
  });

  it('ignores nulls and non-/ values', () => {
    const urls = artifactUrlsForEntry({ id: 'v', thumb: null, preview: 'http://x/y.mp4', qualityLevels: [{ url: null }] });
    expect(urls).toEqual([]);
  });
});
