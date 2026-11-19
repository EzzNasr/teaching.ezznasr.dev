#!/usr/bin/env python3
"""
app_main.py — Lesson Maker for teaching.ezznasr.dev: four sections (left sidebar) sharing one
site root and one Drive bridge config:

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

from modules import common, drive_bridge, test_runner, teacher_mode, background, theme, deploy_runner
from modules.settings_window import SettingsWindow
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
        save_btn = tk.Button(btn_row, text="Save", command=self._save, font=("TkDefaultFont", 10, "bold"))
        save_btn.pack(side="right", padx=6)
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


SECTIONS = (
    ("✎", "Quiz & lesson", "Make a new lesson, or open one to edit its page, quiz and assignment."),
    ("☑", "Assignment", "How students submit, the description, graded questions and videos."),
    ("⇪", "Attachments", "Upload files to your Drive and show them on a lesson page."),
    ("#", "Lesson tags", "Chapter and term tags on grade 1 and 2 lessons, for the subscriptions."),
)


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Lesson Maker — teaching.ezznasr.dev")
        theme.apply(self)                       # the site's palette, Segoe UI, flat cards (modules/theme.py)
        self.configure(bg=theme.P["bg"])

        # -- window sizing: fit the screen, and never shrink below a size where controls get pushed out of view.
        common.fit_geometry(self, 1180, 820, min_w=900, min_h=560)

        self.config_data = common.load_config()
        saved = self.config_data.get("ui_window_geometry")
        if isinstance(saved, str) and saved.count("x") == 1:
            try:                                   # where you left it last time (if it still fits the screen)
                w, rest = saved.split("x", 1)
                h = rest.split("+")[0]
                if int(w) <= self.winfo_screenwidth() and int(h) <= self.winfo_screenheight():
                    self.geometry(saved)
            except (ValueError, tk.TclError):
                pass
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        resolved_path, self._resolved_source = common.resolve_site_root(self.config_data.get("site_root", ""))
        self.site_root_var = tk.StringVar(value=resolved_path or "")
        if resolved_path and self._resolved_source != "config":
            self.config_data["site_root"] = resolved_path
            common.save_config(self.config_data)

        self._build_shell()

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

    # -- the frame of the window: sidebar | header / pages / status bar ------------------------------------

    def _build_shell(self):
        P = theme.P
        self.sidebar = tk.Frame(self, bg=P["nav"], width=260)
        self.sidebar._themed = True
        self.sidebar.pack(side="left", fill="y")
        self.sidebar.pack_propagate(False)
        brand = tk.Frame(self.sidebar, bg=P["nav"])
        brand.pack(fill="x", padx=20, pady=(22, 18))
        tk.Label(brand, text="Lesson Maker", bg=P["nav"], fg="#ffffff", font=theme.FONTS["brand"],
                 anchor="w").pack(fill="x")
        tk.Label(brand, text="teaching.ezznasr.dev", bg=P["nav"], fg=P["nav_dim"], font=theme.FONTS["small"],
                 anchor="w").pack(fill="x")
        self.nav_frame = tk.Frame(self.sidebar, bg=P["nav"])
        self.nav_frame.pack(fill="x")
        self.tools_frame = tk.Frame(self.sidebar, bg=P["nav"])
        self.tools_frame.pack(side="bottom", fill="x", pady=(0, 16))

        main = tk.Frame(self, bg=P["bg"])
        main._themed = True
        main.pack(side="left", fill="both", expand=True)

        header = tk.Frame(main, bg=P["panel"])
        header._themed = True
        header.pack(side="top", fill="x")
        tk.Frame(main, bg=P["line"], height=1).pack(side="top", fill="x")
        actions = tk.Frame(header, bg=P["panel"])
        actions.pack(side="right", padx=24)
        # the current page's main action (Generate / Update), so it is never a long scroll away
        self.page_action_btn = tk.Button(actions, text="", command=self._page_action)
        theme.style_button(self.page_action_btn, "primary")
        self.page_action_tip = theme.Tooltip(self.page_action_btn, lambda: self._page_action_tip)
        self._page_action_tip = ""
        self.dirty_var = tk.StringVar(value="")
        self.dirty_lbl = tk.Label(actions, textvariable=self.dirty_var, bg=P["panel"], fg=P["warn"],
                                  font=theme.FONTS["bold"])
        self.dirty_lbl.pack(side="left", padx=(0, 12))
        titles = tk.Frame(header, bg=P["panel"])
        titles.pack(side="left", fill="x", expand=True, padx=28, pady=(16, 14))
        self.page_title_var = tk.StringVar(value="Lesson Maker")
        self.page_sub_var = tk.StringVar(value="")
        tk.Label(titles, textvariable=self.page_title_var, bg=P["panel"], fg=P["ink"], font=theme.FONTS["title"],
                 anchor="w").pack(fill="x")
        tk.Label(titles, textvariable=self.page_sub_var, bg=P["panel"], fg=P["ink_dim"],
                 font=theme.FONTS["subtitle"], anchor="w", justify="left", wraplength=520).pack(fill="x")

        status_row = tk.Frame(main, bg=P["panel"])
        status_row._themed = True
        status_row.pack(side="bottom", fill="x")
        tk.Frame(main, bg=P["line"], height=1).pack(side="bottom", fill="x")
        self.status_var = tk.StringVar(value="Ready.")
        tk.Label(status_row, textvariable=self.status_var, anchor="w", bg=P["panel"], fg=P["ink_dim"],
                 font=theme.FONTS["small"], justify="left", wraplength=700).pack(
            side="left", fill="x", expand=True, padx=(24, 8), pady=8)
        # shown only while a background job runs (see _on_job_start)
        self.cancel_btn = tk.Button(status_row, text="Cancel", command=self._cancel_job)
        theme.style_button(self.cancel_btn, "secondary")
        self.cancel_btn.configure(pady=3)
        self.busy_bar = ttk.Progressbar(status_row, mode="indeterminate", length=160,
                                        style="Accent.Horizontal.TProgressbar")

        scroll = common.ScrollableFrame(main, bg=P["bg"])
        scroll.canvas.configure(bg=P["bg"])
        scroll.pack(fill="both", expand=True)
        self._scroll = scroll
        self.content = scroll.inner
        self.content.configure(bg=P["bg"])

        source, path = self._resolved_source, self.site_root_var.get()
        if source == "config":
            self.status_var.set("Site: " + path)
        elif source == "relative":
            self.status_var.set("Site found automatically near this app: " + path)
        elif source == "absolute-fallback":
            self.status_var.set("Site found at fallback location: " + path)
        else:
            self.status_var.set("Site folder not found automatically — open Settings (Ctrl+,) to "
                                "choose it (needs assets/ and CNAME inside).")

    def _show_startup_panel(self):
        P = theme.P
        self._startup_panel = tk.Frame(self.content, bg=P["panel"], highlightthickness=1,
                                       highlightbackground=P["line"])
        self._startup_panel._themed = True
        self._startup_panel.pack(padx=60, pady=80, ipadx=40, ipady=30)
        tk.Label(self._startup_panel, text="Starting…", bg=P["panel"], fg=P["ink"],
                 font=theme.FONTS["card"]).pack(pady=(0, 4))
        tk.Label(self._startup_panel, text="Checking your Drive bridge token", bg=P["panel"], fg=P["ink_dim"],
                 font=theme.FONTS["body"]).pack(pady=(0, 14))
        bar = ttk.Progressbar(self._startup_panel, mode="indeterminate", length=320,
                              style="Accent.Horizontal.TProgressbar")
        bar.pack()
        bar.start(12)

    def _finish_startup(self, result):
        self.teacher_identity, self.teacher_badge, self.teacher_problem = result
        self._startup_panel.destroy()
        self._build_top_bar()
        self._install_busy_indicator()     # before the tabs: the Tags tab starts loading as it is built
        self._build_notebook()
        theme.skin(self.content)
        self.quiz_tab.on_dirty_changed = self._show_dirty
        last = self.config_data.get("ui_last_section", 0)
        self.show_section(last if isinstance(last, int) and 0 <= last < len(SECTIONS) else 0)
        common.enable_select_all_shortcut(self)
        self._bind_shortcuts()
        self._toast = None
        self._toast_host = self._show_toast
        if not common.is_valid_site_root(self.site_root_var.get().strip()):
            self.after(300, self._configure_drive)        # first run / moved folder: open Settings

    def _on_close(self):
        job = background.runner_for(self).current
        if job is not None and job.name != "Checking the Drive bridge token" and not messagebox.askyesno(
                "Still working",
                "“{}” is still running. If you close now it stops halfway "
                "(a lesson may be left half-written or a change only half-sent).\n\nClose anyway?".format(job.name),
                icon="warning"):
            return
        quiz = getattr(self, "quiz_tab", None)
        if quiz is not None and getattr(quiz, "dirty", False) and job is None and not messagebox.askyesno(
                "Unsaved changes",
                "The lesson in the Quiz page has changes that were not generated yet.\n\nClose anyway and lose them?",
                icon="warning"):
            return
        try:
            self.config_data["ui_window_geometry"] = self.geometry()
            self.config_data["ui_last_section"] = getattr(self, "_section", 0)
            common.save_config(self.config_data)
        except Exception:
            pass
        common.stop_preview_server()
        self.destroy()

    # -- busy state: one shared progress bar for every background job (modules/background.py) -------------

    def _install_busy_indicator(self):
        runner = background.runner_for(self)
        runner.set_indicator(self._on_job_start, self._on_job_end)
        runner.on_rejected = self._on_job_rejected

    def _on_job_start(self, job):
        self.status_var.set(job.name + "…")
        if job.cancellable:
            self.cancel_btn.pack(side="right", padx=(0, 20), pady=6)
        self.busy_bar.pack(side="right", padx=(0, 12))
        self.busy_bar.start(12)
        self.configure(cursor="watch")

    def _on_job_end(self, job):
        self.busy_bar.stop()
        self.busy_bar.pack_forget()
        self.cancel_btn.pack_forget()
        self.configure(cursor="")

    def _on_job_rejected(self, busy_name, _new_name):
        self.bell()
        self.status_var.set("Still working on “{}” — please wait for it to finish.".format(busy_name))

    def _cancel_job(self):
        runner = background.runner_for(self)
        job = runner.current
        if job is not None and runner.cancel():
            self.status_var.set("Cancelled: {}.".format(job.name))

    # -- sidebar: site tools + Drive bridge connection ----------------------------------------------------

    def _sidebar_button(self, parent, text, command, tip=None):
        P = theme.P
        b = tk.Button(parent, text=text, command=command, anchor="w", bg=P["nav"], fg=P["nav_ink"],
                      activebackground=P["nav_hover"], activeforeground="#ffffff", relief="flat", bd=0,
                      highlightthickness=0, padx=20, pady=6, cursor="hand2", font=theme.FONTS["body"],
                      disabledforeground=P["nav_dim"])
        b.bind("<Enter>", lambda _e: b.configure(bg=P["nav_hover"]) if str(b.cget("state")) != "disabled" else None)
        b.bind("<Leave>", lambda _e: b.configure(bg=P["nav"]))
        b._themed = True
        if tip:
            theme.Tooltip(b, tip)
        return b

    def _build_top_bar(self):
        """Sidebar footer: the Drive bridge status and the Settings button. The site folder, the bridge's URL and
        token and the site tools live in the Settings window (modules/settings_window.py)."""
        P = theme.P
        self.sync_btn = self.resync_btn = None        # these buttons live in the Settings window while it is open
        tools = self.tools_frame
        conn = tk.Frame(tools, bg=P["nav_hover"], cursor="hand2")
        conn.pack(fill="x", padx=14, pady=(14, 8))
        tk.Label(conn, text="DRIVE BRIDGE", bg=P["nav_hover"], fg=P["nav_dim"], font=theme.FONTS["caps"],
                 anchor="w").pack(fill="x", padx=12, pady=(10, 0))
        row = tk.Frame(conn, bg=P["nav_hover"])
        row.pack(fill="x", padx=12, pady=(2, 2))
        self._drive_dot = tk.Label(row, text="\u25cf", bg=P["nav_hover"], font=theme.FONTS["body"])
        self._drive_dot.pack(side="left")
        self.drive_status_var = tk.StringVar()
        status_lbl = tk.Label(row, textvariable=self.drive_status_var, bg=P["nav_hover"], fg="#ffffff",
                              font=theme.FONTS["bold"], anchor="w")
        status_lbl.pack(side="left", padx=(6, 0))
        self.teacher_badge_var = tk.StringVar(value=self.teacher_badge or self.teacher_problem)
        tk.Label(conn, textvariable=self.teacher_badge_var, bg=P["nav_hover"], fg=P["nav_ink"],
                 font=theme.FONTS["small"], anchor="w", justify="left", wraplength=200).pack(fill="x", padx=12,
                                                                                             pady=(0, 10))
        for w in (conn, row, status_lbl, self._drive_dot):
            w.bind("<Button-1>", lambda _e: self._configure_drive())
        theme.Tooltip(conn, "Open Settings to change the Drive bridge, the site folder, or run the site tools")
        settings = self._sidebar_button(tools, "\u2699   Settings", self._configure_drive, "Settings (Ctrl+,)")
        settings.configure(font=theme.FONTS["nav"], pady=9)
        settings.pack(fill="x")
        self._update_drive_status()

    def _run_tests(self, mode):
        """Open a terminal window running the master test gate; the app stays usable meanwhile."""
        err = test_runner.launch(self.site_root_var.get().strip(), mode)
        if err:
            messagebox.showerror("Run tests", err)
        else:
            self.status_var.set("Tests running in a separate terminal window...")

    def _deploy_backend(self, mode):
        """Open a terminal running the backend deploy (dry run, or the real deploy after two confirmations)."""
        if mode == "deploy" and not messagebox.askyesno(
                "Deploy backend",
                "This replaces the LIVE backend (Apps Script) with the code in your site folder.\n\n"
                "- Not during a class or an open quiz window.\n"
                "- Run 'Check only' first.\n"
                "- The window will ask you to type DEPLOY.\n\nOpen the deploy window?", icon="warning"):
            return
        err = deploy_runner.launch(self.site_root_var.get().strip(), mode)
        if err:
            messagebox.showerror("Deploy backend", err)
        else:
            self.status_var.set("Backend %s running in a separate terminal window..." % ("check" if mode == "check" else "deploy"))

    def _pick_site_root(self, parent=None):
        path = filedialog.askdirectory(title="Select your teaching-site repo folder", parent=parent or self)
        if path:
            self.site_root_var.set(path)
            self.config_data["site_root"] = path
            common.save_config(self.config_data)
            self.status_var.set("Site: " + path)
            for tab in (self.quiz_tab, self.assignment_tab, self.attachment_tab, self.tags_tab):
                if hasattr(tab, "_refresh_groups"):
                    tab._refresh_groups()
                elif hasattr(tab, "_refresh_lessons"):
                    tab._refresh_lessons()

    def _update_drive_status(self):
        drive_cfg = common.get_drive_config(self.config_data)
        if drive_cfg["web_app_url"]:
            self.drive_status_var.set("Connected")
            self._drive_dot.configure(fg=theme.P["success"])
        else:
            self.drive_status_var.set("Not set up yet")
            self._drive_dot.configure(fg=theme.P["warn"])

    def _configure_drive(self):
        """Open (or bring forward) the Settings window."""
        win = getattr(self, "_settings_win", None)
        if win is not None and win.winfo_exists():
            win.deiconify()
            win.lift()
            win.focus_set()
            return
        self._settings_win = SettingsWindow(self)

    def _apply_drive_settings(self, url, token):
        """Save the Drive bridge URL/token (from the Settings window) and re-check who the token belongs to."""
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

    # -- toasts: success messages that don't need a click (theme.notify) -----------------------------------

    def _show_toast(self, title, message, kind="success"):
        P = theme.P
        if self._toast is not None:
            self._toast.destroy()
        self.last_toast = (title, message)
        t = tk.Frame(self, bg=P["ink"], cursor="hand2")
        t._themed = True
        tk.Frame(t, bg=P["success"] if kind == "success" else P["accent"], width=5).pack(side="left", fill="y")
        box = tk.Frame(t, bg=P["ink"])
        box.pack(side="left", fill="both", padx=(12, 16), pady=10)
        tk.Label(box, text=("\u2713  " if kind == "success" else "") + title, bg=P["ink"], fg="#ffffff",
                 font=theme.FONTS["bold"], anchor="w").pack(fill="x")
        if message:
            tk.Label(box, text=message, bg=P["ink"], fg=P["nav_ink"], font=theme.FONTS["small"], anchor="w",
                     justify="left", wraplength=380).pack(fill="x", pady=(2, 0))
        tk.Label(box, text="click to close", bg=P["ink"], fg=P["nav_dim"], font=theme.FONTS["caps"],
                 anchor="e").pack(fill="x", pady=(4, 0))
        t.place(relx=1.0, rely=1.0, x=-24, y=-52, anchor="se")
        t.lift()
        self._toast = t

        def close(_e=None, me=t):
            if self._toast is me:
                self._toast = None
            if me.winfo_exists():
                me.destroy()
        for w in [t, box] + list(box.winfo_children()):
            w.bind("<Button-1>", close)
        self.after(8000 if len(message) < 160 else 14000, close)

    # -- keyboard shortcuts, page action, unsaved marker --------------------------------------------------------

    def _bind_shortcuts(self):
        for i in range(len(SECTIONS)):
            self.bind_all("<Control-Key-%d>" % (i + 1), lambda _e, i=i: self.show_section(i))
        self.bind_all("<Control-comma>", lambda _e: self._configure_drive())
        self.bind_all("<Control-g>", lambda _e: self._page_action())
        self.bind_all("<F5>", lambda _e: self._on_tab_changed())

    def _page_action(self):
        tab = self.notebook.nametowidget(self.notebook.select())
        if tab is self.quiz_tab:
            self.quiz_tab._generate()
        elif tab is self.assignment_tab:
            self.assignment_tab._update()

    def _show_dirty(self, dirty):
        self.dirty_var.set("\u25cf  Unsaved changes" if dirty else "")

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
            theme.notify(self, "Synced", "Updated:\n" + "\n".join(written))

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
            theme.notify(self, "Resynced", "Updated base.css + forms.css in {} lesson folder(s).".format(len(touched)))

        background.run_in_background(
            self, lambda job: common.sync_all_lesson_stylesheets(site_root), resynced,
            lambda e: self._job_failed("Resync lesson stylesheets", e),
            name="Resyncing lesson stylesheets", disable=[self.sync_btn, self.resync_btn])

    # -- tabs ----------------------------------------------------------------

    def _build_notebook(self):
        notebook = ttk.Notebook(self.content, style="Pages.TNotebook")
        notebook.pack(fill="both", expand=True, padx=28, pady=(20, 28))

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

        # The sidebar is the tab row: one entry per section.
        P = theme.P
        self._nav_items = []
        for i, (icon, label, _sub) in enumerate(SECTIONS):
            row = tk.Frame(self.nav_frame, bg=P["nav"])
            row.pack(fill="x", pady=1)
            bar = tk.Frame(row, bg=P["nav"], width=4)
            bar.pack(side="left", fill="y")
            btn = tk.Button(row, text="{}    {}".format(icon, label), anchor="w", bg=P["nav"], fg=P["nav_ink"],
                            activebackground=P["nav_hover"], activeforeground="#ffffff", relief="flat", bd=0,
                            highlightthickness=0, padx=18, pady=9, cursor="hand2", font=theme.FONTS["nav"],
                            command=lambda i=i: self.show_section(i))
            btn.pack(side="left", fill="x", expand=True)
            btn.bind("<Enter>", lambda _e, i=i: self._nav_hover(i, True))
            btn.bind("<Leave>", lambda _e, i=i: self._nav_hover(i, False))
            self._nav_items.append((bar, btn))
        self._section = 0

    def show_section(self, index):
        """Switch the page (sidebar click): select the notebook page, light up its sidebar entry, set the header."""
        self._section = index
        self.notebook.select(index)
        P = theme.P
        for i, (bar, btn) in enumerate(self._nav_items):
            on = i == index
            bar.configure(bg=P["accent"] if on else P["nav"])
            btn.configure(bg=P["nav_active"] if on else P["nav"], fg="#ffffff" if on else P["nav_ink"],
                          font=(theme.FONTS["nav"][0], theme.FONTS["nav"][1], "bold") if on else theme.FONTS["nav"])
        # a ttk.Notebook is as tall as its tallest page; size it to this page so short pages don't scroll
        # into empty space (and stretchy lists don't grow into it)
        page = self.notebook.nametowidget(self.notebook.tabs()[index])
        self.update_idletasks()
        self.notebook.configure(height=page.winfo_reqheight())
        action = {0: ("Generate lesson files", "Write this lesson's files and send its quiz (Ctrl+G)"),
                  1: ("Update assignment page", "Write assignment.html for the selected lesson (Ctrl+G)")}.get(index)
        if action:
            self.page_action_btn.configure(text=action[0])
            self._page_action_tip = action[1]
            self.page_action_btn.pack(side="left")
        else:
            self.page_action_btn.pack_forget()
        self.dirty_lbl.pack_configure() if index == 0 else None
        self.dirty_var.set("\u25cf  Unsaved changes" if index == 0 and getattr(self.quiz_tab, "dirty", False) else "")
        self.page_title_var.set(SECTIONS[index][1])
        self.page_sub_var.set(SECTIONS[index][2])
        self._scroll.canvas.yview_moveto(0)

    def _nav_hover(self, index, inside):
        if index == self._section:
            return
        bar, btn = self._nav_items[index]
        btn.configure(bg=theme.P["nav_hover"] if inside else theme.P["nav"])

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
