#!/usr/bin/env python3
"""R-P25-D: the home page (Phase 2.5 step D), in a real browser at 390 px and 1280 px, light and dark.
Three main subject cards in order (Programming, Math, Science), English in a smaller "More" row below them, every
subject link opens a real page (200, its own <h1>), no sideways scroll, the cards stack on a phone."""
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
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)[:300]))
    fails += 0 if ok else 1

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=REPO))
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % srv.server_address[1]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, dark in ((390, False), (390, True), (1280, False), (1280, True)):
        tag = "%dpx %s: " % (width, "dark" if dark else "light")
        ctx = browser.new_context(viewport={"width": width, "height": 900}, color_scheme="dark" if dark else "light")
        seal(ctx, allow=(base,))
        if dark:
            ctx.add_init_script("try{localStorage.setItem('theme','dark');localStorage.setItem('teaching-theme','dark')}catch(e){}")
        pg = ctx.new_page()
        pg.goto(base + "/", wait_until="load")
        cards = pg.locator("#lessons .grid > a.card")
        titles = [cards.nth(i).locator("h3").inner_text().strip() for i in range(cards.count())]
        check(tag + "three main cards: Programming, Math, Science", titles == ["Programming", "Math", "Science"], titles)
        hrefs = [cards.nth(i).get_attribute("href") for i in range(cards.count())]
        check(tag + "they lead to /programming/, /math/, /science/", hrefs == ["/programming/", "/math/", "/science/"], hrefs)
        more = pg.locator("#lessons .more")
        check(tag + "a 'More' row below the cards holds English", more.count() == 1 and "English" in more.inner_text()
              and more.locator("a[href='/english/']").count() == 1 and pg.locator(".grid a[href='/english/']").count() == 0)
        box_grid, box_more = pg.locator("#lessons .grid").bounding_box(), more.bounding_box()
        check(tag + "'More' sits under the main cards", box_more["y"] >= box_grid["y"] + box_grid["height"])
        mini = more.locator(".mini-card").bounding_box()
        card = cards.nth(0).bounding_box()
        check(tag + "the English row is smaller than a main card", mini["height"] < card["height"], (mini["height"], card["height"]))
        check(tag + "no sideways scroll", pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
        if width == 390:
            xs = {round(cards.nth(i).bounding_box()["x"]) for i in range(3)}
            check(tag + "the cards stack in one column", len(xs) == 1, xs)
        else:
            ys = {round(cards.nth(i).bounding_box()["y"]) for i in range(3)}
            check(tag + "the cards sit in one row", len(ys) == 1, ys)
        if width == 390 and not dark:
            for href in hrefs + ["/english/"]:
                r = pg.goto(base + href, wait_until="load")
                check("link %s opens a real page" % href, r is not None and r.status == 200 and pg.locator("h1").count() >= 1, r and r.status)
            pg.goto(base + "/science/", wait_until="load")
            for a in ("./preparatory/grade-3-preparatory/", "./secondary/grade-1-secondary/"):
                r = pg.goto(base + "/science/" + a[2:], wait_until="load")
                check("science grade page %s opens" % a, r is not None and r.status == 200 and "Lessons coming soon" in pg.inner_text("main"))
                check("science grade page %s: no sideways scroll at 390" % a, pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
        ctx.close()
    browser.close()
srv.shutdown()
sys.exit(1 if fails else 0)
