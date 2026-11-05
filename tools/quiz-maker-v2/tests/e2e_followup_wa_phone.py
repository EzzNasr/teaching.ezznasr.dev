#!/usr/bin/env python3
"""
e2e_followup_wa_phone.py -- the follow-up page's "send all from the WhatsApp phone" (docs/whatsapp/README.md), real Chromium,
390px phone, ?mock=1 only (nothing leaves the machine).

  - phone off / older server (no &wa=1): the walk-through is exactly as before, no phone option
  - phone on (&wa=1): the first screen offers "send all from the phone (N)"; confirm -> ONE admin_fu2_wa_enqueue with each
    student's message exactly as composed, the parent's WhatsApp digits and the contact items; nothing is logged as contacted yet
  - no sideways scroll; screenshots for the docs with --shots DIR

    python tests/e2e_followup_wa_phone.py [--shots DIR]      (run from tools/quiz-maker-v2)
"""
import os
import re
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PAGE = "/dashboard/followup.html"
SHOTS = sys.argv[sys.argv.index("--shots") + 1] if "--shots" in sys.argv else None
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


def calls(page, action=None):
    c = page.evaluate("window.__fuMockCalls || []")
    return [x for x in c if action is None or x.get("action") == action]


def open_walk(browser, base, wa):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, locale="ar-EG", timezone_id="Africa/Cairo")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
    page.route(re.compile(r"https://(wa\.me|api\.whatsapp\.com)/.*"), lambda r: r.fulfill(body="wa", content_type="text/plain"))
    page.goto(base + PAGE + "?mock=1&scenario=parents" + ("&wa=1" if wa else "") + "#g=sat%206pm")
    page.wait_for_selector("#fu-hero", timeout=15000)
    page.click("#fu-hero-go")
    page.wait_for_selector("[data-fw='root']", timeout=10000)
    return ctx, page, errors


def shot(page, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=os.path.join(SHOTS, name))


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=REPO))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % srv.server_address[1]
    with sync_playwright() as p:
        b = p.chromium.launch()

        # ---- phone off: unchanged ----
        ctx, page, errors = open_walk(b, base, False)
        check("phone off: the walk-through opens as before (1 of 3)", "1 من 3" in page.inner_text("[data-fw='count']"), page.inner_text("[data-fw='count']"))
        check("phone off: no phone option", page.locator("[data-fw='phone-banner']").count() == 0)
        check("phone off: the status was asked and the answer (Unknown action) ignored", len(calls(page, "admin_fu2_wa_status")) >= 1 and not errors, errors)
        ctx.close()

        # ---- phone on ----
        ctx, page, errors = open_walk(b, base, True)
        banner = page.locator("[data-fw='phone-banner']")
        check("phone on: the first screen offers «ابعت الكل من موبايل الواتساب»", banner.count() == 1 and "موبايل الواتساب" in banner.inner_text(), page.inner_text("[data-fw='root']")[:300])
        n = int(re.search(r"\((\d+)\)", page.inner_text("[data-fw='phone-all']")).group(1))
        check("phone on: the count is the students whose parent number passes the check (1-3)", 1 <= n <= 3, n)
        check("phone on: test mode is said on the banner", "رقمك" in banner.inner_text())
        bubble0 = page.inner_text("[data-fw='bubble']")
        shot(page, "1-walk-phone-option.png")
        page.click("[data-fw='phone-all']")
        page.wait_for_selector("[data-fw='phone-ask']")
        check("confirm screen: how many, test-mode warning", ("ابعت " + str(n)) in page.inner_text("[data-fw='phone-ask']") and "وضع التجربة" in page.inner_text("[data-fw='phone-ask']"), page.inner_text("[data-fw='phone-ask']"))
        check("confirm screen: nothing queued before Confirm", not calls(page, "admin_fu2_wa_enqueue"))
        shot(page, "2-confirm.png")
        page.click("[data-fw='phone-confirm']")
        page.wait_for_selector("[data-fw='phone-done']")
        q = calls(page, "admin_fu2_wa_enqueue")
        check("ONE enqueue call for the whole batch", len(q) == 1, len(q))
        q = q[0] if q else {}
        items = q.get("items") or []
        check("enqueue: event parents_hw, the group, N items", q.get("event") == "parents_hw" and q.get("group") and len(items) == n, {k: q.get(k) for k in ("event", "group", "group_key")})
        check("each item: parent WhatsApp digits with the country code", all(re.match(r"^[1-9]\d{10,14}$", it.get("to", "")) for it in items), [it.get("to") for it in items])
        check("each item: the message, a student phone and contact items {kind, ref}", all(it.get("text") and it.get("student_phone") and it.get("log_items") and all(x.get("kind") and x.get("ref") for x in it["log_items"]) for it in items), items[:1])
        check("the first message is exactly the one shown in the bubble (WhatsApp *bold* markers kept in the text)", bool(items) and re.sub(r"\s+", " ", re.sub(r"[*_~]", "", items[0]["text"])).strip()[:60] in re.sub(r"\s+", " ", bubble0), (items[0]["text"][:60] if items else "", bubble0[:60]))
        check("done screen: «✓ N رسالة في طابور الموبايل»", ("✓ " + str(n) + " رسالة") in page.inner_text("[data-fw='phone-done']"), page.inner_text("[data-fw='phone-done']"))
        check("nothing is logged as contacted when queued (the server logs each one when the phone sends it)", not calls(page, "admin_log_parent_notification"))
        check("no sideways scroll on the phone screens", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
        shot(page, "3-queued.png")
        rest = page.locator("[data-fw='phone-rest']")
        if rest.count():
            rest.click()
            page.wait_for_selector("[data-fw='name']")
            check("«كمّل الباقي بإيدك» goes back to the one-by-one walk for the rest", page.locator("[data-fw='phone-banner']").count() == 0)
            page.click("[data-fw='done-now']")
        else:
            page.click("[data-fw='phone-close']")
        page.wait_for_function("!document.querySelector('[data-fw=root]')")
        check("closing logs nothing extra", not calls(page, "admin_log_parent_notification"))
        check("no JS errors", not errors, errors)
        ctx.close()
        b.close()
    srv.shutdown()
    print("\n%d passed, %d failed" % (passed, failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
