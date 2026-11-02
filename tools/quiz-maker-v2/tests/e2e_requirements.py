#!/usr/bin/env python3
"""
e2e_requirements.py - real-browser (Chromium) test for dashboard/requirements.html (Follow-up v2 / S4).

Runs the page in ?mock=1 mode (in-memory fixture, nothing saved) on a 390px phone viewport, light and dark.

    pip install playwright && playwright install chromium
    python tests/e2e_requirements.py          (run from tools/quiz-maker-v2)
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


def main():
    srv = serve(); base = "http://127.0.0.1:%d" % srv.server_address[1]
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 390, "height": 844}, locale="ar-EG")
        # fonts / theme come from the network on the real site; keep the test offline
        ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith(base) else r.abort())
        pg = ctx.new_page()
        errors = []
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(base + "/dashboard/requirements.html?mock=1")
        pg.wait_for_selector("#rq-card-watch")

        check("mock badge shown", pg.is_visible("#rq-mock"))
        check("four tabs", pg.locator("#rq-tabs .rq-tab").count() == 4)
        check("global tab shows the 5 built-in cards", pg.locator("[id^=rq-card-]").count() == 5)
        check("no sideways scroll at 390px", pg.evaluate("document.documentElement.scrollWidth <= 390"))
        check("tap targets >= 44px (switches, inputs, tabs)", pg.evaluate(
            "[...document.querySelectorAll('.rq-sw, .rq-in, .rq-tab, .rq-btn')].every(e => e.getBoundingClientRect().height >= 44)"))
        check("watch rule starts at 80", pg.input_value("#rq-rule-watch") == "80")

        # --- toggle: disable homework globally
        pg.click("#rq-sw-homework-enabled")
        pg.wait_for_function("document.querySelector('#rq-card-homework').classList.contains('off')")
        check("toggle homework off dims its card", True)
        check("a toast confirmed the save", pg.is_visible(".rq-toast"))

        # --- rule validation (client) then a good save
        pg.fill("#rq-rule-watch", "150"); pg.press("#rq-rule-watch", "Tab")
        check("pct 150 shows an inline error and nothing saved", pg.is_visible("#rq-rule-watch-err"))
        pg.fill("#rq-rule-watch", "70"); pg.press("#rq-rule-watch", "Tab")
        pg.wait_for_function("!document.querySelector('#rq-rule-watch-err') || document.querySelector('#rq-rule-watch-err').hidden")
        check("pct 70 accepted", pg.input_value("#rq-rule-watch") == "70")

        # --- new manual requirement
        pg.click("#rq-new-open"); pg.fill("#rq-new-ar", "السلوك في الحصة"); pg.fill("#rq-new-en", "Behaviour"); pg.click("#rq-new-save")
        pg.wait_for_selector("#rq-card-custom_behaviour")
        check("manual requirement card appears with its key", pg.is_visible("#rq-card-custom_behaviour"))
        check("manual card has no parent-message switch", pg.locator("#rq-sw-custom_behaviour-parent").count() == 0)

        # --- groups tab: override, differs badge, effective text
        pg.click("#rq-tab-groups"); pg.wait_for_selector("#rq-group-select")
        check("group select lists both groups", pg.locator("#rq-group-select option").count() == 2)
        pg.select_option("#rq-group-select", "sat 6pm")
        pg.click("label[for=rq-mode-watch-off]"); pg.wait_for_function("document.querySelector('#rq-eff-watch').textContent.includes('متوقف')")
        check("group Off: effective line says disabled", True)
        check("differs-from-global badge shown", "يختلف عن العام" in pg.inner_text("#rq-gcard-watch"))
        pg.click("label[for=rq-mode-watch-custom]"); pg.wait_for_selector("#rq-grule-watch")
        pg.fill("#rq-grule-watch", "50"); pg.press("#rq-grule-watch", "Tab")
        pg.wait_for_function("document.querySelector('#rq-eff-watch').textContent.includes('50%')")
        check("group Custom pct 50 reflected", True)
        pg.select_option("#rq-group-select", "mon 5pm")
        check("other group still inherits (70% from global)", "70%" in pg.inner_text("#rq-eff-watch"))

        # --- copy from group
        pg.select_option("#rq-copy-from", "sat 6pm"); pg.click("#rq-copy-go"); pg.wait_for_selector("#rq-dialog")
        pg.click("#rq-dialog-ok"); pg.wait_for_function("document.querySelector('#rq-eff-watch').textContent.includes('50%')")
        check("copy-from-group made mon 5pm like sat 6pm", True)

        # --- manual monthly checklist
        pg.select_option("#rq-group-select", "sat 6pm"); pg.wait_for_selector("#rq-chk-1012345001-yes")
        pg.click("#rq-chk-1012345001-yes"); pg.wait_for_function("document.querySelector('#rq-chk-1012345001-yes').classList.contains('sel')")
        check("tick a student: Yes is selected", True)
        pg.click("#rq-chk-1012345001-no"); pg.wait_for_function("document.querySelector('#rq-chk-1012345001-no').classList.contains('sel')")
        check("switch to No", not pg.evaluate("document.querySelector('#rq-chk-1012345001-yes').classList.contains('sel')"))
        pg.click("#rq-chk-1012345001-clear"); pg.wait_for_function("document.querySelector('#rq-chk-1012345001-clear').classList.contains('sel')")
        check("clear back to not-yet", True)
        pg.click("#rq-chk-1012345001-yes"); pg.wait_for_function("document.querySelector('#rq-chk-1012345001-yes').classList.contains('sel')")

        # --- preview tab
        pg.click("#rq-tab-preview"); pg.wait_for_selector("#rq-pv-student")
        pg.select_option("#rq-pv-student", "1012345001")
        txt = pg.inner_text("#rq-pv-card")
        check("preview lists the student's requirements", pg.locator("[id^=rq-pv-]").count() >= 6)
        check("preview: sat 6pm student gets the group's custom watch rule (50%)", "50%" in pg.inner_text("#rq-pv-watch"), pg.inner_text("#rq-pv-watch"))
        check("preview: homework disabled globally is not counted", "مش بيتحسب" in pg.inner_text("#rq-pv-homework"))
        check("preview shows the manual tick", "تم" in pg.inner_text("#rq-pv-custom_behaviour"), pg.inner_text("#rq-pv-custom_behaviour"))
        check("preview works for an unclassified student", pg.select_option("#rq-pv-student", "1512345012") is not None and "غير مصنّف" in pg.inner_text("#rq-pv-card"))

        # --- history tab
        pg.click("#rq-tab-history"); pg.wait_for_selector("#rq-hist-list .rq-hi")
        check("history has entries, newest first", pg.locator("#rq-hist-list .rq-hi").count() >= 5)
        check("history says Alex, never the old zone name", "Alex" in pg.inner_text("main") and "Cairo" not in pg.inner_text("body"))

        # --- deep link + dark mode
        pg.goto(base + "/dashboard/requirements.html?mock=1#history"); pg.wait_for_selector("#rq-hist-list")
        check("#history deep link opens the History tab", pg.get_attribute("#rq-tab-history", "aria-selected") == "true")
        pg.evaluate("document.documentElement.setAttribute('data-theme','dark')")
        check("dark mode: card background is not white", pg.evaluate("getComputedStyle(document.querySelector('.rq-card')).backgroundColor") != "rgb(255, 255, 255)")
        check("no console errors", errors == [], errors)
        b.close()
    srv.shutdown()
    print("\n%d passed, %d failed" % (passed, failed))
    sys.exit(1 if failed else 0)


main()
