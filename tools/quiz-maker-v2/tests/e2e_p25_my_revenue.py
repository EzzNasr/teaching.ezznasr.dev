#!/usr/bin/env python3
"""R-P25-F-PAGE: the teacher's revenue page dashboard/my-revenue.html (?mock=1), in a real browser (Phase 2.5 F).
Cards (students, courses, lessons, purchases, total sales) > course list > course page (lesson, price, videos, visible)
> lesson page (videos, sales, latest purchases). One "Download report" button gives two files: a self-contained HTML
balance sheet (summary, per course, per lesson, every purchase; prints to A4 without cutting rows) and a CSV of the
purchases (Excel-safe: BOM, no formulas). Names and titles are shown as text, never as HTML. Read only: no write
action is ever called. 390 px and 1280 px, light and dark, Arabic and English, no sideways scroll."""
import os, sys, threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("SKIP: playwright is not installed")
    sys.exit(0)
from _hermetic import seal   # noqa: E402

fails = 0
def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)[:400]))
    fails += 0 if ok else 1

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=REPO))
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % srv.server_address[1]
URL = base + "/dashboard/my-revenue.html?mock=1"

with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, dark in ((390, False), (390, True), (1280, False)):
        tag = "%dpx %s: " % (width, "dark" if dark else "light")
        ctx = browser.new_context(viewport={"width": width, "height": 900}, color_scheme="dark" if dark else "light", accept_downloads=True)
        seal(ctx, allow=(base,))
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(URL)
        pg.wait_for_selector("#mr-cards")
        cards = pg.inner_text("#mr-cards")
        check(tag + "five cards with the numbers", all(w in cards for w in ("الطلاب", "الكورسات", "الدروس", "المشتريات", "إجمالي المبيعات", "34", "290")), cards)
        check(tag + "pending purchases are mentioned, not counted", "1 مستنية موافقة" in cards)
        check(tag + "two courses listed", pg.locator("#mr-courses li").count() == 2)
        check(tag + "no sideways scroll (overview)", pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
        pg.locator("#mr-courses li a").nth(0).click()
        pg.wait_for_function("location.hash.indexOf('#/course/') === 0 && document.querySelector('.m-crumbs').children.length === 3")
        txt = pg.inner_text("main")
        check(tag + "a lesson title with markup is shown as text, not as HTML", "<b>&</b>" in txt and pg.locator("main b").count() == 0, txt[:200])
        pg.goto(URL + "#/course/" + "science%2Fsecondary%2Fgrade-1-secondary")
        pg.wait_for_selector("table.m-table a")
        txt = pg.inner_text("main")
        check(tag + "course page: lessons with price, videos and visible", "Energy" in txt and "60 ج.م" in txt and "مخفي" in txt and "أيوه" in txt, txt[:300])
        check(tag + "course page: breadcrumb back to all courses", pg.locator(".m-crumbs a[href='#/']").count() == 1)
        check(tag + "no sideways scroll (course)", pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
        pg.locator("table.m-table a").first.click()
        pg.wait_for_function("location.hash.indexOf('#/lesson/') === 0 && document.querySelector('.m-crumbs').children.length === 5")
        txt = pg.inner_text("main")
        check(tag + "lesson page: videos, sales and its latest purchases", "الفيديوهات" in txt and "120 ج.م" in txt and "Omar Ali" in txt and "Lamis Adel" in txt and "Sara Mahmoud" not in txt, txt[:400])
        pg.goto(URL + "#/course/" + "math%2Fx")
        pg.wait_for_selector(".m-state.err")
        check(tag + "a course outside his subjects says so", "مش من موادك" in pg.inner_text("main"))
        pg.goto(URL)
        pg.wait_for_selector("#mr-cards")
        if width == 1280 and not dark:
            with pg.expect_download() as d1:
                pg.click("#mr-download")
            first = d1.value
            with pg.expect_download() as d2:
                pass
            second = d2.value
            names = sorted([first.suggested_filename, second.suggested_filename])
            check("download: two files, the report and the purchases", names[0].startswith("purchases-") and names[0].endswith(".csv") and names[1].startswith("revenue-report-") and names[1].endswith(".html"), names)
            rep = pg.evaluate("window.__lastReport")
            html, csv = rep["html"], rep["csv"]
            check("report: self-contained (no outside scripts, styles or images)", "<script" not in html and "<link" not in html and "src=" not in html)
            check("report: summary, per course, per lesson and every purchase", all(w in html for w in ("الملخص", "حسب الكورس", "كل المشتريات", "إجمالي الكورس", "290 ج.م")) and html.count("Sara Mahmoud") == 1 and html.count("<tr>") >= 12)
            check("report: names and titles are escaped, never markup", "&lt;b&gt;&amp;&lt;/b&gt;" in html and "<b>&</b>" not in html)
            check("report: A4 print rules, rows never split", "@page{size:A4" in html and "page-break-inside:avoid" in html)
            check("csv: BOM for Excel, one header and five purchases", csv.startswith("﻿") and len([l for l in csv.split("\r\n") if l]) == 6, csv[:200])
            check("csv: a name that looks like a formula is made plain text", "'=HYPERLINK" in csv)
            rp = ctx.new_page()
            rp.set_content(html)
            rp.emulate_media(media="print")
            check("report: opens on its own and hides the print hint when printing", rp.locator(".noprint").is_hidden() and "تقرير الإيرادات" in rp.inner_text("h1"))
            pdf = rp.pdf(format="A4")
            check("report: prints to a PDF", len(pdf) > 5000 and pdf[:4] == b"%PDF", len(pdf))
            rp.close()
            # English mode
            pg.evaluate("window.I18n.set('en')")
            pg.wait_for_function("document.documentElement.lang === 'en'")
            t = pg.inner_text("main")
            check("English: cards and button translated", "Total sales" in t and "Download report" in t and "Latest purchases" in t, t[:300])
            rep_en = pg.evaluate("(function(){document.getElementById('mr-download').click();return window.__lastReport.html;})()")
            check("English: the report follows the page language", 'lang="en"' in rep_en and "Revenue report" in rep_en and 'dir="ltr"' in rep_en)
            pg.evaluate("window.I18n.set('ar')")
        check(tag + "no script errors", not errors, errors)
        ctx.close()
    # read only: the page source calls one action, the report
    src = open(os.path.join(REPO, "dashboard", "my-revenue.html"), encoding="utf-8").read()
    import re
    acts = set(re.findall(r'action:\s*"([a-z0-9_]+)"', src))
    check("read only: the page calls teacher_revenue_report and nothing else", acts == {"teacher_revenue_report"}, acts)
    guard = open(os.path.join(REPO, "assets", "staff-guard.js"), encoding="utf-8").read()
    check("staff guard: teachers and the owner only", '"my-revenue": ["teacher", "admin"]' in guard)
    browser.close()
srv.shutdown()
sys.exit(1 if fails else 0)
