#!/usr/bin/env python3
"""
David Bond TV — brand-kit generator.

Reads (never writes) the originals:
    ../logo.jpg                          the source lockup
    ../public/fonts/pixelify-bold.woff2  the wordmark face (Pixelify Sans)

and emits a full, multi-format brand kit into this `logos/` folder.

Run:  python logos/build-logos.py      (from the repo root)
      python build-logos.py            (from inside logos/)

Pure stdlib + Pillow + NumPy + OpenCV. No network, no ML model.
"""

import base64
import io
import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

try:
    import cv2
    HAVE_CV2 = True
except Exception:
    HAVE_CV2 = False

# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC_LOCKUP   = os.path.join(ROOT, "logo.jpg")     # original figure + baked wordmark
SRC_WORDMARK = os.path.join(ROOT, "logo2.jpg")    # clean wordmark-only reference
SRC_MARK     = os.path.join(ROOT, "avatar.jpg")   # clean figure-only — base for the mark
FONT = os.path.join(ROOT, "public", "fonts", "pixelify-bold.woff2")


def out(*parts):
    p = os.path.join(HERE, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


# --------------------------------------------------------------------------- #
# Brand constants (mirrors public/styles.css :root)
# --------------------------------------------------------------------------- #
ACCENT     = (59, 130, 246)    # #3b82f6  blue tile
WHITE      = (255, 255, 255)
INK        = (15, 23, 42)      # #0f172a  dark text for light backgrounds
BRAND_DARK = (10, 15, 28)      # #0a0f1c  site --bg
LIGHT_CARD = (244, 246, 251)   # #f4f6fb  soft light card
NAVY       = (23, 26, 45)      # #171a2d  the source illustration's own background

MANIFEST = []   # relpaths collected for the run summary


def save(img, *parts):
    path = out(*parts)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".png":
        img.save(path, optimize=True)
    elif ext == ".webp":
        img.save(path, quality=92, method=6)
    elif ext in (".jpg", ".jpeg"):
        img.convert("RGB").save(path, quality=90, optimize=True, progressive=True)
    else:
        img.save(path)
    MANIFEST.append(os.path.relpath(path, HERE).replace("\\", "/"))
    return path


def save_bytes(data, *parts):
    path = out(*parts)
    with open(path, "wb") as f:
        f.write(data)
    MANIFEST.append(os.path.relpath(path, HERE).replace("\\", "/"))
    return path


def save_text(text, *parts):
    path = out(*parts)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    MANIFEST.append(os.path.relpath(path, HERE).replace("\\", "/"))
    return path


def hexc(rgb):
    return "#%02x%02x%02x" % rgb


# --------------------------------------------------------------------------- #
# 1. Load & clean sources (metadata is dropped by decode + re-encode).
#    The mark is built from avatar.jpg — the clean figure with NO baked wordmark.
# --------------------------------------------------------------------------- #
print("Reading mark source:", SRC_MARK)
src = Image.open(SRC_MARK).convert("RGB")
W, H = src.size
arr = np.asarray(src).astype(np.float32)

border = np.concatenate([
    arr[:8].reshape(-1, 3), arr[-8:].reshape(-1, 3),
    arr[:, :8].reshape(-1, 3), arr[:, -8:].reshape(-1, 3)])
bg = np.median(border, axis=0)
dist = np.sqrt(((arr - bg) ** 2).sum(2))
content = dist > 38

prows = np.where(content.any(1))[0]
pcols = np.where(content.any(0))[0]
py0, py1 = int(prows.min()), int(prows.max())
px0, px1 = int(pcols.min()), int(pcols.max())
print(f"Figure bbox: x[{px0}:{px1}] y[{py0}:{py1}]")

# --------------------------------------------------------------------------- #
# 2. The mark — clean square head-and-shoulders crop of the figure
# --------------------------------------------------------------------------- #
def make_mark_square():
    cx = (px0 + px1) // 2
    top = max(0, py0 - int(0.04 * H))               # a little air above the head
    side = int((px1 - px0) * 0.90)                  # frame head + shoulders
    side = min(side, H - top)
    left = max(0, min(cx - side // 2, W - side))
    return src.crop((left, top, left + side, top + side))

mark_rgb = make_mark_square().resize((1024, 1024), Image.LANCZOS)
print("Mark square:", mark_rgb.size)


def rounded_mask(size, radius_frac=0.22):
    m = Image.new("L", (size, size), 0)
    r = int(size * radius_frac)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=255)
    return m


def circle_mask(size):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).ellipse((0, 0, size - 1, size - 1), fill=255)
    return m


def masked(square_rgb, mask):
    img = square_rgb.convert("RGBA")
    img.putalpha(mask.resize(square_rgb.size, Image.LANCZOS))
    return img

mark_rounded = masked(mark_rgb, rounded_mask(1024))
mark_circle  = masked(mark_rgb, circle_mask(1024))

save(mark_rgb, "mark", "mark-1024.png")
save(mark_rgb.resize((512, 512), Image.LANCZOS), "mark", "mark-512.png")
save(mark_rgb.resize((256, 256), Image.LANCZOS), "mark", "mark-256.png")
save(mark_rounded.resize((512, 512), Image.LANCZOS), "mark", "mark-rounded.png")
save(mark_circle.resize((512, 512), Image.LANCZOS), "mark", "mark-circle.png")

# --------------------------------------------------------------------------- #
# 3b. Transparency note — no free-floating cutout.
#     The figure's hair / sunglasses / black leather jacket sit at the same value
#     as the navy background, so every automated separation (GrabCut, colour
#     threshold, border flood-fill) either leaves a halo or eats the dark areas.
#     Clean transparency is delivered instead via the circle / rounded badge masks
#     above (transparent OUTSIDE a crisp geometric edge), which is also the more
#     professional treatment for a detailed portrait mark.
# --------------------------------------------------------------------------- #

# --------------------------------------------------------------------------- #
# 4. Wordmark — rebuilt crisply in Pixelify Sans
# --------------------------------------------------------------------------- #
PRE = "David Bond"
BOX = "TV"


def _font(size):
    return ImageFont.truetype(FONT, size)


def measure(text, size):
    f = _font(size)
    l, t, r, b = f.getbbox(text)
    return (r - l, b - t, l, t)


def render_wordmark(text_color, size=240):
    """Return a tightly-cropped RGBA wordmark: 'David Bond' + boxed 'TV'."""
    f = _font(size)
    # generous scratch canvas
    cw, ch = size * 14, int(size * 2.2)
    img = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    baseline_y = int(size * 0.55)

    # prefix
    pl, pt, pr, pb = d.textbbox((0, 0), PRE + " ", font=f)
    d.text((0, baseline_y), PRE, font=f, fill=text_color + (255,))
    pre_w = d.textbbox((0, 0), PRE, font=f)[2]
    gap = int(size * 0.20)

    # tile around "TV"
    bl, bt, br, bb = d.textbbox((0, 0), BOX, font=f)
    box_w, box_h = br - bl, bb - bt
    pad_x, pad_y = int(size * 0.22), int(size * 0.14)
    cl, ct, cr, cap = d.textbbox((0, 0), "TV", font=f)
    # vertical extent of caps for tile sizing
    tile_x0 = pre_w + gap
    tile_top = baseline_y + bt - pad_y
    tile_h = box_h + 2 * pad_y
    tile_w = box_w + 2 * pad_x
    radius = int(tile_h * 0.24)
    d.rounded_rectangle(
        (tile_x0, tile_top, tile_x0 + tile_w, tile_top + tile_h),
        radius=radius, fill=ACCENT + (255,))
    d.text((tile_x0 + pad_x - bl, baseline_y), BOX, font=f, fill=WHITE + (255,))

    bbox = img.getbbox()
    return img.crop(bbox)

wm_white = render_wordmark(WHITE)   # for dark backgrounds
wm_dark  = render_wordmark(INK)     # for light backgrounds
save(wm_white, "wordmark", "wordmark.png")
save(wm_white, "wordmark", "wordmark.webp")
save(wm_dark,  "wordmark", "wordmark-on-light.png")

# --------------------------------------------------------------------------- #
# 4b. Vector wordmark SVG (real text + embedded Pixelify font)
# --------------------------------------------------------------------------- #
FONT_B64 = base64.b64encode(open(FONT, "rb").read()).decode("ascii")


def wordmark_svg(text_color, name):
    """Self-contained SVG: embedded woff2 @font-face + live text + TV tile."""
    S = 100.0
    f = _font(int(S))
    d = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
    pre_w = d.textbbox((0, 0), PRE, font=f)[2]
    bl, bt, br, bb = d.textbbox((0, 0), BOX, font=f)
    box_w, box_h = br - bl, bb - bt
    asc, desc = f.getmetrics()
    gap = S * 0.20
    pad_x, pad_y = S * 0.22, S * 0.14
    tile_x = pre_w + gap
    tile_w = box_w + 2 * pad_x
    tile_h = box_h + 2 * pad_y
    radius = tile_h * 0.24
    baseline = asc
    tile_y = baseline + bt - pad_y
    total_w = tile_x + tile_w
    total_h = asc + desc
    fs = S
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total_w:.1f} {total_h:.1f}" role="img" aria-label="David Bond TV">
  <defs><style>
    @font-face {{
      font-family: "Pixelify Sans";
      src: url(data:font/woff2;base64,{FONT_B64}) format("woff2");
      font-weight: 700;
    }}
    text {{ font-family: "Pixelify Sans", Arial, sans-serif; font-weight: 700; font-size: {fs:.0f}px; }}
  </style></defs>
  <text x="0" y="{baseline:.1f}" fill="{hexc(text_color)}">{PRE}</text>
  <rect x="{tile_x:.1f}" y="{tile_y:.1f}" width="{tile_w:.1f}" height="{tile_h:.1f}" rx="{radius:.1f}" fill="{hexc(ACCENT)}"/>
  <text x="{tile_x + pad_x - bl:.1f}" y="{baseline:.1f}" fill="{hexc(WHITE)}">{BOX}</text>
</svg>
'''
    save_text(svg, "wordmark", name)
    return svg

wordmark_svg(WHITE, "wordmark.svg")          # neutral / dark-bg (white text)
wordmark_svg(WHITE, "wordmark-dark.svg")     # explicit dark-bg
wordmark_svg(INK,   "wordmark-light.svg")    # light-bg (dark text)

# --------------------------------------------------------------------------- #
# 5. Lockups
# --------------------------------------------------------------------------- #
def fit_wordmark(target_w, color="white"):
    wm = wm_white if color == "white" else wm_dark
    scale = target_w / wm.width
    return wm.resize((target_w, max(1, int(wm.height * scale))), Image.LANCZOS)


def primary(bg_rgb, wm_color, mark_img, sq=False):
    """Vertical lockup: mark on top, wordmark beneath, balanced padding."""
    canvas_w = 1280
    pad = int(canvas_w * 0.10)
    mark_s = int(canvas_w * 0.46)
    wm_w = int(canvas_w * 0.62)
    wm = fit_wordmark(wm_w, wm_color)
    gap = int(canvas_w * 0.06)
    content_h = mark_s + gap + wm.height
    canvas_h = content_h + 2 * pad if not sq else canvas_w
    img = Image.new("RGBA", (canvas_w, canvas_h), bg_rgb + (255,) if bg_rgb else (0, 0, 0, 0))
    top = (canvas_h - content_h) // 2
    m = mark_img.resize((mark_s, mark_s), Image.LANCZOS)
    img.paste(m, ((canvas_w - mark_s) // 2, top), m if m.mode == "RGBA" else None)
    img.alpha_composite(wm, ((canvas_w - wm.width) // 2, top + mark_s + gap))
    return img


def horizontal(bg_rgb, wm_color, mark_img):
    h = 520
    pad = int(h * 0.16)
    mark_s = h - 2 * pad
    wm_w = int(mark_s * 2.05)
    wm = fit_wordmark(wm_w, wm_color)
    gap = int(h * 0.10)
    w = pad + mark_s + gap + wm.width + pad
    img = Image.new("RGBA", (w, h), bg_rgb + (255,) if bg_rgb else (0, 0, 0, 0))
    m = mark_img.resize((mark_s, mark_s), Image.LANCZOS)
    img.paste(m, (pad, pad), m if m.mode == "RGBA" else None)
    img.alpha_composite(wm, (pad + mark_s + gap, (h - wm.height) // 2))
    return img

# Navy full-bleed family (seamless — same navy as the figure sits on)
prim = primary(NAVY, "white", mark_rgb)
save(prim, "primary", "logo-primary.png")
save(prim, "primary", "logo-primary.webp")
save(prim, "primary", "logo-primary.jpg")

horiz = horizontal(NAVY, "white", mark_rgb)
save(horiz, "horizontal", "logo-horizontal.png")
save(horiz, "horizontal", "logo-horizontal.webp")
# transparent horizontal: rounded mark + wordmark on transparent
horiz_t = horizontal(None, "white", mark_rounded)
save(horiz_t, "horizontal", "logo-horizontal-transparent.png")

sq = primary(NAVY, "white", mark_rgb, sq=True)
save(sq, "square", "logo-square.png")
save(sq, "square", "logo-square.webp")

# On-light card: navy rounded badge + dark wordmark
on_light = primary(LIGHT_CARD, "dark", mark_rounded)
save(on_light, "on-light", "logo-on-light.png")
save(on_light, "on-light", "logo-on-light.webp")

# On-dark card: brand dark bg + rounded mark + white wordmark
on_dark = primary(BRAND_DARK, "white", mark_rounded)
save(on_dark, "on-dark", "logo-on-dark.png")
save(on_dark, "on-dark", "logo-on-dark.webp")

# --------------------------------------------------------------------------- #
# 5b. Full logo as a single scalable SVG (vector wordmark + embedded mark PNG)
# --------------------------------------------------------------------------- #
def full_svg():
    buf = io.BytesIO()
    mark_rounded.resize((512, 512), Image.LANCZOS).save(buf, "PNG")
    mark_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    # reuse wordmark svg geometry at S=100
    S = 100.0
    f = _font(int(S))
    d = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
    pre_w = d.textbbox((0, 0), PRE, font=f)[2]
    bl, bt, br, bb = d.textbbox((0, 0), BOX, font=f)
    box_w, box_h = br - bl, bb - bt
    asc, desc = f.getmetrics()
    gap = S * 0.20
    pad_x, pad_y = S * 0.22, S * 0.14
    tile_x = pre_w + gap
    tile_w = box_w + 2 * pad_x
    tile_h = box_h + 2 * pad_y
    wm_w = tile_x + tile_w
    wm_h = asc + desc
    # layout: mark (W units) centered, wordmark below scaled to width
    markW = 360.0
    scale = (markW * 0.62) / wm_w
    wmW, wmH = wm_w * scale, wm_h * scale
    vgap = 28
    totalW = markW
    totalH = markW + vgap + wmH
    wm_x = (totalW - wmW) / 2
    wm_y = markW + vgap
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {totalW:.0f} {totalH:.0f}" role="img" aria-label="David Bond TV">
  <defs><style>
    @font-face {{ font-family:"Pixelify Sans"; src:url(data:font/woff2;base64,{FONT_B64}) format("woff2"); font-weight:700; }}
    .wm {{ font-family:"Pixelify Sans",Arial,sans-serif; font-weight:700; font-size:{S:.0f}px; }}
  </style></defs>
  <image x="0" y="0" width="{markW:.0f}" height="{markW:.0f}" href="data:image/png;base64,{mark_b64}"/>
  <g transform="translate({wm_x:.1f},{wm_y:.1f}) scale({scale:.4f})">
    <text class="wm" x="0" y="{asc:.1f}" fill="{hexc(WHITE)}">{PRE}</text>
    <rect x="{tile_x:.1f}" y="{asc + bt - pad_y:.1f}" width="{tile_w:.1f}" height="{tile_h:.1f}" rx="{tile_h*0.24:.1f}" fill="{hexc(ACCENT)}"/>
    <text class="wm" x="{tile_x + pad_x - bl:.1f}" y="{asc:.1f}" fill="{hexc(WHITE)}">{BOX}</text>
  </g>
</svg>
'''
    save_text(svg, "full", "logo-full.svg")

full_svg()

# --------------------------------------------------------------------------- #
# 6. Icons / favicons
# --------------------------------------------------------------------------- #
icon_base = mark_rounded   # rounded, transparent corners

def icon(size):
    return icon_base.resize((size, size), Image.LANCZOS)

for s in (16, 32, 48):
    save(icon(s), "icon", f"favicon-{s}.png")
save(mark_rgb.resize((180, 180), Image.LANCZOS), "icon", "apple-touch-icon.png")  # opaque (Apple)
save(icon(192), "icon", "icon-192.png")
save(icon(512), "icon", "icon-512.png")

# maskable: figure centered inside the 80% safe zone on full-bleed navy
mask512 = Image.new("RGBA", (512, 512), NAVY + (255,))
inner = mark_rgb.resize((410, 410), Image.LANCZOS)
mask512.paste(inner, (51, 51))
save(mask512, "icon", "maskable-512.png")

# multi-resolution .ico
ico_path = out("icon", "favicon.ico")
icon_base.resize((48, 48), Image.LANCZOS).save(
    ico_path, sizes=[(16, 16), (32, 32), (48, 48)])
MANIFEST.append("icon/favicon.ico")

manifest_json = {
    "name": "David Bond TV",
    "short_name": "David Bond TV",
    "icons": [
        {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"},
        {"src": "/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ],
    "theme_color": hexc(BRAND_DARK),
    "background_color": hexc(BRAND_DARK),
    "display": "standalone",
}
save_text(json.dumps(manifest_json, indent=2), "icon", "site.webmanifest")

# --------------------------------------------------------------------------- #
# 7. Contact sheet for quick review
# --------------------------------------------------------------------------- #
def contact_sheet():
    cells = [
        ("primary (navy)", prim, NAVY),
        ("horizontal", horiz, NAVY),
        ("square", sq, NAVY),
        ("on-light", on_light, LIGHT_CARD),
        ("on-dark", on_dark, BRAND_DARK),
        ("mark rounded", mark_rounded, (40, 44, 60)),
        ("mark circle", mark_circle, (40, 44, 60)),
        ("favicon 192 (transparent)", icon(192), LIGHT_CARD),
        ("wordmark", wm_white, (40, 44, 60)),
    ]
    cols, cell, padc = 3, 440, 24
    label_h = 30
    rows = (len(cells) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * (cell + label_h)), (18, 20, 30))
    d = ImageDraw.Draw(sheet)
    lf = _font(20)
    for i, (label, im, swatch) in enumerate(cells):
        cx = (i % cols) * cell
        cy = (i // cols) * (cell + label_h)
        d.rectangle((cx, cy, cx + cell, cy + cell), fill=swatch)
        if im is not None:
            box = cell - 2 * padc
            t = im.copy()
            t.thumbnail((box, box), Image.LANCZOS)
            ox = cx + (cell - t.width) // 2
            oy = cy + (cell - t.height) // 2
            sheet.paste(t.convert("RGBA"), (ox, oy), t.convert("RGBA"))
        d.text((cx + 10, cy + cell + 6), label, font=lf, fill=(210, 216, 230))
    save(sheet, "contact-sheet.png")

contact_sheet()

# --------------------------------------------------------------------------- #
# Summary
# --------------------------------------------------------------------------- #
print("\nGenerated %d files:" % len(MANIFEST))
for p in sorted(set(MANIFEST)):
    print("  ", p)
print("\nDone.")
