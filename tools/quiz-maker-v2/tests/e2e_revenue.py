#!/usr/bin/env python3
"""
e2e_revenue.py - real-browser (Chromium) test for dashboard/revenue.html («الإيرادات») in ?mock=1 mode.

Main view: this month's approved website revenue against last month, what is waiting for approval, all time,
then where the money came from (by lesson / month / group, any month), and the lesson price with the one-time
"fill in old lesson payments at today's price" button (option C). Desktop and phone, light and dark.

    python tests/e2e_revenue.py        (run from tools/quiz-maker-v2)
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


def names(pg):
    return pg.eval_on_selector_all("#rv-list .rv-row", "rs => rs.map(r => [r.querySelector('.rv-name').textContent, r.querySelector('.rv-amt').textContent])")


def run(b, base, width, scheme):
    ctx = b.new_context(viewport={"width": width, "height": 900}, color_scheme=scheme)
    ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith(base) else r.abort())
    pg = ctx.new_page()
    errors, dialogs = [], []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
    pg.goto(base + "/dashboard/revenue.html?mock=1")
    pg.wait_for_selector("#rv-hero", timeout=10000)
    tag = "%dpx %s: " % (width, scheme)
    check(tag + "page is Arabic, right to left", pg.evaluate("document.documentElement.dir") == "rtl")
    check(tag + "mock badge shown", pg.locator("#rv-mock").is_visible())
    hero = pg.inner_text("#rv-hero")
    check(tag + "main number: this month's revenue", "4,250 جنيه" in pg.inner_text("#rv-now") and "نوفمبر 2026" in hero, hero)
    check(tag + "compared with last month", "أكتوبر 2026" in hero and "2,250 جنيه" in hero and "زيادة" in hero, hero)
    check(tag + "waiting for approval links to the access page", pg.locator("a#rv-pending[href='access.html']").count() == 1 and "دفعتين" in pg.inner_text("#rv-pending"))
    check(tag + "the counting rule is said in plain words", "مش محسوب" in pg.inner_text(".rv-rule") and "السنتر" in pg.inner_text(".rv-rule"))
    # by lesson, this month (the default)
    check(tag + "opens on this month", pg.eval_on_selector("#rv-month", "s => s.value") == "2026-11")
    rows = names(pg)
    check(tag + "by lesson: biggest first, subscriptions named in Arabic", rows and rows[0][0] == "أولى ثانوي · اشتراك الفصل 3" and rows[0][1] == "2,250 جنيه", rows)
    check(tag + "a single lesson shows its title from the lesson list", any("Information and Media" in r[0] for r in rows), rows)
    check(tag + "a lesson with no amount says so", "من غير مبلغ" in pg.inner_text("#rv-list"))
    check(tag + "total row", "4,250 جنيه" in pg.inner_text(".rv-total"))
    pg.locator("#rv-month").select_option("")
    check(tag + "all time: more items", len(names(pg)) == 6, names(pg))
    # by month
    pg.locator("[data-view=month]").click()
    rows = names(pg)
    check(tag + "by month: newest first", [r[0] for r in rows] == ["نوفمبر 2026", "أكتوبر 2026", "سبتمبر 2026"], rows)
    check(tag + "no month picker in the month view", pg.locator("#rv-month").count() == 0)
    # by group
    pg.locator("[data-view=group]").click()
    rows = names(pg)
    check(tag + "by group: students without a group are grouped too", any(r[0] == "من غير جروب" for r in rows), rows)
    check(tag + "by group: the biggest group first", rows[0][0] == "أولى ثانوي — السبت", rows)
    # lesson price + option C
    check(tag + "no price yet: says lesson payments are not counted", "لسه ما حددتش سعر الدرس" in pg.inner_text("#rv-price-card"))
    check(tag + "old lessons without an amount are pointed out", "6 دفعات" in pg.inner_text("#rv-fill"), pg.inner_text("#rv-fill"))
    pg.locator("#rv-price").fill(""); pg.locator("#rv-price-save").click()
    pg.wait_for_selector("#rv-price-card .rv-msg.err", timeout=3000)
    check(tag + "empty price: asks for it", "اكتب سعر الدرس" in pg.inner_text("#rv-price-card .rv-msg"))
    pg.locator("#rv-price").fill("60"); pg.locator("#rv-price-save").click()
    pg.wait_for_selector("#rv-fill-go", timeout=3000)
    check(tag + "price saved, said in plain words", "سعر الدرس 60 جنيه" in pg.inner_text("#rv-price-card"))
    check(tag + "fill button names the count and the price", "6 × 60 جنيه" in pg.inner_text("#rv-fill-go"), pg.inner_text("#rv-fill-go"))
    pg.locator("#rv-fill-go").click()
    pg.wait_for_function("!document.getElementById('rv-fill')", timeout=3000)
    check(tag + "fill asks first", dialogs and "مرة واحدة" in dialogs[-1], dialogs)
    check(tag + "after filling, this month includes the lessons", "4,430 جنيه" in pg.inner_text("#rv-now"), pg.inner_text("#rv-now"))
    check(tag + "done message", "اتحسبت 6 دفعات" in pg.inner_text("#rv-price-card"))
    check(tag + "link to the teacher numbers", pg.locator("a[href='teacher-stats.html']").count() == 1)
    check(tag + "menu marks this page", pg.locator("nav a[aria-current=page]").inner_text() == "الإيرادات")
    wide = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    check(tag + "no sideways scroll", wide <= 1, wide)
    shots = os.path.join(HERE, "_shots"); os.makedirs(shots, exist_ok=True)
    pg.screenshot(path=os.path.join(shots, "revenue_%d_%s.png" % (width, scheme)), full_page=True)
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
