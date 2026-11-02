#!/usr/bin/env python3
"""
e2e_student_summary_requirements.py - the Requirements card on dashboard/student-summary.html (?mock=1, phone width):
live summary card, monthly card, saved-snapshot note, month with no snapshot.

    python tests/e2e_student_summary_requirements.py        (run from tools/quiz-maker-v2)
"""
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_followup as E

check = E.check


def main():
    srv, base = E.serve()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx, page, errors = E.new_page(browser, base, width=390) if "width" in E.new_page.__code__.co_varnames else E.new_page(browser, base)
        page.set_viewport_size({"width": 390, "height": 800})
        page.goto(base + "/dashboard/student-summary.html?mock=1&student=1012345001")
        page.wait_for_selector("#ss-student")
        check("the live summary has a Requirements card", page.locator("#ss-requirements").count() == 1)
        txt = page.inner_text("#ss-requirements")
        check("it lists each requirement with met / expected", "الواجب" in txt and "7 / 9" in txt and "9 / 9" in txt, txt)
        check("a manual requirement shows its state and note", "تمّ" in txt and "ممتاز" in txt, txt)
        check("the compliance percentage and the source are shown", "81%" in page.inner_text("#ss-requirements-compliance") and page.locator("#ss-requirements-source").count() == 1)
        check("one progress bar per item", page.locator("#ss-requirements .ss-req-bar").count() == 4)
        wide = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        check("390px: no sideways scroll", wide <= 1, wide)
        page.click("#ss-monthly")
        page.wait_for_selector("#ss-month-requirements")
        check("the monthly report shows the requirements too", "7 / 9" in page.inner_text("#ss-month-requirements") and page.locator("#ss-month-requirements-snapshot").count() == 0)
        check("no JS errors", not errors, errors)
        ctx.close()
        browser.close()
    srv.shutdown()
    print("\n%d passed, %d failed" % (E.passed, E.failed))
    return 1 if E.failed else 0


if __name__ == "__main__":
    sys.exit(main())
