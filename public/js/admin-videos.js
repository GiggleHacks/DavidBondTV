// Manage Videos page (/god-videos.html). Cookie-authenticated. Paginates the
// library at 50/page, supports checkbox + Select-All bulk actions
// (delete / publish / unpublish / premium / free) plus per-row edit, thumbnail
// replace, and delete.
import { requireAdmin } from './god-auth.js';
import { COUNTRIES } from './countries.js';

const $ = (id) => document.getElementById(id);
const PAGE = 50;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let all = [];
let filtered = [];
let page = 0;
let cats = []; // [{slug,name}]
const selected = new Set();

async function load() {
  try {
    all = await (await fetch(`/thumbs/videos.json?_=${Date.now()}`)).json();
  } catch { all = []; }
  try {
    cats = (await (await fetch('/api/categories')).json()).categories || [];
  } catch { cats = []; }
  applyFilter();
}

const catName = (slug) => (cats.find((c) => c.slug === slug) || {}).name || '';
const catFlag = (slug) => (cats.find((c) => c.slug === slug) || {}).flag || '';

/** A small flag <img> for a lowercase ISO code, or '' if no code. Self-removes if the SVG is missing. */
const flagImg = (code, cls) => (code
  ? `<img class="${cls}" src="/vendor/flags/4x3/${code}.svg" alt="" loading="lazy" onerror="this.remove()" />`
  : '');

/** Country <select> with a "no flag" option; `selected` is a lowercase code or ''. */
function countrySelect(selected) {
  const opts = ['<option value="">— No flag —</option>'].concat(
    COUNTRIES.map((c) => {
      const code = c.code.toLowerCase();
      return `<option value="${code}"${code === selected ? ' selected' : ''}>${esc(c.name)}</option>`;
    }),
  );
  return `<select class="cat-flag-sel">${opts.join('')}</select>`;
}

function applyFilter() {
  const q = $('search').value.trim().toLowerCase();
  filtered = q ? all.filter((v) => (v.title || '').toLowerCase().includes(q) || v.id.toLowerCase().includes(q)) : all.slice();
  page = 0;
  render();
}

function render() {
  $('vcount').textContent = `(${filtered.length})`;
  const slice = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const lib = $('library');
  lib.replaceChildren(...slice.map(libRow));
  if (!filtered.length) lib.innerHTML = '<p class="muted">No videos.</p>';
  renderPager();
  updateSel();
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const p = $('pager');
  if (pages <= 1) { p.innerHTML = ''; return; }
  p.innerHTML = `
    <button class="btn sm ghost" ${page === 0 ? 'disabled' : ''} id="prev">← Prev</button>
    <span class="muted">Page ${page + 1} of ${pages}</span>
    <button class="btn sm ghost" ${page >= pages - 1 ? 'disabled' : ''} id="next">Next →</button>`;
  $('prev')?.addEventListener('click', () => { if (page > 0) { page--; render(); } });
  $('next')?.addEventListener('click', () => { if (page < pages - 1) { page++; render(); } });
}

function badges(v) {
  const out = [];
  if (v.published === false) out.push('<span class="vb vb-un">Unpublished</span>');
  if (v.visibility === 'premium') out.push('<span class="vb vb-prem">Premium</span>');
  if (v.category && catName(v.category)) out.push(`<span class="vb vb-cat">${flagImg(catFlag(v.category), 'vb-flag')}${esc(catName(v.category))}</span>`);
  return out.join(' ');
}

function libRow(v) {
  const row = document.createElement('div');
  row.className = 'lib-row';
  row.innerHTML = `
    <input type="checkbox" class="row-check" ${selected.has(v.id) ? 'checked' : ''} />
    <img alt="" ${v.thumb ? `src="${v.thumb}?_=${Date.now()}"` : ''} />
    <div class="lt"><b></b><span class="meta"></span></div>
    <div class="lib-actions">
      <a class="btn-edit" href="/god-edit.html?v=${encodeURIComponent(v.id)}">Edit</a>
      <button class="btn-del" type="button">Delete</button>
    </div>`;
  row.querySelector('b').textContent = v.title || v.id;
  row.querySelector('.meta').innerHTML = `${esc(v.durLabel || '')} · ${esc(v.uploaded || '')} ${badges(v)}`.trim();

  const check = row.querySelector('.row-check');
  check.addEventListener('change', () => { if (check.checked) selected.add(v.id); else selected.delete(v.id); updateSel(); });

  row.querySelector('.btn-del').addEventListener('click', async () => {
    if (!confirm(`Delete "${v.title || v.id}"? This removes it and its files.`)) return;
    const res = await fetch('/api/admin/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: v.id }) });
    if (res.status === 401) { location.reload(); return; }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) { all = all.filter((x) => x.id !== v.id); selected.delete(v.id); applyFilter(); }
    else alert(data.error || 'Delete failed.');
  });
  return row;
}

function updateSel() {
  $('selcount').textContent = `${selected.size} selected`;
  const sa = $('select-all');
  const pageIds = filtered.map((v) => v.id);
  sa.checked = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
}

async function runBulk(action) {
  const ids = [...selected];
  if (!ids.length) { alert('Select at least one video.'); return; }
  if (action === 'delete' && !confirm(`Delete ${ids.length} video(s)? This cannot be undone.`)) return;
  const res = await fetch('/api/admin/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, action }) });
  if (res.status === 401) { location.reload(); return; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) { alert(data.error || 'Bulk action failed.'); return; }
  selected.clear();
  await load();
}

// --- category manager ---------------------------------------------------------
async function catAction(body) {
  const res = await fetch('/api/admin/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) { location.reload(); return null; }
  return res.json().catch(() => ({}));
}
function renderCats() {
  const wrap = $('cat-list');
  if (!wrap) return;
  wrap.replaceChildren();
  if (!cats.length) { wrap.innerHTML = '<span class="muted">No categories yet.</span>'; return; }
  for (const c of cats) {
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.innerHTML = `<span class="cat-flag-cell">${flagImg(c.flag, 'cat-flag-img') || '<span class="cat-flag-none"></span>'}</span>
      <input class="cat-name" value="${esc(c.name)}" maxlength="40" />
      <span class="muted cat-slug">${esc(c.slug)}</span>
      ${countrySelect(c.flag || '')}
      <button class="btn sm ghost cat-save">Rename</button>
      <button class="btn sm danger cat-del">Remove</button>`;
    row.querySelector('.cat-flag-sel').addEventListener('change', async (e) => {
      const d = await catAction({ action: 'setflag', slug: c.slug, flag: e.target.value });
      if (d && d.ok) { cats = d.categories; render(); renderCats(); }
      else if (d) alert(d.error || 'Could not set flag.');
    });
    row.querySelector('.cat-save').addEventListener('click', async () => {
      const name = row.querySelector('.cat-name').value.trim();
      const d = await catAction({ action: 'rename', slug: c.slug, name });
      if (d && d.ok) { cats = d.categories; render(); renderCats(); }
      else if (d) alert(d.error || 'Rename failed.');
    });
    row.querySelector('.cat-del').addEventListener('click', async () => {
      if (!confirm(`Remove category "${c.name}"? Videos keep their tag but it won't be listed.`)) return;
      const d = await catAction({ action: 'remove', slug: c.slug });
      if (d && d.ok) { cats = d.categories; render(); renderCats(); }
      else if (d) alert(d.error || 'Remove failed.');
    });
    wrap.appendChild(row);
  }
}
function wireCats() {
  const btn = $('cat-add-btn');
  if (!btn) return;
  // Inject a flag picker into the add row (next to the name input), so a new
  // category can be created with its flag in one step.
  let flagSel = $('cat-new-flag');
  if (!flagSel) {
    const tmp = document.createElement('div');
    tmp.innerHTML = countrySelect('');
    flagSel = tmp.firstChild;
    flagSel.id = 'cat-new-flag';
    $('cat-new').insertAdjacentElement('afterend', flagSel);
  }
  const submit = async () => {
    const name = $('cat-new').value.trim();
    if (!name) return;
    const d = await catAction({ action: 'add', name, flag: flagSel.value });
    if (d && d.ok) { cats = d.categories; $('cat-new').value = ''; flagSel.value = ''; $('cat-msg').textContent = ''; render(); renderCats(); }
    else if (d) $('cat-msg').textContent = d.error || 'Could not add.';
  };
  btn.addEventListener('click', submit);
  $('cat-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function wire() {
  $('search').addEventListener('input', applyFilter);
  $('select-all').addEventListener('change', (e) => {
    if (e.target.checked) filtered.forEach((v) => selected.add(v.id));
    else filtered.forEach((v) => selected.delete(v.id));
    render();
  });
  document.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', () => runBulk(b.dataset.bulk)));
}

async function main() {
  await requireAdmin();
  wire();
  wireCats();
  await load();
  renderCats();
}
main();
