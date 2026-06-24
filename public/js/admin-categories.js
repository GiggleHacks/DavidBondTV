import { requireAdmin } from './god-auth.js';
import {
  buildCategoryIconLibrary,
  categoryDisplayName,
  categoryLabelWithVisual,
  categoryVisualMarkup,
  matchesCategoryIcon,
  resolveCategoryVisual,
} from './category-visuals.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let cats = [];
let videos = [];
const iconLibrary = buildCategoryIconLibrary();
let draftVisual = null;

async function api(body) {
  const res = await fetch('/api/admin/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { location.reload(); return null; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || 'Could not save category.');
  cats = data.categories || [];
  render();
  return data;
}

async function load() {
  try { cats = (await (await fetch('/api/admin/categories')).json()).categories || []; } catch { cats = []; }
  try { videos = (await (await fetch(`/api/admin/videos?_=${Date.now()}`)).json()).videos || []; } catch { videos = []; }
  render();
}

function counts() {
  const map = new Map();
  videos.forEach((v) => { if (v.category) map.set(v.category, (map.get(v.category) || 0) + 1); });
  return map;
}

function filtered() {
  const q = $('cat-search-admin').value.trim().toLowerCase();
  if (!q) return cats;
  return cats.filter((c) => `${categoryDisplayName(c)} ${c.slug} ${categoryLabelWithVisual(c)} ${c.visual?.label || ''}`.toLowerCase().includes(q));
}

function row(c, count) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'cat-admin-row';
  el.innerHTML = `
    ${categoryVisualMarkup(c, 'cat-admin-icon')}
    <span class="cat-admin-name"><b>${esc(categoryDisplayName(c))}</b><small>${esc(c.slug)}</small></span>
    <span class="coupon-stat"><b>${count.get(c.slug) || 0}</b><span>videos</span></span>
    <span class="btn sm ghost">Edit</span>`;
  el.addEventListener('click', () => openDialog(c));
  return el;
}

function render() {
  const wrap = $('cat-admin-list');
  const rows = filtered();
  const count = counts();
  wrap.replaceChildren(...rows.map((c) => row(c, count)));
  if (!rows.length) wrap.innerHTML = '<p class="muted">No categories match this view.</p>';
}

function openDialog(c = null) {
  $('cat-dialog-title').textContent = c ? `Edit ${c.name}` : 'New category';
  $('cat-slug').value = c?.slug || '';
  $('cat-name').value = categoryDisplayName(c) || '';
  draftVisual = c ? resolveCategoryVisual(c) : null;
  syncVisualButton();
  $('cat-remove').hidden = !c;
  $('cat-dialog-msg').textContent = '';
  $('cat-dialog').showModal();
}

function syncVisualButton() {
  const preview = $('cat-visual-preview');
  const name = $('cat-visual-name');
  const help = $('cat-visual-help');
  if (!draftVisual) {
    preview.className = '';
    preview.innerHTML = '<span class="cat-visual-lg is-empty" aria-hidden="true">•</span>';
    name.textContent = 'Choose icon';
    help.textContent = 'Emoji, custom icons, and all country flags';
    return;
  }
  preview.innerHTML = categoryVisualMarkup({ visual: draftVisual }, 'cat-visual-lg');
  name.textContent = draftVisual.label || draftVisual.value;
  help.textContent = draftVisual.kind === 'flag'
    ? 'Country flag'
    : draftVisual.kind === 'custom'
      ? 'Custom icon'
      : 'Emoji';
}

function pickerOption(item) {
  const active = draftVisual && draftVisual.kind === item.kind && draftVisual.value === item.value;
  return `<button class="cat-picker-item${active ? ' active' : ''}" type="button" data-kind="${esc(item.kind)}" data-value="${esc(item.value)}" data-label="${esc(item.label)}">
    ${categoryVisualMarkup({ visual: { kind: item.kind, value: item.value, label: item.label } }, 'cat-picker-glyph')}
    <span class="cat-picker-text"><b>${esc(item.label)}</b><small>${esc(item.kind === 'flag' ? item.value.toUpperCase() : item.kind)}</small></span>
  </button>`;
}

function pickerSection(title, items) {
  if (!items.length) return '';
  return `<section class="cat-picker-section">
    <div class="menu-head">${esc(title)}</div>
    <div class="cat-picker-grid">${items.map(pickerOption).join('')}</div>
  </section>`;
}

function renderPicker() {
  const q = $('cat-picker-search').value.trim();
  const customs = iconLibrary.customs.filter((item) => matchesCategoryIcon(item, q));
  const emojis = iconLibrary.emojis.filter((item) => matchesCategoryIcon(item, q));
  const flags = iconLibrary.flags.filter((item) => matchesCategoryIcon(item, q));
  $('cat-picker-sections').innerHTML = pickerSection('Custom icons', customs)
    + pickerSection('Emoji', emojis)
    + pickerSection('Country flags', flags)
    || '<p class="muted">No icons match that search.</p>';
}

function chooseVisual(kind, value, label) {
  draftVisual = kind && value ? { kind, value, label } : null;
  syncVisualButton();
  renderPicker();
  $('cat-picker-dialog').close();
}

async function save(e) {
  e.preventDefault();
  const slug = $('cat-slug').value;
  const name = $('cat-name').value.trim();
  try {
    let liveSlug = slug;
    if (!liveSlug) {
      const created = await api({ action: 'add', name, visual: draftVisual });
      liveSlug = created.category.slug;
    } else {
      await api({ action: 'rename', slug: liveSlug, name });
      await api({ action: 'setvisual', slug: liveSlug, visual: draftVisual });
    }
    $('cat-dialog').close();
  } catch (err) {
    $('cat-dialog-msg').textContent = err.message || 'Could not save category.';
  }
}

async function removeCurrent() {
  const slug = $('cat-slug').value;
  if (!slug) return;
  if (!confirm('Remove this category? Existing videos keep their stored slug but it will no longer appear in category lists.')) return;
  try {
    await api({ action: 'remove', slug });
    $('cat-dialog').close();
  } catch (err) {
    $('cat-dialog-msg').textContent = err.message || 'Could not remove category.';
  }
}

async function main() {
  await requireAdmin();
  $('cat-new-btn').addEventListener('click', () => openDialog());
  $('cat-search-admin').addEventListener('input', render);
  $('cat-visual-trigger').addEventListener('click', () => {
    $('cat-picker-search').value = '';
    renderPicker();
    $('cat-picker-dialog').showModal();
  });
  $('cat-picker-close').addEventListener('click', () => $('cat-picker-dialog').close());
  $('cat-picker-clear').addEventListener('click', () => chooseVisual('', '', ''));
  $('cat-picker-search').addEventListener('input', renderPicker);
  $('cat-picker-sections').addEventListener('click', (e) => {
    const btn = e.target.closest('.cat-picker-item');
    if (!btn) return;
    chooseVisual(btn.dataset.kind, btn.dataset.value, btn.dataset.label);
  });
  $('cat-form').addEventListener('submit', save);
  $('cat-remove').addEventListener('click', removeCurrent);
  await load();
}

main();
