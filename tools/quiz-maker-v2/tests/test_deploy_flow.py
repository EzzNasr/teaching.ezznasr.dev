#!/usr/bin/env python3
"""R-QM-DEPLOY: the Settings window's backend deploy (modules/deploy_flow.py, modules/deploy_window.py).

Pure part: the script's "== N. step ==" lines become step ids; the file list comes from apps_script/deploy.json;
plain-words warnings for a dirty tree / unpushed commit / not main; the command and its refusals.
Window part (skipped without a display): the progress window runs a FAKE deploy script that prints the real
script's step lines, and must tick the steps, show success, a stop, and a rollback. Nothing reaches Google:
the real scripts/deploy_backend.js is never run here.
"""
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
QM = os.path.abspath(os.path.join(HERE, ".."))
SITE = os.path.abspath(os.path.join(QM, "..", ".."))
sys.path.insert(0, QM)
from modules import deploy_flow as df  # noqa: E402

fails = 0


def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)))
    fails += 0 if ok else 1


# 1. step lines
check("step: '== 1. preflight =='", df.step_of("== 1. preflight ==") == "1")
check("step: '== 4-5. stage and push =='", df.step_of("\n== 4-5. stage and push ==\n") == "4-5")
check("step: rollback line", df.step_of("== 8. ROLLBACK: the live smoke test failed ==") == "8")
check("step: dry run", df.step_of("== dry run ==") == "dry")
check("step: ordinary output is not a step", df.step_of("commit abc1234 on main (= origin/main)") is None
      and df.step_of("ALL GREEN") is None)

# 2. the file list (the real deploy.json in this repo)
files = df.files_to_sync(SITE)
code = [f for f in files if f["kind"] == "code"]
check("files: every repo file listed in deploy.json, in push order, exists",
      code and all(f["exists"] for f in code) and code[0]["repo"] == "Code.gs", [f["repo"] for f in code])
check("files: each shows its Apps Script name", all(f["live"].endswith(".gs") for f in code)
      and any(f["repo"] == "FollowupRouter.gs" and f["live"] == "Followuprouter.gs" for f in code))
check("files: the full source path is under tools/quiz-maker-v2/apps_script",
      all(f["path"].startswith(df.gs_dir(SITE)) for f in code))
check("files: the generated Version.gs and the manifest are listed too",
      any(f["kind"] == "generated" and f["live"] == "Version.gs" for f in files)
      and files[-1]["live"] == "appsscript.json")
try:
    df.files_to_sync(tempfile.mkdtemp())
    check("files: a folder without deploy.json is refused", False)
except ValueError as e:
    check("files: a folder without deploy.json is refused with a clear reason", "deploy.json" in str(e))
sid, dep, url = df.deploy_target(SITE)
check("target: the unchanged /exec URL comes from deploy.json", url.endswith(dep + "/exec") and sid)

# 3. warnings before confirming
good = {"commit": "a" * 40, "short": "aaaaaaa", "branch": "main", "dirty": False, "is_main": True, "on_github": True}
check("problems: clean pushed main has none", df.problems(good, False) == [])
check("problems: uncommitted changes", any("uncommitted" in p for p in df.problems(dict(good, dirty=True), False)))
check("problems: not on GitHub", any("not on GitHub" in p for p in df.problems(dict(good, on_github=False), False)))
br = dict(good, is_main=False, branch="hotfix")
check("problems: a branch needs the explicit allow", any("not origin/main" in p for p in df.problems(br, False))
      and df.problems(br, True) == [])
check("problems: not a git checkout", "not a git checkout" in df.problems({"commit": ""}, False)[0])

# 4. the command
empty = tempfile.mkdtemp()
argv, why = df.command(empty)
check("command: no script -> a reason, no argv", argv is None and "deploy_backend.js" in why)
os.makedirs(os.path.join(empty, "scripts"))
open(os.path.join(empty, "scripts", "deploy_backend.js"), "w").close()
argv, why = df.command(empty)
check("command: no clasp -> tells you npm ci + clasp login", argv is None and "npm ci" in why and "clasp login" in why)
os.makedirs(os.path.join(empty, "node_modules", "@google", "clasp"))
argv, why = df.command(empty, dry_run=True)
if argv is None:
    print("SKIP command flags (node not on PATH)")
else:
    check("command: dry run has no --yes", argv[1:] == ["scripts/deploy_backend.js"], argv)
    argv, _ = df.command(empty, dry_run=False, allow_branch=True)
    check("command: deploy = --yes, plus --allow-branch only when asked", argv[2:] == ["--yes", "--allow-branch"], argv)

# 5. the progress window against a fake script
try:
    import tkinter as tk
    _r = tk.Tk()
    _r.withdraw()
except Exception as e:
    print("SKIP progress window (%s)" % e.__class__.__name__)
else:
    from tkinter import messagebox
    from modules import deploy_window, theme
    for _n in ("showinfo", "showerror", "showwarning"):
        setattr(messagebox, _n, lambda *a, **k: None)
    theme.apply(_r)
    _r.status_var = tk.StringVar()
    toasts = []
    _r._toast_host = lambda t, m, k="success": toasts.append(t)

    def fake(script_text):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "fake_deploy.py")
        with open(p, "w", encoding="utf-8") as f:
            f.write(script_text)
        return p

    def run_window(script_text, dry):
        path = fake(script_text)
        real = df.command
        df.command = lambda site, dry_run=True, allow_branch=False: ([sys.executable, "-u", path], None)
        try:
            w = deploy_window.DeployProgressWindow(_r, SITE, dry, False)
            end = time.time() + 20
            while not w.finished and time.time() < end:
                _r.update()
                time.sleep(0.01)
            for _ in range(5):
                _r.update()
            return w
        finally:
            df.command = real

    ok_script = ("import time\nfor s in ['1. preflight','2. fast test gate','3. live check','4-5. stage and push',"
                 "'6. version and deployment','7. live smoke test','9. record']:\n"
                 "    print('== %s ==' % s, flush=True); print('working...', flush=True); time.sleep(0.05)\n"
                 "print('Recorded. Done: Version 71 = abc1234.')\n")
    w = run_window(ok_script, dry=False)
    icons = {k: v[0].cget("text") for k, v in w.rows.items()}
    check("window: every step ticked on success", all(icons[k] == "✓" for k in ("1", "2", "3", "4-5", "6", "7", "9")),
          icons)
    check("window: success heading and the script's last line", w.head_var.get().startswith("Deployed")
          and "Version 71" in w.sub_var.get(), (w.head_var.get(), w.sub_var.get()))
    check("window: a success toast", toasts and toasts[-1] == "Backend deployed", toasts)
    check("window: the log has the script's output", "working..." in w.log.get("1.0", "end"))
    w.destroy()

    stop_script = ("import sys\nprint('== 1. preflight ==', flush=True)\nprint('== 2. fast test gate ==', flush=True)\n"
                   "print('STOPPED: the test gate is not green', file=sys.stderr, flush=True)\nsys.exit(1)\n")
    w = run_window(stop_script, dry=False)
    check("window: a failed step is marked, earlier ones ticked",
          w.rows["1"][0].cget("text") == "✓" and w.rows["2"][0].cget("text") == "✕")
    check("window: 'nothing went live' and the reason", "nothing went live" in w.head_var.get()
          and w.sub_var.get() == "the test gate is not green", (w.head_var.get(), w.sub_var.get()))
    w.destroy()

    rb_script = ("import sys\nfor s in ['1. preflight','2. fast test gate','3. live check','4-5. stage and push',"
                 "'6. version and deployment','7. live smoke test','8. ROLLBACK: the live smoke test failed']:\n"
                 "    print('== %s ==' % s, flush=True)\n"
                 "print('STOPPED: the live smoke test failed. Rolled back.', flush=True)\nsys.exit(1)\n")
    w = run_window(rb_script, dry=False)
    check("window: a rollback adds its own row and says the old version is live",
          "8" in w.rows and w.head_var.get().startswith("Rolled back"), w.head_var.get())
    w.destroy()

    dry_script = ("for s in ['1. preflight','2. fast test gate','3. live check','dry run']:\n"
                  "    print('== %s ==' % s, flush=True)\nprint('Nothing was changed. Run again with --yes to deploy.')\n")
    w = run_window(dry_script, dry=True)
    check("window: dry run ends with 'nothing was changed'", "nothing was changed" in w.head_var.get()
          and w.rows["dry"][0].cget("text") == "✓", w.head_var.get())
    w.destroy()

    # the confirmation dialog: one click on clean pushed main (no typing), blocked with reasons otherwise
    dlg = deploy_window.DeployConfirmDialog(_r, SITE, dry_run=False)
    dlg.facts = dict(good)
    dlg._refresh()
    check("confirm: Deploy enabled at once on clean pushed main (nothing to type)",
          str(dlg.go_btn.cget("state")) == "normal" and not hasattr(dlg, "word_var"))
    dlg.facts = dict(good, dirty=True)
    dlg._refresh()
    check("confirm: a dirty tree blocks it and says why", str(dlg.go_btn.cget("state")) == "disabled"
          and "uncommitted" in dlg.warn_var.get())
    dlg.destroy()
    _r.destroy()

print("\n%s (%d failure%s)" % ("ALL PASS" if not fails else "FAILED", fails, "" if fails == 1 else "s"))
sys.exit(1 if fails else 0)
