#!/usr/bin/env python3
"""
quiz_tab.py — Tab 1: Quiz & Lesson Maker.

Feature set is unchanged from the original single-file quiz_maker.py:
add/edit/remove questions, bulk paste, save/load drafts, generate
index.html + quiz.html (+ assignment.html) for a lesson and upsert the
subject's index.html lesson-card list.

The only functional addition on the generated *site* side (not this
file) is that assets_templates/quiz.js now remembers a student's last
attempt per lesson in localStorage and shows it on re-entry — see that
file's header comment. Nothing here needs to change to support that.
"""

import copy
import json
import os
import re
import tkinter as tk
import webbrowser
from tkinter import ttk, messagebox, filedialog

from modules import common
from modules.common import (
    GRADED_BULK_HELP,
    parse_bulk_graded_questions,
    MCQItemDialog,
    TrueFalseItemDialog,
    MatchItemDialog,
    GradedBulkDialog,
)

UNDO_LIMIT = 50


class DeleteConfirmDialog(tk.Toplevel):
    def __init__(self, parent, subject_slug, lesson_slug):
        super().__init__(parent)
        self.title("Delete lesson?")
        self.confirmed = False
        common.fit_geometry(self, 460, 280, min_w=360, min_h=260)
        self.resizable(True, True)

        pad = {"padx": 14, "pady": 6}
        warn = ("This removes:\n\n"
                "  {}/{}/\n"
                "  (index.html, quiz.html, assignment.html, attachments.json)\n\n"
                "and its card from {}/index.html.\n\n"
                "It's moved to a _deleted-lessons/ folder next to your site "
                "(not published, not permanently erased) — not hard-deleted.\n"
                "Anything already uploaded to Drive is not touched.").format(
                    subject_slug, lesson_slug, subject_slug)
        tk.Label(self, text=warn, justify="left", anchor="w", wraplength=420).pack(fill="x", **pad)

        tk.Label(self, text='Type the lesson name ("{}") to confirm:'.format(lesson_slug),
                 anchor="w").pack(fill="x", padx=14)
        self.confirm_var = tk.StringVar()
        entry = tk.Entry(self, textvariable=self.confirm_var)
        entry.pack(fill="x", padx=14, pady=(2, 10))
        entry.focus_set()

        self.lesson_slug = lesson_slug
        btn_row = tk.Frame(self)
        btn_row.pack(fill="x", pady=8, padx=14)
        self.delete_btn = tk.Button(btn_row, text="Delete", command=self._on_confirm,
                                     state="disabled", fg="#8a1f1f")
        self.delete_btn.pack(side="right")
        tk.Button(btn_row, text="Cancel", command=self.destroy).pack(side="right", padx=6)

        self.confirm_var.trace_add("write", self._on_type)

        common.lock_min_width_to_content(self)
        self.transient(parent)
        self.grab_set()

    def _on_type(self, *_args):
        matches = self.confirm_var.get().strip() == self.lesson_slug
        self.delete_btn.config(state=("normal" if matches else "disabled"))

    def _on_confirm(self):
        self.confirmed = True
        self.destroy()


class RecoverDialog(tk.Toplevel):
    def __init__(self, parent, site_root):
        super().__init__(parent)
        self.title("Recover a deleted lesson")
        self.result = None
        common.fit_geometry(self, 560, 420, min_w=420, min_h=320)
        self.resizable(True, True)

        entries = common.list_deleted_lessons(site_root)
        self.entries = entries

        if not entries:
            tk.Label(self, text="Nothing in _deleted-lessons/ — trash is empty.",
                     anchor="w").pack(fill="x", padx=14, pady=20)
            tk.Button(self, text="Close", command=self.destroy).pack(pady=10)
            self.transient(parent)
            self.grab_set()
            return

        tk.Label(self, text="Select a deleted lesson to move back into the site:",
                 anchor="w").pack(fill="x", padx=14, pady=(12, 4))

        list_frame = tk.Frame(self)
        list_frame.pack(fill="both", expand=True, padx=14, pady=4)
        self.listbox = tk.Listbox(list_frame)
        self.listbox.pack(side="left", fill="both", expand=True)
        scrollbar = tk.Scrollbar(list_frame, command=self.listbox.yview)
        scrollbar.pack(side="right", fill="y")
        self.listbox.config(yscrollcommand=scrollbar.set)

        for e in entries:
            self.listbox.insert("end", "{}/{}  —  deleted {}".format(
                e["subject"], e["lesson"], e["deleted_at"] or "unknown time"))

        btn_row = tk.Frame(self)
        btn_row.pack(fill="x", padx=14, pady=10)
        tk.Button(btn_row, text="Recover", command=self._on_recover).pack(side="right")
        tk.Button(btn_row, text="Cancel", command=self.destroy).pack(side="right", padx=6)

        common.lock_min_width_to_content(self)
        self.transient(parent)
        self.grab_set()

    def _on_recover(self):
        sel = self.listbox.curselection()
        if not sel:
            messagebox.showinfo("No selection", "Select a lesson to recover.", parent=self)
            return
        self.result = self.entries[sel[0]]["name"]
        self.destroy()


class EmptyTrashDialog(tk.Toplevel):
    def __init__(self, parent, site_root):
        super().__init__(parent)
        self.title("Empty trash")
        self.confirmed = False
        common.fit_geometry(self, 440, 220, min_w=360, min_h=200)

        entries = common.list_deleted_lessons(site_root)
        msg = ("{} lesson(s) currently in _deleted-lessons/.\n\n"
               "This PERMANENTLY deletes them — unlike the lesson delete "
               "above, there is no recovery after this.").format(len(entries))
        tk.Label(self, text=msg, justify="left", anchor="w", wraplength=400).pack(
            fill="x", padx=14, pady=14)

        btn_row = tk.Frame(self)
        btn_row.pack(fill="x", padx=14, pady=10)
        tk.Button(btn_row, text="Empty trash permanently", command=self._on_confirm,
                  fg="#8a1f1f", state=("normal" if entries else "disabled")).pack(side="right")
        tk.Button(btn_row, text="Cancel", command=self.destroy).pack(side="right", padx=6)

        common.lock_min_width_to_content(self)
        self.transient(parent)
        self.grab_set()

    def _on_confirm(self):
        self.confirmed = True
        self.destroy()


class QuizTab(ttk.Frame):
    def __init__(self, parent, site_root_var, status_var, on_lessons_changed=None):
        super().__init__(parent)
        self.site_root_var = site_root_var
        self.status_var = status_var
        self.on_lessons_changed = on_lessons_changed
        self.questions = []
        self._undo_stack = []
        self._redo_stack = []
        self._group_map = {}
        # Set by _load_lesson_for_edit() — {"subject_slug", "group_relpath",
        # "lesson_slug"} of the lesson currently loaded into the form, so
        # _generate() can tell "save this edit in place" apart from
        # "this happens to reuse an existing folder name". Cleared by
        # _new_lesson() or whenever the form no longer matches it.
        self._editing = None
        self._build_form()
        self._bind_undo_redo()

    def _build_form(self):
        pad = {"padx": 10, "pady": 6}

        info_frame = tk.LabelFrame(self, text="Lesson")
        info_frame.pack(fill="x", **pad)

        row1 = tk.Frame(info_frame)
        row1.pack(fill="x", padx=8, pady=4)
        tk.Label(row1, text="Subject:", width=14, anchor="w").pack(side="left")
        self.subject_var = tk.StringVar(value=common.SUBJECTS[0][1])
        subject_combo = ttk.Combobox(row1, textvariable=self.subject_var, state="readonly",
                                      values=[label for _, label in common.SUBJECTS])
        subject_combo.pack(side="left", fill="x", expand=True)
        subject_combo.bind("<<ComboboxSelected>>", lambda e: self._refresh_groups())

        row1b = tk.Frame(info_frame)
        row1b.pack(fill="x", padx=8, pady=4)
        tk.Label(row1b, text="Group:", width=14, anchor="w").pack(side="left")
        self.group_var = tk.StringVar()
        self.group_combo = ttk.Combobox(row1b, textvariable=self.group_var, state="readonly", values=[])
        self.group_combo.pack(side="left", fill="x", expand=True)
        self.group_combo.bind("<<ComboboxSelected>>", lambda e: self._refresh_lessons())
        tk.Label(info_frame,
                 text="Where the lesson lives inside the subject — e.g. \u201c(subject root)\u201d for flat "
                      "subjects, or a nested folder like \u201cBaccalaureate / Grade 1 Secondary\u201d.",
                 fg="gray30", font=("TkDefaultFont", 8)).pack(anchor="w", padx=8, pady=(0, 6))

        row2 = tk.Frame(info_frame)
        row2.pack(fill="x", padx=8, pady=4)
        tk.Label(row2, text="Lesson name:", width=14, anchor="w").pack(side="left")
        self.lesson_name_var = tk.StringVar()
        tk.Entry(row2, textvariable=self.lesson_name_var).pack(side="left", fill="x", expand=True)

        row3 = tk.Frame(info_frame)
        row3.pack(fill="x", padx=8, pady=4)
        tk.Label(row3, text="Description:", width=14, anchor="w").pack(side="left")
        self.lesson_desc_var = tk.StringVar()
        tk.Entry(row3, textvariable=self.lesson_desc_var).pack(side="left", fill="x", expand=True)

        row4 = tk.Frame(info_frame)
        row4.pack(fill="x", padx=8, pady=4)
        tk.Label(row4, text="Video embed URL:", width=14, anchor="w").pack(side="left")
        self.video_url_var = tk.StringVar()
        tk.Entry(row4, textvariable=self.video_url_var).pack(side="left", fill="x", expand=True)
        tk.Label(info_frame, text="Leave blank to keep a placeholder box (YouTube embed URL, e.g. https://www.youtube.com/embed/VIDEO_ID)",
                 fg="gray30", font=("TkDefaultFont", 8)).pack(anchor="w", padx=8, pady=(0, 6))

        assign_frame = tk.LabelFrame(self, text="Assignment")
        assign_frame.pack(fill="x", **pad)
        self.include_assignment_var = tk.BooleanVar(value=True)
        tk.Checkbutton(assign_frame, text="Include an assignment page for this lesson",
                        variable=self.include_assignment_var).pack(anchor="w", padx=8, pady=4)
        row5 = tk.Frame(assign_frame)
        row5.pack(fill="x", padx=8, pady=4)
        tk.Label(row5, text="Prompt text:", width=14, anchor="w").pack(side="left")
        self.assign_prompt_var = tk.StringVar(value="Paste your completed assignment below.")
        tk.Entry(row5, textvariable=self.assign_prompt_var).pack(side="left", fill="x", expand=True)
        tk.Label(assign_frame, text="This creates a basic text-paste assignment page. For URL/file submission "
                                     "modes, use the Assignment Maker tab after generating this lesson.",
                 fg="gray30", font=("TkDefaultFont", 8)).pack(anchor="w", padx=8, pady=(0, 6))

        del_frame = tk.LabelFrame(self, text="Existing lessons")
        del_frame.pack(fill="x", **pad)
        row_del = tk.Frame(del_frame)
        row_del.pack(fill="x", padx=8, pady=4)
        tk.Label(row_del, text="Lesson:", width=14, anchor="w").pack(side="left")
        self.delete_lesson_var = tk.StringVar()
        self.delete_lesson_combo = ttk.Combobox(row_del, textvariable=self.delete_lesson_var,
                                                 state="readonly", values=[])
        self.delete_lesson_combo.pack(side="left", fill="x", expand=True)
        tk.Button(row_del, text="Refresh", command=self._refresh_lessons).pack(side="left", padx=6)

        btn_row_del = tk.Frame(del_frame)
        btn_row_del.pack(fill="x", padx=8, pady=(0, 4))
        tk.Button(btn_row_del, text="Load for editing", command=self._load_lesson_for_edit,
                  font=("TkDefaultFont", 9, "bold")).pack(side="left")
        tk.Button(btn_row_del, text="Preview in browser", command=self._preview_lesson).pack(side="left", padx=6)
        tk.Button(btn_row_del, text="Delete lesson...", command=self._delete_lesson,
                  fg="#8a1f1f").pack(side="left")
        tk.Button(btn_row_del, text="Recover deleted lesson...", command=self._recover_lesson).pack(side="left", padx=6)
        tk.Button(btn_row_del, text="Empty trash...", command=self._empty_trash,
                  fg="#8a1f1f").pack(side="right")
        tk.Button(btn_row_del, text="New lesson / clear form", command=self._new_lesson).pack(side="right", padx=6)
        tk.Label(del_frame,
                 text="Preview/Load/Delete use the Subject selected above. \u201cLoad for editing\u201d pulls that "
                      "lesson's questions, chapters, name, description, video and assignment prompt back into "
                      "the form below \u2014 change what you need, then Generate lesson files to save it in place "
                      "(existing files are overwritten, its listing card is updated, nothing is duplicated). "
                      "Deleted lessons move to _deleted-lessons/ next to your site (not published, recoverable) "
                      "until emptied.",
                 fg="gray30", font=("TkDefaultFont", 8), justify="left", wraplength=640).pack(anchor="w", padx=8, pady=(0, 6))

        q_frame = tk.LabelFrame(self, text="Questions")
        q_frame.pack(fill="both", expand=True, **pad)

        chapter_row = tk.Frame(q_frame)
        chapter_row.pack(fill="x", padx=8, pady=(6, 0))
        tk.Label(chapter_row, text="Chapter:", width=14, anchor="w").pack(side="left")
        self.chapter_var = tk.StringVar(value="1")
        self.chapter_combo = ttk.Combobox(chapter_row, textvariable=self.chapter_var, state="readonly",
                                           values=[str(i) for i in range(1, 21)], width=6)
        self.chapter_combo.pack(side="left")
        tk.Label(chapter_row,
                 text="Applies to new questions added below (bulk paste can override per-block with \"Ch: N\").",
                 fg="gray30", font=("TkDefaultFont", 8)).pack(side="left", padx=8)

        btn_row = tk.Frame(q_frame)
        btn_row.pack(fill="x", padx=8, pady=6)
        tk.Button(btn_row, text="+ Multiple choice", command=self._add_mcq).pack(side="left")
        tk.Button(btn_row, text="+ True/False", command=self._add_truefalse).pack(side="left", padx=6)
        tk.Button(btn_row, text="+ Matching", command=self._add_match).pack(side="left")
        tk.Button(btn_row, text="+ Bulk paste...", command=self._bulk_add).pack(side="left", padx=6)
        tk.Button(btn_row, text="Edit selected", command=self._edit_question).pack(side="left", padx=6)
        tk.Button(btn_row, text="Remove selected", command=self._remove_question).pack(side="left")
        tk.Button(btn_row, text="Save draft...", command=self._save_draft).pack(side="right", padx=6)
        tk.Button(btn_row, text="Load draft...", command=self._load_draft).pack(side="right")

        list_frame = tk.Frame(q_frame)
        list_frame.pack(fill="both", expand=True, padx=8, pady=4)
        self.q_listbox = tk.Listbox(list_frame)
        self.q_listbox.pack(side="left", fill="both", expand=True)
        scrollbar = tk.Scrollbar(list_frame, command=self.q_listbox.yview)
        scrollbar.pack(side="right", fill="y")
        self.q_listbox.config(yscrollcommand=scrollbar.set)
        self.q_listbox.bind("<Double-Button-1>", lambda e: self._edit_question())

        gen_row = tk.Frame(self)
        gen_row.pack(fill="x", padx=10, pady=12)
        tk.Button(gen_row, text="Generate lesson files", command=self._generate,
                  font=("TkDefaultFont", 10, "bold"), height=2).pack(fill="x")

        self._refresh_groups()

    # -- groups & delete lesson --------------------------------------------

    def _refresh_groups(self):
        site_root = self.site_root_var.get().strip()
        subject_slug = self._subject_slug()
        relpaths = common.list_lesson_groups(site_root, subject_slug) if site_root else []
        if not relpaths:
            relpaths = [""]
        self._group_map = {common.group_display_name(rp): rp for rp in relpaths}
        display_values = list(self._group_map.keys())
        self.group_combo["values"] = display_values
        if display_values and self.group_var.get() not in display_values:
            self.group_var.set(display_values[0])
        elif not display_values:
            self.group_var.set("")
        self._refresh_lessons()

    def _group_relpath(self):
        return self._group_map.get(self.group_var.get(), "")

    def _refresh_lessons(self):
        site_root = self.site_root_var.get().strip()
        subject_slug = self._subject_slug()
        group_relpath = self._group_relpath()
        lessons = common.list_existing_lessons(site_root, subject_slug, group_relpath) if site_root else []
        self.delete_lesson_combo["values"] = lessons
        if lessons and self.delete_lesson_var.get() not in lessons:
            self.delete_lesson_var.set(lessons[0])
        elif not lessons:
            self.delete_lesson_var.set("")

    def _delete_lesson(self):
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site root folder first (top of the window).")
            return
        lesson_slug = self.delete_lesson_var.get().strip()
        if not lesson_slug:
            messagebox.showinfo("No lesson selected", "Pick a lesson to delete first.")
            return
        subject_slug = self._subject_slug()
        group_relpath = self._group_relpath()

        dlg = DeleteConfirmDialog(self, subject_slug, lesson_slug)
        self.wait_window(dlg)
        if not dlg.confirmed:
            return

        try:
            moved_to = common.delete_lesson(site_root, subject_slug, group_relpath, lesson_slug)
        except FileNotFoundError:
            messagebox.showerror("Not found", "That lesson folder no longer exists.")
            self._refresh_lessons()
            return
        except OSError as e:
            messagebox.showerror("Delete failed", "Couldn't move the lesson folder:\n{}".format(e))
            return

        self._refresh_lessons()
        self.status_var.set("Deleted lesson {}/{}/{} — moved to {}".format(
            subject_slug, group_relpath, lesson_slug, moved_to))
        messagebox.showinfo("Deleted", "Removed {}/{}/{} from the site.\n\nMoved to:\n{}".format(
            subject_slug, group_relpath, lesson_slug, moved_to))
        if self.on_lessons_changed:
            self.on_lessons_changed()

    def _preview_lesson(self):
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site root folder first (top of the window).")
            return
        lesson_slug = self.delete_lesson_var.get().strip()
        if not lesson_slug:
            messagebox.showinfo("No lesson selected", "Pick a lesson to preview first.")
            return
        subject_slug = self._subject_slug()
        group_relpath = self._group_relpath()
        lesson_dir = os.path.join(common.group_dir(site_root, subject_slug, group_relpath), lesson_slug)
        if not os.path.isdir(lesson_dir):
            messagebox.showerror("Not found", "That lesson folder doesn't exist.")
            self._refresh_lessons()
            return

        try:
            base_url = common.start_preview_server(site_root)
        except OSError as e:
            messagebox.showerror("Preview failed", "Couldn't start the local preview server:\n{}".format(e))
            return

        url = "{}/{}/".format(base_url, common.lesson_url_path(subject_slug, group_relpath, lesson_slug))
        webbrowser.open(url)
        self.status_var.set("Previewing at " + url + " (served locally so /assets/... links resolve correctly)")

    def _load_lesson_for_edit(self):
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site root folder first (top of the window).")
            return
        lesson_slug = self.delete_lesson_var.get().strip()
        if not lesson_slug:
            messagebox.showinfo("No lesson selected", "Pick a lesson to load first.")
            return
        subject_slug = self._subject_slug()
        group_relpath = self._group_relpath()
        lesson_dir = os.path.join(common.group_dir(site_root, subject_slug, group_relpath), lesson_slug)

        quiz_path = os.path.join(lesson_dir, "quiz.html")
        if not os.path.isfile(quiz_path):
            messagebox.showerror("No quiz.html found",
                                  "{}/quiz.html doesn't exist \u2014 this lesson may have been created "
                                  "outside this tool, or its files were hand-edited.".format(lesson_slug))
            return

        with open(quiz_path, "r", encoding="utf-8") as f:
            quiz_content = f.read()
        json_match = re.search(r'<script type="application/json" id="quiz-data">\s*(.*?)\s*</script>',
                                quiz_content, re.DOTALL)
        if not json_match:
            messagebox.showerror("Couldn't read quiz data",
                                  "quiz.html doesn't have the expected embedded JSON block \u2014 it may use an "
                                  "older template or have been hand-edited.")
            return
        try:
            quiz_json = json.loads(json_match.group(1))
        except ValueError as e:
            messagebox.showerror("Couldn't parse quiz data", "quiz.html's embedded JSON is invalid:\n{}".format(e))
            return

        questions = quiz_json.get("questions", [])
        if not isinstance(questions, list):
            questions = []

        if self.questions or self.lesson_name_var.get().strip():
            if not messagebox.askyesno(
                    "Replace current form?",
                    "This replaces the lesson name, description, video, assignment prompt, and question "
                    "list currently in the form below with {}'s saved content.\n\n"
                    "Anything you've typed here that hasn't been generated yet will be lost. Continue?".format(
                        lesson_slug)):
                return

        # -- description + video, from index.html (best-effort; quiz.html
        # alone doesn't carry these) --------------------------------------
        lesson_desc = ""
        video_url = ""
        index_path = os.path.join(lesson_dir, "index.html")
        if os.path.isfile(index_path):
            with open(index_path, "r", encoding="utf-8") as f:
                index_content = f.read()
            desc_match = re.search(r'<h1>.*?</h1>\s*<p class="lede">(.*?)</p>', index_content, re.DOTALL)
            if desc_match:
                lesson_desc = desc_match.group(1).strip()
            slot_match = re.search(r'<div class="media-slot">\s*(.*?)\s*</div>', index_content, re.DOTALL)
            if slot_match:
                iframe_match = re.search(r'<iframe src="([^"]+)"', slot_match.group(1))
                if iframe_match:
                    video_url = iframe_match.group(1)

        # -- assignment prompt + whether one exists, from assignment.html --
        # (submission mode itself is left alone here — see _generate(),
        # which preserves it automatically when this lesson is saved)
        include_assignment = False
        assign_prompt = "Paste your completed assignment below."
        assignment_path = os.path.join(lesson_dir, "assignment.html")
        if os.path.isfile(assignment_path):
            include_assignment = True
            with open(assignment_path, "r", encoding="utf-8") as f:
                assignment_content = f.read()
            prompt_match = re.search(r'<p class="lede">(.*?)</p>', assignment_content, re.DOTALL)
            if prompt_match:
                assign_prompt = prompt_match.group(1).strip()

        self._snapshot()
        self.lesson_name_var.set(quiz_json.get("title") or lesson_slug.replace("-", " ").title())
        self.lesson_desc_var.set(lesson_desc)
        self.video_url_var.set(video_url)
        self.include_assignment_var.set(include_assignment)
        self.assign_prompt_var.set(assign_prompt)
        self.questions = copy.deepcopy(questions)
        self._refresh_listbox()

        self._editing = {
            "subject_slug": subject_slug,
            "group_relpath": group_relpath,
            "lesson_slug": lesson_slug,
        }
        self.status_var.set(
            "Loaded {} for editing ({} question(s)). Make your changes, then Generate lesson files to "
            "save them in place.".format(lesson_slug, len(self.questions)))

    def _new_lesson(self):
        if self.questions or self.lesson_name_var.get().strip():
            if not messagebox.askyesno("Clear form?",
                                        "This clears the lesson name, description, video, assignment prompt, "
                                        "and all questions currently in the form. Continue?"):
                return
        self._snapshot()
        self.lesson_name_var.set("")
        self.lesson_desc_var.set("")
        self.video_url_var.set("")
        self.include_assignment_var.set(True)
        self.assign_prompt_var.set("Paste your completed assignment below.")
        self.questions = []
        self._refresh_listbox()
        self._editing = None
        self.status_var.set("Form cleared \u2014 ready for a new lesson.")

    def _recover_lesson(self):
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site root folder first (top of the window).")
            return

        dlg = RecoverDialog(self, site_root)
        self.wait_window(dlg)
        if not dlg.result:
            return

        try:
            subject_slug, lesson_slug = common.recover_lesson(site_root, dlg.result)
        except FileExistsError as e:
            messagebox.showerror("Already exists", "A lesson already exists at that location:\n{}\n\n"
                                                     "Delete or rename it first.".format(e))
            return
        except (FileNotFoundError, ValueError, OSError) as e:
            messagebox.showerror("Recover failed", str(e))
            return

        self._refresh_lessons()
        self.status_var.set("Recovered {}/{} from trash.".format(subject_slug, lesson_slug))
        messagebox.showinfo("Recovered", "{}/{} is back on the site.".format(subject_slug, lesson_slug))
        if self.on_lessons_changed:
            self.on_lessons_changed()

    def _empty_trash(self):
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site root folder first (top of the window).")
            return

        dlg = EmptyTrashDialog(self, site_root)
        self.wait_window(dlg)
        if not dlg.confirmed:
            return

        removed = common.purge_deleted_lessons(site_root)
        self.status_var.set("Emptied trash — permanently removed {} lesson(s).".format(len(removed)))
        messagebox.showinfo("Trash emptied",
                             "Permanently removed {} lesson(s) from _deleted-lessons/.".format(len(removed)))

    # -- question list --------------------------------------------------

    _TYPE_LABELS = {"mcq": "MCQ", "truefalse": "T/F", "match": "Match"}

    def _current_chapter(self):
        try:
            return int(self.chapter_var.get())
        except (AttributeError, ValueError):
            return 1

    def _chapter_choices(self):
        return list(range(1, 21))

    @staticmethod
    def _normalize_legacy(q):
        """Old quizzes (generated before graded question types existed)
        store {q, options, correct: int, explain, chapter} with no "type"
        key. Editing one needs it converted to the unified mcq shape the
        shared MCQItemDialog understands — saving it back then upgrades
        that question to the new shape permanently, in place, one at a
        time as each is touched."""
        if "type" in q:
            return q
        return {
            "type": "mcq",
            "prompt": q.get("q", ""),
            "options": q.get("options", ["", ""]),
            "correct": [q.get("correct", 0)],
            "explain": q.get("explain", ""),
            "chapter": q.get("chapter", 1),
        }

    def _refresh_listbox(self):
        self.q_listbox.delete(0, "end")
        for i, q in enumerate(self.questions):
            qtype = q.get("type", "mcq")
            text = q.get("prompt", q.get("q", ""))
            preview = text[:60].replace("\n", " ")
            chapter = q.get("chapter")
            ch_label = "Ch{} ".format(chapter) if chapter is not None else ""
            self.q_listbox.insert("end", "{:>2}. {}[{}] {}".format(
                i + 1, ch_label, self._TYPE_LABELS.get(qtype, "?"), preview))

    def _add_mcq(self):
        dlg = MCQItemDialog(self, chapter_choices=self._chapter_choices(), default_chapter=self._current_chapter())
        self.wait_window(dlg)
        if dlg.result:
            self._snapshot()
            self.questions.append(dlg.result)
            self._refresh_listbox()

    def _add_truefalse(self):
        dlg = TrueFalseItemDialog(self, chapter_choices=self._chapter_choices(), default_chapter=self._current_chapter())
        self.wait_window(dlg)
        if dlg.result:
            self._snapshot()
            self.questions.append(dlg.result)
            self._refresh_listbox()

    def _add_match(self):
        dlg = MatchItemDialog(self, chapter_choices=self._chapter_choices(), default_chapter=self._current_chapter())
        self.wait_window(dlg)
        if dlg.result:
            self._snapshot()
            self.questions.append(dlg.result)
            self._refresh_listbox()

    def _bulk_add(self):
        dlg = GradedBulkDialog(self, current_chapter=self._current_chapter())
        self.wait_window(dlg)
        if dlg.result:
            self._snapshot()
            self.questions.extend(dlg.result)
            self._refresh_listbox()
            self.status_var.set("Added {} question(s) from bulk paste.".format(len(dlg.result)))

    def _edit_question(self):
        sel = self.q_listbox.curselection()
        if not sel:
            messagebox.showinfo("No selection", "Select a question to edit.")
            return
        idx = sel[0]
        existing = self._normalize_legacy(self.questions[idx])
        dialog_cls = {"mcq": MCQItemDialog, "truefalse": TrueFalseItemDialog, "match": MatchItemDialog}[existing["type"]]
        dlg = dialog_cls(self, existing=existing, chapter_choices=self._chapter_choices(),
                          default_chapter=self._current_chapter())
        self.wait_window(dlg)
        if dlg.result:
            self._snapshot()
            self.questions[idx] = dlg.result
            self._refresh_listbox()

    def _remove_question(self):
        sel = self.q_listbox.curselection()
        if not sel:
            messagebox.showinfo("No selection", "Select a question to remove.")
            return
        idx = sel[0]
        self._snapshot()
        del self.questions[idx]
        self._refresh_listbox()

    # -- undo / redo for the question list --------------------------------
    # Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) undo/redo add/edit/remove/bulk-paste
    # changes to the question list. The Text boxes inside the Question and
    # Bulk-paste dialogs have their own native undo (undo=True) — this only
    # takes over when the focus isn't in a Text/Entry field, so the two
    # never fight over the same keystroke.

    def _bind_undo_redo(self):
        top = self.winfo_toplevel()
        top.bind_all("<Control-z>", self._handle_undo)
        top.bind_all("<Control-y>", self._handle_redo)
        top.bind_all("<Control-Shift-Z>", self._handle_redo)
        top.bind_all("<Control-Shift-z>", self._handle_redo)

    def _is_active_tab(self):
        try:
            return self.master.select() == str(self)
        except Exception:
            return False

    def _snapshot(self):
        self._undo_stack.append(copy.deepcopy(self.questions))
        if len(self._undo_stack) > UNDO_LIMIT:
            self._undo_stack.pop(0)
        self._redo_stack.clear()

    def _handle_undo(self, event=None):
        if not self._is_active_tab():
            return None
        focus = self.focus_get()
        if isinstance(focus, (tk.Text, tk.Entry, ttk.Entry, ttk.Combobox, tk.Spinbox)):
            return None  # let the focused widget's own native undo handle it
        if not self._undo_stack:
            self.status_var.set("Nothing to undo.")
            return "break"
        self._redo_stack.append(copy.deepcopy(self.questions))
        self.questions = self._undo_stack.pop()
        self._refresh_listbox()
        self.status_var.set("Undid last question-list change.")
        return "break"

    def _handle_redo(self, event=None):
        if not self._is_active_tab():
            return None
        focus = self.focus_get()
        if isinstance(focus, (tk.Text, tk.Entry, ttk.Entry, ttk.Combobox, tk.Spinbox)):
            return None
        if not self._redo_stack:
            self.status_var.set("Nothing to redo.")
            return "break"
        self._undo_stack.append(copy.deepcopy(self.questions))
        self.questions = self._redo_stack.pop()
        self._refresh_listbox()
        self.status_var.set("Redid question-list change.")
        return "break"

    # -- draft save/load --------------------------------------------------

    def _current_state(self):
        return {
            "subject": self.subject_var.get(),
            "lesson_name": self.lesson_name_var.get(),
            "lesson_desc": self.lesson_desc_var.get(),
            "video_url": self.video_url_var.get(),
            "include_assignment": self.include_assignment_var.get(),
            "assign_prompt": self.assign_prompt_var.get(),
            "questions": self.questions,
        }

    def _save_draft(self):
        path = filedialog.asksaveasfilename(defaultextension=".json",
                                             filetypes=[("JSON draft", "*.json")])
        if not path:
            return
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self._current_state(), f, indent=2)
        self.status_var.set("Draft saved to " + path)

    def _load_draft(self):
        path = filedialog.askopenfilename(filetypes=[("JSON draft", "*.json")])
        if not path:
            return
        with open(path, "r", encoding="utf-8") as f:
            state = json.load(f)
        self.subject_var.set(state.get("subject", common.SUBJECTS[0][1]))
        self.lesson_name_var.set(state.get("lesson_name", ""))
        self.lesson_desc_var.set(state.get("lesson_desc", ""))
        self.video_url_var.set(state.get("video_url", ""))
        self.include_assignment_var.set(state.get("include_assignment", True))
        self.assign_prompt_var.set(state.get("assign_prompt", ""))
        self._snapshot()
        self.questions = state.get("questions", [])
        self._refresh_listbox()
        self.status_var.set("Draft loaded from " + path)

    # -- generation ---------------------------------------------------------

    def _subject_slug(self):
        label = self.subject_var.get()
        for slug, name in common.SUBJECTS:
            if name == label:
                return slug
        return common.slugify(label)

    def _generate(self):
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site root folder first (top of the window).")
            return

        lesson_name = self.lesson_name_var.get().strip()
        if not lesson_name:
            messagebox.showerror("Missing lesson name", "Enter a lesson name.")
            return

        if not self.questions:
            messagebox.showerror("No questions", "Add at least one question before generating.")
            return

        subject_slug = self._subject_slug()
        subject_title = self.subject_var.get()
        group_relpath = self._group_relpath()
        lesson_slug = common.slugify(lesson_name)
        if not lesson_slug:
            messagebox.showerror("Invalid lesson name", "Lesson name must contain at least one letter or number.")
            return

        lesson_dir = os.path.join(common.group_dir(site_root, subject_slug, group_relpath), lesson_slug)
        location_label = common.lesson_url_path(subject_slug, group_relpath, lesson_slug)
        editing_same_lesson = (self._editing == {
            "subject_slug": subject_slug, "group_relpath": group_relpath, "lesson_slug": lesson_slug,
        })
        if os.path.exists(lesson_dir) and not editing_same_lesson:
            if not messagebox.askyesno("Folder exists",
                                        "{}  already exists. Overwrite its files?".format(location_label)):
                return
        os.makedirs(lesson_dir, exist_ok=True)
        common.write_lesson_stylesheets(lesson_dir)

        include_assignment = self.include_assignment_var.get()

        # Determined once, used both when (re)writing assignment.html below
        # and for the lesson-card link's description text further down.
        submit_mode = "text"
        if include_assignment:
            assignment_path = os.path.join(lesson_dir, "assignment.html")
            if os.path.isfile(assignment_path):
                with open(assignment_path, "r", encoding="utf-8") as f:
                    existing_assignment = f.read()
                mode_match = re.search(r'data-mode="([a-z]+)"', existing_assignment)
                if mode_match:
                    submit_mode = mode_match.group(1)

        # ---- quiz.html ----
        quiz_json = {
            "title": lesson_name,
            "subject": subject_slug,
            "lesson": lesson_slug,
            "questions": self.questions,
        }
        track_class = common.track_class_for_group(subject_slug, group_relpath)

        quiz_html = common.load_template("quiz.html")
        quiz_html = (quiz_html
                     .replace("{{SUBJECT_SLUG}}", subject_slug)
                     .replace("{{LESSON_SLUG}}", lesson_slug)
                     .replace("{{LESSON_TITLE}}", lesson_name)
                     .replace("{{QUESTION_COUNT}}", str(len(self.questions)))
                     .replace("{{QUIZ_JSON}}", json.dumps(quiz_json, indent=2))
                     .replace("{{TRACK_CLASS}}", track_class)
                     .replace("{{LESSON_URL_PATH}}", location_label))
        with open(os.path.join(lesson_dir, "quiz.html"), "w", encoding="utf-8") as f:
            f.write(quiz_html)

        # ---- assignment.html — preserve an already-configured submission
        #      mode (set via the Assignment Maker tab) instead of resetting
        #      it back to plain text every time the quiz is regenerated.
        #      Brand-new lessons still default to "text" (submit_mode
        #      computed above, next to include_assignment).
        if include_assignment:
            assignment_html = common.load_template("assignment.html")
            assignment_html = (assignment_html
                                .replace("{{SUBJECT_SLUG}}", subject_slug)
                                .replace("{{LESSON_SLUG}}", lesson_slug)
                                .replace("{{LESSON_TITLE}}", lesson_name)
                                .replace("{{SUBMIT_MODE}}", submit_mode)
                                .replace("{{ASSIGN_PROMPT}}", self.assign_prompt_var.get().strip() or
                                         "Paste your completed assignment below.")
                                .replace("{{TRACK_CLASS}}", track_class)
                     .replace("{{LESSON_URL_PATH}}", location_label))
            with open(os.path.join(lesson_dir, "assignment.html"), "w", encoding="utf-8") as f:
                f.write(assignment_html)

        # ---- lesson index.html ----
        video_url = self.video_url_var.get().strip()
        if video_url:
            video_block = '<iframe src="{}" title="{}" allowfullscreen></iframe>'.format(video_url, lesson_name)
        else:
            video_block = "Video placeholder &mdash; add a YouTube embed URL to replace this box."

        if include_assignment:
            mode_desc = {"text": "Paste your work as text", "url": "Submit a link",
                         "file": "Upload a file", "both": "Submit a link or file"}.get(
                submit_mode, "Paste your work as text")
            assign_link_block = (
                '      <a class="lesson-link frame" href="/{}/assignment.html">\n'
                '        <div class="ll-title">Assignment</div>\n'
                '        <div class="ll-desc">{}</div>\n'
                '        <span class="ll-go">Submit</span>\n'
                '      </a>'
            ).format(location_label, mode_desc)
        else:
            assign_link_block = ""

        lesson_index_html = common.load_template("lesson_index.html")
        lesson_index_html = (lesson_index_html
                              .replace("{{SUBJECT_SLUG}}", subject_slug)
                              .replace("{{SUBJECT_TITLE}}", subject_title)
                              .replace("{{LESSON_SLUG}}", lesson_slug)
                              .replace("{{LESSON_TITLE}}", lesson_name)
                              .replace("{{LESSON_DESC}}", self.lesson_desc_var.get().strip())
                              .replace("{{VIDEO_BLOCK}}", video_block)
                              .replace("{{QUESTION_COUNT}}", str(len(self.questions)))
                              .replace("{{ASSIGNMENT_LINK_BLOCK}}", assign_link_block)
                              .replace("{{TRACK_CLASS}}", track_class)
                     .replace("{{LESSON_URL_PATH}}", location_label))
        with open(os.path.join(lesson_dir, "index.html"), "w", encoding="utf-8") as f:
            f.write(lesson_index_html)

        # ---- attachments.json (empty manifest; Attachment Maker tab fills it in) ----
        attachments_path = os.path.join(lesson_dir, "attachments.json")
        if not os.path.exists(attachments_path):
            with open(attachments_path, "w", encoding="utf-8") as f:
                json.dump([], f)

        # ---- group/subject index.html: create or update the lesson's card ----
        index_path = common.group_index_path(site_root, subject_slug, group_relpath)
        try:
            style_used = common.upsert_lesson_card(
                site_root, subject_slug, group_relpath, lesson_slug,
                lesson_name, self.lesson_desc_var.get().strip(), len(self.questions))
        except ValueError as e:
            messagebox.showerror("Couldn't update the listing page",
                                  "Lesson files were generated at:\n{}\n\nBut inserting the card into\n{}\n"
                                  "failed:\n\n{}".format(lesson_dir, index_path, e))
            self._editing = {"subject_slug": subject_slug, "group_relpath": group_relpath, "lesson_slug": lesson_slug}
            self._refresh_lessons()
            if self.on_lessons_changed:
                self.on_lessons_changed()
            return

        self.status_var.set("Generated {}/ ({} files) and updated {} ({} style)".format(
            location_label, 3 if include_assignment else 2, index_path, style_used))
        messagebox.showinfo("Done", "Lesson files created at:\n{}\n\nListing page updated:\n{}\n\n"
                                     "Tip: switch to the Attachment Maker or Assignment Maker tabs to "
                                     "add files or change the submission mode for this lesson.".format(
                                         lesson_dir, index_path))
        self._editing = {"subject_slug": subject_slug, "group_relpath": group_relpath, "lesson_slug": lesson_slug}
        self._refresh_lessons()
        if lesson_slug in self.delete_lesson_combo["values"]:
            self.delete_lesson_var.set(lesson_slug)
        if self.on_lessons_changed:
            self.on_lessons_changed()
