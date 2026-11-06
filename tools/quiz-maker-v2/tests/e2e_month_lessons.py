#!/usr/bin/env python3
"""
e2e_month_lessons.py -- the monthly review's "required lessons" menu and the mass send, real Chromium, 390px phone,
?mock=1 only (nothing leaves the machine).

  - the card says which list a group follows (none / general / its own)
  - the menu: tick lessons (homework + quiz required), switch the quiz or the homework off, save the GENERAL list
  - a group: read-only "follows the general list", then "make a list for this group" (starts from the general), save,
    then "back to the general list" (the group's list is removed)
  - the send: counts before sending, TEST by default (also when the phone is live), one enqueue per group with
    event "monthly" and send_to "test"; "all groups" loads every group; "parents" only when the phone is live
  - no sideways scroll, tap targets >= 44px, no JS errors; screenshots with --shots DIR

    python tests/e2e_month_lessons.py [--shots DIR]      (run from tools/quiz-maker-v2)
"""
import os
import re
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_followup as E  # the static server and the page factory

G1 = "programming/baccalaureate/grade-1-secondary/"
VARS, LOOPS = G1 + "chapter-2-lesson-1-variables", G1 + "chapter-1-lesson-4-loops"
SHOTS = sys.argv[sys.argv.index("--shots") + 1] if "--shots" in sys.argv else None
check = E.check


def calls(page, action=None):
    c = page.evaluate("window.__fuMockCalls || []")
    return [x for x in c if action is None or x.get("action") == action]


def shot(page, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.wait_for_timeout(600)   # the sheet fades in
        page.screenshot(path=os.path.join(SHOTS, name))


def small(page, scope):
    return page.evaluate("""(scope) => { const bad=[]; const root=document.querySelector(scope); if(!root) return ['no '+scope];
      root.querySelectorAll('button,a[href],select,input:not([type=checkbox])').forEach(e=>{
        const r=e.getBoundingClientRect(); if(!r.width||!r.height) return;
        if(r.height<43.5||r.width<43.5) bad.push((e.id||e.className||e.tagName)+' '+Math.round(r.width)+'x'+Math.round(r.height)); });
      return bad; }""", scope)


def confirm(page):
    page.wait_for_selector(".fu-dialog")
    page.click(".fu-dialog .fu-btn.primary")


def open_monthly(browser, base, extra):
    ctx, page, errors = E.new_page(browser, base, url_extra="?mock=1" + extra)
    page.wait_for_selector(".fu-stu", timeout=15000)
    page.click("#fu-monthly")
    page.wait_for_selector("#fu-mplan")
    page.wait_for_selector("[data-review]")
    return ctx, page, errors


def source(page):
    page.wait_for_selector("#fu-mplan-source")
    return page.get_attribute("#fu-mplan-source", "data-source")


def main():
    srv, base = E.serve()
    with sync_playwright() as p:
        b = p.chromium.launch()

        # ================= the menu =================
        ctx, page, errors = open_monthly(b, base, "&wa=live")
        check("card: nothing chosen yet -> 'none', the weekly lessons are used", source(page) == "none" and "الأسبوعية" in page.inner_text("#fu-mplan"), page.inner_text("#fu-mplan"))
        page.click("#fu-mplan-edit")
        page.wait_for_selector("#fu-medit")
        check("menu opens on the GENERAL list", page.get_attribute("[data-scope='general']", "aria-checked") == "true")
        check("menu lists the lessons by folder, none ticked", page.locator("#fu-medit-list input[type=checkbox]").count() >= 3 and page.locator("#fu-medit-list input:checked").count() == 0)
        check("no Save button to forget, nothing sent before a change", page.locator("#fu-medit-save").count() == 0 and not calls(page, "admin_req_month_save"))
        page.check("input[data-lesson='%s']" % VARS)
        page.check("input[data-lesson='%s']" % LOOPS)
        row = "[data-row='%s']" % LOOPS
        check("ticking a lesson shows homework + quiz, both required", page.get_attribute(row + " [data-part='homework']", "aria-pressed") == "true" and page.get_attribute(row + " [data-part='quiz']", "aria-pressed") == "true")
        page.click(row + " [data-part='quiz']")
        check("the quiz can be switched off on its own", page.get_attribute(row + " [data-part='quiz']", "aria-pressed") == "false" and page.get_attribute(row + " [data-part='homework']", "aria-pressed") == "true")
        check("the count line follows: 2 lessons, 2 homework, 1 quiz", "2 درس · 2 واجب · 1 كويز" in page.inner_text("#fu-medit-count"), page.inner_text("#fu-medit-count"))
        page.fill("#fu-medit-q", "loops")
        check("search keeps only the matching lessons", page.locator("#fu-medit-list input[type=checkbox]").count() == 1)
        page.fill("#fu-medit-q", "")
        check("menu: no sideways scroll, tap targets ok", E.no_hscroll(page) and not small(page, "#fu-medit"), small(page, "#fu-medit"))
        shot(page, "month-1-menu.png")
        page.wait_for_selector("#fu-medit-status[data-state='saved']")
        sv = calls(page, "admin_req_month_save")
        les = (sv[-1].get("lessons") if sv else None) or []
        check("every change is saved by itself: the last save is the general list with the two lessons and the quiz off",
              len(sv) >= 1 and all(x.get("group") == "" for x in sv) and sorted((l["lesson"], l["homework"], l["quiz"]) for l in les) == sorted([(VARS, True, True), (LOOPS, True, False)]), sv)
        check("the menu says it is saved", "اتحفظ" in page.inner_text("#fu-medit-status"))
        # the reported bug: ticks made, menu closed with X (no button pressed), list must still be there
        page.click("#fu-close")
        page.click("#fu-monthly")
        page.wait_for_selector("#fu-mplan-source[data-source='general']")
        check("card: Sat 6pm now follows the general list, 2 lessons · 2 homework · 1 quiz", "2 درس · 2 واجب · 1 كويز" in page.inner_text("#fu-mplan-counts"), page.inner_text("#fu-mplan"))
        shot(page, "month-2-card.png")

        # ---- a list for this group ----
        page.click("#fu-mplan-edit")
        page.wait_for_selector("#fu-medit")
        page.click("[data-scope='group']")
        page.wait_for_selector("#fu-medit-where[data-own='0']")
        check("group: says it follows the general list, lessons shown read-only", "ماشية على القائمة العامة" in page.inner_text("#fu-medit-where") and page.is_disabled("input[data-lesson='%s']" % VARS) and page.is_checked("input[data-lesson='%s']" % VARS))
        page.click("#fu-medit-fork")
        page.wait_for_selector("#fu-medit-where[data-own='new'], #fu-medit-where[data-own='1']")
        check("make own list: starts from the general list, editable", page.is_checked("input[data-lesson='%s']" % LOOPS) and not page.is_disabled("input[data-lesson='%s']" % LOOPS))
        page.uncheck("input[data-lesson='%s']" % LOOPS)
        page.click("[data-row='%s'] [data-part='homework']" % VARS)
        page.wait_for_selector("#fu-medit-status[data-state='saved']")
        page.click("#fu-medit-back")
        page.wait_for_selector("#fu-mplan-source[data-source='group']")
        sv = calls(page, "admin_req_month_save")[-1]
        check("save: the group's own list (Sat 6pm), one lesson with the homework off", sv.get("group") == "Sat 6pm" and [(l["lesson"], l["homework"], l["quiz"]) for l in sv.get("lessons", [])] == [(VARS, False, True)], sv)
        check("card: 'own list', 1 lesson · 0 homework · 1 quiz", "1 درس · 0 واجب · 1 كويز" in page.inner_text("#fu-mplan-counts"), page.inner_text("#fu-mplan"))
        page.click("#fu-mplan-edit")
        page.wait_for_selector("#fu-medit-where[data-own='1']")
        check("menu opens on the group's own list and says the general list does not affect it", page.get_attribute("[data-scope='group']", "aria-checked") == "true" and "بدل العام" in page.inner_text("#fu-medit-where"))
        page.click("[data-scope='general']")
        check("the general list says which groups have their own", "Sat 6pm" in page.inner_text("#fu-medit-where"), page.inner_text("#fu-medit-where"))
        page.click("[data-scope='group']")
        page.click("#fu-medit-inherit")
        confirm(page)
        page.wait_for_selector("#fu-mplan-source[data-source='general']")
        sv = calls(page, "admin_req_month_save")[-1]
        check("back to the general list: clear:true for Sat 6pm", sv.get("group") == "Sat 6pm" and sv.get("clear") is True, sv)
        check("no JS errors (menu)", not errors, errors)

        # ================= the send (phone live) =================
        page.click("#fu-monthly-send")
        page.wait_for_selector("#fu-msend-go")
        cnt = {t.get_attribute("data-count"): int(t.inner_text().split("\n")[0]) for t in page.locator("#fu-msend-counts [data-count]").all()}
        check("preview counts: students = ready + held + already; complete + missing = ready",
              cnt.get("students") == 5 and cnt["ready"] + cnt["held"] + cnt["already"] == 5 and cnt["complete"] + cnt["missing"] == cnt["ready"] and cnt["ready"] >= 1, cnt)
        check("TEST is picked by default even though the phone is live", page.get_attribute("[data-dest='test']", "aria-checked") == "true" and not page.is_disabled("[data-dest='parents']"))
        check("nothing queued before Send", not calls(page, "admin_fu2_wa_enqueue"))
        check("send: no sideways scroll, tap targets ok", E.no_hscroll(page) and not small(page, "#fu-msend"), small(page, "#fu-msend"))
        shot(page, "month-3-send.png")
        page.click("#fu-msend-go")
        confirm(page)
        page.wait_for_selector("#fu-msend-done")
        q = calls(page, "admin_fu2_wa_enqueue")
        it = (q[0].get("items") if q else None) or []
        check("one enqueue: event monthly, send_to test, the group, one item per ready student",
              len(q) == 1 and q[0].get("event") == "monthly" and q[0].get("send_to") == "test" and q[0].get("group") == "Sat 6pm" and len(it) == cnt["ready"], q)
        check("each item: parent digits, the report text, log item monthly/<month>",
              all(re.match(r"^[1-9]\d{10,14}$", x.get("to", "")) and x.get("text") and x.get("log_items") == [{"kind": "monthly", "ref": q[0]["items"][0]["log_items"][0]["ref"]}] for x in it)
              and re.match(r"^\d{4}-\d{2}$", it[0]["log_items"][0]["ref"]), it[:1])
        check("done screen says TEST", page.get_attribute("#fu-msend-done", "data-mode") == "test" and "رقمك" in page.inner_text("#fu-msend-done"))
        shot(page, "month-4-queued.png")
        page.click("#fu-msend-back")
        page.wait_for_selector("#fu-monthly-send")
        page.click("#fu-monthly-send")
        page.wait_for_selector("#fu-msend-go")
        page.click("[data-sscope='all']")
        page.wait_for_selector("#fu-msend-groups")
        n_all = int(page.inner_text("#fu-msend-counts [data-count='students'] b"))
        check("all groups: every group loaded and listed, more students than one group", page.locator("#fu-msend-groups li").count() == 3 and n_all > 5, (n_all, page.inner_text("#fu-msend-groups")))
        page.click("[data-dest='parents']")
        check("parents picked: the button says it is not a test", "تجربة" not in page.inner_text("#fu-msend-go"), page.inner_text("#fu-msend-go"))
        before = len(calls(page, "admin_fu2_wa_enqueue"))
        page.click("#fu-msend-go")
        confirm(page)
        page.wait_for_selector("#fu-msend-done")
        q2 = calls(page, "admin_fu2_wa_enqueue")[before:]
        check("all groups + parents: one enqueue per group with ready students, send_to parents", len(q2) >= 2 and all(x.get("send_to") == "parents" and x.get("event") == "monthly" for x in q2) and len({x.get("group_key") for x in q2}) == len(q2), [(x.get("group"), x.get("send_to")) for x in q2])
        check("done screen says live", page.get_attribute("#fu-msend-done", "data-mode") == "live")
        check("no JS errors (send)", not errors, errors)
        ctx.close()

        # ================= the phone in test mode / switched off =================
        ctx, page, errors = open_monthly(b, base, "&wa=1")
        page.click("#fu-monthly-send")
        page.wait_for_selector("#fu-msend-go")
        check("phone in TEST mode: 'parents' cannot be picked, the note says everything goes to my number", page.is_disabled("[data-dest='parents']") and "وضع التجربة" in page.inner_text("#fu-msend-mode"))
        ctx.close()
        ctx, page, errors = open_monthly(b, base, "")
        page.click("#fu-monthly-send")
        page.wait_for_selector("#fu-msend-nophone")
        check("phone off / older server: says so, no send button", page.locator("#fu-msend-go").count() == 0)
        check("no JS errors (phone off)", not errors, errors)
        ctx.close()

        # ================= an older server (no month lists) =================
        ctx, page, errors = E.new_page(b, base, url_extra="?mock=1&wa=live&oldserver=1")
        page.wait_for_selector(".fu-stu", timeout=15000)
        page.click("#fu-monthly")
        page.wait_for_selector("#fu-mplan-off")
        check("older server: the card says Apps Script needs the update, and there is NO mass-send button (it would ignore send_to)",
              page.locator("#fu-monthly-send").count() == 0 and page.locator("#fu-mplan-edit").count() == 0 and page.locator("[data-review]").count() == 5)
        check("no JS errors (older server)", not errors, errors)
        ctx.close()

        # ================= dark theme =================
        ctx, page, errors = E.new_page(b, base, dark=True, url_extra="?mock=1&wa=live")
        page.wait_for_selector(".fu-stu", timeout=15000)
        page.click("#fu-monthly")
        page.wait_for_selector("#fu-mplan-edit")
        page.click("#fu-mplan-edit")
        page.check("input[data-lesson='%s']" % VARS)
        shot(page, "month-5-menu-dark.png")
        bg = page.evaluate("getComputedStyle(document.querySelector('.fu-medit-row.on')).backgroundColor")
        check("dark: the ticked row is not a white box", bg not in ("rgb(255, 255, 255)",), bg)
        ctx.close()
        b.close()
    srv.shutdown()
    print("\n%d passed, %d failed" % (E.passed if hasattr(E, "passed") else 0, E.failed if hasattr(E, "failed") else 0))
    sys.exit(1 if getattr(E, "failed", 0) else 0)


if __name__ == "__main__":
    main()
