"""S4: written-question helpers in Quiz Maker (pure functions, no Tk window).
Run from tools/quiz-maker-v2:  python3 tests/test_written_authoring.py"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import types

class _Dummy:                      # stands in for any tkinter class so common.py imports without Tk
    def __init__(self, *a, **k): pass

def _stub(name):
    m = types.ModuleType(name)
    m.__getattr__ = lambda attr: _Dummy if attr[:1].isupper() else (lambda *a, **k: None)
    return m

try:
    import tkinter  # noqa: F401  (real Tk present: use it)
except ImportError:
    sys.modules["tkinter"] = _stub("tkinter")
    sys.modules["tkinter.ttk"] = _stub("tkinter.ttk")
    sys.modules["tkinter.messagebox"] = _stub("tkinter.messagebox")
    sys.modules["tkinter.filedialog"] = _stub("tkinter.filedialog")
    sys.modules["tkinter"].ttk = sys.modules["tkinter.ttk"]
    sys.modules["tkinter"].messagebox = sys.modules["tkinter.messagebox"]
    sys.modules["tkinter"].filedialog = sys.modules["tkinter.filedialog"]
from modules import common

ok = True
def t(name, cond):
    global ok
    print(("PASS " if cond else "FAIL ") + name); ok = ok and cond

qs = [{"type": "mcq", "prompt": "a", "options": ["x", "y"], "correct": [0]},
      {"type": "written", "qid": "w1abc", "prompt": "Explain", "max_marks": 3, "model_answer": "SECRET", "explain": "e"}]
pub, models = common.split_written_models(qs)
t("model_answer removed from public JSON", "SECRET" not in json.dumps(pub))
t("public written keeps qid, prompt, max_marks", pub[1]["qid"] == "w1abc" and pub[1]["max_marks"] == 3 and pub[1]["prompt"] == "Explain")
t("source questions not mutated", qs[1]["model_answer"] == "SECRET")
t("mcq untouched", pub[0] == qs[0])
t("models list for the server", models == [{"question_id": "w1abc", "max_marks": 3, "model_answer": "SECRET", "prompt": "Explain"}])
loaded = common.merge_written_models(json.loads(json.dumps(pub)), models)
t("merge restores model answer after reload", loaded[1]["model_answer"] == "SECRET")
t("merge ignores unknown ids and non-written", common.merge_written_models([{"type": "written", "qid": "zz"}, qs[0]], models)[0].get("model_answer") is None)
t("qids are unique and well-formed", len({common.new_written_qid() for _ in range(200)}) == 200 and common.new_written_qid().startswith("w"))
sys.exit(0 if ok else 1)
