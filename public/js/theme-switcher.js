const THEMES = [
  { id: 'default', label: 'Default (Midnight)' },
  { id: 'synthwave', label: 'Synthwave 1984' },
  { id: 'neubrutalism', label: 'Neubrutalism' },
  { id: 'aurora', label: 'Aurora (Northern Lights)' },
  { id: 'esports', label: 'Esports / Tactical' },
  { id: 'minimalist', label: 'Minimalist Zen' }
];

function initThemeSwitcher() {
  // Prevent duplicate initialization
  if (document.getElementById('theme-fab-container')) return;

  const container = document.createElement('div');
  container.id = 'theme-fab-container';

  const btn = document.createElement('button');
  btn.id = 'theme-fab';
  btn.innerHTML = '🎨';
  btn.title = 'Switch Theme';

  const menu = document.createElement('div');
  menu.id = 'theme-menu';

  const currentTheme = localStorage.getItem('dashboard-theme') || 'default';

  THEMES.forEach(t => {
    const opt = document.createElement('button');
    opt.className = 'theme-opt' + (t.id === currentTheme ? ' active' : '');
    opt.textContent = t.label;
    opt.dataset.theme = t.id;
    opt.addEventListener('click', () => {
      setTheme(t.id);
      menu.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.theme === t.id));
      menu.classList.remove('open');
    });
    menu.appendChild(opt);
  });

  btn.addEventListener('click', () => {
    menu.classList.toggle('open');
  });

  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) {
      menu.classList.remove('open');
    }
  });

  container.appendChild(menu);
  container.appendChild(btn);
  document.body.appendChild(container);

  // Apply initially
  setTheme(currentTheme);
}

function setTheme(themeId) {
  localStorage.setItem('dashboard-theme', themeId);
  if (themeId === 'default') {
    document.documentElement.setAttribute('data-dashboard-theme', '');
    document.documentElement.setAttribute('data-theme', 'midnight');
  } else {
    document.documentElement.setAttribute('data-dashboard-theme', themeId);
    // Keep base theme as midnight so variables exist if not overridden
    document.documentElement.setAttribute('data-theme', 'midnight');
  }
}

// Run when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initThemeSwitcher);
} else {
  initThemeSwitcher();
}
