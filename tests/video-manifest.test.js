import { describe, expect, it } from 'vitest';
import { sanitizePublicVideo, sanitizePlaybackVideo } from '../lib/video-manifest.js';

const fullVideo = {
  id: 'vid-1',
  title: 'Premium clip',
  description: 'desc',
  status: 'ready',
  duration: 12,
  durLabel: '0:12',
  thumb: '/thumbs/thumb-vid-1.jpg',
  preview: '/previews/preview-vid-1.mp4',
  uploaded: 'Jun 23, 2026',
  uploadedAt: 123,
  published: true,
  publishAt: 456,
  visibility: 'premium',
  blur: 'medium',
  category: 'cat',
  storyboard: '/storyboards/vid-1/storyboard.json',
  thumbCandidates: ['/thumbs/t0.jpg'],
  qualityLevels: [{ height: 720, url: '/videos/vid-1/720p.mp4' }],
};

describe('video-manifest sanitizers', () => {
  it('removes admin-only and direct-playback fields from the public manifest', () => {
    expect(sanitizePublicVideo(fullVideo)).toEqual({
      id: 'vid-1',
      title: 'Premium clip',
      description: 'desc',
      status: 'ready',
      duration: 12,
      durLabel: '0:12',
      thumb: '/thumbs/thumb-vid-1.jpg',
      preview: '/previews/preview-vid-1.mp4',
      uploaded: 'Jun 23, 2026',
      uploadedAt: 123,
      visibility: 'premium',
      blur: 'medium',
      category: 'cat',
      storyboard: '/storyboards/vid-1/storyboard.json',
    });
  });

  it('returns only playback-safe fields for the protected playback endpoint', () => {
    expect(sanitizePlaybackVideo(fullVideo)).toEqual({
      id: 'vid-1',
      status: 'ready',
      preview: '/previews/preview-vid-1.mp4',
      storyboard: '/storyboards/vid-1/storyboard.json',
      qualityLevels: [{ height: 720, url: '/videos/vid-1/720p.mp4' }],
    });
  });
});
