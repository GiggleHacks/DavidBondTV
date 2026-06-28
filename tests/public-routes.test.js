import { describe, expect, it } from 'vitest';
import { canonicalCoursePath, canonicalVideoPath, resolveCanonicalRedirect, slugifyPathPart } from '../lib/public-routes.js';

const videos = [
  { id: 'vid_1', title: 'My First Video!' },
  { id: 'vid_2', title: 'My First Video!' },
];
const products = [
  { slug: 'digital-pickup', name: 'Digital Pickup' },
];

describe('public route canonicals', () => {
  it('generates stable readable paths for videos and courses', () => {
    expect(slugifyPathPart('My First Video!')).toBe('my-first-video');
    expect(canonicalVideoPath(videos[0], videos)).toBe('/videos/my-first-video');
    expect(canonicalVideoPath(videos[1], videos)).toBe('/videos/my-first-video-vid-2');
    expect(canonicalCoursePath(products[0])).toBe('/courses/digital-pickup');
  });

  it('redirects legacy query URLs to canonical paths when resolvable', () => {
    expect(resolveCanonicalRedirect('/watch?v=vid_1', { videos, products })).toEqual({
      status: 301,
      location: '/videos/my-first-video',
    });
    expect(resolveCanonicalRedirect('/course.html?slug=digital-pickup', { videos, products })).toEqual({
      status: 301,
      location: '/courses/digital-pickup',
    });
  });

  it('resolves canonical paths back to existing static pages', () => {
    expect(resolveCanonicalRedirect('/videos/my-first-video', { videos, products })).toEqual({
      rewrite: '/index.html',
      query: { v: 'vid_1' },
    });
    expect(resolveCanonicalRedirect('/courses/digital-pickup', { videos, products })).toEqual({
      rewrite: '/course.html',
      query: { slug: 'digital-pickup' },
    });
  });
});
