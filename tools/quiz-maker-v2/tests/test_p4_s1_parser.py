"""P4-S1: the bulk-paste parser and math. A '*' inside \\( \\) or \\[ \\] is not an answer marker, a trailing '*'
still is, '\\*' is a literal star, and every backslash survives into the generated question data.
Run from tools/quiz-maker-v2:  python3 tests/test_p4_s1_parser.py"""
import sys, os, json, types

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


class _Dummy:                      # stands in for any tkinter class so common.py imports without Tk
    def __init__(self, *a, **k): pass


def _stub(name):
    m = types.ModuleType(name)
    m.__getattr__ = lambda attr: _Dummy if attr[:1].isupper() else (lambda *a, **k: None)
    return m


try:
    import tkinter  # noqa: F401
except ImportError:
    for n in ("tkinter", "tkinter.ttk", "tkinter.messagebox", "tkinter.filedialog"):
        sys.modules[n] = _stub(n)
    sys.modules["tkinter"].ttk = sys.modules["tkinter.ttk"]
    sys.modules["tkinter"].messagebox = sys.modules["tkinter.messagebox"]
    sys.modules["tkinter"].filedialog = sys.modules["tkinter.filedialog"]
from modules import common

ok = True


def t(name, cond, extra=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))
    ok = ok and bool(cond)


def parse(block):
    return common.parse_bulk_graded_questions(block, 1)


def mcq(*opts, q="Q: pick one"):
    return parse(q + "\n" + "\n".join("%s) %s" % (chr(65 + i), o) for i, o in enumerate(opts)))[0]


# --- the marker --------------------------------------------------------------------------------------------------------
m = mcq("2", "4 *", "6")
t("trailing * still marks the correct option", m["correct"] == [1] and m["options"] == ["2", "4", "6"], m)
m = mcq(r"\(x^*\)", r"\(x^*\) *", r"\(y\)")
t(r"a * INSIDE \( \) is not a marker; a * after the math is", m["correct"] == [1] and m["options"][0] == r"\(x^*\)" and m["options"][1] == r"\(x^*\)", m)
m = mcq(r"\(a*b\)", r"\(a*b\)*", r"\[ k* \]")
t(r"no space before the marker, and a * inside \[ \], also work", m["correct"] == [1] and m["options"] == [r"\(a*b\)", r"\(a*b\)", r"\[ k* \]"], m)
m = mcq(r"\(x\) *", r"\(y\) *", r"\(z\)")
t("two starred options = select-all (two correct)", m["correct"] == [0, 1], m)
m = mcq(r"\(a *", r"\(b\)")
t(r"a * sitting inside UNCLOSED math is not a marker either (text kept, default correct = first)", m["options"][0] == r"\(a *" and m["correct"] == [0], m)
m = mcq("plain", r"a\\*", "other")
t(r"an even number of backslashes ('\\') before the star: the star IS the marker, both backslashes kept", m["correct"] == [1] and m["options"][1] == "a\\\\", m)

# --- literal star --------------------------------------------------------------------------------------------------------
m = mcq(r"Use int\*", r"Use int *", r"Use int")
t(r"'\*' at the end is a literal star (backslash removed), not a marker", m["options"] == ["Use int*", "Use int", "Use int"] and m["correct"] == [1], m)
m = mcq(r"\*", "x *")
t(r"an option that is only '\*' shows a star", m["options"][0] == "*" and m["correct"] == [1], m)

# --- backslashes survive all the way into the JSON the generator embeds ----------------------------------------------------
block = "Ch: 2\n" + "\n".join([
    r"Q: Simplify \(\frac{a}{b} + \frac{c}{d}\) when \[ \sqrt{x^2} \]",
    r"A) \(\frac{ad+bc}{bd}\) *", r"B) \(\frac{a+c}{b+d}\)", r"E: Use \(\lcm\).",
    "", "---", "",
    r"TF: \(x^2 \ge 0\) for every real x", "Correct: True", r"E: because \(\lvert x \rvert^2 = x^2\)",
    "", "---", "",
    r"MATCH: Match \(\sin\) values", r"- \(\sin 30^\circ\) -> \(\frac12\)", r"- \(\sin 90^\circ\) -> \(1\)",
    "", "---", "",
    r"WRITTEN: Prove \(\sqrt2\) is irrational.", "Marks: 4", r"Model: Assume \(\sqrt2 = \frac{p}{q}\)...",
])
items = parse(block)
dumped = json.dumps({"questions": items}, indent=2)          # exactly what quiz_tab.py embeds in the page
back = json.loads(dumped)["questions"]
t("4 questions parsed (mcq, tf, match, written)", [i["type"] for i in items] == ["mcq", "truefalse", "match", "written"], [i["type"] for i in items])
t("MCQ prompt and options keep every backslash and brace", items[0]["prompt"] == r"Simplify \(\frac{a}{b} + \frac{c}{d}\) when \[ \sqrt{x^2} \]" and items[0]["options"][0] == r"\(\frac{ad+bc}{bd}\)" and items[0]["correct"] == [0], items[0])
t("explanation, TF prompt and TF explanation keep backslashes", items[0]["explain"] == r"Use \(\lcm\)." and items[1]["prompt"] == r"\(x^2 \ge 0\) for every real x" and items[1]["explain"] == r"because \(\lvert x \rvert^2 = x^2\)", items[:2])
t("MATCH rows and options keep backslashes", items[2]["rows"][0] == {"label": r"\(\sin 30^\circ\)", "correct": r"\(\frac12\)"} and r"\(1\)" in items[2]["options"], items[2])
t("WRITTEN prompt and model answer keep backslashes", items[3]["prompt"] == r"Prove \(\sqrt2\) is irrational." and items[3]["model_answer"] == r"Assume \(\sqrt2 = \frac{p}{q}\)...", items[3])
t("the JSON the generator embeds round-trips to the identical strings", back == json.loads(json.dumps(items)) and all(r"\(" in dumped.replace("\\\\", "\\") for _ in [0]))
t("chapter tag still applies", all(i.get("chapter") == 2 for i in items))

# --- the help text the owner sees documents it -----------------------------------------------------------------------------
h = common.GRADED_BULK_HELP
t("bulk help documents math delimiters, the marker rule and the literal star", r"\(" in h and r"\[" in h and "NOT" in h and r"\*" in h and "$" in h, h[-700:])

print("\nOK" if ok else "\nFAILED")
sys.exit(0 if ok else 1)
