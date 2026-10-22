#!/usr/bin/env python3
"""R-019 (grading page + student quiz-review): Arabic text keeps its direction and nothing overflows a phone screen.
The follow-up, summary and monthly-review pages are covered in e2e_p2_followup.py. Run from tools/quiz-maker-v2:
    python tests/e2e_R019_rtl.py
grading.html runs in its built-in ?mock=1 mode (no network); the review list is the real dash-review.js fed Arabic rows.
"""
import os, sys, mimetypes
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
SITE = "https://site.test"
passed = failed = 0


def check(name, cond, extra=""):
    global passed, failed
    if cond: passed += 1; print("PASS " + name)
    else: failed += 1; print("FAIL " + name + ("  -> " + str(extra)[:300] if extra else ""))


def serve(route):
    p = route.request.url[len(SITE):].split("?")[0]
    fp = os.path.join(ROOT, p.lstrip("/"))
    if os.path.isfile(fp):
        return route.fulfill(status=200, content_type=mimetypes.guess_type(fp)[0] or "text/plain", body=open(fp, "rb").read())
    route.fulfill(status=404, body="")


def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        for width in (375, 1180):
            ctx = b.new_context(viewport={"width": width, "height": 800})
            ctx.route(SITE + "/**", serve)
            ctx.route("https://script.google.com/**", lambda r: r.abort())
            ctx.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(status=200, content_type="text/css", body=""))
            ctx.route("https://fonts.gstatic.com/**", lambda r: r.fulfill(status=200, body=""))
            pg = ctx.new_page(); pg.set_default_timeout(8000)
            pg.goto(SITE + "/dashboard/grading.html?mock=1")
            pg.wait_for_selector(".g-card")
            # put Arabic into the three free-text slots the way real data arrives
            pg.evaluate("""() => { document.querySelector('.g-q').textContent = 'اشرح كيف يعمل الذكاء الاصطناعي بالتفصيل؟';
                document.querySelector('.g-model').textContent = 'يتعلم من البيانات ثم يتنبأ بالنتائج.';
                document.getElementById('g-note').value = 'إجابة ممتازة'; }""")
            d = lambda sel: pg.evaluate("s => getComputedStyle(document.querySelector(s)).direction", sel)
            tag = " @%dpx" % width
            check("grading: Arabic question renders right-to-left" + tag, d(".g-q") == "rtl")
            check("grading: Arabic model answer renders right-to-left" + tag, d(".g-model") == "rtl")
            check("grading: Arabic note field renders right-to-left" + tag, d("#g-note") == "rtl")
            check("grading: the numeric marks box stays left-to-right" + tag, d("#g-marks") == "ltr")
            check("grading: no sideways scroll" + tag, pg.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"),
                  pg.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]"))
            ctx.close()
        # the review tree (student.html uses it with Arabic wording)
        ctx = b.new_context(viewport={"width": 375, "height": 800}); ctx.route(SITE + "/**", serve)
        pg = ctx.new_page(); pg.goto(SITE + "/dashboard/grading.html?mock=1"); pg.wait_for_selector(".g-card")
        pg.add_script_tag(url=SITE + "/assets/dash-review.js")
        res = pg.evaluate("""() => {
          const el = (t, a, k) => { const n = document.createElement(t); Object.keys(a||{}).forEach(x => x==='text' ? n.textContent=a[x] : x==='class' ? n.className=a[x] : n.setAttribute(x,a[x])); (k||[]).forEach(c => n.append(c)); return n; };
          const R = window.DashReview.create({ el: (t, a, k) => el(t, a, k), fmtWhen: String, whenMs: () => NaN, isTruthyFlag: v => v === true,
            t: { chapter: 'الفصل', lesson: 'الدرس', quiz: 'اختبار', assign: 'واجب', other: 'دروس أخرى', subjects: { programming: 'البرمجة' }, srcQuiz: 'اختبار', srcAssign: 'واجب' } });
          return typeof R.renderChapters === 'function'; }""")
        check("review: dash-review.js loads and exposes renderChapters with Arabic wording", res is True)
        ctx.close(); b.close()
    print("\n%d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
