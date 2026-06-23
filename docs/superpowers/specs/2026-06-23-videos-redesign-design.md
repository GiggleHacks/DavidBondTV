# Videos Admin Page Redesign — Design Spec

**Date:** 2026-06-23
**Status:** Approved (design), pending implementation
**Scope:** `public/god-videos.html`, `public/css/admin.css`, `public/js/admin-videos.js` (UI only — no server changes)

## Problem

The "Manage videos" admin page exposes every control at all times. Three stacked
toolbars are always visible:

1. **`.mv-filters`** — state / access / category dropdowns, search, "Manage categories" link
2. **`.reviewbar`** — review-all, review-selected, publish-approved buttons
3. **`.bulkbar`** — select-all, 6 toggle buttons (approve/unapprove/publish/unpublish/premium/free),
   category select+apply, blur select+apply, delete

The result is "so many random buttons and dropdowns" with no visual hierarchy. Bulk
actions are shown even when nothing is selected; rarely-used toggles sit beside common
ones with equal weight. Goal: a calm default view that surfaces controls **contextually**.

## Design Principles

- **Calm by default.** When nothing is selected, show only what's needed to find and
  browse videos. Actions appear when there is something to act on.
- **Collapse toggle pairs into menus.** Premium/Free and the publish/approve inverse
  actions don't both need to be on screen at once.
- **Nothing is removed.** Every existing action remains reachable — moved, not deleted.
- **No server changes.** Reuse every existing handler (`runBulk`, `runBulkSetCategory`,
  rubber-band selection, review handoff). This is a markup + CSS + wiring restructure.

## Layout — Two States

### Default state (nothing selected)

```
┌──────────────────────────────────────────────────────────────┐
│ Manage videos · 128            [ ⚲ Filters ② ]  [ search… ]   │  ← header row
├──────────────────────────────────────────────────────────────┤
│ Review queue · 4 unapproved →   · 2 approved ready to publish →│  ← quiet strip
├──────────────────────────────────────────────────────────────┤
│ ☐ Select all · 128 videos                                      │  ← list header
├──────────────────────────────────────────────────────────────┤
│ ☐  [thumb]  Title …  [badges]              Edit  ⋯  (on hover) │  ← rows
│ ☐  [thumb]  Title …  [badges]              Edit  ⋯             │
└──────────────────────────────────────────────────────────────┘
```

**Header row:** `Manage videos · <count>` on the left. On the right, a single
**`⚲ Filters`** button with an active-count badge, plus the inline search input.

**Filters popover** (opens from the Filters button, closes on outside-click / Esc):
a small panel containing the three dropdowns stacked vertically —
- State (All states / Draft·Unapproved / Draft·Approved / Published / Processing / Failed)
- Access (All access / Free / Premium)
- Category (All categories / Uncategorized / …each category)

Footer of the popover: a `Clear all` link (resets the three filters) and a
`Manage categories →` link (absorbs the stray link from the old toolbar). The button's
badge shows the number of non-default filters active.

**Review-queue strip:** one quiet line, only meaningful counts shown as links:
- `<n> unapproved →` → triggers the old `review-all` flow (review all unapproved)
- `<n> approved ready to publish →` → triggers the old `publish-approved` flow

If both counts are zero the strip is hidden.

**List header:** a thin row with `☐ Select all` and `<count> videos`. Always present —
this is the affordance that lets the contextual action bar appear.

### Selected state (≥1 video selected)

When `selected.size > 0`, the contextual **action bar** replaces the list header:

```
┌──────────────────────────────────────────────────────────────┐
│ ✔ 3 selected │ Publish · Approve · Access▾ · Category▾ · More▾ │      Delete   ✕ │
└──────────────────────────────────────────────────────────────┘
```

| Control       | Maps to (existing `data-bulk` / handler)                              |
|---------------|----------------------------------------------------------------------|
| **Publish**   | `data-bulk="publish"`                                                 |
| **Approve**   | `data-bulk="approve"`                                                 |
| **Access ▾**  | menu → Make premium (`premium`) · Make free (`free`)                  |
| **Category ▾**| menu → category list + Uncategorized → `runBulkSetCategory` per item  |
| **More ▾**    | menu → Unapprove (`unapprove`) · Unpublish (`unpublish`) · Review selected (`review-selected` flow) · Blur ▸ (Off/Medium/Strong/Strongest → `bulk-blur` flow) |
| **Delete**    | `data-bulk="delete"`, danger styling, pinned right                   |
| **✕**         | clear selection (uncheck all, hide bar)                              |

The bar is sticky to the top of the card while scrolling so actions stay reachable on
long lists.

## Rows

Each row keeps its current content — checkbox, thumbnail, title + meta, and the existing
state / Premium / category badges (these are already clear and unchanged). Row actions
become **hover-revealed** (always visible on touch / narrow widths):
- **Edit** — direct link/button (unchanged target)
- **⋯** menu — Quick edit · Delete

Drag-to-select (rubber band) is unchanged and adds rows to `selected`, which triggers the
action bar exactly like checkbox or Select-all.

## Component Breakdown

### `god-videos.html`
Replace the `.mv-filters` / `.reviewbar` / `.bulkbar` block (lines ~54–107) with:
- header row: title+count, `#filters-btn` (with `#filters-badge`), `#search`
- `#filters-popover`: `#state-filter`, `#access-filter`, `#cat-filter`, `Clear all`, Manage categories link
- `#review-strip`: `#review-all` and `#publish-approved` as links with count spans
- `#list-header`: `#select-all` + `#vcount-inline`
- `#selection-bar` (hidden by default): `#selcount`, Publish, Approve, `#access-menu`,
  `#category-menu`, `#more-menu`, Delete, `#clear-selection`

IDs preserved where the JS already binds them (`state-filter`, `access-filter`,
`cat-filter`, `search`, `select-all`, `review-all`, `publish-approved`, `library`, `pager`).

### `css/admin.css`
- New: `.mv-header`, `.filters-btn` + badge, `.filters-popover`, `.review-strip`,
  `.list-header`, `.selection-bar`, `.menu` / `.menu-panel` (shared dropdown), `.row-actions`
- Retire / replace: `.mv-filters`, `.reviewbar`, `.bulkbar`, `.bulk-cat`, `.bulk-blur`
  (keep any rules still referenced by rows/badges)

### `admin-videos.js`
- **New UI plumbing:** popover open/close (outside-click + Esc), generic dropdown-menu
  toggle, `syncSelectionBar()` to show/hide `#selection-bar` and update `#selcount` from
  `selected.size`, `syncFiltersBadge()` to count active filters.
- **Rewire (no logic change):** Publish/Approve/Access/More items call the existing
  `runBulk` paths; Category menu calls `runBulkSetCategory`; Blur submenu calls the
  existing blur-apply path; Review-strip links call the existing review-all /
  publish-approved handlers; `#clear-selection` clears `selected` and re-renders.
- `applyFilter`, `bulkChunked`, `runBulkSetCategory`, `wireRubberBand` are unchanged.

## Data Flow

No API or manifest changes. Selection state (`selected` Set) and filter values remain the
single source of truth. `syncSelectionBar()` runs wherever selection changes today
(checkbox toggle, select-all, rubber-band mouseup, post-action re-render).

## Error Handling

Unchanged — bulk actions already surface errors via the existing toast/status path.
Menus close on action dispatch; a failed bulk action leaves selection intact so the user
can retry.

## Testing

Manual verification against a running dev server (admin cookie present, site password
bypassed for admin):
1. Default view shows no bulk controls; Filters button + review strip render.
2. Filters popover opens, each dropdown filters the list, badge reflects active count,
   Clear all resets, outside-click/Esc closes.
3. Selecting via checkbox, Select-all, and drag-select each reveals the action bar with
   correct count.
4. Each action bar control performs the same mutation as the old button (spot-check
   Publish, Approve, Access→Premium/Free, Category set, More→Unapprove/Unpublish/Blur,
   Delete).
5. Review strip links drive review-all and publish-approved flows.
6. Row hover actions (Edit, ⋯→Quick edit/Delete) work.

## Out of Scope

- The "Publish to server" card (`#publish-card`) and `publish.js` — untouched.
- Server, manifest, and ingest logic.
- The other v1.29.0 subsystems (categories admin, coupons, signup verification,
  draft review carousel) — separate specs.
