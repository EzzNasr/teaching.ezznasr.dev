#!/usr/bin/env python3
"""
e2e_followup_walk.py -- real-browser (Chromium) test of assets/followup-walk.js on a 390px phone viewport.
Uses tests/walk-harness.html (its own page; the Follow-up page is wired by S1). Nothing touches the network.

    python tests/e2e_followup_walk.py        (run from tools/quiz-maker-v2)
"""
import os
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PAGE = "/tools/quiz-maker-v2/tests/walk-harness.html"
passed = failed = 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("PASS " + name)
    else:
        failed += 1
        print("FAIL " + name + ("  -> " + str(extra)[:300] if extra else ""))


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=REPO))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % srv.server_address[1]
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 390, "height": 780}, locale="ar-EG")
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        # never leave the harness: WhatsApp links open in a new tab, which we simply swallow
        ctx.route("**/wa.me/**", lambda r: r.fulfill(status=200, body="ok"))
        ctx.route("**/api.whatsapp.com/**", lambda r: r.fulfill(status=200, body="ok"))

        def fw(sel):
            return pg.locator('[data-fw="%s"]' % sel)

        def log():
            return pg.evaluate("window.LOG")

        pg.goto(base + PAGE)
        pg.evaluate("window.openWalk()")
        check("opens as a full-screen dialog", fw("root").is_visible() and fw("root").get_attribute("role") == "dialog")
        check("progress reads 1 of 3", "1" in fw("count").inner_text() and "3" in fw("count").inner_text(), fw("count").inner_text())
        check("first student name shown", "أحمد" in fw("name").inner_text())
        check("message preview shown", "رسالة أحمد" in fw("bubble").inner_text())
        check("no phone warning for a student with a phone", fw("phonewarn").count() == 0)
        check("Next is disabled before WhatsApp is opened", fw("next").is_disabled())
        check("Back is disabled on the first student", fw("back").is_disabled())
        href = fw("wa").get_attribute("href") or ""
        check("WhatsApp link is a wa.me link with the message", "wa.me/" in href and "text=" in href, href)

        # no sideways scroll, 44px tap targets
        sw = pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        check("no horizontal scroll at 390px", sw)
        small = pg.evaluate("""() => [...document.querySelectorAll('.fw-overlay button, .fw-overlay a.fw-btn')]
            .filter(e => e.offsetParent && e.getBoundingClientRect().height < 44).map(e => e.dataset.fw)""")
        check("every button is at least 44px tall", not small, small)

        # open WhatsApp (popup swallowed), then Next
        with ctx.expect_page() as popup:
            fw("wa").click()
        popup.value.close()
        check("Next unlocks after opening WhatsApp", fw("next").is_enabled())
        fw("next").click()
        check("moved to the 2nd student", "منى" in fw("name").inner_text() and "2" in fw("count").inner_text())
        check("no-parent-phone warning shown", fw("phonewarn").count() == 1 and fw("phonewarn").is_visible())
        check("WhatsApp button is disabled without a parent phone", fw("wa").get_attribute("aria-disabled") == "true" and not fw("wa").get_attribute("href"))
        check("Back is enabled now", fw("back").is_enabled())

        fw("skip").click()
        check("Skip moved to the 3rd student", "يوسف" in fw("name").inner_text())
        fw("back").click()
        check("Back returns to the skipped student", "منى" in fw("name").inner_text())
        fw("skip").click()
        with ctx.expect_page() as popup:
            fw("wa").click()
        popup.value.close()
        fw("next").click()
        check("finished: summary shown", fw("summary").is_visible())
        check("summary counts all rows", "3" in fw("count").inner_text(), fw("count").inner_text())

        # keyboard: Escape on the summary closes (a sent row exists, so it asks first)
        pg.keyboard.press("Escape")
        check("Escape with sent rows asks before closing", fw("confirm").is_visible())
        fw("confirm-keep").click()
        check("Keep going returns to the summary", fw("summary").is_visible())
        fw("finish").click()
        check("Finish closes the sheet", fw("root").count() == 0)
        lg = log()
        check("onDone called once with sent=[1,3] skipped=[2]",
              len(lg["done"]) == 1 and lg["done"][0] == {"sent": ["1012345001", "1012345003"], "skipped": ["1012345002"]}, lg)
        check("onClose called once", lg["closed"] == 1, lg)
        check("page scroll restored after close", pg.evaluate("document.body.style.overflow") in ("", "visible"))

        # Done for now midway
        pg.evaluate("window.openWalk()")
        with ctx.expect_page() as popup:
            fw("wa").click()
        popup.value.close()
        fw("done-now").click()
        lg = log()
        check("Done for now reports only what was opened", lg["done"][-1] == {"sent": ["1012345001"], "skipped": []}, lg)
        check("sheet closed after Done for now", fw("root").count() == 0)

        # close with nothing sent: closes straight away, onDone not called
        n_done = len(log()["done"])
        pg.evaluate("window.openWalk()")
        fw("close").click()
        check("X with nothing sent closes without onDone", fw("root").count() == 0 and len(log()["done"]) == n_done)

        # close with something sent: confirm; discard
        pg.evaluate("window.openWalk()")
        with ctx.expect_page() as popup:
            fw("wa").click()
        popup.value.close()
        fw("close").click()
        check("X after sending asks to confirm", fw("confirm").is_visible())
        fw("confirm-discard").click()
        check("Discard closes without onDone", fw("root").count() == 0 and len(log()["done"]) == n_done)

        # empty list and programmatic close
        pg.evaluate("window.openWalk([])")
        check("empty list shows the empty message", fw("empty").is_visible())
        pg.evaluate("window.WALK.close()")
        check("handle.close() closes", fw("root").count() == 0)

        # edit text updates the link
        pg.evaluate("window.openWalk()")
        fw("edit-toggle").click()
        fw("edit").fill("نص معدّل")
        check("editing the text updates the preview and the link",
              "معدّل" in fw("bubble").inner_text() and "text=" in (fw("wa").get_attribute("href") or ""))
        pg.evaluate("window.WALK.close()")

        check("no console or page errors", not errors, errors)
        b.close()
    srv.shutdown()
    print("\n%d passed, %d failed" % (passed, failed))
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
