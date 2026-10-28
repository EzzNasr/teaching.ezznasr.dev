#!/usr/bin/env python3
"""
e2e_p3_followup.py - real-browser tests for Phase 3 / S1 (follow-up core):
  flag-off banner, parent-contact chips + counter, contacted filter + sort (URL hash), monthly report contact state,
  "how the page knows what is required" guide.

    python tests/e2e_p3_followup.py          (run from tools/quiz-maker-v2)

Runs followup.html in ?mock=1 against dashboard/_fixtures/followup-overview.json (fake data). Nothing real is touched.
Fixture facts (today = Fri 2026-10-16, week Sat 10-10 .. Fri 10-16):
  Sat 6pm : pending Mariam, Omar, Hana | contacted Sara (custom note 15/10, nothing due) | none Nour  -> "1 من 4"
  Tue 4pm : pending Adham (old log, other lesson, Sept), Karim -> "0 من 2"
  Sun 8pm : pending Sara (different group, due items not logged), Ziad -> "0 من 2"
"""
import os
import re
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_followup as E  # static server, page factory, layout helpers
import e2e_p2_followup as P  # real_page (stub AuthEngine)

check = E.check
PAGE = "/dashboard/followup.html"


def names(page):
    return [n.strip() for n in page.locator("#fu-rows .fu-stu-name").all_inner_texts()]


def tab(page, label):
    page.locator(".fu-tab", has_text=label).click()
    page.wait_for_selector(".fu-stu")


def flags(parent, monthly):
    def m(d):
        d["flags"] = {"FF_PARENT_LOG": parent, "FF_MONTHLY": monthly}
    return m


def no_flags(d):
    d.pop("flags", None)


def main():
    srv, base = E.serve()
    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ================= contact chips, counter, filter, sort =================
        ctx, page, errors = E.new_page(browser, base)
        page.wait_for_selector(".fu-stu")
        check("no flag banner when both switches are on", page.locator("#fu-flag-banner").count() == 0)
        check("Sat 6pm counter says 1 of 4 contacted (pending 3 + contacted 1; «none» students not counted)", "1 من 4" in page.inner_text("#fu-contactline"), page.inner_text("#fu-contactline"))
        check("Sara (nothing due, contacted this week) shows ✅ تم التواصل with the date", "تم التواصل" in page.inner_text("#stu-1012345002 [data-chip='notified']") and "15/10" in page.inner_text("#stu-1012345002 [data-chip='notified']"))
        check("Mariam and Omar show ⭕ لم يتم التواصل", all("لم يتم التواصل" in page.inner_text("#stu-%s [data-chip='contact-pending']" % k) for k in ("1012345001", "1012345003")))
        check("Nour (nothing due, nobody contacted) shows no contact chip at all", page.locator("#stu-1012345004 [data-chip='contact-pending']").count() == 0 and page.locator("#stu-1012345004 [data-chip='notified']").count() == 0)
        check("filter chips and the sort chip exist", page.locator("[data-cfilter]").count() == 3 and page.locator("[data-sort='nc']").count() == 1)
        check("default order is untouched (roster order)", names(page) == ["Mariam Ahmed", "Sara Mahmoud", "Omar Khaled", "Nour Hassan", "Hana Sami"], names(page))

        page.click("[data-cfilter='pending']")
        check("«لم يتم التواصل» lists exactly Mariam, Omar, Hana", sorted(names(page)) == ["Hana Sami", "Mariam Ahmed", "Omar Khaled"], names(page))
        check("picking that filter turns the sort on by itself", page.get_attribute("[data-sort='nc']", "aria-pressed") == "true")
        check("the choice is in the URL hash", "cf=pending" in page.evaluate("location.hash") and "sort=nc" in page.evaluate("location.hash"), page.evaluate("location.hash"))
        page.click("[data-cfilter='contacted']")
        check("«تم التواصل» lists exactly Sara", names(page) == ["Sara Mahmoud"], names(page))
        page.click("[data-cfilter='all']")
        check("with the sort on and filter «الكل»: not contacted first, then nobody-to-call, then contacted", names(page)[-1] == "Sara Mahmoud" and names(page)[-2] == "Nour Hassan" and set(names(page)[:3]) == {"Mariam Ahmed", "Omar Khaled", "Hana Sami"}, names(page))
        page.click("[data-sort='nc']")
        check("turning the sort off restores roster order", names(page)[0] == "Mariam Ahmed" and names(page)[1] == "Sara Mahmoud", names(page))
        page.click("[data-cfilter='pending']")
        page.click("#stu-1012345001 .fu-stu-head")
        h = page.evaluate("location.hash")
        check("hash holds student and filter together", "student=1012345001" in h and "cf=pending" in h, h)
        check("no horizontal scroll (390)", E.no_hscroll(page))
        check("tap targets >= 48px with the contact controls", not E.small_targets(page), E.small_targets(page))
        check("no JS errors (contact)", not errors, errors)
        ctx.close()

        # a shared link restores the filter
        ctx, page, errors = E.new_page(browser, base)
        page.wait_for_selector(".fu-stu")
        page.goto(base + PAGE + "?mock=1#cf=pending&sort=nc")
        page.reload()
        page.wait_for_selector(".fu-stu")
        check("a link with #cf=pending&sort=nc opens already filtered", sorted(names(page)) == ["Hana Sami", "Mariam Ahmed", "Omar Khaled"] and page.get_attribute("[data-cfilter='pending']", "aria-pressed") == "true", names(page))
        ctx.close()

        # other groups: counters differ per group, and Sara is judged per group
        ctx, page, errors = E.new_page(browser, base)
        page.wait_for_selector(".fu-stu")
        tab(page, "Tue 4pm")
        check("Tue 4pm counter is 0 of 2", "0 من 2" in page.inner_text("#fu-contactline"), page.inner_text("#fu-contactline"))
        check("a contact about ANOTHER lesson, last month, does not clear Adham (still ⭕, date shown as 📨 20/9)", page.locator("#stu-1112345006 [data-chip='contact-pending']").count() == 1 and "20/9" in page.inner_text("#stu-1112345006 [data-chip='notified']"))
        tab(page, "Sun 8pm")
        check("Sara is ⭕ in Sun 8pm (due items there are not logged) though ✅ in Sat 6pm", page.locator("#stu-1012345002 [data-chip='contact-pending']").count() == 1)
        ctx.close()

        # ================= logging a contact moves the chip and the counter =================
        ctx, page, errors = E.new_page(browser, base)
        page.wait_for_selector(".fu-stu")
        P.stub_browser_apis(page)
        page.click("#stu-1012345001 .fu-stu-head")
        page.locator("#stu-1012345001 .fu-btn.wa").click()
        page.wait_for_selector("#fu-log-send")
        page.click("#fu-log-send")
        page.wait_for_function("document.querySelector('#fu-log-send') && document.querySelector('#fu-log-send').textContent.includes('اتسجّل')")
        page.click("#fu-close")
        page.wait_for_selector("#fu-contactline")
        check("after logging, Mariam turns ✅ and the counter becomes 2 of 4", "2 من 4" in page.inner_text("#fu-contactline") and page.locator("#stu-1012345001 [data-chip='contact-pending']").count() == 0 and "تم التواصل" in page.inner_text("#stu-1012345001 [data-chip='notified']"), page.inner_text("#fu-contactline"))
        page.click("[data-cfilter='pending']")
        check("and she leaves the «not contacted» list", "Mariam Ahmed" not in names(page), names(page))
        check("no JS errors (log)", not errors, errors)
        ctx.close()

        # ================= flags: honest banner =================
        ctx, page, errors = E.new_page(browser, base, mutate=flags(False, False))
        page.wait_for_selector(".fu-stu")
        b = page.inner_text("#fu-flag-banner")
        check("both flags off: banner names FF_PARENT_LOG and FF_MONTHLY and says where to set them", "FF_PARENT_LOG" in b and "FF_MONTHLY" in b and "Script Properties" in b, b)
        check("both flags off: no contact chips, counter, filters or monthly button", all(page.locator(s).count() == 0 for s in ("#fu-contactline", "[data-cfilter]", "[data-sort]", "[data-chip='contact-pending']", "[data-chip='notified']", "#fu-monthly")))
        check("banner has a refresh button", page.locator("#fu-flag-reload").count() == 1)
        check("banner fits 390px and its button is >= 48px", E.no_hscroll(page) and not [x for x in E.small_targets(page) if "fu-flag" in x], E.small_targets(page))
        ctx.close()
        ctx, page, errors = E.new_page(browser, base, mutate=flags(True, False))
        page.wait_for_selector(".fu-stu")
        b = page.inner_text("#fu-flag-banner")
        check("only FF_MONTHLY off: banner names just that one; contact UI still works", "FF_MONTHLY" in b and "FF_PARENT_LOG" not in b and page.locator("[data-cfilter]").count() == 3 and page.locator("#fu-monthly").count() == 0, b)
        ctx.close()
        # LIVE path: no `flags` in the answer -> nothing is assumed on, nothing invented
        ctx, pg, errors = P.real_page(browser, base, PAGE, mutate=no_flags)
        pg.wait_for_selector(".fu-stu")
        check("live path never defaults a flag to on (no flags in the answer -> no log UI, no monthly button)", all(pg.locator(s).count() == 0 for s in ("[data-cfilter]", "#fu-monthly", "#fu-contactline")))
        ctx.close()
        # a server that says "Feature disabled" gives the actionable text, not a bare error
        ctx, pg, errors = P.real_page(browser, base, PAGE)
        pg.wait_for_selector(".fu-stu")
        pg.evaluate("""() => { const o = AuthEngine.adminCall; AuthEngine.adminCall = (s, p) => p.action === 'admin_log_parent_notification'
          ? Promise.resolve({ ok: false, error: 'Feature disabled: FF_PARENT_LOG', disabled: true }) : o(s, p); }""")
        pg.click("#stu-1012345001 .fu-stu-head")
        pg.locator("#stu-1012345001 .fu-btn.wa").click()
        pg.wait_for_selector("#fu-log-send")
        pg.click("#fu-log-send")
        pg.wait_for_selector(".fu-toast")
        tt = pg.inner_text(".fu-toast")
        check("a «Feature disabled» reply becomes a message naming the Script Property to set", "FF_PARENT_LOG" in tt and "Script Properties" in tt, tt)
        check("and the student stays ⭕ (nothing was saved)", pg.locator("#stu-1012345001 [data-chip='contact-pending']").count() == 1)
        ctx.close()

        # ================= monthly report =================
        ctx, page, errors = E.new_page(browser, base)
        page.wait_for_selector(".fu-stu")
        P.stub_browser_apis(page)
        page.click("#fu-monthly")
        page.wait_for_selector("[data-review]")
        check("monthly: every student starts ⭕ for the current month", page.locator("[data-contact='pending']").count() == 5 and page.locator("[data-contact='sent']").count() == 0)
        check("monthly: counter reads 0 of 5", "0 من 5" in page.inner_text("#fu-monthly-count"), page.inner_text("#fu-monthly-count"))
        page.locator("[data-open-review='1012345002']").click()
        page.wait_for_selector("#fu-month-sent")
        page.click("#fu-month-sent")
        page.wait_for_function("document.querySelector('#fu-month-status') && document.querySelector('#fu-month-status').textContent.includes('اتبعت')")
        page.click("#fu-month-back")
        page.wait_for_selector("[data-review]")
        check("monthly: after «تم الإرسال» Sara is ✅ and the counter is 1 of 5", page.locator("[data-review='1012345002'] [data-contact='sent']").count() == 1 and "1 من 5" in page.inner_text("#fu-monthly-count"))
        page.click("[data-mfilter='pending']")
        order = [e.get_attribute("data-review") for e in page.locator("[data-review]").all()]
        check("monthly: filter «لم يتم التواصل» hides Sara and keeps the other four", len(order) == 4 and "1012345002" not in order, order)
        page.click("[data-mfilter='contacted']")
        check("monthly: filter «تم التواصل» shows only Sara", [e.get_attribute("data-review") for e in page.locator("[data-review]").all()] == ["1012345002"])
        page.click("[data-mfilter='all']")
        order = [e.get_attribute("data-review") for e in page.locator("[data-review]").all()]
        check("monthly: choosing «لم يتم التواصل» switched the sort on, so with «الكل» the contacted student is last", order[-1] == "1012345002" and len(order) == 5 and page.get_attribute("[data-msort='nc']", "aria-pressed") == "true", order)
        page.click("[data-msort='nc']")
        order = [e.get_attribute("data-review") for e in page.locator("[data-review]").all()]
        check("monthly: turning the sort off restores roster order", order == ["1012345001", "1012345002", "1012345003", "1012345004", "1012345005"], order)
        # month boundary: a report sent for October is NOT a report sent for September
        page.select_option("#fu-month", "2026-09")
        page.wait_for_selector("[data-review]")
        check("monthly month boundary: for September everyone is ⭕ again (Sara's October report does not count)", page.locator("[data-contact='sent']").count() == 0 and "0 من 5" in page.inner_text("#fu-monthly-count"))
        page.select_option("#fu-month", "2026-10")
        page.wait_for_selector("[data-review]")
        check("monthly month boundary: back to October Sara is ✅ again", page.locator("[data-review='1012345002'] [data-contact='sent']").count() == 1)
        page.click("[data-mfilter='contacted']")
        page.click("#fu-monthly-copy-all")
        copied = page.evaluate("window.__copied") or ""
        check("monthly: «نسخ كل الرسائل» copies all 5 students even when the list is filtered", copied.count("———") == 4, copied.count("———"))
        check("monthly sheet: no horizontal scroll and tap targets >= 48px", E.no_hscroll(page) and not E.small_targets(page), E.small_targets(page))
        check("no JS errors (monthly)", not errors, errors)
        ctx.close()

        # ================= "how it knows what is required" =================
        ctx, page, errors = E.new_page(browser, base)
        page.wait_for_selector(".fu-stu")
        page.click("#fu-info-required")
        page.wait_for_selector("#fu-help-required")
        t = page.inner_text(".fu-sheet")
        check("the ℹ️ link opens the guide with the required-rule steps and a worked example", page.locator("#fu-help-example").count() == 1 and "نفس رقم الطالب" in t and "الواجب مطلوب" in t and "الميعاد عدّى" in t, t[:200])
        check("the guide still contains the original usage steps and messaging rules", "مفيش بوتات" in t and page.locator(".fu-guide li").count() == 6)
        page.click("#fu-close")
        page.click("#stu-1012345001 .fu-stu-head")
        page.locator("#stu-1012345001 [data-info='required']").first.click()
        page.wait_for_selector("#fu-help-required")
        check("the ℹ️ next to a «missing» chip opens the same guide", page.locator("#fu-help-required").count() == 1)
        page.click("#fu-close")
        page.click("#fu-help")
        page.wait_for_selector(".fu-sheet")
        check("the top-bar help button still opens the normal guide (guide also at the end)", page.locator("#fu-help-required").count() == 1 and page.locator(".fu-guide li").count() == 6)
        check("no JS errors (help)", not errors, errors)
        ctx.close()

        # ================= RTL / dark spot checks on the new controls =================
        ctx, page, errors = E.new_page(browser, base, width=1280, height=900, dark=True)
        page.wait_for_selector(".fu-stu")
        check("desktop 1280 dark: contact controls render, no horizontal scroll", page.locator("[data-cfilter]").count() == 3 and E.no_hscroll(page))
        check("html is rtl", page.evaluate("document.documentElement.dir") == "rtl")
        ctx.close()
        browser.close()
    srv.shutdown()
    print("\n%d passed, %d failed" % (E.passed, E.failed))
    return 1 if E.failed else 0


if __name__ == "__main__":
    sys.exit(main())
