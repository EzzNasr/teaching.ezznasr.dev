#!/usr/bin/env python3
"""
e2e_p3_bulk_access.py -- Phase 3 / S4: the "Bulk access" tab of dashboard/access.html in a real browser, against the real
Code.gs + Phase3_BulkAccess.gs. Ticks lessons x groups + a student, previews, applies, reads the result, revokes, and gives back.

    python tests/e2e_p3_bulk_access.py        (run from tools/quiz-maker-v2; needs playwright + chromium)
"""
import os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_dashboard as D
import e2e_video as E
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
APPS = os.path.join(HERE, "..", "apps_script")
LESSONS = ["programming/other/functions", "programming/other/loops", "english/grammar-basics"]


def entitlements():
    ov = E.api(dict(E.TOK, action="admin_access_overview"))
    return [a for a in ov["access"] if a["state"] == "active"]


def run(browser):
    E.api({"action": "register_student", "phone": "01000000001", "password_hash": E.sha("adm"), "display_name": "Teacher", "year": "Senior 1", "parent_phone": "01100000001"})
    E.api({"phone": "01000000001"}, "/__make_admin")
    admin = D.login("01000000001", "adm")
    for i, ph in enumerate(["01000000002", "01000000003", "01000000004", "01000000005"]):
        E.api({"action": "register_student", "phone": ph, "password_hash": E.sha("x"), "display_name": "S%d" % i, "year": "Senior 1", "parent_phone": "01100000009"})
    E.api(dict(E.TOK, action="admin_group_add", group="GroupA", phones=["01000000002", "01000000003"]))
    E.api(dict(E.TOK, action="admin_group_add", group="GroupB", phones=["01000000004"]))
    for l in LESSONS:
        E.set_video(l, "lesson", "AAAAAAAAAAA", locked=True)

    s = D.open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector(".dash-stats")
    pg.click('[data-tab="bulk"]')
    pg.wait_for_selector('[data-bulk="preview"]')
    D.check("bulk tab opens, apply is disabled until a preview", pg.is_disabled('[data-bulk="apply"]') and pg.is_disabled('[data-bulk="preview"]'))

    # tick every lesson shown, both groups
    pg.click("text=Select all shown")
    pg.locator('.bk-box:nth-child(2) input[type=checkbox]').nth(0).check()
    pg.locator('.bk-box:nth-child(2) input[type=checkbox]').nth(1).check()
    pg.select_option("#bk-term", "never")
    D.check("preview is enabled once lessons + groups are picked", not pg.is_disabled('[data-bulk="preview"]'))
    pg.click('[data-bulk="preview"]')
    pg.wait_for_function("document.querySelector('.ac-preview') && document.querySelector('.ac-preview').textContent.indexOf('=') > -1")
    txt = pg.inner_text(".ac-preview")
    D.check("preview says 3 lessons x 3 students = 9 grants, all new", "3 lessons" in txt and "3 students" in txt and "9 grants" in txt and "9 new" in txt, txt)
    D.check("preview changed nothing", len(entitlements()) == 0)
    D.check("apply is enabled after the preview", not pg.is_disabled('[data-bulk="apply"]'))

    # changing the selection invalidates the preview
    pg.locator('.bk-box:nth-child(2) input[type=checkbox]').nth(1).uncheck()
    D.check("changing the selection disables apply again", pg.is_disabled('[data-bulk="apply"]'))
    pg.locator('.bk-box:nth-child(2) input[type=checkbox]').nth(1).check()
    pg.click('[data-bulk="preview"]')
    pg.wait_for_function("document.querySelector('.ac-preview').textContent.indexOf('9 grants') > -1")

    pg.once("dialog", lambda d: d.accept())
    pg.click('[data-bulk="apply"]')
    pg.wait_for_selector('[data-bulk="result"]')
    res = pg.inner_text('[data-bulk="result"]')
    D.check("result shows 9 applied, 0 skipped", "9 applied" in res and "0 skipped" in res, res)
    D.check("9 rows really exist", len(entitlements()) == 9, len(entitlements()))
    # lists were cleared after apply
    D.check("selection is cleared after apply", pg.locator(".bk-list input:checked").count() == 0)

    # revoke mode
    pg.click('[data-bulk-mode="revoke"]')
    pg.wait_for_selector('[data-bulk="preview"]')
    pg.click("text=Select all shown")
    pg.locator('.bk-box:nth-child(2) input[type=checkbox]').nth(0).check()
    pg.click('[data-bulk="preview"]')
    pg.wait_for_function("document.querySelector('.ac-preview').textContent.indexOf('taken away') > -1")
    txt = pg.inner_text(".ac-preview")
    D.check("revoke preview: 6 will be taken away (GroupA = 2 students x 3)", "6 will be taken away" in txt, txt)
    pg.once("dialog", lambda d: d.accept())
    pg.click('[data-bulk="apply"]')
    pg.wait_for_selector('[data-bulk="undo"]')
    D.check("revoke removed 6, GroupB keeps its 3", len(entitlements()) == 3, len(entitlements()))
    pg.click('[data-bulk="undo"]')
    pg.wait_for_function("document.querySelector('[data-bulk=undo]') === null")
    D.check("'Give these back' restores the 6", len(entitlements()) == 9, len(entitlements()))
    s.ctx.close()


def main():
    proc = subprocess.Popen(["node", os.path.join(HERE, "e2e_p3_bulk_backend.js"), os.path.join(APPS, "Code.gs"),
                             os.path.join(APPS, "chunks", "Phase3_BulkAccess.gs"), str(E.PORT)], stdout=subprocess.PIPE, text=True)
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
