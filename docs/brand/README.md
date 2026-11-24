# Handasa · هندسة brand

Chosen by the owner on 2026-11-24 (Telegram). The sheets here are the record of that choice:

| File | What |
|---|---|
| `1-logo-concepts.png` | the three first ideas: A compass, B construction H, **C Arabic «هـ» (chosen)** |
| `2-colour-themes.png` | three palettes, light and dark: **1 Blueprint (chosen)**, 2 Drafting, 3 Teal ink |
| `3-logo-refinements.png` | hand-drawn redraws of C; the owner kept the real letter instead |
| `4-final-logo.png` | the final logo at every size, light and dark, plus the Android round icon |

## Where the files live

| Path | What |
|---|---|
| `assets/brand/handasa-mark.svg` | the logo (navy tile, white «هـ», amber arc) — source of truth |
| `assets/brand/handasa-mark-dark.svg` | the same on #1d4f91 for dark mode (brand.css swaps it in) |
| `assets/brand/handasa-maskable.svg` | full-bleed square for Android |
| `assets/brand/handasa-glyph.svg` | the bare letter + arc in currentColor |
| `assets/brand.css` | header lockup, footer credit, `--brand-*` colour tokens |
| `icons/` | favicon .ico/.svg, 16/32/180/192/512 PNGs, maskable, `og-handasa.png` share card, `site.webmanifest` |
| `tools/brand/build_brand.py` | redraws everything in `icons/` from the SVGs |
| `tools/brand/apply_brand.py` | the one-off page swap (idempotent) |
| `tools/brand/source/` | how the «هـ» outline was taken from the Cairo font, and the script that draws the SVGs |
| `tools/seo/seo_config.json` | name, short name, aliases, author «Eng. EzzNasr», theme colour, share image |

Colours: navy `#0e2240`, blue `#2563eb` (the site accent family), sky `#5fb6ff`, amber `#f2a93b`.
Fonts: Manrope (Latin) and Cairo (Arabic), both already loaded by the pages.
