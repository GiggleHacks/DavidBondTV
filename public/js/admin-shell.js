// Shared admin header / nav injector. Single source of truth for the backend
// chrome: renders the colour-coded, icon'd nav on every god-* page, themes the
// page to the active section via the --section-accent custom property, and
// (optionally) renders a standardized page-header band. Replaces the nav HTML
// that used to be copy-pasted — and had drifted — across ~13 pages.
//
// Usage in a page: give the header bar id="admin-shell" (empty) and load this as
// a module. The active section + admin route prefix are derived from the URL, so
// the obfuscated admin path stays only in the URL. A page may override the title
// via body[data-admin-title] / body[data-admin-desc], suppress the page-header
// band with body[data-admin-no-header], and the offline preview harness can pin
// section/prefix with body[data-admin-section] / body[data-admin-prefix].

import { NAV_SECTIONS, resolveSectionContext, sectionHref } from './section-visuals.js';
import { icon } from './admin-icons.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function navMarkup(prefix, activeKey) {
  const items = NAV_SECTIONS.map((s) => {
    const active = s.key === activeKey ? ' active' : '';
    const ink = s.dark ? '#06141f' : '#ffffff';
    return `<a class="admin-nav-item${active}" href="${esc(sectionHref(prefix, s))}" data-section="${esc(s.key)}"`
      + ` style="--i-accent:${esc(s.accent)};--i-ink:${ink}" ${active ? 'aria-current="page"' : ''}>`
      + `<span class="nav-ico">${icon(s.icon)}</span>`
      + `<span class="nav-label">${esc(s.label)}</span></a>`;
  }).join('');
  return `<a class="logo" href="/" title="Back to site" style="text-decoration:none">`
    + `<span class="logo-wm"><span class="wm-pre">David Bond</span><span class="wm-box">TV</span></span></a>`
    + `<nav class="admin-nav" aria-label="Admin sections">${items}`
    + `<a class="admin-nav-item back" href="/"><span class="nav-ico">${icon('back')}</span><span class="nav-label">Site</span></a>`
    + `</nav>`;
}

function pageHeaderMarkup(section, body) {
  const ds = body.dataset || {};
  const title = ds.adminTitle || section.label;
  const desc = ds.adminDesc || section.desc || '';
  return `<div class="page-header">`
    + `<span class="ph-icon">${icon(section.icon, { size: '24px' })}</span>`
    + `<div class="ph-text"><h1 class="ph-title">${esc(title)}</h1>`
    + (desc ? `<p class="ph-desc">${esc(desc)}</p>` : '')
    + `</div></div>`;
}

function mount() {
  const body = document.body;
  const ctx = resolveSectionContext(location.pathname, body);
  const section = ctx.section;

  // Theme the page to the active section.
  const root = document.documentElement;
  root.style.setProperty('--section-accent', section.accent);
  root.style.setProperty('--section-ink', section.dark ? '#06141f' : '#ffffff');
  root.setAttribute('data-admin-section', section.key);

  // Render the nav into the header bar (id="admin-shell"). Fall back to an
  // existing .admin-bar, or create one at the top of the app shell.
  let bar = document.getElementById('admin-shell') || document.querySelector('.admin-bar');
  if (!bar) {
    const shell = document.querySelector('.admin-app-shell') || body;
    bar = document.createElement('header');
    bar.className = 'admin-bar';
    shell.insertBefore(bar, shell.firstChild);
  }
  bar.classList.add('admin-bar');
  bar.innerHTML = navMarkup(ctx.prefix, section.key);

  // Optional standardized page-header band at the top of <main>.
  if (!('adminNoHeader' in (body.dataset || {}))) {
    const main = document.querySelector('.admin-app-shell main') || document.querySelector('main');
    if (main && !main.querySelector(':scope > .page-header')) {
      const wrap = document.createElement('div');
      wrap.innerHTML = pageHeaderMarkup(section, body);
      main.insertBefore(wrap.firstChild, main.firstChild);
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
