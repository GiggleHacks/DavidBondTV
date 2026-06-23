import { requireAdmin } from './god-auth.js';
import { COUNTRIES } from './countries.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let cats = [];
let videos = [];

const FLAG_OPTIONS = '<option value="">No flag</option>'
  + COUNTRIES.map((c) => `<option value="${c.code.toLowerCase()}">${esc(c.name)} (${c.code})</option>`).join('');

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
  return cats.filter((c) => `${c.name} ${c.slug} ${c.icon || ''}`.toLowerCase().includes(q));
}

function flag(c) {
  return c.flag ? `<img class="cat-admin-flag" src="/vendor/flags/4x3/${esc(c.flag)}.svg" alt="">` : '<span class="cat-admin-flag empty"></span>';
}

function row(c, count) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'cat-admin-row';
  el.innerHTML = `
    <span class="cat-admin-icon">${esc(c.icon || '•')}</span>
    ${flag(c)}
    <span class="cat-admin-name"><b>${esc(c.name)}</b><small>${esc(c.slug)}</small></span>
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
  $('cat-name').value = c?.name || '';
  $('cat-icon').value = c?.icon || '';
  $('cat-flag').innerHTML = FLAG_OPTIONS;
  $('cat-flag').value = c?.flag || '';
  $('cat-remove').hidden = !c;
  $('cat-dialog-msg').textContent = '';
  $('cat-dialog').showModal();
}

async function save(e) {
  e.preventDefault();
  const slug = $('cat-slug').value;
  const name = $('cat-name').value.trim();
  const icon = $('cat-icon').value.trim();
  const flag = $('cat-flag').value;
  try {
    let liveSlug = slug;
    if (!liveSlug) {
      const created = await api({ action: 'add', name, flag });
      liveSlug = created.category.slug;
    } else {
      await api({ action: 'rename', slug: liveSlug, name });
      await api({ action: 'setflag', slug: liveSlug, flag });
    }
    await api({ action: 'seticon', slug: liveSlug, icon });
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
  $('cat-form').addEventListener('submit', save);
  $('cat-remove').addEventListener('click', removeCurrent);
  await load();
}

main();
