import { describe, expect, it } from 'vitest';
import {
  ACCESS_FILTER_CHOICES,
  STATE_FILTER_CHOICES,
  buildCategoryChoices,
  choiceIcon,
  choiceTone,
  findChoiceLabel,
} from '../public/js/admin-filter-choices.js';

describe('buildCategoryChoices', () => {
  it('adds uncategorized only when at least one video has no category', () => {
    const cats = [{ slug: 'privacy', name: 'Privacy' }];
    const withUncategorized = buildCategoryChoices(cats, [{ id: 'a' }, { id: 'b', category: 'privacy' }]);
    const withoutUncategorized = buildCategoryChoices(cats, [{ id: 'b', category: 'privacy' }]);

    expect(withUncategorized.map((c) => c.value)).toEqual(['', 'privacy', '__none__']);
    expect(withUncategorized[0]).toEqual({ value: '', label: 'All categories', icon: '◌', tone: 'all' });
    expect(withUncategorized[1]).toMatchObject({ value: 'privacy', label: 'Privacy', icon: '#', tone: 'category' });
    expect(withUncategorized[2]).toEqual({ value: '__none__', label: 'Uncategorized', icon: '∅', tone: 'uncategorized' });
    expect(withoutUncategorized.map((c) => c.value)).toEqual(['', 'privacy']);
  });

  it('renders category flags as self-hosted SVG markup, never emoji', () => {
    const cats = [
      { slug: 'hacking', name: 'Hacking', icon: '💻' },
      { slug: 'colombia', name: 'Colombia Harem', flag: 'co' },
    ];
    const [, hacking, colombia] = buildCategoryChoices(cats, []);
    // Plain emoji icons still render as text (they work cross-platform).
    expect(hacking).toMatchObject({ value: 'hacking', label: 'Hacking', icon: '💻', tone: 'category' });
    expect(hacking.iconHtml).toContain('💻');
    // Flags carry NO emoji glyph; the chip uses the self-hosted SVG flag instead.
    expect(colombia.icon).toBe('#');
    expect(colombia.iconHtml).toContain('/vendor/flags/4x3/co.svg');
    expect(colombia.iconHtml).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u); // no regional-indicator emoji
  });
});

describe('findChoiceLabel', () => {
  it('returns the matching label or a fallback for empty / unknown values', () => {
    const choices = [
      { value: '', label: 'All states' },
      { value: 'published', label: 'Published (live)' },
    ];

    expect(findChoiceLabel(choices, 'published', 'All states')).toBe('Published (live)');
    expect(findChoiceLabel(choices, '', 'All states')).toBe('All states');
    expect(findChoiceLabel(choices, 'missing', 'All states')).toBe('All states');
  });
});

describe('filter metadata', () => {
  it('defines tones and icons for state and access chips', () => {
    // Review-first lifecycle states: uploaded (in review) → encoding → approved.
    expect(STATE_FILTER_CHOICES.find((choice) => choice.value === 'uploaded')).toEqual({
      value: 'uploaded',
      label: 'In review',
      icon: '◷',
      tone: 'review',
    });
    expect(STATE_FILTER_CHOICES.find((choice) => choice.value === 'encoding')).toEqual({
      value: 'encoding',
      label: 'Encoding',
      icon: '◔',
      tone: 'processing',
    });
    expect(ACCESS_FILTER_CHOICES.find((choice) => choice.value === 'premium')).toEqual({
      value: 'premium',
      label: 'Premium',
      icon: '★',
      tone: 'premium',
    });
  });

  it('returns icon and tone fallbacks', () => {
    expect(choiceIcon({ icon: '💻' }, '?')).toBe('💻');
    expect(choiceIcon({}, '?')).toBe('?');
    expect(choiceTone({ tone: 'live' }, 'default')).toBe('live');
    expect(choiceTone({}, 'default')).toBe('default');
  });
});
