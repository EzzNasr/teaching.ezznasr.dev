#!/usr/bin/env python3
"""
app_main.py — Quiz & Lesson Maker for teaching.ezznasr.dev, split into
three tabs sharing one site root and one Drive bridge config:

  1. Quiz Maker        — generate a lesson (index/quiz/assignment/attachments.json)
  2. Assignment Maker   — bigger description + text/url/file/both submission mode
  3. Attachment Maker   — upload files to your Drive, embedded on the lesson page
  4. Lesson Tags        — tag lessons with chapter/term for the grade subscriptions

Run:  python3 app_main.py
Requires only the Python standard library (tkinter, urllib).
"""

import os
import sys
import tkinter as tk
from tkinter import ttk, messagebox, filedialog

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from modules import common, drive_bridge, test_runner, teacher_mode, background
from modules.quiz_tab import QuizTab
from modules.assignment_tab import AssignmentTab
from modules.attachment_tab import AttachmentTab
from modules.tags_tab import TagsTab


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
        self.test_btn = tk.Button(btn_row, text="Test connection", command=self._test)
        self.test_btn.pack(side="left")
        tk.Button(btn_row, text="Save", command=self._save).pack(side="right", padx=6)
        tk.Button(btn_row, text="Cancel", command=self.destroy).pack(side="right")

        common.lock_min_width_to_content(self)
        self.transient(parent)
        self.grab_set()

    def _test(self):
        url, token = self.url_var.get().strip(), self.token_var.get().strip()

        def done(info):
            if not self.winfo_exists():       # the dialog was closed while the test ran
                return
            who = teacher_mode.badge_text(teacher_mode.identity_from_ping(info))
            messagebox.showinfo("Connected", "The Drive bridge responded successfully."
                                + ("\n\n" + who if who else ""), parent=self)

        def failed(e):
            if not self.winfo_exists():
                return
            messagebox.showerror("Connection failed", str(e) or e.__class__.__name__, parent=self)

        background.run_in_background(self, lambda job: drive_bridge.test_connection(url, token), done, failed,
                                     name="Testing the Drive bridge connection", disable=[self.test_btn])

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
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        # Teacher mode (Phase 4): a teacher token limits the subjects every tab offers. Must run BEFORE the tabs
        # are built (they read common.SUBJECTS once). Never raises; an unreachable server just means no filtering.
        # It pings the backend (up to ~8 s offline), so it runs in the background behind a small "checking"
        # panel, and the rest of the window is built when it answers (_finish_startup).
        self._show_startup_panel()

        def check_token(job):
            return teacher_mode.startup(self.config_data, common.SUBJECTS, common.get_drive_config)

        background.run_in_background(
            self, check_token, self._finish_startup,
            lambda e: self._finish_startup((None, "", "Could not check the token: %s" % e)),
            name="Checking the Drive bridge token")

    def _show_startup_panel(self):
        self._startup_panel = tk.Frame(self.content)
        self._startup_panel.pack(fill="x", padx=40, pady=60)
        tk.Label(self._startup_panel, text="Starting\u2026 checking your Drive bridge token",
                 font=("TkDefaultFont", 11)).pack(pady=(0, 10))
        bar = ttk.Progressbar(self._startup_panel, mode="indeterminate", length=320)
        bar.pack()
        bar.start(12)

    def _finish_startup(self, result):
        self.teacher_identity, self.teacher_badge, self.teacher_problem = result
        self._startup_panel.destroy()
        self._build_top_bar()
        self._install_busy_indicator()     # before the tabs: the Tags tab starts loading as it is built
        self._build_notebook()
        common.lock_min_width_to_content(self)
        common.enable_select_all_shortcut(self)

    def _on_close(self):
        job = background.runner_for(self).current
        if job is not None and job.name != "Checking the Drive bridge token" and not messagebox.askyesno(
                "Still working",
                "\u201c{}\u201d is still running. If you close now it stops halfway "
                "(a lesson may be left half-written or a change only half-sent).\n\nClose anyway?".format(job.name),
                icon="warning"):
            return
        common.stop_preview_server()
        self.destroy()

    # -- busy state: one shared progress bar for every background job (modules/background.py) -------------

    def _install_busy_indicator(self):
        runner = background.runner_for(self)
        runner.set_indicator(self._on_job_start, self._on_job_end)
        runner.on_rejected = self._on_job_rejected

    def _on_job_start(self, job):
        self.status_var.set(job.name + "\u2026")
        self.busy_bar.pack(side="left", padx=(8, 0))
        self.busy_bar.start(12)
        if job.cancellable:
            self.cancel_btn.pack(side="left", padx=(6, 0))
        self.configure(cursor="watch")

    def _on_job_end(self, job):
        self.busy_bar.stop()
        self.busy_bar.pack_forget()
        self.cancel_btn.pack_forget()
        self.configure(cursor="")

    def _on_job_rejected(self, busy_name, _new_name):
        self.bell()
        self.status_var.set("Still working on \u201c{}\u201d \u2014 please wait for it to finish.".format(busy_name))

    def _cancel_job(self):
        runner = background.runner_for(self)
        job = runner.current
        if job is not None and runner.cancel():
            self.status_var.set("Cancelled: {}.".format(job.name))

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
        # "Run tests": opens a terminal and streams scripts/test_all.sh live (see modules/test_runner.py)
        tests_btn = tk.Menubutton(row, text="Run tests \u25be", relief="raised", padx=8)
        tests_menu = tk.Menu(tests_btn, tearoff=0)
        for _mode, (_flags, _label) in test_runner.MODES.items():
            tests_menu.add_command(label=_label, command=lambda m=_mode: self._run_tests(m))
        tests_btn.configure(menu=tests_menu)
        tests_btn.pack(side="left")
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
        self.sync_btn = tk.Button(drow, text="Sync site assets", command=self._sync_assets)
        self.sync_btn.pack(side="left")
        self.resync_btn = tk.Button(drow, text="Resync lesson stylesheets", command=self._resync_lesson_stylesheets)
        self.resync_btn.pack(side="left", padx=(6, 0))
        tk.Label(drive_frame,
                 text="\"Sync site assets\" writes assets/auth.js, quiz.js, assign.js, attachments.js to your site "
                      "with the current Drive bridge URL baked in. Run it once after configuring, and again "
                      "any time you update this package.\n"
                      "\"Resync lesson stylesheets\" copies the current base.css/forms.css into every "
                      "already-generated lesson folder (newly generated lessons get this automatically) — "
                      "run it any time you change a lesson's accent color or edit base.css.",
                 fg="gray30", font=("TkDefaultFont", 8), justify="left").pack(anchor="w", padx=8, pady=(0, 6))

        self._update_drive_status()
        self.teacher_badge_var = tk.StringVar(value=self.teacher_badge or self.teacher_problem)
        tk.Label(drive_frame, textvariable=self.teacher_badge_var, anchor="w", fg="#0a6a3a",
                 font=("TkDefaultFont", 9, "bold")).pack(anchor="w", padx=8, pady=(0, 4))

        self.status_var = tk.StringVar(value="Ready.")
        status_row = tk.Frame(self.content)
        status_row.pack(fill="x", padx=10, pady=(0, 4))
        status_bar = tk.Label(status_row, textvariable=self.status_var, anchor="w", fg="gray30",
                               wraplength=600, justify="left")
        status_bar.pack(side="left", fill="x", expand=True)
        # shown only while a background job runs (see _on_job_start)
        self.busy_bar = ttk.Progressbar(status_row, mode="indeterminate", length=140)
        self.cancel_btn = tk.Button(status_row, text="Cancel", command=self._cancel_job)

        if resolved_source == "config":
            self.status_var.set("Site: " + resolved_path)
        elif resolved_source == "relative":
            self.status_var.set("Site found automatically near this app: " + resolved_path)
        elif resolved_source == "absolute-fallback":
            self.status_var.set("Site found at fallback location: " + resolved_path)
        else:
            self.status_var.set("Site folder not found automatically — click Browse to locate it "
                                 "(needs assets/ and CNAME inside).")

    def _run_tests(self, mode):
        """Open a terminal window running the master test gate; the app stays usable meanwhile."""
        err = test_runner.launch(self.site_root_var.get().strip(), mode)
        if err:
            messagebox.showerror("Run tests", err)
        else:
            self.status_var.set("Tests running in a separate terminal window...")

    def _pick_site_root(self):
        path = filedialog.askdirectory(title="Select your teaching-site repo folder")
        if path:
            self.site_root_var.set(path)
            self.config_data["site_root"] = path
            common.save_config(self.config_data)
            for tab in (self.quiz_tab, self.assignment_tab, self.attachment_tab, self.tags_tab):
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

            def recheck(job):
                return teacher_mode.startup(self.config_data, common.SUBJECTS, common.get_drive_config)

            def done(result):
                ident, badge, problem = result
                self.teacher_badge_var.set(badge or problem)
                self.status_var.set("Drive bridge settings saved.")
                if badge:
                    messagebox.showinfo("Restart needed", "If you changed the token, restart the app so the subject "
                                        "lists on every tab match it.")

            if background.run_in_background(
                    self, recheck, done,
                    lambda e: self.status_var.set("Drive bridge settings saved; token check failed: %s" % e),
                    name="Checking the new token") is None:
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
        # Sync overwrites assets/ from assets_templates/. If a live file was
        # edited directly (not in its template) that edit would be lost, so
        # say which files will really change and let the user stop first.
        # Both the comparison and the writing run in the background.
        web_app_url = drive_cfg["web_app_url"]
        background.run_in_background(
            self, lambda job: common.preview_site_assets_changes(site_root, web_app_url),
            lambda changes: self._sync_assets_confirm(site_root, web_app_url, changes),
            lambda e: self._job_failed("Sync site assets", e),
            name="Comparing site assets", disable=[self.sync_btn, self.resync_btn])

    def _sync_assets_confirm(self, site_root, web_app_url, changes):
        replaced = [c for c in changes if c[1] == "changed"]
        if replaced:
            listing = "\n".join("  {}   (+{} / -{} lines)".format(n, a, r) for n, _s, a, r in replaced)
            if not messagebox.askyesno(
                    "Replace live files?",
                    "These files in assets/ differ from the versions in assets_templates/ and will be "
                    "REPLACED by the template versions:\n\n" + listing + "\n\n"
                    "If you edited any of them directly in assets/ instead of in assets_templates/, "
                    "that edit will be lost. (Run  python check_asset_drift.py  to see the differences.)\n\n"
                    "Continue?"):
                self.status_var.set("Sync cancelled.")
                return

        def synced(written):
            self.status_var.set("Synced: " + ", ".join(os.path.basename(p) for p in written))
            messagebox.showinfo("Synced", "Updated:\n" + "\n".join(written))

        background.run_in_background(
            self, lambda job: common.sync_site_assets(site_root, web_app_url), synced,
            lambda e: self._job_failed("Sync site assets", e),
            name="Syncing site assets", disable=[self.sync_btn, self.resync_btn])

    def _job_failed(self, title, e):
        text = str(e) or e.__class__.__name__
        self.status_var.set("{} failed: {}".format(title, text.splitlines()[0]))
        messagebox.showerror(title, "{} failed:\n\n{}".format(title, text))

    def _resync_lesson_stylesheets(self):
        site_root = self.site_root_var.get().strip()
        if not site_root or not os.path.isdir(site_root):
            messagebox.showerror("Site location missing", "Pick a valid site root folder first.")
            return

        def resynced(touched):
            self.status_var.set("Resynced base.css/forms.css into {} lesson folder(s).".format(len(touched)))
            messagebox.showinfo("Resynced", "Updated base.css + forms.css in {} lesson folder(s).".format(len(touched)))

        background.run_in_background(
            self, lambda job: common.sync_all_lesson_stylesheets(site_root), resynced,
            lambda e: self._job_failed("Resync lesson stylesheets", e),
            name="Resyncing lesson stylesheets", disable=[self.sync_btn, self.resync_btn])

    # -- tabs ----------------------------------------------------------------

    def _build_notebook(self):
        notebook = ttk.Notebook(self.content)
        notebook.pack(fill="both", expand=True, padx=10, pady=(0, 10))

        self.quiz_tab = QuizTab(notebook, self.site_root_var, self.status_var,
                                 on_lessons_changed=self._refresh_all_lessons)
        self.assignment_tab = AssignmentTab(notebook, self.site_root_var, self.status_var)
        self.attachment_tab = AttachmentTab(notebook, self.site_root_var, self.status_var)
        self.tags_tab = TagsTab(notebook, self.site_root_var, self.status_var)

        notebook.add(self.quiz_tab, text="1. Quiz Maker")
        notebook.add(self.assignment_tab, text="2. Assignment Maker")
        notebook.add(self.attachment_tab, text="3. Attachment Maker")
        notebook.add(self.tags_tab, text="4. Lesson Tags")

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
