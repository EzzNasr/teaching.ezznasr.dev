#!/usr/bin/env python3
"""R-P25-C-QM: the Quiz Maker knows the "science" subject (Phase 2.5 step C). No tkinter needed.
SUBJECTS and teacher mode list science; the two science grade folders are found as lesson groups with their own
accent; the first lesson card added to an empty grade page replaces the "coming soon" note (on a temp copy); a
science-only token shows only Science and guards other subjects.
Step G (R-P25-G-QM): the owner's seeded lessons (seeds/science.json, seed_lessons.py) are found in both grades with
their titles; a teacher's videos go to the server only, never into a page; in the real tabs (hidden window) a teacher
cannot rename, add or delete lessons or write pages, while videos, quiz questions and files stay."""
import os, shutil, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
QM = os.path.abspath(os.path.join(HERE, ".."))
SITE = os.path.abspath(os.path.join(QM, "..", ".."))
sys.path.insert(0, QM)
from modules import common as c, teacher_mode as tm   # noqa: E402

fails = 0
def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)))
    fails += 0 if ok else 1

GRADES = ["preparatory/grade-3-preparatory", "secondary/grade-1-secondary"]
check("SUBJECTS has science", ("science", "Science") in c.SUBJECTS, c.SUBJECTS)
check("teacher mode knows science", "science" in tm.KNOWN_SUBJECTS and tm.subject_of("science/secondary/grade-1-secondary/x") == "science")
check("the site's science grades are lesson groups", c.list_lesson_groups(SITE, "science") == GRADES, c.list_lesson_groups(SITE, "science"))
check("each science grade has its own accent", [c.track_class_for_group("science", g) for g in GRADES] == ["track-one", "track-two"])

tmp = tempfile.mkdtemp()
try:
    shutil.copytree(os.path.join(SITE, "science"), os.path.join(tmp, "science"))
    gpage = os.path.join(tmp, "science", *GRADES[1].split("/"), "index.html")
    EMPTY_NOTE = chr(10) + '<p class="empty">Lessons coming soon.</p>' + chr(10)
    with open(gpage, encoding="utf-8") as f:     # back to the empty grade page (before the owner's seeded lessons)
        empty = c._GRID_CONTAINER_RE.sub(lambda m: m.group(1) + EMPTY_NOTE + m.group(3), f.read(), count=1)
    with open(gpage, "w", encoding="utf-8") as f:
        f.write(empty)
    kind = c.upsert_lesson_card(tmp, "science", GRADES[1], "chapter-1-lesson-1-matter", "Chapter 1 Lesson 1 | Matter", "States of matter.")
    with open(os.path.join(tmp, "science", *GRADES[1].split("/"), "index.html"), encoding="utf-8") as f:
        html = f.read()
    check("first lesson is added as a grid card", kind == "grid" and 'href="./chapter-1-lesson-1-matter/"' in html, kind)
    check("the 'coming soon' note is gone once a lesson exists", 'class="empty"' not in html)
    check("the page structure is intact after the insert", html.count("</section>") == 2 and html.rstrip().endswith("</html>"))
    c.upsert_lesson_card(tmp, "science", GRADES[1], "chapter-1-lesson-2-energy", "Chapter 1 Lesson 2 | Energy", "")
    with open(os.path.join(tmp, "science", *GRADES[1].split("/"), "index.html"), encoding="utf-8") as f:
        html = f.read()
    check("a second lesson is numbered after the first", html.count('class="lesson"') == 2 and '<span class="number">02</span>' in html)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

subjects = list(c.SUBJECTS)
st = tm.apply(tm.identity_from_ping({"ok": True, "kind": "teacher", "subjects": ["science"], "name": "Science Teacher"}), subjects)
check("a science token shows only Science", subjects == [("science", "Science")] and st["restricted"], (subjects, st))
check("a science token may work on science", tm.allowed("science/preparatory/grade-3-preparatory/l1"))
check("a science token is stopped on math and programming", not tm.allowed("math/x/y") and not tm.allowed("programming/baccalaureate/grade-1-secondary/l"))
tm.reset()

# ---- Phase 2.5 step G: the owner seeds the lessons, the teacher fills them in ---------------------------------------
import json, re   # noqa: E401,E402
import seed_lessons as sl   # noqa: E402
from modules import drive_bridge as db   # noqa: E402

with open(os.path.join(QM, "seeds", "science.json"), encoding="utf-8") as f:
    SEED = json.load(f)
PLAN = sl.planned(SEED)
plan = [(x["group"], x["slug"], x["title"]) for x in PLAN]
check("the science seed has lessons in both grades", SEED["subject"] == "science" and
      sorted({g for g, _s, _t in plan}) == sorted(GRADES), sorted({g for g, _s, _t in plan}))
check("seeded folders are neutral (chapter-<n>-lesson-<m>)", all(re.fullmatch(r"chapter-\d+-lesson-\d+", s) for _g, s, _t in plan))
prep = [x for x in PLAN if x["group"] == GRADES[0]]
check("3rd Prep is the teacher's list: 4 units x (شرح, تجميعات Give reason & What happens, حل أسئلة, امتحانين شاملين)",
      [x["title"] for x in prep[:4]] == ["Unit 1 | شرح", "Unit 1 | تجميعات Give reason & What happens", "Unit 1 | حل أسئلة", "Unit 1 | امتحانين شاملين"]
      and len(prep) == 16 and prep[-1]["slug"] == "chapter-4-lesson-4", [x["title"] for x in prep[:4]])
check("3rd Prep: only the exams have a quiz, no lesson has an assignment",
      [x["quiz"] for x in prep] == [False, False, False, True] * 4 and not any(x["assignment"] for x in prep))
for g in GRADES:
    want = sorted(s for gg, s, _t in plan if gg == g)
    got = c.list_existing_lessons(SITE, "science", g)
    check("every seeded lesson is found in %s" % g, got == want, (got, want))
    with open(os.path.join(SITE, "science", *g.split("/"), "index.html"), encoding="utf-8") as f:
        page = f.read()
    missing = [t for gg, s, t in plan if gg == g and ('href="./%s/"' % s not in page or "<h3>%s</h3>" % t not in page)]
    check("the %s page lists every seeded lesson with its title" % g, not missing and 'class="empty"' not in page, missing[:3])
    bad = []
    for x in PLAN:
        if x["group"] != g:
            continue
        d = os.path.join(SITE, "science", *g.split("/"), x["slug"])
        with open(os.path.join(d, "index.html"), encoding="utf-8") as f:
            idx = f.read()
        key = "science/%s/%s" % (g, x["slug"])
        ok = (os.path.isfile(os.path.join(d, "quiz.html")) and os.path.isfile(os.path.join(d, "attachments.json"))
              and os.path.isfile(os.path.join(d, "assignment.html")) == x["assignment"]
              and ('href="/%s/quiz.html"' % key in idx) == x["quiz"]
              and ('href="/%s/assignment.html"' % key in idx) == x["assignment"]
              and "0 questions" not in idx)
        if not ok:
            bad.append(x["slug"])
    check("every seeded lesson in %s has exactly the pages and links the seed asks for" % g, not bad, bad[:4])

# seeding again on a copy changes nothing (the lessons are the Quiz Maker's own output, and existing ones are kept)
tmp = tempfile.mkdtemp()
try:
    shutil.copytree(os.path.join(SITE, "science"), os.path.join(tmp, "science"))
    check("seeding again keeps every existing lesson", sl.seed(tmp, SEED, log=lambda *_a: None) == [])
    one = {"subject": "science", "groups": [{"group": GRADES[1], "chapters": [{"lessons": ["Cells"]}]}]}
    shutil.rmtree(os.path.join(tmp, "science", *GRADES[1].split("/"), "chapter-1-lesson-1"))
    made = sl.seed(tmp, one, log=lambda *_a: None)
    with open(os.path.join(tmp, "science", *GRADES[1].split("/"), "chapter-1-lesson-1", "index.html"), encoding="utf-8") as f:
        lesson = f.read()
    check("a seeded lesson is a Quiz Maker lesson page with the owner's title",
          made == ["chapter-1-lesson-1"] and "Chapter 1 Lesson 1 | Cells" in lesson and 'class="media-slot"' in lesson)
    # --rewrite: an existing lesson gets a new title and loses its quiz link and assignment page; its files stay
    att = os.path.join(tmp, "science", *GRADES[1].split("/"), "chapter-1-lesson-2", "attachments.json")
    with open(att, "w", encoding="utf-8") as f:
        f.write('[{"title": "Kept", "drive_file_id": "1keepAAAAAAAAAAAA", "type": "pdf"}]')
    two = {"subject": "science", "groups": [{"group": GRADES[1], "title_format": "Unit {chapter} | {title}", "assignment": False,
                                             "chapters": [{"lessons": ["Cells", {"title": "Atoms", "quiz": False}]}]}]}
    check("without --rewrite existing lessons are kept", sl.seed(tmp, two, log=lambda *_a: None) == [])
    made = sl.seed(tmp, two, log=lambda *_a: None, rewrite=(GRADES[1],))
    d2 = os.path.join(tmp, "science", *GRADES[1].split("/"), "chapter-1-lesson-2")
    with open(os.path.join(d2, "index.html"), encoding="utf-8") as f:
        idx = f.read()
    with open(att, encoding="utf-8") as f:
        kept = f.read()
    check("--rewrite: new title, no quiz link, no assignment page, files kept",
          made == ["chapter-1-lesson-1", "chapter-1-lesson-2"] and "<h1>Unit 1 | Atoms</h1>" in idx and "quiz.html" not in idx.split("lesson-links")[1][:400]
          and not os.path.exists(os.path.join(d2, "assignment.html")) and os.path.isfile(os.path.join(d2, "quiz.html")) and "Kept" in kept, (made, kept))
    check("the title format: an empty title keeps only the head", sl.lesson_title(2, 3, "", "Unit {chapter} | {title}") == "Unit 2" and sl.lesson_title(2, 3, "") == "Chapter 2 Lesson 3")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# teacher mode: videos go to the backend only, never into the page
tm.apply(tm.identity_from_ping({"ok": True, "kind": "teacher", "subjects": ["science"], "name": "T"}), list(c.SUBJECTS))
check("a science teacher's lessons are locked (made by the owner)", tm.locks_lessons())
tmp = tempfile.mkdtemp()
calls, saved = [], db.set_video
try:
    page = os.path.join(tmp, "index.html")
    with open(page, "w", encoding="utf-8") as f:
        f.write('<div class="media-slot">Video coming soon</div>')
    db.set_video = lambda *a: calls.append(a)
    url, used = c.set_lesson_video("https://x.invalid/exec", "tok", "science/secondary/grade-1-secondary/chapter-1-lesson-1",
                                   "lesson", "https://youtu.be/abcdefghijk", "T", page)
    with open(page, encoding="utf-8") as f:
        after = f.read()
    check("teacher: a video is saved on the server and the lesson page is not touched",
          used and len(calls) == 1 and calls[0][3] == "lesson" and after == '<div class="media-slot">Video coming soon</div>', (calls, after))
    tm.reset()
    c.set_lesson_video("https://x.invalid/exec", "tok", "science/x/y", "lesson", "https://youtu.be/abcdefghijk", "T", page)
    with open(page, encoding="utf-8") as f:
        check("owner: the page still gets the loading placeholder as before", "Loading video" in f.read())
finally:
    db.set_video = saved
    tm.reset()
    shutil.rmtree(tmp, ignore_errors=True)
check("an owner token locks nothing", not tm.locks_lessons())

# the real tabs in a hidden window: a teacher cannot rename, add or delete lessons; videos, questions, files stay
try:
    import tkinter as tk
    root = tk.Tk()
    root.withdraw()
    from modules import theme
    theme.apply(root)
except Exception as e:
    root = None
    print("SKIP teacher-mode window checks: no tkinter / no display (%s)" % e.__class__.__name__)
if root is not None:
    from tkinter import messagebox
    from modules.quiz_tab import QuizTab
    from modules.assignment_tab import AssignmentTab
    from modules.attachment_tab import AttachmentTab
    shown = []
    messagebox.showinfo = lambda *a, **k: shown.append(a)
    site_var, status = tk.StringVar(master=root, value=SITE), tk.StringVar(master=root)
    q, a = QuizTab(root, site_var, status), AssignmentTab(root, site_var, status)
    att = AttachmentTab(root, site_var, status)
    for w in (q, a, att):
        w.pack()
    packed = lambda w: w.winfo_manager() != ""
    owner_ok = packed(q.generate_btn) and packed(q.new_lesson_btn) and str(q.lesson_name_entry["state"]) == "normal"
    q.apply_teacher_lock(True)
    a.apply_teacher_lock(True)
    check("teacher: lesson name and description are read-only",
          str(q.lesson_name_entry["state"]) == "readonly" and str(q.lesson_desc_entry["state"]) == "readonly")
    check("teacher: no New lesson, Delete / Recover / Empty trash, assignment settings or Generate",
          not any(packed(w) for w in (q.new_lesson_btn, q.lesson_admin_row, q._frames["assign"], q.generate_btn)))
    check("teacher: the video Update buttons and Save quiz questions are there",
          all(packed(w) for w in (q.video_update_btn, q.solution_update_btn, q.save_questions_btn, q.load_btn)))
    check("teacher: the assignment page's text, type, questions and Update are hidden; its two videos stay",
          not any(packed(w) for w in a._page_frames) and packed(a.video_btn) and packed(a.solution_btn))
    check("teacher: the Attachment section keeps upload, replace and delete",
          all(packed(w) for w in (att.upload_btn, att.replace_btn, att.delete_btn)))
    tmp = tempfile.mkdtemp()
    try:
        site_var.set(tmp)
        q.lesson_name_var.set("Chapter 9 Lesson 9 | Mine")
        q.questions = [{"type": "tf", "q": "x", "answer": True}]
        before = len(shown)
        q._generate(); q._new_lesson(); q._delete_lesson(); a._update()
        check("teacher: Generate, New lesson, Delete and Update assignment page refuse and write nothing",
              len(shown) - before == 4 and os.listdir(tmp) == [], (shown[before:], os.listdir(tmp)))
    finally:
        site_var.set(SITE)
        shutil.rmtree(tmp, ignore_errors=True)
    q.apply_teacher_lock(False)
    a.apply_teacher_lock(False)
    check("owner: everything is back after unlocking", owner_ok and packed(q.generate_btn) and packed(q.new_lesson_btn)
          and packed(q.lesson_admin_row) and not packed(q.save_questions_btn) and all(packed(w) for w in a._page_frames)
          and str(q.lesson_name_entry["state"]) == "normal")
    root.destroy()

sys.exit(1 if fails else 0)
