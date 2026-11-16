"""background.py - run slow work (network, git, file generation) off the Tk main thread.

Tk is single-threaded: a callback that blocks (an HTTP call to the Apps Script /exec endpoint, writing a lesson,
the SEO build) freezes the whole window ("Not responding") until it returns. Use this instead:

    background.run_in_background(widget, task, on_done, on_error, name="Generating lesson")

  * task(job) runs in a worker thread. It must NOT touch any widget or tk variable: read what it needs from the
    form BEFORE starting and pass it in. It may check job.cancelled between steps.
  * on_done(result) / on_error(exc) run on the Tk main thread. The worker never calls Tk: it puts the outcome on
    a queue and the main thread picks it up with after() polling.
  * One job at a time per window. A second run() while one is busy (a double-click, or another button) is
    refused and returns None, so nothing runs twice.
  * Cancel (when the job allows it) means "stop waiting and discard the result": on_done/on_error are not called.
    The worker thread itself cannot be killed mid-HTTP-call, so only offer it for jobs that do not write.

The window can show a busy state through set_indicator(on_start, on_end) (app_main does: progress bar, Cancel
button, status text). Standard library only; no tkinter import, so it is unit-testable with a fake scheduler.
"""
import queue
import threading
import traceback


class Job(object):
    """One background run. `cancelled` is safe to read from the worker."""

    def __init__(self, name, cancellable):
        self.name = name
        self.cancellable = cancellable
        self._cancel = threading.Event()

    @property
    def cancelled(self):
        return self._cancel.is_set()

    def cancel(self):
        if self.cancellable:
            self._cancel.set()


class BackgroundRunner(object):
    """`scheduler` is anything with after(ms, fn): a Tk widget, or a fake in tests."""

    def __init__(self, scheduler, poll_ms=40):
        self._scheduler = scheduler
        self._poll_ms = poll_ms
        self._queue = queue.Queue()
        self._job = None
        self._disabled = []
        self._on_start = None
        self._on_end = None
        self.on_rejected = None          # fn(busy_job_name, refused_name), main thread

    # -- state -------------------------------------------------------------------------------------------------

    @property
    def busy(self):
        return self._job is not None

    @property
    def current(self):
        return self._job

    def set_indicator(self, on_start=None, on_end=None):
        """on_start(job) / on_end(job) run on the main thread when a job starts / finishes (or is cancelled)."""
        self._on_start, self._on_end = on_start, on_end

    def cancel(self):
        """Main thread: give up on the current job if it allows that. Returns True if it was cancelled."""
        job = self._job
        if job is None or not job.cancellable:
            return False
        job.cancel()
        self._finish(job)
        return True

    # -- run ---------------------------------------------------------------------------------------------------

    def run(self, task, on_done=None, on_error=None, name="Working", disable=(), cancellable=False):
        """Start task(job) in a worker thread. Returns the Job, or None when another job is still running."""
        if self._job is not None:
            if self.on_rejected:
                self.on_rejected(self._job.name, name)
            return None
        job = Job(name, cancellable)
        self._job = job
        self._disable(disable)
        if self._on_start:
            self._on_start(job)

        def worker():
            try:
                result = task(job)
            except BaseException as e:          # every failure must come back, or the busy state never clears
                e._bg_traceback = traceback.format_exc()
                self._queue.put((job, False, e, on_done, on_error))
            else:
                self._queue.put((job, True, result, on_done, on_error))

        threading.Thread(target=worker, name="bg-" + name, daemon=True).start()
        self._scheduler.after(self._poll_ms, self._poll)
        return job

    # -- main-thread side --------------------------------------------------------------------------------------

    def _poll(self):
        try:
            while True:
                job, ok, value, on_done, on_error = self._queue.get_nowait()
                if job is not self._job or job.cancelled:
                    continue                    # a cancelled job finishing late: drop its result
                self._finish(job)
                if ok:
                    if on_done:
                        on_done(value)
                elif on_error:
                    on_error(value)
                else:
                    print(getattr(value, "_bg_traceback", repr(value)))
        except queue.Empty:
            pass
        if self._job is not None:
            self._scheduler.after(self._poll_ms, self._poll)

    def _finish(self, job):
        if job is not self._job:
            return
        self._job = None
        self._restore()
        if self._on_end:
            self._on_end(job)

    def _disable(self, widgets):
        self._disabled = []
        for w in widgets or ():
            if w is None:
                continue
            try:
                self._disabled.append((w, w.cget("state")))
                w.config(state="disabled")
            except Exception:
                pass

    def _restore(self):
        for w, state in self._disabled:
            try:
                w.config(state=state)
            except Exception:                   # the widget (e.g. a dialog) may be gone by now
                pass
        self._disabled = []


def runner_for(widget):
    """The app's shared runner (created on first use, stored on the Tk root, so dialogs share it too)."""
    top = widget._root() if hasattr(widget, "_root") else widget
    runner = getattr(top, "_bg_runner", None)
    if runner is None:
        runner = BackgroundRunner(top)
        top._bg_runner = runner
    return runner


def run_in_background(widget, task, on_done=None, on_error=None, **kw):
    """Shortcut: runner_for(widget).run(...). See the module docstring."""
    return runner_for(widget).run(task, on_done, on_error, **kw)
