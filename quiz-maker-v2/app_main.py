#!/usr/bin/env python3
"""
app_main.py — Quiz & Lesson Maker for teaching.ezznasr.dev, split into
three tabs sharing one site root and one Drive bridge config:

  1. Quiz Maker        — generate a lesson (index/quiz/assignment/attachments.json)
  2. Assignment Maker   — bigger description + text/url/file/both submission mode
  3. Attachment Maker   — upload files to your Drive, embedded on the lesson page

Run:  python3 app_main.py
Requires only the Python standard library (tkinter, urllib).
"""

import os
import sys
import tkinter as tk
from tkinter import ttk, messagebox, filedialog

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from modules import common, drive_bridge
from modules.quiz_tab import QuizTab
from modules.assignment_tab import AssignmentTab
from modules.attachment_tab import AttachmentTab


class DriveConfigDialog(tk.Toplevel):
    def __init__(self, parent, current_url, current_token):
        super().__init__(parent)
        self.title("Drive bridge settings")
        self.result = None
        common.fit_geometry(self, 520, 240, min_w=380, min_h=220)

        pad = {"padx": 12, "pady": 6}
        tk.Label(self, text="Apps Script Web App URL", anchor="w").pack(fill="x", **pad)
        self.url_var = tk.StringVar(value=current_url)
        tk.Entry(self, textvariable=self.url_var).pack(fill="x", padx=12)

        tk.Label(self, text="Admin token (from Code.gs Script Properties)", anchor="w").pack(fill="x", **pad)
        self.token_var = tk.StringVar(value=current_token)
        tk.Entry(self, textvariable=self.token_var, show="*").pack(fill="x", padx=12)

        tk.Label(self, text="See apps_script/Code.gs and apps_script/DEPLOY.md for how to get these.",
                 fg="gray30", font=("TkDefaultFont", 8), justify="left").pack(anchor="w", padx=12, pady=(10, 0))

        btn_row = tk.Frame(self)
        btn_row.pack(fill="x", pady=14, padx=12)
        tk.Button(btn_row, text="Test connection", command=self._test).pack(side="left")
        tk.Button(btn_row, text="Save", command=self._save).pack(side="right", padx=6)
        tk.Button(btn_row, text="Cancel", command=self.destroy).pack(side="right")

        common.lock_min_width_to_content(self)
        self.transient(parent)
        self.grab_set()

    def _test(self):
        try:
            drive_bridge.test_connection(self.url_var.get().strip(), self.token_var.get().strip())
            messagebox.showinfo("Connected", "The Drive bridge responded successfully.", parent=self)
        except drive_bridge.DriveBridgeError as e:
            messagebox.showerror("Connection failed", str(e), parent=self)

    def _save(self):
        self.result = (self.url_var.get().strip(), self.token_var.get().strip())
        self.destroy()


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Quiz, Assignment & Attachment Maker — teaching.ezznasr.dev")

        # -- visual polish: a cleaner ttk theme + slightly larger default
        #    font, applied globally so every tab benefits without each
        #    widget needing to be touched individually. -------------------
        style = ttk.Style(self)
        for candidate in ("clam", "vista", "alt", "default"):
            if candidate in style.theme_names():
                style.theme_use(candidate)
                break
        self.option_add("*Font", "TkDefaultFont 10")
        style.configure("TNotebook.Tab", padding=(14, 6))

        # -- window sizing: fit the screen instead of a fixed 820x780 that
        #    can run off small/scaled-up screens, and never let the window
        #    shrink below a size where controls (e.g. "Browse...") would
        #    be pushed out of view. ------------------------------------
        common.fit_geometry(self, 820, 780, min_w=640, min_h=480)

        # -- everything below lives in a scrollable container, so if the
        #    window is ever shorter than its content (small screen, high
        #    DPI scaling, etc.) you can scroll to reach it instead of
        #    controls being clipped off-window. -------------------------
        scroll = common.ScrollableFrame(self)
        scroll.pack(fill="both", expand=True)
        self.content = scroll.inner

        self.config_data = common.load_config()

        self._build_top_bar()
        self._build_notebook()
        common.lock_min_width_to_content(self)
        common.enable_select_all_shortcut(self)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _on_close(self):
        common.stop_preview_server()
        self.destroy()

    # -- shared top bar: site root + drive bridge --------------------------

    def _build_top_bar(self):
        pad = {"padx": 10, "pady": 6}

        root_frame = tk.LabelFrame(self.content, text="Site location")
        root_frame.pack(fill="x", **pad)

        resolved_path, resolved_source = common.resolve_site_root(self.config_data.get("site_root", ""))
        self.site_root_var = tk.StringVar(value=resolved_path or "")
        if resolved_path and resolved_source != "config":
            self.config_data["site_root"] = resolved_path
            common.save_config(self.config_data)

        row = tk.Frame(root_frame)
        row.pack(fill="x", padx=8, pady=6)
        tk.Entry(row, textvariable=self.site_root_var).pack(side="left", fill="x", expand=True)
        tk.Button(row, text="Browse...", command=self._pick_site_root).pack(side="left", padx=6)
        tk.Label(root_frame,
                 text="Path to your local teaching-site repo (the folder containing programming/, english/, "
                      "math/, assets/, CNAME). Shared by all three tabs below.",
                 fg="gray30", font=("TkDefaultFont", 8)).pack(anchor="w", padx=8, pady=(0, 6))

        drive_frame = tk.LabelFrame(self.content, text="Drive bridge (for file/link submissions & attachments)")
        drive_frame.pack(fill="x", **pad)
        drow = tk.Frame(drive_frame)
        drow.pack(fill="x", padx=8, pady=6)
        self.drive_status_var = tk.StringVar()
        tk.Label(drow, textvariable=self.drive_status_var, anchor="w").pack(side="left", fill="x", expand=True)
        tk.Button(drow, text="Configure...", command=self._configure_drive).pack(side="left", padx=6)
        tk.Button(drow, text="Sync site assets", command=self._sync_assets).pack(side="left")
        tk.Button(drow, text="Resync lesson stylesheets", command=self._resync_lesson_stylesheets).pack(side="left", padx=(6, 0))
        tk.Label(drive_frame,
                 text="\"Sync site assets\" writes assets/quiz.js, assign.js, attachments.js to your site "
                      "with the current Drive bridge URL baked in. Run it once after configuring, and again "
                      "any time you update this package.\n"
                      "\"Resync lesson stylesheets\" copies the current base.css/forms.css into every "
                      "already-generated lesson folder (newly generated lessons get this automatically) — "
                      "run it any time you change a lesson's accent color or edit base.css.",
                 fg="gray30", font=("TkDefaultFont", 8), justify="left").pack(anchor="w", padx=8, pady=(0, 6))

        self._update_drive_status()

        self.status_var = tk.StringVar(value="Ready.")
        status_bar = tk.Label(self.content, textvariable=self.status_var, anchor="w", fg="gray30",
                               wraplength=760, justify="left")
        status_bar.pack(fill="x", padx=10, pady=(0, 4))

        if resolved_source == "config":
            self.status_var.set("Site: " + resolved_path)
        elif resolved_source == "relative":
            self.status_var.set("Site found automatically near this app: " + resolved_path)
        elif resolved_source == "absolute-fallback":
            self.status_var.set("Site found at fallback location: " + resolved_path)
        else:
            self.status_var.set("Site folder not found automatically — click Browse to locate it "
                                 "(needs assets/ and CNAME inside).")

    def _pick_site_root(self):
        path = filedialog.askdirectory(title="Select your teaching-site repo folder")
        if path:
            self.site_root_var.set(path)
            self.config_data["site_root"] = path
            common.save_config(self.config_data)
            for tab in (self.quiz_tab, self.assignment_tab, self.attachment_tab):
                if hasattr(tab, "_refresh_groups"):
                    tab._refresh_groups()
                elif hasattr(tab, "_refresh_lessons"):
                    tab._refresh_lessons()

    def _update_drive_status(self):
        drive_cfg = common.get_drive_config(self.config_data)
        if drive_cfg["web_app_url"]:
            self.drive_status_var.set("Configured: " + drive_cfg["web_app_url"])
        else:
            self.drive_status_var.set("Not configured yet — required for file/link submissions and attachments.")

    def _configure_drive(self):
        drive_cfg = common.get_drive_config(self.config_data)
        dlg = DriveConfigDialog(self, drive_cfg["web_app_url"], drive_cfg["admin_token"])
        self.wait_window(dlg)
        if dlg.result:
            url, token = dlg.result
            common.save_drive_config(self.config_data, url, token)
            self._update_drive_status()
            self.status_var.set("Drive bridge settings saved.")

    def _sync_assets(self):
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site root folder first.")
            return
        drive_cfg = common.get_drive_config(self.config_data)
        if not drive_cfg["web_app_url"]:
            if not messagebox.askyesno("Drive bridge not configured",
                                        "No Web App URL set — synced assets will have URL/File submission "
                                        "and attachment embeds disabled until you configure it.\n\nSync anyway?"):
                return
        written = common.sync_site_assets(site_root, drive_cfg["web_app_url"])
        self.status_var.set("Synced: " + ", ".join(os.path.basename(p) for p in written))
        messagebox.showinfo("Synced", "Updated:\n" + "\n".join(written))

    def _resync_lesson_stylesheets(self):
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site root folder first.")
            return
        touched = common.sync_all_lesson_stylesheets(site_root)
        self.status_var.set("Resynced base.css/forms.css into {} lesson folder(s).".format(len(touched)))
        messagebox.showinfo("Resynced", "Updated base.css + forms.css in {} lesson folder(s).".format(len(touched)))

    # -- tabs ----------------------------------------------------------------

    def _build_notebook(self):
        notebook = ttk.Notebook(self.content)
        notebook.pack(fill="both", expand=True, padx=10, pady=(0, 10))

        self.quiz_tab = QuizTab(notebook, self.site_root_var, self.status_var,
                                 on_lessons_changed=self._refresh_all_lessons)
        self.assignment_tab = AssignmentTab(notebook, self.site_root_var, self.status_var)
        self.attachment_tab = AttachmentTab(notebook, self.site_root_var, self.status_var)

        notebook.add(self.quiz_tab, text="1. Quiz Maker")
        notebook.add(self.assignment_tab, text="2. Assignment Maker")
        notebook.add(self.attachment_tab, text="3. Attachment Maker")

        self.notebook = notebook
        # Auto-refresh: whenever you switch into the Assignment or Attachment
        # tab, re-scan the site for lessons — so a lesson just generated in
        # the Quiz Maker tab shows up immediately without a manual Refresh.
        notebook.bind("<<NotebookTabChanged>>", self._on_tab_changed)

    def _on_tab_changed(self, event=None):
        try:
            tab = self.notebook.nametowidget(self.notebook.select())
        except (tk.TclError, KeyError):
            return
        if hasattr(tab, "_refresh_lessons"):
            tab._refresh_lessons()

    def _refresh_all_lessons(self):
        """Called by the Quiz Maker tab right after generating or deleting
        a lesson, so the other tabs' lesson pickers update immediately —
        not just the next time you switch into them."""
        for tab in (self.quiz_tab, self.assignment_tab, self.attachment_tab):
            if hasattr(tab, "_refresh_lessons"):
                tab._refresh_lessons()


if __name__ == "__main__":
    app = App()
    app.mainloop()
