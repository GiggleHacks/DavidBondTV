# David Bond TV — Brand Kit

A polished, multi-format logo kit generated from the original artwork. Everything in
this folder is produced by [`build-logos.py`](build-logos.py); the originals
(`../logo.jpg`, `../logo2.jpg`, `../avatar.jpg`, the font) are **never modified**.

> **Review build — not yet wired into the site.** These files are for review. None of
> the live pages, favicons, or `public/brand/` assets have been changed. Wiring them in
> is a separate, opt-in step (see *Wiring in* below).

Quick visual overview: **[`contact-sheet.png`](contact-sheet.png)**.

To regenerate: `python logos/build-logos.py` (needs Pillow + NumPy + OpenCV — already installed).

---

## What was improved

The source `logo.jpg` was a single lossy JPEG with the figure **and** wordmark fused onto
a solid navy background, odd EXIF metadata baked in, loose cropping, and no transparency
or scalability. This kit fixes that:

- **Separated** the mark (figure) from the wordmark so each can be used independently and
  recomposed for any placement.
- Built the **mark** from the clean, wordmark-free `avatar.jpg` and cropped it to a tidy,
  balanced square (head-and-shoulders).
- **Rebuilt the wordmark as true vector** — re-typeset in the brand font (Pixelify Sans)
  with the exact brand blue, so it's razor-sharp at any size.
- **Stripped all metadata**, optimized every file, and exported the full range of
  formats and sizes, including transparent variants and a complete favicon/app-icon set.

---

## Palette & type

| Token | Value | Use |
|-------|-------|-----|
| Accent blue | `#3b82f6` | the `TV` tile, links, highlights |
| White | `#ffffff` | wordmark text on dark, tile text |
| Ink | `#0f172a` | wordmark text on light backgrounds |
| Brand dark | `#0a0f1c` | site background / dark cards |
| Navy | `#171a2d` | the illustration's own background (seamless lockups) |
| Light card | `#f4f6fb` | soft light background panels |

**Wordmark font:** *Pixelify Sans* (bold) — `../public/fonts/pixelify-bold.woff2`, the
same retro pixel face the artwork uses.

---

## Files

### `primary/` — full vertical lockup (mark over wordmark, seamless navy)
`logo-primary.png` · `.webp` · `.jpg` — the default logo. PNG (transparent-safe) and
WebP for the web, JPG for places that need a flat file.

### `horizontal/` — mark left, wordmark right
`logo-horizontal.png` · `.webp` (navy) and `logo-horizontal-transparent.png` (rounded
badge + wordmark on transparency). Best for site headers and email signatures.

### `square/` — 1:1 lockup
`logo-square.png` · `.webp`. For avatars / tiles that want the wordmark included.

### `mark/` — the figure only
- `mark-1024 / 512 / 256.png` — square navy mark (drop-in replacement quality for the
  existing `public/brand/mark.png`).
- `mark-rounded.png` — rounded-square, **transparent corners** (app-icon style).
- `mark-circle.png` — circular, **transparent** (avatars / round badges).

### `wordmark/` — "David Bond TV" only
- `wordmark.svg` (white, neutral) · `wordmark-dark.svg` (white, for dark bg) ·
  `wordmark-light.svg` (ink, for light bg) — **scalable vector**, self-contained.
- `wordmark.png` · `.webp` (white) and `wordmark-on-light.png` (ink) — raster renders.

### `full/` — `logo-full.svg`
A single scalable file: the vector wordmark plus the mark embedded as a high-res image.

### `on-light/` & `on-dark/`
`logo-on-light.png/.webp` (light card, ink wordmark) and `logo-on-dark.png/.webp`
(brand-dark card, white wordmark) — ready-made lockups for each background.

### `icon/` — favicons & app icons
`favicon.ico` (16/32/48 multi-res) · `favicon-16/32/48.png` · `apple-touch-icon.png`
(180, opaque) · `icon-192.png` · `icon-512.png` · `maskable-512.png` (safe-zone padded
for Android adaptive icons) · `site.webmanifest` (sample). File names mirror the existing
ones in `public/` so wiring later is a drop-in.

---

## Notes & caveats

- **Transparency = geometric, not free-floating.** A clean free-floating cutout of the
  figure isn't achievable from this artwork: the hair, sunglasses, and black leather
  jacket sit at almost the same brightness as the navy background, so every automated
  separation (GrabCut, colour threshold, flood-fill) either leaves a halo or eats the
  dark areas. Transparency is therefore delivered via the **circle** and **rounded**
  badge masks — a crisp, intentional edge that's also the more professional treatment for
  a detailed portrait mark. If a true cutout is ever needed, it requires a manual mask in
  an image editor or an ML background remover (e.g. `rembg`), neither used here.
- **SVG wordmark fonts are embedded.** The wordmark/full SVGs embed the woff2 font as
  base64 with live `<text>`, so they render crisply in browsers without the font being
  installed (that's what inflates `logo-full.svg`). A few non-browser tools ignore
  embedded fonts; for those, use the PNG/WebP renders.
- The mark intentionally uses the illustration's own navy, so navy lockups are seamless.

---

## Wiring in (optional, later)

When approved, these can replace the live assets with minimal edits:

- Swap `public/brand/mark.png` ← `mark/mark-512.png` (or the rounded variant).
- Replace `public/favicon.ico`, `favicon-16/32/48.png`, `apple-touch-icon.png`,
  `icon-192/512.png` ← matching files in `icon/`.
- Add the header `<img>`/`og:image` using `horizontal/` or `primary/`, and link
  `icon/site.webmanifest`.

No site files have been touched in this pass.
