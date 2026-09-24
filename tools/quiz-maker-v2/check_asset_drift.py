#!/usr/bin/env python3
"""
check_asset_drift.py — is the live site's assets/ still what assets_templates/ says?

"Sync site assets" overwrites <site_root>/assets/ from assets_templates/. If a
shared script (auth.js, quiz.js, assign.js, attachments.js) or stylesheet was
edited directly in assets/, the next sync would silently undo that edit. This
script compares the two WITHOUT changing anything and says so.

    python check_asset_drift.py               # site root = the repo this tool lives in
    python check_asset_drift.py C:\\path\\to\\site

Exit code 0 = in sync, 1 = drift found, 2 = something is missing.
Line endings (CRLF vs LF) are ignored. The Drive endpoint URL is taken from the
live assets/assign.js, so only the placeholder line is allowed to differ.
Standard library only (does not need tkinter).
"""

import difflib
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATES = os.path.join(HERE, "assets_templates")
SCRIPTS = ("auth.js", "quiz.js", "assign.js", "attachments.js", "video.js")
STYLES = ("base.css", "forms.css")
ENDPOINT_RE = re.compile(r'DRIVE_ENDPOINT\s*=\s*"([^"]*)"')
MAX_DIFF_LINES = 40


def read(path):
    with open(path, "r", encoding="utf-8") as f:      # universal newlines
        return f.read()


def live_endpoint(assets_dir):
    """The Web App URL currently baked into the live site (from assign.js, the
    one script whose template carries the {{DRIVE_ENDPOINT}} placeholder)."""
    path = os.path.join(assets_dir, "assign.js")
    if os.path.exists(path):
        m = ENDPOINT_RE.search(read(path))
        if m and m.group(1) and "{{" not in m.group(1):
            return m.group(1)
    return ""


def main(argv):
    site_root = os.path.abspath(argv[1]) if len(argv) > 1 else os.path.abspath(os.path.join(HERE, "..", ".."))
    assets_dir = os.path.join(site_root, "assets")
    if not os.path.isdir(assets_dir):
        print("No assets/ folder in {}".format(site_root))
        return 2
    endpoint = live_endpoint(assets_dir)
    drift = missing = 0
    for name in SCRIPTS + STYLES:
        tpl_path = os.path.join(TEMPLATES, name)
        live_path = os.path.join(assets_dir, name)
        if not os.path.exists(tpl_path) or not os.path.exists(live_path):
            print("MISSING  {} ({})".format(name, "template" if not os.path.exists(tpl_path) else "live copy"))
            missing += 1
            continue
        expected = read(tpl_path).replace("{{DRIVE_ENDPOINT}}", endpoint)
        actual = read(live_path)
        if expected == actual:
            print("ok       {}".format(name))
            continue
        drift += 1
        print("DRIFT    {}  (live differs from what Sync would write)".format(name))
        diff = list(difflib.unified_diff(actual.splitlines(), expected.splitlines(),
                                         "assets/" + name + "  (live now)",
                                         "assets_templates/" + name + "  (after Sync)", lineterm="", n=1))
        for line in diff[:MAX_DIFF_LINES]:
            print("    " + line)
        if len(diff) > MAX_DIFF_LINES:
            print("    ... {} more diff lines".format(len(diff) - MAX_DIFF_LINES))
    if missing:
        return 2
    if drift:
        print("\n{} file(s) differ. Copy any edit you want to keep into assets_templates/ BEFORE syncing.".format(drift))
        return 1
    print("\nIn sync.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))