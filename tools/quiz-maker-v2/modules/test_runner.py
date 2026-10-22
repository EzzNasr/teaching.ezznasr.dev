"""test_runner.py - opens a real terminal window and runs the site's master test gate in it, live.

From the app:   test_runner.launch(site_root, "fast" | "e2e" | "strict")
In the window:  python modules/test_runner.py <site_root> <mode>      (this file is its own entry point)

The gate is scripts/test_all.sh (needs bash: Git for Windows, macOS, Linux). If bash is not found it falls
back to `node scripts/run_registry.js`, which runs the same registry without the extra syntax stage.
Standard library only.
"""
import os
import shlex
import shutil
import subprocess
import sys

MODES = {
    "fast": ([], "Fast gate (about 5 s)"),
    "e2e": (["--e2e"], "With browser tests (about 2 min)"),
    "strict": (["--strict"], "Release gate (--strict)"),
}


def _find_bash():
    if sys.platform == "win32":          # Git's bash first: the bash.exe on PATH is often WSL, which can't see C:\ paths
        for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"), os.environ.get("LocalAppData")):
            if base:
                for sub in ("Git\\bin\\bash.exe", "Programs\\Git\\bin\\bash.exe"):
                    p = os.path.join(base, sub)
                    if os.path.isfile(p):
                        return p
        return None
    return shutil.which("bash")


def build_command(site_root, mode):
    """-> (argv, None) or (None, reason)."""
    flags = MODES[mode][0]
    sh = os.path.join(site_root, "scripts", "test_all.sh")
    reg = os.path.join(site_root, "scripts", "run_registry.js")
    bash = _find_bash()
    if bash and os.path.isfile(sh):
        return [bash, "scripts/test_all.sh"] + flags, None
    node = shutil.which("node")
    if node and os.path.isfile(reg):
        return [node, "scripts/run_registry.js"] + flags, None
    if not os.path.isfile(reg):
        return None, "scripts/run_registry.js not found under:\n%s\n\nIs Site location pointing at the teaching.ezznasr.dev repo?" % site_root
    return None, "Neither bash (Git for Windows) nor node was found on PATH, so the tests can't run."


def _terminal_argv(inner):
    """Wrap `inner` (an argv list) so it runs in a new terminal window. -> (argv, popen_kwargs) or (None, reason)."""
    if sys.platform == "win32":
        return inner, {"creationflags": subprocess.CREATE_NEW_CONSOLE}
    if sys.platform == "darwin":
        script = 'tell application "Terminal" to activate\ntell application "Terminal" to do script %s' % \
                 '"' + " ".join(shlex.quote(a) for a in inner).replace("\\", "\\\\").replace('"', '\\"') + '"'
        return ["osascript", "-e", script], {}
    for name, pre in (("x-terminal-emulator", ["-e"]), ("gnome-terminal", ["--"]), ("konsole", ["-e"]),
                      ("xfce4-terminal", ["-x"]), ("kitty", []), ("alacritty", ["-e"]), ("xterm", ["-e"])):
        if shutil.which(name):
            return [name] + pre + inner, {}
    return None, "No terminal program found (tried x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, xterm)."


def launch(site_root, mode="fast"):
    """Open a terminal running the gate. Returns None on success, or an error message for a messagebox."""
    site_root = os.path.abspath(site_root or "")
    if not os.path.isdir(site_root):
        return "Site location is not a folder:\n%s" % site_root
    cmd, why = build_command(site_root, mode)
    if cmd is None:
        return why
    inner = [sys.executable, os.path.abspath(__file__), site_root, mode]
    argv, kw = _terminal_argv(inner)
    if argv is None:
        return kw
    try:
        subprocess.Popen(argv, cwd=site_root, **(kw if isinstance(kw, dict) else {}))
    except OSError as e:
        return "Could not open a terminal: %s" % e
    return None


def _main(site_root, mode):
    """Runs INSIDE the new terminal window: stream the gate live, show the verdict, wait for Enter."""
    if sys.platform == "win32":
        os.system("title Site tests - %s" % MODES[mode][1])
        os.system("")                    # turns on ANSI colours in the Windows console
    cmd, why = build_command(site_root, mode)
    print("=" * 70)
    print(" teaching.ezznasr.dev - %s" % MODES[mode][1])
    print(" folder : %s" % site_root)
    print(" running: %s" % " ".join(cmd or ["(nothing)"]))
    print("=" * 70, flush=True)
    code = 2
    if cmd is None:
        print("\n" + why)
    else:
        env = dict(os.environ, PYTHONUNBUFFERED="1", FORCE_COLOR="1")
        try:
            code = subprocess.call(cmd, cwd=site_root, env=env)      # inherits this console: output is live
        except OSError as e:
            print("\ncould not start the tests: %s" % e)
    print("\n" + "=" * 70)
    print(" RESULT: %s (exit code %s)" % ("ALL GREEN - safe to ship" if code == 0 else "BLOCKED - do not ship", code))
    print("=" * 70)
    try:
        input("Press Enter to close this window...")
    except EOFError:
        pass
    return code


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[2] not in MODES:
        print("usage: python test_runner.py <site_root> <%s>" % "|".join(MODES))
        sys.exit(2)
    sys.exit(_main(sys.argv[1], sys.argv[2]))
