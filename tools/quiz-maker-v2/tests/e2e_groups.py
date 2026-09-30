#!/usr/bin/env python3
"""
e2e_groups.py - real-browser test of the roster picker on the Groups tab of dashboard/access.html.
Same setup as e2e_dashboard.py (real Code.gs through the Node harness, real page, Playwright).

    python tests/e2e_groups.py        (run from tools/quiz-maker-v2)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_dashboard as D
from playwright.sync_api import sync_playwright

E, check, api, TOK = D.E, D.check, D.api, D.TOK


def groups():
    return {g["group"]: g for g in D.overview()["groups"]}


def run(browser):
    S, P = D.seed()
    admin = S["admin"]

    s = D.open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector('[data-tab="groups"]')
    pg.click('[data-tab="groups"]')
    pg.wait_for_selector("text=New group")

    # ---- create a group by ticking students from the roster ----------------------------------------------------
    check("no groups yet", not groups())
    go = pg.locator("button", has_text="Create group").last
    check("Create is disabled until there is a name and a student", go.is_disabled())
    pg.fill('input[aria-label="New group name"]', "Section A")
    pg.locator(".ac-pick > summary").last.click()
    items = pg.locator(".ac-pick[open] .ac-pickitem")
    check("the picker lists the whole roster", items.count() == 6, items.count())
    pg.fill('.ac-pick[open] input[aria-label="Search students"]', "sara")
    check("search narrows the list", pg.locator(".ac-pick[open] .ac-pickitem:visible").count() == 1)
    pg.locator(".ac-pick[open] .ac-pickitem:visible input").check()
    pg.fill('.ac-pick[open] input[aria-label="Search students"]', "")
    pg.locator(".ac-pick[open] .ac-pickitem", has_text="Omar").locator("input").check()
    pg.locator(".ac-pick[open] .ac-pickitem", has_text="Nour").locator("input").check()
    check("the counter follows the ticks", "3 selected" in pg.locator(".ac-pick[open] .ac-picktools").inner_text())
    go = pg.locator("button", has_text="Create group with 3")
    check("the button says how many", go.count() == 1)
    go.click()
    pg.wait_for_selector(".ac-toast.is-ok")
    g = groups().get("Section A")
    check("the group was created with all three, names from the roster",
          g and sorted(m["name"] for m in g["members"]) == ["Nour", "Omar", "Sara"], g)

    # ---- add more from the group's card: members already in it are not offered -----------------------------------
    pg.wait_for_selector('[data-group="Section A"]')
    card = pg.locator('[data-group="Section A"]')
    card.locator(".ac-pick > summary").first.click()
    offered = card.locator(".ac-pick[open] .ac-pickitem").all_inner_texts()
    check("members already in the group are not offered again", not any("Sara" in t or "Omar" in t or "Nour" in t for t in offered), offered)
    check("...the rest of the roster is (Teacher, Hana, Mo)", len(offered) == 3, offered)
    card.locator(".ac-pick[open] .ac-pickitem", has_text="Hana").locator("input").check()
    card.locator("button", has_text="Add 1").click()
    pg.wait_for_selector(".ac-toast.is-ok")
    check("Hana joined", len(groups()["Section A"]["members"]) == 4)

    # ---- permissions to the whole group, identically, then revoke (backend actions the panel calls) ---------------
    api(dict(TOK, action="admin_group_grant_access", group="Section A", scope=D.L2, days=10))
    check("everyone in the group can watch", all(D.can_watch(S[k], D.L2) for k in ("sara", "omar", "nour", "hana")))
    api(dict(TOK, action="admin_group_revoke_access", group="Section A", scope=D.L2))
    check("revoking takes it from the whole group", not any(D.can_watch(S[k], D.L2) for k in ("sara", "omar", "nour", "hana")))

    # ---- remove several at once ---------------------------------------------------------------------------------------------
    pg.wait_for_selector('[data-group="Section A"]')
    card = pg.locator('[data-group="Section A"]')
    card.locator(".ac-pickwrap", has_text="Remove students").locator("summary").click()
    card.locator(".ac-pick[open] .ac-pickitem", has_text="Sara").locator("input").check()
    card.locator(".ac-pick[open] .ac-pickitem", has_text="Hana").locator("input").check()
    card.locator("button", has_text="Remove 2").click()
    pg.wait_for_selector(".ac-toast.is-ok")
    check("two members removed in one go", sorted(m["name"] for m in groups()["Section A"]["members"]) == ["Nour", "Omar"])
    s.ctx.close()

    # ---- phone width ------------------------------------------------------------------------------------------------------------------
    s = D.open_dash(browser, admin, width=390)
    pg = s.page
    pg.wait_for_selector('[data-tab="groups"]')
    pg.click('[data-tab="groups"]')
    pg.wait_for_selector('[data-group="Section A"]')
    pg.locator(".ac-pick > summary").first.click()
    pg.wait_for_timeout(150)
    wide = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    check("phone width: the open picker does not scroll the page sideways", wide <= 1, wide)
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
    print("\n%d passed, %d failed" % (D.passed, D.failed))
    return 1 if D.failed else 0


if __name__ == "__main__":
    sys.exit(main())
