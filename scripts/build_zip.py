#!/usr/bin/env python3
"""Build the Phase 2 delivery zip (Session 5).

    python scripts/build_zip.py                      # gate, then zip every changed/new file -> ../teaching-phase2-YYYYMMDD.zip
    python scripts/build_zip.py --interim            # mid-build zip: active tests must pass, pending/TODO allowed
    python scripts/build_zip.py --skip-e2e           # gate without the browser tests (no Playwright here)
    python scripts/build_zip.py --list               # only print what would be shipped and the checklist
    python scripts/build_zip.py --since d2bef69      # compare against another commit (default HEAD)
    python scripts/build_zip.py --files a b c        # explicit repo-relative paths instead of git
    python scripts/build_zip.py --no-gate            # skip the registry gate (not for releases)
    python scripts/build_zip.py --out some.zip

Zip layout (rollout plan 1.7): every path starts with `teaching.ezznasr.dev/`, plus an APPLY.txt
inside that folder in the existing style. Unzip it in the folder that CONTAINS teaching.ezznasr.dev.

The gate (all must pass, otherwise no zip is written):
  1. node scripts/run_registry.js --strict --e2e   (every active test passes, nothing pending/TODO; --interim drops --strict)
  2. python tools/quiz-maker-v2/check_asset_drift.py   ("In sync.")
  3. every shipped .gs / .js / .json file parses
  4. no shipped path is a backup / cache / config / secret file
"""
import argparse, datetime, json, os, re, subprocess, sys, zipfile

SITE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PREFIX = 'teaching.ezznasr.dev/'
EXCLUDE = [r'\.bak$', r'\.pyc$', r'(^|/)__pycache__/', r'(^|/)\.git(/|$)', r'(^|/)node_modules/',
           r'quiz_maker_config\.json$', r'\.lnk$', r'\.log$', r'^handoff/', r'^APPLY\.txt$', r'(^|/)_shots/', r'(^|/)\.DS_Store$']


def run(cmd, **kw):
    return subprocess.run(cmd, cwd=SITE, text=True, capture_output=True, **kw)


def changed_files(since):
    r = run(['git', 'status', '--porcelain', '-uall'])
    if r.returncode != 0:
        sys.exit('git status failed (%s). Use --files instead.' % r.stderr.strip())
    files = set()
    for line in r.stdout.splitlines():
        code, path = line[:2], line[3:].strip().strip('"')
        if ' -> ' in path:
            path = path.split(' -> ')[1]
        if 'D' in code:
            continue
        files.add(path)
    if since != 'HEAD':
        r = run(['git', 'diff', '--name-only', '--diff-filter=d', since, 'HEAD'])
        files.update(r.stdout.split())
    return sorted(files)


def excluded(p):
    return any(re.search(x, p) for x in EXCLUDE)


def apply_text(files, interim=False, note=''):
    gs = [f for f in files if f.endswith('.gs')]
    tpl = [f for f in files if '/assets_templates/' in f]
    pages = [f for f in files if f.endswith('.html') and not f.startswith('tools/')]
    tests = [f for f in files if '/tests/' in f]
    out = ['Phase 2 delivery', '',
           'Unzip in the folder that CONTAINS teaching.ezznasr.dev (the zip paths start with',
           'teaching.ezznasr.dev/), accepting "replace". Then, in this order:', '']
    n = 1
    out.append('%d. node scripts/run_registry.js %s   (from the repo root; expect: nothing FAIL%s)' % (n, '' if interim else '--strict', ' (XFAIL/TODO are normal in an interim build)' if interim else ' / XFAIL / TODO')); n += 1
    if gs:
        out.append('%d. Apps Script: paste EACH of these into the project (one file each; Code.gs replaces the old one):' % n); n += 1
        out += ['     - ' + os.path.basename(f) for f in gs]
        out.append('   Then Deploy -> Manage deployments -> pencil -> New version.')
        out.append('   Script Properties: add FF_CAMERA, FF_DEFERRED_ANSWERS, FF_GRADING, FF_PARENT_LOG, FF_MONTHLY = 1 only when you want that feature on (missing = off).')
    if tpl:
        out.append('%d. Quiz Maker -> "Sync site assets" (changed templates: %s). Answer Yes.' % (n, ', '.join(sorted(set(os.path.basename(f) for f in tpl))))); n += 1
    out.append('%d. python tools/quiz-maker-v2/check_asset_drift.py   -> must print "In sync."' % n); n += 1
    out.append('%d. Commit + push, hard-refresh the browser. Then follow docs/rollout-checklist.md section "After deploy".' % n)
    if note:
        out += ['', 'NOTE: ' + note]
    out += ['', 'Files (%d):' % len(files)]
    out += ['  ' + f for f in files]
    out += ['', '%d site page(s), %d test file(s), %d Apps Script file(s).' % (len(pages), len(tests), len(gs))]
    return '\n'.join(out) + '\n'


def gate(interim=False, e2e=True):
    ok = True
    r = run(['node', 'scripts/run_registry.js'] + (['--e2e'] if e2e else []) + ([] if interim else ['--strict']))
    print(r.stdout[-1500:])
    if r.returncode != 0:
        print('GATE FAILED: registry'); ok = False
    r = run([sys.executable, 'tools/quiz-maker-v2/check_asset_drift.py'])
    if 'In sync.' not in r.stdout:
        print('GATE FAILED: asset drift\n' + r.stdout[-800:]); ok = False
    return ok


def parse_ok(files):
    bad = []
    for f in files:
        p = os.path.join(SITE, f)
        if f.endswith('.json'):
            try: json.load(open(p, encoding='utf-8'))
            except Exception as e: bad.append('%s: %s' % (f, e))
        elif f.endswith(('.gs', '.js')):
            code = ("const fs=require('fs'),vm=require('vm');try{new vm.Script(fs.readFileSync(process.argv[1],'utf8'))}catch(e){console.error(e.message);process.exit(1)}")
            r = subprocess.run(['node', '-e', code, p], capture_output=True, text=True)
            if r.returncode: bad.append('%s: %s' % (f, r.stderr.strip()[:120]))
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', default='HEAD'); ap.add_argument('--files', nargs='*')
    ap.add_argument('--out'); ap.add_argument('--list', action='store_true'); ap.add_argument('--no-gate', action='store_true'); ap.add_argument('--note', default='', help='free text appended to APPLY.txt'); ap.add_argument('--skip-e2e', action='store_true', help='gate without the Playwright tests (machine has no browser)'); ap.add_argument('--interim', action='store_true', help='mid-build zip: active tests must pass, pending/TODO allowed')
    a = ap.parse_args()
    files = [f for f in (a.files if a.files else changed_files(a.since)) if not excluded(f)]
    files = [f for f in files if os.path.isfile(os.path.join(SITE, f))]
    if not files:
        sys.exit('Nothing to ship.')
    print('Shipping %d file(s):' % len(files)); [print('  ' + f) for f in files]
    if a.list:
        print('\n' + apply_text(files, a.interim, a.note)); return
    bad = parse_ok(files)
    if bad:
        sys.exit('GATE FAILED: does not parse:\n  ' + '\n  '.join(bad))
    if not a.no_gate and not gate(a.interim, not a.skip_e2e):
        sys.exit(1)
    out = a.out or os.path.join(os.path.dirname(SITE), 'teaching-phase2-%s.zip' % datetime.date.today().strftime('%Y%m%d'))
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(os.path.join(SITE, f), PREFIX + f)
        z.writestr(PREFIX + 'APPLY.txt', apply_text(files, a.interim, a.note))
    print('Wrote %s (%d files + APPLY.txt)' % (out, len(files)))


if __name__ == '__main__':
    main()
