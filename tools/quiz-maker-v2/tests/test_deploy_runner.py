"""R-DEP-2: the Quiz Maker's "Deploy backend" menu (modules/deploy_runner.py) runs the right command and never deploys
without the typed confirmation. Nothing here starts a terminal, node or clasp: the command runner is faked."""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from modules import deploy_runner as R  # noqa: E402

passed = failed = 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1; print("PASS " + name)
    else:
        failed += 1; print("FAIL " + name + ("  -> " + str(extra) if extra != "" else ""))


def site(with_script=True, with_clasp=True):
    d = tempfile.mkdtemp(prefix="deployrunner-")
    os.makedirs(os.path.join(d, "scripts"))
    if with_script:
        open(os.path.join(d, "scripts", "deploy_backend.js"), "w").close()
    if with_clasp:
        os.makedirs(os.path.join(d, "node_modules", "@google", "clasp"))
    return d


check("two modes: check (no flags) and deploy (--yes)", R.MODES["check"][0] == [] and R.MODES["deploy"][0] == ["--yes"])
d = site()
cmd, why = R.build_command(d, "check")
check("check runs the deploy script as a dry run", cmd is not None and cmd[1:] == ["scripts/deploy_backend.js"], why)
cmd, why = R.build_command(d, "deploy")
check("deploy adds --yes", cmd is not None and cmd[1:] == ["scripts/deploy_backend.js", "--yes"], why)
cmd, why = R.build_command(site(with_script=False), "check")
check("a folder without the script explains itself", cmd is None and "deploy_backend.js not found" in why)
cmd, why = R.build_command(site(with_clasp=False), "check")
check("missing clasp says to run npm ci and clasp login", cmd is None and "npm ci" in why and "clasp login" in why)
check("launch refuses a missing folder", "not a folder" in (R.launch(os.path.join(d, "nope"), "check") or ""))

calls = []
fake_call = lambda c, **kw: calls.append(c) or 0


def asker(*answers):
    it = iter(answers)
    return lambda prompt="": next(it, "")


code = R._main(d, "deploy", ask=asker("no", ""), call=fake_call)
check("deploy without typing DEPLOY runs nothing", calls == [] and code == 1)
code = R._main(d, "deploy", ask=asker("deploy", ""), call=fake_call)
check("...lower-case 'deploy' is not enough", calls == [] and code == 1)
code = R._main(d, "deploy", ask=asker("DEPLOY", ""), call=fake_call)
check("typing DEPLOY runs the deploy with --yes", len(calls) == 1 and calls[0][-1] == "--yes" and code == 0, calls)
calls.clear()
code = R._main(d, "check", ask=asker(""), call=fake_call)
check("check runs at once, no confirmation, no --yes", len(calls) == 1 and "--yes" not in calls[0] and code == 0, calls)

src = open(os.path.join(os.path.dirname(HERE), "app_main.py"), encoding="utf-8").read()
check("the app has the Deploy backend menu wired to deploy_runner", "Deploy backend" in src and "deploy_runner.launch(" in src)
check("the app asks before opening a real deploy", "askyesno" in src.split("def _deploy_backend", 1)[1].split("def ", 1)[0])

print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
