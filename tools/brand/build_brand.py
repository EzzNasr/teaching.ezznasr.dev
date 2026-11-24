#!/usr/bin/env python3
"""
build_brand.py - draw every brand image from the logo SVGs in assets/brand/.

    python tools/brand/build_brand.py

Source of truth (hand-made, keep these in git):
    assets/brand/handasa-mark.svg        the logo (navy tile, white «هـ», amber arc)
    assets/brand/handasa-mark-dark.svg   same on the lighter blue used in dark mode
    assets/brand/handasa-maskable.svg    full-bleed square with the art in the safe zone (Android)
    assets/brand/handasa-glyph.svg       the bare letter + arc (currentColor), for inline use

The «هـ» outline is the real glyph from the Cairo font (SIL Open Font Licence),
ExtraBold, converted to a path, so no page needs the font to show the logo.

Writes (all generated, safe to re-run):
    icons/favicon.svg, icons/favicon.ico (16/32/48), icons/favicon-16.png, icons/favicon-32.png,
    icons/apple-touch-icon.png (180, square: iOS rounds it), icons/favicon-192.png,
    icons/favicon-512.png, icons/maskable-512.png, icons/og-handasa.png (1200x630 share card)

Needs Playwright (Chromium) and Pillow, both already used by the test suite.
The share card loads Cairo/Manrope from Google Fonts, so run it online.
"""
import io
import json
import os
import pathlib
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
BRAND = ROOT / "assets" / "brand"
ICONS = ROOT / "icons"
SEO = json.loads((ROOT / "tools" / "seo" / "seo_config.json").read_text(encoding="utf-8"))


def svg(name):
    return (BRAND / name).read_text(encoding="utf-8")


def page_for(svg_text, size):
    sized = svg_text.replace("<svg ", '<svg width="{0}" height="{0}" '.format(size), 1)
    return ("<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:transparent}"
            "svg{display:block}</style>" + sized)


def render(pg, html, w, h):
    pg.set_viewport_size({"width": w, "height": h})
    pg.set_content(html, wait_until="networkidle")
    pg.wait_for_timeout(150)
    return pg.screenshot(omit_background=True, clip={"x": 0, "y": 0, "width": w, "height": h})


def og_card_html():
    mark = svg("handasa-mark.svg").replace("<svg ", '<svg width="148" height="148" ', 1)
    tagline = SEO.get("og_tagline", "")
    host = SEO["site_url"].replace("https://", "")
    return """<!doctype html><meta charset=utf-8>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@700;800&family=Manrope:wght@600;800&display=swap" rel="stylesheet">
<style>
html,body{margin:0}
.c{width:1200px;height:630px;box-sizing:border-box;padding:84px 90px;color:#fff;position:relative;overflow:hidden;
   background:radial-gradient(900px 520px at 100% 100%,#1d4f91 0%,transparent 70%),linear-gradient(135deg,#0e2240 0%,#0b1a33 100%);
   font-family:Manrope,sans-serif}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(95,182,255,.09) 1px,transparent 1px),
   linear-gradient(90deg,rgba(95,182,255,.09) 1px,transparent 1px);background-size:40px 40px}
.arc{position:absolute;right:-160px;bottom:-330px;width:760px;height:760px;border-radius:50%;border:3px solid rgba(242,169,59,.55)}
.row{position:relative;display:flex;align-items:center;gap:34px}
.row svg{border-radius:34px;box-shadow:0 0 0 2px rgba(255,255,255,.12)}
.en{font-weight:800;font-size:104px;letter-spacing:-.02em;line-height:1}
.ar{font-family:Cairo,sans-serif;font-weight:800;font-size:64px;line-height:1.1;color:#f2a93b}
.tag{position:relative;margin-top:62px;font-weight:600;font-size:40px;color:#dbe7ff}
.host{position:absolute;left:90px;bottom:62px;font-weight:600;font-size:28px;color:#9fb7dd}
</style>
<div class="c"><div class="grid"></div><div class="arc"></div>
<div class="row">@MARK@<div><div class="en">Handasa</div><div class="ar">هندسة</div></div></div>
<div class="tag">@TAG@</div><div class="host">@HOST@</div></div>""".replace("@MARK@", mark).replace("@TAG@", tagline).replace("@HOST@", host)


def main():
    ICONS.mkdir(exist_ok=True)
    mark = svg("handasa-mark.svg")
    square = mark.replace('rx="15"', 'rx="0"')         # iOS applies its own corner mask
    maskable = svg("handasa-maskable.svg")
    (ICONS / "favicon.svg").write_text(mark, encoding="utf-8", newline="\n")

    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(device_scale_factor=1)
        out = {}
        for n in (16, 32, 48, 192, 512):
            out[n] = render(pg, page_for(mark, n), n, n)
        apple = render(pg, page_for(square, 180), 180, 180)
        mask = render(pg, page_for(maskable, 512), 512, 512)
        og = render(pg, og_card_html(), 1200, 630)
        b.close()

    def save(png, name):
        Image.open(io.BytesIO(png)).save(ICONS / name, optimize=True)

    save(out[16], "favicon-16.png")
    save(out[32], "favicon-32.png")
    save(out[192], "favicon-192.png")
    save(out[512], "favicon-512.png")
    save(apple, "apple-touch-icon.png")
    save(mask, "maskable-512.png")
    Image.open(io.BytesIO(og)).convert("RGB").save(ICONS / "og-handasa.png", optimize=True)
    big = Image.open(io.BytesIO(out[48])).convert("RGBA")
    big.save(ICONS / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)],
             append_images=[Image.open(io.BytesIO(out[n])).convert("RGBA") for n in (16, 32)])
    for f in sorted(ICONS.iterdir()):
        print("  {:<24} {:>7} bytes".format(f.name, f.stat().st_size))
    return 0


if __name__ == "__main__":
    sys.exit(main())
