// Manage Videos page (/god-videos.html). Cookie-authenticated. Paginates the
// library at 50/page, supports checkbox + Select-All bulk actions
// (delete / publish / unpublish / premium / free) plus per-row edit, thumbnail
// replace, and delete.
import { requireAdmin } from './god-auth.js';

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
function catOptions(selectedSlug) {
  const opts = ['<option value="">Uncategorized</option>'];
  for (const c of cats) opts.push(`<option value="${esc(c.slug)}"${c.slug === selectedSlug ? ' selected' : ''}>${esc(c.name)}</option>`);
  return opts.join('');
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
  if (v.category && catName(v.category)) out.push(`<span class="vb vb-cat">${esc(catName(v.category))}</span>`);
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
      <button class="btn-edit" type="button">Edit</button>
      <button class="btn-thumb" type="button">Thumbnail</button>
      <button class="btn-del" type="button">Delete</button>
    </div>
    <div class="lib-editor hidden">
      <input class="ed-title" type="text" maxlength="200" placeholder="Title" />
      <textarea class="ed-desc" maxlength="2000" rows="3" placeholder="Description"></textarea>
      <label class="ed-blur-row ed-blur-wrap">Premium thumbnail blur:
        <select class="ed-blur">
          <option value="strong">Strong blur</option>
          <option value="medium">Medium blur</option>
          <option value="off">No blur</option>
        </select>
      </label>
      <label class="ed-blur-row">Category:
        <select class="ed-category">${catOptions(v.category || '')}</select>
      </label>
      <div class="ed-row"><button class="ed-save" type="button">Save</button><button class="ed-cancel" type="button">Cancel</button><span class="ed-msg"></span></div>
    </div>
    <input class="thumb-file hidden" type="file" accept="image/png,image/jpeg,image/webp" />`;
  row.querySelector('b').textContent = v.title || v.id;
  row.querySelector('.meta').innerHTML = `${esc(v.durLabel || '')} · ${esc(v.uploaded || '')} ${badges(v)}`.trim();

  const check = row.querySelector('.row-check');
  check.addEventListener('change', () => { if (check.checked) selected.add(v.id); else selected.delete(v.id); updateSel(); });

  const editor = row.querySelector('.lib-editor');
  const titleInput = row.querySelector('.ed-title');
  const descInput = row.querySelector('.ed-desc');
  const blurSel = row.querySelector('.ed-blur');
  const catSel = row.querySelector('.ed-category');
  const msg = row.querySelector('.ed-msg');
  const blurOf = (x) => (['strong', 'medium', 'off'].includes(x.blur) ? x.blur : (x.visibility === 'premium' ? 'strong' : 'off'));
  row.querySelector('.btn-edit').addEventListener('click', () => {
    titleInput.value = v.title || ''; descInput.value = v.description || ''; blurSel.value = blurOf(v);
    catSel.value = v.category || ''; msg.textContent = '';
    // Blur only affects premium thumbnails, so hide it for free videos.
    row.querySelector('.ed-blur-wrap').classList.toggle('hidden', v.visibility !== 'premium');
    editor.classList.toggle('hidden');
  });
  row.querySelector('.ed-cancel').addEventListener('click', () => editor.classList.add('hidden'));
  row.querySelector('.ed-save').addEventListener('click', async () => {
    const save = row.querySelector('.ed-save'); save.disabled = true; msg.textContent = 'Saving…';
    try {
      const res = await fetch('/api/admin/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: v.id, title: titleInput.value, description: descInput.value, blur: blurSel.value, category: catSel.value }) });
      if (res.status === 401) { location.reload(); return; }
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) { v.title = titleInput.value.trim(); v.description = descInput.value.trim(); v.blur = blurSel.value; v.category = catSel.value; row.querySelector('b').textContent = v.title || v.id; row.querySelector('.meta').innerHTML = `${esc(v.durLabel || '')} · ${esc(v.uploaded || '')} ${badges(v)}`.trim(); editor.classList.add('hidden'); }
      else msg.textContent = data.error || 'Save failed.';
    } catch { msg.textContent = 'Network error.'; } finally { save.disabled = false; }
  });

  const thumbFile = row.querySelector('.thumb-file');
  row.querySelector('.btn-thumb').addEventListener('click', () => thumbFile.click());
  thumbFile.addEventListener('change', async () => {
    const file = thumbFile.files[0]; thumbFile.value = ''; if (!file) return;
    const btn = row.querySelector('.btn-thumb'); btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      const res = await fetch(`/api/admin/thumb?id=${encodeURIComponent(v.id)}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      if (res.status === 401) { location.reload(); return; }
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) { v.thumb = data.thumb; row.querySelector('img').src = `${data.thumb}?_=${Date.now()}`; }
      else alert(data.error || 'Thumbnail upload failed.');
    } catch { alert('Network error.'); } finally { btn.disabled = false; btn.textContent = 'Thumbnail'; }
  });

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
    row.innerHTML = `<input class="cat-name" value="${esc(c.name)}" maxlength="40" />
      <span class="muted cat-slug">${esc(c.slug)}</span>
      <button class="btn sm ghost cat-save">Rename</button>
      <button class="btn sm danger cat-del">Remove</button>`;
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
  const submit = async () => {
    const name = $('cat-new').value.trim();
    if (!name) return;
    const d = await catAction({ action: 'add', name });
    if (d && d.ok) { cats = d.categories; $('cat-new').value = ''; $('cat-msg').textContent = ''; render(); renderCats(); }
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
