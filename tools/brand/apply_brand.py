#!/usr/bin/env python3
"""
apply_brand.py - one-off: swap the old "EZZ NASR · TEACHING" brand markup for
the Handasa · هندسة lockup in every page and Quiz Maker template.

    python tools/brand/apply_brand.py --dry   # count what would change, write nothing
    python tools/brand/apply_brand.py         # apply

Only touches the brand bits (header mark, footer credit, private-page <title>
suffix). Head tags (title/meta/icons/manifest) are seo_build.py's job.
Idempotent: a second run changes nothing.
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SKIP = {".git", "node_modules", "tests", "__pycache__", "packaged", "Docs", "docs"}

MARK = ('<img class="brand-logo" src="/assets/brand/handasa-mark.svg" alt="" width="28" height="28">'
        '<span class="brand-name">Handasa<span class="brand-ar" lang="ar">هندسة</span></span>')
CREDIT = "Handasa · هندسة · by Eng. EzzNasr"
CREDIT_ENT = "Handasa &middot; هندسة &middot; by Eng. EzzNasr"
FOOT = '<span class="brand-foot">' + CREDIT + ' ·</span> '

RULES = [
    # header marks
    ("mark", re.compile(r'<span class="dot"[^>]*></span>\s*EZZ NASR\s*<span\s+aria-hidden="true">(?:&middot;|·)</span>\s*TEACHING'), MARK),
    ("mark", re.compile(r'<span class="dot"[^>]*></span>\s*EZZ NASR\s*[·:]\s*TEACHING'), MARK),
    ("mark", re.compile(r'<i></i>\s*EZZ NASR · TEACHING'), MARK),
    ("mark", re.compile(r'<span class="d-brand-mark" aria-hidden="true"><svg.*?</svg></span>\s*Teaching Portal', re.S), MARK),
    ("mark", re.compile(r'aria-label="Teaching Portal home"'), 'aria-label="Handasa home"'),
    # private-page titles
    ("title", re.compile(r' — (?:Teaching Portal|Ezz Nasr : Teaching)</title>'), ' — Handasa</title>'),
    # footers
    ("footer", re.compile(r'© 2026 Ezz Nasr · Teaching Portal'), '© 2026 ' + CREDIT),
    ("footer", re.compile(r'EZZ NASR · Teaching Portal'), CREDIT),
    ("footer", re.compile(r'&copy; 2026 Ezz Nasr &middot; '), '&copy; 2026 ' + CREDIT_ENT + ' &middot; '),
    ("footer", re.compile(r'(<(?:p|div) class="footer-note">)(?!<span class="brand-foot">)(teaching\.ezznasr\.dev/)'), r'\1' + FOOT + r'\2'),
    # bare credits (grade pages, 404, home/subject footers) get the same isolating span
    ("footer", re.compile(r'(?<!<span class="brand-foot">)(?<!© 2026 )(?<!&copy; 2026 )Handasa · هندسة · by Eng. EzzNasr'),
     '<span class="brand-foot">' + CREDIT + '</span>'),
    ("footer", re.compile(r'(?<!<span class="brand-foot">)(© 2026 |&copy; 2026 )(Handasa (?:·|&middot;) هندسة (?:·|&middot;) by Eng. EzzNasr)'),
     r'<span class="brand-foot">\1\2</span>'),
    # compact staff tools (follow-up, requirements, team, ...): just the logo, linking home
    ("mark", re.compile(r'(<div class="(?:fu|rq)-top-row">\s*)(<h1 class="(?:fu|rq)-title">)'),
     r'\1<a class="brand-home" href="/" aria-label="Handasa"><img class="brand-logo" src="/assets/brand/handasa-mark.svg" alt="" width="28" height="28"></a>\2'),
]


def targets():
    """Every site page (tools/ skipped) plus the Quiz Maker's page templates."""
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in SKIP and d != "tools" and not d.startswith(".")]
        for f in fn:
            if f.endswith(".html"):
                yield os.path.join(dp, f)
    tpl = os.path.join(ROOT, "tools", "quiz-maker-v2", "templates")
    for f in sorted(os.listdir(tpl)):
        if f.endswith(".html"):
            yield os.path.join(tpl, f)


def main(dry):
    files = changed = 0
    counts = {}
    for path in targets():
        files += 1
        with open(path, "r", encoding="utf-8", newline="") as fh:
            text = fh.read()
        new = text
        for kind, rx, repl in RULES:
            new, n = rx.subn(repl, new)
            if n:
                counts[kind] = counts.get(kind, 0) + n
        if new != text:
            changed += 1
            if not dry:
                with open(path, "w", encoding="utf-8", newline="") as fh:
                    fh.write(new)
    print("{} pages scanned, {} {}".format(files, changed, "would change" if dry else "changed"))
    for k in sorted(counts):
        print("  {:<7} {}".format(k, counts[k]))


if __name__ == "__main__":
    main("--dry" in sys.argv[1:])
