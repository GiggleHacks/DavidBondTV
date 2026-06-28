export function slugifyPathPart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

export function canonicalVideoPath(video, videos = []) {
  if (!video || !video.id) return null;
  const base = slugifyPathPart(video.slug || video.title || video.id);
  const sameBase = videos.filter((v) => slugifyPathPart(v.slug || v.title || v.id) === base);
  if (sameBase.length > 1 && sameBase[0] !== video) return `/videos/${base}-${slugifyPathPart(video.id).slice(0, 16)}`;
  return `/videos/${base}`;
}

export function canonicalCoursePath(product) {
  if (!product || !product.slug) return null;
  return `/courses/${slugifyPathPart(product.slug)}`;
}

function findVideoBySlug(slug, videos) {
  for (const v of videos) {
    const p = canonicalVideoPath(v, videos);
    if (p === `/videos/${slug}`) return v;
  }
  return null;
}

function findProductBySlug(slug, products) {
  return products.find((p) => slugifyPathPart(p.slug) === slug) || null;
}

export function resolveCanonicalRedirect(rawUrl, { videos = [], products = [] } = {}) {
  const url = new URL(rawUrl, 'http://localhost');
  const path = decodeURIComponent(url.pathname);
  const suffixWithout = (keys) => {
    const q = new URLSearchParams(url.searchParams);
    for (const key of keys) q.delete(key);
    const s = q.toString();
    return s ? `?${s}` : '';
  };

  if (path === '/watch' || path === '/index.html') {
    const id = url.searchParams.get('v');
    const video = videos.find((v) => v.id === id);
    const location = canonicalVideoPath(video, videos);
    return location ? { status: 301, location: location + suffixWithout(['v']) } : null;
  }

  if (path === '/course' || path === '/course.html') {
    const slug = url.searchParams.get('slug');
    const product = products.find((p) => p.slug === slug);
    const location = canonicalCoursePath(product);
    return location ? { status: 301, location: location + suffixWithout(['slug']) } : null;
  }

  const vm = /^\/videos\/([^/?#]+)$/.exec(path);
  if (vm) {
    const video = findVideoBySlug(vm[1], videos);
    return video ? { rewrite: '/index.html', query: { v: video.id } } : null;
  }

  const cm = /^\/courses\/([^/?#]+)$/.exec(path);
  if (cm) {
    const product = findProductBySlug(cm[1], products);
    return product ? { rewrite: '/course.html', query: { slug: product.slug } } : null;
  }

  return null;
}
