import { COUNTRIES } from './countries.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const FLAG_NAME_BY_CODE = new Map(COUNTRIES.map((country) => [String(country.code || '').toLowerCase(), country.name]));

export const CUSTOM_CATEGORY_ICONS = [
  { key: 'shield', label: 'Shield', text: '🛡️', tone: 'violet', terms: ['shield', 'security', 'privacy', 'safe', 'protect', 'guard'] },
  { key: 'lock', label: 'Lock', text: '🔐', tone: 'pink', terms: ['lock', 'secure', 'private', 'locked', 'premium'] },
  { key: 'globe', label: 'Globe', text: '🌐', tone: 'blue', terms: ['globe', 'world', 'international', 'travel', 'global'] },
  { key: 'camera', label: 'Camera', text: '📹', tone: 'amber', terms: ['camera', 'video', 'film', 'record', 'upload'] },
  { key: 'code', label: 'Code', text: '⌘', tone: 'emerald', terms: ['code', 'tech', 'computer', 'programming', 'hacking'] },
  { key: 'ghost', label: 'Ghost', text: '◌', tone: 'slate', terms: ['ghost', 'privacy', 'hidden', 'stealth', 'anonymous'] },
  { key: 'plane', label: 'Plane', text: '✈️', tone: 'sky', terms: ['plane', 'travel', 'flight', 'trip', 'passport'] },
  { key: 'map', label: 'Map', text: '🧭', tone: 'orange', terms: ['map', 'location', 'journey', 'explore', 'country'] },
  { key: 'alert', label: 'Alert', text: '⚠️', tone: 'red', terms: ['alert', 'warning', 'danger', 'crime', 'news'] },
  { key: 'star', label: 'Star', text: '✦', tone: 'gold', terms: ['star', 'featured', 'favorite', 'special', 'highlight'] },
  { key: 'fire', label: 'Fire', text: '🔥', tone: 'rose', terms: ['fire', 'hot', 'trending', 'intense', 'viral'] },
  { key: 'book', label: 'Book', text: '📘', tone: 'indigo', terms: ['book', 'course', 'guide', 'tutorial', 'lesson'] },
];

const EMOJI_OPTIONS = [
  { glyph: '😀', label: 'Grinning face', terms: ['happy', 'smile', 'fun'] },
  { glyph: '😎', label: 'Cool face', terms: ['cool', 'sunglasses', 'style'] },
  { glyph: '🤩', label: 'Star eyes', terms: ['excited', 'wow', 'featured'] },
  { glyph: '🥳', label: 'Celebration', terms: ['party', 'celebrate', 'fun'] },
  { glyph: '👻', label: 'Ghost', terms: ['ghost', 'anonymous', 'privacy'] },
  { glyph: '🤖', label: 'Robot', terms: ['robot', 'ai', 'tech'] },
  { glyph: '🐶', label: 'Dog', terms: ['dog', 'animal', 'pet'] },
  { glyph: '🐱', label: 'Cat', terms: ['cat', 'animal', 'pet'] },
  { glyph: '🦁', label: 'Lion', terms: ['lion', 'animal', 'wild'] },
  { glyph: '🐺', label: 'Wolf', terms: ['wolf', 'animal', 'wild'] },
  { glyph: '🦅', label: 'Eagle', terms: ['eagle', 'bird', 'freedom'] },
  { glyph: '🐍', label: 'Snake', terms: ['snake', 'animal', 'danger'] },
  { glyph: '🦈', label: 'Shark', terms: ['shark', 'ocean', 'predator'] },
  { glyph: '🌎', label: 'Globe Americas', terms: ['world', 'earth', 'travel'] },
  { glyph: '🌴', label: 'Palm tree', terms: ['beach', 'tropical', 'travel'] },
  { glyph: '🌋', label: 'Volcano', terms: ['volcano', 'mountain', 'travel'] },
  { glyph: '🔥', label: 'Fire', terms: ['fire', 'hot', 'trending'] },
  { glyph: '⚡', label: 'Lightning', terms: ['power', 'energy', 'fast'] },
  { glyph: '💎', label: 'Diamond', terms: ['diamond', 'premium', 'luxury'] },
  { glyph: '🔒', label: 'Lock', terms: ['lock', 'private', 'secure'] },
  { glyph: '🛡️', label: 'Shield', terms: ['shield', 'security', 'protect'] },
  { glyph: '💻', label: 'Laptop', terms: ['computer', 'laptop', 'hacking', 'tech'] },
  { glyph: '📱', label: 'Phone', terms: ['phone', 'mobile', 'device'] },
  { glyph: '📸', label: 'Photo camera', terms: ['camera', 'photo', 'picture'] },
  { glyph: '🎥', label: 'Movie camera', terms: ['movie', 'camera', 'video'] },
  { glyph: '🎬', label: 'Clapper board', terms: ['film', 'video', 'shoot'] },
  { glyph: '🎧', label: 'Headphones', terms: ['music', 'audio', 'listen'] },
  { glyph: '🎯', label: 'Target', terms: ['target', 'focus', 'goal'] },
  { glyph: '🚨', label: 'Police light', terms: ['alert', 'crime', 'emergency'] },
  { glyph: '✈️', label: 'Plane', terms: ['plane', 'travel', 'flight'] },
  { glyph: '🚀', label: 'Rocket', terms: ['rocket', 'launch', 'fast'] },
  { glyph: '🧭', label: 'Compass', terms: ['compass', 'map', 'travel'] },
  { glyph: '🏝️', label: 'Island', terms: ['island', 'beach', 'travel'] },
  { glyph: '🏳️', label: 'White flag', terms: ['flag', 'signal'] },
  { glyph: '⭐', label: 'Star', terms: ['star', 'favorite', 'featured'] },
  { glyph: '❤️', label: 'Heart', terms: ['heart', 'love'] },
  { glyph: '💰', label: 'Money', terms: ['money', 'cash', 'finance'] },
  { glyph: '📈', label: 'Chart up', terms: ['chart', 'growth', 'business'] },
  { glyph: '📘', label: 'Blue book', terms: ['book', 'course', 'tutorial'] },
];

function normalizeName(name) {
  let text = String(name || '').trim();
  try {
    text = text.replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\s._-]+/gu, '').trim();
  } catch {
    text = text.replace(/^[^A-Za-z0-9]+/, '').trim();
  }
  return text || String(name || '').trim() || 'Untitled category';
}

function flagEmoji(code) {
  const upper = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return '';
  return [...upper].map((ch) => String.fromCodePoint(127397 + ch.charCodeAt(0))).join('');
}

export function categoryDisplayName(category) {
  return normalizeName(category && category.name);
}

export function resolveCategoryVisual(category) {
  if (!category || typeof category !== 'object') return null;
  const visual = category.visual && typeof category.visual === 'object' ? category.visual : null;
  const kind = visual && typeof visual.kind === 'string' ? visual.kind : '';
  const value = visual && typeof visual.value === 'string' ? visual.value.trim() : '';
  if (kind === 'flag' && /^[a-z]{2}$/i.test(value)) {
    const code = value.toLowerCase();
    return { kind: 'flag', value: code, text: flagEmoji(code), label: FLAG_NAME_BY_CODE.get(code) || code.toUpperCase() };
  }
  if (kind === 'custom' && value) {
    const custom = CUSTOM_CATEGORY_ICONS.find((item) => item.key === value);
    if (custom) return { kind: 'custom', value: custom.key, text: custom.text, label: custom.label, tone: custom.tone };
  }
  if (kind === 'emoji' && value) return { kind: 'emoji', value, text: value, label: visual.label || value };
  if (category.iconKey) {
    const custom = CUSTOM_CATEGORY_ICONS.find((item) => item.key === category.iconKey);
    if (custom) return { kind: 'custom', value: custom.key, text: custom.text, label: custom.label, tone: custom.tone };
  }
  if (category.flag && /^[a-z]{2}$/i.test(category.flag)) {
    const code = String(category.flag).toLowerCase();
    return { kind: 'flag', value: code, text: flagEmoji(code), label: FLAG_NAME_BY_CODE.get(code) || code.toUpperCase() };
  }
  if (category.icon) return { kind: 'emoji', value: category.icon, text: category.icon, label: category.icon };
  return null;
}

export function categoryVisualText(category, fallback = '•') {
  return resolveCategoryVisual(category)?.text || fallback;
}

export function categoryLabelWithVisual(category, fallback = 'Uncategorized') {
  if (!category) return fallback;
  return `${categoryVisualText(category)} ${categoryDisplayName(category)}`.trim();
}

export function categoryBadge(category) {
  const visual = resolveCategoryVisual(category);
  if (!visual) return { kind: 'fallback', text: '•' };
  if (visual.kind === 'flag') return { kind: 'flag', text: visual.text, code: visual.value };
  if (visual.kind === 'custom') return { kind: 'custom', text: visual.text, key: visual.value, tone: visual.tone };
  return { kind: 'icon', text: visual.text };
}

export function categoryVisualMarkup(category, className = 'cat-visual') {
  const visual = resolveCategoryVisual(category);
  if (!visual) return `<span class="${esc(className)} is-empty" aria-hidden="true">•</span>`;
  if (visual.kind === 'flag') {
    return `<span class="${esc(className)} is-flag" aria-hidden="true"><img src="/vendor/flags/4x3/${esc(visual.value)}.svg" alt="" loading="lazy" onerror="this.closest('span')?.remove()"></span>`;
  }
  const extra = visual.kind === 'custom' ? ` is-custom tone-${esc(visual.tone || 'slate')}` : ' is-emoji';
  return `<span class="${esc(className)}${extra}" aria-hidden="true">${esc(visual.text)}</span>`;
}

export function buildCategoryIconLibrary() {
  const customs = CUSTOM_CATEGORY_ICONS.map((item) => ({
    id: `custom:${item.key}`,
    kind: 'custom',
    value: item.key,
    label: item.label,
    text: item.text,
    keywords: item.terms.join(' '),
    tone: item.tone,
  }));
  const emojis = EMOJI_OPTIONS.map((item) => ({
    id: `emoji:${item.glyph}`,
    kind: 'emoji',
    value: item.glyph,
    label: item.label,
    text: item.glyph,
    keywords: item.terms.join(' '),
  }));
  const flags = COUNTRIES.map((country) => ({
    id: `flag:${country.code.toLowerCase()}`,
    kind: 'flag',
    value: country.code.toLowerCase(),
    label: country.name,
    text: flagEmoji(country.code),
    keywords: `${country.name} ${country.code} flag country`,
  }));
  return { customs, emojis, flags, all: [...customs, ...emojis, ...flags] };
}

export function matchesCategoryIcon(item, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return `${item.label} ${item.keywords} ${item.value}`.toLowerCase().includes(q);
}

