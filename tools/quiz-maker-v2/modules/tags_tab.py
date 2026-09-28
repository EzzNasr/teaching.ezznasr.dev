#!/usr/bin/env python3
"""
tags_tab.py — Tab 4: Lesson Tags.

Grade subscriptions (see subscription-plan.md) sell a whole CHAPTER or the current
TERM of a grade. Which lessons belong to which chapter/term is not guessed from
folder names: it is a tag you set here, per lesson, and it is stored server-side
(Code.gs, "LessonTags" sheet) through the same Drive bridge URL + admin token as
the other tabs.

  - Lists the lesson folders found under programming/baccalaureate/grade-1-secondary
    and grade-2-secondary in your local site copy, with the chapter/term each one
    currently has on the server.
  - Select a lesson, type its chapter and term, Save. Blank BOTH to clear the tag.
  - The server enforces the rules (whole numbers; every lesson of one chapter in one
    grade must share the same term; only these two grades) and its message is shown
    exactly as it comes back.
  - "Untagged only" hides lessons that already have a tag, for the first pass.

Untagged lessons are never affected by subscriptions: they stay locked/unlocked by
hand exactly as before.
"""

import os
import re
import threading
import tkinter as tk
from tkinter import ttk, messagebox

from modules import common, drive_bridge

SUBJECT = "programming"
GRADES = [
    ("baccalaureate/grade-1-secondary", "Grade 1"),
    ("baccalaureate/grade-2-secondary", "Grade 2"),
]
_CHAPTER_IN_NAME = re.compile(r"chapter-(\d+)", re.IGNORECASE)


def lesson_path(group_relpath, slug):
    """Same key Code.gs uses: 'programming/baccalaureate/grade-1-secondary/<slug>'."""
    return "/".join([SUBJECT, group_relpath, slug]).lower()


def find_grade_lessons(site_root):
    """[(lesson_path, grade_label, slug)] for every folder with an index.html under
    the two grade folders, sorted by grade then slug."""
    out = []
    for group_relpath, label in GRADES:
        gdir = common.group_dir(site_root, SUBJECT, group_relpath)
        if not os.path.isdir(gdir):
            continue
        try:
            names = sorted(os.listdir(gdir))
        except OSError:
            continue
        for name in names:
            full = os.path.join(gdir, name)
            if os.path.isdir(full) and os.path.exists(os.path.join(full, "index.html")):
                out.append((lesson_path(group_relpath, name), label, name))
    return out


class TagsTab(ttk.Frame):
    def __init__(self, parent, site_root_var, status_var):
        super().__init__(parent)
        self.site_root_var = site_root_var
        self.status_var = status_var
        self.tags = {}            # lesson path -> (chapter, term) as last seen on the server
        self.lessons = []         # [(path, grade label, slug)]
        self._loaded_once = False
        self._busy = False
        common.enable_clipboard_shortcuts(self)
        self._build()
        self._refresh_lessons()

    # -- UI ---------------------------------------------------------------------

    def _build(self):
        pad = {"padx": 10, "pady": 6}

        top = tk.LabelFrame(self, text="Lessons (grade 1 and grade 2, Baccalaureate)")
        top.pack(fill="both", expand=True, **pad)

        bar = tk.Frame(top)
        bar.pack(fill="x", padx=8, pady=(6, 2))
        self.untagged_var = tk.BooleanVar(value=False)
        tk.Checkbutton(bar, text="Untagged only", variable=self.untagged_var,
                       command=self._fill_list).pack(side="left")
        tk.Button(bar, text="Rescan folders", command=self._refresh_lessons).pack(side="right")
        tk.Button(bar, text="Load tags from server", command=self._load_tags).pack(side="right", padx=6)

        inner = tk.Frame(top)
        inner.pack(fill="both", expand=True, padx=8, pady=6)
        cols = ("grade", "lesson", "chapter", "term")
        self.tree = ttk.Treeview(inner, columns=cols, show="headings", height=14, selectmode="browse")
        for col, text, width in (("grade", "Grade", 70), ("lesson", "Lesson folder", 380),
                                 ("chapter", "Chapter", 70), ("term", "Term", 60)):
            self.tree.heading(col, text=text)
            self.tree.column(col, width=width, anchor="w" if col == "lesson" else "center")
        self.tree.pack(side="left", fill="both", expand=True)
        sb = tk.Scrollbar(inner, command=self.tree.yview)
        sb.pack(side="right", fill="y")
        self.tree.config(yscrollcommand=sb.set)
        self.tree.bind("<<TreeviewSelect>>", self._on_select)

        edit = tk.LabelFrame(self, text="Tag the selected lesson")
        edit.pack(fill="x", **pad)
        row = tk.Frame(edit)
        row.pack(fill="x", padx=8, pady=6)
        self.sel_var = tk.StringVar(value="(select a lesson above)")
        tk.Label(row, textvariable=self.sel_var, anchor="w", fg="gray30").pack(fill="x", pady=(0, 4))
        fields = tk.Frame(edit)
        fields.pack(fill="x", padx=8, pady=(0, 6))
        tk.Label(fields, text="Chapter:").pack(side="left")
        self.chapter_var = tk.StringVar()
        ch = tk.Entry(fields, textvariable=self.chapter_var, width=6)
        ch.pack(side="left", padx=(4, 14))
        tk.Label(fields, text="Term:").pack(side="left")
        self.term_var = tk.StringVar()
        tm = tk.Entry(fields, textvariable=self.term_var, width=6)
        tm.pack(side="left", padx=(4, 14))
        self.save_btn = tk.Button(fields, text="Save tag", command=self._save,
                                  font=("TkDefaultFont", 10, "bold"))
        self.save_btn.pack(side="left")
        for w in (ch, tm):
            w.bind("<Return>", lambda e: self._save())
        tk.Label(edit,
                 text="Whole numbers. Leave BOTH blank and Save to clear a lesson's tag. Every lesson in one "
                      "chapter (within one grade) must share the same term \u2014 the server refuses a conflict "
                      "and says so. A chapter only appears on the grade page once at least one lesson is tagged "
                      "with it.",
                 fg="gray30", font=("TkDefaultFont", 8), justify="left", wraplength=620).pack(anchor="w", padx=8, pady=(0, 6))

    # -- data -------------------------------------------------------------------

    def _refresh_lessons(self):
        """Also called by app_main when you switch into this tab: rescans the local
        folders (cheap). The first time the tab is shown it also pulls the tags."""
        site_root = self.site_root_var.get().strip()
        self.lessons = find_grade_lessons(site_root) if site_root and os.path.isdir(site_root) else []
        self._fill_list()
        if not self._loaded_once and self.lessons:
            self._loaded_once = True
            self._load_tags()

    def _tag_text(self, path):
        chapter, term = self.tags.get(path, ("", ""))
        return str(chapter), str(term)

    def _fill_list(self):
        keep = self._selected_path()
        self.tree.delete(*self.tree.get_children())
        only_untagged = self.untagged_var.get()
        for path, label, slug in self.lessons:
            chapter, term = self._tag_text(path)
            if only_untagged and (chapter or term):
                continue
            self.tree.insert("", "end", iid=path, values=(label, slug, chapter, term))
        if keep and self.tree.exists(keep):
            self.tree.selection_set(keep)

    def _selected_path(self):
        sel = self.tree.selection()
        return sel[0] if sel else ""

    def _on_select(self, _event=None):
        path = self._selected_path()
        if not path:
            return
        self.sel_var.set(path)
        chapter, term = self._tag_text(path)
        if not chapter and not term:
            # A suggestion only (from the folder name); nothing is saved until you press Save,
            # and the term is never guessed.
            m = _CHAPTER_IN_NAME.search(path.rsplit("/", 1)[-1])
            chapter = m.group(1) if m else ""
        self.chapter_var.set(chapter)
        self.term_var.set(term)

    def _bridge(self):
        cfg = common.get_drive_config(common.load_config())
        if not cfg["web_app_url"] or not cfg["admin_token"]:
            messagebox.showerror("Drive bridge not configured",
                                 "Set the Web App URL and admin token first (\"Configure...\" at the top of the window).",
                                 parent=self)
            return None
        return cfg

    def _call(self, payload, on_ok, on_err):
        """Runs one bridge call off the UI thread; on_ok(result) / on_err(message) run on it."""
        cfg = self._bridge()
        if not cfg:
            return
        payload = dict(payload, token=cfg["admin_token"])
        self._busy = True
        self.save_btn.config(state="disabled")

        def worker():
            try:
                result = drive_bridge._post_json(cfg["web_app_url"], payload)
                self.after(0, lambda: self._done(on_ok, result))
            except drive_bridge.DriveBridgeError as e:
                msg = str(e)
                self.after(0, lambda: self._done(on_err, msg))

        threading.Thread(target=worker, daemon=True).start()

    def _done(self, fn, arg):
        self._busy = False
        self.save_btn.config(state="normal")
        fn(arg)

    # -- actions ----------------------------------------------------------------

    def _load_tags(self):
        if self._busy:
            return
        self.status_var.set("Loading lesson tags\u2026")

        def ok(result):
            self.tags = {}
            for row in result.get("tags", []):
                self.tags[str(row.get("lesson", "")).strip().lower()] = (row.get("chapter", ""), row.get("term", ""))
            self._fill_list()
            self.status_var.set("Loaded {} tag(s) from the server.".format(len(self.tags)))

        def err(msg):
            self.status_var.set("Couldn't load tags.")
            messagebox.showerror("Couldn't load tags", msg, parent=self)

        self._call({"action": "admin_list_lesson_tags"}, ok, err)

    def _save(self):
        if self._busy:
            return
        path = self._selected_path()
        if not path:
            messagebox.showinfo("Pick a lesson", "Select a lesson in the list first.", parent=self)
            return
        chapter = self.chapter_var.get().strip()
        term = self.term_var.get().strip()
        if bool(chapter) != bool(term):
            messagebox.showerror("Both or neither", "Fill in BOTH chapter and term, or leave both blank to clear the tag.",
                                 parent=self)
            return
        self.status_var.set("Saving tag\u2026")

        def ok(result):
            c, t = result.get("chapter", ""), result.get("term", "")
            if c == "" and t == "":
                self.tags.pop(path, None)
                self.status_var.set("Cleared the tag on " + path)
            else:
                self.tags[path] = (c, t)
                self.status_var.set("Tagged {}: chapter {}, term {}.".format(path, c, t))
            self._fill_list()
            self._select_next_untagged(path)

        def err(msg):
            self.status_var.set("Tag not saved.")
            messagebox.showerror("Tag not saved", msg, parent=self)

        self._call({"action": "admin_set_lesson_tags", "lesson": path, "chapter": chapter, "term": term}, ok, err)

    def _select_next_untagged(self, after_path):
        """With 'Untagged only' on, the saved row disappears \u2014 move to the next one so a first
        pass through the lessons is just: type, Enter, type, Enter."""
        if not self.untagged_var.get():
            if self.tree.exists(after_path):
                self.tree.selection_set(after_path)
            return
        rows = [p for p, _l, _s in self.lessons if self.tree.exists(p)]
        if rows:
            self.tree.selection_set(rows[0])
            self.tree.see(rows[0])
        else:
            self.sel_var.set("(nothing left untagged)")
            self.chapter_var.set("")
            self.term_var.set("")
