#!/usr/bin/env python3
"""R-TEACH-1: teacher transition on the home page and the teacher photo on each subject's front page, in a real browser.
Home: clicking a subject card shows the teacher overlay (that subject's photo and name) and then opens the link; Esc
skips it; Enter on a focused card plays it too; prefers-reduced-motion goes straight to the page with no overlay; with
JavaScript off the plain href still works. Subject pages (programming, math, science, english) at 390 and 1280 px,
light and dark: one photo card for that subject, its photo loads and matches assets/teachers.js, beside the cards on
desktop and above them on a phone, Arabic name marked lang=ar dir=rtl, the existing links are still there, no sideways
scroll. Changing the photo in assets/teachers.js alone changes it on the page (one-file swap)."""
import os, sys, threading, time
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
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)[:300]))
    fails += 0 if ok else 1

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=REPO))
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % srv.server_address[1]

SUBJECTS = {
    "programming": {"cards": "#baccalaureate .track-card", "hrefs": ["./baccalaureate/grade-1-secondary/", "./baccalaureate/grade-2-secondary/"]},
    "math": {"cards": "#lessons .lesson-card", "hrefs": []},
    "science": {"cards": "#grades .track-card", "hrefs": ["./preparatory/grade-3-preparatory/", "./secondary/grade-1-secondary/"]},
    "english": {"cards": "#lessons .lesson-card", "hrefs": ["/english/ace-the-interview/"]},
}

def ctx_for(browser, width=1280, dark=False, **kw):
    ctx = browser.new_context(viewport={"width": width, "height": 860}, color_scheme="dark" if dark else "light", **kw)
    seal(ctx, allow=(base,))
    ctx.add_init_script("try{localStorage.setItem('teaching-theme','%s')}catch(e){}" % ("dark" if dark else "light"))
    return ctx

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---------------------------------------------------------------- home: the transition runs
    ctx = ctx_for(browser)
    pg = ctx.new_page()
    pg.goto(base + "/", wait_until="load")
    pg.wait_for_function("!!window.TEACHERS")
    marked = pg.evaluate("[...document.querySelectorAll('a[data-teacher]')].map(a => [a.getAttribute('data-teacher'), a.getAttribute('href')])")
    check("home: the four subject links carry data-teacher and keep their plain href",
          sorted(marked) == sorted([["programming", "/programming/"], ["math", "/math/"], ["science", "/science/"], ["english", "/english/"]]), marked)
    pg.evaluate("document.documentElement.setAttribute('data-teacher-intro-hold','')")
    pg.click("a[data-teacher=science]")
    ov = pg.locator(".ti-overlay.is-on")
    check("home: clicking Science shows the teacher overlay", ov.count() == 1 and ov.get_attribute("data-subject") == "science")
    photo = pg.evaluate("window.TEACHERS.science.photo")
    check("home: the overlay shows the science photo and name",
          pg.locator(".ti-overlay .ti-photo").get_attribute("src") == photo and
          pg.locator(".ti-overlay .ti-name").inner_text() == pg.evaluate("window.TEACHERS.science.name"))
    ms = pg.evaluate("window.__teacherIntro.ms")
    check("home: the transition is short (<= 2 s)", 0 < ms <= 2000, ms)
    pg.wait_for_timeout(ms + 300)
    check("home: when it ends it heads to the card's link", pg.evaluate("window.__teacherIntro.wentTo") == base + "/science/",
          pg.evaluate("window.__teacherIntro"))
    check("home: overlay covers the screen, no sideways scroll", pg.evaluate(
        "(() => { const r = document.querySelector('.ti-overlay').getBoundingClientRect(); return r.width >= innerWidth - 1 && r.height >= innerHeight - 1 && document.documentElement.scrollWidth <= innerWidth + 1 })()"))
    ctx.close()

    # it really navigates
    ctx = ctx_for(browser)
    pg = ctx.new_page()
    pg.goto(base + "/", wait_until="load")
    pg.wait_for_function("!!window.TEACHERS")
    t0 = time.time()
    pg.click("a[data-teacher=programming]")
    pg.wait_for_url(base + "/programming/", timeout=6000)
    check("home: Programming card opens /programming/ after the transition", pg.url == base + "/programming/")
    # Esc skips
    pg.goto(base + "/", wait_until="load")
    pg.wait_for_function("!!window.TEACHERS")
    pg.click("a[data-teacher=math]")
    t0 = time.time()
    pg.keyboard.press("Escape")
    pg.wait_for_url(base + "/math/", timeout=6000)
    check("home: Esc skips the transition", time.time() - t0 < 1.0, time.time() - t0)
    # keyboard: Enter on a focused card
    pg.goto(base + "/", wait_until="load")
    pg.wait_for_function("!!window.TEACHERS")
    pg.evaluate("document.documentElement.setAttribute('data-teacher-intro-hold','')")
    pg.focus("a[data-teacher=english]")
    pg.keyboard.press("Enter")
    check("home: Enter on a focused card plays it too", pg.locator(".ti-overlay.is-on[data-subject=english]").count() == 1)
    ctx.close()

    # ---------------------------------------------------------------- home: it can be skipped entirely
    ctx = ctx_for(browser, reduced_motion="reduce")
    pg = ctx.new_page()
    pg.goto(base + "/", wait_until="load")
    pg.wait_for_function("!!window.TEACHERS")
    t0 = time.time()
    pg.click("a[data-teacher=science]")
    pg.wait_for_url(base + "/science/", timeout=6000)
    check("reduced motion: straight to /science/, no transition", time.time() - t0 < 1.0, time.time() - t0)
    ctx.close()

    ctx = ctx_for(browser, java_script_enabled=False)
    pg = ctx.new_page()
    pg.goto(base + "/", wait_until="load")
    pg.click("a[data-teacher=math]")
    pg.wait_for_url(base + "/math/", timeout=6000)
    check("no JavaScript: the plain link still opens /math/", pg.url == base + "/math/")
    check("no JavaScript: the math page still shows the placeholder photo",
          pg.locator("[data-teacher-slot=math] img[data-teacher-img]").get_attribute("src") == "/assets/teachers/placeholder-math.svg")
    ctx.close()

    # ---------------------------------------------------------------- subject pages: the photo slot
    for width, dark in ((390, False), (390, True), (1280, False), (1280, True)):
        ctx = ctx_for(browser, width, dark)
        pg = ctx.new_page()
        for sub, info in SUBJECTS.items():
            tag = "%s %dpx %s: " % (sub, width, "dark" if dark else "light")
            r = pg.goto(base + "/%s/" % sub, wait_until="load")
            pg.wait_for_function("!!window.TEACHERS")
            slots = pg.locator("[data-teacher-slot]")
            check(tag + "one teacher card, for this subject", r.status == 200 and slots.count() == 1 and slots.get_attribute("data-teacher-slot") == sub)
            img = pg.locator("[data-teacher-slot] img[data-teacher-img]")
            img.evaluate("i => i.complete || new Promise(r => { i.onload = i.onerror = r })")
            check(tag + "the photo loads and is the one in assets/teachers.js",
                  img.evaluate("i => i.naturalWidth > 0") and img.get_attribute("src") == pg.evaluate("window.TEACHERS['%s'].photo" % sub)
                  and bool(img.get_attribute("alt")))
            ar = pg.locator("[data-teacher-slot] [lang=ar][dir=rtl]")
            check(tag + "Arabic name marked lang=ar dir=rtl", ar.count() == 1 and ar.inner_text().strip() == pg.evaluate("window.TEACHERS['%s'].nameAr" % sub))
            check(tag + "body carries the subject theme", pg.evaluate("document.body.classList.contains('subject-%s')" % sub))
            cb = slots.bounding_box()
            first = pg.locator(info["cards"]).first.bounding_box()
            if width == 390:
                check(tag + "photo card sits above the cards", cb["y"] + cb["height"] <= first["y"], (cb, first))
            else:
                check(tag + "photo card sits beside the cards", cb["x"] >= first["x"] + first["width"] and cb["y"] < first["y"] + first["height"], (cb, first))
            for h in info["hrefs"]:
                check(tag + "link %s still there" % h, pg.locator('a[href="%s"]' % h).count() == 1)
            check(tag + "no sideways scroll", pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
        ctx.close()

    # ---------------------------------------------------------------- one-file swap: teachers.js decides the photo
    ctx = ctx_for(browser)
    def patched(route):
        body = open(os.path.join(REPO, "assets", "teachers.js"), encoding="utf-8").read()
        route.fulfill(status=200, content_type="application/javascript",
                      body=body.replace("/assets/teachers/placeholder-science.svg", "/assets/teachers/placeholder-math.svg"))
    ctx.route("**/assets/teachers.js", patched)
    pg = ctx.new_page()
    pg.goto(base + "/science/", wait_until="load")
    pg.wait_for_function("!!window.TEACHERS")
    check("swap: changing the photo in assets/teachers.js changes it on the science page",
          pg.locator("[data-teacher-slot=science] img").get_attribute("src") == "/assets/teachers/placeholder-math.svg")
    ctx.close()
    browser.close()
srv.shutdown()
sys.exit(1 if fails else 0)
