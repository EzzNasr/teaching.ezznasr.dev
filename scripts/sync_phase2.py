#!/usr/bin/env python3
"""Keep the Phase 2 sections of apps_script/Code.gs identical to the standalone Phase2_*.gs files.

Code.gs (the file you deploy) contains the Phase2_*.gs files merged in, each under a marker line:
    // ===== MERGED FROM Phase2_Core.gs =====
The Phase2_*.gs files are the SOURCE of those sections. Edit a Phase2_*.gs file, then run:

    python scripts/sync_phase2.py            # rewrite the merged sections in Code.gs from the files
    python scripts/sync_phase2.py --check    # change nothing; exit 1 if they differ (tests/test_phase2_core.js does this too)

If a Phase2_*.gs file has been deleted, its section in Code.gs is simply left alone (Code.gs is then its only source).
Everything above the first marker is plain Code.gs and is edited directly. Standard library only.
"""
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
GS = os.path.join(HERE, "..", "tools", "quiz-maker-v2", "apps_script")
MARK = re.compile(r"^// ===== MERGED FROM (Phase2_\w+\.gs) =====[ \t]*\r?$", re.M)


def read(p):
    with open(p, "r", encoding="utf-8", newline="") as f:
        return f.read()


def squash(t):   # compare ignoring EOL style, blank lines and trailing spaces
    return "\n".join(l.rstrip() for l in t.replace("\r\n", "\n").split("\n") if l.strip())


def main(check):
    code_path = os.path.join(GS, "Code.gs")
    code = read(code_path)
    eol = "\r\n" if "\r\n" in code else "\n"
    marks = list(MARK.finditer(code))
    if not marks:
        print("no '// ===== MERGED FROM' markers in Code.gs: nothing to sync"); return 0
    out, last, drift = [code[:marks[0].start()]], None, []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(code)
        name = m.group(1)
        part_path = os.path.join(GS, name)
        if not os.path.isfile(part_path):      # standalone file deleted: Code.gs is the only source for that section
            out.append(code[m.start():end]); continue
        part = read(part_path).replace("\r\n", "\n").strip("\n")
        if squash(code[m.end():end]) != squash(part):
            drift.append(name)
        out.append(m.group(0).rstrip("\r\n") + eol + part.replace("\n", eol) + eol + eol)
    if check:
        print("in sync" if not drift else "DRIFT in Code.gs vs: " + ", ".join(drift) + "   (run: python scripts/sync_phase2.py)")
        return 1 if drift else 0
    new = "".join(out)
    if new != code:
        with open(code_path, "w", encoding="utf-8", newline="") as f:
            f.write(new)
    print("updated: " + ", ".join(drift) if drift else "already in sync (layout normalised)" if new != code else "already in sync")
    return 0


if __name__ == "__main__":
    sys.exit(main("--check" in sys.argv))
