#!/usr/bin/env python3
"""
e2e_team_page.py - real-browser (Chromium) test for dashboard/team.html in ?mock=1 mode.

Checks the small clean-ups from the admin UX pass (2026-11):
  - no code names on screen (file names, sheet names)
  - the long "what can an assistant do" list starts closed; the trust warning stays visible
  - the revenue page has a clear button at the top of the owner part and a nav link
  - on a phone the staff activity log shows one card per change (no squashed six-column table), no sideways scroll

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
    pg.goto(base + "/dashboard/team.html?mock=1")
    pg.wait_for_selector("#t-powers", timeout=10000)
    pg.wait_for_selector("text=Mona (math)", timeout=10000)
    tag = "%dpx %s: " % (width, scheme)
    text = pg.inner_text("body")
    for bad in ("Phase3_Roles", ".gs", "شيت Students", "tokens"):
        check(tag + "no code name on screen: " + bad, bad not in text)
    check(tag + "permissions list starts closed", pg.evaluate("!document.getElementById('t-powers').open"))
    check(tag + "...and its items are hidden", not pg.locator("#t-powers li").first.is_visible())
    check(tag + "trust warning is visible", pg.locator(".t-warn").is_visible())
    pg.locator("#t-powers summary").click()
    check(tag + "permissions list opens on tap", pg.locator("#t-powers li").first.is_visible())
    jump = pg.locator(".t-jump a[href='teacher-stats.html']")
    check(tag + "revenue button at the top of the owner part", jump.count() == 1 and jump.is_visible())
    check(tag + "revenue link in the nav", pg.locator("header nav a[href='teacher-stats.html']").count() == 1)
    pg.locator("button", has_text="Show the latest 200 edits").click()
    pg.wait_for_selector(".t-table tr[data-kind]", timeout=5000)
    rows = pg.locator(".t-table tr[data-kind]")
    check(tag + "log shows both mock changes", rows.count() == 2, rows.count())
    info = pg.evaluate("""() => {
      const t = document.querySelector('.t-table'), head = t.querySelector('tr');
      const row = t.querySelector('tr[data-kind]');
      return { headShown: getComputedStyle(head).display !== 'none', rowDisplay: getComputedStyle(row).display,
               rowW: row.getBoundingClientRect().width, tableW: t.parentNode.getBoundingClientRect().width,
               phone: (row.querySelector('.t-who-ph') || {}).textContent || '' };
    }""")
    check(tag + "who-cell shows the phone on its own line", info["phone"] == "01000000010", info)
    if width < 600:
        check(tag + "phone: header row hidden, each change is a card", not info["headShown"] and info["rowDisplay"] == "block", info)
        check(tag + "phone: card fits the width", info["rowW"] <= info["tableW"] + 1, info)
        labels = pg.evaluate("""() => [...document.querySelectorAll('.t-table tr[data-kind]')[0].children]
          .map(td => getComputedStyle(td, '::before').content).filter(c => c && c !== 'none')""")
        check(tag + "phone: labels on the card", any("Before" in c for c in labels) and any("After" in c for c in labels), labels)
    else:
        check(tag + "desktop: still a normal table with a header", info["headShown"] and info["rowDisplay"] == "table-row", info)
    wide = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    check(tag + "no sideways scroll", wide <= 1, wide)
    shots = os.path.join(HERE, "_shots"); os.makedirs(shots, exist_ok=True)
    pg.screenshot(path=os.path.join(shots, "team_%d_%s.png" % (width, scheme)), full_page=True)
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
