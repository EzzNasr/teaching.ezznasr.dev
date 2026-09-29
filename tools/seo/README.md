# SEO tooling

One config file, one command.

    tools/seo/seo_config.json   <- site name, url, per-page titles/descriptions, social links
    python tools/seo/seo_build.py          # stamp every page + sitemap.xml + robots.txt + manifest
    python tools/seo/seo_build.py --check  # dry run
    python tools/seo/seo_build.py --og     # redraw icons/og-default.png (needs Pillow)

## Change the site name
Edit `"site_name"` in `seo_config.json`, run `seo_build.py`, commit. Titles, Open Graph,
JSON-LD, the web manifest and every generated lesson pick it up.
(`site_alt_names` is a hand-kept list of aliases - leave the old name there on purpose after a rename.)
Run `--og` too so the share image shows the new name.

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
