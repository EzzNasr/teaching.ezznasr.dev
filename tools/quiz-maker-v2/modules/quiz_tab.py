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

from modules import common, drive_bridge, background, theme
from modules.question_panel import QuestionPanel
from modules.common import (
    GRADED_BULK_HELP,
    parse_bulk_graded_questions,
    MCQItemDialog,
    TrueFalseItemDialog,
    MatchItemDialog,
    WrittenItemDialog,
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
        common.enable_clipboard_shortcuts(self)
        self._build_form()
        self._bind_undo_redo()
        # "Unsaved changes": any edit to the form or the question list since the last load / generate / clear
        self.dirty = False
        self._dirty_rev = 0
        self.on_dirty_changed = None          # app_main shows the marker in the header
        for var in (self.lesson_name_var, self.lesson_desc_var, self.video_url_var, self.include_assignment_var,
                    self.assign_prompt_var):
            var.trace_add("write", lambda *_a: self._mark_dirty())

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
                                     "modes, use the Assignment section after generating this lesson.",
                 fg="gray30", font=("TkDefaultFont", 8)).pack(anchor="w", padx=8, pady=(0, 6))

        solution_frame = tk.LabelFrame(self, text="Solution video (shown on the quiz page itself)")
        solution_frame.pack(fill="x", **pad)
        row_sol = tk.Frame(solution_frame)
        row_sol.pack(fill="x", padx=8, pady=4)
        tk.Label(row_sol, text="Video URL:", width=14, anchor="w").pack(side="left")
        self.quiz_solution_video_var = tk.StringVar()
        tk.Entry(row_sol, textvariable=self.quiz_solution_video_var).pack(side="left", fill="x", expand=True)
        self.solution_update_btn = tk.Button(row_sol, text="Update", command=self._update_quiz_solution_video)
        self.solution_update_btn.pack(side="left", padx=6)
        tk.Label(solution_frame,
                 text="A homework-solving/walkthrough video embedded directly on this lesson's quiz.html page "
                      "(separate from the intro video above, which lives on the lesson's main page). Paste any "
                      "YouTube link \u2014 it's converted automatically. Requires the lesson to already exist "
                      "(Generate lesson files at least once first); leave blank and click Update to remove it. "
                      "This only touches the quiz page's video, nothing else.",
                 fg="gray30", font=("TkDefaultFont", 8), justify="left", wraplength=640).pack(anchor="w", padx=8, pady=(0, 6))

        del_frame = tk.LabelFrame(self, text="Open an existing lesson")
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
        self.load_btn = tk.Button(btn_row_del, text="Load for editing", command=self._load_lesson_for_edit,
                                  font=("TkDefaultFont", 9, "bold"))
        self.load_btn.pack(side="left")
        tk.Button(btn_row_del, text="Preview in browser", command=self._preview_lesson).pack(side="left", padx=6)
        tk.Button(btn_row_del, text="New lesson / clear form", command=self._new_lesson).pack(side="right")
        # the destructive / recovery actions on their own row, away from the everyday ones
        btn_row_del2 = tk.Frame(del_frame)
        btn_row_del2.pack(fill="x", padx=8, pady=(2, 4))
        tk.Button(btn_row_del2, text="Delete lesson...", command=self._delete_lesson,
                  fg="#8a1f1f").pack(side="left")
        tk.Button(btn_row_del2, text="Recover deleted lesson...", command=self._recover_lesson).pack(side="left", padx=6)
        tk.Button(btn_row_del2, text="Empty trash...", command=self._empty_trash,
                  fg="#8a1f1f").pack(side="left")
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
                 fg="gray30", font=("TkDefaultFont", 8), wraplength=330, justify="left").pack(side="left", padx=8)
        tk.Button(chapter_row, text="Save draft...", command=self._save_draft).pack(side="right", padx=(6, 0))
        tk.Button(chapter_row, text="Load draft...", command=self._load_draft).pack(side="right")

        btn_row = tk.Frame(q_frame)
        btn_row.pack(fill="x", padx=8, pady=6)
        tk.Button(btn_row, text="+ Multiple choice", command=self._add_mcq).pack(side="left")
        tk.Button(btn_row, text="+ True/False", command=self._add_truefalse).pack(side="left", padx=6)
        tk.Button(btn_row, text="+ Matching", command=self._add_match).pack(side="left")
        tk.Button(btn_row, text="+ Written (photo)", command=self._add_written).pack(side="left", padx=6)
        tk.Button(btn_row, text="+ Bulk paste...", command=self._bulk_add).pack(side="left", padx=6)
        # the list: select several (Shift/Ctrl+click, Ctrl+A) and edit, duplicate, move, re-chapter or
        # remove them together (modules/question_panel.py); every change is one Ctrl+Z step
        self.qpanel = QuestionPanel(q_frame, get_items=lambda: self.questions, set_items=self._set_questions,
                                    on_edit=self._edit_question_at, before_change=self._snapshot,
                                    status_var=self.status_var, new_qid=common.new_written_qid)
        self.qpanel.pack(fill="both", expand=True, padx=8, pady=(4, 8))

        gen_row = tk.Frame(self)
        gen_row.pack(fill="x", padx=10, pady=12)
        self.generate_btn = tk.Button(gen_row, text="Generate lesson files", command=self._generate,
                                      font=("TkDefaultFont", 10, "bold"), height=2)
        self.generate_btn.pack(fill="x")

        # Page order, top to bottom, the way a lesson is made: open (or start) a lesson, its details, the
        # questions, the assignment, the quiz-page video, then Generate.
        for frame in (del_frame, info_frame, q_frame, assign_frame, solution_frame, gen_row):
            info = frame.pack_info()
            info.pop("in", None)
            frame.pack_forget()
            frame.pack(**info)

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
            messagebox.showerror("Site location missing", "Pick a valid site folder first (Settings → Site folder, Ctrl+,).")
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
        theme.notify(self, "Deleted", "Removed {}/{}/{} from the site.\n\nMoved to:\n{}".format(
            subject_slug, group_relpath, lesson_slug, moved_to))
        if self.on_lessons_changed:
            self.on_lessons_changed()

    def _preview_lesson(self):
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site folder first (Settings → Site folder, Ctrl+,).")
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

    def _update_quiz_solution_video(self):
        """Embed (or clear) a video directly on this lesson's quiz.html
        page — independent of the lesson's intro video and independent
        of regenerating the questions. Targets whichever lesson is
        selected in the 'Open an existing lesson' combo."""
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site folder first (Settings → Site folder, Ctrl+,).")
            return
        lesson_slug = self.delete_lesson_var.get().strip()
        if not lesson_slug:
            messagebox.showinfo("No lesson selected", "Pick a lesson in \u201cExisting lessons\u201d below first.")
            return
        subject_slug = self._subject_slug()
        group_relpath = self._group_relpath()
        lesson_dir = os.path.join(common.group_dir(site_root, subject_slug, group_relpath), lesson_slug)
        quiz_path = os.path.join(lesson_dir, "quiz.html")
        lesson_key = common.lesson_url_path(subject_slug, group_relpath, lesson_slug)
        drive_cfg = common.get_drive_config(common.load_config())
        video_url = self.quiz_solution_video_var.get()

        # The backend call (and the page write after it) runs off the Tk thread; see modules/background.py.
        def task(job):
            return common.set_lesson_video(
                drive_cfg["web_app_url"], drive_cfg["admin_token"], lesson_key, "quiz",
                video_url, lesson_slug.replace("-", " ").title(), quiz_path)

        def failed(e):
            self.status_var.set("Solution video not updated.")
            if isinstance(e, FileNotFoundError):
                messagebox.showerror("No quiz page found",
                                      "{}/quiz.html doesn't exist yet \u2014 generate this lesson first.".format(lesson_slug))
            elif isinstance(e, ValueError):
                messagebox.showerror("Couldn't find the video area",
                                      "This lesson's quiz.html doesn't have the expected media-slot section \u2014 "
                                      "it may have been hand-edited or use an older template.")
            elif isinstance(e, drive_bridge.DriveBridgeError):
                messagebox.showerror("Couldn't reach the Drive bridge", str(e))
            else:
                messagebox.showerror("Solution video not updated", "{}: {}".format(e.__class__.__name__, e))

        def done(result):
            embed_url, used_backend = result
            if embed_url != self.quiz_solution_video_var.get().strip():
                self.quiz_solution_video_var.set(embed_url)
            self.status_var.set("Updated solution video for {}/{} quiz page".format(subject_slug, lesson_slug))
            if not embed_url:
                theme.notify(self, "Done", "Quiz solution video cleared.")
            elif used_backend:
                theme.notify(self, "Done", "Quiz solution video updated (starts locked if new \u2014 unlock it from "
                                             "the dashboard once you're ready).")
            else:
                theme.notify(self, "Done", "Quiz solution video updated.\n\nNote: the Drive bridge Web App URL/admin "
                                             "token aren't set (Settings → Drive bridge), so this video was baked in as a "
                                             "plain, unprotected embed \u2014 configure the Drive bridge to make it "
                                             "lockable.")

        background.run_in_background(self, task, done, failed, name="Updating the quiz solution video",
                                     disable=[self.solution_update_btn])

    def _load_lesson_for_edit(self):
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site folder first (Settings → Site folder, Ctrl+,).")
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

        # -- video (lesson page) and solution video (quiz.html), preferring
        # the Drive-bridge Videos sheet over whatever's baked in the page --
        lesson_key = common.lesson_url_path(subject_slug, group_relpath, lesson_slug)
        drive_cfg = common.get_drive_config(common.load_config())
        index_path = os.path.join(lesson_dir, "index.html")

        # Everything that asks the backend runs off the Tk thread (modules/background.py); only reads, so the
        # user may cancel it. The form is only touched afterwards, in _apply_loaded_lesson().
        def fetch(job):
            out = {"questions": questions, "models_error": None}
            # Once a lesson's quiz content has been synced (set_quiz_content, in
            # _generate() below), quiz.html itself may only carry meta (title/
            # subject/lesson) — the questions live server-side instead, same as
            # a synced video's URL isn't baked into the page either. Prefer that
            # stored copy here so re-opening a synced lesson for editing doesn't
            # show an empty question list; falls back to whatever's already in
            # the page (legacy pages, or no Drive bridge configured) otherwise.
            if drive_cfg["web_app_url"] and drive_cfg["admin_token"]:
                try:
                    synced_quiz = drive_bridge.get_quiz_content(
                        drive_cfg["web_app_url"], drive_cfg["admin_token"], lesson_key)
                except drive_bridge.DriveBridgeError:
                    synced_quiz = None
                if synced_quiz and isinstance(synced_quiz.get("questions"), list):
                    out["questions"] = synced_quiz["questions"]
                    if any(isinstance(q, dict) and q.get("type") == "written" for q in out["questions"]):
                        try:   # model answers live in WrittenModels, not in the quiz content
                            common.merge_written_models(out["questions"], drive_bridge.get_written_models(
                                drive_cfg["web_app_url"], drive_cfg["admin_token"], lesson_key))
                        except drive_bridge.DriveBridgeError as e:
                            out["models_error"] = str(e)
            if job.cancelled:
                return out
            out["video_url"] = common.get_lesson_video_url(
                drive_cfg["web_app_url"], drive_cfg["admin_token"], lesson_key, "lesson", index_path)
            out["quiz_solution_video_url"] = common.get_lesson_video_url(
                drive_cfg["web_app_url"], drive_cfg["admin_token"], lesson_key, "quiz", quiz_path)
            return out

        def failed(e):
            self.status_var.set("Couldn't load {}.".format(lesson_slug))
            messagebox.showerror("Couldn't load the lesson", "{}: {}".format(e.__class__.__name__, e))

        background.run_in_background(
            self, fetch,
            lambda out: self._apply_loaded_lesson(out, quiz_json, subject_slug, group_relpath, lesson_slug,
                                                  lesson_dir, index_path),
            failed, name="Loading {} for editing".format(lesson_slug), disable=[self.load_btn], cancellable=True)

    def _apply_loaded_lesson(self, out, quiz_json, subject_slug, group_relpath, lesson_slug, lesson_dir, index_path):
        """Main thread: the second half of _load_lesson_for_edit, once the backend has answered."""
        questions = out["questions"]
        if out["models_error"] is not None:
            messagebox.showwarning("Model answers not loaded",
                                   "Couldn't read the written questions' model answers:\n{}".format(out["models_error"]))

        if self.questions or self.lesson_name_var.get().strip():
            if not messagebox.askyesno(
                    "Replace current form?",
                    "This replaces the lesson name, description, video, assignment prompt, and question "
                    "list currently in the form below with {}'s saved content.\n\n"
                    "Anything you've typed here that hasn't been generated yet will be lost. Continue?".format(
                        lesson_slug)):
                self.status_var.set("Load cancelled \u2014 the form was left as it was.")
                return

        # -- description, from index.html (best-effort; quiz.html alone
        # doesn't carry it) --------------------------------------------
        lesson_desc = ""
        if os.path.isfile(index_path):
            with open(index_path, "r", encoding="utf-8") as f:
                index_content = f.read()
            desc_match = re.search(r'<h1>.*?</h1>\s*<p class="lede">(.*?)</p>', index_content, re.DOTALL)
            if desc_match:
                lesson_desc = desc_match.group(1).strip()

        video_url = out["video_url"]
        quiz_solution_video_url = out["quiz_solution_video_url"]

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
        self.quiz_solution_video_var.set(quiz_solution_video_url)
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
        self._clear_dirty()

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
        self.quiz_solution_video_var.set("")
        self.include_assignment_var.set(True)
        self.assign_prompt_var.set("Paste your completed assignment below.")
        self.questions = []
        self._refresh_listbox()
        self._editing = None
        self._clear_dirty()
        self.status_var.set("Form cleared \u2014 ready for a new lesson.")

    def _recover_lesson(self):
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site folder first (Settings → Site folder, Ctrl+,).")
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
        theme.notify(self, "Recovered", "{}/{} is back on the site.".format(subject_slug, lesson_slug))
        if self.on_lessons_changed:
            self.on_lessons_changed()

    def _empty_trash(self):
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site folder first (Settings → Site folder, Ctrl+,).")
            return

        dlg = EmptyTrashDialog(self, site_root)
        self.wait_window(dlg)
        if not dlg.confirmed:
            return

        removed = common.purge_deleted_lessons(site_root)
        self.status_var.set("Emptied trash — permanently removed {} lesson(s).".format(len(removed)))
        theme.notify(self, "Trash emptied",
                             "Permanently removed {} lesson(s) from _deleted-lessons/.".format(len(removed)))

    # -- question list --------------------------------------------------

    _TYPE_LABELS = {"mcq": "MCQ", "truefalse": "T/F", "match": "Match", "written": "Written"}

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

    def _refresh_listbox(self, select=None):
        self.qpanel.refresh(select=select)
        if hasattr(self, "_mark_dirty"):
            self._mark_dirty()

    def _mark_dirty(self):
        self._dirty_rev = getattr(self, "_dirty_rev", 0) + 1
        if not getattr(self, "dirty", True):
            self.dirty = True
            if self.on_dirty_changed:
                self.on_dirty_changed(True)

    def _clear_dirty(self, if_rev=None):
        """Mark the form saved; with if_rev, only when nothing changed since that revision."""
        if if_rev is not None and if_rev != self._dirty_rev:
            return
        self.dirty = False
        if self.on_dirty_changed:
            self.on_dirty_changed(False)

    def _set_questions(self, items):
        self.questions = items

    def _add_mcq(self):
        dlg = MCQItemDialog(self, chapter_choices=self._chapter_choices(), default_chapter=self._current_chapter())
        self.wait_window(dlg)
        if dlg.result:
            self._snapshot()
            self.questions.append(dlg.result)
            self._refresh_listbox(select=[len(self.questions) - 1])

    def _add_truefalse(self):
        dlg = TrueFalseItemDialog(self, chapter_choices=self._chapter_choices(), default_chapter=self._current_chapter())
        self.wait_window(dlg)
        if dlg.result:
            self._snapshot()
            self.questions.append(dlg.result)
            self._refresh_listbox(select=[len(self.questions) - 1])

    def _add_match(self):
        dlg = MatchItemDialog(self, chapter_choices=self._chapter_choices(), default_chapter=self._current_chapter())
        self.wait_window(dlg)
        if dlg.result:
            self._snapshot()
            self.questions.append(dlg.result)
            self._refresh_listbox(select=[len(self.questions) - 1])

    def _add_written(self):
        dlg = WrittenItemDialog(self, chapter_choices=self._chapter_choices(), default_chapter=self._current_chapter())
        self.wait_window(dlg)
        if dlg.result:
            self._snapshot()
            self.questions.append(dlg.result)
            self._refresh_listbox(select=[len(self.questions) - 1])

    def _bulk_add(self):
        dlg = GradedBulkDialog(self, current_chapter=self._current_chapter())
        self.wait_window(dlg)
        if dlg.result:
            self._snapshot()
            self.questions.extend(dlg.result)
            self._refresh_listbox(select=list(range(len(self.questions) - len(dlg.result), len(self.questions))))
            self.status_var.set("Added {} question(s) from bulk paste.".format(len(dlg.result)))

    def _edit_question(self):
        sel = self.qpanel.selection()
        if len(sel) != 1:
            messagebox.showinfo("No selection", "Select one question to edit." if sel else "Select a question to edit.")
            return
        self._edit_question_at(sel[0])

    def _edit_question_at(self, idx):
        existing = self._normalize_legacy(self.questions[idx])
        dialog_cls = {"mcq": MCQItemDialog, "truefalse": TrueFalseItemDialog, "match": MatchItemDialog,
                      "written": WrittenItemDialog}[existing["type"]]
        dlg = dialog_cls(self, existing=existing, chapter_choices=self._chapter_choices(),
                          default_chapter=self._current_chapter())
        self.wait_window(dlg)
        if dlg.result:
            self._snapshot()
            self.questions[idx] = dlg.result
            self._refresh_listbox(select=[idx])

    def _remove_question(self):
        """Remove every selected question (one undo step)."""
        if not self.qpanel.selection():
            messagebox.showinfo("No selection", "Select one or more questions to remove.")
            return
        self.qpanel.remove_selected()

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
            messagebox.showerror("Site location missing", "Pick a valid site folder first (Settings → Site folder, Ctrl+,).")
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

        # Everything the files are made from, read from the form NOW: the writing (and the backend calls in
        # between) runs in a worker thread, which must never touch a widget (modules/background.py).
        inp = {
            "site_root": site_root, "lesson_name": lesson_name, "subject_slug": subject_slug,
            "subject_title": subject_title, "group_relpath": group_relpath, "lesson_slug": lesson_slug,
            "lesson_dir": lesson_dir, "location_label": location_label,
            "include_assignment": self.include_assignment_var.get(),
            "questions": copy.deepcopy(self.questions),
            "lesson_desc": self.lesson_desc_var.get().strip(),
            "assign_prompt": self.assign_prompt_var.get().strip(),
            "video_url": self.video_url_var.get(),
            "rev": self._dirty_rev,            # edits made while it generates stay "unsaved"
        }
        background.run_in_background(
            self, lambda job: self._write_lesson_files(inp),
            lambda res: self._on_generated(inp, res), lambda e: self._on_generate_failed(inp, e),
            name="Generating {}".format(location_label), disable=[self.generate_btn])

    @staticmethod
    def _write_lesson_files(inp):
        """Worker thread: write the lesson's files and call the backend. Same steps, same output as before
        this ran in the background; dialogs are collected in `res` and shown by _on_generated."""
        site_root, lesson_name = inp["site_root"], inp["lesson_name"]
        subject_slug, subject_title = inp["subject_slug"], inp["subject_title"]
        group_relpath, lesson_slug = inp["group_relpath"], inp["lesson_slug"]
        lesson_dir, location_label = inp["lesson_dir"], inp["location_label"]
        questions = inp["questions"]
        res = {"sync_error": None, "new_video_url": None, "video_warning": None, "card_error": None,
               "include_assignment": inp["include_assignment"]}
        os.makedirs(lesson_dir, exist_ok=True)
        common.write_lesson_stylesheets(lesson_dir)

        include_assignment = inp["include_assignment"]

        # Determined once, used both when (re)writing assignment.html below
        # and for the lesson-card link's description text further down.
        submit_mode = common.DEFAULT_SUBMIT_MODE
        # Preserve any graded questions already embedded on assignment.html
        # (set via the Assignment Maker tab) across regeneration here —
        # this tab has no knowledge of graded items, so without this the
        # {{ASSIGN_QUESTIONS_JSON}} placeholder would get written out
        # unreplaced, silently wiping the assignment's questions.
        existing_assign_questions_json = json.dumps({"items": []})
        if include_assignment:
            assignment_path = os.path.join(lesson_dir, "assignment.html")
            if os.path.isfile(assignment_path):
                with open(assignment_path, "r", encoding="utf-8") as f:
                    existing_assignment = f.read()
                mode_match = re.search(r'data-mode="([a-z]+)"', existing_assignment)
                if mode_match:
                    submit_mode = mode_match.group(1)
                q_match = re.search(r'id="assign-questions">\s*(\{.*?\})\s*</script>',
                                     existing_assignment, re.DOTALL)
                if q_match:
                    existing_assign_questions_json = q_match.group(1)

        # ---- quiz.html ----
        # Written questions: the model answer goes to the WrittenModels tab, never into the
        # quiz JSON (get_quiz serves that to every student) or the page.
        public_questions, written_models = common.split_written_models(questions)
        quiz_json = {
            "title": lesson_name,
            "subject": subject_slug,
            "lesson": lesson_slug,
            "questions": public_questions,
        }
        track_class = common.track_class_for_group(subject_slug, group_relpath)
        drive_cfg = common.get_drive_config(common.load_config())

        # The questions (and their correct answers) now live behind the same
        # lock the "Quiz gate" lock/unlock control sets — get_quiz only hands
        # them to a viewer the server has actually cleared, the same way a
        # video's URL only ever reaches someone allowed to watch it. Baking
        # them into the static page too (the old behavior) meant a "locked"
        # quiz still put its full answer key in the page's own source for
        # anyone to read regardless of what the on-screen lock said. If no
        # Drive bridge is configured there's nowhere else for them to live,
        # so they're kept in the page as a fallback — same as
        # quiz_video_block below falling back to a plain iframe with no
        # bridge configured.
        content_synced = False
        if drive_cfg["web_app_url"] and drive_cfg["admin_token"]:
            try:
                drive_bridge.set_quiz_content(
                    drive_cfg["web_app_url"], drive_cfg["admin_token"], location_label, quiz_json)
                content_synced = True
                if written_models:
                    drive_bridge.set_written_models(
                        drive_cfg["web_app_url"], drive_cfg["admin_token"], location_label, written_models)
            except drive_bridge.DriveBridgeError as e:
                res["sync_error"] = str(e)      # shown by _on_generated, before the "Done" message

        quiz_meta = {"title": lesson_name, "subject": subject_slug, "lesson": lesson_slug}
        if not content_synced:
            quiz_meta["questions"] = public_questions

        # Preserve a solution video already set on this quiz page (via the
        # standalone "Solution video" control below) across regeneration —
        # regenerating the questions shouldn't wipe it out. If it's backend-
        # managed (Videos sheet), always write the placeholder here — video.js
        # renders the real thing client-side, so baking it back in on every
        # regen would defeat any lock on it. Otherwise preserve whatever's
        # already baked into the page (legacy, not-yet-migrated video, or none).
        quiz_path = os.path.join(lesson_dir, "quiz.html")
        quiz_video_block = common.video_block_for_regen(
            drive_cfg["web_app_url"], drive_cfg["admin_token"], location_label, "quiz", quiz_path, lesson_name)

        quiz_html = common.load_template("quiz.html")
        quiz_html = (quiz_html
                     .replace("{{SUBJECT_SLUG}}", subject_slug)
                     .replace("{{LESSON_SLUG}}", lesson_slug)
                     .replace("{{LESSON_TITLE}}", lesson_name)
                     .replace("{{QUESTION_COUNT}}", str(len(questions)))
                     .replace("{{QUIZ_JSON}}", json.dumps(quiz_meta, indent=2))
                     .replace("{{VIDEO_BLOCK}}", quiz_video_block)
                     .replace("{{TRACK_CLASS}}", track_class)
                     .replace("{{LESSON_URL_PATH}}", location_label))
        with open(quiz_path, "w", encoding="utf-8") as f:
            f.write(quiz_html)

        # ---- assignment.html — preserve an already-configured submission
        #      mode (set via the Assignment Maker tab) instead of resetting
        #      it back to plain text every time the quiz is regenerated.
        #      Brand-new lessons default to graded questions (submit_mode
        #      computed above, next to include_assignment).
        if include_assignment:
            # Preserve a solution video already set on this assignment page
            # (via the Assignment Maker tab's "Solution video" control)
            # across regeneration, same as submit_mode above — and same
            # backend-managed-vs-legacy handling as quiz_video_block above.
            assign_video_block = common.video_block_for_regen(
                drive_cfg["web_app_url"], drive_cfg["admin_token"], location_label, "assignment",
                assignment_path, lesson_name)

            assignment_html = common.load_template("assignment.html")
            assignment_html = (assignment_html
                                .replace("{{SUBJECT_SLUG}}", subject_slug)
                                .replace("{{LESSON_SLUG}}", lesson_slug)
                                .replace("{{LESSON_TITLE}}", lesson_name)
                                .replace("{{SUBMIT_MODE}}", submit_mode)
                                .replace("{{ASSIGN_PROMPT}}", inp["assign_prompt"] or
                                         "Paste your completed assignment below.")
                                .replace("{{VIDEO_BLOCK}}", assign_video_block)
                                .replace("{{TRACK_CLASS}}", track_class)
                     .replace("{{LESSON_URL_PATH}}", location_label)
                     .replace("{{ASSIGN_QUESTIONS_JSON}}", existing_assign_questions_json))
            with open(assignment_path, "w", encoding="utf-8") as f:
                f.write(assignment_html)

        # ---- lesson index.html ----
        # The video field is written from scratch here every time (not
        # preserved from the file, unlike the quiz/assignment solution
        # videos above), so the template always gets the placeholder;
        # the actual video (if any) is applied via set_lesson_video just
        # below, once the file exists on disk for it to update.
        video_block = common.VIDEO_PLACEHOLDER

        if include_assignment:
            mode_desc = {"text": "Paste your work as text", "url": "Submit a link",
                         "file": "Upload a file", "both": "Submit a link or file",
                         "graded": "Answer the questions"}.get(
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
                              .replace("{{LESSON_DESC}}", inp["lesson_desc"])
                              .replace("{{VIDEO_BLOCK}}", video_block)
                              .replace("{{QUESTION_COUNT}}", str(len(questions)))
                              .replace("{{ASSIGNMENT_LINK_BLOCK}}", assign_link_block)
                              .replace("{{TRACK_CLASS}}", track_class)
                     .replace("{{LESSON_URL_PATH}}", location_label))
        lesson_index_path = os.path.join(lesson_dir, "index.html")
        with open(lesson_index_path, "w", encoding="utf-8") as f:
            f.write(lesson_index_html)

        # Now that index.html exists on disk (with the placeholder just
        # written above), apply the lesson's own video field — it's set
        # directly by the user every time (not preserved from the file),
        # so it always goes through the Drive bridge when one is configured.
        video_warning = None
        try:
            video_url, video_used_backend = common.set_lesson_video(
                drive_cfg["web_app_url"], drive_cfg["admin_token"], location_label, "lesson",
                inp["video_url"], lesson_name, lesson_index_path)
        except drive_bridge.DriveBridgeError as e:
            video_url, video_used_backend = inp["video_url"].strip(), False
            video_warning = ("The lesson's video couldn't be saved: {}\n\nEverything else was generated "
                              "normally \u2014 fix the Drive bridge connection and click Generate again, or "
                              "paste the video URL again once it's reachable.".format(e))
        else:
            if video_url and video_url != inp["video_url"].strip():
                res["new_video_url"] = video_url     # put back into the form by _on_generated
            if video_url and not video_used_backend:
                video_warning = ("Drive bridge Web App URL/admin token aren't set (Settings → Drive bridge), so the "
                                  "lesson video was baked in as a plain, unprotected embed \u2014 configure the "
                                  "Drive bridge to make it lockable.")

        # ---- attachments.json (empty manifest; Attachment Maker tab fills it in) ----
        attachments_path = os.path.join(lesson_dir, "attachments.json")
        if not os.path.exists(attachments_path):
            with open(attachments_path, "w", encoding="utf-8") as f:
                json.dump([], f)

        res["video_warning"] = video_warning

        # ---- group/subject index.html: create or update the lesson's card ----
        index_path = common.group_index_path(site_root, subject_slug, group_relpath)
        res["index_path"] = index_path
        try:
            style_used = common.upsert_lesson_card(
                site_root, subject_slug, group_relpath, lesson_slug,
                lesson_name, inp["lesson_desc"], len(questions))
        except ValueError as e:
            res["card_error"] = str(e)
            return res
        res["style_used"] = style_used

        common.run_seo_build(site_root)  # titles / meta / sitemap for the new lesson
        return res

    def _on_generate_failed(self, inp, e):
        """Main thread: an unexpected error while writing (disk full, permission denied...)."""
        self.status_var.set("Generating {} failed: {}".format(inp["location_label"], e))
        messagebox.showerror("Generate lesson files failed",
                             "Something went wrong while writing {}:\n\n{}: {}\n\nSome of its files may "
                             "already have been written; fix the problem and click Generate again.".format(
                                 inp["lesson_dir"], e.__class__.__name__, e))

    def _on_generated(self, inp, res):
        """Main thread: show what the worker collected, then refresh the lesson lists."""
        subject_slug, group_relpath, lesson_slug = inp["subject_slug"], inp["group_relpath"], inp["lesson_slug"]
        lesson_dir, location_label = inp["lesson_dir"], inp["location_label"]
        index_path = res["index_path"]
        if res["sync_error"] is not None:
            messagebox.showerror(
                "Couldn't reach the Drive bridge",
                "The quiz's questions weren't synced to the server, so they've been kept "
                "in the page itself for now instead (same as before this feature):\n{}".format(res["sync_error"]))
        if res["new_video_url"] and self.video_url_var.get() == inp["video_url"]:
            self.video_url_var.set(res["new_video_url"])

        if res["card_error"] is not None:
            self.status_var.set("Generated {}/ but couldn't update the listing page.".format(location_label))
            messagebox.showerror("Couldn't update the listing page",
                                  "Lesson files were generated at:\n{}\n\nBut inserting the card into\n{}\n"
                                  "failed:\n\n{}".format(lesson_dir, index_path, res["card_error"]))
            self._editing = {"subject_slug": subject_slug, "group_relpath": group_relpath, "lesson_slug": lesson_slug}
            self._clear_dirty(if_rev=inp["rev"])
            self._refresh_lessons()
            if self.on_lessons_changed:
                self.on_lessons_changed()
            return

        video_warning = res["video_warning"]
        status = "Generated {}/ ({} files) and updated {} ({} style)".format(
            location_label, 3 if res["include_assignment"] else 2, index_path, res["style_used"])
        self.status_var.set(status + (" \u2014 video not saved, see popup" if video_warning else ""))
        done_msg = ("Lesson files created at:\n{}\n\nListing page updated:\n{}\n\n"
                     "Tip: the Attachments and Assignment sections add files or change how students "
                     "submit for this lesson.".format(lesson_dir, index_path))
        if video_warning:
            messagebox.showwarning("Done, with a video issue", done_msg + "\n\n" + video_warning)
        else:
            theme.notify(self, "Done", done_msg)
        self._editing = {"subject_slug": subject_slug, "group_relpath": group_relpath, "lesson_slug": lesson_slug}
        self._clear_dirty(if_rev=inp["rev"])
        self._refresh_lessons()
        if lesson_slug in self.delete_lesson_combo["values"]:
            self.delete_lesson_var.set(lesson_slug)
        if self.on_lessons_changed:
            self.on_lessons_changed()
