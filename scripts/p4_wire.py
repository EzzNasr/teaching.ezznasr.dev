#!/usr/bin/env python3
"""p4_wire.py - assemble Phase 4 (math teacher build) into Code.gs.  Standard library only.

  python scripts/p4_wire.py --merge --wire      append the five Phase 4 chunks, insert hooks H1-H5
  python scripts/p4_wire.py --check             change nothing; exit 1 if anything is off
  python scripts/p4_wire.py --list-actions      print every case "..." label of doPost, sorted
  --dry-run                                     with --merge/--wire: report, write nothing
  --code PATH  --chunks DIR                     override the default Code.gs / chunks folder (tests)

Idempotent: a second run changes nothing. Never guesses: if an anchor or a case has an unexpected shape
the script exits 1 and lists every failure (the file is only written when all steps succeeded).
Line endings of Code.gs (CRLF today) are preserved.  Contract: 00-MASTER-CONTRACT.md sections 5, 6b-6e, 7.
"""
import argparse
import os
import re
import sys

SITE = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
QM = os.path.join(SITE, "tools", "quiz-maker-v2")
DEFAULT_CODE = os.path.join(QM, "apps_script", "Code.gs")
DEFAULT_CHUNKS = os.path.join(QM, "apps_script", "chunks")

# Merge order (contract section 8).
CHUNKS = ["Phase4_Scope.gs", "Phase4_People.gs", "Phase4_Team.gs", "Phase4_Telegram.gs", "Phase4_Stats.gs"]

# Contract section 5, "Filter" column: these responses are wrapped by hook H4.
FILTERED = [
    "admin_list_videos", "admin_list_lesson_tags", "admin_list_lessons", "admin_grant_access",
    "admin_grant_quiz_access", "admin_group_add", "admin_list_groups", "admin_get_all",
    "admin_access_overview", "admin_list_payments", "admin_followup_overview", "admin_student_summary",
    "admin_monthly_review", "admin_list_parent_notifications", "admin_grading_queue",
]
# Contract section 7, H5: new router cases, handler function name == action name.
NEW_CASES = [
    "p4_session_scope", "p4_admin_set_teacher", "p4_admin_list_teachers", "p4_admin_set_group_owner",
    "p4_admin_tg_unlink", "p4_admin_list_edit_log", "p4_teacher_update_student", "p4_teacher_set_assistant",
    "p4_teacher_list_assistants", "p4_teacher_revoke_assistant", "p4_tg_link_start", "p4_tg_status",
    "p4_tg_unlink", "p4_admin_teacher_stats",
]

H1 = 'if (typeof p4_tokenAllows === "function" && p4_tokenAllows(payload)) return;'
H2 = ('if (tokenOk && !isAdmin && typeof p4_teacherAllows === "function" && '
      'p4_teacherAllows(values[i], c, payload)) return true;')
H3 = ('var __g = (typeof p4_gate === "function") ? p4_gate(payload) : null; '
      'if (__g && __g.deny) return _json(__g.deny);')
H2_ANCHOR = re.compile(r'^[ \t]*if \(tokenOk && !isAdmin && typeof p3_assistantAllows === "function" && '
                       r'p3_assistantAllows\(values\[i\], c, payload\)\) return true;[ \t]*$', re.M)


class Fail(Exception):
    pass


# ----------------------------------------------------------------------------- text helpers

def read_text(path):
    raw = open(path, "rb").read().decode("utf-8")
    crlf, lf = raw.count("\r\n"), raw.count("\n")
    if crlf == 0:
        eol = "\n"
    elif crlf == lf:
        eol = "\r\n"
    else:
        raise Fail("%s has mixed line endings (%d CRLF of %d lines); fix that first" % (path, crlf, lf))
    return raw.replace("\r\n", "\n"), eol


def write_text(path, text, eol):
    open(path, "wb").write(text.replace("\n", eol).encode("utf-8"))


def find_function(text, name):
    """(start, end) of `function name(...) {` .. its closing `}` at column 0, or raise Fail."""
    m = re.search(r"^function %s\(" % re.escape(name), text, re.M)
    if not m:
        raise Fail("anchor missing: function %s" % name)
    e = re.compile(r"^}[ \t]*$", re.M).search(text, m.end())
    if not e:
        raise Fail("anchor shape: no closing brace at column 0 for function %s" % name)
    return m.start(), e.end()


def match_paren(s, i):
    """s[i] == '(' ; index of the matching ')' (skips strings and comments), or -1."""
    depth, j, n = 0, i, len(s)
    while j < n:
        ch = s[j]
        if ch in "\"'`":
            q = ch
            j += 1
            while j < n and s[j] != q:
                j += 2 if s[j] == "\\" else 1
        elif s.startswith("//", j):
            while j < n and s[j] != "\n":
                j += 1
            continue
        elif s.startswith("/*", j):
            k = s.find("*/", j + 2)
            j = n if k < 0 else k + 1
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return j
        j += 1
    return -1


def split_doPost(text):
    a, b = find_function(text, "doPost")
    return a, b


# ----------------------------------------------------------------------------- merge

def banner(name):
    bar = "// " + "=" * 76
    return "%s\n// ===== MERGED FROM %s =====\n%s\n" % (bar, name, bar)


def end_marker(name):
    return "// ===== END MERGED FROM %s =====\n" % name


def section_re(name):
    n = re.escape(name)
    return re.compile(r"^// =+\n// ===== MERGED FROM %s =====\n// =+\n(.*?)^// ===== END MERGED FROM %s =====\n" % (n, n),
                      re.M | re.S)


def norm_chunk(s):
    s = s.replace("\r\n", "\n")
    return s if s.endswith("\n") else s + "\n"


def merge(text, chunks_dir, problems, log, allow_missing=False):
    for name in CHUNKS:
        path = os.path.join(chunks_dir, name)
        if not os.path.exists(path):
            if allow_missing:
                log.append("merge  %-20s skipped (not in chunks folder)" % name)
            else:
                problems.append("chunk missing: %s (expected in %s)" % (name, chunks_dir))
            continue
        body = norm_chunk(open(path, "rb").read().decode("utf-8"))
        m = section_re(name).search(text)
        if m:
            if m.group(1) == body:
                log.append("merge  %-20s present, unchanged" % name)
            else:
                text = text[:m.start(1)] + body + text[m.end(1):]
                log.append("merge  %-20s REPLACED (chunk changed)" % name)
        elif re.search(r"MERGED FROM %s\b" % re.escape(name), text):
            problems.append("%s: a 'MERGED FROM' marker exists without the matching END marker; merge it by hand once "
                            "or remove the old copy, then rerun" % name)
        else:
            text = text.rstrip("\n") + "\n\n" + banner(name) + body + end_marker(name)
            log.append("merge  %-20s ADDED" % name)
    return text


# ----------------------------------------------------------------------------- hooks

def hook1(text):
    a, b = find_function(text, "_requireAdmin")
    body = text[a:b]
    if H1 in body:
        return text, "present"
    nl = body.index("\n") + 1
    return text[:a] + body[:nl] + "  " + H1 + "\n" + body[nl:] + text[b:], "ADDED"


def hook2(text):
    a, b = find_function(text, "_requireAdminSession")
    body = text[a:b]
    if H2 in body:
        return text, "present"
    ms = list(H2_ANCHOR.finditer(body))
    if len(ms) != 1:
        raise Fail("anchor missing: the p3_assistantAllows line in _requireAdminSession (found %d)" % len(ms))
    indent = re.match(r"[ \t]*", ms[0].group(0)).group(0)
    ins = ms[0].end()
    return text[:a] + body[:ins] + "\n" + indent + H2 + body[ins:] + text[b:], "ADDED"


def hook3(text):
    a, b = split_doPost(text)
    body = text[a:b]
    if H3 in body:
        return text, "present"
    m = re.search(r"^([ \t]*)try \{\n[ \t]*switch \(payload\.action\) \{\n", body, re.M)
    if not m:
        raise Fail("anchor missing: `try {` directly followed by `switch (payload.action) {` in doPost")
    ins = m.start() + len(m.group(1)) + len("try {\n")
    return text[:a] + body[:ins] + m.group(1) + "  " + H3 + "\n" + body[ins:] + text[b:], "ADDED"


def case_return_span(body, action, start_hint=0):
    """For `case "action":` (comment allowed) followed by `return _json(EXPR);` return (open_paren, close_paren)
    of the _json( ... ) call, or raise Fail."""
    m = re.search(r'^[ \t]*case "%s":[ \t]*(?://[^\n]*)?\n' % re.escape(action), body, re.M)
    if not m:
        raise Fail('anchor missing: case "%s": (alone on its line) in doPost' % action)
    rest = body[m.end():]
    # skip blank lines and comment-only lines
    r = re.match(r"(?:[ \t]*(?://[^\n]*)?\n)*?[ \t]*(?:[A-Za-z_]\w*\([^\n]*\);[ \t]*\n[ \t]*)?return _json\(", rest)
    if not r:
        raise Fail('unexpected shape: case "%s" is not followed by `return _json(...)`' % action)
    open_i = m.end() + r.end() - 1
    close_i = match_paren(body, open_i)
    if close_i < 0 or not re.match(r"[ \t]*;", body[close_i + 1:]):
        raise Fail('unexpected shape: case "%s": `return _json(...)` has no balanced `);`' % action)
    # the return must be this case's own: no other `case` between
    if re.search(r'^[ \t]*case "', body[m.end():open_i], re.M):
        raise Fail('unexpected shape: case "%s" falls through to another case' % action)
    return open_i, close_i


def hook4(text):
    a, b = split_doPost(text)
    body = text[a:b]
    states = {}
    fails = []
    # work from the last case to the first so spans stay valid
    spans = []
    for action in FILTERED:
        try:
            o, c = case_return_span(body, action)
        except Fail as e:
            fails.append(str(e))
            continue
        spans.append((o, c, action))
    for o, c, action in sorted(spans, reverse=True):
        expr = body[o + 1:c]
        if expr.lstrip().startswith('_p2Post("p4_filter",'):
            states[action] = "present"
            continue
        body = body[:o + 1] + '_p2Post("p4_filter", ' + expr + ", payload)" + body[c:]
        states[action] = "ADDED"
    if fails:
        raise Fail("\n  ".join(fails))
    return text[:a] + body + text[b:], states


def hook5(text):
    a, b = split_doPost(text)
    body = text[a:b]
    states = {}
    # ping: wrap the returned object
    try:
        o, c = case_return_span(body, "ping")
        expr = body[o + 1:c]
        if expr.lstrip().startswith('_p2Post("p4_pingDecorate",'):
            states["ping"] = "present"
        else:
            body = body[:o + 1] + '_p2Post("p4_pingDecorate", ' + expr + ", payload)" + body[c:]
            states["ping"] = "ADDED"
    except Fail as e:
        raise Fail(str(e))
    m = re.search(r"^([ \t]*)switch \(payload\.action\) \{\n", body, re.M)
    if not m:
        raise Fail("anchor missing: `switch (payload.action) {` in doPost")
    ind = m.group(1) + "  "
    add = ""
    for name in NEW_CASES:
        if re.search(r'^[ \t]*case "%s":' % re.escape(name), body, re.M):
            states[name] = "present"
            continue
        add += '%scase "%s":\n%s  return _json(%s(payload));\n\n' % (ind, name, ind, name)
        states[name] = "ADDED"
    if add:
        body = body[:m.end()] + add + body[m.end():]
    return text[:a] + body + text[b:], states


def wire(text, problems, log):
    for label, fn in (("H1", hook1), ("H2", hook2), ("H3", hook3)):
        try:
            text, st = fn(text)
            log.append("wire   %s %s" % (label, st))
        except Fail as e:
            problems.append("%s: %s" % (label, e))
    for label, fn in (("H4", hook4), ("H5", hook5)):
        try:
            text, states = fn(text)
            added = sorted(k for k, v in states.items() if v == "ADDED")
            log.append("wire   %s %d present, %d ADDED%s" % (label, len(states) - len(added), len(added),
                                                          (" (" + ", ".join(added) + ")") if added else ""))
        except Fail as e:
            problems.append("%s: %s" % (label, e))
    return text


# ----------------------------------------------------------------------------- check

FUNC_RE = re.compile(r"^function\s+([A-Za-z_$][\w$]*)\s*\(", re.M)
GLOBAL_RE = re.compile(r"^(?:var|let|const)\s+([A-Za-z_$][\w$]*)\b", re.M)


def strip_merged(text):
    for name in CHUNKS:
        text = section_re(name).sub("", text)
    return text


def declared(text):
    return set(FUNC_RE.findall(text)), set(GLOBAL_RE.findall(text))


def check(text, chunks_dir, problems, log, require_chunks=True):
    # 1. every chunk merged, identical to the file in the chunks folder
    found = {}
    for name in CHUNKS:
        path = os.path.join(chunks_dir, name)
        m = section_re(name).search(text)
        if not m:
            problems.append("not merged: %s" % name)
            continue
        found[name] = m.group(1)
        if os.path.exists(path):
            if norm_chunk(open(path, "rb").read().decode("utf-8")) != m.group(1):
                problems.append("merged copy differs from chunk: %s (rerun --merge)" % name)
        elif require_chunks:
            problems.append("chunk file missing, cannot compare: %s" % name)
    # 2. hooks present
    for label, fn in (("H1", hook1), ("H2", hook2), ("H3", hook3)):
        try:
            _, st = fn(text)
            if st != "present":
                problems.append("hook missing: %s" % label)
        except Fail as e:
            problems.append("%s: %s" % (label, e))
    for label, fn in (("H4", hook4), ("H5", hook5)):
        try:
            _, states = fn(text)
            missing = sorted(k for k, v in states.items() if v != "present")
            if missing:
                problems.append("hook %s missing for: %s" % (label, ", ".join(missing)))
        except Fail as e:
            problems.append("%s: %s" % (label, e))
    # 3. duplicate declarations: chunk vs original code, and chunk vs chunk
    base_f, base_g = declared(strip_merged(text))
    seen_f, seen_g = {}, {}
    for name, body in found.items():
        fs, gs = declared(body)
        for f in sorted(fs):
            if f in base_f:
                problems.append("%s defines function %s that already exists in Code.gs" % (name, f))
            if f in seen_f:
                problems.append("function %s defined in both %s and %s" % (f, seen_f[f], name))
            seen_f.setdefault(f, name)
        for g in sorted(gs):
            if g in base_g:
                problems.append("%s declares global %s that already exists in Code.gs" % (name, g))
            if g in seen_g:
                problems.append("global %s declared in both %s and %s" % (g, seen_g[g], name))
            seen_g.setdefault(g, name)
    # 4. every new router case has a handler; every p4f_* has its wrapped action
    if found:
        for n in NEW_CASES:
            if n not in seen_f:
                problems.append("router case %s has no handler function in the merged chunks" % n)
        for f, name in sorted(seen_f.items()):
            if f.startswith("p4f_") and f[4:] not in FILTERED:
                problems.append("%s (in %s) is a response filter for %s, which is not in the wired FILTERED list"
                                % (f, name, f[4:]))
        for need in ("p4_gate", "p4_filter", "p4_tokenAllows", "p4_teacherAllows", "p4_pingDecorate"):
            if need not in seen_f:
                problems.append("required Phase 4 function %s is not defined in the merged chunks" % need)
        m = re.search(r"function\s+p4_pingDecorate\s*\(([^)]*)\)", "\n".join(found.values()))
        if m and len([p for p in m.group(1).split(",") if p.strip()]) < 2:
            problems.append("p4_pingDecorate must be (resp, payload): the ping hook calls it through _p2Post")
        m = re.search(r"function\s+p4_filter\s*\(([^)]*)\)", "\n".join(found.values()))
        if m and len([p for p in m.group(1).split(",") if p.strip()]) < 2:
            problems.append("p4_filter must be (resp, payload): hook H4 calls it through _p2Post")
    # 5. duplicate case labels inside doPost
    try:
        a, b = split_doPost(text)
        labels = re.findall(r'^[ \t]*case "([^"]+)":', text[a:b], re.M)
        dup = sorted({x for x in labels if labels.count(x) > 1})
        if dup:
            problems.append("duplicate case labels in doPost: " + ", ".join(dup))
    except Fail as e:
        problems.append(str(e))
    log.append("check  %d chunk section(s) found" % len(found))


def list_actions(text):
    a, b = split_doPost(text)
    return sorted(set(re.findall(r'^[ \t]*case "([^"]+)":', text[a:b], re.M)))


# ----------------------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description="Assemble Phase 4 into Code.gs (see module docstring).")
    ap.add_argument("--merge", action="store_true")
    ap.add_argument("--wire", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--list-actions", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-missing", action="store_true", help="--merge: skip chunks that are not in the folder")
    ap.add_argument("--code", default=DEFAULT_CODE)
    ap.add_argument("--chunks", default=DEFAULT_CHUNKS)
    args = ap.parse_args(argv)
    if not (args.merge or args.wire or args.check or args.list_actions):
        ap.print_help()
        return 2
    problems, log = [], []
    try:
        text, eol = read_text(args.code)
    except (Fail, OSError) as e:
        print("ERROR: %s" % e)
        return 1
    if args.list_actions:
        try:
            print("\n".join(list_actions(text)))
            return 0
        except Fail as e:
            print("ERROR: %s" % e)
            return 1
    if args.check:
        if args.merge or args.wire:
            print("ERROR: --check changes nothing; do not combine it with --merge/--wire")
            return 2
        check(text, args.chunks, problems, log)
    else:
        new = text
        if args.merge:
            new = merge(new, args.chunks, problems, log, args.allow_missing)
        if args.wire:
            new = wire(new, problems, log)
        if not problems and new != text and not args.dry_run:
            write_text(args.code, new, eol)
            log.append("wrote  %s" % args.code)
        elif not problems and new == text:
            log.append("nothing to change")
        elif args.dry_run and not problems:
            log.append("dry run: %s would change" % args.code)
    for line in log:
        print(line)
    if problems:
        print("\nFAILED (%d):" % len(problems))
        for p in problems:
            print("  - " + p)
        if not args.check:
            print("Code.gs was NOT written.")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
