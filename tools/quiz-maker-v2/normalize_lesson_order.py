"""Lay out every grid-style lesson index (programming/baccalaureate/grade-*-secondary, ...) by chapter: sections, order, numbers.
The Quiz Maker does this automatically whenever a lesson is added or removed; run this once to fix pages made before that.

    python tools/quiz-maker-v2/normalize_lesson_order.py            # fix every index under the site root
    python tools/quiz-maker-v2/normalize_lesson_order.py --check    # change nothing; exit 1 if any index needs fixing
"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); SITE = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
import types
try:
    import tkinter  # noqa: F401  (a machine without Tk can still run this: the layout code needs no window)
except ImportError:
    class _D:
        def __init__(self, *a, **k): pass
    def _stub(n):
        m = types.ModuleType(n); m.__getattr__ = lambda a: _D if a[:1].isupper() else (lambda *x, **k: None); return m
    for n in ("tkinter", "tkinter.ttk", "tkinter.messagebox", "tkinter.filedialog"): sys.modules[n] = _stub(n)
    sys.modules["tkinter"].ttk = sys.modules["tkinter.ttk"]; sys.modules["tkinter"].messagebox = sys.modules["tkinter.messagebox"]
from modules import common as C   # noqa: E402

SKIP = {"assets", "tools", "docs", "_deleted-lessons", "node_modules", "dashboard", "attend", "scripts", "tests", ".git", "__pycache__"}


def indexes(root):
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP and not x.startswith(".")]
        if "index.html" in files:
            p = os.path.join(d, "index.html")
            with open(p, encoding="utf-8") as f:
                if C.is_grid_style_index(f.read()):
                    yield p


def main(argv):
    check = "--check" in argv; changed = []
    for p in indexes(SITE):
        if check:
            before = open(p, encoding="utf-8").read(); tmp = p + ".chk"
            open(tmp, "w", encoding="utf-8").write(before)
            try:
                if C.normalize_grid_index(tmp): changed.append(p)
            finally:
                os.remove(tmp)
        elif C.normalize_grid_index(p):
            changed.append(p)
    for p in changed: print(("needs fixing: " if check else "fixed: ") + os.path.relpath(p, SITE))
    print("%d index page(s) %s" % (len(changed), "need fixing" if check else "fixed"))
    return 1 if (check and changed) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
