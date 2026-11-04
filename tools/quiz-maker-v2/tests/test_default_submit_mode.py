"""A brand-new assignment defaults to graded questions, not "Paste text" (Nov 3 request).

Covers both places a new assignment.html gets its mode: the Assignment Maker tab (empty form) and the
quiz tab when it creates a lesson. An existing page keeps the mode it already has (data-mode is read back).
    python tests/test_default_submit_mode.py        (run from tools/quiz-maker-v2/)
"""
import os
import re
import sys

QM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, QM)
from modules import common  # noqa: E402

passed = failed = 0


def check(name, ok, info=""):
    global passed, failed
    if ok:
        passed += 1
        print("PASS " + name)
    else:
        failed += 1
        print("FAIL " + name + ("  -> " + str(info) if info else ""))


def src(name):
    with open(os.path.join(QM, "modules", name), encoding="utf-8") as f:
        return f.read()


check("DEFAULT_SUBMIT_MODE is graded", common.DEFAULT_SUBMIT_MODE == "graded", common.DEFAULT_SUBMIT_MODE)
check("the default is one of the offered modes", common.DEFAULT_SUBMIT_MODE in [s for s, _ in common.SUBMIT_MODES])
check("its label is the graded one", common.submit_mode_label("graded") == "Graded questions (auto-marked)")
check("an unknown slug falls back to the first label", common.submit_mode_label("nope") == common.SUBMIT_MODES[0][1])

A, Q = src("assignment_tab.py"), src("quiz_tab.py")
check("Assignment Maker never hard-codes the first mode (Paste text) as its default", "SUBMIT_MODES[0][1]" not in A)
check("Assignment Maker starts and resets to the default", A.count("submit_mode_label(common.DEFAULT_SUBMIT_MODE)") == 2)
check("quiz tab: a new lesson's assignment starts in the default mode",
      re.search(r'^\s*submit_mode = common\.DEFAULT_SUBMIT_MODE\s*$', Q, re.M) is not None)
check("quiz tab: an existing assignment keeps its data-mode", 'submit_mode = mode_match.group(1)' in Q)
check("quiz tab: the lesson card describes a graded assignment", '"graded": "Answer the questions"' in Q)

print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
