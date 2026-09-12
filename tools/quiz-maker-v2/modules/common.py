#!/usr/bin/env python3
"""
common.py — shared helpers for the Quiz Maker / Assignment Maker /
Attachment Maker tabs: site-root resolution, config load/save, slugify,
and template loading. Split out of the original quiz_maker.py so all
three tabs stay in sync on one site_root + one Drive bridge config.

Also home to a couple of small UI helpers (ScrollableFrame, fit_geometry)
used by every window in the app so windows/dialogs behave consistently
on small or scaled-up screens.
"""

import functools
import http.server
import json
import os
import re
import shutil
import socket
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk, messagebox

# --------------------------------------------------------------------------
# Path resolution — has to work both as a raw script AND as a frozen
# PyInstaller --onefile exe, where __file__ / cwd point somewhere temporary.
# --------------------------------------------------------------------------


def _is_frozen():
    return getattr(sys, "frozen", False)


if _is_frozen():
    EXE_DIR = os.path.dirname(os.path.abspath(sys.executable))
    TEMPLATES_BASE = getattr(sys, "_MEIPASS", EXE_DIR)
else:
    # this file lives in <app_root>/modules/common.py — app root is one up
    EXE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    TEMPLATES_BASE = EXE_DIR

TEMPLATES_DIR = os.path.join(TEMPLATES_BASE, "templates")
ASSETS_TEMPLATES_DIR = os.path.join(TEMPLATES_BASE, "assets_templates")
CONFIG_PATH = os.path.join(EXE_DIR, "quiz_maker_config.json")

# Known-good absolute fallback for the site root, used only if the relative
# search below can't find it (e.g. the app got moved somewhere unrelated).
ABS_FALLBACK_SITE_ROOT = r"D:\projects\teaching-site-new\teaching.ezznasr.dev"

SUBJECTS = [("programming", "Programming"), ("english", "English"), ("math", "Math")]

SUBMIT_MODES = [
    ("text", "Paste text"),
    ("url", "Link (URL)"),
    ("file", "File upload"),
    ("both", "Link or file upload"),
    ("graded", "Graded questions (auto-marked)"),
]


def fit_geometry(win, want_w, want_h, min_w=480, min_h=360, margin=80):
    """Size + center a Tk window (or Toplevel) so it always fits on the
    current screen, and set a sane minsize so the window can never be
    shrunk small enough to push controls out of view.

    want_w/want_h are the "ideal" size; if the screen is smaller than
    that (small laptop, scaled-up display), the window shrinks to fit
    instead of running off-screen — down to min_w/min_h, at which point
    ScrollableFrame content (see below) takes over via scrolling.
    """
    win.update_idletasks()
    screen_w = win.winfo_screenwidth()
    screen_h = win.winfo_screenheight()
    w = min(want_w, max(min_w, screen_w - margin))
    h = min(want_h, max(min_h, screen_h - margin))
    x = max(0, (screen_w - w) // 2)
    y = max(0, (screen_h - h) // 2)
    win.geometry("{}x{}+{}+{}".format(w, h, x, y))
    win.minsize(min(min_w, w), min(min_h, h))


def lock_min_width_to_content(win, extra=24):
    """Call once, after all of a window's widgets are built, to raise its
    minimum width to whatever its content actually needs. fit_geometry()
    has to guess a min_w/min_h before any widgets exist, so a button row
    added later (e.g. three buttons in a row) can easily need more width
    than that guess — and since ScrollableFrame only scrolls vertically,
    resizing narrower than that leaves those buttons clipped off the
    right edge with no way to reach them. This closes that gap by
    deriving the real floor from win.winfo_reqwidth() instead of a guess.

    Only ever raises the floor, never lowers it — takes the max of the
    content-derived width and whatever min_w was already set, so a small
    dialog's content-derived width can't accidentally shrink a minimum
    that was deliberately set larger for other reasons."""
    win.update_idletasks()
    needed_w = win.winfo_reqwidth() + extra
    try:
        existing_min_w, existing_min_h = win.wm_minsize()
    except Exception:
        existing_min_w, existing_min_h = 0, win.winfo_height()
    new_min_w = max(existing_min_w, needed_w)
    cur_w, cur_h = win.winfo_width(), win.winfo_height()
    if new_min_w > cur_w:
        win.geometry("{}x{}".format(new_min_w, cur_h))
    win.minsize(new_min_w, existing_min_h)


def enable_select_all_shortcut(win):
    """Ctrl+A in a plain Tk Entry/Text defaults to Emacs-style 'move to
    start of line', not 'select all' — surprising for anyone used to the
    Windows/Mac convention. Bound once on the toplevel; only fires when
    focus is actually in an Entry/Text/Combobox, so it never interferes
    with other Ctrl+A uses (there aren't any elsewhere in this app)."""
    def _select_all(event):
        widget = event.widget
        if isinstance(widget, (tk.Entry, ttk.Entry, ttk.Combobox)):
            widget.selection_range(0, "end")
            widget.icursor("end")
            return "break"
        if isinstance(widget, tk.Text):
            widget.tag_add("sel", "1.0", "end-1c")
            widget.mark_set("insert", "end-1c")
            return "break"
        return None
    win.bind_class("Entry", "<Control-a>", _select_all)
    win.bind_class("TEntry", "<Control-a>", _select_all)
    win.bind_class("TCombobox", "<Control-a>", _select_all)
    win.bind_class("Text", "<Control-a>", _select_all)


class ScrollableFrame(tk.Frame):
    """A vertically-scrolling container. Put your content inside
    `.inner` (a plain tk.Frame) instead of packing directly into this
    frame. A scrollbar only appears once content is actually taller
    than the visible area, and the mouse wheel scrolls while the
    pointer is over it — so on a roomy window this is invisible, and on
    a small/cramped screen nothing ever gets clipped off-window.
    """

    def __init__(self, parent, *args, **kwargs):
        super().__init__(parent, *args, **kwargs)
        self.canvas = tk.Canvas(self, highlightthickness=0)
        self.vscroll = tk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=self.vscroll.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        self._scrollbar_visible = False

        self.inner = tk.Frame(self.canvas)
        self._window = self.canvas.create_window((0, 0), window=self.inner, anchor="nw")

        self.inner.bind("<Configure>", self._on_inner_configure)
        self.canvas.bind("<Configure>", self._on_canvas_configure)

        # Mousewheel scrolling: bound at the application level (not just on
        # the bare canvas) and filtered by whether the pointer is actually
        # over this widget's subtree, so the wheel works no matter which
        # button/field/label the cursor happens to be over — binding only
        # to the canvas itself misses almost the whole window, since it's
        # covered edge-to-edge by child widgets.
        self.bind_all("<MouseWheel>", self._on_mousewheel, add="+")   # Windows / macOS
        self.bind_all("<Button-4>", self._on_mousewheel, add="+")     # Linux scroll up
        self.bind_all("<Button-5>", self._on_mousewheel, add="+")     # Linux scroll down

    def _on_mousewheel(self, event):
        try:
            widget_under = self.winfo_containing(event.x_root, event.y_root)
        except KeyError:
            # A ttk.Combobox's open dropdown list is an internal widget
            # named "popdown" that isn't registered in the normal widget
            # tree winfo_containing walks — hovering the wheel over an
            # open dropdown throws here instead of just returning None.
            # Nothing to scroll in that case either way.
            return
        w = widget_under
        while w is not None and w is not self:
            w = w.master
        if w is not self:
            return  # pointer is over a different window (e.g. a dialog) — ignore
        if getattr(event, "num", None) == 4:
            delta = -1
        elif getattr(event, "num", None) == 5:
            delta = 1
        else:
            delta = -1 if event.delta > 0 else 1
        self.canvas.yview_scroll(delta, "units")

    def _on_inner_configure(self, _event=None):
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))
        self._update_scrollbar_visibility()

    def _on_canvas_configure(self, event):
        self.canvas.itemconfig(self._window, width=event.width)
        self._update_scrollbar_visibility()

    def _update_scrollbar_visibility(self):
        bbox = self.canvas.bbox("all")
        if not bbox:
            return
        needed = (bbox[3] - bbox[1]) > self.canvas.winfo_height()
        if needed and not self._scrollbar_visible:
            self.vscroll.pack(side="right", fill="y")
            self._scrollbar_visible = True
        elif not needed and self._scrollbar_visible:
            self.vscroll.pack_forget()
            self._scrollbar_visible = False


def _lesson_card_pattern(lesson_slug, subject_slug=None):
    """Match a lesson card by its href, accepting both the current relative
    form (href="./lesson-slug/") and the legacy absolute form
    (href="/subject-slug/lesson-slug/") so old, not-yet-regenerated subject
    index pages still work with delete/recover/update."""
    rel = r'href="\./{}/"'.format(re.escape(lesson_slug))
    if subject_slug:
        legacy = r'href="/{}/{}/"'.format(re.escape(subject_slug), re.escape(lesson_slug))
        href = "(?:{}|{})".format(rel, legacy)
    else:
        href = rel
    return r'\s*(<a class="lesson-card frame" {}>.*?</a>)\s*'.format(href)


def _extract_lesson_card(content, lesson_slug, subject_slug=None):
    """Pull a lesson's <a class="lesson-card"...> block out of a group/
    subject index.html content between the LESSON_CARDS markers, returning
    (content_with_card_removed, exact_card_markup_or_None). Keeping the
    exact markup (not reconstructing it later) is what lets recovery
    restore the card byte-for-byte instead of guessing at its fields."""
    start_marker = "<!-- LESSON_CARDS_START -->"
    end_marker = "<!-- LESSON_CARDS_END -->"
    if start_marker not in content or end_marker not in content:
        return content, None
    before = content.split(start_marker)[0]
    after = content.split(end_marker)[1]
    middle = content.split(start_marker)[1].split(end_marker)[0]
    pattern = _lesson_card_pattern(lesson_slug, subject_slug)
    m = re.search(pattern, middle, re.DOTALL)
    card_markup = m.group(1) if m else None
    new_middle = re.sub(pattern, "\n", middle, flags=re.DOTALL)
    new_content = before + start_marker + "\n" + new_middle.strip("\n") + "\n" + end_marker + after
    return new_content, card_markup


def delete_lesson(site_root, subject_slug, group_relpath, lesson_slug):
    """Remove a lesson's card from its group/subject index and move its
    folder OUT of the site — into a `_deleted-lessons/` folder that sits
    next to (not inside) site_root, so it never gets published, but
    nothing is permanently erased on disk. The exact card markup is
    stashed inside the moved folder (`_card.html`) so recover_lesson() can
    restore it byte-for-byte. Returns the path it was moved to.

    Note: this only touches local files. Anything already uploaded via
    the Attachment Maker's Drive bridge stays in Drive untouched — delete
    those there separately if you want them gone too.
    """
    lesson_dir = os.path.join(group_dir(site_root, subject_slug, group_relpath), lesson_slug)
    if not os.path.isdir(lesson_dir):
        raise FileNotFoundError(lesson_dir)

    index_path = group_index_path(site_root, subject_slug, group_relpath)
    card_markup = None
    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            content = f.read()
        if is_grid_style_index(content):
            card_markup = remove_grid_lesson_card(index_path, lesson_slug)
        else:
            new_content, card_markup = _extract_lesson_card(content, lesson_slug, subject_slug)
            with open(index_path, "w", encoding="utf-8") as f:
                f.write(new_content)

    trash_root = os.path.join(os.path.dirname(os.path.abspath(site_root)), "_deleted-lessons")
    os.makedirs(trash_root, exist_ok=True)
    group_enc = group_relpath.replace("/", "~") if group_relpath else "_"
    dest_name = "{}__{}__{}__{}".format(subject_slug, group_enc, lesson_slug, time.strftime("%Y%m%d-%H%M%S"))
    dest = os.path.join(trash_root, dest_name)
    shutil.move(lesson_dir, dest)

    if card_markup:
        with open(os.path.join(dest, "_card.html"), "w", encoding="utf-8") as f:
            f.write(card_markup)

    return dest


def _trash_root(site_root):
    return os.path.join(os.path.dirname(os.path.abspath(site_root)), "_deleted-lessons")


def list_deleted_lessons(site_root):
    """List entries in _deleted-lessons/, newest first. Each entry:
    {"name": <trash-folder-name>, "dir": <full path>, "subject": ...,
    "lesson": ..., "deleted_at": "YYYY-MM-DD HH:MM:SS" or ""}."""
    trash_root = _trash_root(site_root)
    if not os.path.isdir(trash_root):
        return []
    out = []
    for name in sorted(os.listdir(trash_root), reverse=True):
        full = os.path.join(trash_root, name)
        if not os.path.isdir(full):
            continue
        parts = name.split("__")
        group_relpath = ""
        if len(parts) == 4:
            subject_slug, group_enc, lesson_slug, stamp = parts
            group_relpath = "" if group_enc == "_" else group_enc.replace("~", "/")
        elif len(parts) == 3:
            # legacy trash entries created before group support existed
            subject_slug, lesson_slug, stamp = parts
        else:
            subject_slug, lesson_slug, stamp = "?", name, ""
        if stamp:
            try:
                deleted_at = time.strftime("%Y-%m-%d %H:%M:%S", time.strptime(stamp, "%Y%m%d-%H%M%S"))
            except ValueError:
                deleted_at = stamp
        else:
            deleted_at = ""
        out.append({"name": name, "dir": full, "subject": subject_slug, "group": group_relpath,
                     "lesson": lesson_slug, "deleted_at": deleted_at})
    return out


def recover_lesson(site_root, trash_dir_name):
    """Move a trashed lesson folder back into the site and, if a stashed
    `_card.html` sidecar exists, re-insert its exact original card into
    the subject index. Returns (subject_slug, lesson_slug).
    Raises FileExistsError if a lesson already occupies that slot."""
    trash_root = _trash_root(site_root)
    src = os.path.join(trash_root, trash_dir_name)
    if not os.path.isdir(src):
        raise FileNotFoundError(src)
    parts = trash_dir_name.split("__")
    if len(parts) == 4:
        subject_slug, group_enc, lesson_slug, _stamp = parts
        group_relpath = "" if group_enc == "_" else group_enc.replace("~", "/")
    elif len(parts) == 3:
        # legacy trash entries created before group support existed
        subject_slug, lesson_slug, _stamp = parts
        group_relpath = ""
    else:
        raise ValueError("Unrecognized trash folder name: " + trash_dir_name)

    dest_dir = os.path.join(group_dir(site_root, subject_slug, group_relpath), lesson_slug)
    if os.path.exists(dest_dir):
        raise FileExistsError(dest_dir)

    card_sidecar = os.path.join(src, "_card.html")
    card_markup = None
    if os.path.exists(card_sidecar):
        with open(card_sidecar, "r", encoding="utf-8") as f:
            card_markup = f.read()

    os.makedirs(group_dir(site_root, subject_slug, group_relpath), exist_ok=True)
    shutil.move(src, dest_dir)

    moved_sidecar = os.path.join(dest_dir, "_card.html")
    if os.path.exists(moved_sidecar):
        os.remove(moved_sidecar)  # don't leave our bookkeeping file inside the live lesson folder

    if card_markup:
        index_path = group_index_path(site_root, subject_slug, group_relpath)
        if os.path.exists(index_path):
            with open(index_path, "r", encoding="utf-8") as f:
                content = f.read()
            if is_grid_style_index(content):
                m = _GRID_CONTAINER_RE.search(content)
                if m:
                    open_tag, cards_block, close_tag = m.group(1), m.group(2), m.group(3)
                    rebuilt = cards_block.rstrip("\n ") + "\n" + card_markup + "\n"
                    new_content = content[:m.start()] + open_tag + "\n" + rebuilt + close_tag + content[m.end():]
                    with open(index_path, "w", encoding="utf-8") as f:
                        f.write(new_content)
            else:
                start_marker = "<!-- LESSON_CARDS_START -->"
                end_marker = "<!-- LESSON_CARDS_END -->"
                if start_marker in content and end_marker in content:
                    before = content.split(start_marker)[0]
                    after = content.split(end_marker)[1]
                    middle = content.split(start_marker)[1].split(end_marker)[0]
                    new_middle = middle.rstrip("\n ") + "\n" + card_markup + "\n"
                    new_content = before + start_marker + "\n" + new_middle + end_marker + after
                    with open(index_path, "w", encoding="utf-8") as f:
                        f.write(new_content)

    return subject_slug, lesson_slug


def purge_deleted_lessons(site_root, older_than_days=None):
    """Permanently erase entries from _deleted-lessons/. With
    older_than_days set, only entries older than that survive the cut;
    with it left None, everything in the trash is purged. Returns the
    list of trash-folder names that were removed."""
    trash_root = _trash_root(site_root)
    if not os.path.isdir(trash_root):
        return []
    cutoff = time.time() - older_than_days * 86400 if older_than_days else None
    removed = []
    for name in os.listdir(trash_root):
        full = os.path.join(trash_root, name)
        if not os.path.isdir(full):
            continue
        if cutoff is not None and os.path.getmtime(full) > cutoff:
            continue
        shutil.rmtree(full)
        removed.append(name)
    return removed


# --------------------------------------------------------------------------
# Local preview server — lets "Preview in browser" resolve a lesson's
# absolute-rooted links (/assets/..., /programming/x/assignment.html)
# correctly, which a plain file:// open of index.html cannot do.
# --------------------------------------------------------------------------

_preview_state = {"root": None, "httpd": None, "thread": None}


def _find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_preview_server(site_root):
    """Start (or reuse) a local HTTP server rooted at site_root. Reuses
    the running server across calls as long as site_root hasn't changed;
    restarts it if it has. Returns the base URL, e.g. 'http://127.0.0.1:PORT'."""
    if _preview_state["root"] == site_root and _preview_state["httpd"]:
        return "http://127.0.0.1:{}".format(_preview_state["httpd"].server_address[1])

    stop_preview_server()

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=site_root)
    port = _find_free_port()
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    _preview_state["root"] = site_root
    _preview_state["httpd"] = httpd
    _preview_state["thread"] = thread
    return "http://127.0.0.1:{}".format(port)


def stop_preview_server():
    httpd = _preview_state.get("httpd")
    if httpd:
        httpd.shutdown()
        httpd.server_close()
    _preview_state["root"] = None
    _preview_state["httpd"] = None
    _preview_state["thread"] = None


def is_valid_site_root(path):
    """A real teaching-site root has an assets/ folder and a CNAME file."""
    if not path or not os.path.isdir(path):
        return False
    return os.path.isdir(os.path.join(path, "assets")) and os.path.exists(os.path.join(path, "CNAME"))


def find_site_root_relative():
    """Look near the running exe/script for the site folder: itself, its
    parent, its grandparent, and one level of subfolders under each."""
    seen = set()
    bases = [EXE_DIR, os.path.dirname(EXE_DIR), os.path.dirname(os.path.dirname(EXE_DIR))]
    for base in bases:
        if not base or base in seen or not os.path.isdir(base):
            continue
        seen.add(base)
        if is_valid_site_root(base):
            return base
        try:
            for name in os.listdir(base):
                sub = os.path.join(base, name)
                if is_valid_site_root(sub):
                    return sub
        except OSError:
            pass
    return None


def resolve_site_root(configured):
    """relative (near the app) -> absolute fallback -> not found, in that order."""
    if is_valid_site_root(configured):
        return configured, "config"
    found = find_site_root_relative()
    if found:
        return found, "relative"
    if is_valid_site_root(ABS_FALLBACK_SITE_ROOT):
        return ABS_FALLBACK_SITE_ROOT, "absolute-fallback"
    return None, "not-found"


def slugify(text):
    text = text.strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


# --------------------------------------------------------------------------
# Lesson "groups" — a group is any listing folder inside a subject that has
# its own index.html with the LESSON_CARDS_START/END markers and houses
# lesson folders directly inside it. This is how programming/ now works:
#
#   programming/other/index.html + style.css              <- group ""      -> "other"
#   programming/baccalaureate/grade-1-secondary/index.html <- group "baccalaureate/grade-1-secondary"
#   programming/baccalaureate/grade-2-secondary/index.html <- group "baccalaureate/grade-2-secondary"
#
# Groups are discovered dynamically (nothing hardcoded), so new grades or a
# "Courses" folder for another subject show up automatically once they
# exist on disk with an index.html containing the markers.
#
# A subject can ALSO still be flat (english/, math/ today): if the subject
# root's own index.html has the markers, that's group "" (empty string =
# root), rendered with the ORIGINAL subject_index.html + shared
# /assets/base.css — unchanged behavior for subjects that were never
# restructured. Nested groups always use group_index.html + a local,
# self-contained style.css instead.
# --------------------------------------------------------------------------

LESSON_CARDS_MARKER = "<!-- LESSON_CARDS_START -->"

_SKIP_DIR_NAMES = {"assets", "_deleted-lessons", "__pycache__"}


def _dir_has_group_index(full_dir):
    index_path = os.path.join(full_dir, "index.html")
    if not os.path.exists(index_path):
        return False
    try:
        with open(index_path, "r", encoding="utf-8") as f:
            content = f.read()
    except OSError:
        return False
    return LESSON_CARDS_MARKER in content or is_grid_style_index(content)


def list_lesson_groups(site_root, subject_slug):
    """Return sorted relative paths (posix-style, '' for the subject root
    itself) of every group folder found under <site_root>/<subject_slug>/.
    A lesson folder (has quiz.html) is never itself treated as a group."""
    subject_dir = os.path.join(site_root, subject_slug)
    if not os.path.isdir(subject_dir):
        return []

    groups = []
    if _dir_has_group_index(subject_dir) and not os.path.exists(os.path.join(subject_dir, "quiz.html")):
        groups.append("")

    for dirpath, dirnames, _filenames in os.walk(subject_dir):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIR_NAMES and not d.startswith(".")]
        rel = os.path.relpath(dirpath, subject_dir)
        if rel == ".":
            continue
        if os.path.exists(os.path.join(dirpath, "quiz.html")):
            continue  # this is a lesson folder, not a group
        if _dir_has_group_index(dirpath):
            groups.append(rel.replace(os.sep, "/"))

    return sorted(groups, key=lambda g: (g != "", g))


def group_display_name(group_relpath):
    """Human label for a group combobox, e.g. 'baccalaureate/grade-1-secondary'
    -> 'Baccalaureate / Grade 1 Secondary'; '' -> '(subject root)'."""
    if not group_relpath:
        return "(subject root)"
    parts = group_relpath.split("/")
    return " / ".join(p.replace("-", " ").title() for p in parts)


def group_dir(site_root, subject_slug, group_relpath):
    if group_relpath:
        return os.path.join(site_root, subject_slug, *group_relpath.split("/"))
    return os.path.join(site_root, subject_slug)


def group_index_path(site_root, subject_slug, group_relpath):
    return os.path.join(group_dir(site_root, subject_slug, group_relpath), "index.html")


def group_url_path(subject_slug, group_relpath):
    """Root-relative URL path (no leading/trailing slash) for a group's
    listing page, used only for canonical/meta tags and human-readable
    footer notes — actual navigation links stay relative."""
    parts = [subject_slug] + ([group_relpath] if group_relpath else [])
    return "/".join(parts)


def lesson_url_path(subject_slug, group_relpath, lesson_slug):
    return group_url_path(subject_slug, group_relpath) + "/" + lesson_slug


# --------------------------------------------------------------------------
# Accent "tracks" for individual lesson pages (quiz.html/assignment.html/
# lesson_index.html). These link ONE shared /assets/base.css site-wide, so
# per-group recoloring works by stamping a class onto <body> and letting
# base.css's body.track-* rules override just the --accent/-strong/-soft
# trio (see assets_templates/base.css) — same technique the group portal
# pages already use in their own style.css, just centralized instead of
# duplicated per subject.
#
# Add an entry here any time a new group needs its own accent; anything
# not listed falls back to no class (base.css's default blue).
# --------------------------------------------------------------------------

TRACK_CLASS_BY_GROUP = {
    ("programming", "baccalaureate/grade-1-secondary"): "track-one",   # orange
    ("programming", "baccalaureate/grade-2-secondary"): "track-two",   # blue (= default)
}


def track_class_for_group(subject_slug, group_relpath):
    return TRACK_CLASS_BY_GROUP.get((subject_slug, group_relpath), "")


_OLD_CSS_LINK_RE = {
    "/assets/base.css": "./base.css",
    "/assets/forms.css": "./forms.css",
}


def _patch_lesson_html_css_links(lesson_dir):
    """Rewrite <link href="/assets/base.css"|"/assets/forms.css"> to the
    bundled relative ./base.css|./forms.css in any of a lesson's own HTML
    files that still use the old absolute, shared-file path — e.g. a
    lesson generated before CSS bundling existed. Safe/idempotent: files
    already using the relative path are left untouched. Returns True if
    anything was changed."""
    changed_any = False
    for html_name in ("index.html", "quiz.html", "assignment.html"):
        path = os.path.join(lesson_dir, html_name)
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        original = content
        for old, new in _OLD_CSS_LINK_RE.items():
            content = content.replace('href="{}"'.format(old), 'href="{}"'.format(new))
        if content != original:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            changed_any = True
    return changed_any


def write_lesson_stylesheets(lesson_dir):
    """Copy base.css + forms.css straight into a lesson's own folder, so
    the lesson page is self-contained and never depends on someone
    remembering to click 'Sync site assets' to push /assets/base.css
    live. Lesson pages link these as ./base.css and ./forms.css
    (relative — works at any folder depth automatically, and unlike an
    absolute /assets/... path, also resolves when a file is opened
    directly in a browser rather than served by a webserver). Also
    patches any of the lesson's own HTML files still pointing at the old
    absolute /assets/base.css|forms.css path, so pre-existing lessons
    get fixed the moment this runs, not just newly generated ones."""
    os.makedirs(lesson_dir, exist_ok=True)
    for name in ("base.css", "forms.css"):
        content = load_asset_template(name)
        with open(os.path.join(lesson_dir, name), "w", encoding="utf-8") as f:
            f.write(content)
    _patch_lesson_html_css_links(lesson_dir)


def sync_all_lesson_stylesheets(site_root):
    """Re-copy the current base.css/forms.css templates into every
    existing lesson folder across every subject/group, and patch any
    old absolute /assets/base.css links in those lessons' HTML files to
    the bundled relative path. Use this after editing
    assets_templates/base.css (e.g. a new track color), or once after
    upgrading to bundled per-lesson stylesheets, so already-generated
    lessons pick up the change without regenerating one by one.

    Deliberately does its own folder scan here instead of reusing
    list_existing_lessons() — that one only counts a folder as a lesson
    if it has quiz.html (used to populate the quiz-editing dropdowns),
    which would silently skip older, content-only lessons that were
    never given a quiz. Here, anything with an index.html qualifies.
    Returns the list of lesson dirs touched."""
    touched = []
    for subject_slug, _label in SUBJECTS:
        groups = list_lesson_groups(site_root, subject_slug)
        if not groups:
            groups = [""]
        for group_relpath in groups:
            gdir = group_dir(site_root, subject_slug, group_relpath)
            if not os.path.isdir(gdir):
                continue
            try:
                names = sorted(os.listdir(gdir))
            except OSError:
                continue
            for name in names:
                full = os.path.join(gdir, name)
                if os.path.isdir(full) and os.path.exists(os.path.join(full, "index.html")):
                    write_lesson_stylesheets(full)
                    touched.append(full)
    return touched


def create_group(site_root, subject_slug, group_relpath, group_title, group_lede):
    """Create a new nested group folder (e.g. 'baccalaureate/grade-3-secondary')
    with its own self-contained index.html + style.css. Raises FileExistsError
    if that folder already has an index.html (won't overwrite silently)."""
    if not group_relpath:
        raise ValueError("group_relpath is required to create a new group")
    gdir = group_dir(site_root, subject_slug, group_relpath)
    index_path = os.path.join(gdir, "index.html")
    if os.path.exists(index_path):
        raise FileExistsError(index_path)
    os.makedirs(gdir, exist_ok=True)

    group_slug = group_relpath.split("/")[-1]
    index_html = load_template("group_index.html")
    index_html = (index_html
                  .replace("{{GROUP_TITLE}}", group_title)
                  .replace("{{GROUP_LEDE}}", group_lede)
                  .replace("{{GROUP_SLUG}}", group_slug)
                  .replace("{{GROUP_URL_PATH}}", group_url_path(subject_slug, group_relpath))
                  .replace("{{ABOUT_BLOCK}}", ""))
    with open(index_path, "w", encoding="utf-8") as f:
        f.write(index_html)

    style_css = load_asset_template("group_style.css")
    with open(os.path.join(gdir, "style.css"), "w", encoding="utf-8") as f:
        f.write(style_css)

    return gdir


def sync_group_stylesheets(site_root):
    """Refresh style.css in every existing nested group folder (across all
    subjects) from the current assets_templates/group_style.css — so a
    global design tweak propagates to every grade/Courses page. Subject-root
    ('') groups are untouched here; they use the shared /assets/base.css
    via sync_site_assets() instead. Returns the list of paths written."""
    written = []
    template = load_asset_template("group_style.css")
    for subject_slug, _label in SUBJECTS:
        for group_relpath in list_lesson_groups(site_root, subject_slug):
            if not group_relpath:
                continue
            gdir = group_dir(site_root, subject_slug, group_relpath)
            out_path = os.path.join(gdir, "style.css")
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(template)
            written.append(out_path)
    return written


# --------------------------------------------------------------------------
# "Grid" lesson cards — the newer visual format used by hand-built nested
# group pages (programming/baccalaureate/grade-1-secondary,
# grade-2-secondary, programming/other), which looks like:
#
#   <div class="lessons">
#   <a class="lesson" href="./slug/"><span class="number">01</span>
#     <h3>Title</h3><p>Desc</p><span class="open">Open lesson</span></a>
#   ...
#   </div></div></section>
#
# This is NOT the legacy .lesson-card.frame + LESSON_CARDS_START/END
# system (still used by flat subjects like english/math via
# subject_index.html/lesson_card.html). Detection is automatic — no
# markers to maintain by hand. The "Open lesson" label text is copied
# from whatever card already exists in the file, so Arabic vs English
# group pages each keep their own wording without the app hardcoding it.
# --------------------------------------------------------------------------

_GRID_CONTAINER_RE = re.compile(r'(<div class="lessons">)(.*?)(</div>\s*</div>\s*</section>)', re.DOTALL)
_GRID_CARD_RE = re.compile(
    r'<a class="lesson" href="\./([^/"]+)/">\s*'
    r'<span class="number">(\d+)</span>\s*'
    r'<h3>(.*?)</h3>\s*'
    r'<p>(.*?)</p>\s*'
    r'<span class="open">(.*?)</span>\s*</a>',
    re.DOTALL,
)


def is_grid_style_index(content):
    """True if this group index.html uses the newer '.lesson' grid card
    format instead of the legacy '.lesson-card.frame' + marker system."""
    return bool(_GRID_CONTAINER_RE.search(content)) and "lesson-card" not in content


def _parse_grid_cards(cards_block):
    return [
        {"slug": m.group(1), "number": m.group(2), "title": m.group(3),
         "desc": m.group(4), "open_label": m.group(5), "raw": m.group(0)}
        for m in _GRID_CARD_RE.finditer(cards_block)
    ]


def upsert_grid_lesson_card(index_path, lesson_slug, lesson_title, lesson_desc):
    """Insert or update a lesson's card in a grid-style group index.html.
    The number auto-increments from the highest existing card (kept as-is
    if the lesson already has a card, so regenerating doesn't reshuffle
    everyone else's numbering). Raises ValueError if the file isn't
    grid-style / the container can't be found."""
    with open(index_path, "r", encoding="utf-8") as f:
        content = f.read()

    m = _GRID_CONTAINER_RE.search(content)
    if not m:
        raise ValueError('No <div class="lessons">...</div></div></section> block found in ' + index_path)

    open_tag, cards_block, close_tag = m.group(1), m.group(2), m.group(3)
    cards = _parse_grid_cards(cards_block)

    open_label = cards[0]["open_label"] if cards else "Open lesson"
    existing = next((c for c in cards if c["slug"] == lesson_slug), None)
    if existing:
        number = existing["number"]
        cards = [c for c in cards if c["slug"] != lesson_slug]
    else:
        width = len(cards[-1]["number"]) if cards else 2
        next_n = max((int(c["number"]) for c in cards), default=0) + 1
        number = str(next_n).zfill(width)

    new_card = ('<a class="lesson" href="./{slug}/"><span class="number">{num}</span>'
                '<h3>{title}</h3><p>{desc}</p><span class="open">{open_label}</span></a>').format(
                    slug=lesson_slug, num=number, title=lesson_title, desc=lesson_desc, open_label=open_label)

    rebuilt_cards = "\n".join(c["raw"] for c in cards) + ("\n" if cards else "") + new_card + "\n"
    new_content = content[:m.start()] + open_tag + "\n" + rebuilt_cards + close_tag + content[m.end():]

    with open(index_path, "w", encoding="utf-8") as f:
        f.write(new_content)


def remove_grid_lesson_card(index_path, lesson_slug):
    """Remove a lesson's card from a grid-style group index.html. Returns
    the removed card's raw markup (stashed for trash recovery), or None
    if no matching card was found."""
    if not os.path.exists(index_path):
        return None
    with open(index_path, "r", encoding="utf-8") as f:
        content = f.read()

    m = _GRID_CONTAINER_RE.search(content)
    if not m:
        return None

    open_tag, cards_block, close_tag = m.group(1), m.group(2), m.group(3)
    cards = _parse_grid_cards(cards_block)
    removed = next((c for c in cards if c["slug"] == lesson_slug), None)
    if not removed:
        return None
    remaining = [c for c in cards if c["slug"] != lesson_slug]
    rebuilt = "\n".join(c["raw"] for c in remaining) + ("\n" if remaining else "")
    new_content = content[:m.start()] + open_tag + "\n" + rebuilt + close_tag + content[m.end():]
    with open(index_path, "w", encoding="utf-8") as f:
        f.write(new_content)
    return removed["raw"]


def upsert_lesson_card(site_root, subject_slug, group_relpath, lesson_slug, lesson_title, lesson_desc,
                        question_count=None):
    """Single entry point quiz_tab._generate() calls after writing a
    lesson's files: figures out whether the target group index.html is
    grid-style or legacy-style and inserts/updates the card accordingly.
    Creates the group's index.html + style.css first if this is a brand
    new nested group that doesn't exist on disk yet (legacy style only —
    grid-style group pages are hand-built, so a missing one is an error
    the caller should surface, not silently paper over)."""
    index_path = group_index_path(site_root, subject_slug, group_relpath)

    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            content = f.read()
        if is_grid_style_index(content):
            upsert_grid_lesson_card(index_path, lesson_slug, lesson_title, lesson_desc)
            return "grid"

    # legacy style (flat subject root like english/math, or a nested group
    # that was created through this app rather than hand-built)
    if not group_relpath:
        subject_title = dict(SUBJECTS).get(subject_slug, subject_slug.title())
        _upsert_legacy_subject_card(index_path, subject_slug, subject_title, lesson_slug,
                                     lesson_title, lesson_desc, question_count or 0)
    else:
        if not os.path.exists(index_path):
            create_group(site_root, subject_slug, group_relpath,
                          group_display_name(group_relpath), "")
        _upsert_legacy_group_card(index_path, subject_slug, lesson_slug, lesson_title,
                                   lesson_desc, question_count or 0)
    return "legacy"


def _legacy_lesson_card_markup(subject_slug, lesson_slug, lesson_title, lesson_desc, question_count):
    card = load_template("lesson_card.html")
    return (card
            .replace("{{SUBJECT_SLUG}}", subject_slug)
            .replace("{{LESSON_SLUG}}", lesson_slug)
            .replace("{{LESSON_TITLE}}", lesson_title)
            .replace("{{LESSON_DESC}}", lesson_desc)
            .replace("{{QUESTION_COUNT}}", str(question_count)))


def _upsert_legacy_subject_card(index_path, subject_slug, subject_title, lesson_slug, lesson_title,
                                 lesson_desc, question_count):
    card = _legacy_lesson_card_markup(subject_slug, lesson_slug, lesson_title, lesson_desc, question_count)
    start_marker = "<!-- LESSON_CARDS_START -->"
    end_marker = "<!-- LESSON_CARDS_END -->"

    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            content = f.read()
        if start_marker in content and end_marker in content:
            before = content.split(start_marker)[0]
            after = content.split(end_marker)[1]
            middle = content.split(start_marker)[1].split(end_marker)[0]
            middle = re.sub(_lesson_card_pattern(lesson_slug, subject_slug), "\n", middle, flags=re.DOTALL)
            new_middle = middle.rstrip() + "\n" + card
            new_content = before + start_marker + "\n" + new_middle + end_marker + after
            with open(index_path, "w", encoding="utf-8") as f:
                f.write(new_content)
            return
        raise ValueError(index_path + " exists but has no LESSON_CARDS_START/END markers.")

    os.makedirs(os.path.dirname(index_path), exist_ok=True)
    subj = load_template("subject_index.html")
    subj = (subj
            .replace("{{SUBJECT_TITLE}}", subject_title)
            .replace("{{SUBJECT_SLUG}}", subject_slug)
            .replace("{{SUBJECT_LEDE}}", "{} lessons, quizzes, and assignments.".format(subject_title))
            .replace("{{DWG_NO}}", "01")
            .replace("{{ABOUT_BLOCK}}", ""))
    subj = subj.replace(start_marker + "\n" + end_marker, start_marker + "\n" + card + end_marker)
    with open(index_path, "w", encoding="utf-8") as f:
        f.write(subj)


def _upsert_legacy_group_card(index_path, subject_slug, lesson_slug, lesson_title, lesson_desc, question_count):
    card = _legacy_lesson_card_markup(subject_slug, lesson_slug, lesson_title, lesson_desc, question_count)
    start_marker = "<!-- LESSON_CARDS_START -->"
    end_marker = "<!-- LESSON_CARDS_END -->"
    with open(index_path, "r", encoding="utf-8") as f:
        content = f.read()
    if start_marker not in content or end_marker not in content:
        raise ValueError(index_path + " has no LESSON_CARDS_START/END markers.")
    before = content.split(start_marker)[0]
    after = content.split(end_marker)[1]
    middle = content.split(start_marker)[1].split(end_marker)[0]
    middle = re.sub(_lesson_card_pattern(lesson_slug), "\n", middle, flags=re.DOTALL)
    new_middle = middle.rstrip() + "\n" + card
    new_content = before + start_marker + "\n" + new_middle + end_marker + after
    with open(index_path, "w", encoding="utf-8") as f:
        f.write(new_content)


def load_template(name):
    path = os.path.join(TEMPLATES_DIR, name)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def load_asset_template(name):
    path = os.path.join(ASSETS_TEMPLATES_DIR, name)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def load_config():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_config(cfg):
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass


def get_drive_config(cfg):
    """Drive bridge (Apps Script Web App) settings, shared across the
    Assignment and Attachment tabs. admin_token gates privileged actions
    (attachment uploads); student assignment submissions don't need it."""
    return {
        "web_app_url": cfg.get("drive_web_app_url", ""),
        "admin_token": cfg.get("drive_admin_token", ""),
    }


def save_drive_config(cfg, web_app_url, admin_token):
    cfg["drive_web_app_url"] = web_app_url.strip()
    cfg["drive_admin_token"] = admin_token.strip()
    save_config(cfg)


def list_existing_lessons(site_root, subject_slug, group_relpath=""):
    """Scan <site_root>/<subject>/<group_relpath>/ for lesson folders
    (anything containing a quiz.html), used by the Assignment/Attachment
    tabs to populate a 'pick an existing lesson' dropdown instead of
    retyping the slug. group_relpath="" scans the subject root directly
    (legacy flat subjects like english/math)."""
    scan_dir = group_dir(site_root, subject_slug, group_relpath)
    if not os.path.isdir(scan_dir):
        return []
    out = []
    try:
        for name in sorted(os.listdir(scan_dir)):
            full = os.path.join(scan_dir, name)
            if os.path.isdir(full) and os.path.exists(os.path.join(full, "quiz.html")):
                out.append(name)
    except OSError:
        pass
    return out


def sync_site_assets(site_root, drive_web_app_url):
    """Write auth.js / quiz.js / assign.js / attachments.js from
    assets_templates/ into <site_root>/assets/, substituting the Drive
    bridge endpoint. Each engine carries its own el()/postToDrive() copy
    (common.js was tried as a shared home for these and rolled back —
    left in assets_templates/ unreferenced, not deleted, in case it's
    revisited later).
    Also copies the shared stylesheets (base.css, forms.css) the same
    way, kept in step with the shipped copy in assets_templates/.
    Call this after (re)configuring the Drive bridge or updating the
    generator so the live site picks up the new engine code."""
    assets_dir = os.path.join(site_root, "assets")
    os.makedirs(assets_dir, exist_ok=True)
    written = []

    for name in ("auth.js", "quiz.js", "assign.js", "attachments.js"):
        content = load_asset_template(name)
        content = content.replace("{{DRIVE_ENDPOINT}}", drive_web_app_url.strip())
        out_path = os.path.join(assets_dir, name)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(content)
        written.append(out_path)

    for name in ("base.css", "forms.css"):
        content = load_asset_template(name)
        out_path = os.path.join(assets_dir, name)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(content)
        written.append(out_path)

    return written


# ==========================================================================
# Graded-question editor — shared by Quiz Maker and Assignment Maker.
# Three question types (mcq/truefalse/match), each addable one-at-a-time
# via a dialog or in bulk via GradedBulkDialog. chapter_choices/
# default_chapter are only passed by Quiz Maker (quizzes are chapter-
# tagged for dashboard aggregation); Assignment Maker calls the same
# dialogs without them and simply gets no "chapter" key back.
# ==========================================================================

GRADED_BULK_HELP = """Bulk paste format for graded questions \u2014 one block per question:

MCQ (same syntax as the Quiz Maker tab):
Q: What does the def keyword do?
A) Deletes a variable
B) Starts a function definition *
C) Defines a class
D) Imports a module
E: def marks the start of a function definition.

True/False:
TF: Python is a compiled language.
Correct: False
E: Python is interpreted, not compiled.

Matching (shows one dropdown per row, options shared across rows):
MATCH: Match each term to its definition
- Variable -> Stores a value
- Loop -> Repeats code
- Function -> Named block of code
E: optional explanation

Separate questions with a blank line or a line of ---.
Mark correct MCQ option(s) with a * right after them (up to 6 options,
A-F) \u2014 star more than one for a "select all that apply" question.
"Correct:" for True/False takes True or False (case-insensitive).
Each "- label -> answer" line under MATCH is one row; the dropdown options
shown to students are every row's answer, alphabetized (so position never
gives the answer away).
"E:" (explanation) is optional on every question type.

In the Quiz Maker tab only: a "Ch: N" line on its own sets the chapter
for every question after it, until the next "Ch:" line \u2014 same
convention as the classic quiz bulk-paste box. Questions before the
first "Ch:" line use the chapter selected in the dropdown above this
box."""


def parse_bulk_graded_questions(text, current_chapter=None):
    """Parses the MCQ / True-False / Matching bulk-paste block above into
    a flat list of typed question dicts ready for JSON embedding. Mirrors
    quiz_tab.py's old parse_bulk_questions() structurally (same block-flush
    pattern) but supports three question shapes instead of one.

    current_chapter is None for assignments (no chapter concept there —
    items get no "chapter" key at all). Quiz Maker passes the tab's
    currently-selected chapter; a "Ch: N" line overrides it from that
    point on, same convention as the classic quiz bulk-paste box."""
    text = text.strip()
    if not text:
        return []

    items = []
    counter = [0]
    chapter = current_chapter

    def next_id():
        counter[0] += 1
        return "g" + str(counter[0])

    mode = None  # "mcq" | "tf" | "match" | None
    q_text, options, correct, explain = None, [], [], ""
    tf_text, tf_correct, tf_explain = None, None, ""
    match_prompt, match_rows, match_explain = None, [], ""

    def flush():
        item = None
        if mode == "mcq" and q_text and len(options) >= 2:
            item = {
                "id": next_id(), "type": "mcq", "prompt": q_text,
                "options": list(options), "correct": list(correct) if correct else [0],
                "explain": explain,
            }
        elif mode == "tf" and tf_text and tf_correct is not None:
            item = {
                "id": next_id(), "type": "truefalse", "prompt": tf_text,
                "correct": tf_correct, "explain": tf_explain,
            }
        elif mode == "match" and match_prompt and len(match_rows) >= 2:
            pool = sorted(set(r["correct"] for r in match_rows))
            item = {
                "id": next_id(), "type": "match", "prompt": match_prompt,
                "rows": list(match_rows), "options": pool, "explain": match_explain,
            }
        if item is not None:
            if chapter is not None:
                item["chapter"] = chapter
            items.append(item)

    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line:
            continue

        if re.match(r"^-{3,}$", line):
            flush()
            mode = None
            q_text, options, correct, explain = None, [], [], ""
            tf_text, tf_correct, tf_explain = None, None, ""
            match_prompt, match_rows, match_explain = None, [], ""
            continue

        ch_match = re.match(r"^Ch:\s*(\d+)", line, re.IGNORECASE)
        if ch_match:
            flush()
            mode = None
            q_text, options, correct, explain = None, [], [], ""
            tf_text, tf_correct, tf_explain = None, None, ""
            match_prompt, match_rows, match_explain = None, [], ""
            chapter = int(ch_match.group(1))
            continue

        if line.startswith("Q:"):
            flush()
            mode = "mcq"
            q_text, options, correct, explain = line[2:].strip(), [], [], ""
            continue

        if line.startswith("TF:"):
            flush()
            mode = "tf"
            tf_text, tf_correct, tf_explain = line[3:].strip(), None, ""
            continue

        if line.upper().startswith("MATCH:"):
            flush()
            mode = "match"
            match_prompt = line.split(":", 1)[1].strip()
            match_rows, match_explain = [], ""
            continue

        opt_match = re.match(r"^([A-Fa-f])\)", line)
        if mode == "mcq" and opt_match:
            opt_text = line[2:].strip()
            is_correct = opt_text.rstrip().endswith("*")
            if is_correct:
                opt_text = opt_text.rstrip()[:-1].strip()
            options.append(opt_text)
            if is_correct:
                correct.append(len(options) - 1)
            continue

        if mode == "tf" and line.lower().startswith("correct:"):
            tf_correct = line.split(":", 1)[1].strip().lower().startswith("t")
            continue

        if mode == "match" and line.startswith("-") and "->" in line:
            label, ans = line[1:].split("->", 1)
            match_rows.append({"label": label.strip(), "correct": ans.strip()})
            continue

        if line.startswith("E:"):
            explain_text = line[2:].strip()
            if mode == "mcq":
                explain = explain_text
            elif mode == "tf":
                tf_explain = explain_text
            elif mode == "match":
                match_explain = explain_text
            continue

    flush()
    return items


def _add_chapter_row(dialog, chapter_choices, default_chapter, existing_chapter):
    """Shared by MCQItemDialog/TrueFalseItemDialog/MatchItemDialog — only
    added when chapter_choices is given (Quiz Maker passes it; Assignment
    Maker doesn't, since assignments have no chapter concept). Returns the
    StringVar so _on_save can read it back."""
    row = tk.Frame(dialog)
    row.pack(fill="x", padx=10, pady=(6, 0))
    tk.Label(row, text="Chapter:", width=14, anchor="w").pack(side="left")
    value = str(existing_chapter if existing_chapter is not None else (default_chapter or 1))
    chapter_var = tk.StringVar(value=value)
    ttk.Combobox(row, textvariable=chapter_var, state="readonly",
                 values=[str(c) for c in chapter_choices], width=6).pack(side="left")
    return chapter_var


class MCQItemDialog(tk.Toplevel):
    """Add/edit one multiple-choice graded question. Checkboxes (not a
    single radio) so more than one choice can be marked correct."""

    def __init__(self, parent, existing=None, chapter_choices=None, default_chapter=None):
        super().__init__(parent)
        self.title("Multiple choice question")
        self.result = None
        fit_geometry(self, 560, 560, min_w=380, min_h=400)
        self.resizable(True, True)

        pad = {"padx": 10, "pady": 6}

        self.chapter_var = None
        if chapter_choices:
            self.chapter_var = _add_chapter_row(self, chapter_choices, default_chapter,
                                                 existing.get("chapter") if existing else None)

        tk.Label(self, text="Question text (HTML ok, e.g. <code>...</code>)").pack(anchor="w", **pad)
        self.q_text = tk.Text(self, height=3, wrap="word", undo=True, autoseparators=True, maxundo=-1)
        self.q_text.pack(fill="x", **pad)

        tk.Label(self, text="Choices \u2014 check every box that's a correct answer:").pack(anchor="w", **pad)
        self.choices_frame = tk.Frame(self)
        self.choices_frame.pack(fill="both", expand=True, **pad)
        self.choice_rows = []  # list of (correct_var, text_var, row_frame)

        add_row = tk.Frame(self)
        add_row.pack(fill="x", padx=10)
        tk.Button(add_row, text="+ Add choice", command=self._add_choice_row).pack(side="left")

        tk.Label(self, text="Explanation (optional)").pack(anchor="w", **pad)
        self.explain_text = tk.Text(self, height=3, wrap="word", undo=True, autoseparators=True, maxundo=-1)
        self.explain_text.pack(fill="x", **pad)

        btn_row = tk.Frame(self)
        btn_row.pack(fill="x", pady=12)
        tk.Button(btn_row, text="Save question", command=self._on_save).pack(side="right", padx=10)
        tk.Button(btn_row, text="Cancel", command=self.destroy).pack(side="right")

        if existing:
            self.q_text.insert("1.0", existing.get("prompt", ""))
            options = existing.get("options", ["", ""])
            correct = set(existing.get("correct", []))
            for i, opt in enumerate(options):
                self._add_choice_row(text=opt, checked=(i in correct))
            self.explain_text.insert("1.0", existing.get("explain", ""))
        else:
            self._add_choice_row()
            self._add_choice_row()

        lock_min_width_to_content(self)
        self.transient(parent)
        self.grab_set()

    def _add_choice_row(self, text="", checked=False):
        row = tk.Frame(self.choices_frame)
        row.pack(fill="x", pady=2)
        correct_var = tk.BooleanVar(value=checked)
        tk.Checkbutton(row, variable=correct_var).pack(side="left")
        text_var = tk.StringVar(value=text)
        tk.Entry(row, textvariable=text_var).pack(side="left", fill="x", expand=True)
        tk.Button(row, text="\u2212", width=2, command=lambda: self._remove_choice_row(row)).pack(side="left", padx=(4, 0))
        self.choice_rows.append((correct_var, text_var, row))

    def _remove_choice_row(self, row):
        if len(self.choice_rows) <= 2:
            messagebox.showinfo("Minimum 2 choices", "A multiple choice question needs at least 2 choices.", parent=self)
            return
        self.choice_rows = [r for r in self.choice_rows if r[2] is not row]
        row.destroy()

    def _on_save(self):
        q = self.q_text.get("1.0", "end").strip()
        if not q:
            messagebox.showerror("Missing question", "Enter the question text.", parent=self)
            return
        options = [tv.get().strip() for _, tv, _ in self.choice_rows]
        if any(not o for o in options):
            messagebox.showerror("Missing choice", "All choice fields must be filled in.", parent=self)
            return
        correct = [i for i, (cv, _, _) in enumerate(self.choice_rows) if cv.get()]
        if not correct:
            messagebox.showerror("No correct answer", "Check at least one choice as correct.", parent=self)
            return
        explain = self.explain_text.get("1.0", "end").strip()
        self.result = {"type": "mcq", "prompt": q, "options": options, "correct": correct, "explain": explain}
        if self.chapter_var is not None:
            self.result["chapter"] = int(self.chapter_var.get())
        self.destroy()


class TrueFalseItemDialog(tk.Toplevel):
    def __init__(self, parent, existing=None, chapter_choices=None, default_chapter=None):
        super().__init__(parent)
        self.title("True / False question")
        self.result = None
        fit_geometry(self, 480, 380, min_w=360, min_h=320)
        self.resizable(True, True)

        pad = {"padx": 10, "pady": 6}

        self.chapter_var = None
        if chapter_choices:
            self.chapter_var = _add_chapter_row(self, chapter_choices, default_chapter,
                                                 existing.get("chapter") if existing else None)

        tk.Label(self, text="Statement (HTML ok)").pack(anchor="w", **pad)
        self.q_text = tk.Text(self, height=3, wrap="word", undo=True, autoseparators=True, maxundo=-1)
        self.q_text.pack(fill="x", **pad)

        tk.Label(self, text="Correct answer:").pack(anchor="w", **pad)
        self.correct_var = tk.StringVar(value="")
        radio_row = tk.Frame(self)
        radio_row.pack(anchor="w", padx=10)
        tk.Radiobutton(radio_row, text="True", variable=self.correct_var, value="True").pack(side="left")
        tk.Radiobutton(radio_row, text="False", variable=self.correct_var, value="False").pack(side="left", padx=10)

        tk.Label(self, text="Explanation (optional)").pack(anchor="w", **pad)
        self.explain_text = tk.Text(self, height=3, wrap="word", undo=True, autoseparators=True, maxundo=-1)
        self.explain_text.pack(fill="x", **pad)

        btn_row = tk.Frame(self)
        btn_row.pack(fill="x", pady=12)
        tk.Button(btn_row, text="Save question", command=self._on_save).pack(side="right", padx=10)
        tk.Button(btn_row, text="Cancel", command=self.destroy).pack(side="right")

        if existing:
            self.q_text.insert("1.0", existing.get("prompt", ""))
            self.correct_var.set("True" if existing.get("correct") else "False")
            self.explain_text.insert("1.0", existing.get("explain", ""))

        lock_min_width_to_content(self)
        self.transient(parent)
        self.grab_set()

    def _on_save(self):
        q = self.q_text.get("1.0", "end").strip()
        if not q:
            messagebox.showerror("Missing statement", "Enter the statement text.", parent=self)
            return
        if not self.correct_var.get():
            messagebox.showerror("No correct answer", "Choose True or False as the correct answer.", parent=self)
            return
        explain = self.explain_text.get("1.0", "end").strip()
        self.result = {"type": "truefalse", "prompt": q, "correct": self.correct_var.get() == "True", "explain": explain}
        if self.chapter_var is not None:
            self.result["chapter"] = int(self.chapter_var.get())
        self.destroy()


class MatchItemDialog(tk.Toplevel):
    def __init__(self, parent, existing=None, chapter_choices=None, default_chapter=None):
        super().__init__(parent)
        self.title("Matching question")
        self.result = None
        fit_geometry(self, 600, 520, min_w=420, min_h=380)
        self.resizable(True, True)

        pad = {"padx": 10, "pady": 6}

        self.chapter_var = None
        if chapter_choices:
            self.chapter_var = _add_chapter_row(self, chapter_choices, default_chapter,
                                                 existing.get("chapter") if existing else None)

        tk.Label(self, text="Instructions (HTML ok, e.g. \u201cMatch each term to its definition\u201d)").pack(anchor="w", **pad)
        self.q_text = tk.Text(self, height=2, wrap="word", undo=True, autoseparators=True, maxundo=-1)
        self.q_text.pack(fill="x", **pad)

        tk.Label(self, text="Rows \u2014 term on the left, its correct match on the right:").pack(anchor="w", **pad)
        header = tk.Frame(self)
        header.pack(fill="x", padx=10)
        tk.Label(header, text="Term", width=28, anchor="w").pack(side="left")
        tk.Label(header, text="Correct match", anchor="w").pack(side="left", fill="x", expand=True)

        self.rows_frame = tk.Frame(self)
        self.rows_frame.pack(fill="both", expand=True, **pad)
        self.row_vars = []  # list of (label_var, answer_var, row_frame)

        add_row = tk.Frame(self)
        add_row.pack(fill="x", padx=10)
        tk.Button(add_row, text="+ Add row", command=self._add_row).pack(side="left")

        tk.Label(self, text="Explanation (optional)").pack(anchor="w", **pad)
        self.explain_text = tk.Text(self, height=2, wrap="word", undo=True, autoseparators=True, maxundo=-1)
        self.explain_text.pack(fill="x", **pad)

        btn_row = tk.Frame(self)
        btn_row.pack(fill="x", pady=12)
        tk.Button(btn_row, text="Save question", command=self._on_save).pack(side="right", padx=10)
        tk.Button(btn_row, text="Cancel", command=self.destroy).pack(side="right")

        if existing:
            self.q_text.insert("1.0", existing.get("prompt", ""))
            for row in existing.get("rows", []):
                self._add_row(label=row.get("label", ""), answer=row.get("correct", ""))
            self.explain_text.insert("1.0", existing.get("explain", ""))
        else:
            self._add_row()
            self._add_row()

        lock_min_width_to_content(self)
        self.transient(parent)
        self.grab_set()

    def _add_row(self, label="", answer=""):
        row = tk.Frame(self.rows_frame)
        row.pack(fill="x", pady=2)
        label_var = tk.StringVar(value=label)
        tk.Entry(row, textvariable=label_var, width=28).pack(side="left")
        answer_var = tk.StringVar(value=answer)
        tk.Entry(row, textvariable=answer_var).pack(side="left", fill="x", expand=True, padx=(6, 0))
        tk.Button(row, text="\u2212", width=2, command=lambda: self._remove_row(row)).pack(side="left", padx=(4, 0))
        self.row_vars.append((label_var, answer_var, row))

    def _remove_row(self, row):
        if len(self.row_vars) <= 2:
            messagebox.showinfo("Minimum 2 rows", "A matching question needs at least 2 rows.", parent=self)
            return
        self.row_vars = [r for r in self.row_vars if r[2] is not row]
        row.destroy()

    def _on_save(self):
        prompt = self.q_text.get("1.0", "end").strip()
        if not prompt:
            messagebox.showerror("Missing instructions", "Enter the matching instructions.", parent=self)
            return
        rows = []
        for label_var, answer_var, _ in self.row_vars:
            label = label_var.get().strip()
            answer = answer_var.get().strip()
            if not label or not answer:
                messagebox.showerror("Incomplete row", "Every row needs both a term and its correct match.", parent=self)
                return
            rows.append({"label": label, "correct": answer})
        options = sorted(set(r["correct"] for r in rows))
        explain = self.explain_text.get("1.0", "end").strip()
        self.result = {"type": "match", "prompt": prompt, "rows": rows, "options": options, "explain": explain}
        if self.chapter_var is not None:
            self.result["chapter"] = int(self.chapter_var.get())
        self.destroy()


class GradedBulkDialog(tk.Toplevel):
    """Same idea as quiz_tab.py's BulkDialog \u2014 for pasting several
    questions at once instead of clicking through one at a time. Results
    land in the same list the +Multiple choice / +True-False / +Matching
    buttons populate, so it's a shortcut into the visual editor, not a
    separate storage format."""

    def __init__(self, parent, current_chapter=None):
        super().__init__(parent)
        self.title("Bulk paste graded questions")
        self.result = None
        self.current_chapter = current_chapter
        fit_geometry(self, 640, 560, min_w=420, min_h=400)
        self.resizable(True, True)

        pad = {"padx": 10, "pady": 6}
        tk.Label(self, text=GRADED_BULK_HELP, justify="left", anchor="w",
                 fg="gray30", font=("TkDefaultFont", 8), wraplength=600).pack(fill="x", **pad)
        self.text = tk.Text(self, height=16, wrap="word", undo=True, autoseparators=True, maxundo=-1)
        self.text.pack(fill="both", expand=True, **pad)

        btn_row = tk.Frame(self)
        btn_row.pack(fill="x", pady=12)
        tk.Button(btn_row, text="Add questions", command=self._on_add).pack(side="right", padx=10)
        tk.Button(btn_row, text="Cancel", command=self.destroy).pack(side="right")

        lock_min_width_to_content(self)
        self.transient(parent)
        self.grab_set()

    def _on_add(self):
        items = parse_bulk_graded_questions(self.text.get("1.0", "end"), current_chapter=self.current_chapter)
        if not items:
            messagebox.showerror("Nothing parsed", "No valid questions were found in that text.", parent=self)
            return
        self.result = items
        self.destroy()


