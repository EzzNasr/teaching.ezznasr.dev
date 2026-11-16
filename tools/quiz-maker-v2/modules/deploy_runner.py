"""deploy_runner.py - opens a terminal window and runs the backend deploy script in it, live.

From the app:   deploy_runner.launch(site_root, "check" | "deploy")
In the window:  python modules/deploy_runner.py <site_root> <mode>      (this file is its own entry point)

The deploy itself is scripts/deploy_backend.js (clasp; see docs/runbooks/backend-deploy.md). "check" is its dry run
and changes nothing. "deploy" asks you to type DEPLOY in the window before anything is sent to Google.
Standard library only.
"""
import os
import shutil
import subprocess
import sys

try:
    from modules import test_runner          # when imported by the app
except ImportError:                          # when run as its own entry point in the terminal window
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from modules import test_runner

MODES = {
    "check": ([], "Check only (dry run, changes nothing)"),
    "deploy": (["--yes"], "Deploy backend to live"),
}
CONFIRM_WORD = "DEPLOY"


def build_command(site_root, mode):
    """-> (argv, None) or (None, reason)."""
    script = os.path.join(site_root, "scripts", "deploy_backend.js")
    if not os.path.isfile(script):
        return None, "scripts/deploy_backend.js not found under:\n%s\n\nIs Site location pointing at the teaching.ezznasr.dev repo?" % site_root
    if not os.path.isdir(os.path.join(site_root, "node_modules", "@google", "clasp")):
        return None, "clasp is not installed in the site folder. Open a terminal there and run:\n\nnpm ci\nnpx clasp login"
    node = shutil.which("node")
    if not node:
        return None, "node was not found on PATH, so the deploy can't run."
    return [node, "scripts/deploy_backend.js"] + MODES[mode][0], None


def launch(site_root, mode="check"):
    """Open a terminal running the deploy script. Returns None on success, or an error message for a messagebox."""
    site_root = os.path.abspath(site_root or "")
    if not os.path.isdir(site_root):
        return "Site location is not a folder:\n%s" % site_root
    cmd, why = build_command(site_root, mode)
    if cmd is None:
        return why
    argv, kw = test_runner._terminal_argv([sys.executable, os.path.abspath(__file__), site_root, mode])
    if argv is None:
        return kw
    try:
        subprocess.Popen(argv, cwd=site_root, **(kw if isinstance(kw, dict) else {}))
    except OSError as e:
        return "Could not open a terminal: %s" % e
    return None


def _main(site_root, mode, ask=input, call=subprocess.call):
    """Runs INSIDE the new terminal window. `ask` and `call` are replaceable for tests."""
    if sys.platform == "win32":
        os.system("title Backend - %s" % MODES[mode][1])
        os.system("")
    cmd, why = build_command(site_root, mode)
    print("=" * 70)
    print(" teaching.ezznasr.dev backend - %s" % MODES[mode][1])
    print(" folder : %s" % site_root)
    print("=" * 70, flush=True)
    code = 2
    if cmd is None:
        print("\n" + why)
    else:
        go = True
        if mode == "deploy":
            print("\nThis replaces the LIVE backend that students and staff use right now.")
            print("Not during a class or an open quiz window. Run 'Check only' first if you have not.")
            try:
                go = ask("Type %s and press Enter to continue (anything else cancels): " % CONFIRM_WORD).strip() == CONFIRM_WORD
            except EOFError:
                go = False
            if not go:
                print("\nCancelled. Nothing was changed.")
                code = 1
        if go:
            try:
                code = call(cmd, cwd=site_root, env=dict(os.environ, FORCE_COLOR="1"))
            except OSError as e:
                print("\ncould not start the deploy: %s" % e)
    print("\n" + "=" * 70)
    if mode == "check":
        print(" RESULT: %s" % ("checks passed - nothing was changed" if code == 0 else "a check failed - read the message above"))
    else:
        print(" RESULT: %s" % ("DEPLOYED - commit docs/runbooks/backend-deploys.md" if code == 0 else "NOT deployed (or rolled back) - read the message above"))
    print("=" * 70)
    try:
        ask("Press Enter to close this window...")
    except EOFError:
        pass
    return code


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[2] not in MODES:
        print("usage: python deploy_runner.py <site_root> <%s>" % "|".join(MODES))
        sys.exit(2)
    sys.exit(_main(sys.argv[1], sys.argv[2]))
