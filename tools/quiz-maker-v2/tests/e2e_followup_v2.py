#!/usr/bin/env python3
"""
e2e_followup_v2.py — Follow-up v2 / S1 ("what is the next step?") on a 390px phone, ?mock=1 only.

    python tests/e2e_followup_v2.py            (run from tools/quiz-maker-v2)

Runs the page against dashboard/_fixtures/followup-overview.json with the mock scenarios in
fixture._v2_scenarios (?mock=1&scenario=golden1 ...). Every scenario is checked in two modes:

  stub    /assets/followup-events.js is served from assets/__stubs__/followup-events.stub.js (canned answers)
  engine  the real S3 file assets/followup-events.js (only when it exists; skipped with a NOTE otherwise)

plus a "degraded" run where the S3 scripts 404 (the page must keep the old layout). The walk-through is the
real S3 assets/followup-walk.js when it exists; the fallback (no FollowupWalk) is always checked as well.
Nothing touches the live site or the Sheet. Screenshots go to tests/_shots/v2-*.png.
"""
import json
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
STUB = os.path.join(REPO, "assets", "__stubs__", "followup-events.stub.js")
SHOTS = os.path.join(HERE, "_shots")
L1 = "programming/baccalaureate/grade-1-secondary/chapter-2-lesson-1-variables"
L2 = "programming/baccalaureate/grade-1-secondary/chapter-2-lesson-2-functions"
L3 = "programming/baccalaureate/grade-1-secondary/chapter-2-lesson-3-recursion"
RED_STEPS = {"attendance", "parents_watch", "parents_hw"}
ORDER = ["attendance", "parents_watch", "parents_hw", "remind_watch", "remind_hw", "advance_lessons", "setup_missing"]

passed = failed = 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("PASS " + name)
    else:
        failed += 1
        print("FAIL " + name + ("  -> " + str(extra)[:400] if extra else ""))


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=REPO))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, "http://127.0.0.1:%d" % srv.server_address[1]


def real(name):
    return os.path.exists(os.path.join(REPO, "assets", name))


# visible text must not show a 24-hour time (contract 3.12): H:MM not followed by AM/PM/ص/م
H24 = re.compile(r"\b(?:[01]?\d|2[0-3]):[0-5]\d\b(?!\s*(?:AM|PM|ص|م))")


def bad_times(page):
    txt = page.evaluate("() => { const out=[]; const w=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);"
                        " let n; while((n=w.nextNode())){ const e=n.parentElement; if(!e||e.closest('script,style,[hidden]')) continue;"
                        " const r=e.getBoundingClientRect(); if(!r.width&&!r.height) continue; out.push(n.textContent);} return out.join('\\n'); }")
    return [m.group(0) for m in H24.finditer(txt)]


def no_hscroll(page):
    return page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1")


def small_targets(page, scope="body"):
    return page.evaluate("""(scope) => { const bad=[]; const root=document.querySelector(scope); if(!root) return bad;
      root.querySelectorAll('button,a[href],select,input:not([type=checkbox])').forEach(e=>{
        const r=e.getBoundingClientRect(); if(!r.width||!r.height) return; if(e.closest('[hidden]')) return;
        if(r.height<43.5||r.width<43.5) bad.push((e.id||e.className||e.tagName)+' '+Math.round(r.width)+'x'+Math.round(r.height)); });
      return bad; }""", scope)


def calls(page, action=None):
    c = page.evaluate("window.__fuMockCalls || []")
    return [x for x in c if action is None or x.get("action") == action]


def new_page(browser, base, scenario="", hash_="", mode="stub", walk=True, dark=False, query=""):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, locale="ar-EG",
                              timezone_id="Africa/Cairo", color_scheme="dark" if dark else "light",
                              permissions=["clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
    page.route(re.compile(r"https://(wa\.me|api\.whatsapp\.com)/.*"), lambda r: r.fulfill(body="wa", content_type="text/plain"))
    if mode == "stub":
        page.route("**/assets/followup-events.js", lambda r: r.fulfill(path=STUB, content_type="application/javascript"))
    elif mode == "degraded":
        page.route("**/assets/followup-events.js", lambda r: r.fulfill(status=404, body=""))
    if mode == "degraded" or not walk:
        page.route("**/assets/followup-walk.js", lambda r: r.fulfill(status=404, body=""))
    url = base + PAGE + "?mock=1" + ("&scenario=" + scenario if scenario else "") + query + hash_
    page.goto(url)
    page.wait_for_selector("#fu-hero, #fu-today, .fu-stu", timeout=15000)
    return ctx, page, errors


def hero(page):
    h = page.locator("#fu-hero")
    return (h.get_attribute("data-phase"), h.get_attribute("data-state")) if h.count() else (None, None)


def shot(page, name):
    os.makedirs(SHOTS, exist_ok=True)
    page.screenshot(path=os.path.join(SHOTS, "v2-" + name + ".png"), full_page=True)


def common(page, errors, tag):
    check(tag + ": no JS errors", not errors, errors)
    check(tag + ": no horizontal scroll at 390px", no_hscroll(page))
    bt = bad_times(page)
    check(tag + ": no 24-hour time in the visible text", not bt, bt)
    body = page.inner_text("body")
    check(tag + ": never says Cairo / القاهرة", "Cairo" not in body and "القاهرة" not in body)


def run_mode(browser, base, mode):
    M = "[" + mode + "] "

    # ---------- golden 1, fresh visit: Today tab ----------
    ctx, page, errors = new_page(browser, base, "golden1", mode=mode)
    check(M + "a fresh visit opens the Today tab first", page.locator(".fu-tab").first.get_attribute("data-tab") == "__today"
          and page.locator(".fu-tab[aria-selected='true']").get_attribute("data-tab") == "__today")
    rows = page.locator("#fu-today .fu-inrow")
    steps = [rows.nth(i).get_attribute("data-step") for i in range(rows.count())]
    groups = [rows.nth(i).get_attribute("data-group") for i in range(rows.count())]
    check(M + "Today lists the busy groups, most urgent first", steps and [ORDER.index(s) for s in steps] == sorted(ORDER.index(s) for s in steps), steps)
    check(M + "Today includes Sat 6pm with its homework reminder", "sat 6pm" in groups and steps[groups.index("sat 6pm")] == "remind_hw", list(zip(groups, steps)))
    badge = page.locator(".fu-tab[data-tab='__today'] .fu-badge")
    check(M + "Today badge = number of busy groups", badge.count() == 1 and badge.inner_text() == str(len(steps)), (badge.count(), steps))
    dots_ok, bad = True, []
    for g in ["sat 6pm", "tue 4pm", "sun 8pm"]:
        dot = page.locator(".fu-tab[data-tab='%s'] .fu-dot" % g)
        tone = dot.get_attribute("data-dot") if dot.count() else None
        want = None
        if g in groups:
            # the dot is red when ANY due step of that group is red; the Today row shows the most urgent one
            want = "red" if steps[groups.index(g)] in RED_STEPS else "amber"
        if tone != want and not (want == "amber" and tone == "red"):
            dots_ok = False
            bad.append((g, tone, want))
    check(M + "group tab dots match the Today rows (red = attendance / parents, amber = the rest, none = clear)", dots_ok, bad)
    sat_row = page.locator("#fu-today .fu-inrow[data-group='sat 6pm']")
    check(M + "Today row says what to do, how many, and the deadline in 12-hour time",
          "ذكّر الجروب بالواجب" in sat_row.inner_text() and "3 طلاب" in sat_row.inner_text() and "11:59 م" in sat_row.inner_text(), sat_row.inner_text())
    check(M + "Today: tap targets >= 44px", not small_targets(page, "#fu-root"), small_targets(page, "#fu-root"))
    common(page, errors, M + "Today")
    shot(page, mode + "-01-today")
    # tapping the row body goes to the group with that step in the hero
    sat_row.locator(".fu-inrow-main").click()
    check(M + "tapping a Today row opens that group with that step", page.locator(".fu-tab[aria-selected='true']").get_attribute("data-tab") == "sat 6pm" and hero(page)[0] == "remind_hw")
    ctx.close()

    # ---------- golden 1 in the group: homework reminder + "Reminder sent" ----------
    ctx, page, errors = new_page(browser, base, "golden1", "#g=sat%206pm", mode=mode)
    check(M + "deep link #g=… opens that group", page.locator(".fu-tab[aria-selected='true']").get_attribute("data-tab") == "sat 6pm")
    check(M + "golden 1: hero = remind_hw (due)", hero(page) == ("remind_hw", "due"), hero(page))
    ht = page.inner_text("#fu-hero")
    check(M + "golden 1: hero says remind about homework, 3 missing, deadline tonight 11:59 م", "ذكّر الجروب بالواجب" in ht and "3 طلاب" in ht and "النهارده 11:59 م" in ht, ht)
    check(M + "golden 1: hero shows the homework lesson by name", "Ch 2 · L1 — Variables" in ht, ht)
    check(M + "golden 1: next line names the next step at 4:00 م Alex", "بعده" in ht and "4:00 م Alex" in ht, ht)
    check(M + "golden 1: one green primary button + «Reminder sent»", page.locator("#fu-hero .fu-btn.wa").count() == 1 and page.locator("#fu-hero-sent").count() == 1)
    check(M + "golden 1: the old next-session card and accordion are still below", page.locator("section[aria-label='الحصة الجاية']").count() == 1 and page.locator(".fu-stu").count() == 5)
    check(M + "group page: tap targets >= 44px", not small_targets(page, "#fu-hero"), small_targets(page, "#fu-hero"))
    common(page, errors, M + "golden 1")
    shot(page, mode + "-02-golden1")
    page.click("#fu-hero-go")
    page.wait_for_selector("#fu-reminder-state")
    check(M + "hero button opens the group reminder (copy, no wa.me link)", page.locator("#fu-copy").count() == 1 and page.locator(".fu-sheet a[href*='wa.me']").count() == 0)
    pv = page.inner_text("#fu-preview").replace("\u2068", "").replace("\u2069", "").lower()
    check(M + "reminder text lists the homework lesson", "variables" in pv, pv)
    check(M + "reminder sheet has «Reminder sent»", page.locator("#fu-reminder-sent").count() == 1)
    page.click("#fu-reminder-sent")
    page.wait_for_function("(window.__fuMockCalls||[]).some(c => c.action === 'admin_fu2_mark_done')")
    c = calls(page, "admin_fu2_mark_done")[-1]
    check(M + "«Reminder sent» calls admin_fu2_mark_done with the group KEY, kind hw and the session date",
          c.get("group") == "sat 6pm" and c.get("kind") == "hw" and c.get("session_date") == "2026-11-07", c)
    page.wait_for_function("document.querySelector('#fu-hero') && document.querySelector('#fu-hero').dataset.phase !== 'remind_hw'")
    check(M + "after «Reminder sent» the hero moves on", hero(page)[0] != "remind_hw", hero(page))
    check(M + "no JS errors after mark done", not errors, errors)
    ctx.close()

    # ---------- deep link to a step that is not due yet ----------
    ctx, page, errors = new_page(browser, base, "golden1", "#g=sat%206pm&step=parents_hw", mode=mode)
    check(M + "deep link &step=parents_hw shows that step in the hero", hero(page)[0] == "parents_hw", hero(page))
    check(M + "a step that is not due yet: «لسه بدري», button disabled, way back to the top step",
          hero(page)[1] == "upcoming" and "لسه بدري" in page.inner_text("#fu-hero-sub") and page.is_disabled("#fu-hero-go") and page.locator("#fu-hero-back").count() == 1,
          page.inner_text("#fu-hero"))
    page.click("#fu-hero-back")
    check(M + "«back to the top step» returns to remind_hw", hero(page)[0] == "remind_hw")
    # a Telegram link tapped while the page is open (hashchange)
    page.evaluate("location.hash = '#g=sun%208pm'")
    page.wait_for_function("document.querySelector(\".fu-tab[aria-selected='true']\").dataset.tab === 'sun 8pm'")
    check(M + "hashchange #g=… switches group while the page is open", True)
    page.evaluate("location.hash = '#today'")
    page.wait_for_selector("#fu-today")
    check(M + "#today opens the Today tab", page.locator(".fu-tab[aria-selected='true']").get_attribute("data-tab") == "__today")
    check(M + "no JS errors (deep links)", not errors, errors)
    ctx.close()

    # ---------- golden 2: attendance ----------
    ctx, page, errors = new_page(browser, base, "golden2", "#g=sat%206pm", mode=mode)
    check(M + "golden 2: hero = attendance (due)", hero(page) == ("attendance", "due"), hero(page))
    ht = page.inner_text("#fu-hero")
    check(M + "golden 2: «5 students not marked · session ended 6:00 م»", "5 طلاب" in ht and "6:00 م" in ht, ht)
    check(M + "golden 2: next = advance lessons at 9:00 م Alex", "انقل الدرس التالي" in ht and "9:00 م Alex" in ht, ht)
    common(page, errors, M + "golden 2")
    shot(page, mode + "-03-golden2")
    page.click("#fu-hero-go")
    check(M + "attendance button filters the list to unmarked students and opens the first one",
          page.get_attribute("[data-filter='unmarked']", "aria-pressed") == "true" and page.locator(".fu-stu.open").count() == 1 and page.locator(".fu-stu").count() == 5)
    ctx.close()

    # ---------- advance lessons ----------
    ctx, page, errors = new_page(browser, base, "advance", "#g=sat%206pm", mode=mode)
    check(M + "advance: hero = advance_lessons", hero(page) == ("advance_lessons", "due"), hero(page))
    check(M + "advance: proposes L2 -> L3 (track order) and homework/quiz L1 -> L2",
          "Ch 2 · L2 — Functions" in page.inner_text("#fu-adv-current") and "Ch 2 · L3 — Recursion" in page.inner_text("#fu-adv-current")
          and "Ch 2 · L1 — Variables" in page.inner_text("#fu-adv-review") and "Ch 2 · L2 — Functions" in page.inner_text("#fu-adv-review"))
    check(M + "advance: shows the new deadlines at 11:59 م and what is done", "11:59 م" in page.inner_text("#fu-adv-deadlines") and "الحضور اتسجّل (5 من 5)" in page.inner_text("#fu-adv-done"))
    common(page, errors, M + "advance")
    shot(page, mode + "-04-advance")
    page.click("#fu-adv-confirm")
    staged = page.evaluate("window.Draft ? window.Draft.count() : -1")
    if staged >= 0:   # Phase 4 Save model (draft-store.js): the lesson change waits for the Save bar
        check(M + "Save model: Confirm STAGES the lesson change and sends nothing yet",
              staged == 1 and not calls(page, "admin_followup_save_group") and not calls(page, "admin_fu2_mark_done"), (staged, calls(page)))
        check(M + "Save model: the step shows done right away (no second advance card while it is staged)", hero(page)[0] != "advance_lessons", hero(page))
        page.click("#p4-draft-save")
    page.wait_for_function("(window.__fuMockCalls||[]).some(c => c.action === 'admin_fu2_mark_done')")
    order = [c["action"] for c in calls(page) if c["action"] in ("admin_followup_save_group", "admin_fu2_mark_done")]
    check(M + "the step is marked done only AFTER the lesson change is saved", order[:2] == ["admin_followup_save_group", "admin_fu2_mark_done"], order)
    sg = calls(page, "admin_followup_save_group")[-1]
    check(M + "Confirm saves the next lesson and moves the finished one to homework + quiz",
          sg.get("current_lesson") == L3 and sg.get("hw_lessons") == [L2] and sg.get("quiz_lessons") == [L2] and sg.get("review_lessons") == [L2], sg)
    md = calls(page, "admin_fu2_mark_done")[-1]
    check(M + "Confirm then marks advance done for the session that just ended", md.get("kind") == "advance" and md.get("session_date") == "2026-11-07" and md.get("group") == "sat 6pm", md)
    page.wait_for_function("document.querySelector('#fu-hero').dataset.phase !== 'advance_lessons'")
    check(M + "after Confirm the hero moves on", hero(page)[0] != "advance_lessons", hero(page))
    check(M + "no JS errors (advance)", not errors, errors)
    ctx.close()
    # discarding the staged lesson change never marks the step done, and the advance card comes back
    ctx, page, errors = new_page(browser, base, "advance", "#g=sat%206pm", mode=mode)
    if page.evaluate("!!window.Draft"):
        page.on("dialog", lambda d: d.accept())
        page.click("#fu-adv-confirm")
        page.evaluate("window.Draft.discardAll()")
        page.wait_for_function("document.querySelector('#fu-hero') && document.querySelector('#fu-hero').dataset.phase === 'advance_lessons'")
        check(M + "Save model: Discard drops the pending «done» (nothing sent) and the advance card is back",
              not calls(page, "admin_fu2_mark_done") and not calls(page, "admin_followup_save_group") and hero(page)[0] == "advance_lessons", calls(page))
        check(M + "no JS errors (advance discard)", not errors, errors)
    ctx.close()

    # ---------- parents: walk-through ----------
    if real("followup-walk.js"):
        ctx, page, errors = new_page(browser, base, "parents", "#g=sat%206pm", mode=mode)
        check(M + "parents: hero = parents_hw with 3 parents", hero(page) == ("parents_hw", "due") and "كلّم 3 أولياء أمور" in page.inner_text("#fu-hero"), page.inner_text("#fu-hero"))
        shot(page, mode + "-05-parents")
        page.click("#fu-hero-go")
        page.wait_for_selector("[data-fw='root']")
        check(M + "«ابدأ» opens the S3 walk-through with 3 students", "1 من 3" in page.inner_text("[data-fw='count']"), page.inner_text("[data-fw='count']"))
        check(M + "walk-through message is the page's own homework message", "واجب" in page.inner_text("[data-fw='bubble']"), page.inner_text("[data-fw='bubble']")[:200])
        shot(page, mode + "-06-walk")
        page.click("[data-fw='copy']"); page.click("[data-fw='next']")
        page.click("[data-fw='skip']")
        page.click("[data-fw='copy']"); page.click("[data-fw='next']")
        page.wait_for_selector("[data-fw='summary']")
        page.click("[data-fw='finish']")
        page.wait_for_function("(window.__fuMockCalls||[]).filter(c => c.action === 'admin_log_parent_notification').length >= 2")
        logs = calls(page, "admin_log_parent_notification")
        check(M + "walk-through onDone logs the 2 sent students (homework, lesson 1) and not the skipped one",
              len(logs) == 2 and all(l.get("kind") == "homework" and l.get("ref") == L1 for l in logs) and len({l["student"] for l in logs}) == 2, logs)
        page.wait_for_function("!document.querySelector('[data-fw=root]')")
        txt = page.inner_text("#fu-hero")
        if mode == "engine":   # the stub's answers are canned; only the real engine recounts from parent_log
            check(M + "after the walk-through the hero count drops to the 1 skipped parent", "ولي أمر واحد" in txt, txt)
        check(M + "no JS errors (walk-through)", not errors, errors)
        ctx.close()
    else:
        print("NOTE assets/followup-walk.js not merged yet: walk-through checks use the fallback only")
    # fallback without FollowupWalk
    ctx, page, errors = new_page(browser, base, "parents", "#g=sat%206pm", mode=mode, walk=False)
    page.click("#fu-hero-go")
    page.wait_for_selector("#fu-wa-open")
    check(M + "no FollowupWalk: falls back to the single-message flow (list narrowed to the 3, first message open)",
          page.locator("#fu-focus").count() == 1 and page.locator(".fu-stu").count() == 3 and "wa.me" in (page.get_attribute("#fu-wa-open", "href") or ""))
    check(M + "no horizontal scroll with the fallback narrowing on", no_hscroll(page))
    page.click("#fu-close")
    page.click("#fu-focus")
    check(M + "the focus chip clears the narrowing", page.locator(".fu-stu").count() == 5)
    check(M + "no JS errors (fallback)", not errors, errors)
    ctx.close()

    # ---------- requirement switched off for the group ----------
    ctx, page, errors = new_page(browser, base, "reqoff", "#g=sat%206pm", mode=mode)
    check(M + "homework disabled: no homework step in the hero", hero(page)[0] != "remind_hw", hero(page))
    tiles = {t.get_attribute("data-tile"): t.inner_text().split("\n")[0] for t in page.locator(".fu-tile").all()}
    check(M + "homework disabled: homework tile counts 0", tiles.get("hwmissing") == "0", tiles)
    check(M + "homework disabled: no homework chip in the collapsed rows", page.locator(".fu-stu [data-chip='homework']").count() == 0)
    page.click("#stu-1012345001 .fu-stu-head")
    check(M + "homework disabled: no homework row and no homework button in the student", page.locator("#stu-1012345001 [data-hw]").count() == 0 and page.locator("#stu-1012345001 [data-kind='homework_missing']").count() == 0)
    check(M + "group watch threshold (60%) replaces the global 80%", "المطلوب 60%" in page.inner_text("#stu-1012345001"), page.inner_text("#stu-1012345001"))
    check(M + "quiz (still enabled) keeps its row", page.locator("#stu-1012345001 [data-quiz]").count() == 1)
    common(page, errors, M + "reqoff")
    ctx.close()

    # ---------- setup missing ----------
    ctx, page, errors = new_page(browser, base, "setup", "#g=tue%204pm", mode=mode)
    check(M + "setup: hero = setup_missing", hero(page)[0] == "setup_missing", hero(page))
    page.click("#fu-hero-go")
    check(M + "setup button opens the weekday + 12-hour time editor", page.is_visible("#fu-wd") and page.is_visible("#fu-time-h") and page.is_visible("#fu-time-ap"))
    check(M + "no JS errors (setup)", not errors, errors)
    ctx.close()


def main():
    srv, base = serve()
    modes = ["stub"] + (["engine"] if real("followup-events.js") else [])
    if "engine" not in modes:
        print("NOTE assets/followup-events.js not merged yet: running against the stub only\n")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for mode in modes:
            run_mode(browser, base, mode)

        # ---------- 12-hour session time picker ----------
        ctx, page, errors = new_page(browser, base, "golden1", "#g=sat%206pm")
        page.click("#fu-edit-time")
        check("no <input type=time> on the page", page.locator("input[type=time]").count() == 0)
        hours = page.eval_on_selector("#fu-time-h", "s => [...s.options].map(o => o.text)")
        mins = page.eval_on_selector("#fu-time-m", "s => [...s.options].map(o => o.text)")
        aps = page.eval_on_selector("#fu-time-ap", "s => [...s.options].map(o => o.text)")
        check("time picker: hours 1..12, minutes in steps of 5, ص/م", hours == [str(i) for i in range(1, 13)] and mins[:3] == ["00", "05", "10"] and len(mins) == 12 and aps == ["ص", "م"], (hours, mins, aps))
        check("time picker starts at the stored 18:00 = 6:00 م", page.input_value("#fu-time-h") == "6" and page.input_value("#fu-time-m") == "00" and page.input_value("#fu-time-ap") == "pm")
        page.select_option("#fu-wd", "2"); page.select_option("#fu-time-h", "4"); page.select_option("#fu-time-m", "30"); page.select_option("#fu-time-ap", "pm")
        page.click("#fu-save-time")
        if page.evaluate("!!window.Draft"): page.click("#p4-draft-save")   # Phase 4 Save model
        page.wait_for_function("(window.__fuMockCalls||[]).some(c => c.action === 'admin_followup_save_group')")
        sg = calls(page, "admin_followup_save_group")[-1]
        check("saving 4:30 م stores 24-hour \"16:30\"", sg.get("time") == "16:30" and sg.get("weekday") == 2, sg)
        page.wait_for_function("document.querySelector('#fu-when').textContent.includes('4:30')")
        check("the card shows the 12-hour time", "الثلاثاء 4:30 م" in page.inner_text("#fu-when"), page.inner_text("#fu-when"))
        page.click("#fu-edit-time"); page.select_option("#fu-time-h", "12"); page.select_option("#fu-time-m", "00"); page.select_option("#fu-time-ap", "am"); page.click("#fu-save-time")
        if page.evaluate("!!window.Draft"): page.click("#p4-draft-save")
        page.wait_for_function("(window.__fuMockCalls||[]).filter(c => c.action === 'admin_followup_save_group').length >= 2")
        check("12:00 ص (midnight) stores \"00:00\"", calls(page, "admin_followup_save_group")[-1].get("time") == "00:00")
        check("«last updated» is 12-hour", re.search(r"آخر تحديث \d{1,2}:\d\d [صم]", page.inner_text("#fu-updated")) is not None, page.inner_text("#fu-updated"))
        check("no JS errors (time picker)", not errors, errors)
        ctx.close()

        # ---------- notification settings (screen 6) ----------
        ctx, page, errors = new_page(browser, base, "golden1", "#g=sat%206pm")
        check("group settings show the notifications button with the reminder time", "4:00 م Alex" in page.inner_text("#fu-notify-open"), page.inner_text("#fu-notify-open"))
        page.click("#fu-notify-open")
        page.wait_for_selector("#fu-notify-hour")
        opts = page.eval_on_selector("#fu-notify-hour", "s => [...s.options].map(o => o.text)")
        check("reminder hour: 8:00 ص .. 10:00 م hourly (15 choices), 12-hour", len(opts) == 15 and opts[0] == "8:00 ص" and opts[-1] == "10:00 م" and "4:00 م" in opts, opts)
        check("reminder hour starts at 4:00 م and the zone says Alex", page.input_value("#fu-notify-hour") == "16" and page.inner_text("#fu-notify-tz") == "Alex")
        check("settings read through admin_fu2_notify_settings_get", len(calls(page, "admin_fu2_notify_settings_get")) == 1)
        check("status line: on, next reminder in 12-hour Alex time", "شغّالة" in page.inner_text("#fu-notify-status") and "Alex" in page.inner_text("#fu-notify-status"), page.inner_text("#fu-notify-status"))
        check("notification sheet: no 24-hour times, tap targets >= 44px", not bad_times(page) and not small_targets(page, ".fu-sheet"), (bad_times(page), small_targets(page, ".fu-sheet")))
        shot(page, "07-notify")
        page.select_option("#fu-notify-hour", "18")
        page.click("#fu-snooze-day")
        check("«one day» snooze is shown as pressed and the status says paused", page.get_attribute("#fu-snooze-day", "aria-pressed") == "true" and "موقوفة" in page.inner_text("#fu-notify-status"))
        page.click("#fu-notify-save")
        page.wait_for_function("(window.__fuMockCalls||[]).some(c => c.action === 'admin_fu2_notify_settings_save')")
        sv = calls(page, "admin_fu2_notify_settings_save")[-1]
        check("save sends {group key, enabled, hour 18, snooze tomorrow}", sv.get("group") == "sat 6pm" and sv.get("enabled") is True and sv.get("hour") == 18 and sv.get("snooze_until") == "2026-11-07", sv)
        page.wait_for_selector(".fu-toast")
        check("after saving, the button says paused", "موقوفة مؤقتًا" in page.inner_text("#fu-notify-open"), page.inner_text("#fu-notify-open"))
        page.click("#fu-notify-open"); page.wait_for_selector("#fu-notify-enabled")
        page.click("#fu-snooze-clear"); page.uncheck("#fu-notify-enabled", force=True)
        check("switching notifications off says so", "متوقفة" in page.inner_text("#fu-notify-status"))
        page.click("#fu-notify-save")
        page.wait_for_function("(window.__fuMockCalls||[]).filter(c => c.action === 'admin_fu2_notify_settings_save').length >= 2")
        sv = calls(page, "admin_fu2_notify_settings_save")[-1]
        check("off + snooze cleared are saved", sv.get("enabled") is False and sv.get("snooze_until") == "", sv)
        check("no JS errors (notifications)", not errors, errors)
        ctx.close()

        # ---------- dark mode screenshot of the hero (visual check only) ----------
        ctx, page, errors = new_page(browser, base, "golden1", "#g=sat%206pm", dark=True)
        page.evaluate("document.documentElement.setAttribute('data-theme','dark')")
        shot(page, "08-dark")
        check("dark mode: no JS errors", not errors, errors)
        ctx.close()

        # ---------- degraded: S3 scripts missing -> old layout ----------
        ctx, page, errors = new_page(browser, base, "golden1", mode="degraded")
        check("without followup-events.js: no Today tab, no hero, the old group page", page.locator(".fu-tab[data-tab='__today']").count() == 0 and page.locator("#fu-hero").count() == 0 and page.locator(".fu-stu").count() == 5)
        check("without followup-events.js: first group tab selected, no dots", page.locator(".fu-tab").first.get_attribute("aria-selected") == "true" and page.locator(".fu-dot").count() == 0)
        check("without followup-events.js: no JS errors", not errors, errors)
        ctx.close()
        ctx, page, errors = new_page(browser, base, "", mode="degraded", query="", hash_="")
        ctx.close()

        # ---------- no groups at all: the old empty state, no Today tab ----------
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, locale="ar-EG", timezone_id="Africa/Cairo")
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.route(re.compile(r"https://fonts\..*"), lambda r: r.abort())

        def empty(route):
            d = json.load(open(os.path.join(REPO, "dashboard", "_fixtures", "followup-overview.json"), encoding="utf-8"))
            d.update(groups=[], unclassified=[])
            route.fulfill(body=json.dumps(d), content_type="application/json")
        page.route("**/_fixtures/followup-overview.json", empty)
        page.goto(base + PAGE + "?mock=1")
        page.wait_for_selector("#fu-root .fu-empty")
        check("no groups: the old empty state and no Today tab", page.locator(".fu-tab[data-tab='__today']").count() == 0)
        check("no groups: no JS errors", not errs, errs)
        ctx.close()
        browser.close()
    srv.shutdown()
    print("\n%d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
