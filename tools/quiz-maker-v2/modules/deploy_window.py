"""deploy_window.py - the in-app backend deploy: a confirmation that lists exactly which files go where, then a
progress window that ticks off the deploy script's steps live and shows its log.

Nothing here talks to Google itself: it runs scripts/deploy_backend.js (the only supported way to deploy) and
reads its output. The script refuses on its own if the tree is dirty, the commit is not pushed, it is not main
(without --allow-branch), or the test gate is red; and it rolls back by itself if a later step fails.
"""
import os
import queue
import subprocess
import threading
import time
import tkinter as tk
from tkinter import messagebox, ttk

from modules import background, common, deploy_flow, theme



class DeployConfirmDialog(tk.Toplevel):
    """Shows the source folder, every file and its Apps Script name, the commit, and anything that will make the
    deploy stop. One click once nothing would make the script stop (dirty tree, unpushed commit, not main)."""

    def __init__(self, parent, site_root, dry_run):
        super().__init__(parent)
        self.site_root, self.dry_run = site_root, dry_run
        self.result = None                     # {"allow_branch": bool} when confirmed
        self.title("Check the backend deploy" if dry_run else "Deploy the backend to live")
        common.fit_geometry(self, 760, 700, min_w=560, min_h=480)
        P = theme.P

        files = deploy_flow.files_to_sync(site_root)
        self.facts = deploy_flow.git_facts(site_root)
        script_id, dep_id, url = deploy_flow.deploy_target(site_root)

        tk.Label(self, text=("Check what a deploy would change" if dry_run else "Deploy the backend to live?"),
                 font=theme.FONTS["title"], anchor="w").pack(fill="x", padx=20, pady=(16, 2))
        tk.Label(self, text=("A dry run: every check, then a list of what would change. Nothing is sent to Google."
                             if dry_run else
                             "These files replace the code your site's backend runs. Not during a class or an "
                             "open quiz window. If any step after the push fails, it rolls back by itself."),
                 fg="gray30", font=("TkDefaultFont", 8), justify="left", wraplength=700, anchor="w").pack(
            fill="x", padx=20)

        src = tk.LabelFrame(self, text="From this folder")
        src.pack(fill="x", padx=20, pady=(12, 8))
        tk.Label(src, text=os.path.normpath(deploy_flow.gs_dir(site_root)), anchor="w", justify="left", wraplength=660,
                 font=("Consolas", 9)).pack(fill="x", padx=8, pady=(0, 4))
        tk.Label(src, text="Commit {}  on  {}{}".format(self.facts["short"] or "?", self.facts["branch"] or "?",
                                                        "  (= origin/main)" if self.facts["is_main"] else ""),
                 anchor="w").pack(fill="x", padx=8, pady=(0, 6))

        lst = tk.LabelFrame(self, text="Files that will be synced ({})".format(len(files)))
        lst.pack(fill="both", expand=True, padx=20, pady=(0, 8))
        tree = ttk.Treeview(lst, columns=("repo", "live", "note"), show="headings", height=min(10, len(files)))
        for col, label, w in (("repo", "File in the repo", 190), ("live", "Becomes in Apps Script", 220),
                              ("note", "", 220)):
            tree.heading(col, text=label, anchor="w")
            tree.column(col, width=w, anchor="w", stretch=(col == "note"))
        for f in files:
            note = {"generated": "commit + time, made at deploy time", "manifest": "must match the live manifest"
                    }.get(f["kind"], "" if f["exists"] else "MISSING — the deploy will stop")
            tree.insert("", "end", values=(f["repo"], f["live"], note))
        tree.pack(fill="both", expand=True, padx=8, pady=(0, 8))

        tgt = tk.LabelFrame(self, text="To")
        tgt.pack(fill="x", padx=20, pady=(0, 8))
        tk.Label(tgt, text="Apps Script project  {}…\nWeb app (unchanged URL)  {}".format(script_id[:18], url),
                 anchor="w", justify="left", wraplength=660, font=("Consolas", 9)).pack(fill="x", padx=8, pady=(0, 6))

        self.allow_branch_var = tk.BooleanVar(value=False)
        opts = tk.Frame(self)
        opts.pack(fill="x", padx=20)
        if not self.facts["is_main"]:
            tk.Checkbutton(opts, text="Allow a commit that is not main (a hotfix or a rollback)",
                           variable=self.allow_branch_var, command=self._refresh).pack(anchor="w")
        self.warn_var = tk.StringVar()
        self.warn = tk.Label(self, textvariable=self.warn_var, fg=P["danger"], justify="left", anchor="w",
                             wraplength=700)
        self.warn.pack(fill="x", padx=20, pady=(6, 0))

        foot = tk.Frame(self)
        foot.pack(fill="x", padx=20, pady=14)
        self.go_btn = tk.Button(foot, text="Run the check" if dry_run else "Deploy to live", command=self._go,
                                font=("TkDefaultFont", 10, "bold") if dry_run else None,
                                fg=None if dry_run else "#8a1f1f")
        self.go_btn.pack(side="right")
        tk.Button(foot, text="Cancel", command=self.destroy).pack(side="right", padx=(0, 6))
        self._refresh()
        self.transient(parent)
        self.grab_set()
        self.bind("<Escape>", lambda _e: self.destroy())

    def _refresh(self):
        probs = deploy_flow.problems(self.facts, self.allow_branch_var.get())
        self.warn_var.set("\n".join("⚠  " + p for p in probs) +
                          ("\n(The check still runs and shows exactly where it stops.)" if probs and self.dry_run else ""))
        ok = self.dry_run or not probs      # a real deploy only when nothing would make the script stop
        self.go_btn.configure(state="normal" if ok else "disabled")

    def _go(self):
        self.result = {"allow_branch": self.allow_branch_var.get()}
        self.destroy()


class DeployProgressWindow(tk.Toplevel):
    """Runs the deploy script and shows its steps ticking off, a timer, and the full log."""

    def __init__(self, app, site_root, dry_run, allow_branch):
        super().__init__(app)
        self.app, self.site_root, self.dry_run = app, site_root, dry_run
        self.title("Backend check" if dry_run else "Backend deploy")
        common.fit_geometry(self, 760, 680, min_w=560, min_h=460)
        self.transient(app)
        self.lines = queue.Queue()
        self.proc = None
        self.started = time.time()
        self.current = None
        self.finished = False
        P = theme.P

        self.head_var = tk.StringVar(value="Checking…" if dry_run else "Deploying…")
        tk.Label(self, textvariable=self.head_var, font=theme.FONTS["title"], anchor="w").pack(fill="x", padx=20,
                                                                                               pady=(16, 2))
        self.sub_var = tk.StringVar(value="Running scripts/deploy_backend.js" + (" (dry run)" if dry_run else " --yes"))
        tk.Label(self, textvariable=self.sub_var, fg="gray30", font=("TkDefaultFont", 8), anchor="w",
                 justify="left", wraplength=700).pack(fill="x", padx=20)

        steps = tk.LabelFrame(self, text="Steps")
        steps.pack(fill="x", padx=20, pady=(12, 8))
        self.rows = {}
        order = list(deploy_flow.DRY_STEPS) if dry_run else [k for k, _ in deploy_flow.STEPS if k != "8"]
        labels = dict(deploy_flow.STEPS)
        labels["dry"] = "Done: dry run (nothing was changed)"
        for key in order:
            self._add_row(steps, key, labels[key])
        self._steps_frame, self._labels = steps, labels

        logf = tk.LabelFrame(self, text="Log")
        logf.pack(fill="both", expand=True, padx=20, pady=(0, 8))
        box = tk.Frame(logf)
        box.pack(fill="both", expand=True, padx=8, pady=(0, 8))
        self.log = tk.Text(box, height=10, wrap="word", font=("Consolas", 9), state="disabled")
        sb = ttk.Scrollbar(box, orient="vertical", command=self.log.yview)
        self.log.configure(yscrollcommand=sb.set)
        self.log.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

        foot = tk.Frame(self)
        foot.pack(fill="x", padx=20, pady=(0, 14))
        self.close_btn = tk.Button(foot, text="Close", command=self._close)
        self.close_btn.pack(side="right")
        tk.Button(foot, text="Copy log", command=self._copy).pack(side="right", padx=(0, 6))
        self.stop_btn = tk.Button(foot, text="Stop", command=self._stop)
        if dry_run:
            self.stop_btn.pack(side="left")
        else:
            tk.Label(foot, text="A deploy can't be stopped halfway; it rolls back by itself if a step fails.",
                     fg="gray30", font=("TkDefaultFont", 8)).pack(side="left")
        self.protocol("WM_DELETE_WINDOW", self._close)

        argv, why = deploy_flow.command(site_root, dry_run=dry_run, allow_branch=allow_branch)
        if argv is None:
            self._finish(None, why)
            return
        self._append("$ " + " ".join(os.path.basename(a) if i == 0 else a for i, a in enumerate(argv)) + "\n")
        job = background.run_in_background(self, lambda j: self._run(argv), self._on_exit,
                                           lambda e: self._finish(None, str(e)),
                                           name="Checking the backend deploy" if dry_run else "Deploying the backend")
        if job is None:
            self._finish(None, "Another job is still running; try again when it finishes.")
            return
        self._tick()

    # -- widgets -----------------------------------------------------------------------------------------------

    def _add_row(self, parent, key, text):
        row = tk.Frame(parent)
        row.pack(fill="x", padx=8, pady=1)
        icon = tk.Label(row, text="○", width=2, fg=theme.P["ink_dim"], font=theme.FONTS["bold"])
        icon.pack(side="left")
        lbl = tk.Label(row, text=text, anchor="w")
        lbl.pack(side="left")
        timer = tk.Label(row, text="", fg="gray30", font=("TkDefaultFont", 8))
        timer.pack(side="right")
        self.rows[key] = (icon, lbl, timer, row)

    def _mark(self, key, state):
        if key not in self.rows:
            if key == "8":          # rollback: a row that only appears when it happens
                self._add_row(self._steps_frame, "8", self._labels["8"])
            else:
                return
        icon, lbl, timer, _row = self.rows[key]
        P = theme.P
        glyph, colour = {"run": ("●", P["accent"]), "ok": ("✓", P["success"]),
                         "fail": ("✕", P["danger"]), "warn": ("⟲", P["warn"])}[state]
        icon.configure(text=glyph, fg=colour)
        lbl.configure(font=theme.FONTS["bold"] if state == "run" else theme.FONTS["body"],
                      fg=P["danger"] if state == "fail" else P["ink"])
        if state != "run":
            timer.configure(text="")

    def _append(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", text)
        self.log.see("end")
        self.log.configure(state="disabled")

    # -- running -----------------------------------------------------------------------------------------------

    def _run(self, argv):
        """Worker thread: run the script, hand every line to the window's queue. Returns the exit code."""
        env = dict(os.environ, FORCE_COLOR="0", NO_COLOR="1")
        self.proc = subprocess.Popen(argv, cwd=self.site_root, env=env, **deploy_flow.popen_kwargs())
        for line in self.proc.stdout:
            self.lines.put(line)
        return self.proc.wait()

    def _tick(self):
        """Main thread, every 100 ms: take new lines, move the step marks, update the timers."""
        try:
            if not self.winfo_exists():
                return
        except tk.TclError:
            return
        try:
            while True:
                line = self.lines.get_nowait()
                self._append(line)
                key = deploy_flow.step_of(line)
                if key:
                    if self.current:
                        self._mark(self.current, "ok")
                    self.current = key
                    self._step_started = time.time()
                    self._mark(key, "warn" if key == "8" else "run")
        except queue.Empty:
            pass
        if self.current and self.current in self.rows and not self.finished:
            self.rows[self.current][2].configure(text="%ds" % (time.time() - self._step_started))
        if not self.finished:
            self.sub_var.set("Running for %ds — scripts/deploy_backend.js%s" % (
                time.time() - self.started, " (dry run)" if self.dry_run else " --yes"))
            self.after(100, self._tick)

    def _on_exit(self, code):
        # drain what is left, then judge (the window may already be closed: the deploy ran on without it)
        try:
            if self.winfo_exists():
                self.after(150, lambda: self._finish(code, None))
                return
        except tk.TclError:
            pass
        if code == 0 and not self.dry_run:
            theme.notify(self.app, "Backend deployed", "scripts/deploy_backend.js finished successfully.")
        elif code != 0:
            self.app.status_var.set("The backend %s stopped (exit %s); run Check only to see why."
                                    % ("check" if self.dry_run else "deploy", code))

    def _finish(self, code, error):
        try:
            while True:
                self._append(self.lines.get_nowait())
        except queue.Empty:
            pass
        self.finished = True
        P = theme.P
        text = self.log.get("1.0", "end")
        rolled_back = "ROLLBACK" in text
        if error is not None:
            self.head_var.set("Couldn't start")
            self.sub_var.set(error)
            self._append("\n" + error + "\n")
        elif code == 0:
            if self.current:
                self._mark(self.current, "ok")
            self.head_var.set("Check finished — nothing was changed" if self.dry_run else "Deployed ✓")
            last = [l for l in text.splitlines() if l.strip()]
            self.sub_var.set(last[-1] if last else "")
            if not self.dry_run:
                theme.notify(self.app, "Backend deployed", self.sub_var.get())
        else:
            if self.current:
                self._mark(self.current, "warn" if rolled_back and self.current == "8" else "fail")
            stop = [l for l in text.splitlines() if l.startswith("STOPPED:")]
            self.head_var.set("Rolled back — the previous version is live again" if rolled_back else
                              ("Check stopped" if self.dry_run else "Deploy stopped — nothing went live"))
            self.sub_var.set(stop[-1][len("STOPPED:"):].strip() if stop else "Exit code %s. See the log." % code)
        self.stop_btn.configure(state="disabled")
        self.close_btn.configure(font=theme.FONTS["primary"])

    def _stop(self):
        if self.proc and self.proc.poll() is None and self.dry_run:
            self.proc.kill()
            self._append("\n(stopped by you)\n")

    def _copy(self):
        self.clipboard_clear()
        self.clipboard_append(self.log.get("1.0", "end"))
        self.app.status_var.set("Deploy log copied.")

    def _close(self):
        if not self.finished and not self.dry_run:
            messagebox.showinfo("Still deploying", "The deploy keeps running in the background; it will finish "
                                "(or roll back) by itself. This window will close.", parent=self)
        self.destroy()


def start(app, dry_run):
    """Settings window entry point: confirm, then run."""
    site_root = app.site_root_var.get().strip()
    try:
        dlg = DeployConfirmDialog(app, site_root, dry_run)
    except ValueError as e:
        messagebox.showerror("Deploy backend", str(e))
        return
    app.wait_window(dlg)
    if dlg.result is None:
        return
    DeployProgressWindow(app, site_root, dry_run, dlg.result["allow_branch"])
