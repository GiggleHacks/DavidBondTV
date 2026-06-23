function pick(entry, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(entry, key) && entry[key] !== undefined) out[key] = entry[key];
  }
  return out;
}

export function sanitizePublicVideo(entry) {
  return pick(entry, [
    'id',
    'title',
    'description',
    'status',
    'duration',
    'durLabel',
    'thumb',
    'preview',
    'uploaded',
    'uploadedAt',
    'visibility',
    'blur',
    'category',
    'storyboard',
  ]);
}

export function sanitizePlaybackVideo(entry) {
  return pick(entry, [
    'id',
    'status',
    'preview',
    'storyboard',
    'qualityLevels',
    'hls',
  ]);
}
