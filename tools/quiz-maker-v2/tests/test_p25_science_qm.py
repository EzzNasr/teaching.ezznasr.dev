#!/usr/bin/env python3
"""R-P25-C-QM: the Quiz Maker knows the "science" subject (Phase 2.5 step C). No tkinter needed.
SUBJECTS and teacher mode list science; the two science grade folders are found as lesson groups with their own
accent; the first lesson card added to an empty grade page replaces the "coming soon" note (on a temp copy); a
science-only token shows only Science and guards other subjects."""
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

sys.exit(1 if fails else 0)
