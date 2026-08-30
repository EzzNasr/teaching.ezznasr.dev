#!/usr/bin/env python3
"""
assignment_tab.py — Tab 2: Assignment Maker.

Works on a lesson that already exists (created via the Quiz Maker tab).
Lets you write a longer assignment description and pick how students
submit: paste text, a link, a file upload, or either link-or-file.

File uploads go through the Drive bridge (Apps Script Web App) configured
at the top of the window — students only ever see this site, never
drive.google.com. See apps_script/Code.gs for the server side.
"""

import os
import re
import tkinter as tk
from tkinter import ttk, messagebox

from modules import common


class AssignmentTab(ttk.Frame):
    def __init__(self, parent, site_root_var, status_var):
        super().__init__(parent)
        self.site_root_var = site_root_var
        self.status_var = status_var
        self._build_form()

    def _build_form(self):
        pad = {"padx": 10, "pady": 6}

        pick_frame = tk.LabelFrame(self, text="Lesson")
        pick_frame.pack(fill="x", **pad)

        row1 = tk.Frame(pick_frame)
        row1.pack(fill="x", padx=8, pady=4)
        tk.Label(row1, text="Subject:", width=14, anchor="w").pack(side="left")
        self.subject_var = tk.StringVar(value=common.SUBJECTS[0][1])
        subject_combo = ttk.Combobox(row1, textvariable=self.subject_var, state="readonly",
                                      values=[label for _, label in common.SUBJECTS])
        subject_combo.pack(side="left", fill="x", expand=True)
        subject_combo.bind("<<ComboboxSelected>>", lambda e: self._refresh_lessons())

        row2 = tk.Frame(pick_frame)
        row2.pack(fill="x", padx=8, pady=4)
        tk.Label(row2, text="Lesson:", width=14, anchor="w").pack(side="left")
        self.lesson_var = tk.StringVar()
        self.lesson_combo = ttk.Combobox(row2, textvariable=self.lesson_var, state="readonly", values=[])
        self.lesson_combo.pack(side="left", fill="x", expand=True)
        tk.Button(row2, text="Refresh", command=self._refresh_lessons).pack(side="left", padx=6)
        tk.Button(row2, text="Load current settings", command=self._load_current).pack(side="left")

        prompt_frame = tk.LabelFrame(self, text="Assignment description")
        prompt_frame.pack(fill="both", expand=True, **pad)
        tk.Label(prompt_frame, text="This is shown to students on the assignment page. Multiple paragraphs are fine.",
                 fg="gray30", font=("TkDefaultFont", 8)).pack(anchor="w", padx=8, pady=(6, 0))
        self.prompt_text = tk.Text(prompt_frame, height=10, wrap="word",
                                    undo=True, autoseparators=True, maxundo=-1)
        self.prompt_text.pack(fill="both", expand=True, padx=8, pady=8)

        mode_frame = tk.LabelFrame(self, text="How students submit")
        mode_frame.pack(fill="x", **pad)
        row3 = tk.Frame(mode_frame)
        row3.pack(fill="x", padx=8, pady=6)
        tk.Label(row3, text="Submission type:", width=14, anchor="w").pack(side="left")
        self.mode_label_var = tk.StringVar(value=common.SUBMIT_MODES[0][1])
        mode_combo = ttk.Combobox(row3, textvariable=self.mode_label_var, state="readonly",
                                   values=[label for _, label in common.SUBMIT_MODES])
        mode_combo.pack(side="left", fill="x", expand=True)
        tk.Label(mode_frame,
                 text="Paste text: works with no setup. Link/File/Both: requires the Drive bridge "
                      "configured above (files upload to your Drive folder — students never see it).",
                 fg="gray30", font=("TkDefaultFont", 8), justify="left").pack(anchor="w", padx=8, pady=(0, 6))

        gen_row = tk.Frame(self)
        gen_row.pack(fill="x", padx=10, pady=12)
        tk.Button(gen_row, text="Update assignment page", command=self._update,
                  font=("TkDefaultFont", 10, "bold"), height=2).pack(fill="x")

        self._refresh_lessons()

    # -- helpers ----------------------------------------------------------

    def _subject_slug(self):
        label = self.subject_var.get()
        for slug, name in common.SUBJECTS:
            if name == label:
                return slug
        return common.slugify(label)

    def _mode_slug(self):
        label = self.mode_label_var.get()
        for slug, name in common.SUBMIT_MODES:
            if name == label:
                return slug
        return "text"

    def _lesson_dir(self):
        site_root = self.site_root_var.get().strip()
        subject_slug = self._subject_slug()
        lesson_slug = self.lesson_var.get().strip()
        if not (site_root and lesson_slug):
            return None
        return os.path.join(site_root, subject_slug, lesson_slug)

    def _refresh_lessons(self):
        site_root = self.site_root_var.get().strip()
        subject_slug = self._subject_slug()
        lessons = common.list_existing_lessons(site_root, subject_slug) if site_root else []
        self.lesson_combo["values"] = lessons
        if lessons and self.lesson_var.get() not in lessons:
            self.lesson_var.set(lessons[0])
        elif not lessons:
            self.lesson_var.set("")

    def _load_current(self):
        lesson_dir = self._lesson_dir()
        if not lesson_dir or not os.path.isdir(lesson_dir):
            messagebox.showinfo("No lesson selected", "Pick a subject and lesson first.")
            return

        assignment_path = os.path.join(lesson_dir, "assignment.html")
        if os.path.exists(assignment_path):
            with open(assignment_path, "r", encoding="utf-8") as f:
                content = f.read()
            prompt_match = re.search(r'<p class="lede">(.*?)</p>', content, re.DOTALL)
            if prompt_match:
                prompt = prompt_match.group(1).strip()
                self.prompt_text.delete("1.0", "end")
                self.prompt_text.insert("1.0", prompt)
            mode_match = re.search(r'data-mode="([a-z]+)"', content)
            if mode_match:
                mode_slug = mode_match.group(1)
                for slug, label in common.SUBMIT_MODES:
                    if slug == mode_slug:
                        self.mode_label_var.set(label)
                        break
            self.status_var.set("Loaded current assignment settings for " + self.lesson_var.get())
        else:
            self.prompt_text.delete("1.0", "end")
            self.prompt_text.insert("1.0", "Paste your completed assignment below.")
            self.mode_label_var.set(common.SUBMIT_MODES[0][1])
            self.status_var.set("No assignment.html yet for this lesson — fill in the form and click Update.")

    def _lesson_title(self, lesson_dir):
        index_path = os.path.join(lesson_dir, "index.html")
        if os.path.exists(index_path):
            with open(index_path, "r", encoding="utf-8") as f:
                content = f.read()
            m = re.search(r"<h1>(.*?)</h1>", content, re.DOTALL)
            if m:
                # strip any inner tags like <strong>
                return re.sub(r"<[^>]+>", "", m.group(1)).strip()
        return self.lesson_var.get().replace("-", " ").title()

    # -- update -------------------------------------------------------------

    def _update(self):
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site root folder first (top of the window).")
            return

        lesson_dir = self._lesson_dir()
        if not lesson_dir or not os.path.isdir(lesson_dir):
            messagebox.showerror("No lesson selected", "Pick a subject and lesson first (generate it in the "
                                                         "Quiz Maker tab if it doesn't exist yet).")
            return

        mode_slug = self._mode_slug()
        if mode_slug != "text":
            drive_cfg = common.get_drive_config(common.load_config())
            if not drive_cfg["web_app_url"]:
                if not messagebox.askyesno(
                        "Drive bridge not configured",
                        "This submission type needs the Drive bridge Web App URL (set it at the top of the "
                        "window) or student links/files won't be able to reach your Drive.\n\n"
                        "Continue anyway and set it up later?"):
                    return

        prompt = self.prompt_text.get("1.0", "end").strip()
        if not prompt:
            messagebox.showerror("Missing description", "Enter an assignment description.")
            return

        subject_slug = self._subject_slug()
        lesson_slug = self.lesson_var.get().strip()
        lesson_title = self._lesson_title(lesson_dir)

        assignment_html = common.load_template("assignment.html")
        assignment_html = (assignment_html
                            .replace("{{SUBJECT_SLUG}}", subject_slug)
                            .replace("{{LESSON_SLUG}}", lesson_slug)
                            .replace("{{LESSON_TITLE}}", lesson_title)
                            .replace("{{SUBMIT_MODE}}", mode_slug)
                            .replace("{{ASSIGN_PROMPT}}", prompt))
        with open(os.path.join(lesson_dir, "assignment.html"), "w", encoding="utf-8") as f:
            f.write(assignment_html)

        # Make sure the lesson's index.html actually links to the assignment
        # page (in case this lesson was generated with "include assignment"
        # unchecked, or this is the first time an assignment is being added).
        self._ensure_assignment_link(lesson_dir, subject_slug, lesson_slug)

        self.status_var.set("Updated assignment.html for {}/{} (mode: {})".format(
            subject_slug, lesson_slug, mode_slug))
        messagebox.showinfo("Done", "assignment.html updated for {}/{}.\n\nSubmission mode: {}".format(
            subject_slug, lesson_slug, self.mode_label_var.get()))

    def _ensure_assignment_link(self, lesson_dir, subject_slug, lesson_slug):
        index_path = os.path.join(lesson_dir, "index.html")
        if not os.path.exists(index_path):
            return
        with open(index_path, "r", encoding="utf-8") as f:
            content = f.read()
        if "assignment.html" in content:
            return
        link_block = (
            '      <a class="lesson-link frame" href="/{}/{}/assignment.html">\n'
            '        <div class="ll-title">Assignment</div>\n'
            '        <div class="ll-desc">Submit your work</div>\n'
            '        <span class="ll-go">Submit</span>\n'
            '      </a>\n'
        ).format(subject_slug, lesson_slug)
        marker = "{{ASSIGNMENT_LINK_BLOCK}}"
        if marker in content:
            content = content.replace(marker, link_block)
        else:
            # marker was already substituted at generation time (with "") —
            # splice the link back in right before the attachments block.
            content = re.sub(
                r'(\n    </div>\n\n    <div class="attachments")',
                "\n" + link_block + r'    </div>\n\n    <div class="attachments"',
                content, count=1)
        with open(index_path, "w", encoding="utf-8") as f:
            f.write(content)
