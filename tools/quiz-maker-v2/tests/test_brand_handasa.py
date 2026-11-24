#!/usr/bin/env python3
"""R-BRAND-1: the Handasa · هندسة rebrand reaches every page. No browser, no tkinter.

Every site page: exactly one BRAND block (favicon .ico + .svg, apple-touch icon, manifest, theme-color,
/assets/brand.css) and no loose icon/manifest links outside it; every <title> carries the brand (attendance
pages excepted: they show Alexandria University's own system name); stamped pages have og:site_name,
og:image = the Handasa share card and the Organization logo; every page with a header shows the logo
(attendance excepted); none shows the old brand ("EZZ NASR · TEACHING", "Teaching Portal", "Ezz Nasr : Teaching").
The manifest names Handasa, lists its icons and colours, and every icon file exists at its stated size.
sitemap.xml parses and only lists the configured site_url; robots.txt points at it. The Quiz Maker's
templates carry the logo lockup and {{SITE_NAME}} titles, common.site_name() is the config's name,
i18n strings use «{0} — Handasa», seo_build.py --check and apply_brand.py --dry change nothing."""
import io
import json
import os
import re
import subprocess
import sys
import xml.dom.minidom

HERE = os.path.dirname(os.path.abspath(__file__))
QM = os.path.abspath(os.path.join(HERE, ".."))
SITE = os.path.abspath(os.path.join(QM, "..", ".."))
sys.path.insert(0, QM)
sys.path.insert(0, os.path.join(SITE, "tools", "seo"))
from modules import common as c   # noqa: E402
import seo_build                  # noqa: E402

fails = 0


def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)[:600]))
    fails += 0 if ok else 1


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


CFG = json.loads(read(os.path.join(SITE, "tools", "seo", "seo_config.json")))
NAME = CFG["site_name"]
check("config: site name is «Handasa · هندسة», short name Handasa", NAME == "Handasa · هندسة" and CFG.get("short_name") == "Handasa", NAME)
check("config: share image is the Handasa card", CFG["og_image"] == "/icons/og-handasa.png")

pages = [p for p in seo_build.walk_pages(SITE) if not p.startswith("tests/")]
check("found the site's pages", len(pages) > 150, len(pages))

OLD = re.compile(r"EZZ NASR|Teaching Portal|Ezz Nasr : Teaching|Ezz Nasr · Teaching")
BRAND_BLOCK = re.compile(r"<!-- BRAND:START.*?<!-- BRAND:END -->", re.S)
NEED = ['<link rel="icon" href="/icons/favicon.ico"', '<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml">',
        '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">', '<link rel="manifest" href="/icons/site.webmanifest">',
        '<meta name="theme-color"', '<link rel="stylesheet" href="/assets/brand.css">']
LOOSE = re.compile(r'<link\s+rel="(?:shortcut )?icon"|<link\s+rel="apple-touch-icon"|<link\s+rel="manifest"|<meta\s+name="theme-color"')

bad = {"block": [], "loose": [], "title": [], "og": [], "logo": [], "old": []}
for rel in pages:
    html = read(os.path.join(SITE, rel))
    head = re.search(r"<head[^>]*>(.*?)</head>", html, re.S | re.I)
    head = head.group(1) if head else ""
    blocks = BRAND_BLOCK.findall(head)
    if len(blocks) != 1 or not all(n in blocks[0] for n in NEED):
        bad["block"].append(rel)
    if LOOSE.search(BRAND_BLOCK.sub("", head)):
        bad["loose"].append(rel)
    attend = rel.startswith("attend/")
    title = re.search(r"<title>(.*?)</title>", head, re.S)
    import html as _h
    t = _h.unescape(title.group(1)) if title else ""
    too_long = len(t + CFG["title_separator"] + CFG["short_name"]) > CFG["title_target_max"]   # SEO rule: no room
    if not attend and (not title or ("Handasa" not in t and not too_long)):
        bad["title"].append((rel, title.group(1) if title else None))
    if "<!-- SEO:START" in head and "<title>" in head.split("<!-- SEO:END")[0]:
        if ('<meta property="og:site_name" content="{}">'.format(NAME) not in head
                or "/icons/og-handasa.png" not in head
                or ('"LearningResource"' in head and "/icons/favicon-512.png" not in head)):
            bad["og"].append(rel)
    if not attend and "<header" in html and "/assets/brand/handasa-mark.svg" not in html:
        bad["logo"].append(rel)
    visible = re.sub(r'<script type="application/ld\+json">.*?</script>', "", html, flags=re.S)
    if OLD.search(visible):
        bad["old"].append((rel, OLD.search(visible).group(0)))

check("every page has one complete BRAND block in <head>", not bad["block"], bad["block"])
check("no loose icon / manifest / theme-color links outside it", not bad["loose"], bad["loose"])
check("every <title> carries Handasa unless the name alone fills the 65-char budget (attendance excepted)", not bad["title"], bad["title"])
check("stamped pages: og:site_name and the Handasa share card; lessons name the Organization with its logo", not bad["og"], bad["og"])
check("every page with a header shows the logo (attendance excepted)", not bad["logo"], bad["logo"])
check("no page shows the old brand", not bad["old"], bad["old"])

home = read(os.path.join(SITE, "index.html"))
ld = json.loads(re.search(r'<script type="application/ld\+json">(.*?)</script>', home, re.S).group(1))
org = [n for n in ld["@graph"] if n.get("@type") == "Organization"]
check("home JSON-LD: Organization Handasa with logo, founded by the author",
      org and org[0]["name"] == NAME and org[0]["logo"].endswith("/icons/favicon-512.png")
      and org[0].get("founder", {}).get("@id", "").endswith("#person"), org)
person = [n for n in ld["@graph"] if n.get("@type") == "Person"]
check("home JSON-LD: the author is «Eng. EzzNasr» (plain spellings as aliases)",
      person and person[0]["name"] == "Eng. EzzNasr" and "EzzNasr" in person[0].get("alternateName", []), person)
old_credit = [p for p in pages if "by Ezz Nasr" in read(os.path.join(SITE, p))]
check("footer credit reads «by Eng. EzzNasr» everywhere", not old_credit, old_credit)
authors = [p for p in pages if '<meta name="author"' in read(os.path.join(SITE, p))
           and '<meta name="author" content="Eng. EzzNasr">' not in read(os.path.join(SITE, p))]
check("every author meta tag says Eng. EzzNasr", not authors, authors)
site_node = [n for n in ld["@graph"] if n.get("@type") == "WebSite"]
check("home JSON-LD: WebSite published by the Organization",
      site_node and site_node[0]["publisher"]["@id"].endswith("#organization"))

# manifest + icon files
man = json.loads(read(os.path.join(SITE, "icons", "site.webmanifest")))
check("manifest: name, short_name, colours", man["name"] == NAME and man["short_name"] == "Handasa"
      and man["theme_color"] == CFG["theme_color"] and man["background_color"], man)
check("manifest: has a maskable icon", any(i.get("purpose") == "maskable" for i in man["icons"]), man["icons"])
try:
    from PIL import Image
except ImportError:
    Image = None
for icon in man["icons"] + [{"src": "/icons/apple-touch-icon.png", "sizes": "180x180"},
                            {"src": "/icons/favicon-32.png", "sizes": "32x32"},
                            {"src": "/icons/favicon-16.png", "sizes": "16x16"},
                            {"src": "/icons/og-handasa.png", "sizes": "1200x630"}]:
    path = os.path.join(SITE, icon["src"].lstrip("/"))
    ok = os.path.exists(path)
    if ok and Image is not None and icon["sizes"] != "any":
        w, h = map(int, icon["sizes"].split("x"))
        ok = Image.open(path).size == (w, h)
    check("icon {} exists at {}".format(icon["src"], icon["sizes"]), ok)
ico = os.path.join(SITE, "icons", "favicon.ico")
check("favicon.ico holds 16, 32 and 48 px", Image is None or
      {(16, 16), (32, 32), (48, 48)} <= set(Image.open(ico).info.get("sizes", set())))
for f in ("handasa-mark.svg", "handasa-mark-dark.svg", "handasa-maskable.svg", "handasa-glyph.svg"):
    svg = read(os.path.join(SITE, "assets", "brand", f))
    check("logo " + f + " is a self-contained SVG (no fonts, no external refs)",
          svg.startswith("<svg") and "<text" not in svg and "href" not in svg and "font-family" not in svg)
check("brand.css swaps in the dark-mode logo", "handasa-mark-dark.svg" in read(os.path.join(SITE, "assets", "brand.css")))

# sitemap / robots
sm = xml.dom.minidom.parse(os.path.join(SITE, "sitemap.xml"))
locs = [n.firstChild.data for n in sm.getElementsByTagName("loc")]
check("sitemap.xml parses and lists only site_url pages", locs and all(l.startswith(CFG["site_url"] + "/") for l in locs), len(locs))
check("robots.txt points at the sitemap", "Sitemap: {}/sitemap.xml".format(CFG["site_url"]) in read(os.path.join(SITE, "robots.txt")))

# Quiz Maker
tpl_dir = os.path.join(QM, "templates")
for t in ("lesson_index.html", "quiz.html", "assignment.html", "subject_index.html"):
    s = read(os.path.join(tpl_dir, t))
    check("template {}: logo lockup, {{SITE_NAME}} title, no old brand".format(t),
          "/assets/brand/handasa-mark.svg" in s and "| {{SITE_NAME}}</title>" in s and not OLD.search(s))
check("common.site_name() is the config's name", c.site_name() == NAME, c.site_name())
check("Quiz Maker window says Handasa", "Handasa" in read(os.path.join(QM, "app_main.py")))

# i18n
for f in ("i18n.js", "i18n/my-lessons.js", "i18n/my-revenue.js", "i18n/my-team.js"):
    s = read(os.path.join(SITE, "assets", f))
    check("assets/{}: title pattern is «{{0}} — Handasa»".format(f), "{0} — Handasa" in s and not OLD.search(s))

# generators agree with what is committed
stats = seo_build.run(SITE, check=True, quiet=True)
check("seo_build.py --check: every page already up to date", stats["changed"] == 0, stats)
out = subprocess.run([sys.executable, os.path.join(SITE, "tools", "brand", "apply_brand.py"), "--dry"],
                     capture_output=True, text=True, encoding="utf-8")
check("apply_brand.py --dry: nothing left to swap", " 0 would change" in out.stdout, out.stdout + out.stderr)

print("\n{} failure(s)".format(fails))
sys.exit(1 if fails else 0)
