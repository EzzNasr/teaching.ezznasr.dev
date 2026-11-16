#!/usr/bin/env python3
"""R-QM-QLIST: question-list operations behind the multi-select list (modules/qlist.py).
Remove many at once, keep only the selected, duplicate (written copies get a new qid), move up/down/top/bottom
as a block, set the chapter of many, the summary line. Pure Python, no tkinter."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..")))
from modules import qlist  # noqa: E402

fails = 0


def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)))
    fails += 0 if ok else 1


def Q(n, t="mcq", ch=1, **kw):
    d = {"type": t, "prompt": "q%d" % n, "chapter": ch}
    d.update(kw)
    return d


def names(items):
    return [q["prompt"] for q in items]


base = [Q(1), Q(2, "truefalse"), Q(3, "match", 2), Q(4, "written", 2, qid="w1"), Q(5)]
snapshot = [dict(q) for q in base]

# remove
out, sel = qlist.remove(base, [1, 3])
check("remove several at once", names(out) == ["q1", "q3", "q5"] and sel == [], names(out))
check("remove ignores out-of-range and duplicate indexes", names(qlist.remove(base, [0, 0, 9, -1])[0]) == ["q2", "q3", "q4", "q5"])
check("remove with nothing selected changes nothing", names(qlist.remove(base, [])[0]) == names(base))
check("input list never changed", base == snapshot)

# keep only
out, sel = qlist.keep_only(base, [4, 0])
check("keep only the selected, in list order", names(out) == ["q1", "q5"] and sel == [0, 1], (names(out), sel))

# duplicate
ids = iter(["w2", "w3"])
out, sel = qlist.duplicate(base, [0, 3], new_qid=lambda: next(ids))
check("duplicate puts copies after the last selected", names(out) == ["q1", "q2", "q3", "q4", "q1", "q4", "q5"], names(out))
check("duplicate selects the copies", sel == [4, 5], sel)
check("written copy gets a fresh qid, original keeps its own", out[5]["qid"] == "w2" and out[3]["qid"] == "w1")
check("copies are independent objects", out[4] is not base[0] and out[4] == base[0])
check("input list never changed (duplicate)", base == snapshot)

# move
out, sel = qlist.move(base, [1, 2], -1)
check("move a block up", names(out) == ["q2", "q3", "q1", "q4", "q5"] and sel == [0, 1], (names(out), sel))
out, sel = qlist.move(base, [0, 1], -1)
check("block already at the top stays", names(out) == names(base) and sel == [0, 1])
out, sel = qlist.move(base, [1, 3], 1)
check("move non-adjacent rows down", names(out) == ["q1", "q3", "q2", "q5", "q4"] and sel == [2, 4], (names(out), sel))
out, sel = qlist.move(base, [4], 1)
check("last row cannot move down", names(out) == names(base) and sel == [4])
out, sel = qlist.move_to(base, [2, 4], "top")
check("move to top keeps order", names(out) == ["q3", "q5", "q1", "q2", "q4"] and sel == [0, 1], (names(out), sel))
out, sel = qlist.move_to(base, [0, 2], "bottom")
check("move to bottom keeps order", names(out) == ["q2", "q4", "q5", "q1", "q3"] and sel == [3, 4], (names(out), sel))
check("input list never changed (move)", base == snapshot)

# set chapter
out, sel = qlist.set_chapter(base, [0, 1, 4], 7)
check("set chapter of several", [q["chapter"] for q in out] == [7, 7, 2, 2, 7] and sel == [0, 1, 4])
check("set chapter does not touch the originals", [q["chapter"] for q in base] == [1, 1, 2, 2, 1])

# rows and summary
check("row: number, chapter, type, one-line text", qlist.row(0, {"type": "mcq", "prompt": "a\n b", "chapter": 3}) == ("1", "3", "MCQ", "a b"))
check("row: legacy question (q key, no type)", qlist.row(1, {"q": "old", "chapter": 1})[2:] == ("MCQ", "old"))
check("row: long text is cut with an ellipsis", qlist.row(0, {"prompt": "x" * 300})[3].endswith("…"))
check("summary", qlist.summary(base) == "5 questions · 2 MCQ, 1 T/F, 1 Match, 1 Written · chapters 1–2",
      qlist.summary(base))
check("summary of one chapter", qlist.summary([Q(1)]) == "1 question · 1 MCQ · chapter 1", qlist.summary([Q(1)]))
check("summary of nothing", qlist.summary([]) == "No questions yet")

print("\n%s (%d failure%s)" % ("ALL PASS" if not fails else "FAILED", fails, "" if fails == 1 else "s"))
sys.exit(1 if fails else 0)
