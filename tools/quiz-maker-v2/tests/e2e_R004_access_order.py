#!/usr/bin/env python3
"""
e2e_R004_access_order.py -- R-004 (and R-003 on screen): the "Each lesson and who can watch it" list on
dashboard/access.html is ordered year > chapter > lesson NUMBER, one group per lesson, even when the grants
sit on the three old spellings of a key (the Oct 2026 rename incident).

Reproduces the screenshot: grants on `lesson-1-...`, `lesson-2-...`, `chaper-1-lesson-3-...` (old/typo keys)
next to grants on `chapter-1-lesson-4-...`, `chapter-2-lesson-1-...`, `chapter-2-lesson-2-...`.

    python tests/e2e_R004_access_order.py        (run from tools/quiz-maker-v2; needs playwright + chromium)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_dashboard as D          # same backend launcher, fake site and helpers
import e2e_video as E
from playwright.sync_api import sync_playwright

G2 = "programming/baccalaureate/grade-2-secondary/"
G1 = "programming/baccalaureate/grade-1-secondary/"
# (grant scope as stored in the sheet, expected position, expected heading text)
GRANTS = [
    (G2 + "chapter-2-lesson-2-network-security-design", 6, "Chapter 2 \u00b7 Lesson 2"),
    (G2 + "chapter-1-lesson-10-future-topic", 4, "Chapter 1 \u00b7 Lesson 10"),                      # text order would put 10 before 2
    (G2 + "chaper-1-lesson-3-ai-in-daily-life-and-industry", 2, "Chapter 1 \u00b7 Lesson 3"),       # typo key
    (G2 + "chapter-1-lesson-4-ethical-issues-with-ai", 3, "Chapter 1 \u00b7 Lesson 4"),
    (G2 + "lesson-2-how-ai-works", 1, "Chapter 1 \u00b7 Lesson 2"),                                 # old key
    (G2 + "chapter-2-lesson-1-cryptographic-technologies-and-authentication", 5, "Chapter 2 \u00b7 Lesson 1"),
    (G2 + "lesson-1-development-of-information-technology-and-social-transformation", 0, "Chapter 1 \u00b7 Lesson 1"),  # old key
]


def run(browser):
    admin_reg = E.api({"action": "register_student", "phone": "01000000001", "password_hash": E.sha("adm"),
                       "display_name": "Teacher", "year": "Senior 2", "parent_phone": "01100000001"})
    E.api({"phone": "01000000001"}, "/__make_admin")
    admin = D.login("01000000001", "adm")
    E.api({"action": "register_student", "phone": "01000000002", "password_hash": E.sha("b"), "display_name": "Sara",
           "year": "Senior 2", "parent_phone": "01100000009"})
    for scope, _, _ in GRANTS:
        E.api(dict(E.TOK, action="admin_grant_access", phone="01000000002", scope=scope, never=True))
    # a second person on one old-key lesson, so the grouping has to MERGE old and new spellings of the same lesson
    E.api({"action": "register_student", "phone": "01000000003", "password_hash": E.sha("c"), "display_name": "Omar",
           "year": "Senior 2", "parent_phone": "01100000009"})
    E.api(dict(E.TOK, action="admin_grant_access", phone="01000000003", scope=G2 + "chapter-1-lesson-2-how-ai-works", never=True))

    s = D.open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector(".dash-stats")
    pg.click('[data-tab="access"]')
    pg.wait_for_selector('[data-view="lesson"]')
    pg.click('[data-view="lesson"]')
    pg.wait_for_selector(".ac-grp")
    titles = [t.strip() for t in pg.locator(".ac-grp-title b").all_inner_texts()]
    subs = [t.strip() for t in pg.locator(".ac-grp-title small").all_inner_texts()]
    D.check("seven lesson groups (old and new spellings of one lesson are ONE group)", len(titles) == 7, titles)
    order_ok = len(titles) == 7 and all(titles[pos].startswith(head) for _, pos, head in GRANTS for pos in [pos])
    D.check("R-004: ordered Ch1 L1, L2, L3, L4, L10, then Ch2 L1, L2", order_ok, titles)
    D.check("R-003 on screen: Lesson 2 shows both people (old-key grant + new-key grant merged)",
            len(titles) == 7 and "2 people" in pg.locator(".ac-grp-meta b").nth(1).inner_text(), pg.locator(".ac-grp-meta b").all_inner_texts())
    D.check("no group still shows the typo spelling 'chaper'", not any("chaper" in x for x in subs), subs)
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
