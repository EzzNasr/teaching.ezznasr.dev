#!/usr/bin/env python3
"""
e2e_team_page.py - real-browser (Chromium) test for dashboard/team.html («الفريق») in ?mock=1 mode.

The page was rebuilt in Nov 2026 as one Arabic page: everyone with staff access in one list (owner, teachers with
their assistants under them, your own assistants), one "add someone" button, the recent changes loaded on open,
and the long details folded at the bottom. Desktop and phone, light and dark.

    python tests/e2e_team_page.py        (run from tools/quiz-maker-v2)
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


def run(b, base, width, scheme):
    ctx = b.new_context(viewport={"width": width, "height": 860}, color_scheme=scheme)
    ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith(base) else r.abort())
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("dialog", lambda d: d.accept())
    pg.goto(base + "/dashboard/team.html?mock=1")
    pg.wait_for_selector("#t-log li[data-kind]", timeout=10000)
    tag = "%dpx %s: " % (width, scheme)
    check(tag + "page is Arabic, right to left", pg.evaluate("document.documentElement.dir") == "rtl")
    text = pg.inner_text("body")
    for bad in ("Phase3_Roles", ".gs", "شيت Students", "token", "admin_", "Telegram linked", "Assistants:", "Make teacher"):
        check(tag + "no code name or English label on screen: " + bad, bad not in text)
    # one list of everyone
    check(tag + "owner, teacher and own assistant in one list", pg.locator("#t-owners li[data-role=owner]").count() == 1
          and pg.locator("#t-teachers li[data-role=teacher]").count() == 1 and pg.locator("#t-assistants li[data-role=assistant]").count() == 1)
    check(tag + "the teacher's assistant is listed under the teacher", pg.locator("#t-teachers [data-role=teacher-assistant]").inner_text() == "مساعد: عمر")
    check(tag + "subject in words, Telegram status as a chip", "رياضة" in pg.inner_text("#t-teachers") and "تليجرام متوصّل" in pg.inner_text("#t-teachers"))
    check(tag + "the count covers everyone (owner + teacher + 2 assistants)", "(4)" in pg.inner_text("#t-people h3"), pg.inner_text("#t-people h3"))
    # one add button
    check(tag + "add panel closed at first", not pg.locator("#t-add").is_visible())
    pg.locator("#t-add-open").click()
    check(tag + "add panel opens with assistant chosen", pg.locator("#t-add").is_visible() and pg.locator("#t-add-go").inner_text() == "ضيفه مساعد")
    pg.locator("#t-add [data-kind=teacher]").click()
    check(tag + "choosing teacher shows the subjects (4, science included)", pg.locator(".t-subjects input").count() == 4 and "علوم" in pg.inner_text(".t-subjects") and pg.locator("#t-add-go").inner_text() == "خلّيه مدرّس")
    pg.locator("#t-phone").fill("01000000077")
    pg.locator("#t-add-go").click()
    pg.wait_for_selector("#t-msg.err", timeout=3000)
    check(tag + "teacher without a subject: asks to tick one", "علّم مادة" in pg.inner_text("#t-msg"))
    pg.locator(".t-subjects label", has_text="برمجة").click()
    pg.locator("#t-add-go").click()
    pg.wait_for_selector("#t-msg.ok", timeout=3000)
    check(tag + "teacher added and listed, panel closes", pg.locator("#t-teachers li[data-role=teacher]").count() == 2 and not pg.locator("#t-add").is_visible())
    pg.locator("#t-add-open").click(); pg.locator("#t-add [data-kind=assistant]").click()
    pg.locator("#t-phone").fill("9999999999"); pg.locator("#t-add-go").click()
    pg.wait_for_selector("#t-msg.err", timeout=3000)
    check(tag + "unknown number: a plain sentence", "لازم الشخص يسجّل حساب" in pg.inner_text("#t-msg"), pg.inner_text("#t-msg"))
    pg.locator("#t-add-open").click()
    # recent changes: loaded on open, cards, plain words
    log = pg.locator("#t-log li[data-kind]")
    check(tag + "recent changes loaded on open (2 entries)", log.count() == 2, log.count())
    first = log.first.inner_text()
    check(tag + "change in plain words, attendance value translated", "سجّل حضور: في السنتر" in first and "center" not in first, first)
    pg.locator("#t-logwho").select_option("teacher")
    check(tag + "filter by teachers", pg.locator("#t-log li[data-kind]").count() == 1)
    if width < 600:
        box = pg.evaluate("(() => { const l = document.querySelector('#t-log li'), w = document.querySelector('#t-logcard'); return [l.getBoundingClientRect().right, w.getBoundingClientRect().right]; })()")
        check(tag + "phone: each change card fits the card", box[0] <= box[1] + 1, box)
    # folded details
    check(tag + "permissions list starts closed", pg.evaluate("!document.getElementById('t-powers').open"))
    check(tag + "trust warning is visible", pg.locator(".t-warn").is_visible())
    pg.locator("#t-powers summary").click()
    check(tag + "permissions list opens on tap", pg.locator("#t-powers li").first.is_visible())
    check(tag + "revenue link in the menu and at the bottom", pg.locator("nav a[href='revenue.html']").count() == 1 and pg.locator(".t-links a[href='revenue.html']").count() == 1)
    wide = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    check(tag + "no sideways scroll", wide <= 1, wide)
    check(tag + "no page errors", not errors, errors)
    ctx.close()


def main():
    srv = serve(); base = "http://127.0.0.1:%d" % srv.server_address[1]
    with sync_playwright() as p:
        b = p.chromium.launch()
        for width, scheme in ((1280, "light"), (390, "dark"), (390, "light")):
            run(b, base, width, scheme)
        b.close()
    srv.shutdown()
    print("\n%d passed, %d failed" % (passed, failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
