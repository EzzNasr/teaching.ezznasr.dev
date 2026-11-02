#!/usr/bin/env python3
"""merge_registry_fragments.py - fold the per-session Phase 4 test fragments into tests/registry.json.
Standard library only.

  python scripts/merge_registry_fragments.py                   merge registry.p4-s1.json .. registry.p4-s8.json
  python scripts/merge_registry_fragments.py --check           change nothing; exit 1 if a fragment entry is missing
                                                               from the registry or differs from it
  python scripts/merge_registry_fragments.py --activate R-P4-S4-*   set status "active" on matching ids (id or glob)
  python scripts/merge_registry_fragments.py --list            print the entries that come from fragments
  --registry PATH  --fragments DIR                             override the defaults (tests)
  --dry-run                                                    report, write nothing

Rules: a fragment file registry.p4-sN.json holds {"entries":[...]}; every id must be R-P4-SN-nn and every
entry's "owner" must be p4-sN. An id that is already in the registry is skipped when identical and is an
ERROR when different (the script never silently overwrites). Output keeps the registry's formatting
(2-space JSON, trailing newline). Exit 0 = fine, 1 = problem.
"""
import argparse
import fnmatch
import glob
import json
import os
import re
import sys

SITE = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
TESTS = os.path.join(SITE, "tools", "quiz-maker-v2", "tests")
FRAG_RE = re.compile(r"^registry\.p4-s(\d+)\.json$")
ID_RE = re.compile(r"^R-P4-S(\d+)-(\d{2,})$")
STATUSES = ("active", "pending")


def dump(obj):
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def load_fragments(frag_dir, problems):
    """-> list of (session_no, filename, entries) sorted by session number."""
    out = []
    for path in glob.glob(os.path.join(frag_dir, "registry.p4-s*.json")):
        name = os.path.basename(path)
        m = FRAG_RE.match(name)
        if not m:
            problems.append("%s: unexpected fragment file name" % name)
            continue
        n = int(m.group(1))
        try:
            data = json.loads(open(path, "rb").read().decode("utf-8"))
        except ValueError as e:
            problems.append("%s: not valid JSON (%s)" % (name, e))
            continue
        entries = data.get("entries") if isinstance(data, dict) else None
        if not isinstance(entries, list):
            problems.append('%s: top level must be {"entries":[...]}' % name)
            continue
        seen = set()
        for e in entries:
            eid = e.get("id", "") if isinstance(e, dict) else ""
            im = ID_RE.match(eid)
            if not im or int(im.group(1)) != n:
                problems.append("%s: id %r must look like R-P4-S%d-NN" % (name, eid, n))
            if eid in seen:
                problems.append("%s: duplicate id %s inside the fragment" % (name, eid))
            seen.add(eid)
            for k in ("id", "title", "status", "owner"):
                if not e.get(k):
                    problems.append("%s: %s is missing %r" % (name, eid or "an entry", k))
            if e.get("status") not in STATUSES:
                problems.append("%s: %s status must be one of %s" % (name, eid, "/".join(STATUSES)))
            if e.get("owner") != "p4-s%d" % n:
                problems.append("%s: %s owner must be p4-s%d" % (name, eid, n))
            if not e.get("cmd"):
                problems.append("%s: %s has no cmd" % (name, eid))
        out.append((n, name, entries))
    out.sort(key=lambda t: t[0])
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Merge Phase 4 registry fragments (see module docstring).")
    ap.add_argument("--registry", default=os.path.join(TESTS, "registry.json"))
    ap.add_argument("--fragments", default=TESTS)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--activate", metavar="ID_OR_GLOB")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    problems, log = [], []
    try:
        reg = json.loads(open(args.registry, "rb").read().decode("utf-8"))
    except (OSError, ValueError) as e:
        print("ERROR: cannot read registry %s: %s" % (args.registry, e))
        return 1
    by_id = {e["id"]: e for e in reg["entries"]}
    frags = load_fragments(args.fragments, problems)

    if args.list:
        for n, name, entries in frags:
            for e in entries:
                print("%-12s %-8s %s" % (e["id"], e["status"], e["title"][:80]))
        return 1 if problems else 0

    if args.activate:
        hit = [e for e in reg["entries"] if fnmatch.fnmatch(e["id"], args.activate)]
        if not hit:
            problems.append("--activate %s matches no registry entry" % args.activate)
        for e in hit:
            if e["status"] == "active":
                log.append("activate %-12s already active" % e["id"])
            else:
                e["status"] = "active"
                log.append("activate %-12s -> active" % e["id"])
        if not problems and not args.dry_run:
            open(args.registry, "wb").write(dump(reg).encode("utf-8"))
        return finish(problems, log)

    added = skipped = 0
    for n, name, entries in frags:
        for e in entries:
            cur = by_id.get(e["id"])
            if cur is None:
                if args.check:
                    problems.append("%s is in %s but not in the registry (run without --check)" % (e["id"], name))
                else:
                    reg["entries"].append(e)
                    by_id[e["id"]] = e
                    added += 1
            elif cur == e:
                skipped += 1
            elif cur.get("status") == "active" and e.get("status") == "pending" and \
                    {k: v for k, v in cur.items() if k != "status"} == {k: v for k, v in e.items() if k != "status"}:
                skipped += 1   # activated at assembly: the fragment still says pending, that is expected
            else:
                problems.append("%s differs between %s and the registry; resolve it by hand (not overwritten)"
                                % (e["id"], name))
    if not frags:
        problems.append("no registry.p4-s*.json fragments found in %s" % args.fragments)
    log.append("merge  %d added, %d already present, %d fragment file(s)" % (added, skipped, len(frags)))
    if not problems and added and not args.dry_run and not args.check:
        open(args.registry, "wb").write(dump(reg).encode("utf-8"))
        log.append("wrote  %s" % args.registry)
    return finish(problems, log)


def finish(problems, log):
    for line in log:
        print(line)
    if problems:
        print("\nFAILED (%d):" % len(problems))
        for p in problems:
            print("  - " + p)
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
