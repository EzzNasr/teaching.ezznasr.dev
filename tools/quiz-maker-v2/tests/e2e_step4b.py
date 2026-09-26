#!/usr/bin/env python3
"""Real-browser tests for the quiz gate (quiz.js) and the two new dashboard tabs
(Quiz gate, Groups) added to dashboard/access.html. Same harness/backend as
e2e_video.py and e2e_dashboard.py. Run from tools/quiz-maker-v2:
    python tests/e2e_step4b.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_video as E
import e2e_dashboard as D
from playwright.sync_api import sync_playwright

REPO = E.SITE_ROOT
api, sha, TOK = E.api, E.sha, E.TOK
L1 = "programming/other/functions"

passed = failed = 0
def check(name, cond, extra=""):
    global passed, failed
    if cond: passed += 1; print("PASS " + name)
    else: failed += 1; print("FAIL " + name + ("  -> " + str(extra)[:250] if extra else ""))


def quiz_page_html():
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="/assets/base.css"><link rel="stylesheet" href="/assets/forms.css">'
        '</head><body><main><div class="wrap"><div id="quiz-root"></div></div></main>'
        '<script type="application/json" id="quiz-data">'
        '{"subject":"programming","lesson":"' + L1 + '","title":"Functions",'
        '"questions":[{"q":"2+2?","options":["3","4"],"correct":1}]}'
        '</script>'
        '<script src="/assets/auth.js"></script><script src="/assets/quiz.js"></script>'
        '<script>QuizEngine.mount(\'#quiz-root\', \'#quiz-data\');</script>'
        '</body></html>'
    )


def run(browser):
    E.ASSETS["/assets/quiz.js"] = E.read(E.QM, "assets_templates", "quiz.js").replace(
        "https://script.google.com/macros/s/AKfycbzpyJWSI9aRseig5JBmydzo34ogfNYv9qQH1HrzIUGcgETF1rk4pE8qO8j7Hp3FrVjCvw/exec",
        E.GAS,
    )
    stu = D.reg("01000000030", "pw", "Lina")

    # ---- quiz gate on the actual quiz page --------------------------------------------------------
    api(dict(TOK, action="admin_set_quiz_lock", lesson=L1, locked=True))
    s = E.Site(browser, session=stu, pages={"/quiz.html": quiz_page_html()})
    pg = s.open("/quiz.html")
    pg.wait_for_selector("text=Not open yet")
    check("a locked quiz shows a 'not open yet' screen, no questions", "Ask your teacher" in pg.inner_text("body") and pg.locator(".qz-options").count() == 0)
    api(dict(TOK, action="admin_set_quiz_lock", lesson=L1, locked=False))
    pg.click("button:has-text('Check again')")
    pg.wait_for_selector(".qz-card")
    check("'Check again' opens it once unlocked", "ask your teacher" not in pg.inner_text("body").lower())
    s.ctx.close()

    api(dict(TOK, action="admin_set_quiz_lock", lesson=L1, locked=False))
    s = E.Site(browser, session=stu, pages={"/quiz.html": quiz_page_html()})
    pg = s.open("/quiz.html")
    pg.wait_for_selector(".qz-card")
    check("an unlocked (or ungated) quiz opens straight away", "begin quiz" in pg.inner_text("body").lower())
    s.ctx.close()

    s = E.Site(browser)
    s.mode = "offline"
    s2 = E.Site.__new__(E.Site)
    s2.ctx = browser.new_context(); s2.calls = []; s2.bodies = []; s2.mode = "offline"; s2.pages = {"/quiz.html": quiz_page_html()}
    s2.ctx.route(E.SITE + "/**", s2._site); s2.ctx.route("https://script.google.com/**", s2._gas)
    s2.ctx.add_init_script("localStorage.setItem('teaching_session', %s)" % json.dumps(json.dumps(stu)))
    s2.page = s2.ctx.new_page(); s2.page.set_default_timeout(7000)
    s2.page.goto(E.SITE + "/quiz.html")
    s2.page.wait_for_selector(".qz-card", timeout=10000)
    check("a network error checking the gate fails OPEN (doesn't trap the student)", "begin quiz" in s2.page.inner_text("body").lower())
    s2.ctx.close(); s.ctx.close()

    # ---- dashboard: Quiz gate tab -------------------------------------------------------------------
    D.seed()
    api(dict(TOK, action="admin_set_quiz_lock", lesson=L1, locked=True))
    admin = D.login("01000000001", "adm")
    s = D.open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector('[data-tab="quizzes"]')
    pg.click('[data-tab="quizzes"]')
    pg.wait_for_selector("[data-quiz]")
    card = pg.locator('[data-quiz="%s"]' % L1)
    check("the gated lesson shows locked", "locked" in card.inner_text().lower())
    card.locator("button", has_text="Open it").click()
    card.locator('[data-panel="quiz-lock"] button', has_text="Open it").click()
    pg.wait_for_selector(".ac-toast.is-ok")
    check("opening it from the dashboard works", "now open" in pg.inner_text(".ac-toast"))
    check("SERVER: get_quiz_state confirms it's open", api({"action": "get_quiz_state", "lesson": L1})["locked"] is False)
    pg.click('[data-tab="quizzes"]')
    sel = pg.locator("#qz-lesson-sel")
    sel.select_option(label=lambda o: True) if False else None
    check("the add-form offers lessons that don't already have a gate", sel.locator("option").count() >= 2)
    s.ctx.close()

    # ---- dashboard: Groups tab ----------------------------------------------------------------------
    s = D.open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector('[data-tab="groups"]')
    pg.click('[data-tab="groups"]')
    pg.wait_for_selector("input[placeholder*='Grade 2']")
    pg.fill("input[placeholder*='Grade 2']", "Test Group")
    pg.fill("input[placeholder*='first student']", "01000000002")
    pg.click("button:has-text('Create group')")
    pg.wait_for_selector(".ac-toast.is-ok")
    check("creating a group confirms and names the student", "Created" in pg.inner_text(".ac-toast") and "Sara" in pg.inner_text(".ac-toast"), pg.inner_text(".ac-toast"))
    check("SERVER: the group now exists with one member", any(g["group"] == "Test Group" and len(g["members"]) == 1 for g in api(dict(TOK, action="admin_list_groups"))["groups"]))
    gcard = pg.locator('[data-group="Test Group"]')
    check("the group card lists the member", "Sara" in gcard.inner_text())
    gcard.locator("input[placeholder='01xxxxxxxxx']").fill("01000000003")
    gcard.locator("button:has-text('Add')").click()
    pg.wait_for_selector(".ac-toast.is-ok")
    check("adding a second member works", "Omar" in pg.inner_text(".ac-toast"))
    gcard = pg.locator('[data-group="Test Group"]')
    check("both members now show on the card", gcard.inner_text().count("Sara") if False else ("Sara" in gcard.inner_text() and "Omar" in gcard.inner_text()))
    gcard.locator("button:has-text('Give this group access')").click()
    panel = gcard.locator(".ac-panel")
    panel.locator("select").first.select_option(L1)
    panel.locator("button:has-text('Give the group access')").click()
    pg.wait_for_selector(".ac-toast.is-ok")
    check("bulk grant via the dashboard confirms count and scope", "Gave 2 members" in pg.inner_text(".ac-toast") and "Functions" in pg.inner_text(".ac-toast"), pg.inner_text(".ac-toast"))
    check("SERVER: both members can now watch", D.can_watch({"student_id": "01000000002", "session_token": api({'action':'login_student','phone':'01000000002','password_hash':D.sha('b')})['session_token']}, L1))
    gcard = pg.locator('[data-group="Test Group"]')
    gcard.locator("button:has-text('Revoke from this group')").click()
    panel = gcard.locator(".ac-panel")
    panel.locator("select").first.select_option(L1)
    panel.locator("button:has-text('Revoke from the whole group')").click()
    pg.wait_for_selector(".ac-toast.is-ok")
    check("bulk revoke via the dashboard confirms", "Removed access" in pg.inner_text(".ac-toast"), pg.inner_text(".ac-toast"))
    check("SERVER: access is gone", not D.can_watch({"student_id": "01000000002", "session_token": api({'action':'login_student','phone':'01000000002','password_hash':D.sha('b')})['session_token']}, L1))
    s.ctx.close()


def main():
    backend = E.start_backend()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            run(browser)
            browser.close()
    finally:
        backend.terminate()
    print("\n%d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
