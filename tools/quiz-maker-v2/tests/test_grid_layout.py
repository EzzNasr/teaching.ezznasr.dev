"""Senior 1 / Senior 2 (and any grid-style group page): lessons are sectioned by chapter, ordered by chapter then lesson number, and
numbered consecutively, whatever order they were created or pushed in.  Run from tools/quiz-maker-v2:  python3 tests/test_grid_layout.py"""
import sys, os, re, shutil, tempfile, types
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, ".."))
class _D:
    def __init__(self, *a, **k): pass
def _stub(n):
    m = types.ModuleType(n); m.__getattr__ = lambda a: _D if a[:1].isupper() else (lambda *x, **k: None); return m
try:
    import tkinter  # noqa: F401
except ImportError:
    for n in ("tkinter", "tkinter.ttk", "tkinter.messagebox", "tkinter.filedialog"): sys.modules[n] = _stub(n)
    sys.modules["tkinter"].ttk = sys.modules["tkinter.ttk"]; sys.modules["tkinter"].messagebox = sys.modules["tkinter.messagebox"]
from modules import common as C

SITE = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
passed = 0
def ok(c, m):
    global passed
    if not c: raise AssertionError(m)
    passed += 1; print("PASS " + m)

def parse(html):
    """-> list of ('head', chapter-id) / ('card', slug, number) in page order"""
    out = []
    for m in re.finditer(r'<div class="chapter-head"[^>]*id="([^"]+)"|<a class="lesson" href="\./([^/"]+)/">\s*<span class="number">(\d+)</span>', html):
        out.append(("head", m.group(1)) if m.group(1) else ("card", m.group(2), m.group(3)))
    return out

def page(cards, label="Open lesson"):
    body = "\n".join('<a class="lesson" href="./%s/"><span class="number">%s</span><h3>%s</h3><p></p><span class="open">%s</span></a>' % (s, n, t, label) for s, n, t in cards)
    return '<section><div class="lessons">\n' + body + '\n</div>\n</div>\n</section>'

tmp = tempfile.mkdtemp()
try:
    # ── layout of a jumbled page ──
    jumbled = [("chapter-2-lesson-2-b", "7", "Chapter 2 Lesson 2 | B"), ("chapter-2-lesson-3-incident", "8", "C"), ("chapter-2-lesson-1-a", "6", "A"),
               ("chapter-1-lesson-2-y", "3", "Y"), ("intro-session", "1", "Intro"), ("chapter-1-lesson-1-x", "2", "X"), ("chapter-2-lesson-3-zzz", "9", "Z")]
    p = os.path.join(tmp, "index.html"); open(p, "w", encoding="utf-8").write(page(jumbled))
    ok(C.normalize_grid_index(p) is True, "a jumbled page is changed by normalize")
    seq = parse(open(p, encoding="utf-8").read())
    ok([x[1] for x in seq if x[0] == "card"] == ["intro-session", "chapter-1-lesson-1-x", "chapter-1-lesson-2-y", "chapter-2-lesson-1-a", "chapter-2-lesson-2-b", "chapter-2-lesson-3-incident", "chapter-2-lesson-3-zzz"],
       "order: lessons without a chapter first, then chapter 1, chapter 2; each by lesson number, ties by slug")
    ok([x[2] for x in seq if x[0] == "card"] == ["1", "2", "3", "4", "5", "6", "7"], "numbers are consecutive in the displayed order")
    ok([x[1] for x in seq if x[0] == "head"] == ["intro", "chapter-1", "chapter-2"], "one heading per chapter (plus the introduction), no repeats")
    ok(seq[0] == ("head", "intro") and seq[2][0] == "head" and seq[2][1] == "chapter-1", "each heading sits right before its lessons")
    ok(C.normalize_grid_index(p) is False, "normalizing an already-correct page changes nothing (idempotent)")

    # ── adding / removing lessons keeps it right ──
    C.upsert_grid_lesson_card(p, "chapter-1-lesson-3-new", "Chapter 1 Lesson 3 | New", "")
    seq = parse(open(p, encoding="utf-8").read()); cards = [x for x in seq if x[0] == "card"]
    ok([c[1] for c in cards][:4] == ["intro-session", "chapter-1-lesson-1-x", "chapter-1-lesson-2-y", "chapter-1-lesson-3-new"] and [c[2] for c in cards] == [str(i) for i in range(1, 9)],
       "a lesson added LATER but belonging to chapter 1 is placed in chapter 1 and everything is renumbered")
    C.upsert_grid_lesson_card(p, "chapter-3-lesson-1-first", "Chapter 3 Lesson 1 | First", "")
    seq = parse(open(p, encoding="utf-8").read())
    ok(seq[-2] == ("head", "chapter-3") and seq[-1][1] == "chapter-3-lesson-1-first", "a lesson of a brand-new chapter opens a new section at the end")
    ok(C.remove_grid_lesson_card(p, "chapter-1-lesson-1-x") is not None, "remove returns the removed card")
    cards = [x for x in parse(open(p, encoding="utf-8").read()) if x[0] == "card"]
    ok([c[2] for c in cards] == [str(i) for i in range(1, len(cards) + 1)], "after a removal the numbers stay consecutive (no gap)")
    C.upsert_grid_lesson_card(p, "chapter-1-lesson-2-y", "Chapter 1 Lesson 2 | Renamed", "d")
    html = open(p, encoding="utf-8").read()
    ok(html.count("chapter-1-lesson-2-y") == 1 and "Renamed" in html, "re-saving an existing lesson updates it in place (no duplicate)")

    # ── a page with no chapters (programming/other) is untouched: new lessons are appended with the next number ──
    q = os.path.join(tmp, "other.html")
    open(q, "w", encoding="utf-8").write(page([("functions", "01", "Functions"), ("if-conditional", "03", "If"), ("demi", "02", "Demi")]))
    ok(C.normalize_grid_index(q) is False, "a page with no chaptered lessons is not reordered")
    C.upsert_grid_lesson_card(q, "loops", "Loops", "")
    seq = parse(open(q, encoding="utf-8").read())
    ok([x[1] for x in seq] == ["functions", "if-conditional", "demi", "loops"] and seq[-1][2] == "04" and not any(x[0] == "head" for x in seq), "...it keeps its order and appends the next number, with no headings")

    # ── the real Senior 1 and Senior 2 pages ──
    for g in ("grade-1-secondary", "grade-2-secondary"):
        d = os.path.join(SITE, "programming", "baccalaureate", g); html = open(os.path.join(d, "index.html"), encoding="utf-8").read()
        seq = parse(html); cards = [x for x in seq if x[0] == "card"]
        folders = sorted(x for x in os.listdir(d) if os.path.isdir(os.path.join(d, x)))
        ok(sorted(c[1] for c in cards) == folders, g + ": every lesson folder is listed exactly once")
        ok([int(c[2]) for c in cards] == list(range(1, len(cards) + 1)), g + ": numbers run 1..%d with no gap or repeat, in page order" % len(cards))
        pos = [C.lesson_position(c[1]) for c in cards]
        keyed = [(p[0] if p[0] is not None else -1, p[1] or 0) for p in pos]
        ok(keyed == sorted(keyed), g + ": page order is by chapter, then lesson number")
        heads = [x[1] for x in seq if x[0] == "head"]
        ok(len(heads) == len(set(heads)) and all(("chapter-%d" % p[0]) in heads for p in pos if p[0] is not None), g + ": a heading for every chapter, each once")
        # each card sits under the heading of ITS chapter
        cur = None; good = True
        for x in seq:
            if x[0] == "head": cur = x[1]
            else:
                ch = C.lesson_position(x[1])[0]; good &= (cur == ("chapter-%d" % ch)) if ch is not None else (cur == "intro")
        ok(good, g + ": every lesson is under its own chapter's heading")
        ok(not re.search(r"Chaper|\bchapter 2 lesson 2\b", html), g + ": no typo'd lesson titles left in the list")
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print("\n%d grid-layout checks passed" % passed)
