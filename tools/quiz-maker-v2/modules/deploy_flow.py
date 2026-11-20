"""deploy_flow.py - what the Settings window's "Deploy backend" needs, without tkinter (unit-tested).

The deploy itself is scripts/deploy_backend.js (clasp; see docs/runbooks/backend-deploy.md): a dry run by default,
--yes to deploy. This module:
  * files_to_sync(site_root)   which repo files become which Apps Script files (from apps_script/deploy.json),
  * git_facts(site_root)       commit, branch, uncommitted changes, is it origin/main, is it on GitHub,
  * command(site_root, ...)    the argv to run (or why it can't run: no node, no clasp, wrong folder),
  * step_of(line)              turns the script's "== 3. live check ==" lines into a step id for the progress list.
"""
import json
import os
import re
import shutil
import subprocess
import sys

GS_REL = os.path.join("tools", "quiz-maker-v2", "apps_script")

# The script's steps, in order, as it prints them ("== 1. preflight ==" ...). "8" only appears on a rollback.
STEPS = (
    ("1", "Preflight: committed, pushed, the right commit"),
    ("2", "Fast test gate (about 1–2 minutes)"),
    ("3", "Live check: what is deployed now, what changes"),
    ("4-5", "Stage and push the files, then verify them"),
    ("6", "New version on the same /exec URL"),
    ("7", "Live smoke test"),
    ("8", "Rollback to the previous version"),
    ("9", "Record the deploy"),
)
DRY_STEPS = ("1", "2", "3", "dry")
STEP_RE = re.compile(r"^==\s*(?:(\d+(?:-\d+)?)\.|(dry run))", re.I)


def step_of(line):
    """'== 4-5. stage and push ==' -> '4-5'; '== dry run ==' -> 'dry'; anything else -> None."""
    m = STEP_RE.match(line.strip())
    if not m:
        return None
    return m.group(1) or "dry"


def gs_dir(site_root):
    return os.path.join(site_root, GS_REL)


def files_to_sync(site_root):
    """-> list of dicts {repo, path, live, kind, exists} in push order; raises ValueError when deploy.json is
    missing or wrong. kind: 'code' (a .gs file), 'manifest' (appsscript.json), 'generated' (Version.gs)."""
    d = gs_dir(site_root)
    cfg_path = os.path.join(d, "deploy.json")
    if not os.path.isfile(cfg_path):
        raise ValueError("No deploy.json in %s — is the site folder the teaching.ezznasr.dev repo, "
                         "and does it have the deploy script (scripts/deploy_backend.js)?" % d)
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    out = []
    for e in cfg.get("files") or []:
        live = str(e.get("live", "")) + ".gs"
        if e.get("generated"):
            out.append({"repo": "(made at deploy time)", "path": "", "live": live, "kind": "generated", "exists": True})
        else:
            p = os.path.join(d, e["repo"])
            out.append({"repo": e["repo"], "path": p, "live": live, "kind": "code", "exists": os.path.isfile(p)})
    man = os.path.join(d, "appsscript.json")
    out.append({"repo": "appsscript.json", "path": man, "live": "appsscript.json", "kind": "manifest",
                "exists": os.path.isfile(man)})
    return out


def deploy_target(site_root):
    """(scriptId, deploymentId, exec URL) from deploy.json, or ('', '', '')."""
    try:
        with open(os.path.join(gs_dir(site_root), "deploy.json"), "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return "", "", ""
    dep = cfg.get("deploymentId", "")
    return cfg.get("scriptId", ""), dep, ("https://script.google.com/macros/s/%s/exec" % dep if dep else "")


def _git(site_root, *args):
    try:
        r = subprocess.run(["git"] + list(args), cwd=site_root, capture_output=True, text=True, timeout=15,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return r.returncode, (r.stdout or "").strip()
    except (OSError, subprocess.SubprocessError):
        return 1, ""


def git_facts(site_root):
    """Local facts only (no fetch, so it is instant): {commit, short, branch, dirty, is_main, on_github}."""
    _c, commit = _git(site_root, "rev-parse", "HEAD")
    _c, branch = _git(site_root, "rev-parse", "--abbrev-ref", "HEAD")
    _c, status = _git(site_root, "status", "--porcelain", "--untracked-files=no")
    _c, main = _git(site_root, "rev-parse", "origin/main")
    _c, remote = _git(site_root, "branch", "-r", "--contains", commit) if commit else (1, "")
    return {"commit": commit, "short": commit[:7], "branch": branch, "dirty": bool(status),
            "is_main": bool(commit) and commit == main, "on_github": bool(remote)}


def problems(facts, allow_branch):
    """What will make the script's preflight stop, in plain words (shown before you confirm)."""
    out = []
    if not facts.get("commit"):
        out.append("This folder is not a git checkout, so the deploy can't say which commit it sends.")
        return out
    if facts["dirty"]:
        out.append("There are uncommitted changes. Commit them first: the deploy only sends committed code.")
    if not facts["on_github"]:
        out.append("Commit %s is not on GitHub yet. Push it first, so the deployed commit can be found later."
                   % facts["short"])
    if not facts["is_main"] and not allow_branch:
        out.append("This is %s, not origin/main. Deploy main, or tick “Allow a commit that is not main” "
                   "on purpose (a hotfix or a rollback)." % (facts["branch"] or facts["short"]))
    return out


def command(site_root, dry_run=True, allow_branch=False):
    """-> (argv, None) or (None, reason). Same checks as deploy_runner (node, clasp, the script)."""
    script = os.path.join(site_root, "scripts", "deploy_backend.js")
    if not os.path.isfile(script):
        return None, "scripts/deploy_backend.js was not found in the site folder:\n%s" % site_root
    if not os.path.isdir(os.path.join(site_root, "node_modules", "@google", "clasp")):
        return None, ("clasp is not installed in the site folder. Open a terminal there and run, once:\n\n"
                      "npm ci\nnpx clasp login")
    node = shutil.which("node")
    if not node:
        return None, "node was not found on PATH, so the deploy can't run."
    argv = [node, "scripts/deploy_backend.js"]
    if not dry_run:
        argv.append("--yes")
    if allow_branch:
        argv.append("--allow-branch")
    return argv, None


def popen_kwargs():
    """No console window flashing up on Windows; line-buffered text output."""
    kw = {"stdout": subprocess.PIPE, "stderr": subprocess.STDOUT, "text": True, "encoding": "utf-8",
          "errors": "replace", "bufsize": 1}
    if sys.platform == "win32":
        kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return kw
