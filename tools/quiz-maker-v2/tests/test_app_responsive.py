#!/usr/bin/env python3
"""R-QM-BG-2: the real Quiz Maker window stays responsive while it generates and sends.

Builds the actual App (app_main.App) against a temp copy of the site and a local fake backend that takes
0.5 s per call (Apps Script is often slower). Then: the token check at startup, Generate lesson files
(clicked twice: a double-click), Load for editing, and Sync site assets. While each runs, a 20 ms Tk timer
measures the longest gap: before this fix the window froze for seconds ("Not responding").
Skipped without tkinter or a display (CI). No real network; dialogs are answered automatically.
"""
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
QM = os.path.abspath(os.path.join(HERE, ".."))
SITE_SRC = os.path.abspath(os.path.join(QM, "..", ".."))
sys.path.insert(0, QM)

fails = 0
MAX_STALL = 0.5          # seconds; each backend call alone takes DELAY
DELAY = 0.5


def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)))
    fails += 0 if ok else 1


try:
    import tkinter as tk
    _probe = tk.Tk()
    _probe.destroy()
except Exception as e:
    print("SKIP no tkinter / no display (%s)" % e.__class__.__name__)
    sys.exit(0)

CALLS = []
STORE = {"quiz": {}, "videos": []}


class Backend(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        a = body.get("action")
        CALLS.append(a)
        time.sleep(DELAY)
        r = {"ok": True}
        if a == "admin_set_quiz_content":
            STORE["quiz"][body["lesson"]] = json.loads(body["content_json"])
        elif a == "admin_get_quiz_content":
            r["quiz"] = STORE["quiz"].get(body["lesson"])
        elif a in ("admin_list_videos",):
            r["videos"] = STORE["videos"]
        elif a == "admin_list_lesson_tags":
            r["tags"] = []
        elif a == "admin_get_written_models":
            r["models"] = []
        out = json.dumps(r).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Backend)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:%d/exec" % srv.server_address[1]

tmp = tempfile.mkdtemp(prefix="qm_responsive_")
site = os.path.join(tmp, "site")
os.makedirs(site)
for name in ("CNAME", "index.html"):
    shutil.copy(os.path.join(SITE_SRC, name), site)
for name in ("assets", "programming"):
    shutil.copytree(os.path.join(SITE_SRC, name), os.path.join(site, name))

from modules import common, background  # noqa: E402
common.CONFIG_PATH = os.path.join(tmp, "config.json")
json.dump({"site_root": site, "drive_web_app_url": URL, "drive_admin_token": "tok"}, open(common.CONFIG_PATH, "w"))

from tkinter import messagebox  # noqa: E402
DIALOGS = []
for _n in ("showinfo", "showerror", "showwarning", "askyesno"):
    setattr(messagebox, _n, (lambda n: lambda title, msg="", **kw: DIALOGS.append((n, title)) or True)(_n))

import app_main  # noqa: E402

app = app_main.App()
app.withdraw()
gap = {"max": 0.0, "last": time.time()}


def tick():
    now = time.time()
    gap["max"] = max(gap["max"], now - gap["last"])
    gap["last"] = now
    app.after(20, tick)


def runner():
    return background.runner_for(app)


def pump_until(cond, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        app.update()
        if cond():
            return True
        time.sleep(0.005)
    return False


def measure(label, start):
    """Run start() then pump until the job is done; -> longest UI gap in seconds."""
    del DIALOGS[:]
    del CALLS[:]
    gap["max"], gap["last"] = 0.0, time.time()
    start()
    started_busy = runner().busy
    ok = pump_until(lambda: not runner().busy)
    for _ in range(3):
        app.update()
    check(label + ": ran as a background job and finished", started_busy and ok, (started_busy, ok))
    check(label + ": window kept responding (longest gap %d ms)" % (gap["max"] * 1000), gap["max"] < MAX_STALL,
          "%.2f s" % gap["max"])
    return gap["max"]


app.after(20, tick)
# 1. startup: the window exists at once; the tabs appear when the token check answers
check("startup: a 'checking' panel shows while the token is checked", hasattr(app, "_startup_panel") and runner().busy)
check("startup: tabs built after the check", pump_until(lambda: hasattr(app, "quiz_tab") and not runner().busy))
pump_until(lambda: not runner().busy)                 # the Tags tab loads its tags as it is built

# 2. Generate, double-clicked
q = app.quiz_tab
q.group_var.set(list(q._group_map.keys())[0])
q.lesson_name_var.set("Responsive Check")
q.include_assignment_var.set(True)
q.questions = [{"type": "mcq", "q": "2+2?", "choices": ["3", "4"], "answer": [1], "chapter": "1"}]


def double_click():
    q._generate()
    check("generate: button disabled while running", str(q.generate_btn.cget("state")) == "disabled")
    q._generate()                                      # second click while the first is running


measure("generate", double_click)
lesson_dir = os.path.join(common.group_dir(site, "programming", q._group_relpath()), "responsive-check")
check("generate: files written", all(os.path.isfile(os.path.join(lesson_dir, f))
                                     for f in ("index.html", "quiz.html", "assignment.html", "attachments.json")))
check("generate: double-click sent the quiz once", CALLS.count("admin_set_quiz_content") == 1, CALLS)
check("generate: 'Done' shown once, as a toast (no click needed)",
      not [d for d in DIALOGS if d[1] == "Done"] and getattr(app, "last_toast", ("",))[0] == "Done",
      (DIALOGS, getattr(app, "last_toast", None)))
check("generate: button enabled again", str(q.generate_btn.cget("state")) == "normal")
check("generate: status reports the result", app.status_var.get().startswith("Generated "), app.status_var.get())

# 2b. the question list: select several, remove them in one step, undo brings them back
q.questions = [{"type": "mcq", "prompt": "p%d" % i, "options": ["a", "b"], "correct": [0], "chapter": 1}
               for i in range(5)]
q._refresh_listbox()
q.qpanel.tree.selection_set(("1", "3"))
app.update()
check("question list: 'Remove 2 selected' offered", q.qpanel.remove_btn.cget("text") == "Remove 2 selected",
      q.qpanel.remove_btn.cget("text"))
q.qpanel.remove_selected()
check("question list: both removed at once", [x["prompt"] for x in q.questions] == ["p0", "p2", "p4"],
      [x["prompt"] for x in q.questions])
check("question list: the form is marked unsaved", q.dirty)
q.focus_set()
q._handle_undo()
check("question list: one Ctrl+Z restores both", [x["prompt"] for x in q.questions] == ["p0", "p1", "p2", "p3", "p4"],
      [x["prompt"] for x in q.questions])

# 3. Load for editing (read-only: offers Cancel)
q._new_lesson()
q.delete_lesson_var.set("responsive-check")
measure("load for editing", q._load_lesson_for_edit)
check("load for editing: form filled", q.lesson_name_var.get() == "Responsive Check" and len(q.questions) == 1,
      (q.lesson_name_var.get(), q.questions))

q.delete_lesson_var.set("responsive-check")
q._load_lesson_for_edit()
check("load for editing: Cancel button shown", app.cancel_btn.winfo_manager() == "pack")
app._cancel_job()
check("load for editing: cancel frees the app at once", not runner().busy and "Cancelled" in app.status_var.get(),
      app.status_var.get())
check("load for editing: Cancel button hidden again", app.cancel_btn.winfo_manager() == "")

# 4. Sync site assets
measure("sync site assets", app._sync_assets)
check("sync site assets: confirmed with a toast", getattr(app, "last_toast", ("",))[0] == "Synced",
      getattr(app, "last_toast", None))

app.destroy()
srv.shutdown()
shutil.rmtree(tmp, ignore_errors=True)
print("\n%s (%d failure%s)" % ("ALL PASS" if not fails else "FAILED", fails, "" if fails == 1 else "s"))
sys.exit(1 if fails else 0)
