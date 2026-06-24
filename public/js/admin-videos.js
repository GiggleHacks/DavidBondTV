// Manage Videos page (/god-videos.html). Cookie-authenticated. Paginates the
// library at 50/page, supports checkbox + Select-All bulk actions
// (delete / publish / unpublish / premium / free / set thumbnail blur level)
// plus per-row edit, thumbnail replace, and delete.
import { requireAdmin } from './god-auth.js';
import { ADMIN_PATHS } from './admin-paths.js';
import { closeAfterAction, togglePanel } from './admin-dropdowns.js';
import { buildCategoryChoices, choiceIcon, choiceTone } from './admin-filter-choices.js';
import { categoryDisplayName, categoryLabelWithVisual, categoryVisualText, categoryVisualMarkup } from './category-visuals.js';

const $ = (id) => document.getElementById(id);
const PAGE = 50;
const REVIEW_QUEUE_KEY = 'dbtv-review-queue'; // handoff to god-review.html

// Approval defaults to 'approved' for legacy entries written before review mode,
// so existing videos are never trapped in the draft-review queue.
const approvalOf = (v) => (v.approval || 'approved');

// Derive the single owner-facing state of a video. The review-first lifecycle:
// uploaded → (approve) → encoding → ready/approved → published. Lifecycle states
// take precedence, then live, then the draft approval split.
function stateOf(v) {
  if (v.status === 'uploaded') return 'uploaded';
  if (v.status === 'encoding' || v.status === 'processing') return 'encoding';
  if (v.status === 'rejected') return 'rejected';
  if (v.status === 'failed') return 'failed';
  if (v.published === true) return 'published';
  return approvalOf(v) === 'approved' ? 'draft-approved' : 'draft-unapproved';
}
// The review queue is now everything still in the pre-encode 'uploaded' state —
// these are the videos awaiting the approve/reject decision that starts encoding.
const needsReview = (v) => v.status === 'uploaded';
const isApprovedDraft = (v) => v.published === false && approvalOf(v) === 'approved' && (v.status || 'ready') === 'ready';

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// Human-readable byte size. The "file size" we show per video is the encoded
// footprint on disk (compressedSize) — what actually gets published — falling
// back to the original size for videos not yet encoded (new review-first flow).
function fmtBytes(b) {
  if (!b && b !== 0) return '';
  const gb = b / 1e9; if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = b / 1e6; if (mb >= 1) return `${mb.toFixed(0)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}
const videoSize = (v) => v.compressedSize || v.originalSize || 0;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let all = [];
let filtered = [];
let page = 0;
let cats = []; // [{slug,name}]
const selected = new Set();

async function load() {
  try {
    all = (await (await fetch(`/api/admin/videos?_=${Date.now()}`)).json()).videos || [];
  } catch { all = []; }
  try {
    cats = (await (await fetch('/api/categories')).json()).categories || [];
  } catch { cats = []; }
  renderCatFilter();
  renderCategoryMenu();
  applyFilter();
}

const catName = (slug) => (cats.find((c) => c.slug === slug) || {}).name || '';
const catBySlug = (slug) => cats.find((c) => c.slug === slug) || null;

function applyFilter() {
  const q = $('search').value.trim().toLowerCase();
  const cat = $('cat-filter') ? $('cat-filter').value : '';
  const state = $('state-filter') ? $('state-filter').value : '';
  const access = $('access-filter') ? $('access-filter').value : '';
  filtered = all.filter((v) => {
    if (state && stateOf(v) !== state) return false;
    if (access === 'free' && v.visibility === 'premium') return false;
    if (access === 'premium' && v.visibility !== 'premium') return false;
    const vcat = v.category || '';
    if (cat === '__none__') { if (vcat) return false; }
    else if (cat && vcat !== cat) return false;
    if (q && !(v.title || '').toLowerCase().includes(q) && !v.id.toLowerCase().includes(q)) return false;
    return true;
  });
  page = 0;
  syncFiltersBadge();
  render();
}

function syncFiltersBadge() {
  const n = ['state-filter', 'access-filter', 'cat-filter'].filter((id) => $(id) && $(id).value).length;
  const badge = $('filters-badge');
  if (!badge) return;
  badge.textContent = n;
  badge.hidden = n === 0;
}

// (Re)build the category filter dropdown from the loaded categories, preserving
// the current selection. "All categories" clears the filter.
function renderCatFilter() {
  const input = $('cat-filter');
  const group = $('cat-filter-group');
  if (!input || !group) return;
  const cur = input.value;
  const choices = buildCategoryChoices(cats, all);
  const valid = choices.some((choice) => choice.value === cur) ? cur : '';
  input.value = valid;
  group.replaceChildren(...choices.map((choice) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ff-chip${choice.value === valid ? ' active' : ''}`;
    b.dataset.filter = 'cat-filter';
    b.dataset.value = choice.value;
    b.dataset.tone = choiceTone(choice, 'category');
    // Categories carry SVG markup (self-hosted flag / icon span) so flags render
    // as images, not broken emoji; other filters use a plain text glyph.
    const chipIcon = choice.iconHtml || esc(choiceIcon(choice, '#'));
    b.innerHTML = `<span class="ff-chip-icon" aria-hidden="true">${chipIcon}</span><span class="ff-chip-label">${esc(choice.label)}</span>`;
    return b;
  }));
}

function renderCategoryMenu() {
  const panel = $('category-menu-panel');
  if (!panel) return;
  const items = [{ slug: '__none__', name: 'Uncategorized' }]
    .concat(cats.map((c) => ({ slug: c.slug, name: categoryLabelWithVisual(c) })));
  panel.replaceChildren(...items.map((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.dataset.cat = it.slug;
    b.textContent = it.name;
    b.addEventListener('click', () => { closeAllPopovers(); runBulkSetCategory(it.slug); });
    return b;
  }));
}

function render() {
  $('vcount').textContent = `(${filtered.length})`;
  const lc = $('lib-count');
  if (lc) lc.textContent = `${filtered.length} video${filtered.length === 1 ? '' : 's'}`;
  const slice = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const lib = $('library');
  lib.replaceChildren(...slice.map(libRow));
  if (!filtered.length) lib.innerHTML = '<p class="muted">No videos.</p>';
  renderPager();
  updateSel();
  updateReviewCounts();
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
  // Exactly one state badge per row (lifecycle → live → draft approval split).
  const st = stateOf(v);
  if (st === 'uploaded') out.push('<span class="vb vb-upload">In review</span>');
  else if (st === 'encoding') out.push('<span class="vb vb-proc">Encoding</span>');
  else if (st === 'rejected') out.push('<span class="vb vb-rej">Rejected</span>');
  else if (st === 'failed') out.push('<span class="vb vb-fail">Failed</span>');
  else if (st === 'published') out.push('<span class="vb vb-live">Live</span>');
  else if (st === 'draft-approved') out.push('<span class="vb vb-appr">Approved</span>');
  else out.push('<span class="vb vb-draft">Draft · Unapproved</span>');
  if (v.visibility === 'premium') out.push('<span class="vb vb-prem">Premium</span>');
  if (v.category && catBySlug(v.category)) {
    const cat = catBySlug(v.category);
    out.push(`<span class="vb vb-cat">${categoryVisualMarkup(cat, 'cat-glyph')}${esc(categoryDisplayName(cat))}</span>`);
  }
  return out.join(' ');
}

// Keep the review/publish toolbar counts in sync with the full library.
function updateReviewCounts() {
  const un = all.filter(needsReview).length;
  const ap = all.filter(isApprovedDraft).length;
  const ra = $('review-all');
  const pa = $('publish-approved');
  const strip = $('review-strip');
  if (ra) { ra.hidden = un === 0; $('unapproved-count').textContent = un; }
  if (pa) { pa.hidden = ap === 0; $('approved-count').textContent = ap; }
  if (strip) strip.hidden = un === 0 && ap === 0;
}

// Inline "Quick edit" for a video's title — no full editor needed. Swaps the
// title text for an input + Save/Cancel; saves via /api/admin/edit (title only)
// and refreshes the list. The full editor stays available for everything else.
function startQuickEdit(row, v) {
  const lt = row.querySelector('.lt');
  if (lt.querySelector('.qe')) return; // already editing this row
  const titleEl = lt.querySelector('b');
  const qe = document.createElement('div');
  qe.className = 'qe';
  qe.innerHTML = `
    <input class="qe-input" type="text" maxlength="200" aria-label="Video title" />
    <button class="btn sm qe-save" type="button">Save</button>
    <button class="btn sm ghost qe-cancel" type="button">Cancel</button>
    <span class="qe-msg muted"></span>`;
  const input = qe.querySelector('.qe-input');
  const msg = qe.querySelector('.qe-msg');
  input.value = v.title || '';
  titleEl.style.display = 'none';
  lt.insertBefore(qe, titleEl);
  input.focus();
  input.select();

  const teardown = () => { qe.remove(); titleEl.style.display = ''; };
  const save = async () => {
    const t = input.value.trim();
    if (!t) { msg.textContent = 'Title required.'; return; }
    if (t === (v.title || '')) { teardown(); return; }
    qe.querySelector('.qe-save').disabled = true;
    msg.textContent = 'Saving…';
    let data = {};
    try {
      const res = await fetch('/api/admin/edit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: v.id, title: t }),
      });
      if (res.status === 401) { location.reload(); return; }
      data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Save failed.');
    } catch (e) {
      qe.querySelector('.qe-save').disabled = false;
      msg.textContent = e.message || 'Save failed.';
      return;
    }
    v.title = t; // same object reference is shared by `all` and `filtered`
    render(); // refresh the list (in place, current page) with the new title
  };

  qe.querySelector('.qe-save').addEventListener('click', save);
  qe.querySelector('.qe-cancel').addEventListener('click', teardown);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); teardown(); }
  });
}

function libRow(v) {
  const row = document.createElement('div');
  row.className = 'lib-row';
  row.dataset.vid = v.id;
  row.innerHTML = `
    <input type="checkbox" class="row-check" ${selected.has(v.id) ? 'checked' : ''} />
    <img alt="" ${v.thumb ? `src="${v.thumb}?_=${Date.now()}"` : ''} />
    <div class="lt"><b></b><span class="meta"></span></div>
    <div class="lib-actions">
      <a class="btn-edit" href="${ADMIN_PATHS.edit}?v=${encodeURIComponent(v.id)}">Edit</a>
      <div class="row-menu">
        <button class="row-menu-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="More actions">⋯</button>
        <div class="row-menu-panel" hidden>
          <button class="menu-item row-quick" type="button">Quick edit</button>
          <button class="menu-item row-del" type="button">Delete</button>
        </div>
      </div>
    </div>`;
  row.querySelector('b').textContent = v.title || v.id;
  const size = videoSize(v);
  const sizeSeg = size ? ` · <span class="vsize" title="${v.compressedSize ? 'Encoded size (published)' : 'Original size (not yet encoded)'}">${esc(fmtBytes(size))}</span>` : '';
  row.querySelector('.meta').innerHTML = `${esc(v.durLabel || '')} · ${esc(v.uploaded || '')}${sizeSeg} ${badges(v)}`.trim();

  const rmBtn = row.querySelector('.row-menu-btn');
  rmBtn.addEventListener('click', () => togglePanel(rmBtn, row.querySelector('.row-menu-panel'), closeAllPopovers));
  row.querySelector('.row-quick').addEventListener('click', () => { closeAllPopovers(); startQuickEdit(row, v); });

  const check = row.querySelector('.row-check');
  check.addEventListener('change', () => { if (check.checked) selected.add(v.id); else selected.delete(v.id); updateSel(); });

  row.querySelector('.row-del').addEventListener('click', async () => {
    closeAllPopovers();
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
  $('selcount').textContent = selected.size;
  const sa = $('select-all');
  const pageIds = filtered.map((v) => v.id);
  sa.checked = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const bar = $('selection-bar');
  if (bar) bar.hidden = selected.size === 0;
}

// Apply a bulk action to ids in ≤500-id batches (the /api/admin/bulk route caps
// the body at 64 KB, ~1600 ids — stay well under so thousand-item ops succeed).
async function bulkChunked(ids, action) {
  for (const batch of chunk(ids, 500)) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch('/api/admin/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: batch, action }) });
    if (res.status === 401) { location.reload(); throw new Error('Session expired.'); }
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Bulk action failed.');
  }
}

async function runBulk(action) {
  const ids = [...selected];
  if (!ids.length) { alert('Select at least one video.'); return; }
  if (action === 'delete' && !confirm(`Delete ${ids.length} video(s)? This permanently removes them and their files.`)) return;
  if (action === 'publish' && !confirm(`Publish ${ids.length} video(s)? They go live immediately.`)) return;
  try { await bulkChunked(ids, action); } catch (e) { alert(e.message || 'Bulk action failed.'); return; }
  selected.clear();
  await load();
}

async function runBulkSetCategory(slug) {
  const ids = [...selected];
  if (!ids.length) { alert('Select at least one video.'); return; }
  const catSlug = slug === '__none__' ? '' : slug;
  try { await bulkChunked(ids, `set-category:${catSlug}`); } catch (e) { alert(e.message || 'Bulk action failed.'); return; }
  selected.clear();
  await load();
}

// Hand off an ordered id list to Review Mode (sessionStorage avoids huge URLs).
function startReview(ids) {
  if (!ids.length) { alert('No videos to review.'); return; }
  try { sessionStorage.setItem(REVIEW_QUEUE_KEY, JSON.stringify(ids)); } catch { /* ignore */ }
  location.href = ADMIN_PATHS.review;
}

async function publishApproved() {
  const ids = all.filter(isApprovedDraft).map((v) => v.id);
  if (!ids.length) { alert('No approved drafts to publish.'); return; }
  if (!confirm(`Publish ${ids.length} approved draft${ids.length === 1 ? '' : 's'}? They go live immediately.`)) return;
  try { await bulkChunked(ids, 'publish'); } catch (e) { alert(e.message || 'Publish failed.'); return; }
  await load();
}

// Category management lives on /god-categories.html (unified visual picker).
// This page only consumes categories for the filter chips + per-video tags.

// --- popover / dropdown-menu infrastructure -----------------------------------
// Close every open popover (selection-bar menus, row ⋯ menus, filters popover),
// optionally leaving `except` open. Resets the matching trigger's aria-expanded.
function closeAllPopovers(except) {
  document.querySelectorAll('.menu-panel:not([hidden]), .row-menu-panel:not([hidden])').forEach((p) => {
    if (p === except) return;
    p.hidden = true;
    const btn = p.parentElement.querySelector('[aria-haspopup]');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
  const fp = $('filters-popover');
  if (fp && fp !== except && !fp.hidden) {
    fp.hidden = true;
    $('filters-btn')?.setAttribute('aria-expanded', 'false');
  }
}

function syncFilterButtons(filterId) {
  document.querySelectorAll(`.ff-chip[data-filter="${filterId}"]`).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === ($(filterId)?.value || ''));
  });
}

function chooseFilter(filterId, value) {
  const input = $(filterId);
  if (!input) return;
  input.value = value;
  syncFilterButtons(filterId);
  applyFilter();
  closeAllPopovers();
}

function wire() {
  $('search').addEventListener('input', applyFilter);

  // Filters popover
  const fb = $('filters-btn');
  fb?.addEventListener('click', () => togglePanel(fb, $('filters-popover'), closeAllPopovers));
  $('filters-popover')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.ff-chip[data-filter]');
    if (!btn) return;
    chooseFilter(btn.dataset.filter, btn.dataset.value || '');
  });
  $('filters-clear')?.addEventListener('click', closeAfterAction(() => {
    ['state-filter', 'access-filter', 'cat-filter'].forEach((id) => { if ($(id)) $(id).value = ''; });
    ['state-filter', 'access-filter', 'cat-filter'].forEach(syncFilterButtons);
    renderCatFilter();
    applyFilter();
  }, closeAllPopovers));

  // Review strip
  $('review-all')?.addEventListener('click', () => startReview(all.filter(needsReview).map((v) => v.id)));
  $('publish-approved')?.addEventListener('click', publishApproved);
  $('more-review-selected')?.addEventListener('click', () => { closeAllPopovers(); startReview([...selected]); });

  // Selection
  $('select-all').addEventListener('change', (e) => {
    if (e.target.checked) filtered.forEach((v) => selected.add(v.id));
    else filtered.forEach((v) => selected.delete(v.id));
    render();
  });
  $('clear-selection')?.addEventListener('click', () => { selected.clear(); render(); });

  // Selection-bar dropdown menus
  document.querySelectorAll('.selection-bar .menu-btn').forEach((btn) => {
    btn.addEventListener('click', () => togglePanel(btn, btn.nextElementSibling, closeAllPopovers));
  });

  // Bulk actions (publish/approve/premium/free/unapprove/unpublish/delete)
  document.querySelectorAll('[data-bulk]').forEach((b) =>
    b.addEventListener('click', () => { closeAllPopovers(); runBulk(b.dataset.bulk); }));
  // Thumbnail blur levels
  document.querySelectorAll('[data-blur]').forEach((b) =>
    b.addEventListener('click', () => { closeAllPopovers(); runBulk(`blur-${b.dataset.blur}`); }));

  // Global popover dismissal (pointerdown covers both mouse click and touch tap)
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.menu') || e.target.closest('.row-menu') || e.target.closest('.filters-wrap')) return;
    closeAllPopovers();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllPopovers(); });

  wireRubberBand();
}

function wireRubberBand() {
  const lib = $('library');
  if (!lib) return;

  const band = document.createElement('div');
  band.style.cssText = 'position:fixed;display:none;border:1px solid var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);pointer-events:none;z-index:200;border-radius:3px;';
  document.body.appendChild(band);

  let dragging = false;
  let startX = 0;
  let startY = 0;

  lib.addEventListener('mousedown', (e) => {
    // Only start a drag on the library background or a row — not on buttons/inputs/links
    const tag = e.target.tagName;
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'A' || tag === 'SELECT' || tag === 'IMG') return;
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    band.style.display = 'block';
    band.style.left = `${startX}px`;
    band.style.top = `${startY}px`;
    band.style.width = '0';
    band.style.height = '0';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    band.style.left = `${x}px`;
    band.style.top = `${y}px`;
    band.style.width = `${Math.abs(e.clientX - startX)}px`;
    band.style.height = `${Math.abs(e.clientY - startY)}px`;
  });

  document.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    band.style.display = 'none';
    const bandLeft = Math.min(e.clientX, startX);
    const bandTop = Math.min(e.clientY, startY);
    const bandRight = Math.max(e.clientX, startX);
    const bandBottom = Math.max(e.clientY, startY);
    // Skip trivial clicks (< 8px drag)
    if (bandRight - bandLeft < 8 && bandBottom - bandTop < 8) return;
    lib.querySelectorAll('.lib-row').forEach((row) => {
      const r = row.getBoundingClientRect();
      const hits = r.left < bandRight && r.right > bandLeft && r.top < bandBottom && r.bottom > bandTop;
      if (!hits) return;
      const vid = row.dataset.vid;
      if (!vid) return;
      selected.add(vid);
      const check = row.querySelector('.row-check');
      if (check) check.checked = true;
    });
    updateSel();
  });
}

async function main() {
  await requireAdmin();
  wire();
  await load();
}
main();
