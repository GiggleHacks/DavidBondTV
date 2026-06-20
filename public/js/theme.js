// Theme registry + persistence. Each theme is a set of CSS custom properties
// defined in styles.css under [data-theme="<id>"]; this module just toggles the
// data-theme attribute on <html> and remembers the choice.
export const THEMES = [
  { id: 'midnight', name: 'Midnight Blue', swatch: '#3b82f6' },
  { id: 'red', name: 'Classic Red', swatch: '#ff0033' },
  { id: 'purple', name: 'Royal Purple', swatch: '#8b5cf6' },
  { id: 'emerald', name: 'Emerald', swatch: '#10b981' },
  { id: 'mono', name: 'Mono', swatch: '#e8e8e8' },
];

const STORAGE_KEY = 'dbtv-theme';
const DEFAULT_THEME = 'midnight';

export function getTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && THEMES.some((t) => t.id === saved)) return saved;
  } catch {
    /* localStorage unavailable — fall through to default */
  }
  return DEFAULT_THEME;
}

export function applyTheme(id) {
  const theme = THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore persistence failure */
  }
}

export function initTheme() {
  applyTheme(getTheme());
}
