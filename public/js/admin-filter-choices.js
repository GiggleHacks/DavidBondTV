import { categoryDisplayName, categoryVisualText, categoryVisualMarkup } from './category-visuals.js';

export const STATE_FILTER_CHOICES = [
  { value: '', label: 'All states', icon: '◌', tone: 'all' },
  { value: 'uploaded', label: 'In review', icon: '◷', tone: 'review' },
  { value: 'encoding', label: 'Encoding', icon: '◔', tone: 'processing' },
  { value: 'draft-approved', label: 'Approved', icon: '✓', tone: 'approved' },
  { value: 'published', label: 'Published (live)', icon: '●', tone: 'live' },
  { value: 'rejected', label: 'Rejected', icon: '⊘', tone: 'failed' },
  { value: 'failed', label: 'Failed', icon: '✕', tone: 'failed' },
  { value: 'draft-unapproved', label: 'Draft · Unapproved', icon: '◌', tone: 'draft' },
];

export const ACCESS_FILTER_CHOICES = [
  { value: '', label: 'All access', icon: '◌', tone: 'all' },
  { value: 'free', label: 'Free', icon: '🔓', tone: 'free' },
  { value: 'premium', label: 'Premium', icon: '★', tone: 'premium' },
];

export function choiceIcon(choice, fallback = '') {
  return choice && choice.icon ? choice.icon : fallback;
}

export function choiceTone(choice, fallback = 'all') {
  return choice && choice.tone ? choice.tone : fallback;
}

export function buildCategoryChoices(categories, videos) {
  const choices = [{ value: '', label: 'All categories', icon: '◌', tone: 'all' }]
    .concat((categories || []).map((c) => ({
      value: c.slug,
      label: categoryDisplayName(c),
      icon: categoryVisualText(c, '#'),
      // SVG/markup glyph (self-hosted flag or icon span) for HTML chip contexts —
      // flags render as images here, never as broken emoji.
      iconHtml: categoryVisualMarkup(c, 'cat-glyph'),
      tone: 'category',
    })));
  if ((videos || []).some((v) => !v.category)) {
    choices.push({ value: '__none__', label: 'Uncategorized', icon: '∅', tone: 'uncategorized' });
  }
  return choices;
}

export function findChoiceLabel(choices, value, fallback) {
  if (!value) return fallback;
  return (choices || []).find((choice) => choice.value === value)?.label || fallback;
}
