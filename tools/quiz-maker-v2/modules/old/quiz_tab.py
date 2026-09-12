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
import tkinter as tk
import webbrowser
from tkinter import ttk, messagebox, filedialog

from modules import common

UNDO_LIMIT = 50

BULK_HELP = """Bulk paste format — one block per question:

Q: What does the def keyword do?
A) Deletes a variable
B) Starts a function definition *
C) Defines a class
D) Imports a module
E: def marks the start of a function definition.

Separate questions with a blank line or a line of ---.
Mark the correct option by adding a * right after it.
The "E:" line (explanation) is optional.
Up to 6 options per question (A-F)."""


def parse_bulk_questions(text):
    import re
    text = text.strip()
    if not text:
        return []

    blocks = re.split(r"\n\s*(?:-{3,}\s*\n)?(?=Q:\s)", "\n" + text)
    questions = []

    for block in blocks:
        block = block.strip()
        if not block:
            continue
        lines = [l.strip() for l in block.split("\n") if l.strip()]

        q_text = None
        options = []
        correct = None
        explain = ""

        for line in lines:
            if line.startswith("Q:"):
                q_text = line[2:].strip()
            elif re.match(r"^[A-Fa-f]\)", line):
                opt_text = line[2:].strip()
                is_correct = False
                stripped = opt_text.rstrip()
                if stripped.endswith("*"):
                    is_correct = True
                    opt_text = stripped[:-1].strip()
                options.append(opt_text)
                if is_correct:
                    correct = len(options) - 1
            elif line.startswith("E:"):
                explain = line[2:].strip()
            elif line.lower().startswith("explain:"):
                explain = line.split(":", 1)[1].strip()

        if q_text and len(options) >= 2:
            questions.append({
                "q": q_text,
                "options": options,
                "correct": correct if correct is not None else 0,
                "explain": explain,
            })

    return questions


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

        self.transient(parent)
        self.grab_set()

    def _on_confirm(self):
        self.confirmed = True
        self.destroy()


class QuestionDialog(tk.Toplevel):
    def __init__(self, parent, existing=None):
        super().__init__(parent)
        self.title("Question")
        self.result = None
        common.fit_geometry(self, 560, 520, min_w=380, min_h=380)
        self.resizable(True, True)

        pad = {"padx": 10, "pady": 6}

        tk.Label(self, text="Question text (HTML ok, e.g. <code>...</code>)").pack(anchor="w", **pad)
        self.q_text = tk.Text(self, height=3, wrap="word", undo=True, autoseparators=True, maxundo=-1)
        self.q_text.pack(fill="x", **pad)

        tk.Label(self, text="Number of options").pack(anchor="w", **pad)
        self.opt_count = tk.IntVar(value=4)
        count_row = tk.Frame(self)
        count_row.pack(fill="x", **pad)
        self.opt_spin = ttk.Spinbox(count_row, from_=2, to=6, textvariable=self.opt_count,
                                     width=5, command=self._rebuild_options)
        self.opt_spin.pack(side="left")

        self.options_frame = tk.Frame(self)
        self.options_frame.pack(fill="both", expand=True, **pad)

        self.option_vars = []
        self.correct_var = tk.IntVar(value=0)
        self._build_option_rows(4)

        tk.Label(self, text="Explanation (optional)").pack(anchor="w", **pad)
        self.explain_text = tk.Text(self, height=3, wrap="word", undo=True, autoseparators=True, maxundo=-1)
        self.explain_text.pack(fill="x", **pad)

        btn_row = tk.Frame(self)
        btn_row.pack(fill="x", pady=12)
        tk.Button(btn_row, text="Save question", command=self._on_save).pack(side="right", padx=10)
        tk.Button(btn_row, text="Cancel", command=self.destroy).pack(side="right")

        if existing:
            self.q_text.insert("1.0", existing.get("q", ""))
            opts = existing.get("options", ["", "", "", ""])
            self.opt_count.set(len(opts))
            self._build_option_rows(len(opts))
            for i, val in enumerate(opts):
                self.option_vars[i].set(val)
            self.correct_var.set(existing.get("correct", 0))
            self.explain_text.insert("1.0", existing.get("explain", ""))

        self.transient(parent)
        self.grab_set()

    def _rebuild_options(self):
        self._build_option_rows(self.opt_count.get())

    def _build_option_rows(self, n):
        for w in self.options_frame.winfo_children():
            w.destroy()
        self.option_vars = []
        for i in range(n):
            row = tk.Frame(self.options_frame)
            row.pack(fill="x", pady=2)
            tk.Radiobutton(row, variable=self.correct_var, value=i).pack(side="left")
            tk.Label(row, text=chr(65 + i) + ")", width=3).pack(side="left")
            var = tk.StringVar()
            entry = tk.Entry(row, textvariable=var)
            entry.pack(side="left", fill="x", expand=True)
            self.option_vars.append(var)
        if self.correct_var.get() >= n:
            self.correct_var.set(0)

    def _on_save(self):
        q = self.q_text.get("1.0", "end").strip()
        options = [v.get().strip() for v in self.option_vars]
        if not q:
            messagebox.showerror("Missing question", "Enter the question text.", parent=self)
            return
        if any(not o for o in options):
            messagebox.showerror("Missing option", "All option fields must be filled in.", parent=self)
            return
        explain = self.explain_text.get("1.0", "end").strip()
        self.result = {
            "q": q,
            "options": options,
            "correct": self.correct_var.get(),
            "explain": explain,
        }
        self.destroy()


class BulkDialog(tk.Toplevel):
    def __init__(self, parent):
        super().__init__(parent)
        self.title("Bulk paste questions")
        self.result = None
        common.fit_geometry(self, 640, 520, min_w=420, min_h=380)
        self.resizable(True, True)

        tk.Label(self, text=BULK_HELP, justify="left", anchor="w", font=("TkDefaultFont", 9)).pack(
            fill="x", padx=10, pady=8)

        self.text = tk.Text(self, wrap="word", undo=True, autoseparators=True, maxundo=-1)
        self.text.pack(fill="both", expand=True, padx=10, pady=6)

        btn_row = tk.Frame(self)
        btn_row.pack(fill="x", pady=10)
        tk.Button(btn_row, text="Parse & add questions", command=self._on_parse).pack(side="right", padx=10)
        tk.Button(btn_row, text="Cancel", command=self.destroy).pack(side="right")

        self.transient(parent)
        self.grab_set()

    def _on_parse(self):
        raw = self.text.get("1.0", "end")
        parsed = parse_bulk_questions(raw)
        if not parsed:
            messagebox.showerror("Nothing parsed", "Couldn't find any valid questions in that text. "
                                                     "Check the format against the instructions above.", parent=self)
            return
        self.result = parsed
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
        subject_combo.bind("<<ComboboxSelected>>", lambda e: self._refresh_lessons())

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
        tk.Button(btn_row_del, text="Preview in browser", command=self._preview_lesson).pack(side="left")
        tk.Button(btn_row_del, text="Delete lesson...", command=self._delete_lesson,
                  fg="#8a1f1f").pack(side="left", padx=6)
        tk.Button(btn_row_del, text="Recover deleted lesson...", command=self._recover_lesson).pack(side="left")
        tk.Button(btn_row_del, text="Empty trash...", command=self._empty_trash,
                  fg="#8a1f1f").pack(side="right")
        tk.Label(del_frame,
                 text="Preview/Delete use the Subject selected above. Deleted lessons move to "
                      "_deleted-lessons/ next to your site (not published, recoverable) until emptied.",
                 fg="gray30", font=("TkDefaultFont", 8), justify="left").pack(anchor="w", padx=8, pady=(0, 6))

        q_frame = tk.LabelFrame(self, text="Questions")
        q_frame.pack(fill="both", expand=True, **pad)

        btn_row = tk.Frame(q_frame)
        btn_row.pack(fill="x", padx=8, pady=6)
        tk.Button(btn_row, text="+ Add question", command=self._add_question).pack(side="left")
        tk.Button(btn_row, text="+ Bulk paste...", command=self._bulk_add).pack(side="left", padx=6)
        tk.Button(btn_row, text="Edit selected", command=self._edit_question).pack(side="left", padx=6)
        tk.Button(btn_row, text="Remove selected", command=self._remove_question).pack(side="left", padx=6)
        tk.Button(btn_row, text="Save draft...", command=self._save_draft).pack(side="right", padx=6)
        tk.Button(btn_row, text="Load draft...", command=self._load_draft).pack(side="right")

        list_frame = tk.Frame(q_frame)
        list_frame.pack(fill="both", expand=True, padx=8, pady=4)
        self.q_listbox = tk.Listbox(list_frame)
        self.q_listbox.pack(side="left", fill="both", expand=True)
        scrollbar = tk.Scrollbar(list_frame, command=self.q_listbox.yview)
        scrollbar.pack(side="right", fill="y")
        self.q_listbox.config(yscrollcommand=scrollbar.set)

        gen_row = tk.Frame(self)
        gen_row.pack(fill="x", padx=10, pady=12)
        tk.Button(gen_row, text="Generate lesson files", command=self._generate,
                  font=("TkDefaultFont", 10, "bold"), height=2).pack(fill="x")

        self._refresh_lessons()

    # -- delete lesson ----------------------------------------------------

    def _refresh_lessons(self):
        site_root = self.site_root_var.get().strip()
        subject_slug = self._subject_slug()
        lessons = common.list_existing_lessons(site_root, subject_slug) if site_root else []
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

        dlg = DeleteConfirmDialog(self, subject_slug, lesson_slug)
        self.wait_window(dlg)
        if not dlg.confirmed:
            return

        try:
            moved_to = common.delete_lesson(site_root, subject_slug, lesson_slug)
        except FileNotFoundError:
            messagebox.showerror("Not found", "That lesson folder no longer exists.")
            self._refresh_lessons()
            return
        except OSError as e:
            messagebox.showerror("Delete failed", "Couldn't move the lesson folder:\n{}".format(e))
            return

        self._refresh_lessons()
        self.status_var.set("Deleted lesson {}/{} — moved to {}".format(subject_slug, lesson_slug, moved_to))
        messagebox.showinfo("Deleted", "Removed {}/{} from the site.\n\nMoved to:\n{}".format(
            subject_slug, lesson_slug, moved_to))
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
        lesson_dir = os.path.join(site_root, subject_slug, lesson_slug)
        if not os.path.isdir(lesson_dir):
            messagebox.showerror("Not found", "That lesson folder doesn't exist.")
            self._refresh_lessons()
            return

        try:
            base_url = common.start_preview_server(site_root)
        except OSError as e:
            messagebox.showerror("Preview failed", "Couldn't start the local preview server:\n{}".format(e))
            return

        url = "{}/{}/{}/".format(base_url, subject_slug, lesson_slug)
        webbrowser.open(url)
        self.status_var.set("Previewing at " + url + " (served locally so /assets/... links resolve correctly)")

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

    def _refresh_listbox(self):
        self.q_listbox.delete(0, "end")
        for i, q in enumerate(self.questions):
            preview = q["q"][:70].replace("\n", " ")
            self.q_listbox.insert("end", "{:>2}. {}".format(i + 1, preview))

    def _add_question(self):
        dlg = QuestionDialog(self)
        self.wait_window(dlg)
        if dlg.result:
            self._snapshot()
            self.questions.append(dlg.result)
            self._refresh_listbox()

    def _bulk_add(self):
        dlg = BulkDialog(self)
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
        dlg = QuestionDialog(self, existing=self.questions[idx])
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
        lesson_slug = common.slugify(lesson_name)
        if not lesson_slug:
            messagebox.showerror("Invalid lesson name", "Lesson name must contain at least one letter or number.")
            return

        lesson_dir = os.path.join(site_root, subject_slug, lesson_slug)
        if os.path.exists(lesson_dir):
            if not messagebox.askyesno("Folder exists",
                                        "{}/{}  already exists. Overwrite its files?".format(subject_slug, lesson_slug)):
                return
        os.makedirs(lesson_dir, exist_ok=True)

        include_assignment = self.include_assignment_var.get()

        # ---- quiz.html ----
        quiz_json = {
            "title": lesson_name,
            "subject": subject_slug,
            "lesson": lesson_slug,
            "questions": self.questions,
        }
        quiz_html = common.load_template("quiz.html")
        quiz_html = (quiz_html
                     .replace("{{SUBJECT_SLUG}}", subject_slug)
                     .replace("{{LESSON_SLUG}}", lesson_slug)
                     .replace("{{LESSON_TITLE}}", lesson_name)
                     .replace("{{QUESTION_COUNT}}", str(len(self.questions)))
                     .replace("{{QUIZ_JSON}}", json.dumps(quiz_json, indent=2)))
        with open(os.path.join(lesson_dir, "quiz.html"), "w", encoding="utf-8") as f:
            f.write(quiz_html)

        # ---- assignment.html (basic text-paste mode; use Assignment Maker
        #      tab afterwards to switch to url/file/both) ----
        if include_assignment:
            assignment_html = common.load_template("assignment.html")
            assignment_html = (assignment_html
                                .replace("{{SUBJECT_SLUG}}", subject_slug)
                                .replace("{{LESSON_SLUG}}", lesson_slug)
                                .replace("{{LESSON_TITLE}}", lesson_name)
                                .replace("{{SUBMIT_MODE}}", "text")
                                .replace("{{ASSIGN_PROMPT}}", self.assign_prompt_var.get().strip() or
                                         "Paste your completed assignment below."))
            with open(os.path.join(lesson_dir, "assignment.html"), "w", encoding="utf-8") as f:
                f.write(assignment_html)

        # ---- lesson index.html ----
        video_url = self.video_url_var.get().strip()
        if video_url:
            video_block = '<iframe src="{}" title="{}" allowfullscreen></iframe>'.format(video_url, lesson_name)
        else:
            video_block = "Video placeholder &mdash; add a YouTube embed URL to replace this box."

        if include_assignment:
            assign_link_block = (
                '      <a class="lesson-link frame" href="/{}/{}/assignment.html">\n'
                '        <div class="ll-title">Assignment</div>\n'
                '        <div class="ll-desc">Paste your work as text</div>\n'
                '        <span class="ll-go">Submit</span>\n'
                '      </a>'
            ).format(subject_slug, lesson_slug)
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
                              .replace("{{ASSIGNMENT_LINK_BLOCK}}", assign_link_block))
        with open(os.path.join(lesson_dir, "index.html"), "w", encoding="utf-8") as f:
            f.write(lesson_index_html)

        # ---- attachments.json (empty manifest; Attachment Maker tab fills it in) ----
        attachments_path = os.path.join(lesson_dir, "attachments.json")
        if not os.path.exists(attachments_path):
            with open(attachments_path, "w", encoding="utf-8") as f:
                json.dump([], f)

        # ---- subject index.html: create or update ----
        subject_index_path = os.path.join(site_root, subject_slug, "index.html")
        self._upsert_subject_index(subject_index_path, subject_slug, subject_title,
                                    lesson_slug, lesson_name, len(self.questions))

        self.status_var.set("Generated {}/{}/ ({} files) and updated {}/index.html".format(
            subject_slug, lesson_slug, 3 if include_assignment else 2, subject_slug))
        messagebox.showinfo("Done", "Lesson files created at:\n{}\n\nSubject index updated:\n{}\n\n"
                                     "Tip: switch to the Attachment Maker or Assignment Maker tabs to "
                                     "add files or change the submission mode for this lesson.".format(
                                         lesson_dir, subject_index_path))
        self._refresh_lessons()
        if lesson_slug in self.delete_lesson_combo["values"]:
            self.delete_lesson_var.set(lesson_slug)
        if self.on_lessons_changed:
            self.on_lessons_changed()

    def _upsert_subject_index(self, path, subject_slug, subject_title, lesson_slug, lesson_name, question_count):
        card = common.load_template("lesson_card.html")
        card = (card
                .replace("{{SUBJECT_SLUG}}", subject_slug)
                .replace("{{LESSON_SLUG}}", lesson_slug)
                .replace("{{LESSON_TITLE}}", lesson_name)
                .replace("{{LESSON_DESC}}", self.lesson_desc_var.get().strip())
                .replace("{{QUESTION_COUNT}}", str(question_count)))

        start_marker = "<!-- LESSON_CARDS_START -->"
        end_marker = "<!-- LESSON_CARDS_END -->"

        if os.path.exists(path):
            import re
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            if start_marker in content and end_marker in content:
                before = content.split(start_marker)[0]
                after = content.split(end_marker)[1]
                middle = content.split(start_marker)[1].split(end_marker)[0]
                middle = re.sub(
                    r'\s*<a class="lesson-card frame" href="/{}/{}/">.*?</a>\s*'.format(
                        re.escape(subject_slug), re.escape(lesson_slug)),
                    "\n", middle, flags=re.DOTALL)
                new_middle = middle.rstrip() + "\n" + card
                new_content = before + start_marker + "\n" + new_middle + end_marker + after
                with open(path, "w", encoding="utf-8") as f:
                    f.write(new_content)
                return
            else:
                messagebox.showwarning(
                    "No insertion markers found",
                    "{} exists but doesn't contain the LESSON_CARDS_START/END markers "
                    "used for auto-insertion. Add the lesson card manually, or replace "
                    "this file with the generator's subject_index.html template first.\n\n"
                    "The lesson card HTML has been printed to the console.".format(path))
                print("\n--- Lesson card for {}/{} ---\n{}\n".format(subject_slug, lesson_slug, card))
                return

        os.makedirs(os.path.dirname(path), exist_ok=True)
        subj = common.load_template("subject_index.html")
        subj = (subj
                .replace("{{SUBJECT_TITLE}}", subject_title)
                .replace("{{SUBJECT_SLUG}}", subject_slug)
                .replace("{{SUBJECT_LEDE}}", "{} lessons, quizzes, and assignments.".format(subject_title))
                .replace("{{DWG_NO}}", "01")
                .replace("{{ABOUT_BLOCK}}", ""))
        subj = subj.replace(start_marker + "\n" + end_marker, start_marker + "\n" + card + end_marker)
        with open(path, "w", encoding="utf-8") as f:
            f.write(subj)
