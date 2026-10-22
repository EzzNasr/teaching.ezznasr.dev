#!/usr/bin/env python3
"""R-001: every lesson folder must refer to itself by its own folder path.

Checks index.html / quiz.html / assignment.html in each lesson folder for:
  * canonical + og:url + JSON-LD urls (anything under https://teaching.ezznasr.dev/<lesson path>)
  * root-relative links  href="/<lesson path>/..."
  * data-lesson="..."  and quiz  "lesson": "..."  (bare folder name)
A reference to a sibling lesson is fine; a reference to a folder that does not exist is not.

Usage: python check_lesson_paths.py [site_root]     (default: ../..)
Exit code 1 if anything is wrong.
"""
import re
import sys
from pathlib import Path

SITE = "https://teaching.ezznasr.dev"
PAGES = ("index.html", "quiz.html", "assignment.html")
LESSON_RE = re.compile(r"^(chapter-\d+-lesson-\d+|introductory-session)")


def lesson_dirs(root: Path):
    for p in sorted(root.glob("programming/*/grade-*-secondary/*/")):
        if p.is_dir() and LESSON_RE.match(p.name) and (p / "index.html").exists():
            yield p


def main(root: Path) -> int:
    bad = []
    for d in lesson_dirs(root):
        rel = d.relative_to(root).as_posix()
        grade_dir = d.parent.relative_to(root).as_posix()
        for page in PAGES:
            f = d / page
            if not f.exists():
                continue
            text = f.read_text(encoding="utf-8", errors="replace")
            # every absolute URL / root-relative link into this grade must point at a real folder
            for m in re.finditer(
                r'(?:%s)?/(%s/[^/"\'\s<>?#]+)/' % (re.escape(SITE), re.escape(grade_dir)), text
            ):
                target = m.group(1)
                if not (root / target).is_dir():
                    bad.append(f"{rel}/{page}: link to missing folder {target}")
            for m in re.finditer(r'(?:%s)?/(%s/[^"\'\s<>?#]+\.html)' % (re.escape(SITE), re.escape(grade_dir)), text):
                if not (root / m.group(1)).exists():
                    bad.append(f"{rel}/{page}: link to missing file {m.group(1)}")
            # self-references must match own folder
            for pat in (r'data-lesson="([^"]+)"', r'"lesson":\s*"([^"]+)"'):
                for m in re.finditer(pat, text):
                    if m.group(1) != d.name:
                        bad.append(f"{rel}/{page}: lesson key '{m.group(1)}' != folder '{d.name}'")
            for m in re.finditer(r'(?:canonical"[^>]*href|og:url"[^>]*content)="([^"]+)"', text):
                if f"/{rel}/" not in m.group(1):
                    bad.append(f"{rel}/{page}: canonical/og:url '{m.group(1)}'")
    for b in bad:
        print("FAIL", b)
    print("OK: all lesson folders self-consistent" if not bad else f"{len(bad)} problem(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    r = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]
    sys.exit(main(r))
