import { categoryDisplayName, resolveCategoryVisual, categoryVisualMarkup } from './category-visuals.js';

// Persistent YouTube-style left navigation for the homepage. Renders the David
// Bond brand vertically — a large rounded avatar on top with the "David Bond TV"
// wordmark beneath — then the section nav (All / Exclusive) and the admin-managed
// categories. The sidebar is ALWAYS visible (no hamburger / no collapse): on wide
// screens it sits fixed at the left and pushes the grid; on narrow screens it
// reflows to a brand-on-top bar with a horizontal scrolling nav row. Selecting an
// item emits `dbtv:nav` { section, category } which browse.js listens for.
const HOME = '<svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>';
const STAR = '<svg viewBox="0 0 24 24"><path d="M12 17.27l5.18 3.14-1.37-5.9L20.5 9.6l-6.05-.52L12 3.5 9.55 9.08 3.5 9.6l4.69 4.91-1.37 5.9z"/></svg>';
const TAG = '<svg viewBox="0 0 24 24"><path d="M21.41 11.58l-9-9A2 2 0 0011 2H4a2 2 0 00-2 2v7a2 2 0 00.59 1.42l9 9a2 2 0 002.82 0l7-7a2 2 0 000-2.84zM6.5 8A1.5 1.5 0 118 6.5 1.5 1.5 0 016.5 8z"/></svg>';
const CAP = '<svg viewBox="0 0 24 24"><path d="M12 3 1 9l11 6 9-4.91V17h2V9zM5 13.18v4L12 21l7-3.82v-4L12 17z"/></svg>';
const BAG = '<svg viewBox="0 0 24 24"><path d="M7 4V2h10v2h3a1 1 0 011 1l-1.34 14.06A2 2 0 0117.67 21H6.33a2 2 0 01-1.99-1.94L3 5a1 1 0 011-1h3zm2 0h6V2.99H9V4zm-3 4h12l.86-2H5.14L6 8z"/></svg>';

function itemHTML(section, category, label, icon, active, count = null) {
  const countBadge = (count !== null && count !== undefined) ? `<span class="sb-count">${count}</span>` : '';
  return `<button class="sb-item${active ? ' active' : ''}" data-section="${section}" data-category="${category}">
    <span class="sb-ico">${icon}</span><span>${label}</span>${countBadge}</button>`;
}

function browseUrl(section, category) {
  const params = new URLSearchParams();
  if (section && section !== 'all') params.set('section', section);
  if (category) params.set('category', category);
  const query = params.toString();
  return query ? `/videos?${query}` : '/videos';
}

async function build() {
  const header = document.querySelector('.site-header');
  if (!header || document.querySelector('.sidebar')) return;
  const isBrowseSurface = !!document.querySelector('.browse');
  if (!isBrowseSurface) document.body.classList.add('has-sidebar-shell');
  const params = new URLSearchParams(location.search);
  const currentSection = isBrowseSurface ? (params.get('section') || 'all') : 'all';
  const currentCategory = isBrowseSurface ? (params.get('category') || '') : '';

  // Keep the panel flush under the (variable-height) sticky header.
  const syncHeaderHeight = () => {
    document.documentElement.style.setProperty('--hdr-h', `${Math.round(header.getBoundingClientRect().height)}px`);
  };
  syncHeaderHeight();
  [60, 250, 700, 1500].forEach((t) => setTimeout(syncHeaderHeight, t));
  window.addEventListener('load', syncHeaderHeight);
  window.addEventListener('resize', syncHeaderHeight);
  if (window.ResizeObserver) new ResizeObserver(syncHeaderHeight).observe(header);

  const nav = document.createElement('nav');
  nav.className = 'sidebar';
  nav.setAttribute('aria-label', 'Browse');

  // Fetch the category registry + published products + videos (best-effort, in parallel).
  let cats = [];
  let courses = [];
  let videos = [];
  try {
    const [catsRes, prodsRes, vidsRes] = await Promise.all([
      fetch('/api/categories').then(r => r.json()).catch(() => ({})),
      fetch('/api/products').then(r => r.json()).catch(() => ({})),
      fetch('/thumbs/videos.json').then(r => r.json()).catch(() => [])
    ]);
    cats = catsRes.categories || [];
    courses = (prodsRes.products || []).filter((p) => p.type === 'course');
    videos = Array.isArray(vidsRes) ? vidsRes : [];
  } catch { /* none */ }

  const allCount = videos.length;
  const exclusiveCount = videos.filter((v) => v.visibility === 'premium').length;

  const catIcon = (c) => resolveCategoryVisual(c) ? categoryVisualMarkup(c, 'sb-visual') : TAG;
  const catItems = cats.map((c) => itemHTML('all', c.slug, categoryDisplayName(c), catIcon(c), currentSection === 'all' && currentCategory === c.slug)).join('');
  const courseItems = courses.map((p) => itemHTML('courses', p.slug, p.name, CAP, currentSection === 'courses' && currentCategory === p.slug)).join('');
  nav.innerHTML = `
    <a class="sb-brand" href="/" aria-label="David Bond TV — home">
      <img class="sb-avatar" src="/brand/avatar.png" alt="" width="88" height="88" />
      <span class="logo-wm"><span class="wm-pre">David Bond</span><span class="wm-box">TV</span></span>
    </a>
    <div class="sb-nav">
      ${itemHTML('all', '', 'All Videos', HOME, currentSection === 'all' && !currentCategory, allCount)}
      ${itemHTML('exclusive', '', 'Exclusive Videos', STAR, currentSection === 'exclusive', exclusiveCount)}
      <a class="sb-item sb-link" href="/products"><span class="sb-ico">${BAG}</span><span>Products</span></a>
      ${courses.length ? `<div class="sb-title">Courses</div>${courseItems}` : ''}
      ${cats.length ? `<div class="sb-title">Categories</div>${catItems}` : ''}
    </div>`;

  // Insert right after the header so it sits ABOVE the grid when it reflows to a
  // top bar on narrow screens (on wide screens it's fixed, so order doesn't matter).
  header.insertAdjacentElement('afterend', nav);
  document.body.classList.add('has-sidebar');   // lets the grid reserve space for the fixed panel

  // Only wire BUTTON items (browse filters). The Products link is a plain <a> and
  // navigates natively to its own page.
  nav.querySelectorAll('button.sb-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      nav.querySelectorAll('.sb-item').forEach((b) => b.classList.toggle('active', b === btn));
      const section = btn.dataset.section || 'all';
      const category = btn.dataset.category || '';
      if (isBrowseSurface) {
        const next = new URL(location.href);
        if (section !== 'all') next.searchParams.set('section', section);
        else next.searchParams.delete('section');
        if (category) next.searchParams.set('category', category);
        else next.searchParams.delete('category');
        history.replaceState(null, '', next);
        window.dispatchEvent(new CustomEvent('dbtv:nav', {
          detail: { section, category },
        }));
        return;
      }
      window.location.href = browseUrl(section, category);
    });
  });
}

build();
