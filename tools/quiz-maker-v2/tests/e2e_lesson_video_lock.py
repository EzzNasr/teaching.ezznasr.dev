#!/usr/bin/env python3
"""
e2e_lesson_video_lock.py — the Lessons tab of dashboard/access.html can open a video that is
locked on its own (videos are born locked; the lesson switch alone never opens them).

    python tests/e2e_lesson_video_lock.py        (run from tools/quiz-maker-v2)
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_dashboard as D
from playwright.sync_api import sync_playwright

E = D.E
L = "programming/other/functions"
n_ok = n_bad = 0


def check(name, cond, extra=""):
    global n_ok, n_bad
    if cond: n_ok += 1; print("PASS " + name)
    else: n_bad += 1; print("FAIL " + name + ("  -> " + str(extra)[:300] if extra else ""))


def vid_state(slot):
    ov = D.overview()
    return [v for v in ov["videos"] if v["lesson"] == L and v["slot"] == slot][0]["locked"]


def open_lessons(browser, admin):
    s = D.open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector(".dash-stats")
    pg.click('[data-tab="lessons"]')
    pg.wait_for_selector('[data-lesson="%s"]' % L)
    return s, pg


def run(browser):
    admin_reg = D.api({"action": "register_student", "phone": "01000000001", "password_hash": D.sha("adm"), "display_name": "Teacher", "year": "Senior 1", "parent_phone": "01100000001"})
    D.api({"phone": "01000000001"}, "/__make_admin")
    admin = D.login("01000000001", "adm")
    E.set_video(L, "lesson", "AAAAAAAAAAA", locked=True)
    E.set_video(L, "quiz", "BBBBBBBBBBB", locked=True)
    D.api(dict(D.TOK, action="admin_set_lesson_lock", lesson=L, locked=False))       # lesson OPEN, videos locked on their own

    # 1. the situation from the bug report: card says open, videos say locked, and there is a button per video
    s, pg = open_lessons(browser, admin)
    card = pg.locator('[data-lesson="%s"]' % L)
    txt = card.inner_text()
    check("card shows the lesson as open", "lesson open" in txt.lower(), txt)
    check("card explains a video is locked on its own", "locked on its own" in txt, txt)
    check("one toggle per video", card.locator("[data-video-toggle]").count() == 2)

    # 2. one video: open just the lesson video
    card.locator('[data-video-toggle="lesson"]').click()
    pg.wait_for_selector('[data-panel="video-lock"]')
    pg.click('[data-panel="video-lock"] .ac-btn.primary')
    pg.wait_for_timeout(500)
    check("lesson video is now open on the server", vid_state("lesson") is False)
    check("quiz video untouched", vid_state("quiz") is True)
    check("card reflects it", "Open to everyone" in pg.locator('[data-lesson="%s"]' % L).inner_text())
    s.ctx.close()

    # 3. lock it again, then lock the lesson and reopen with the "also open videos" box
    D.api(dict(D.TOK, action="admin_set_video", lesson=L, slot="lesson", locked=True))
    D.api(dict(D.TOK, action="admin_set_lesson_lock", lesson=L, locked=True))
    s, pg = open_lessons(browser, admin)
    card = pg.locator('[data-lesson="%s"]' % L)
    card.get_by_text("Open it…", exact=True).first.click()
    pg.wait_for_selector('[data-panel="lesson-lock"]')
    box = pg.locator("#lsn-also-open")
    check("the 'also open videos' box is offered and ticked", box.count() == 1 and box.is_checked())
    pg.click('[data-panel="lesson-lock"] .ac-btn.primary')
    pg.wait_for_timeout(700)
    check("lesson is open", not [l for l in D.overview()["lesson_locks"] if l["lesson"] == L and l["locked"]])
    check("both videos opened by the same click", vid_state("lesson") is False and vid_state("quiz") is False)
    s.ctx.close()

    # 4. unticking the box opens only the lesson
    D.api(dict(D.TOK, action="admin_set_video", lesson=L, slot="lesson", locked=True))
    D.api(dict(D.TOK, action="admin_set_video", lesson=L, slot="quiz", locked=True))
    D.api(dict(D.TOK, action="admin_set_lesson_lock", lesson=L, locked=True))
    s, pg = open_lessons(browser, admin)
    pg.locator('[data-lesson="%s"]' % L).get_by_text("Open it…", exact=True).first.click()
    pg.wait_for_selector("#lsn-also-open")
    pg.uncheck("#lsn-also-open")
    pg.click('[data-panel="lesson-lock"] .ac-btn.primary')
    pg.wait_for_timeout(700)
    check("unticked: lesson opens but videos stay locked", vid_state("lesson") is True and vid_state("quiz") is True)
    s.ctx.close()

    # 5. a student with a paid grant can now actually watch after the video is opened
    stu = D.reg("01000000002", "b", "Sara")
    check("student cannot watch a locked video", not D.can_watch(stu, L))
    D.api(dict(D.TOK, action="admin_set_video", lesson=L, slot="lesson", locked=False))
    D.api(dict(D.TOK, action="admin_set_lesson_lock", lesson=L, locked=False))
    check("student can watch once video and lesson are open", D.can_watch(stu, L))


def main():
    backend = E.start_backend()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            run(b)
            b.close()
    finally:
        backend.terminate()
    print("\n%d passed, %d failed" % (n_ok, n_bad))
    return 1 if n_bad else 0


if __name__ == "__main__":
    sys.exit(main())
