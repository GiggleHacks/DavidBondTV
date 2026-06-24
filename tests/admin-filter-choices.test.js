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

    expect(withUncategorized).toEqual([
      { value: '', label: 'All categories', icon: '◌', tone: 'all' },
      { value: 'privacy', label: 'Privacy', icon: '#', tone: 'category' },
      { value: '__none__', label: 'Uncategorized', icon: '∅', tone: 'uncategorized' },
    ]);
    expect(withoutUncategorized).toEqual([
      { value: '', label: 'All categories', icon: '◌', tone: 'all' },
      { value: 'privacy', label: 'Privacy', icon: '#', tone: 'category' },
    ]);
  });

  it('uses category icon or flag when available', () => {
    const cats = [
      { slug: 'hacking', name: 'Hacking', icon: '💻' },
      { slug: 'colombia', name: 'Colombia Harem', flag: 'co' },
    ];

    expect(buildCategoryChoices(cats, [])).toEqual([
      { value: '', label: 'All categories', icon: '◌', tone: 'all' },
      { value: 'hacking', label: 'Hacking', icon: '💻', tone: 'category' },
      { value: 'colombia', label: 'Colombia Harem', icon: '🇨🇴', tone: 'category' },
    ]);
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
    expect(STATE_FILTER_CHOICES.find((choice) => choice.value === 'processing')).toEqual({
      value: 'processing',
      label: 'Processing',
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
