#!/usr/bin/env python3
"""
e2e_grading_rotate.py - real-browser (Chromium) test for the photo frame on dashboard/grading.html.

A rotated photo must stay inside its box: it never covers the model answer, the marks field or the buttons.
Runs the page in ?mock=1 mode (in-memory answers and a test photo), desktop and phone, light and dark.

    python tests/e2e_grading_rotate.py        (run from tools/quiz-maker-v2)
"""
import os, sys, threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
passed = failed = 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1; print("PASS " + name)
    else:
        failed += 1; print("FAIL " + name + ("  -> " + str(extra) if extra != "" else ""))


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


def serve():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=REPO))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# Does the turned photo (its real on-screen box) stay inside the frame, and the frame inside the answer box,
# with the tools row and the marks row below it?
INSIDE = """() => {
  const img = document.querySelector('.g-photo'), fr = document.querySelector('.g-frame'), box = fr && fr.closest('.g-box');
  const tools = document.querySelector('.g-photo-tools'), mark = document.querySelector('.g-mark');
  if (!img || !fr) return { ok: false, why: 'no photo' };
  const a = img.getBoundingClientRect(), f = fr.getBoundingClientRect(), b = box.getBoundingClientRect();
  const t = tools.getBoundingClientRect(), m = mark.getBoundingClientRect();
  const e = 1.5;
  const ok = a.left >= f.left - e && a.right <= f.right + e && a.top >= f.top - e && a.bottom <= f.bottom + e
    && f.right <= b.right + e && f.left >= b.left - e && t.top >= f.bottom - e && m.top >= b.bottom - e && f.height > 20;
  return { ok, img: [a.left, a.top, a.width, a.height].map(Math.round), frame: [f.left, f.top, f.width, f.height].map(Math.round) };
}"""


def run(b, base, width, scheme):
    ctx = b.new_context(viewport={"width": width, "height": 860}, color_scheme=scheme)
    ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith(base) else r.abort())
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(base + "/dashboard/grading.html?mock=1")
    pg.wait_for_selector(".g-photo", timeout=10000)
    pg.wait_for_function("document.querySelector('.g-photo').naturalWidth > 0")
    tag = "%dpx %s: " % (width, scheme)
    for turn in (0, 90, 180, 270):
        r = pg.evaluate(INSIDE)
        check(tag + "photo at %d degrees stays inside its frame and above the buttons" % turn, r["ok"], r)
        pg.locator(".g-photo-tools button", has_text="Rotate").click()
        pg.wait_for_timeout(250)
    pg.locator(".g-photo-tools button", has_text="Rotate").click()   # 90 degrees, then zoom
    pg.wait_for_timeout(200)
    pg.locator(".g-photo").click()
    pg.wait_for_timeout(250)
    r = pg.evaluate(INSIDE)
    check(tag + "zoomed and turned: still inside the frame", r["ok"], r)
    wide = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    check(tag + "no sideways scroll", wide <= 1, wide)
    check(tag + "no page errors", not errors, errors)
    ctx.close()


def main():
    srv = serve(); base = "http://127.0.0.1:%d" % srv.server_address[1]
    with sync_playwright() as p:
        b = p.chromium.launch()
        for width, scheme in ((1280, "light"), (390, "dark")):
            run(b, base, width, scheme)
        b.close()
    srv.shutdown()
    print("\n%d passed, %d failed" % (passed, failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
