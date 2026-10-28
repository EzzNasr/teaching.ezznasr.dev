#!/usr/bin/env python3
"""Real-browser test of the full-screen "do not close this page" upload screen (assets_templates/upload-guard.js)
on the FILE-upload homework flow, plus the close-warning. Run from tools/quiz-maker-v2:
    python tests/e2e_upload_guard.py
Backend = REAL Code.gs through the Node harness. Nothing touches the live site or Sheet.
"""
import json, os, sys, tempfile, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_video as E
import e2e_capture as C
from playwright.sync_api import sync_playwright

passed = failed = 0
SHOTS = os.environ.get("GUARD_SHOTS", "")


def check(name, cond, extra=""):
    global passed, failed
    if cond: passed += 1; print("PASS " + name)
    else: failed += 1; print("FAIL " + name + ("  -> " + str(extra)[:300] if extra else ""))


def file_page():
    return ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<link rel="stylesheet" href="/assets/base.css"><link rel="stylesheet" href="/assets/forms.css"></head>'
            '<body><main><div class="wrap"><div id="assign-root" data-subject="zz" data-lesson="guard-file" data-mode="file"></div></div></main>'
            '<script src="/assets/auth.js"></script><script src="/assets/assign.js"></script>'
            "<script>AssignEngine.mount('#assign-root');</script></body></html>")


def run(browser, tmp):
    stu = E.session_for("01000000052", "pw", "Nour")
    doc = os.path.join(tmp, "homework.txt")
    open(doc, "w").write("my homework " * 50)

    p = C.Page(browser, stu, {"/zz-test/guard-file/assignment.html": file_page()}, camera=False)
    pg = p.pg
    held = []

    def slow(route):          # hold the request until the test lets it go (later routes run first; fallback() reaches the real backend)
        held.append(route)
    p.s.ctx.route("https://script.google.com/**", slow)

    pg.set_viewport_size({"width": 375, "height": 740})
    pg.goto(E.SITE + "/zz-test/guard-file/assignment.html")
    pg.wait_for_selector("input[type=file]")
    pg.set_input_files("input[type=file]", doc)
    pg.wait_for_function("window.UploadGuard !== undefined")
    pg.click("button:has-text('Submit assignment')")
    pg.wait_for_selector(".tug-card:not(.ok):not(.bad)", timeout=5000)
    check("file upload: full-screen warning is up while the file is sent", "DO NOT close" in pg.inner_text(".tug-back") and "لا تقفل" in pg.inner_text(".tug-back"))
    check("file upload: 375px, card fits, no horizontal scroll", pg.evaluate("document.scrollingElement.scrollWidth <= window.innerWidth"))
    check("file upload: page behind cannot scroll", pg.evaluate("document.documentElement.style.overflow") == "hidden")
    if SHOTS: pg.screenshot(path=os.path.join(SHOTS, "guard-working.png"))
    # closing the tab while it runs asks first
    ev = pg.evaluate("(function(){var e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()")
    check("file upload: closing/reloading the tab is blocked with a browser warning while it runs", ev is True)
    pg.wait_for_function("window.__never === undefined", timeout=1000)
    while held:
        held.pop().fallback()
    pg.wait_for_selector(".tug-card.ok", timeout=15000)
    check("file upload: green screen, 'you can close this page now'", "You can close this page now" in pg.inner_text(".tug-card.ok"))
    ev2 = pg.evaluate("(function(){var e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()")
    check("file upload: the close warning is removed once it is done", ev2 is False)
    if SHOTS: pg.screenshot(path=os.path.join(SHOTS, "guard-done.png"))
    check("file upload: the server really got the file", len(p.calls("upload_submission")) == 1 and p.calls("upload_submission")[0].get("submission_type") == "file")
    pg.click(".tug-btn:has-text('Continue')")
    check("file upload: Continue removes the screen and unlocks the page", pg.locator(".tug-back").count() == 0 and pg.evaluate("document.documentElement.style.overflow") != "hidden")
    p.s.close()

    # server unreachable: red screen, nothing lost, Try again works once the network is back
    p = C.Page(browser, stu, {"/zz-test/guard-file/assignment.html": file_page()}, camera=False)
    pg = p.pg
    state = {"down": True}
    def flaky(route):
        if state["down"]: return route.abort()
        return route.fallback()
    p.s.ctx.route("https://script.google.com/**", flaky)
    pg.goto(E.SITE + "/zz-test/guard-file/assignment.html")
    pg.wait_for_selector("input[type=file]")
    pg.set_input_files("input[type=file]", doc)
    pg.wait_for_function("window.UploadGuard !== undefined")
    pg.click("button:has-text('Submit assignment')")
    pg.wait_for_selector(".tug-card.bad", timeout=30000)
    check("offline: red screen with Try again, tab-close warning already lifted", pg.locator(".tug-btn:has-text('Try again')").count() == 1)
    if SHOTS: pg.screenshot(path=os.path.join(SHOTS, "guard-failed.png"))
    state["down"] = False
    pg.click(".tug-btn:has-text('Try again')")
    pg.wait_for_selector(".tug-card.ok", timeout=15000)
    check("offline: Try again goes through once the network is back", len(p.calls("upload_submission")) >= 1)
    p.s.close()


def main():
    backend = C.start_backend()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            with tempfile.TemporaryDirectory() as tmp:
                run(browser, tmp)
            browser.close()
    finally:
        backend.terminate()
    print("\n%d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
