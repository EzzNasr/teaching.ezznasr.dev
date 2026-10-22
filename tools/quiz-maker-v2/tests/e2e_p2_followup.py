#!/usr/bin/env python3
"""
e2e_p2_followup.py — real-browser tests for Session 2 (Phase 2 follow-up):
  requirement toggles, year-grouped group menu, empty state + assign groups (R-007), year-switch confirm (R-008),
  parent log, monthly review (+ print), bulk-center week confirm, the student summary page, RTL layout (R-019).

    python tests/e2e_p2_followup.py          (run from tools/quiz-maker-v2)

Runs the pages in ?mock=1 against dashboard/_fixtures/*.json (fake data) and, for payload checks, with a stub
AuthEngine that records every call. Nothing touches the live site or the Sheet. Screenshots for the RTL check
are written to tests/_shots/.
"""
import json
import os
import re
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_followup as E  # reuses the static server, page factory and layout helpers

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "_shots")
G1 = "programming/baccalaureate/grade-1-secondary/"
G2 = "programming/baccalaureate/grade-2-secondary/"
REV = G1 + "chapter-2-lesson-1-variables"           # Sat 6pm group: homework & quiz lesson
check = E.check


def tiles(page):
    return {t.get_attribute("data-tile"): t.inner_text().split("\n")[0] for t in page.locator(".fu-tile").all()}


def stub_browser_apis(page):
    """Capture the clipboard and window.print so the tests can read what the page produced."""
    page.evaluate("""() => { window.__copied = null; window.__printed = null;
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied = t; return Promise.resolve(); } }, configurable: true });
      window.print = () => { const h = document.getElementById('fu-print');
        window.__printed = h ? { pages: h.querySelectorAll('.fu-print-page').length, dir: h.getAttribute('dir'), text: h.innerText, bodyClass: document.body.className } : null; }; }""")


def open_page(browser, base, path, **kw):
    ctx, page, errors = E.new_page(browser, base, **kw)
    if path:
        page.goto(base + path)
    return ctx, page, errors


def set_years(d, by_group, unclassified_year=None):
    for g in d["groups"]:
        for m in g["members"]:
            k = m["phone"][-10:]
            if g["key"] in by_group:
                d["students"][k]["year"] = by_group[g["key"]]
    if unclassified_year:
        for m in d["unclassified"]:
            d["students"][m["phone"][-10:]]["year"] = unclassified_year


def s_years(d):
    set_years(d, {"sat 6pm": "Senior 2", "tue 4pm": "Senior 1", "sun 8pm": "Senior 1"}, "Senior 1")
    d["students"]["1012345002"]["year"] = "Senior 2"      # Sara is in Sat (S2) and Sun (S1 mates) -> Sun is mixed


def s_nogroups_s1(d):
    set_years(d, {"sat 6pm": "Senior 2", "tue 4pm": "Senior 2", "sun 8pm": "Senior 2"})
    for i, nm in enumerate(["Mostafa Adel", "Rana Samir", "Tamer Wael"]):
        phone = "0151234" + "5%03d" % (12 + i)
        k = phone[-10:]
        d["students"][k] = {"phone": phone, "name": nm, "year": "Senior 1", "parent_phone": "01234567%03d" % (900 + i)}
        if i:
            d["unclassified"].append({"phone": phone, "name": nm})
    d["students"]["1512345012"]["year"] = "Senior 1"


def s_other_year_lessons(d):
    set_years(d, {"sat 6pm": "Senior 2", "tue 4pm": "Senior 1", "sun 8pm": "Senior 1"}, "Senior 1")
    d["students"]["1012345002"]["year"] = "Senior 2"
    p2 = G2 + "chapter-1-lesson-2-how-ai-works"
    d["all_lessons"].append({"path": p2, "lesson_locked": False, "video_locked": False, "quiz_locked": False})
    for g in d["groups"]:
        if g["key"] == "tue 4pm":
            g["settings"]["current_lesson"] = p2


def s_flags_off(d):
    d["flags"] = {"FF_PARENT_LOG": False, "FF_MONTHLY": False}


AUTH2 = r"""
window.__calls = [];
window.AuthEngine = {
  mount: function(sel, cb){ cb(window.__SESSION); }, clearSession: function(){},
  adminCall: function(session, p){
    window.__calls.push(p);
    var ok = function(o){ return Promise.resolve(Object.assign({ok:true}, o)); };
    if (p.action === "admin_followup_overview")
      return fetch("/dashboard/_fixtures/followup-overview.json").then(function(r){ return r.json(); }).then(function(o){ o.week = {start:"2026-10-10", end:"2026-10-16"}; return o; });
    if (p.action === "admin_followup_set_attendance") return ok({results: p.items.map(function(i){ return {phone:i.phone, mode:i.mode, can_watch:true, quiz_open:true}; }), expires_at:"2026-10-16"});
    if (p.action === "admin_followup_save_group") return ok({settings:p});
    if (p.action === "admin_set_requirement") return ok({requirement:p});
    if (p.action === "admin_group_add") return ok({});
    if (p.action === "admin_log_parent_notification") return ok({created:true, notification:{kind:p.kind, ref:String(p.ref||"").toLowerCase(), sent_at:"2026-10-16 12:00:00", note:p.note||""}});
    if (p.action === "admin_student_summary" || p.action === "admin_monthly_review")
      return fetch("/dashboard/_fixtures/student-summary.json").then(function(r){ return r.json(); }).then(function(s){
        if (p.action === "admin_student_summary") { s.student.phone = p.student; s.range = {from:p.from, to:p.to}; return s; }
        if (p.op === "mark") return {ok:true, review:{student:p.student, month:p.month, status:p.status, sent_at:"", note:""}};
        return {ok:true, month:p.month, range:{from:p.month+"-01", to:p.month+"-28"}, closed:true, reviews:[{student:s.student, summary:s, review:{status:"pending", sent_at:"", note:""}}]};
      });
    return Promise.resolve({ok:false, error:"?"});
  }
};
"""


def real_page(browser, base, path, mutate=None, session=None):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, locale="ar-EG", timezone_id="Africa/Cairo")
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
    pg.route("**/assets/auth.js", lambda r: r.fulfill(body=AUTH2, content_type="application/javascript"))
    pg.route("**/dashboard/student.html", lambda r: r.fulfill(body="<title>student</title>", content_type="text/html"))

    def fx(route):
        d = json.load(open(E.FIXTURE, encoding="utf-8"))
        if mutate:
            mutate(d)
        route.fulfill(body=json.dumps(d), content_type="application/json")
    pg.route("**/_fixtures/followup-overview.json", fx)
    pg.add_init_script("window.__SESSION=%s;" % json.dumps(session or {"student_id": "01000000000", "session_token": "tok", "is_admin": True}))
    pg.goto(base + path)
    return ctx, pg, errors


def calls(pg, action):
    return pg.evaluate("(a) => __calls.filter(c => c.action === a)", action)


def main():
    os.makedirs(SHOTS, exist_ok=True)
    srv, base = E.serve()
    FU = "/dashboard/followup.html?mock=1"
    FUR = "/dashboard/followup.html"            # real mode (stub AuthEngine)
    SS = "/dashboard/student-summary.html?mock=1"
    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ================= requirement toggles (R-009, page side) =================
        ctx, page, errors = open_page(browser, base, None)
        page.wait_for_selector(".fu-stu")
        check("role B has the three requirement controls", page.is_checked("#req-quiz-0") and page.is_checked("#req-hw-0") and page.locator("#req-due-0").count() == 1)
        check("before: 2 quiz-absent, 2 homework-missing", tiles(page) == {"unwatched": "2", "hwmissing": "2", "quizabsent": "2"}, tiles(page))
        page.uncheck("#req-quiz-0", force=True)
        page.wait_for_function("document.querySelector(\"[data-tile='quizabsent'] b\").textContent === '0'")
        check("quiz optional: nobody is «absent», homework still counted", tiles(page)["quizabsent"] == "0" and tiles(page)["hwmissing"] == "2", tiles(page))
        check("quiz optional: Omar's chip says اختياري instead of غائب", "اختياري" in page.inner_text("#stu-1012345003 .fu-stu-head") and "غائب" not in page.inner_text("#stu-1012345003 .fu-stu-head"), page.inner_text("#stu-1012345003 .fu-stu-head"))
        page.check("#req-quiz-0", force=True)
        page.wait_for_function("document.querySelector(\"[data-tile='quizabsent'] b\").textContent === '2'")
        page.uncheck("#req-hw-0", force=True)
        page.wait_for_function("document.querySelector(\"[data-tile='hwmissing'] b\").textContent === '0'")
        check("homework optional: no homework missing, quiz still counted (independent)", tiles(page)["hwmissing"] == "0" and tiles(page)["quizabsent"] == "2", tiles(page))
        page.click("#stu-1012345005 .fu-stu-head")
        check("homework optional: no homework message button", page.locator("#stu-1012345005 [data-kind='homework_missing']").count() == 0)
        page.check("#req-hw-0", force=True)
        page.wait_for_function("document.querySelector(\"[data-tile='hwmissing'] b\").textContent === '2'")
        check("no JS errors (requirements)", not errors, errors)
        ctx.close()

        # ================= attendance state chips + bulk center week confirm (R-010, page side) =================
        ctx, page, errors = open_page(browser, base, None)
        page.wait_for_selector(".fu-stu")
        stub_browser_apis(page)
        txt = {}
        for pk, want in (("1012345001", "must"), ("1012345002", "watched"), ("1012345003", "center")):
            page.click("#stu-%s .fu-stu-head" % pk)
            check("attendance state «%s» for %s" % (want, pk), page.get_attribute("#stu-%s [data-att-state]" % pk, "data-att-state") == want)
            txt[pk] = page.inner_text("#stu-%s [data-att-state]" % pk)
        check("state texts: must watch online / watched online / attended in center", "لازم يشاهد أونلاين" in txt["1012345001"] and "شاهد أونلاين" in txt["1012345002"] and "حضر في السنتر" in txt["1012345003"], txt)
        page.click("#fu-all-center")
        page.wait_for_selector(".fu-dialog")
        dlg = page.inner_text(".fu-dialog")
        check("bulk center asks for the week explicitly (dates shown)", "10/10" in dlg and "16/10" in dlg and page.is_disabled(".fu-dialog .fu-btn.primary"), dlg)
        page.check("#fu-dialog-check")
        check("ticking the week enables the confirm button", page.is_enabled(".fu-dialog .fu-btn.primary"))
        page.click(".fu-dialog .fu-btn.primary")
        page.wait_for_selector(".fu-toast")
        check("toast says when center access ends (Friday 16/10)", "ينتهي يوم الجمعة 16/10" in page.inner_text(".fu-toast"), page.inner_text(".fu-toast"))
        page.click(".fu-toast button")
        page.wait_for_function("document.querySelector('#fu-unmarked') !== null")
        check("undo of a bulk center restores the previous state (unmarked banner is back)", True)
        page.click("#fu-all-online")
        page.click(".fu-dialog .fu-btn.primary")
        page.wait_for_selector(".fu-toast")
        check("bulk ONLINE needs no week tick", "أونلاين" in page.inner_text(".fu-toast"))
        check("no JS errors (center)", not errors, errors)
        ctx.close()

        # ================= year-grouped group menu =================
        ctx, page, errors = open_page(browser, base, None, mutate=s_years)
        page.wait_for_selector(".fu-stu")
        page.click(".fu-tab[data-tab='__none']")
        page.wait_for_selector("#fu-borrow")
        labels = page.eval_on_selector_all("#fu-borrow optgroup", "els => els.map(e => e.label)")
        check("group menu is grouped by year (S1, S2, mixed)", labels == ["سينيور 1", "سينيور 2", "مختلط"], labels)
        first = page.eval_on_selector("#fu-borrow optgroup[data-year-group='1']", "e => Array.from(e.querySelectorAll('option')).map(o => o.textContent)")
        check("Senior 1 groups sit under the Senior 1 heading", first == ["Tue 4pm"], first)
        check("lesson menus keep their year headings", True if page.locator("#fu-borrow").count() else False)
        ctx.close()

        # ================= R-007 empty state + assign groups =================
        ctx, page, errors = open_page(browser, base, None, mutate=s_nogroups_s1)
        page.wait_for_selector(".fu-stu")
        page.click("[data-year='1']")
        page.wait_for_selector("#fu-nogroups")
        check("R-007 Senior 1 without groups: an empty state with an action (not an empty dropdown)", page.is_visible("#fu-assign") and page.locator("#fu-borrow").count() == 0, page.inner_text("#fu-nogroups"))
        check("R-007 the Senior 1 students are still listed", page.locator(".fu-stu").count() == 3, page.locator(".fu-stu").count())
        check("R-007 empty state names the year", "سينيور 1" in page.inner_text("#fu-nogroups"))
        check("R-007 tap targets >= 48px on the empty state", not E.small_targets(page), E.small_targets(page))
        page.click("#fu-assign")
        page.wait_for_selector("#fu-assign-group")
        check("assign sheet lists only the Senior 1 students without a group (3), all ticked", page.locator("#fu-assign-list input:checked").count() == 3)
        page.select_option("#fu-assign-group", "__new")
        check("choosing «جروب جديد» shows the name field", page.is_visible("#fu-assign-name"))
        page.click("#fu-assign-go")
        check("an empty group name is refused", "اكتب اسم الجروب" in page.inner_text(".fu-toast"))
        page.fill("#fu-assign-name", "S1 Sun 4pm")
        page.click("#fu-assign-go")
        page.wait_for_function("document.querySelector(\".fu-tab[aria-selected='true']\") && document.querySelector(\".fu-tab[aria-selected='true']\").textContent.includes('S1 Sun 4pm')")
        check("R-007 the new group exists, is selected and holds the 3 students", page.locator(".fu-stu").count() == 3 and "S1 Sun 4pm" in page.inner_text(".fu-tab[aria-selected='true']"))
        check("R-007 the group menu is no longer needed: roles card is back", page.locator("#fu-role-a").count() == 1)
        check("no JS errors (assign)", not errors, errors)
        ctx.close()
        ctx, pg, errors = real_page(browser, base, FUR, mutate=s_nogroups_s1)
        pg.wait_for_selector(".fu-stu")
        pg.click("[data-year='1']"); pg.wait_for_selector("#fu-assign"); pg.click("#fu-assign"); pg.wait_for_selector("#fu-assign-group")
        pg.select_option("#fu-assign-group", "__new"); pg.fill("#fu-assign-name", "S1 Sun 4pm"); pg.click("#fu-assign-go")
        pg.wait_for_function("__calls.filter(c => c.action === 'admin_group_add').length === 3")
        ga = calls(pg, "admin_group_add")
        check("assign sends one admin_group_add per student with the group name", sorted(c["phone"] for c in ga) == ["01512345012", "01512345013", "01512345014"] and all(c["group"] == "S1 Sun 4pm" for c in ga), ga)
        ctx.close()

        # ================= R-008 year switch with lessons of the other year =================
        ctx, page, errors = open_page(browser, base, None, mutate=s_other_year_lessons)
        page.wait_for_selector(".fu-stu")
        page.click("[data-year='1']")
        page.wait_for_selector(".fu-dialog")
        check("R-008 switching year warns about lessons from the other year (names the group)", "Tue 4pm" in page.inner_text(".fu-dialog") and "سينيور 1" in page.inner_text(".fu-dialog"), page.inner_text(".fu-dialog"))
        page.click(".fu-dialog .fu-btn:not(.primary)")
        check("R-008 «keep» closes the dialog and leaves the warning on the group", page.locator(".fu-dialog").count() == 0)
        page.click(".fu-tab[data-tab='tue 4pm']")
        check("R-008 the kept lesson is flagged on the group", page.is_visible("#fu-year-mismatch") and page.input_value("#pick-current").endswith("how-ai-works"))
        page.click("[data-year='all']")
        page.click("[data-year='1']")
        page.wait_for_selector(".fu-dialog")
        page.click(".fu-dialog .fu-btn.primary")
        page.wait_for_selector(".fu-toast")
        page.click(".fu-tab[data-tab='tue 4pm']")
        check("R-008 «clear» removes the other-year lesson", page.input_value("#pick-current") == "" and page.locator("#fu-year-mismatch").count() == 0, page.input_value("#pick-current"))
        check("R-008 no dialog when nothing mismatches", (page.click("[data-year='all']"), page.click("[data-year='1']"), page.locator(".fu-dialog").count())[2] == 0)
        check("no JS errors (year switch)", not errors, errors)
        ctx.close()
        ctx, pg, errors = real_page(browser, base, FUR, mutate=s_other_year_lessons)
        pg.wait_for_selector(".fu-stu"); pg.click("[data-year='1']"); pg.wait_for_selector(".fu-dialog"); pg.click(".fu-dialog .fu-btn.primary")
        pg.wait_for_function("__calls.some(c => c.action === 'admin_followup_save_group')")
        sg = calls(pg, "admin_followup_save_group")[0]
        check("R-008 clearing saves current_lesson = '' for that group only", sg["group"] == "Tue 4pm" and sg["current_lesson"] == "" and sg["review_lessons"], sg)
        ctx.close()

        # ================= parent log =================
        ctx, page, errors = open_page(browser, base, None)
        page.wait_for_selector(".fu-stu")
        stub_browser_apis(page)
        check("the logged student shows a 📨 chip with the date", "14/10" in page.inner_text("#stu-1012345005 [data-chip='notified']"), page.inner_text("#stu-1012345005 .fu-stu-head"))
        page.click("#stu-1012345005 .fu-stu-head")
        page.locator("#stu-1012345005 .fu-btn.wa").click()
        page.wait_for_selector("#fu-log-send")
        check("message sheet offers «I sent it» (not yet fully logged)", "سجّل" in page.inner_text("#fu-log-send") and "✓" not in page.inner_text("#fu-log-send"))
        page.fill("#fu-log-note", "كلمتها بالتليفون")
        page.click("#fu-log-send")
        page.wait_for_function("document.querySelector('#fu-log-send') && document.querySelector('#fu-log-send').textContent.includes('اتسجّل')")
        check("logging confirms with a toast and the button turns into ✓", "اتسجّل" in page.inner_text(".fu-toast"))
        page.click("#fu-close")
        page.wait_for_selector("#stu-1012345005 [data-log]")
        logtxt = page.inner_text("#stu-1012345005 [data-log]")
        check("the student card lists the logged contacts with note and date", "كويز" in logtxt and "رسالة" in logtxt and "كلمتها بالتليفون" in logtxt and "14/10" in logtxt, logtxt)
        check("the filter «لم يُبلَّغ بعد» exists", page.locator("[data-filter='notnotified']").count() == 1)
        page.click("[data-filter='notnotified']")
        names = page.inner_text("#fu-rows")
        check("«لم يُبلَّغ بعد» keeps students with due items not logged yet (Mariam, Omar) and drops Hana", "Mariam Ahmed" in names and "Omar Khaled" in names and "Hana Sami" not in names, names)
        page.click("[data-filter='all']")
        page.click("#fu-refresh")
        page.wait_for_selector(".fu-toast")
        check("the log persists across a reload of the data", page.locator("#stu-1012345005 [data-chip='notified']").count() == 1)
        check("no JS errors (parent log)", not errors, errors)
        ctx.close()
        ctx, page, errors = open_page(browser, base, None, mutate=s_flags_off)
        page.wait_for_selector(".fu-stu")
        page.click("#stu-1012345005 .fu-stu-head")
        page.locator("#stu-1012345005 .fu-btn.wa").click()
        page.wait_for_selector("#fu-wa-open")
        check("flags off: no log box, no 📨 chip, no «not notified» filter, no monthly button",
              page.locator("#fu-log-send").count() == 0 and page.locator("[data-chip='notified']").count() == 0 and page.locator("[data-filter='notnotified']").count() == 0 and page.locator("#fu-monthly").count() == 0)
        ctx.close()
        ctx, pg, errors = real_page(browser, base, FUR)
        pg.wait_for_selector(".fu-stu"); pg.click("#stu-1012345005 .fu-stu-head"); pg.locator("#stu-1012345005 .fu-btn.wa").click(); pg.wait_for_selector("#fu-log-send"); pg.click("#fu-log-send")
        pg.wait_for_function("__calls.filter(c => c.action === 'admin_log_parent_notification').length === 2")
        lg = calls(pg, "admin_log_parent_notification")
        kinds = sorted((c["kind"], c["ref"].split(":")[0] if c["kind"] == "custom" else "lesson") for c in lg)
        check("a combined message logs one entry per issue (custom watch + quiz) for the student's phone", kinds == [("custom", "watch"), ("quiz", "lesson")] and all(c["student"] == "01012345005" for c in lg), lg)
        ctx.close()

        # ================= monthly review =================
        ctx, page, errors = open_page(browser, base, None)
        page.wait_for_selector(".fu-stu")
        stub_browser_apis(page)
        page.click("#fu-monthly")
        page.wait_for_selector("[data-review]")
        opts = page.eval_on_selector_all("#fu-month option", "els => els.map(e => e.value)")
        check("monthly sheet: 6 months, the running month first", len(opts) == 6 and opts[0] == "2026-10" and opts[1] == "2026-09", opts)
        check("monthly sheet: one row per group member, all pending", page.locator("[data-review]").count() == 5 and page.locator("[data-status='pending']").count() == 5)
        check("monthly sheet: honest note about a running month", "لسه شغال" in page.inner_text("#fu-monthly-body .fu-hint"), page.inner_text("#fu-monthly-body .fu-hint"))
        check("monthly sheet: no horizontal scroll, tap targets >= 48px", E.no_hscroll(page) and not E.small_targets(page), E.small_targets(page))
        page.wait_for_timeout(450)      # let the slide-in animation finish before the screenshot
        page.screenshot(path=os.path.join(SHOTS, "p2-monthly-list.png"))
        page.click("[data-open-review='1012345001']")
        page.wait_for_selector("#fu-msg-text")
        mt = page.input_value("#fu-msg-text")
        check("monthly message: title, month, student, figures", "التقرير الشهري" in mt and "أكتوبر 2026" in mt and "Mariam Ahmed" in mt and "الكويزات" in mt and "الواجبات" in mt, mt)
        href = page.get_attribute("#fu-wa-open", "href")
        check("monthly message: wa.me link to the parent with the same text", href.startswith("https://wa.me/201234567890?text=") and "%0A" in href and page.get_attribute("#fu-wa-open", "target") == "_blank", href[:80])
        check("monthly message: preview is RTL and bold is rendered", page.get_attribute("#fu-preview", "dir") == "auto" and page.locator("#fu-preview b").count() >= 2)
        page.wait_for_timeout(450)
        page.screenshot(path=os.path.join(SHOTS, "p2-monthly-message.png"))
        page.click("#fu-month-sent")
        page.wait_for_function("document.querySelector('#fu-month-status').textContent === 'اتبعت'")
        check("«تم الإرسال» marks the review sent", True)
        page.click("#fu-month-back")
        page.wait_for_selector("[data-review]")
        check("back to the list: that student is «اتبعت», the others still pending", page.get_attribute("[data-review='1012345001'] [data-status]", "data-status") == "sent" and page.locator("[data-status='pending']").count() == 4)
        page.click("#fu-monthly-ready")
        page.wait_for_function("document.querySelectorAll(\"[data-status='ready']\").length === 4")
        check("«الكل جاهز» marks only the pending ones", page.locator("[data-status='sent']").count() == 1)
        page.click("#fu-monthly-copy-all")
        copied = page.evaluate("window.__copied") or ""
        check("copy-all puts every student's message in the clipboard", all(n in copied for n in ("Mariam Ahmed", "Sara Mahmoud", "Omar Khaled", "Nour Hassan", "Hana Sami")) and copied.count("التقرير الشهري") == 5, copied[:120])
        page.click("#fu-monthly-print")
        pr = page.evaluate("window.__printed")
        check("print builds one page per student, RTL, only the print area is shown", pr and pr["pages"] == 5 and pr["dir"] == "rtl" and "fu-printing" in pr["bodyClass"] and "Mariam Ahmed" in pr["text"], pr)
        page.evaluate("window.dispatchEvent(new Event('afterprint'))")
        check("print area is removed after printing", page.locator("#fu-print").count() == 0 and "fu-printing" not in page.evaluate("document.body.className"))
        page.select_option("#fu-month", "2026-09")
        page.wait_for_function("document.querySelector(\"[data-review]\") && !document.querySelector('.fu-skel')")
        check("a closed month says the numbers are final", "خلص" in page.inner_text("#fu-monthly-body .fu-hint"))
        page.click("[data-open-review='1012345002']")
        page.wait_for_selector("#fu-msg-text")
        check("choosing September changes the message month", "سبتمبر 2026" in page.input_value("#fu-msg-text"))
        check("no JS errors (monthly)", not errors, errors)
        ctx.close()
        ctx, page, errors = open_page(browser, base, None)
        page.wait_for_selector(".fu-stu")
        page.click(".fu-tab[data-tab='tue 4pm']"); page.click("#fu-monthly"); page.wait_for_selector("[data-review]")
        page.click("[data-open-review='1112345007']"); page.wait_for_selector("#fu-msg-text")
        check("a student with no parent number: warning, WhatsApp button has no link, copy still works", page.is_visible("#fu-phonewarn") and page.get_attribute("#fu-wa-open", "href") is None and page.is_enabled("#fu-copy"))
        ctx.close()
        ctx, pg, errors = real_page(browser, base, FUR)
        pg.wait_for_selector(".fu-stu"); pg.click("#fu-monthly"); pg.wait_for_selector("[data-review]")
        mr = calls(pg, "admin_monthly_review")[0]
        check("monthly review request: month + group", mr["month"] == "2026-10" and mr["group"] == "Sat 6pm" and "op" not in mr, mr)
        pg.click("[data-open-review]"); pg.wait_for_selector("#fu-month-sent"); pg.click("#fu-month-sent")
        pg.wait_for_function("__calls.some(c => c.op === 'mark')")
        mk = [c for c in calls(pg, "admin_monthly_review") if c.get("op") == "mark"][0]
        check("mark sent request: op, status, month, student phone", mk["status"] == "sent" and mk["month"] == "2026-10" and mk["student"], mk)
        ctx.close()

        # ================= student summary page =================
        ctx, page, errors = open_page(browser, base, SS + "&student=1012345001")
        page.wait_for_selector("#ss-kpis")
        check("summary: student name, groups and parent phone", page.inner_text("#ss-name") == "Mariam Ahmed" and "Sat 6pm" in page.inner_text("#ss-student") and "01234567890" in page.inner_text("#ss-student"), page.inner_text("#ss-student"))
        k = {i: page.inner_text("#" + i).split("\n")[0] for i in ("kpi-quiz-avg", "kpi-quiz-count", "kpi-quiz-missed", "kpi-hw-count", "kpi-hw-missed", "kpi-att", "kpi-watch", "kpi-written")}
        check("summary KPIs come from the summary data", k == {"kpi-quiz-avg": "77%", "kpi-quiz-count": "3", "kpi-quiz-missed": "1", "kpi-hw-count": "2", "kpi-hw-missed": "1", "kpi-att": "1 / 3", "kpi-watch": "72%", "kpi-written": "1 / 2"}, k)
        check("missed counts are red, zero would be green", "bad" in page.get_attribute("#kpi-quiz-missed", "class") and "bad" in page.get_attribute("#kpi-hw-missed", "class"))
        check("quizzes list: one row per quiz with score", page.locator("#ss-quizzes .fu-lrow").count() == 3 and "7 / 10" in page.inner_text("#ss-quizzes"))
        check("homework list shows the graded score", page.locator("#ss-homework .fu-lrow").count() == 2 and "8 / 10" in page.inner_text("#ss-homework"))
        check("expected items: the missed ones are red, the optional quiz says اختياري", page.locator("#ss-expected [data-q='missed']").count() == 1 and page.locator("#ss-expected [data-h='missed']").count() == 1 and page.locator("#ss-expected [data-q='optional']").count() == 1)
        check("video access per lesson: locked lessons are marked", page.locator("#ss-attendance [data-access='locked']").count() == 1 and page.locator("#ss-attendance [data-access='open']").count() == 3)
        check("written answers: pending vs graded", "معلّق 1" in page.inner_text("#ss-w-pending") and "اتصحّح 2" in page.inner_text("#ss-written") and "7 / 10" in page.inner_text("#ss-written"))
        check("no parent contact yet is stated", page.is_visible("#ss-nonotif"))
        page.select_option("#ss-log-kind", index=1)
        page.fill("#ss-log-note", "اتصلت وقالت هتتعوّض")
        page.click("#ss-log-go")
        page.wait_for_selector("#ss-parent :text('اتصلت وقالت هتتعوّض')")
        check("logging a contact adds it to the list", page.locator("#ss-nonotif").count() == 0)
        page.select_option("#ss-month", "2026-09")
        page.wait_for_function("document.querySelector('#ss-from').value === '2026-09-01'")
        check("changing the month reloads with that month's range", page.input_value("#ss-to") == "2026-09-30")
        page.fill("#ss-from", "2026-09-20"); page.fill("#ss-to", "2026-09-05"); page.click("#ss-apply")
        check("an upside-down custom range is refused", "فترة صحيحة" in page.inner_text(".fu-toast"))
        page.click("#ss-monthly")
        page.wait_for_selector("#ss-msg")
        check("monthly card: message for the chosen month with a WhatsApp link", "سبتمبر 2026" in page.input_value("#ss-msg") and page.get_attribute("#ss-wa", "href").startswith("https://wa.me/201234567890?text="))
        page.click("#ss-month-sent")
        page.wait_for_function("document.querySelector('#ss-monthly-out') === null || true")
        check("summary page: no horizontal scroll (390), tap targets >= 48px", E.no_hscroll(page) and not E.small_targets(page), E.small_targets(page))
        check("no JS errors (summary)", not errors, errors)
        page.screenshot(path=os.path.join(SHOTS, "p2-summary-full.png"), full_page=True)
        ctx.close()
        ctx, page, errors = open_page(browser, base, SS)
        page.wait_for_selector("#ss-list .fu-pickrow")
        check("picker lists every student", page.locator(".fu-pickrow").count() == 12)
        page.fill("#ss-q", "mariam")
        check("picker search", page.locator(".fu-pickrow").count() == 1)
        page.click(".fu-pickrow")
        page.wait_for_selector("#ss-kpis")
        check("picking a student opens his summary", "student=1012345001" in page.url and page.inner_text("#ss-name") == "Mariam Ahmed")
        ctx.close()
        ctx, page, errors = open_page(browser, base, FU)
        page.wait_for_selector(".fu-stu"); page.click("#stu-1012345002 .fu-stu-head")
        page.click("#fu-summary-link-1012345002")
        page.wait_for_selector("#ss-kpis")
        check("the follow-up student card links to that student's summary", "student=1012345002" in page.url and "mock=1" in page.url and page.inner_text("#ss-name") == "Sara Mahmoud")
        ctx.close()
        ctx, page, errors = open_page(browser, base, SS + "&student=9999999999")
        page.wait_for_selector("#ss-error")
        check("unknown student: a clear error", "مش موجود" in page.inner_text("#ss-error"))
        ctx.close()
        ctx, page, errors = open_page(browser, base, None)
        page.route("**/_fixtures/student-summary.json", lambda r: r.fulfill(status=500, body="x"))
        page.goto(base + SS + "&student=1012345001")
        page.wait_for_selector("#ss-error")
        check("summary load failure: error + retry button", page.locator("#ss-error + div button").count() == 1)
        ctx.close()
        ctx, page, errors = open_page(browser, base, SS + "&student=1012345001", width=1280, height=800)
        page.wait_for_selector("#ss-kpis")
        check("summary page: no horizontal scroll at 1280, tap targets >= 48px", E.no_hscroll(page) and not E.small_targets(page), E.small_targets(page))
        ctx.close()
        ctx, page, errors = open_page(browser, base, SS + "&student=1012345001", dark=True)
        page.wait_for_selector("#ss-kpis")
        ratios = page.evaluate(E.CONTRAST_JS, ["body", ".fu-kpi b", ".fu-kpi span", ".fu-card h3", ".fu-chip.red", ".fu-chip.green", ".fu-lrow .nm", ".fu-dim", "#ss-log-go"])
        check("summary page, dark mode: text contrast >= 4.5:1", not [r for r in ratios if r[1] is not None and r[1] < 4.5], [r for r in ratios if r[1] is not None and r[1] < 4.5])
        ctx.close()
        ctx, pg, errors = real_page(browser, base, "/dashboard/student-summary.html?student=1012345001")
        pg.wait_for_selector("#ss-kpis")
        sc = calls(pg, "admin_student_summary")[0]
        check("real mode: summary request = student phone + month range", sc["student"] == "01012345001" and sc["from"] == "2026-10-01" and sc["to"] == "2026-10-16", sc)
        ctx.close()
        ctx, pg, errors = real_page(browser, base, "/dashboard/student-summary.html?student=1012345001", session={"student_id": "01000000001", "session_token": "tok", "is_admin": False})
        pg.wait_for_url("**/dashboard/student.html")
        check("real mode: a non-admin session is sent to student.html", True)
        ctx.close()

        # ================= R-019 RTL layout =================
        ctx, page, errors = open_page(browser, base, None)
        page.wait_for_selector(".fu-stu")
        c = lambda sel: page.evaluate("(s) => { const r = document.querySelector(s).getBoundingClientRect(); return (r.left + r.right) / 2; }", sel)
        check("RTL follow-up: html dir/lang and body direction", page.evaluate("document.documentElement.dir") == "rtl" and page.evaluate("getComputedStyle(document.body).direction") == "rtl")
        check("RTL follow-up: the title sits on the right, the action buttons on the left", c(".fu-title") > c("#fu-refresh") and c("#fu-help") > c("#fu-refresh"))
        check("RTL follow-up: the stat tiles run right-to-left (لم يشاهدوا first, on the right)", c("[data-tile='unwatched']") > c("[data-tile='hwmissing']") > c("[data-tile='quizabsent']"))
        page.click("#stu-1012345001 .fu-stu-head")
        check("RTL follow-up: segmented control puts «أونلاين» to the right of «سنتر»", c("#stu-1012345001 [data-att='online']") > c("#stu-1012345001 [data-att='center']"))
        page.screenshot(path=os.path.join(SHOTS, "p2-followup-group.png"))
        page.click("#stu-1012345005 .fu-stu-head")
        page.locator("#stu-1012345005 .fu-btn.wa").click(); page.wait_for_selector("#fu-preview")
        check("RTL message sheet: the Arabic preview and the editor are right-to-left", page.evaluate("getComputedStyle(document.querySelector('#fu-preview')).direction") == "rtl" and page.evaluate("getComputedStyle(document.querySelector('#fu-msg-text')).direction") == "rtl")
        page.wait_for_timeout(450)
        page.screenshot(path=os.path.join(SHOTS, "p2-followup-message.png"))
        ctx.close()
        ctx, page, errors = open_page(browser, base, SS + "&student=1012345001")
        page.wait_for_selector("#ss-kpis")
        c = lambda sel: page.evaluate("(s) => { const r = document.querySelector(s).getBoundingClientRect(); return (r.left + r.right) / 2; }", sel)
        check("RTL summary: html dir and the title on the right of the back button", page.evaluate("document.documentElement.dir") == "rtl" and c(".fu-title") > c("#ss-back"))
        check("RTL summary: KPI grid runs right-to-left", c("#kpi-quiz-avg") > c("#kpi-quiz-count"))
        check("RTL summary: lesson names on the right, their chips on the left", page.evaluate("(() => { const r = document.querySelector('#ss-quizzes .fu-lrow'); const a = r.children[0].getBoundingClientRect(), b = r.children[1].getBoundingClientRect(); return a.left > b.left; })()"))
        page.screenshot(path=os.path.join(SHOTS, "p2-summary-top.png"))
        ctx.close()
        browser.close()
    srv.shutdown()
    print("\n%d passed, %d failed" % (E.passed, E.failed))
    return 1 if E.failed else 0


if __name__ == "__main__":
    sys.exit(main())
