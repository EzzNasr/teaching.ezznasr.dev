#!/usr/bin/env python3
"""R-QM-BG: the Quiz Maker's background helper (modules/background.py).

Slow work (HTTP to the backend, writing lessons, the SEO build) runs in a worker thread so the window never
freezes. This checks the contract with a fake scheduler that is pumped on THIS thread (like Tk's after()):
results and errors come back on the main thread, a second run while one is busy is refused (double-click),
disabled buttons come back, cancel drops the result, the busy indicator is told. Then, if a real Tk display
is available, the same round trip through a real Tk root. No network.
"""
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..")))
from modules import background  # noqa: E402

fails = 0
MAIN = threading.get_ident()


def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)))
    fails += 0 if ok else 1


class FakeScheduler(object):
    """Stands in for a Tk widget: after() only queues; pump() runs the queue on the calling (main) thread."""

    def __init__(self):
        self.pending = []
        self.lock = threading.Lock()
        self.after_threads = set()

    def after(self, ms, fn):
        self.after_threads.add(threading.get_ident())
        with self.lock:
            self.pending.append(fn)

    def pump(self, until, timeout=5.0):
        end = time.time() + timeout
        while time.time() < end:
            with self.lock:
                todo, self.pending = self.pending, []
            for fn in todo:
                fn()
            if until():
                return True
            time.sleep(0.005)
        return False


class FakeButton(object):
    def __init__(self, state="normal"):
        self.state = state

    def cget(self, key):
        return self.state

    def config(self, state):
        self.state = state


# 1. a result comes back, on the main thread, and the worker really ran elsewhere
sch = FakeScheduler()
r = background.BackgroundRunner(sch, poll_ms=1)
seen = {}
r.set_indicator(on_start=lambda job: seen.setdefault("start", (job.name, threading.get_ident())),
                on_end=lambda job: seen.setdefault("end", (job.name, threading.get_ident())))
btn = FakeButton()


def task(job):
    seen["worker_thread"] = threading.get_ident()
    time.sleep(0.05)
    return 41 + 1


job = r.run(task, on_done=lambda v: seen.update(result=v, done_thread=threading.get_ident()),
            on_error=lambda e: seen.update(error=e), name="Generating", disable=[btn])
check("run returns a Job", isinstance(job, background.Job) and job.name == "Generating")
check("busy while running, button disabled", r.busy and btn.state == "disabled", (r.busy, btn.state))
check("indicator told on start (main thread)", seen.get("start") == ("Generating", MAIN), seen.get("start"))

# 2. double-click: a second run while busy is refused and never starts its task
refused = []
r.on_rejected = lambda busy_name, new_name: refused.append((busy_name, new_name))
ran_second = []
second = r.run(lambda j: ran_second.append(1), name="Generating")
check("second run while busy returns None", second is None)
check("on_rejected names the running job", refused == [("Generating", "Generating")], refused)

ok = sch.pump(lambda: "result" in seen)
check("result delivered", ok and seen.get("result") == 42, seen)
check("on_done ran on the main thread", seen.get("done_thread") == MAIN, seen.get("done_thread"))
check("task ran on a worker thread", seen.get("worker_thread") not in (None, MAIN))
check("after() was only ever called from the main thread", sch.after_threads == {MAIN}, sch.after_threads)
check("not busy afterwards, button restored", not r.busy and btn.state == "normal", (r.busy, btn.state))
check("indicator told on end (main thread)", seen.get("end") == ("Generating", MAIN), seen.get("end"))
check("refused second task never ran", ran_second == [])
check("no error reported", "error" not in seen)

# 3. an exception in the task comes back to on_error on the main thread; the button still comes back
seen.clear()
btn2 = FakeButton()


def boom(job):
    raise ValueError("bridge said no")


r.run(boom, on_done=lambda v: seen.update(result=v),
      on_error=lambda e: seen.update(error=e, err_thread=threading.get_ident()), name="Sending", disable=[btn2])
ok = sch.pump(lambda: "error" in seen)
check("error delivered", ok and isinstance(seen.get("error"), ValueError) and "bridge said no" in str(seen["error"]))
check("on_error ran on the main thread", seen.get("err_thread") == MAIN)
check("on_done not called after an error", "result" not in seen)
check("not busy after an error, button restored", not r.busy and btn2.state == "normal")

# 4. a disabled-before button stays disabled afterwards (restore, not force-enable)
already = FakeButton("disabled")
r.run(lambda j: 1, on_done=lambda v: seen.update(r4=v), disable=[already])
sch.pump(lambda: "r4" in seen)
check("a button that was already disabled stays disabled", already.state == "disabled")

# 5. a new job can start once the previous one is done (no stuck busy flag)
seen.clear()
r.run(lambda j: "again", on_done=lambda v: seen.update(again=v))
check("next job runs after the first finished", sch.pump(lambda: "again" in seen) and seen["again"] == "again")

# 6. cancel: only for cancellable jobs; on_done is never called; the runner is free at once
seen.clear()
gate = threading.Event()


def slow(job):
    gate.wait(5)
    return "late"


j = r.run(slow, on_done=lambda v: seen.update(late=v), on_error=lambda e: seen.update(err=e),
          name="Loading", cancellable=True)
check("cancel of a cancellable job succeeds", r.cancel() is True and j.cancelled)
check("runner free right after cancel", not r.busy)
gate.set()
time.sleep(0.05)
r.run(lambda jj: "fresh", on_done=lambda v: seen.update(fresh=v))
sch.pump(lambda: "fresh" in seen)
check("a cancelled job's late result is dropped", "late" not in seen and "err" not in seen, seen)
check("the job after a cancel still delivers", seen.get("fresh") == "fresh")

nc = r.run(lambda jj: (time.sleep(0.05), "kept")[1], on_done=lambda v: seen.update(kept=v), name="Writing")
check("cancel refused for a non-cancellable job", r.cancel() is False and not nc.cancelled and r.busy)
sch.pump(lambda: "kept" in seen)
check("non-cancellable job still delivers", seen.get("kept") == "kept")

# 7. the worker can see job.cancelled between steps
seen.clear()
steps = []
started = threading.Event()


def stepper(job):
    started.set()
    for i in range(50):
        if job.cancelled:
            return "stopped"
        steps.append(i)
        time.sleep(0.01)
    return "finished"


r.run(stepper, on_done=lambda v: seen.update(st=v), cancellable=True)
started.wait(2)
r.cancel()
time.sleep(0.1)
check("worker stops early once cancelled", 0 < len(steps) < 50, len(steps))

# 8. runner_for shares ONE runner per Tk root (dialogs included), using _root() when present
class FakeRoot(FakeScheduler):
    def _root(self):
        return self


class FakeChild(object):
    def __init__(self, root):
        self.root = root

    def _root(self):
        return self.root


root = FakeRoot()
a, b = FakeChild(root), FakeChild(root)
check("runner_for: same runner for two widgets of one window",
      background.runner_for(a) is background.runner_for(b) is background.runner_for(root))
seen.clear()
background.run_in_background(a, lambda j: "x", on_done=lambda v: seen.update(rib=v))
check("run_in_background delivers through the shared runner",
      background.runner_for(b).busy and root.pump(lambda: "rib" in seen) and seen["rib"] == "x")

# 9. real Tk round trip (skipped without tkinter or a display)
try:
    import tkinter as tk
    tkroot = tk.Tk()
except Exception as e:  # no tkinter / no display (CI)
    print("SKIP real-Tk round trip (%s)" % e.__class__.__name__)
else:
    tkroot.withdraw()
    out = {}
    tbtn = tk.Button(tkroot, text="Go")
    background.run_in_background(tbtn, lambda j: (time.sleep(0.05), threading.get_ident())[1],
                                 on_done=lambda v: out.update(worker=v, main=threading.get_ident()),
                                 disable=[tbtn], name="Real")
    disabled_while = str(tbtn.cget("state"))
    end = time.time() + 5
    while "main" not in out and time.time() < end:
        tkroot.update()
        time.sleep(0.005)
    check("real Tk: result back on the Tk thread", out.get("main") == MAIN and out.get("worker") != MAIN, out)
    check("real Tk: button disabled while running, normal after",
          disabled_while == "disabled" and str(tbtn.cget("state")) == "normal")
    tkroot.destroy()

print("\n%s (%d failure%s)" % ("ALL PASS" if not fails else "FAILED", fails, "" if fails == 1 else "s"))
sys.exit(1 if fails else 0)
