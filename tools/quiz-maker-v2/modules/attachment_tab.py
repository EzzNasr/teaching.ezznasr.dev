#!/usr/bin/env python3
"""
attachment_tab.py — Tab 3: Attachment Maker.

Uploads a local file to a predefined Google Drive folder (configured
server-side in apps_script/Code.gs — this app never sees or stores the
folder itself) through the Drive bridge Web App, then appends
{title, drive_file_id, type} to that lesson's attachments.json.

The lesson's index.html (see templates/lesson_index.html +
assets_templates/attachments.js) reads attachments.json at page-load
and renders each entry as an inline, proxied preview/download — the
student's browser only ever talks to your site and the Apps Script
Web App URL, never drive.google.com directly.
"""

import json
import os
import threading
import tkinter as tk
from tkinter import ttk, messagebox, filedialog

from modules import common, drive_bridge


class AttachmentTab(ttk.Frame):
    def __init__(self, parent, site_root_var, status_var):
        super().__init__(parent)
        self.site_root_var = site_root_var
        self.status_var = status_var
        self.selected_file_path = tk.StringVar(value="")
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
        subject_combo.bind("<<ComboboxSelected>>", lambda e: self._refresh_groups())

        row1b = tk.Frame(pick_frame)
        row1b.pack(fill="x", padx=8, pady=4)
        tk.Label(row1b, text="Group:", width=14, anchor="w").pack(side="left")
        self.group_var = tk.StringVar()
        self.group_combo = ttk.Combobox(row1b, textvariable=self.group_var, state="readonly", values=[])
        self.group_combo.pack(side="left", fill="x", expand=True)
        self.group_combo.bind("<<ComboboxSelected>>", lambda e: self._refresh_lessons())

        row2 = tk.Frame(pick_frame)
        row2.pack(fill="x", padx=8, pady=4)
        tk.Label(row2, text="Lesson:", width=14, anchor="w").pack(side="left")
        self.lesson_var = tk.StringVar()
        self.lesson_combo = ttk.Combobox(row2, textvariable=self.lesson_var, state="readonly", values=[])
        self.lesson_combo.pack(side="left", fill="x", expand=True)
        self.lesson_combo.bind("<<ComboboxSelected>>", lambda e: self._refresh_attachment_list())
        tk.Button(row2, text="Refresh", command=self._refresh_lessons).pack(side="left", padx=6)

        upload_frame = tk.LabelFrame(self, text="Upload a file")
        upload_frame.pack(fill="x", **pad)

        row3 = tk.Frame(upload_frame)
        row3.pack(fill="x", padx=8, pady=4)
        tk.Label(row3, text="File:", width=14, anchor="w").pack(side="left")
        tk.Entry(row3, textvariable=self.selected_file_path, state="readonly").pack(side="left", fill="x", expand=True)
        tk.Button(row3, text="Browse...", command=self._pick_file).pack(side="left", padx=6)

        row4 = tk.Frame(upload_frame)
        row4.pack(fill="x", padx=8, pady=4)
        tk.Label(row4, text="Display title:", width=14, anchor="w").pack(side="left")
        self.title_var = tk.StringVar()
        tk.Entry(row4, textvariable=self.title_var).pack(side="left", fill="x", expand=True)

        btn_row = tk.Frame(upload_frame)
        btn_row.pack(fill="x", padx=8, pady=8)
        self.upload_btn = tk.Button(btn_row, text="Upload to Drive & add to lesson",
                                     command=self._upload, font=("TkDefaultFont", 10, "bold"))
        self.upload_btn.pack(fill="x")
        tk.Label(upload_frame,
                 text="Uses the Drive bridge configured at the top of the window. The file lands in the "
                      "attachments folder set in Code.gs — students see it embedded on the lesson page, "
                      "never a drive.google.com link.",
                 fg="gray30", font=("TkDefaultFont", 8), justify="left").pack(anchor="w", padx=8, pady=(0, 6))

        list_frame = tk.LabelFrame(self, text="Attachments already on this lesson")
        list_frame.pack(fill="both", expand=True, **pad)
        inner = tk.Frame(list_frame)
        inner.pack(fill="both", expand=True, padx=8, pady=6)
        self.attach_listbox = tk.Listbox(inner)
        self.attach_listbox.pack(side="left", fill="both", expand=True)
        scrollbar = tk.Scrollbar(inner, command=self.attach_listbox.yview)
        scrollbar.pack(side="right", fill="y")
        self.attach_listbox.config(yscrollcommand=scrollbar.set)
        tk.Button(list_frame, text="Remove selected (from this lesson's list only)",
                  command=self._remove_selected).pack(anchor="w", padx=8, pady=(0, 8))

        self._group_map = {}
        self._refresh_groups()

    # -- helpers ----------------------------------------------------------

    def _subject_slug(self):
        label = self.subject_var.get()
        for slug, name in common.SUBJECTS:
            if name == label:
                return slug
        return common.slugify(label)

    def _group_relpath(self):
        return self._group_map.get(self.group_var.get(), "")

    def _lesson_dir(self):
        site_root = self.site_root_var.get().strip()
        subject_slug = self._subject_slug()
        group_relpath = self._group_relpath()
        lesson_slug = self.lesson_var.get().strip()
        if not (site_root and lesson_slug):
            return None
        return os.path.join(common.group_dir(site_root, subject_slug, group_relpath), lesson_slug)

    def _attachments_path(self):
        lesson_dir = self._lesson_dir()
        return os.path.join(lesson_dir, "attachments.json") if lesson_dir else None

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

    def _refresh_lessons(self):
        site_root = self.site_root_var.get().strip()
        subject_slug = self._subject_slug()
        group_relpath = self._group_relpath()
        lessons = common.list_existing_lessons(site_root, subject_slug, group_relpath) if site_root else []
        self.lesson_combo["values"] = lessons
        if lessons and self.lesson_var.get() not in lessons:
            self.lesson_var.set(lessons[0])
        elif not lessons:
            self.lesson_var.set("")
        self._refresh_attachment_list()

    def _load_attachments(self):
        path = self._attachments_path()
        if not path or not os.path.exists(path):
            return []
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []

    def _save_attachments(self, items):
        path = self._attachments_path()
        if not path:
            return
        with open(path, "w", encoding="utf-8") as f:
            json.dump(items, f, indent=2)

    def _refresh_attachment_list(self):
        self.attach_listbox.delete(0, "end")
        for item in self._load_attachments():
            self.attach_listbox.insert("end", "{}  ({})".format(item.get("title", "untitled"), item.get("type", "?")))

    def _pick_file(self):
        path = filedialog.askopenfilename(title="Choose a file to attach")
        if path:
            self.selected_file_path.set(path)
            if not self.title_var.get().strip():
                self.title_var.set(os.path.splitext(os.path.basename(path))[0])

    # -- upload -------------------------------------------------------------

    def _upload(self):
        lesson_dir = self._lesson_dir()
        if not lesson_dir or not os.path.isdir(lesson_dir):
            messagebox.showerror("No lesson selected", "Pick a subject and lesson first (generate it in the "
                                                         "Quiz Maker tab if it doesn't exist yet).")
            return

        file_path = self.selected_file_path.get().strip()
        if not file_path or not os.path.isfile(file_path):
            messagebox.showerror("No file chosen", "Pick a file to upload first.")
            return

        title = self.title_var.get().strip() or os.path.basename(file_path)

        drive_cfg = common.get_drive_config(common.load_config())
        if not drive_cfg["web_app_url"] or not drive_cfg["admin_token"]:
            messagebox.showerror("Drive bridge not configured",
                                  "Set the Drive bridge Web App URL and admin token at the top of the "
                                  "window first (see apps_script/Code.gs for deployment steps).")
            return

        self.upload_btn.config(state="disabled", text="Uploading...")
        self.status_var.set("Uploading " + os.path.basename(file_path) + " to Drive...")

        subject_slug = self._subject_slug()
        lesson_slug = self.lesson_var.get().strip()

        def worker():
            try:
                result = drive_bridge.upload_attachment(
                    drive_cfg["web_app_url"], drive_cfg["admin_token"],
                    subject_slug, lesson_slug, file_path, title)
                self.after(0, lambda: self._on_upload_done(result, file_path, title))
            except drive_bridge.DriveBridgeError as e:
                self.after(0, lambda: self._on_upload_failed(str(e)))

        threading.Thread(target=worker, daemon=True).start()

    def _on_upload_done(self, result, file_path, title):
        self.upload_btn.config(state="normal", text="Upload to Drive & add to lesson")
        ext = os.path.splitext(file_path)[1].lower().lstrip(".")
        items = self._load_attachments()
        items.append({
            "title": title,
            "drive_file_id": result.get("file_id"),
            "type": ext or "file",
        })
        self._save_attachments(items)
        self._refresh_attachment_list()
        self.selected_file_path.set("")
        self.title_var.set("")
        self.status_var.set("Uploaded and added \"{}\" to {}/{}/attachments.json".format(
            title, self._subject_slug(), self.lesson_var.get()))
        messagebox.showinfo("Uploaded", "\"{}\" is now attached to this lesson.".format(title))

    def _on_upload_failed(self, error_message):
        self.upload_btn.config(state="normal", text="Upload to Drive & add to lesson")
        self.status_var.set("Upload failed.")
        messagebox.showerror("Upload failed", error_message)

    def _remove_selected(self):
        sel = self.attach_listbox.curselection()
        if not sel:
            messagebox.showinfo("No selection", "Select an attachment to remove.")
            return
        idx = sel[0]
        items = self._load_attachments()
        if 0 <= idx < len(items):
            removed = items.pop(idx)
            self._save_attachments(items)
            self._refresh_attachment_list()
            self.status_var.set("Removed \"{}\" from this lesson's list. (The file itself still exists "
                                 "in Drive — delete it there separately if you want it gone entirely.)".format(
                                     removed.get("title", "")))
