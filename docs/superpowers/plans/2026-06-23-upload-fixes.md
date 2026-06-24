# Upload Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the in-progress upload admin fixes: correct duplicate-upload error messages, auto-clear completed uploads after 24 h, consistent category badges, Retry All button, visible upload limits, and no rate-limiting for admins.

**Architecture:** `upload-utils.js` (new helper module) and `upload.js` (controller) are already complete. Two files still need changes: `god-upload.html` needs 4 missing DOM elements that `upload.js` already references, and `server.mjs` needs the admin rate-limiter removed from the two upload-init routes.

**Tech Stack:** Vanilla JS (ESM), Node.js HTTP server (`server.mjs`), HTML/CSS.

---

## What's already done

- `public/js/upload-utils.js` — complete (duplicate error messaging, 24 h retention filter, category badge helpers)
- `public/js/upload.js` — complete (all 633 lines: `retryAllBtn`, `uploadLimitsNote`, `categoryBadgeEl`, `syncRetryAllButton`, `retryAllFailed`, `filterRetainedJobs` in `recoverJobs`, proper 409 handling via `describeUploadError`)

## Files to modify

| File | Change |
|------|--------|
| `public/god-upload.html` | Add `category-badge`, `retry-all`, `upload-limits-note`, `drip-hint` elements |
| `server.mjs` | Remove `uploadLimiter.hit()` blocks from `/api/admin/upload` and `/api/admin/upload/init` |

---

## Task 1: Add missing HTML elements to god-upload.html

**Files:**
- Modify: `public/god-upload.html`

- [ ] **Step 1: Add `category-badge` element inside the category field**

In the `#category-row` `.up-field` div (after the `.cat-wrap`), add a small badge div that shows the selected category's icon/flag/bullet. `upload.js`'s `syncCategoryBadge()` populates it via `innerHTML`.

Replace:
```html
              <div class="up-field" id="category-row">
                <span class="up-label">Category</span>
                <div class="cat-wrap">
                  <select id="category" class="acc-select">
                    <option value="">Uncategorized</option>
                  </select>
                  <a href="/gigglehacksclicking85hgfd7845789drghudr789rdhkjrtbi8r5eg9875g789-videos.html" class="field-note">Manage →</a>
                </div>
              </div>
```

With:
```html
              <div class="up-field" id="category-row">
                <span class="up-label">Category</span>
                <div class="cat-wrap">
                  <select id="category" class="acc-select">
                    <option value="">Uncategorized</option>
                  </select>
                  <a href="/gigglehacksclicking85hgfd7845789drghudr789rdhkjrtbi8r5eg9875g789-videos.html" class="field-note">Manage →</a>
                </div>
                <div id="category-badge" class="cat-badge-row"></div>
              </div>
```

- [ ] **Step 2: Add CSS for `.cat-badge-row` and `.cat-badge-glyph` in the `<style>` block**

Add before the closing `</style>` tag:
```css
    .cat-badge-row { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-dim); min-height: 18px; }
    .cat-badge-row img { width: 18px; height: 13px; object-fit: cover; border-radius: 2px; }
    .cat-badge-glyph { font-size: 15px; line-height: 1; }
```

- [ ] **Step 3: Add `drip-hint` inside the Publishing field**

Replace:
```html
                <select id="drip-interval" class="acc-select hidden">
                  <option value="86400000">Every 24 hours</option>
                  <option value="172800000">Every 48 hours</option>
                  <option value="259200000">Every 72 hours</option>
                  <option value="604800000">Once per week</option>
                </select>
```

With:
```html
                <select id="drip-interval" class="acc-select hidden">
                  <option value="86400000">Every 24 hours</option>
                  <option value="172800000">Every 48 hours</option>
                  <option value="259200000">Every 72 hours</option>
                  <option value="604800000">Once per week</option>
                </select>
                <p id="drip-hint" class="field-note hidden">First video publishes immediately; each subsequent one releases at the chosen interval.</p>
```

- [ ] **Step 4: Add `retry-all` button and `upload-limits-note` in the jobs-card section**

Replace:
```html
      <section id="jobs-card" class="card hidden">
        <h2>Recent uploads</h2>
        <div id="jobs"></div>
      </section>
```

With:
```html
      <section id="jobs-card" class="card hidden">
        <div class="jobs-header">
          <h2>Recent uploads</h2>
          <button type="button" id="retry-all" class="btn ghost sm" disabled>↩ Retry all failed</button>
        </div>
        <p id="upload-limits-note" class="field-note"></p>
        <div id="jobs"></div>
      </section>
```

- [ ] **Step 5: Add CSS for `.jobs-header`**

Add before closing `</style>`:
```css
    .jobs-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
    .jobs-header h2 { margin: 0; }
    #upload-limits-note { margin: 0 0 12px; }
```

- [ ] **Step 6: Commit**

```bash
git add public/god-upload.html
git commit -m "feat(upload): add missing HTML elements for retry-all, upload-limits, category-badge, drip-hint"
```

---

## Task 2: Remove admin rate-limiter from upload routes in server.mjs

**Files:**
- Modify: `server.mjs` lines 1401–1404 and 1428–1431

- [ ] **Step 1: Remove rate-limiter from `/api/admin/upload` (legacy single-shot route)**

Remove lines 1401–1404:
```js
    if (!uploadLimiter.hit(clientIp(req)).allowed) {
      sendJson(res, 429, { error: 'Too many uploads — wait a minute and try again.' });
      return true;
    }
```

The block immediately after the `isAdminReq` check; delete it entirely.

- [ ] **Step 2: Remove rate-limiter from `/api/admin/upload/init` (chunked upload route)**

Remove lines 1428–1431 (same pattern):
```js
    if (!uploadLimiter.hit(clientIp(req)).allowed) {
      sendJson(res, 429, { error: 'Too many uploads — wait a minute and try again.' });
      return true;
    }
```

Note: `uploadLimiter` is still used elsewhere (non-admin routes), so do NOT remove the `createRateLimiter` import or the `uploadLimiter` declaration at line 124.

- [ ] **Step 3: Commit**

```bash
git add server.mjs
git commit -m "fix(upload): remove rate-limiting on admin upload routes"
```

---

## Verification

1. Start the server: `node server.mjs`
2. Open `/god-upload.html` (or the upload subdomain)
3. **Category badge:** Select a category with a flag — confirm the SVG flag appears below the dropdown. Select one with an emoji icon — confirm the emoji shows. Select Uncategorized — confirm `•` shows.
4. **Upload limits note:** Confirm the note appears at the top of the Recent Uploads section with size limit and "no batch cap".
5. **Drip hint:** Toggle Publishing to Schedule — confirm hint text appears below the interval select.
6. **Duplicate detection:** Upload a video. Upload the same video again. Confirm error says `Duplicate — this video matches "..." already in your library.` (not "fell out of sync").
7. **Retry All:** Upload two files and interrupt network — confirm both show Retry buttons, then "↩ Retry all failed" button is enabled and clicking it retries both.
8. **No rate limit:** Upload 31+ files in quick succession — confirm no 429 responses.
9. **24 h retention:** Completed rows that are more than 24 h old should not appear on page reload (test by temporarily setting `RECENT_UPLOAD_RETENTION_MS` to a small value in `upload-utils.js`).

---

## Next subsystems (separate plans)

The v1.29.0 release has 4 more independent subsystems — each needs its own plan once upload fixes ship:

1. **Draft review carousel** (`god-review.html`, `admin-review.js`) — Previous/Next controls, unmuted playback, delete animation
2. **Categories admin** — Dedicated `/god-categories.html` view with search, counts, edit modal
3. **Signup verification** — 6-digit email codes, verification modal, onboarding steps (`lib/accounts.js`)
4. **Coupons** — Percent-off system with admin CRUD, checkout integration, Stripe attachment (`lib/coupons.js`)
