#!/usr/bin/env python3
r"""
strip_embedded_answers.py — remove the old embedded question list (with correct answers) from
quiz.html pages, so "View source" no longer shows the answers once FF_DEFERRED_ANSWERS is on.

Why: quiz.js now loads questions from the server (get_quiz). Pages generated long ago still
carry the whole quiz, answers included, in <script id="quiz-data">. The server can hide answers
from get_quiz, but not from a page that already contains them.

SAFE ORDER (do not skip): for each lesson, FIRST make sure its quiz is on the server
(Quiz Maker syncs it; check get_quiz / admin_get_quiz_content returns questions), THEN strip.
A page stripped before its quiz is synced has no questions to show.

    python strip_embedded_answers.py                      # dry run: list pages that still embed answers
    python strip_embedded_answers.py --apply --only programming/other/functions programming/other/if-conditional
    python strip_embedded_answers.py C:\path\to\site ...  # site root (default: the repo this tool lives in)

Only the "questions" key is removed; title/subject/lesson stay. Idempotent. Standard library only.
Run it AFTER Session 1's key repair has been merged (both touch the same quiz.html files).
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BLOCK = re.compile(r'(<script type="application/json" id="quiz-data">)(.*?)(</script>)', re.S)


def main(argv):
    apply = "--apply" in argv
    only = []
    if "--only" in argv:
        only = [a.strip("/").lower() for a in argv[argv.index("--only") + 1:] if not a.startswith("--")]
    pos = [a for a in argv[1:] if not a.startswith("--") and a.strip("/").lower() not in only]
    root = os.path.abspath(pos[0]) if pos else os.path.abspath(os.path.join(HERE, "..", ".."))
    if apply and not only:
        print("--apply needs --only <lesson path> ... (strip lessons one by one, after their quiz is on the server).")
        return 2
    found = changed = 0
    for dirpath, _dirs, files in os.walk(os.path.join(root, "programming")):
        if "quiz.html" not in files:
            continue
        rel = os.path.relpath(dirpath, root).replace(os.sep, "/")
        path = os.path.join(dirpath, "quiz.html")
        with open(path, "r", encoding="utf-8", newline="") as f:
            html = f.read()
        m = BLOCK.search(html)
        if not m:
            continue
        try:
            data = json.loads(m.group(2))
        except ValueError:
            print("SKIP (unparseable quiz-data)  " + rel)
            continue
        if not isinstance(data.get("questions"), list):
            continue
        found += 1
        n = len(data["questions"])
        if apply and rel.lower() in only:
            del data["questions"]
            nl = "\r\n" if "\r\n" in html else "\n"
            new = json.dumps(data, indent=2, ensure_ascii=False).replace("\n", nl)
            html = html[:m.start(2)] + nl + new + nl + html[m.end(2):]
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(html)
            changed += 1
            print("STRIPPED  {}  ({} questions removed)".format(rel, n))
        else:
            print("EMBEDS    {}  ({} questions with answers in the page source)".format(rel, n))
    print("\n{} page(s) embed answers; {} stripped.".format(found, changed))
    if found and not apply:
        print("Dry run. Strip a lesson only after its quiz is synced to the server (see the header).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
