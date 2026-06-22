# Category flags — design spec

**Date:** 2026-06-22
**Goal:** Let the admin attach a country flag to any video category (e.g. a "Colombia Harem" category with the Colombia flag). Flags render in the sidebar nav and on video cards. Use the repo's existing SVG flag set (renders identically on every OS/browser) — not unicode flag emoji, which fail on Windows.

## Background

Categories are an admin-managed registry of `{ slug, name }` objects in `data/categories.json` (`lib/categories.js`: `list/add/rename/remove`, seeded with travel/aerial/vlogs/tutorials/music). They are:
- Served publicly via `GET /api/categories` and edited via `POST /api/admin/categories` (`{action: add|rename|remove}`).
- Managed in the `/god-videos` category manager (`public/js/admin-videos.js`).
- Rendered in the homepage **sidebar** (`public/js/sidebar.js`) — each category is a nav button with an icon slot (`.sb-ico`) currently always showing a generic `TAG` SVG.
- Used by `browse.js` to filter the grid. Public video cards (`browse.js` `card()`) currently show **no** category label; the only category badge today is in the admin video list (`.vb-cat`).

Existing reusable assets:
- **SVG flag set:** `public/vendor/flags/4x3/<cc>.svg` (ISO 3166-1 alpha-2, lowercase — e.g. `co.svg` = Colombia). ~250 flags.
- **Country list:** `public/js/countries.js` exports `COUNTRIES = [{ code:"CO", name:"Colombia" }, …]` (alpha-2, **uppercase** code). Flag filename = `code.toLowerCase()`.

## Decisions (locked with owner)

- **Flag rendering:** SVG flag images from `public/vendor/flags/4x3/`, never unicode flag emoji.
- **Scope of a flag:** a country (from the flag set). One optional flag per category.
- **Public surfaces:** sidebar nav + video cards. (Not the filtered-view header.)
- **Card placement:** inline in the card meta row — a small flag + category name under the "David Bond TV ✔" channel line (mockup option B).
- **Admin:** a searchable country picker per category (and on the add form), reusing `countries.js`; plus a "none" option to clear.

## Data model

A category becomes `{ slug, name, flag? }` where `flag` is an **ISO alpha-2 code, lowercase** (e.g. `"co"`) or absent/empty for no flag. Fully backward-compatible: existing categories lack `flag` and render with the current tag icon.

## Components & changes

### `lib/categories.js`
- `isValidFlag(code)` helper: returns true for a 2-letter `[a-z]{2}` string (lowercased). (A 2-letter constraint is enough to prevent path issues; a missing SVG simply renders nothing via the image `onerror` fallback.)
- `add(name, flag)` — accept an optional flag; store it lowercased only if valid, else omit.
- `setFlag(slug, flag)` — set the flag on an existing category; empty string / invalid clears it (deletes the key). Returns `{ ok, category }` or `{ ok:false, error }`.
- `rename` / `remove` unchanged. `read()` keeps existing filter (`c.slug && c.name`) so flag is optional.

### Server — `POST /api/admin/categories` (in `server.mjs`)
- `add` action: pass through optional `flag` to `categories.add`.
- New `setflag` action: `{ action:'setflag', slug, flag }` → `categories.setFlag`. `flag` may be `''` to clear.
- `rename` / `remove` unchanged. All responses keep returning the full updated `categories` array (as today) so the admin UI re-renders.
- `GET /api/categories` unchanged — it already returns the objects, so `flag` is included automatically.

### Admin UI — `public/js/admin-videos.js` (category manager)
- `import { COUNTRIES } from './countries.js'`.
- Build a reusable country `<select>` (native type-ahead search): first option `— No flag —` (value `''`), then `COUNTRIES` as `<option value="co">Colombia</option>` (value = `code.toLowerCase()`).
- **Each category row:** show the current flag thumbnail (or nothing) + the country `<select>` preset to `c.flag || ''`; on change, call `catAction({ action:'setflag', slug, flag })` and re-render.
- **Add form:** the existing name input + a country `<select>`; on add, send `{ action:'add', name, flag }`.
- The admin video badge (`.vb-cat`) gets the flag prepended when the video's category has one (small `<img>`), built from the `cats` list already loaded.

### Sidebar — `public/js/sidebar.js`
- Add a `flagImg(code)` helper returning `<img class="sb-flag" src="/vendor/flags/4x3/${code}.svg" alt="" loading="lazy" onerror="this.remove()">`.
- In the category map (line ~46), pass `c.flag ? flagImg(c.flag) : TAG` as the icon argument to `itemHTML`. No change to `itemHTML` signature.

### Video cards — `public/js/browse.js`
- Fetch `GET /api/categories` alongside the existing data and build a `Map(slug → category)` so cards can look up a flag (the page doesn't currently load categories).
- In `card(v)`: if `v.category` resolves to a category with a `flag`, render a meta row under `.vchannel`: a small flag `<img>` + the category name (placement B). Use `textContent` for the name (XSS-safe), and `onerror="this.remove()"` on the flag img.

### CSS — `public/styles.css`
- `.sb-flag` — sized to match `.sb-ico` (≈18–20px wide, 4:3, slight border-radius, object-fit cover).
- `.vcat` (card meta row) — small flex row, `--text-dim`, ~11–12px; `.vcat img` ≈15×11px rounded.
- `.vb-cat img` (admin badge) — tiny inline flag, vertical-aligned.

## Edge cases & error handling
- **Missing/invalid flag code:** server rejects non-`[a-z]{2}` on write; on render a missing SVG is removed via `onerror` so no broken-image icon shows.
- **Category with no flag:** unchanged behavior (tag icon in sidebar, no flag on cards).
- **Removing a category / renaming:** flag travels with the object; rename keeps it.
- **Deleted/renamed flag asset:** graceful (image self-removes).

## Testing
- **`tests/categories.test.js` (new, vitest):** pure-logic tests for `lib/categories.js` against a temp `data/` (follow the pattern of other `tests/*.test.js`). Cover: `add` with a valid flag stores lowercased; `add` with an invalid flag omits it; `setFlag` sets / clears / rejects invalid; `isValidFlag` true/false cases; flag survives `rename`.
- **Manual/preview:** create "Colombia Harem" with Colombia in `/god-videos`; verify the flag in the sidebar and on a card assigned to that category; verify a flagless category still shows the tag icon.

## Deliverable for the owner's request
After the feature ships, create the **"Colombia Harem"** category with the **Colombia (`co`)** flag — via the new admin picker (two clicks) — and confirm it renders in the sidebar + on its videos.

## Out of scope
- Unicode flag emoji.
- Non-flag/arbitrary emoji icons for categories (could be a later addition; the `flag` field is country-only for now).
- Filtered-view header flag.
- Per-video country tags independent of category.

## Versioning
Bump `package.json` version per project convention (`1.14.1` → `1.15.0` — new user-facing feature).
