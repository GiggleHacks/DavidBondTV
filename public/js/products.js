// Public storefront (products.html). Realizes the Categories → Courses → course
// hierarchy: fetches the published product catalog, groups it by course-category,
// and renders a card per course that links to its dedicated sales page
// (course.html). Owned courses show an "Open" state instead of a price.
import { fmtMoney } from '/js/course-buy.js';
import { initTheme } from '/js/theme.js';

initTheme();

const $ = (id) => document.getElementById(id);

/** Humanize a category slug for a heading: "meeting-women" → "Meeting Women". */
function humanize(slug) {
  if (!slug) return 'More';
  return slug.replace(/-+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const escHtml = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function courseCard(p, owned) {
  const b = p.branding || {};
  const sales = p.sales || {};
  const href = `/course.html?slug=${encodeURIComponent(p.slug)}`;
  const a = document.createElement('a');
  a.className = 'pcard';
  a.href = href;
  a.style.setProperty('--course-primary', b.primary || '#7c3aed');
  a.style.setProperty('--course-accent', b.accent || '#22d3ee');
  const media = b.bgImage
    ? `<div class="pcard-media" style="background-image:url('${b.bgImage}')"></div>`
    : '<div class="pcard-media pcard-media-grad"></div>';
  const logo = b.logo ? `<img class="pcard-logo" src="${b.logo}" alt="" />` : '';
  const cta = owned
    ? '<span class="pcard-owned">✓ Owned · Open →</span>'
    : `<span class="pcard-price">${escHtml(fmtMoney(p.price, p.currency))}</span>
       <span class="pcard-cta">${escHtml(sales.ctaLabel || 'View course')}</span>`;
  a.innerHTML = `
    ${media}
    <div class="pcard-body">
      ${logo}
      <h3 class="pcard-name"></h3>
      <p class="pcard-headline"></p>
      <div class="pcard-foot">${cta}</div>
    </div>`;
  a.querySelector('.pcard-name').textContent = p.name || 'Course';
  a.querySelector('.pcard-headline').textContent = sales.headline || p.description || '';
  return a;
}

async function render() {
  let products = [];
  let owned = new Set();
  try {
    const all = (await (await fetch('/api/products')).json()).products || [];
    // Cards link to the course sales page, so only show course-type products here
    // (bundles/digital would need their own destination). Mirrors sidebar.js.
    products = all.filter((p) => p.type === 'course');
  } catch { /* none */ }
  try {
    const me = (await (await fetch('/api/auth/me')).json()).user;
    if (me && Array.isArray(me.ownedProductIds)) owned = new Set(me.ownedProductIds);
  } catch { /* anonymous */ }

  $('store-loading').hidden = true;
  if (!products.length) { $('store-empty').hidden = false; return; }

  // Group by category, preserving first-seen order; uncategorized ('') sinks last.
  const groups = new Map();
  for (const p of products) {
    const key = p.category || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : 0));

  const root = $('store-cats');
  for (const key of keys) {
    const section = document.createElement('section');
    section.className = 'store-cat';
    const h = document.createElement('h2');
    h.className = 'store-cat-title';
    h.textContent = humanize(key);
    const grid = document.createElement('div');
    grid.className = 'store-grid';
    for (const p of groups.get(key)) grid.appendChild(courseCard(p, owned.has(p.id)));
    section.append(h, grid);
    root.appendChild(section);
  }
}

render();
