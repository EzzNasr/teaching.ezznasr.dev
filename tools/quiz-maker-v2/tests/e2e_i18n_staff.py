#!/usr/bin/env python3
"""
e2e_i18n_staff.py - real-browser (Chromium) test of the Arabic / English button (assets/i18n.js) on the staff pages
done so far: team.html («الفريق»), revenue.html («الإيرادات») and staff.html (the assistant's home «الرئيسية»).

For each page, desktop and phone, light and dark:
  - Arabic, right to left, on the first visit; the language button sits next to the dark-mode button.
  - One tap: English, left to right, the key labels in English, NO Arabic left on screen outside data
    (names, group names, lesson titles carry translate="no"), no sideways scroll.
  - What was typed is still there after the switch (team: phone number + ticked subjects, revenue: lesson price).
  - Confirms are asked in English too.
  - The choice is remembered: a reload and another staff page open in English; switching back gives the exact
    Arabic text again.
  - With storage blocked (private window) the page still works and the button still switches.
staff.html has no ?mock=1 mode: its auth.js / staff-guard.js are replaced by small stubs here.

    python tests/e2e_i18n_staff.py        (run from tools/quiz-maker-v2)
"""
import os, sys, threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
passed = failed = 0

AUTH_STUB = """window.AuthEngine = {
  mount: function (sel, cb) { cb({ session_token: "t", student_name: "سارة محمود", is_admin: true, role: "admin" }); },
  adminCall: function () { return Promise.resolve({ ok: true, counts: { pending: 3 } }); },
  clearSession: function () {}
};"""
GUARD_STUB = "window.StaffGuard = { require: function () { return Promise.resolve('admin'); } };"


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


def new_ctx(b, base, width, scheme, block_storage=False):
    ctx = b.new_context(viewport={"width": width, "height": 900}, color_scheme=scheme)
    def route(r):
        u = r.request.url
        if not u.startswith(base): return r.abort()
        if u.endswith("/assets/auth.js"): return r.fulfill(body=AUTH_STUB, content_type="application/javascript")
        if u.endswith("/assets/staff-guard.js") and "staff.html" in (r.request.headers.get("referer") or ""):
            return r.fulfill(body=GUARD_STUB, content_type="application/javascript")
        r.continue_()
    ctx.route("**/*", route)
    if block_storage:
        ctx.add_init_script("Object.defineProperty(window, 'localStorage', { get: function () { throw new Error('blocked'); } });")
    return ctx


PAGES = [
    # file, ready selector, Arabic h1, English h1, [(selector, English text that must be in it)], Arabic text back after switching back,
    # (input to type in before switching, text) whose value must survive the switch
    ("team.html?mock=1", "#t-log li", "الفريق", "Team",
     [("#t-add-open", "Close"), ("#t-add-go", "Make them a teacher"), ("#t-logcard h3", "Latest changes"), ("#t-powers summary", "What can an assistant do?"),
      ("nav a[aria-current=page]", "Team"), ("#t-teachers", "Telegram connected"), ("#t-log", "Took attendance: at the center")], "النتايج", None),
    ("revenue.html?mock=1", "#rv-hero", "الإيرادات", "Revenue",
     [("#rv-hero", "Revenue for November 2026"), ("#rv-now", "4,250 EGP"), ("#rv-break h3", "Where is the money coming from?"),
      ("[data-view=month]", "By month"), ("#rv-price-save", "Save the price"), ("#rv-list", "Secondary 1 · Chapter 3 subscription")], "النتايج", ("#rv-price", "75")),
    ("staff.html", ".sh-card", "الرئيسية", "Home",
     [(".sh-hello", "Hi سارة"), (".sh-cards", "Student follow-up"), (".sh-cards", "Start grading →"), ("#sh-out", "Sign out"), (".sh-badge:not([hidden])", "3 waiting")], "تسجيل خروج", None),
    ("followup.html?mock=1", "#fu-today, #fu-hero", "متابعة الطلاب", "Student follow-up",
     [("#fu-tabs", "Today"), ("#fu-root", "What you need to do now"), ("#fu-updated", "Last updated")], "اليوم", None),
    ("requirements.html?mock=1", ".rq-card", "المطلوبات", "Requirements",
     [("#rq-tabs", "General"), ("#rq-tabs", "History"), ("#rq-root", "General requirements"), ("#rq-root", "Watch video"), ("#rq-root", "Counts in the monthly report")],
     "استثناءات المجموعات", None),
    ("student-summary.html?mock=1", "#ss-q", "ملخص الطالب", "Student summary",
     [("#fu-root", "Choose the student:")], "اختار الطالب", ("#ss-q", "sa")),
    ("my-revenue.html?mock=1", "#mr-cards", "إيراداتي", "My revenue",
     [("#mr-download", "Download report"), ("#mr-cards", "Total sales"), ("#mr-courses", "Science"), ("nav a[aria-current=page]", "My revenue")], "كل الكورسات", None),
    ("my-team.html?mock=1", "#mt-root h2", "فريقي", "My team",
     [("#mt-root", "Your assistants"), ("#mt-root", "Link Telegram"), ("nav", "RESULTS")], "مساعدينك", ("#mt-root input[type=tel]", "0123")),
]


def run_page(b, base, width, scheme, spec):
    path, ready, h1_ar, h1_en, labels, ar_back, typed = spec
    name = path.split(".")[0]
    tag = "%s %dpx %s: " % (name, width, scheme)
    ctx = new_ctx(b, base, width, scheme)
    pg = ctx.new_page()
    errors, dialogs = [], []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    pg.goto(base + "/dashboard/" + path)
    pg.wait_for_selector(ready, timeout=10000)
    check(tag + "Arabic, right to left on the first visit", pg.evaluate("[document.documentElement.lang, document.documentElement.dir]") == ["ar", "rtl"])
    check(tag + "Arabic title", pg.inner_text("h1") == h1_ar, pg.inner_text("h1"))
    check(tag + "language button next to the dark-mode button",
          pg.evaluate("(function(){var b=document.getElementById('lang-toggle'),t=document.getElementById('theme-toggle');return !!b&&b.nextElementSibling===t&&b.offsetWidth>0;})()"))
    check(tag + "the button offers English", pg.inner_text("#lang-toggle") == "EN")
    if name == "team":
        pg.click("#t-add-open"); pg.click("[data-kind=teacher]"); pg.fill("#t-phone", "01234567890")
        pg.locator(".t-subjects input[value=math]").check()
    if typed:
        pg.fill(typed[0], typed[1])
    pg.click("#lang-toggle")
    pg.wait_for_function("document.documentElement.dir === 'ltr'", timeout=3000)
    check(tag + "one tap: English, left to right", pg.evaluate("document.documentElement.lang") == "en")
    check(tag + "English title", pg.inner_text("h1") == h1_en, pg.inner_text("h1"))
    check(tag + "the button now offers Arabic", pg.inner_text("#lang-toggle") == "ع")
    for sel, text in labels:
        got = pg.inner_text(sel)
        check(tag + "English label in " + sel + ": " + text, text.lower() in got.lower(), got[:200])
    left = pg.evaluate("I18n.untranslated()")
    check(tag + "no Arabic left on screen (data aside)", not left, left[:8])
    check(tag + "page title in English", "Teaching" in pg.title() and not any("؀" <= c <= "ۿ" for c in pg.title()), pg.title())
    check(tag + "dark-mode button label in English", pg.get_attribute("#theme-toggle", "aria-label").startswith("Switch to"))
    wide = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    check(tag + "English: no sideways scroll", wide <= 1, wide)
    if typed:
        check(tag + "typed text kept after the switch", pg.input_value(typed[0]) == typed[1])
    if name == "followup":
        pg.locator(".fu-tab[data-tab]:not([data-tab='__none']):not([data-tab='__today'])").first.click()
        pg.wait_for_selector("#fu-q")
        check(tag + "group page in English", "Current lesson" in pg.inner_text("#fu-root") and "Students" in pg.inner_text("#fu-root"))
        pg.fill("#fu-q", "sara")
        left = pg.evaluate("I18n.untranslated()")
        check(tag + "group page: no Arabic left (data aside)", not left, left[:8])
        pg.click("#fu-help"); pg.wait_for_selector(".fu-sheet, #fu-close")
        left = pg.evaluate("I18n.untranslated()")
        check(tag + "help sheet in English", "How to use" in pg.inner_text("body") and not left, left[:8])
        pg.click("#fu-close")
        pg.click("#lang-toggle"); pg.wait_for_function("document.documentElement.dir === 'rtl'", timeout=3000)
        check(tag + "group page back in Arabic, search kept", "الحصة الحالية" in pg.inner_text("#fu-root") and pg.input_value("#fu-q") == "sara")
        pg.click("#lang-toggle"); pg.wait_for_function("document.documentElement.dir === 'ltr'", timeout=3000)
    if name == "requirements":
        pg.click("#rq-tab-groups")
        left = pg.evaluate("I18n.untranslated()")
        check(tag + "groups tab in English", "Group exceptions" in pg.inner_text("#rq-root") and not left, left[:8])
    if name == "team":
        check(tag + "typed phone kept after the switch", pg.input_value("#t-phone") == "01234567890")
        check(tag + "ticked subject kept after the switch", pg.locator(".t-subjects input[value=math]").is_checked())
        check(tag + "subject labels in English", "Programming" in pg.inner_text(".t-subjects"))
        check(tag + "the log keeps its data, words in English", "Before: Lesson: math/l1" in pg.inner_text("#t-log"), pg.inner_text("#t-log"))
        pg.click("[data-act=tg-unlink]")
        check(tag + "confirm asked in English", dialogs and dialogs[-1].startswith("Disconnect") and "Telegram" in dialogs[-1], dialogs)
    if name == "revenue":
        pg.click("[data-view=group]")
        check(tag + "group view: words in English, group names kept", "No group" in pg.inner_text("#rv-list") and "أولى ثانوي" in pg.inner_text("#rv-list"))
        check(tag + "still no Arabic outside data after a re-draw", not pg.evaluate("I18n.untranslated()"), pg.evaluate("I18n.untranslated()")[:8])
    shots = os.path.join(HERE, "_shots"); os.makedirs(shots, exist_ok=True)
    pg.screenshot(path=os.path.join(shots, "i18n_%s_en_%d_%s.png" % (name, width, scheme)), full_page=True)
    # remembered on this device
    pg.reload(); pg.wait_for_selector(ready, timeout=10000)
    check(tag + "remembered after a reload", pg.evaluate("document.documentElement.dir") == "ltr" and pg.inner_text("h1") == h1_en)
    other = "revenue.html?mock=1" if name != "revenue" else "team.html?mock=1"
    pg.goto(base + "/dashboard/" + other); pg.wait_for_selector("#lang-toggle", timeout=10000)
    check(tag + "another staff page opens in English", pg.evaluate("document.documentElement.lang") == "en")
    pg.goto(base + "/dashboard/" + path); pg.wait_for_selector(ready, timeout=10000)
    pg.click("#lang-toggle")
    pg.wait_for_function("document.documentElement.dir === 'rtl'", timeout=3000)
    check(tag + "back to Arabic: the exact Arabic title", pg.inner_text("h1") == h1_ar)
    check(tag + "back to Arabic: the rest in Arabic too", ar_back in pg.inner_text("body"))
    wide = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    check(tag + "Arabic: no sideways scroll", wide <= 1, wide)
    check(tag + "no page errors", not errors, errors)
    ctx.close()


def run_blocked(b, base):
    ctx = new_ctx(b, base, 390, "light", block_storage=True)
    pg = ctx.new_page(); errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(base + "/dashboard/team.html?mock=1"); pg.wait_for_selector("#t-people", timeout=10000)
    check("storage blocked: opens in Arabic", pg.evaluate("document.documentElement.dir") == "rtl")
    pg.click("#lang-toggle")
    check("storage blocked: the button still switches", pg.evaluate("document.documentElement.dir") == "ltr" and pg.inner_text("h1") == "Team")
    check("storage blocked: no page errors", not errors, errors)
    ctx.close()


def main():
    srv = serve(); base = "http://127.0.0.1:%d" % srv.server_address[1]
    with sync_playwright() as p:
        b = p.chromium.launch()
        for spec in PAGES:
            for width, scheme in ((1280, "light"), (390, "dark"), (390, "light")):
                run_page(b, base, width, scheme, spec)
        run_blocked(b, base)
        b.close()
    srv.shutdown()
    print("\n%d passed, %d failed" % (passed, failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
