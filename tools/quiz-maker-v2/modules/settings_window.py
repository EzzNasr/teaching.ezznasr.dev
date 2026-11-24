"""settings_window.py - one Settings window for everything that is set once and rarely touched:
the site folder, the Drive bridge (URL, token, test), the site tools (sync assets, resync stylesheets, run
the tests) and the keyboard shortcuts. Opened from the sidebar (Settings) or Ctrl+, ; not modal, so the
main window stays usable. It calls the App's own methods, so behaviour is the same as before it moved here.
"""
import os
import tkinter as tk

from modules import background, common, deploy_flow, deploy_window, drive_bridge, teacher_mode, test_runner, theme

SHORTCUTS = (
    ("Ctrl+1 … Ctrl+4", "Switch section (Quiz, Assignment, Attachments, Lesson tags)"),
    ("Ctrl+G", "Generate lesson files (Quiz page) / Update assignment page (Assignment page)"),
    ("Ctrl+,", "Open Settings"),
    ("F5", "Rescan the site folder for lessons"),
    ("Ctrl+Z / Ctrl+Y", "Undo / redo a change to the question list"),
    ("In a question list", "Shift/Ctrl+click to select many · Ctrl+A all · Delete removes · "
                           "Ctrl+D duplicates · Alt+↑/↓ moves · Enter edits"),
)


class SettingsWindow(tk.Toplevel):
    def __init__(self, app):
        super().__init__(app)
        self.app = app
        self.title("Settings — Handasa Lesson Maker")
        self.configure(bg=theme.P["bg"])
        self._skinned = True                      # styled here, not by the generic dialog skin
        common.fit_geometry(self, 720, 780, min_w=600, min_h=480)
        self.transient(app)

        scroll = common.ScrollableFrame(self, bg=theme.P["bg"])
        scroll.canvas.configure(bg=theme.P["bg"])
        scroll.pack(fill="both", expand=True)
        body = scroll.inner
        body.configure(bg=theme.P["bg"])
        body._surface = theme.P["bg"]
        body._themed = False

        tk.Label(body, text="Settings", bg=theme.P["bg"], fg=theme.P["ink"], font=theme.FONTS["title"],
                 anchor="w").pack(fill="x", padx=24, pady=(20, 2))
        tk.Label(body, text="Set once, rarely changed. Changes apply right away.", bg=theme.P["bg"],
                 fg=theme.P["ink_dim"], anchor="w").pack(fill="x", padx=24, pady=(0, 14))

        self._build_site(body)
        self._build_drive(body)
        self._build_backend(body)
        self._build_tools(body)
        self._build_shortcuts(body)

        foot = tk.Frame(body)
        foot.pack(fill="x", padx=24, pady=(4, 20))
        tk.Button(foot, text="Close", command=self.destroy).pack(side="right")

        theme.skin(body)
        self.bind("<Escape>", lambda _e: self.destroy())
        self.protocol("WM_DELETE_WINDOW", self.destroy)

    def _card(self, parent, title):
        card = tk.LabelFrame(parent, text=title)
        card.pack(fill="x", padx=24, pady=(0, 14))
        return card

    # -- site folder -----------------------------------------------------------------------------------------

    def _build_site(self, body):
        card = self._card(body, "Site folder")
        tk.Label(card, text="Your local teaching-site repo: the folder with programming/, english/, math/, "
                            "assets/ and CNAME. Every section reads and writes lessons here.",
                 fg="gray30", font=("TkDefaultFont", 8), justify="left").pack(anchor="w", padx=8, pady=(0, 6))
        self.site_path_var = tk.StringVar()
        tk.Label(card, textvariable=self.site_path_var, anchor="w", justify="left", wraplength=560).pack(
            fill="x", padx=8)
        self.site_check_var = tk.StringVar()
        self._site_check = tk.Label(card, textvariable=self.site_check_var, anchor="w")
        self._site_check.pack(fill="x", padx=8, pady=(2, 8))
        row = tk.Frame(card)
        row.pack(fill="x", padx=8, pady=(0, 8))
        tk.Button(row, text="Change folder…", command=self._change_site).pack(side="left")
        tk.Button(row, text="Open in Explorer", command=self._open_site).pack(side="left", padx=6)
        self._show_site()

    def _show_site(self):
        path = self.app.site_root_var.get().strip()
        self.site_path_var.set(path or "(not set)")
        ok = bool(path) and common.is_valid_site_root(path)
        self.site_check_var.set("✓  Looks right: assets/ and CNAME are there." if ok else
                                "⚠  This doesn't look like the site folder (needs assets/ and CNAME inside).")
        self._site_check.configure(fg=theme.P["success"] if ok else theme.P["danger"], bg=theme.P["panel"])

    def _change_site(self):
        self.app._pick_site_root(parent=self)
        self._show_site()
        self.lift()

    def _open_site(self):
        path = self.app.site_root_var.get().strip()
        if path and os.path.isdir(path):
            try:
                os.startfile(path)                 # Windows; the app is a Windows tool
            except AttributeError:
                import subprocess
                import sys
                subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", path])

    # -- Drive bridge ----------------------------------------------------------------------------------------

    def _build_drive(self, body):
        card = self._card(body, "Drive bridge")
        tk.Label(card, text="Your Apps Script Web App. Needed for file/link submissions, attachments, locked "
                            "videos and synced quizzes. See apps_script/DEPLOY.md for where these come from.",
                 fg="gray30", font=("TkDefaultFont", 8), justify="left").pack(anchor="w", padx=8, pady=(0, 6))
        cfg = common.get_drive_config(self.app.config_data)
        grid = tk.Frame(card)
        grid.pack(fill="x", padx=8)
        grid.columnconfigure(1, weight=1)
        tk.Label(grid, text="Web App URL").grid(row=0, column=0, sticky="w", pady=4)
        self.url_var = tk.StringVar(value=cfg["web_app_url"])
        tk.Entry(grid, textvariable=self.url_var).grid(row=0, column=1, sticky="ew", padx=(10, 0), pady=4)
        tk.Label(grid, text="Token").grid(row=1, column=0, sticky="w", pady=4)
        self.token_var = tk.StringVar(value=cfg["admin_token"])
        self.token_entry = tk.Entry(grid, textvariable=self.token_var, show="•")
        self.token_entry.grid(row=1, column=1, sticky="ew", padx=(10, 0), pady=4)
        self.show_token_var = tk.BooleanVar(value=False)
        tk.Checkbutton(grid, text="Show", variable=self.show_token_var,
                       command=lambda: self.token_entry.configure(show="" if self.show_token_var.get() else "•")
                       ).grid(row=1, column=2, padx=(8, 0))
        self.drive_msg_var = tk.StringVar(value=self.app.teacher_badge_var.get())
        self._drive_msg = tk.Label(card, textvariable=self.drive_msg_var, anchor="w", justify="left", wraplength=560)
        self._drive_msg.pack(fill="x", padx=8, pady=(6, 4))
        row = tk.Frame(card)
        row.pack(fill="x", padx=8, pady=(2, 8))
        self.test_btn = tk.Button(row, text="Test connection", command=self._test)
        self.test_btn.pack(side="left")
        self.save_btn = tk.Button(row, text="Save", command=self._save, font=("TkDefaultFont", 10, "bold"))
        self.save_btn.pack(side="right")

    def _test(self):
        url, token = self.url_var.get().strip(), self.token_var.get().strip()

        def done(info):
            if self.winfo_exists():
                who = teacher_mode.badge_text(teacher_mode.identity_from_ping(info))
                self._say("✓  Connected." + ("  " + who if who else ""), ok=True)

        def failed(e):
            if self.winfo_exists():
                self._say("✕  " + (str(e) or e.__class__.__name__), ok=False)

        self._say("Testing…", ok=None)
        background.run_in_background(self, lambda job: drive_bridge.test_connection(url, token), done, failed,
                                     name="Testing the Drive bridge connection", disable=[self.test_btn])

    def _save(self):
        self.app._apply_drive_settings(self.url_var.get().strip(), self.token_var.get().strip())
        self._say("✓  Saved.", ok=True)

    def _say(self, text, ok):
        self.drive_msg_var.set(text)
        self._drive_msg.configure(fg=theme.P["ink_dim"] if ok is None else
                                  theme.P["success"] if ok else theme.P["danger"])

    # -- backend deploy ------------------------------------------------------------------------------------------

    def _build_backend(self, body):
        card = self._card(body, "Backend (Apps Script)")
        tk.Label(card, text="Sends the backend code in this folder (tools/quiz-maker-v2/apps_script/) to your live "
                            "Apps Script with scripts/deploy_backend.js: checks, test gate, push, a new version on "
                            "the same /exec URL, a live smoke test, and an automatic rollback if anything fails. "
                            "You see the exact file list before anything is sent. Never during a class or an open "
                            "quiz window.",
                 fg="gray30", font=("TkDefaultFont", 8), justify="left").pack(anchor="w", padx=8, pady=(0, 6))
        self.backend_info_var = tk.StringVar()
        tk.Label(card, textvariable=self.backend_info_var, anchor="w", justify="left", wraplength=560).pack(
            fill="x", padx=8, pady=(0, 6))
        row = tk.Frame(card)
        row.pack(fill="x", padx=8, pady=(0, 8))
        tk.Button(row, text="Check only (dry run)", command=lambda: deploy_window.start(self.app, True)).pack(side="left")
        tk.Button(row, text="Deploy to live…", command=lambda: deploy_window.start(self.app, False),
                  font=("TkDefaultFont", 10, "bold")).pack(side="left", padx=6)
        term = tk.Menubutton(row, text="In a terminal ▾")
        menu = tk.Menu(term, tearoff=0)
        menu.add_command(label="Check only, in a terminal", command=lambda: self.app._deploy_backend("check"))
        menu.add_command(label="Deploy, in a terminal (type DEPLOY there)", command=lambda: self.app._deploy_backend("deploy"))
        term.configure(menu=menu)
        term.pack(side="right")
        self._show_backend()

    def _show_backend(self):
        site = self.app.site_root_var.get().strip()
        try:
            files = deploy_flow.files_to_sync(site)
        except (ValueError, OSError) as e:
            self.backend_info_var.set("⚠  " + str(e))
            return
        _sid, _dep, url = deploy_flow.deploy_target(site)
        names = ", ".join(f["live"] for f in files if f["kind"] == "code")
        self.backend_info_var.set("{} files: {}  (+ appsscript.json, Version.gs)\nLive web app: {}".format(
            sum(1 for f in files if f["kind"] == "code"), names, url))

    # -- site tools ------------------------------------------------------------------------------------------

    def _build_tools(self, body):
        card = self._card(body, "Site tools")
        rows = (
            ("Sync site assets", self.app._sync_assets,
             "Writes assets/auth.js, quiz.js, assign.js, attachments.js with the current Drive bridge URL "
             "baked in. Run it once after setting up the bridge, and again whenever you update this tool."),
            ("Resync lesson stylesheets", self.app._resync_lesson_stylesheets,
             "Copies the current base.css / forms.css into every generated lesson folder (new lessons get "
             "them automatically). Run it after changing a lesson's accent colour or editing base.css."),
        )
        buttons = []
        for label, cmd, text in rows:
            r = tk.Frame(card)
            r.pack(fill="x", padx=8, pady=(0, 10))
            b = tk.Button(r, text=label, command=cmd, width=22)
            b.pack(side="left", anchor="n")
            tk.Label(r, text=text, fg="gray30", font=("TkDefaultFont", 8), justify="left",
                     wraplength=320).pack(side="left", padx=(12, 0), anchor="w")
            buttons.append(b)
        self.app.sync_btn, self.app.resync_btn = buttons     # disabled by the app while a sync runs
        r = tk.Frame(card)
        r.pack(fill="x", padx=8, pady=(0, 10))
        tests_btn = tk.Menubutton(r, text="Run tests  ▾", width=21)
        menu = tk.Menu(tests_btn, tearoff=0)
        for mode, (_flags, label) in test_runner.MODES.items():
            menu.add_command(label=label, command=lambda m=mode: self.app._run_tests(m))
        tests_btn.configure(menu=menu)
        tests_btn.pack(side="left", anchor="n")
        tk.Label(r, text="Opens a terminal and runs the site's full test gate (scripts/test_all.sh) live.",
                 fg="gray30", font=("TkDefaultFont", 8), justify="left", wraplength=320).pack(
            side="left", padx=(12, 0), anchor="w")

    def _build_shortcuts(self, body):
        card = self._card(body, "Keyboard shortcuts")
        grid = tk.Frame(card)
        grid.pack(fill="x", padx=8, pady=(0, 8))
        for i, (keys, what) in enumerate(SHORTCUTS):
            tk.Label(grid, text=keys, font=theme.FONTS["bold"], anchor="nw").grid(row=i, column=0, sticky="nw", pady=2)
            tk.Label(grid, text=what, anchor="w", justify="left", wraplength=430).grid(
                row=i, column=1, sticky="w", padx=(16, 0), pady=2)
