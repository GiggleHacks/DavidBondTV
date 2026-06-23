# Videos Admin Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three always-visible toolbars on the Manage Videos admin page with a calm default view (header + Filters popover + quiet review strip) and a contextual action bar that appears only when videos are selected.

**Architecture:** Pure front-end restructure of one page. `god-videos.html` gets new markup, `css/admin.css` gets new component styles (old toolbar styles retired), and `js/admin-videos.js` gets popover/menu plumbing plus rewiring of existing handlers. No server, manifest, or API changes — every bulk action reuses the existing `runBulk` / `runBulkSetCategory` / `startReview` / rubber-band code paths.

**Tech Stack:** Vanilla ES modules, no framework. Theme via CSS custom properties (`var(--surface)`, `var(--accent)`, `color-mix()`), `data-theme="midnight"`. Cookie-authenticated admin served by `server.mjs`.

**Design spec:** `docs/superpowers/specs/2026-06-23-videos-redesign-design.md`

**Verification model:** There is no JS test framework in this repo; the page is verified manually against a running dev server using the `preview_*` tools (start server → load page with admin cookie → snapshot/click/inspect). Each task ends by confirming the page still renders and the relevant interaction works.

**Obfuscated admin prefix (used in links):** `gigglehacksclicking85hgfd7845789drghudr789rdhkjrtbi8r5eg9875g789`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `public/god-videos.html` | Page markup for Manage Videos | Replace the `.mv-filters`/`.reviewbar`/`.bulkbar` block with header + filters popover + review strip + lib-head + selection bar |
| `public/css/admin.css` | Admin styling | Retire `.bulkbar`/`.reviewbar`/`.bulk-blur`/`.mv-filters`; add header, popover, review-strip, selection-bar, shared menu, and row-action styles |
| `public/js/admin-videos.js` | Page controller | Add popover/menu infra; rewire filters, review strip, selection bar, category menu, blur, and row ⋯ menu to existing handlers |

The dormant category-manager code in `admin-videos.js` (`renderCats`/`wireCats`, lines ~288–361) binds IDs that do not exist on this page (`#cat-list`, `#cat-add-btn`); it no-ops via `$()` returning null and is **out of scope** — leave it untouched.

---

## Task 1: Restructure the page markup

**Files:**
- Modify: `public/god-videos.html` (replace lines 51–111, the second `<section class="card">`)

- [ ] **Step 1: Replace the videos card markup**

In `public/god-videos.html`, replace the entire second card section (from `<section class="card">` on line 51 through its closing `</section>` on line 111 — the one containing `.mv-filters`, `.reviewbar`, `.bulkbar`, `#library`, `#pager`; **not** the `#publish-card` section above it) with:

```html
      <section class="card">
        <div class="mv-head">
          <h2 class="mv-title">Manage videos <span id="vcount" class="muted"></span></h2>
          <div class="mv-tools">
            <div class="filters-wrap">
              <button id="filters-btn" class="btn sm ghost filters-btn" type="button" aria-haspopup="true" aria-expanded="false">
                <span aria-hidden="true">⚲</span> Filters <span id="filters-badge" class="filters-badge" hidden>0</span>
              </button>
              <div id="filters-popover" class="filters-popover" hidden role="dialog" aria-label="Filter videos">
                <label class="ff-label">State
                  <select id="state-filter">
                    <option value="">All states</option>
                    <option value="draft-unapproved">Draft · Unapproved</option>
                    <option value="draft-approved">Draft · Approved</option>
                    <option value="published">Published (live)</option>
                    <option value="processing">Processing</option>
                    <option value="failed">Failed</option>
                  </select>
                </label>
                <label class="ff-label">Access
                  <select id="access-filter">
                    <option value="">All access</option>
                    <option value="free">Free</option>
                    <option value="premium">Premium</option>
                  </select>
                </label>
                <label class="ff-label">Category
                  <select id="cat-filter"></select>
                </label>
                <div class="ff-foot">
                  <button id="filters-clear" class="ff-clear" type="button">Clear all</button>
                  <a class="ff-manage" href="/gigglehacksclicking85hgfd7845789drghudr789rdhkjrtbi8r5eg9875g789-categories.html">Manage categories →</a>
                </div>
              </div>
            </div>
            <input id="search" class="mv-search" placeholder="Search title" />
          </div>
        </div>

        <div id="review-strip" class="review-strip" hidden>
          <span class="rs-label">Review queue</span>
          <button id="review-all" class="rs-link" type="button" hidden><span id="unapproved-count">0</span> unapproved →</button>
          <button id="publish-approved" class="rs-link" type="button" hidden><span id="approved-count">0</span> approved ready to publish →</button>
        </div>

        <div class="lib-head">
          <label class="selall"><input type="checkbox" id="select-all" /> Select all</label>
          <span class="muted" id="lib-count"></span>
        </div>

        <div id="selection-bar" class="selection-bar" hidden>
          <span class="sel-count"><b id="selcount">0</b> selected</span>
          <button class="btn sm" data-bulk="publish" title="Make live immediately — visible to eligible viewers">Publish</button>
          <button class="btn sm ghost" data-bulk="approve" title="Mark as approved — stays hidden until published">Approve</button>
          <div class="menu" data-menu="access">
            <button class="btn sm ghost menu-btn" type="button" aria-haspopup="true" aria-expanded="false">Access ▾</button>
            <div class="menu-panel" hidden>
              <button class="menu-item" data-bulk="premium" type="button">Make premium</button>
              <button class="menu-item" data-bulk="free" type="button">Make free</button>
            </div>
          </div>
          <div class="menu" data-menu="category">
            <button class="btn sm ghost menu-btn" type="button" aria-haspopup="true" aria-expanded="false">Category ▾</button>
            <div class="menu-panel" id="category-menu-panel" hidden></div>
          </div>
          <div class="menu" data-menu="more">
            <button class="btn sm ghost menu-btn" type="button" aria-haspopup="true" aria-expanded="false">More ▾</button>
            <div class="menu-panel" hidden>
              <button class="menu-item" data-bulk="unapprove" type="button">Unapprove</button>
              <button class="menu-item" data-bulk="unpublish" type="button">Unpublish</button>
              <button class="menu-item" id="more-review-selected" type="button">Review selected</button>
              <div class="menu-sep"></div>
              <span class="menu-head">Thumbnail blur</span>
              <button class="menu-item" data-blur="off" type="button">Off</button>
              <button class="menu-item" data-blur="medium" type="button">Medium</button>
              <button class="menu-item" data-blur="strong" type="button">Strong</button>
              <button class="menu-item" data-blur="strongest" type="button">Strongest</button>
            </div>
          </div>
          <span class="sel-spacer"></span>
          <button class="btn sm danger" data-bulk="delete">Delete</button>
          <button id="clear-selection" class="sel-clear" type="button" aria-label="Clear selection">✕</button>
        </div>

        <div id="library"></div>
        <div id="pager" class="pager"></div>
      </section>
```

- [ ] **Step 2: Sanity-check the file is still well-formed**

Run: `node --check public/god-videos.html 2>/dev/null; node -e "const s=require('fs').readFileSync('public/god-videos.html','utf8'); const o=(s.match(/<section/g)||[]).length, c=(s.match(/<\/section>/g)||[]).length; if(o!==c) throw new Error('section mismatch '+o+'/'+c); console.log('sections balanced:',o)"`

Expected: `sections balanced: 2` (the publish card + the videos card). Ignore the `node --check` part (HTML isn't JS); the inline tag-balance check is the real assertion.

Note: IDs the JS already binds are preserved exactly — `vcount`, `state-filter`, `access-filter`, `cat-filter`, `search`, `select-all`, `review-all`, `publish-approved`, `unapproved-count`, `approved-count`, `selcount`, `library`, `pager`. Do not commit yet — the page will look unstyled until Task 2.

---

## Task 2: Add component styles, retire old toolbar styles

**Files:**
- Modify: `public/css/admin.css`

- [ ] **Step 1: Remove the retired toolbar rules**

Delete these now-unused rules:

Remove line 165 (`.bulkbar { … }`):
```css
.bulkbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 0 14px; border-bottom: 1px solid var(--border); margin-bottom: 6px; }
```

Remove lines 167–171 (`.bulk-blur` block):
```css
.bulk-blur { display: inline-flex; align-items: center; gap: 6px; }
.bulk-blur select {
  background: var(--surface-2); color: var(--text); border: 1px solid var(--border);
  border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 12px; cursor: pointer;
}
```

Remove lines 191–194 (the `.reviewbar` block and the now-redundant standalone `#state-filter` rule — the popover styles `state-filter` via `.ff-label select`):
```css
/* Review/publish toolbar (above the bulk bar on Manage videos). */
.reviewbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 0; }
.reviewbar .muted { font-weight: 700; }
#state-filter { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13px; cursor: pointer; max-width: 200px; }
```

Remove lines 319–321 (the `.mv-filters` block and the standalone `#cat-filter` rule — `cat-filter` is now styled via `.ff-label select`):
```css
/* Manage-videos header filters (category dropdown + search). */
.mv-filters { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
#cat-filter { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13px; cursor: pointer; max-width: 220px; }
```

Keep `.selall` (line 166), `.btn.danger` (172–173), `.lib-row`/`.vb*` (174–189), `.lib-actions`/`.btn-edit`/`.btn-del`/`.btn-quick`/`.qe` (308–318), and `.pager` (324).

- [ ] **Step 2: Append the new component block**

Add this immediately after the `.pager` rule (currently line 324, `.pager { … }`):

```css
/* ===== Manage videos — redesigned header + filters ===== */
.mv-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.mv-title { margin: 0; }
.mv-tools { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mv-search { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 7px 12px; font: inherit; font-size: 13px; min-height: 40px; }
.filters-wrap { position: relative; }
.filters-btn { position: relative; }
.filters-badge { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--accent); color: var(--accent-contrast); font-size: 11px; font-weight: 800; }
.filters-popover { position: absolute; right: 0; top: calc(100% + 6px); z-index: 60; width: 260px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 14px 40px rgba(0,0,0,.45); padding: 14px; display: grid; gap: 12px; }
.ff-label { display: grid; gap: 6px; font-size: 12px; font-weight: 700; color: var(--text-dim); }
.ff-label select { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 13px; cursor: pointer; }
.ff-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid var(--border); padding-top: 10px; }
.ff-clear { background: none; border: none; color: var(--accent); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; padding: 0; }
.ff-manage { color: var(--text-dim); font-size: 13px; text-decoration: none; }
.ff-manage:hover { color: var(--text); }

/* Review-queue strip */
.review-strip { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 10px 12px; margin-bottom: 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; }
.rs-label { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--text-dim); }
.rs-link { background: none; border: none; color: var(--text); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; padding: 0; }
.rs-link:hover { color: var(--accent); }

/* Library header (select-all + count) */
.lib-head { display: flex; align-items: center; gap: 12px; padding: 6px 0 10px; border-bottom: 1px solid var(--border); margin-bottom: 6px; }

/* Contextual selection action bar */
.selection-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; position: sticky; top: 0; z-index: 40; padding: 10px 12px; margin-bottom: 8px; background: color-mix(in srgb, var(--accent) 10%, var(--surface)); border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border)); border-radius: 10px; }
.sel-count { font-size: 13px; margin-right: 4px; }
.sel-count b { font-size: 14px; }
.sel-spacer { flex: 1; }
.sel-clear { background: none; border: none; color: var(--text-dim); font-size: 16px; cursor: pointer; padding: 4px 8px; border-radius: 8px; line-height: 1; }
.sel-clear:hover { background: var(--surface-2); color: var(--text); }

/* Shared dropdown menus (selection bar + row ⋯) */
.menu { position: relative; display: inline-block; }
.menu-panel, .row-menu-panel { position: absolute; top: calc(100% + 4px); z-index: 70; min-width: 180px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 14px 40px rgba(0,0,0,.45); padding: 6px; display: grid; gap: 1px; }
.menu-panel { left: 0; }
.row-menu-panel { right: 0; min-width: 150px; }
.menu-item { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--text); font: inherit; font-size: 13px; padding: 8px 10px; border-radius: 7px; cursor: pointer; }
.menu-item:hover { background: var(--surface-2); }
.menu-sep { height: 1px; background: var(--border); margin: 5px 2px; }
.menu-head { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; color: var(--text-dim); padding: 4px 10px 2px; }

/* Row ⋯ menu + hover-revealed actions */
.row-menu { position: relative; }
.row-menu-btn { cursor: pointer; background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 15px; line-height: 1; font-weight: 700; }
.row-menu-btn:hover { background: color-mix(in srgb, var(--accent) 18%, var(--surface-2)); }
@media (hover: hover) {
  .lib-row .lib-actions { opacity: 0; transition: opacity .12s; }
  .lib-row:hover .lib-actions,
  .lib-row:focus-within .lib-actions { opacity: 1; }
}
```

- [ ] **Step 3: Verify the stylesheet parses**

Run: `node -e "const s=require('fs').readFileSync('public/css/admin.css','utf8'); const o=(s.match(/{/g)||[]).length, c=(s.match(/}/g)||[]).length; if(o!==c) throw new Error('brace mismatch '+o+'/'+c); console.log('braces balanced:',o)"`

Expected: `braces balanced: <N>` with equal counts (no throw).

Do not commit yet — JS rewiring in Task 3 is required before the page is functional.

---

## Task 3: Rewire the controller (`admin-videos.js`)

**Files:**
- Modify: `public/js/admin-videos.js`

Each step is one focused edit. Apply in order.

- [ ] **Step 1: Replace `renderBulkCatSelect` with `renderCategoryMenu`**

Replace this function (lines 90–96):
```js
function renderBulkCatSelect() {
  const sel = $('bulk-cat-select');
  if (!sel) return;
  const opts = ['<option value="">— category —</option>', '<option value="__none__">Uncategorized</option>']
    .concat(cats.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`));
  sel.innerHTML = opts.join('');
}
```
with:
```js
function renderCategoryMenu() {
  const panel = $('category-menu-panel');
  if (!panel) return;
  const items = [{ slug: '__none__', name: 'Uncategorized' }]
    .concat(cats.map((c) => ({ slug: c.slug, name: c.name })));
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
```

- [ ] **Step 2: Update the `load()` call site**

In `load()` (line 51), replace:
```js
  renderBulkCatSelect();
```
with:
```js
  renderCategoryMenu();
```

- [ ] **Step 3: Add the filters badge sync to `applyFilter`**

In `applyFilter()`, replace the tail (lines 72–74):
```js
  page = 0;
  render();
}
```
with:
```js
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
```

- [ ] **Step 4: Set the library count in `render()`**

In `render()`, replace line 99:
```js
  $('vcount').textContent = `(${filtered.length})`;
```
with:
```js
  $('vcount').textContent = `(${filtered.length})`;
  const lc = $('lib-count');
  if (lc) lc.textContent = `${filtered.length} video${filtered.length === 1 ? '' : 's'}`;
```

- [ ] **Step 5: Toggle the review strip in `updateReviewCounts`**

Replace the function (lines 136–141):
```js
function updateReviewCounts() {
  const un = all.filter(isUnapprovedDraft).length;
  const ap = all.filter(isApprovedDraft).length;
  if ($('unapproved-count')) $('unapproved-count').textContent = un ? `(${un})` : '';
  if ($('approved-count')) $('approved-count').textContent = ap ? `(${ap})` : '';
}
```
with:
```js
function updateReviewCounts() {
  const un = all.filter(isUnapprovedDraft).length;
  const ap = all.filter(isApprovedDraft).length;
  const ra = $('review-all');
  const pa = $('publish-approved');
  const strip = $('review-strip');
  if (ra) { ra.hidden = un === 0; $('unapproved-count').textContent = un; }
  if (pa) { pa.hidden = ap === 0; $('approved-count').textContent = ap; }
  if (strip) strip.hidden = un === 0 && ap === 0;
}
```

- [ ] **Step 6: Rebuild the row actions in `libRow`**

In `libRow()`, replace the `.lib-actions` block in the template (lines 206–210):
```js
    <div class="lib-actions">
      <button class="btn-quick" type="button">Quick edit</button>
      <a class="btn-edit" href="${ADMIN_PATHS.edit}?v=${encodeURIComponent(v.id)}">Edit</a>
      <button class="btn-del" type="button">Delete</button>
    </div>`;
```
with:
```js
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
```

- [ ] **Step 7: Update the row handlers in `libRow`**

Replace the quick-edit binding (line 214):
```js
  row.querySelector('.btn-quick').addEventListener('click', () => startQuickEdit(row, v));
```
with:
```js
  const rmBtn = row.querySelector('.row-menu-btn');
  rmBtn.addEventListener('click', () => togglePanel(rmBtn, row.querySelector('.row-menu-panel')));
  row.querySelector('.row-quick').addEventListener('click', () => { closeAllPopovers(); startQuickEdit(row, v); });
```

Then change the delete binding (line 219) from:
```js
  row.querySelector('.btn-del').addEventListener('click', async () => {
    if (!confirm(`Delete "${v.title || v.id}"? This removes it and its files.`)) return;
```
to:
```js
  row.querySelector('.row-del').addEventListener('click', async () => {
    closeAllPopovers();
    if (!confirm(`Delete "${v.title || v.id}"? This removes it and its files.`)) return;
```

- [ ] **Step 8: Update `updateSel` to drive the selection bar**

Replace the function (lines 230–235):
```js
function updateSel() {
  $('selcount').textContent = `${selected.size} selected`;
  const sa = $('select-all');
  const pageIds = filtered.map((v) => v.id);
  sa.checked = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
}
```
with:
```js
function updateSel() {
  $('selcount').textContent = selected.size;
  const sa = $('select-all');
  const pageIds = filtered.map((v) => v.id);
  sa.checked = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const bar = $('selection-bar');
  if (bar) bar.hidden = selected.size === 0;
}
```

- [ ] **Step 9: Make `runBulkSetCategory` take a slug argument**

Replace the function (lines 260–271):
```js
async function runBulkSetCategory() {
  const sel = $('bulk-cat-select');
  if (!sel) return;
  const slug = sel.value;
  if (!slug) { alert('Choose a category first.'); return; }
  const ids = [...selected];
  if (!ids.length) { alert('Select at least one video.'); return; }
  const catSlug = slug === '__none__' ? '' : slug;
  try { await bulkChunked(ids, `set-category:${catSlug}`); } catch (e) { alert(e.message || 'Bulk action failed.'); return; }
  selected.clear();
  await load();
}
```
with:
```js
async function runBulkSetCategory(slug) {
  const ids = [...selected];
  if (!ids.length) { alert('Select at least one video.'); return; }
  const catSlug = slug === '__none__' ? '' : slug;
  try { await bulkChunked(ids, `set-category:${catSlug}`); } catch (e) { alert(e.message || 'Bulk action failed.'); return; }
  selected.clear();
  await load();
}
```

- [ ] **Step 10: Add popover/menu infrastructure**

Insert these two helpers immediately **before** `function wire() {` (currently line 363):
```js
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

// Toggle one panel: close the others, flip this one, sync aria-expanded.
function togglePanel(btn, panel) {
  if (!panel) return;
  const willOpen = panel.hidden;
  closeAllPopovers(willOpen ? panel : null);
  panel.hidden = !willOpen;
  btn.setAttribute('aria-expanded', String(willOpen));
}
```

- [ ] **Step 11: Replace the `wire()` body**

Replace the entire function (lines 363–380):
```js
function wire() {
  $('search').addEventListener('input', applyFilter);
  $('cat-filter')?.addEventListener('change', applyFilter);
  $('state-filter')?.addEventListener('change', applyFilter);
  $('access-filter')?.addEventListener('change', applyFilter);
  $('review-all')?.addEventListener('click', () => startReview(all.filter(isUnapprovedDraft).map((v) => v.id)));
  $('review-selected')?.addEventListener('click', () => startReview([...selected]));
  $('publish-approved')?.addEventListener('click', publishApproved);
  $('select-all').addEventListener('change', (e) => {
    if (e.target.checked) filtered.forEach((v) => selected.add(v.id));
    else filtered.forEach((v) => selected.delete(v.id));
    render();
  });
  document.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', () => runBulk(b.dataset.bulk)));
  $('bulk-blur-apply')?.addEventListener('click', () => runBulk(`blur-${$('bulk-blur-level').value}`));
  $('bulk-cat-apply')?.addEventListener('click', runBulkSetCategory);
  wireRubberBand();
}
```
with:
```js
function wire() {
  $('search').addEventListener('input', applyFilter);
  $('cat-filter')?.addEventListener('change', applyFilter);
  $('state-filter')?.addEventListener('change', applyFilter);
  $('access-filter')?.addEventListener('change', applyFilter);

  // Filters popover
  const fb = $('filters-btn');
  fb?.addEventListener('click', () => togglePanel(fb, $('filters-popover')));
  $('filters-clear')?.addEventListener('click', () => {
    ['state-filter', 'access-filter', 'cat-filter'].forEach((id) => { if ($(id)) $(id).value = ''; });
    applyFilter();
  });

  // Review strip
  $('review-all')?.addEventListener('click', () => startReview(all.filter(isUnapprovedDraft).map((v) => v.id)));
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
    btn.addEventListener('click', () => togglePanel(btn, btn.nextElementSibling));
  });

  // Bulk actions (publish/approve/premium/free/unapprove/unpublish/delete)
  document.querySelectorAll('[data-bulk]').forEach((b) =>
    b.addEventListener('click', () => { closeAllPopovers(); runBulk(b.dataset.bulk); }));
  // Thumbnail blur levels
  document.querySelectorAll('[data-blur]').forEach((b) =>
    b.addEventListener('click', () => { closeAllPopovers(); runBulk(`blur-${b.dataset.blur}`); }));

  // Global popover dismissal
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest('.menu') || e.target.closest('.row-menu') || e.target.closest('.filters-wrap')) return;
    closeAllPopovers();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllPopovers(); });

  wireRubberBand();
}
```

- [ ] **Step 12: Verify the module parses**

Run: `node --check public/js/admin-videos.js`

Expected: no output, exit 0. (Syntax-only check; `import` at top is fine for `--check`.)

---

## Task 4: Verify in the browser and commit

**Files:** none (verification + commit)

- [ ] **Step 1: Start the dev server**

Use `preview_start` (auto-detects the start command; if it asks, the server entry is `node server.mjs`). The page requires an admin cookie — load the admin videos URL:
`/gigglehacksclicking85hgfd7845789drghudr789rdhkjrtbi8r5eg9875g789-videos.html`

If the site password gate blocks the preview, the admin cookie bypasses it (`ctx.isAdmin` short-circuits the gate in `server.mjs`); ensure the preview session is authenticated as admin.

- [ ] **Step 2: Confirm the calm default view**

`preview_snapshot` and check:
- Header shows `Manage videos (N)`, a `⚲ Filters` button, and the search box.
- No bulk-action buttons are visible (selection bar hidden).
- `preview_console_logs` shows no errors.

- [ ] **Step 3: Exercise the Filters popover**

`preview_click` the `#filters-btn`, `preview_snapshot` to confirm the popover opens with State/Access/Category selects and a `Clear all` link. Set Access to `premium` (via `preview_eval`: `document.getElementById('access-filter').value='premium'; document.getElementById('access-filter').dispatchEvent(new Event('change'))`), confirm the list filters and `#filters-badge` shows `1` and is visible. Click `#filters-clear`, confirm the badge hides and the full list returns.

- [ ] **Step 4: Exercise selection + action bar**

`preview_eval`: `document.getElementById('select-all').click()` (or click a `.row-check`). `preview_snapshot` to confirm `#selection-bar` appears with `N selected`, Publish, Approve, Access ▾, Category ▾, More ▾, Delete, ✕. Click `Access ▾` (`.selection-bar [data-menu="access"] .menu-btn`), confirm the panel opens with Make premium / Make free; click elsewhere, confirm it closes. Click `#clear-selection`, confirm the bar hides.

- [ ] **Step 5: Spot-check a real mutation (Category set)**

Select one video, open `Category ▾`, click a category item. Confirm via `preview_network` that a `POST /api/admin/bulk` fires with `action: "set-category:<slug>"` and the list reloads. (Skip if the preview environment has no writable manifest; in that case verify the request is dispatched, not the persisted result.)

- [ ] **Step 6: Confirm row hover actions**

`preview_snapshot` a row; confirm `Edit` link and `⋯` button are present. Click `⋯`, confirm the panel shows Quick edit / Delete. Click Quick edit, confirm the inline title editor appears.

- [ ] **Step 7: Commit**

```bash
git add public/god-videos.html public/css/admin.css public/js/admin-videos.js
git commit -m "feat(videos): sleek redesign — filters popover + contextual action bar

Replace the three always-on toolbars (filters/review/bulk) with a calm
default view and a selection-triggered action bar. Filters collapse into
a single popover with an active-count badge; bulk toggles collapse into
Access/Category/More menus; review actions become a quiet queue strip;
row actions reveal on hover behind a ⋯ menu. No server changes — all
existing handlers (runBulk, set-category, review handoff, rubber-band)
are reused.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** Two-state layout (Tasks 1–3), single Filters popover with badge + Clear all + Manage categories link (Task 1 §1, Task 3 §3/§11), review strip (Task 1 §1, Task 3 §5), contextual action bar with Publish/Approve/Access▾/Category▾/More▾/Delete/✕ (Task 1 §1, Task 3 §8/§9/§11), blur in More menu (Task 1 §1, Task 3 §11), hover row actions with ⋯ menu (Task 3 §6/§7), drag-select preserved (untouched `wireRubberBand`), no server changes — all covered.
- **Type consistency:** `runBulkSetCategory(slug)` now takes an arg; its only callers are the category menu items built in `renderCategoryMenu` (Task 3 §1). `closeAllPopovers`/`togglePanel` are defined in §10 before their use in §11 and §1/§7. `renderBulkCatSelect` fully replaced by `renderCategoryMenu`; the old `load()` call updated in §2. Removed handlers (`#review-selected`, `#bulk-blur-apply`, `#bulk-cat-apply`, `#bulk-cat-select`, `#bulk-blur-level`) no longer exist in markup and are no longer referenced in JS.
- **No placeholders:** every step contains the exact code to apply.
