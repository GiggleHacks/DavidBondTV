#!/usr/bin/env python3
"""
Build David Bond TV brand assets from avatar.jpg (the text-free pixel-art bust).

Outputs:
  public/brand/mark.png         256x256 square mascot tile (header lockup + avatar source)
  public/favicon-16.png         favicon (small)
  public/favicon-32.png         favicon
  public/favicon-48.png         favicon (large)
  public/apple-touch-icon.png   180x180 iOS home-screen icon
  public/icon-192.png           PWA icon
  public/icon-512.png           PWA icon
  public/favicon.ico            multi-size .ico (16/32/48)
  public/avatars/david-bond.svg avatar that embeds the 256px PNG (keeps the .svg pipeline)

Run from the repo root:  python scripts/build-brand-assets.py
"""

import base64
import io
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "avatar.jpg")
PUBLIC = os.path.join(ROOT, "public")
BRAND = os.path.join(PUBLIC, "brand")
AVATARS = os.path.join(PUBLIC, "avatars")


def square_crop(im):
    """Centered square crop of the figure (full height, centered horizontally)."""
    w, h = im.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return im.crop((left, top, left + side, top + side))


def resize(im, size):
    # LANCZOS keeps the chunky pixel blocks clean when downscaled for UI use.
    return im.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(BRAND, exist_ok=True)
    os.makedirs(AVATARS, exist_ok=True)

    base = square_crop(Image.open(SRC).convert("RGB"))

    # Master 256px tile — header mark + avatar source.
    mark = resize(base, 256)
    mark_path = os.path.join(BRAND, "mark.png")
    mark.save(mark_path, "PNG")

    # Favicons / app icons.
    sizes = {
        "favicon-16.png": 16,
        "favicon-32.png": 32,
        "favicon-48.png": 48,
        "apple-touch-icon.png": 180,
        "icon-192.png": 192,
        "icon-512.png": 512,
    }
    for name, size in sizes.items():
        resize(base, size).save(os.path.join(PUBLIC, name), "PNG")

    # Multi-size .ico.
    resize(base, 48).save(
        os.path.join(PUBLIC, "favicon.ico"),
        sizes=[(16, 16), (32, 32), (48, 48)],
    )

    # Avatar SVG embedding the 256px PNG as a data URI (drops into the .svg pipeline).
    buf = io.BytesIO()
    mark.save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" '
        'viewBox="0 0 256 256">'
        '<image width="256" height="256" href="data:image/png;base64,' + b64 + '"/>'
        "</svg>\n"
    )
    with open(os.path.join(AVATARS, "david-bond.svg"), "w", encoding="utf-8") as f:
        f.write(svg)

    print("Brand assets written:")
    for p in [
        mark_path,
        *[os.path.join(PUBLIC, n) for n in sizes],
        os.path.join(PUBLIC, "favicon.ico"),
        os.path.join(AVATARS, "david-bond.svg"),
    ]:
        print("  ", os.path.relpath(p, ROOT), f"({os.path.getsize(p)} bytes)")


if __name__ == "__main__":
    main()
