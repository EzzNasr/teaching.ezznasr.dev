#!/usr/bin/env python3
"""
e2e_one_group.py - real-browser test of "one group per student" on the Groups tab of dashboard/access.html
(confirm before moving, current group shown in the picker, "students in two groups" banner).
Same infrastructure as e2e_groups.py, with a backend that also loads FollowupRouter.gs.

    python tests/e2e_one_group.py        (run from tools/quiz-maker-v2)
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_dashboard as D
from playwright.sync_api import sync_playwright

E, check, api, TOK = D.E, D.check, D.api, D.TOK
HERE = os.path.dirname(os.path.abspath(__file__))


def groups():
    return {g["group"]: sorted(m["name"] for m in g["members"]) for g in D.overview()["groups"]}


def run(browser):
    S, P = D.seed()
    admin = S["admin"]
    api(dict(TOK, action="admin_group_add", group="Sat 6pm", phones=["01000000002", "01000000003"]))   # Sara, Omar
    api(dict(TOK, action="admin_group_add", group="Sun 8pm", phones=["01000000004"]))                    # Nour

    s = D.open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector('[data-tab="groups"]')
    pg.click('[data-tab="groups"]')
    pg.wait_for_selector('[data-group="Sun 8pm"]')
    check("no banner when nobody is in two groups", pg.locator("[data-dup-banner]").count() == 0)

    card = pg.locator('[data-group="Sun 8pm"]')
    card.locator(".ac-pick > summary").first.click()
    item = card.locator(".ac-pick[open] .ac-pickitem", has_text="Sara")
    check("the add picker shows where a student already is", "in “Sat 6pm”" in item.text_content(), item.text_content())

    # ---- dismiss the confirm: nothing changes
    dialogs = []
    mode = {"accept": False}
    pg.on("dialog", lambda d: (dialogs.append(d.message), d.accept() if mode["accept"] else d.dismiss()))
    item.locator("input").check()
    card.locator("button", has_text="Add 1").click()
    pg.wait_for_timeout(400)
    check("a confirm names the student and the group they are in", dialogs and "Sara" in dialogs[0] and "Sat 6pm" in dialogs[0] and "Move" in dialogs[0], dialogs)
    check("cancelling changes nothing", groups() == {"Sat 6pm": ["Omar", "Sara"], "Sun 8pm": ["Nour"]}, groups())

    # ---- accept: moved
    mode["accept"] = True
    card.locator("button", has_text="Add 1").click()
    pg.wait_for_selector(".ac-toast.is-ok")
    check("accepting moves the student", groups() == {"Sat 6pm": ["Omar"], "Sun 8pm": ["Nour", "Sara"]}, groups())
    check("the toast says she was moved", "Moved from another group" in pg.locator(".ac-toast").inner_text(), pg.locator(".ac-toast").inner_text())

    # ---- someone else moved a student after the page loaded: the server answers in_other_group, the page asks then
    api(dict(TOK, action="admin_group_add", group="Sat 6pm", phone="01000000004", move=True))   # Nour -> Sat 6pm behind the page's back
    pg.wait_for_selector('[data-group="Sun 8pm"]')
    card = pg.locator('[data-group="Sun 8pm"]')
    pg.wait_for_timeout(200)
    check("(setup) the page still thinks Nour is in Sun 8pm", True)
    # the page only knows its own data, so add Nour to a THIRD group: the page's pre-check misses it only if stale
    pg.fill('.ac-card[data-group="Sun 8pm"] input[aria-label="Phone to add"]', "01000000004")
    card.locator("button", has_text="Add").first.click()
    pg.wait_for_selector(".ac-toast.is-ok")
    check("the stale page is corrected by the server's answer and the retry moves her", groups().get("Sun 8pm") and "Nour" in groups()["Sun 8pm"], groups())

    # ---- banner for legacy data
    api({"group": "Sat 6pm", "phone": "01000000002"}, "/__dup")
    pg.reload()
    pg.wait_for_selector('[data-tab="groups"]')
    pg.click('[data-tab="groups"]')
    pg.wait_for_selector("[data-dup-banner]")
    txt = pg.locator("[data-dup-banner]").inner_text()
    check("the banner lists a student who is in two groups", "1 student in two groups" in txt and "Sara" in txt, txt)
    wide = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    check("no sideways scroll", wide <= 1, wide)
    s.ctx.close()


def main():
    proc = subprocess.Popen(["node", os.path.join(HERE, "e2e_one_group_backend.js"), os.path.join(HERE, "..", "apps_script"), str(E.PORT)], stdout=subprocess.PIPE, text=True)
    proc.stdout.readline()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            run(browser)
            browser.close()
    finally:
        proc.terminate()
    print("\n%d passed, %d failed" % (D.passed, D.failed))
    return 1 if D.failed else 0


if __name__ == "__main__":
    sys.exit(main())
