# SEO tooling

One config file, one command.

    tools/seo/seo_config.json   <- site name, url, per-page titles/descriptions, social links
    python tools/seo/seo_build.py          # stamp every page (SEO + BRAND blocks) + sitemap.xml + robots.txt + manifest
    python tools/seo/seo_build.py --check  # dry run
    python tools/brand/build_brand.py      # redraw icons + share card from assets/brand/*.svg (Playwright)

## Change the site name
Edit `"site_name"` in `seo_config.json`, run `seo_build.py`, commit. Titles, Open Graph,
JSON-LD, the web manifest and every generated lesson pick it up.
(`site_alt_names` is a hand-kept list of aliases - leave the old name there on purpose after a rename.)
Run `python tools/brand/build_brand.py` too so the share card shows the new name.

## Change the domain
Edit `"site_url"` only, run `seo_build.py`. Canonicals, Open Graph, JSON-LD, sitemap and robots follow.
(Also update `CNAME` and the GitHub Pages setting.)

## Brand block
Every page, private ones included, also gets a `<!-- BRAND:START -->` block (favicon .ico/.svg,
apple-touch icon, manifest, theme-color, `/assets/brand.css`). Logo sources: `assets/brand/*.svg`.
The header/footer lockup markup was swapped once by `tools/brand/apply_brand.py`; the Quiz Maker
templates carry it for new pages.

## What is indexed
| Page type | Robots | In sitemap |
|---|---|---|
| Home, subject pages, grade pages, lesson pages | index, follow | yes |
| quiz.html, assignment.html | noindex, follow | no |
| dashboard/*, 404.html | noindex, nofollow (+ `Disallow: /dashboard/`) | no |

Flip `index_quiz_pages` / `index_assignment_pages` in the config if you ever want them indexed.

## Descriptions
* A lesson's meta description = what you type in the Quiz Maker's description box (the same text shown under the lesson title).
* If it is empty or short, a sentence is generated from the section and question count.
* Per-page hand-written copy: add the URL under `"overrides"` in the config.

The Quiz Maker and Assignment Maker run `seo_build.py` automatically after saving, so new lessons are never published un-stamped.
Each stamped page holds one block between `<!-- SEO:START -->` and `<!-- SEO:END -->` - never edit inside it.
