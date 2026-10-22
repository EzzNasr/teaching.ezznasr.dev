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
# ---- bulk paste: WRITTEN blocks (quiz tab and assignment tab share this parser) ----
BULK = """Ch: 2
Q: What is 1+1?
A) 1
B) 2 *
C) 3
E: because

WRITTEN: Explain list vs tuple.
second line of the question
Marks: 8
Model: A list is mutable.
A tuple is not.
E: see notes

W: Short one
Max: 2.5
Model: x
---
TF: Python is compiled
Correct: False

WRITTEN: no model here
"""
items = common.parse_bulk_graded_questions(BULK, 1)
wr = [i for i in items if i["type"] == "written"]
t("bulk: 1 mcq + 1 tf + 3 written parsed", len(items) == 5 and len(wr) == 3)
t("bulk: written prompt continues over lines", wr[0]["prompt"] == "Explain list vs tuple.\nsecond line of the question")
t("bulk: Marks / Max parsed (8, 2.5; default 1)", [w["max_marks"] for w in wr] == [8, 2.5, 1])
t("bulk: multi-line Model and E parsed", wr[0]["model_answer"] == "A list is mutable.\nA tuple is not." and wr[0]["explain"] == "see notes")
t("bulk: W: alias works", wr[1]["prompt"] == "Short one" and wr[1]["model_answer"] == "x")
t("bulk: a written question without Model is kept (empty model)", wr[2]["model_answer"] == "")
t("bulk: every written item has a unique qid", len({w["qid"] for w in wr}) == 3 and all(w["qid"].startswith("w") for w in wr))
t("bulk: chapter from Ch: line applies to written", all(w.get("chapter") == 2 for w in wr))
t("bulk: the mcq before it is unharmed", items[0]["type"] == "mcq" and items[0]["correct"] == [1])
pub, models = common.split_written_models(items)
t("bulk: split sends 3 models to the server and no model in the page JSON", len(models) == 3 and "A list is mutable" not in json.dumps(pub))
bad = common.parse_bulk_graded_questions("WRITTEN: x\nMarks: 0\nModel: m", None)
t("bulk: Marks 0 falls back to 1", bad and bad[0]["max_marks"] == 1)

sys.exit(0 if ok else 1)
