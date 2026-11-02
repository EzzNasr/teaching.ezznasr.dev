#!/usr/bin/env python3
"""
build_server_logic.py -- turn the browser follow-up logic into an Apps Script file.

The page (assets/followup-logic.js + assets/followup-events.js) and the Telegram tick on the server must
agree on "what is due". They do, because the server runs the SAME code: this script copies the two browser
modules, unchanged, into tools/quiz-maker-v2/apps_script/FollowupLogic.gs and adds a thin wrapper:

  * an Intl shim built on Utilities.formatDate (Apps Script's own time-zone database), so the Alex-time
    maths is identical to the browser's and does not depend on the V8 runtime's Intl support;
  * fu2_logic_eventsFor_(overview, groupKey, nowIso)   -> FollowupEvents.eventsFor
  * fu2_logic_dueNow_(overview, nowIso)                -> FollowupEvents.dueNow
  * fu2_logic_version_()                               -> "<module version>+<source hash>"
  * fu2_logic_selfCheck()                              -> run it once in the Apps Script editor (see the file)

    python scripts/build_server_logic.py            write FollowupLogic.gs
    python scripts/build_server_logic.py --check    do not write; exit 0 if the file is current, 1 if stale, 2 if a file is missing
    python scripts/build_server_logic.py --root C:\\path\\to\\site   (default: the site this script lives in)

Never edit FollowupLogic.gs by hand: change the two sources and run this again. The same pattern as
tools/quiz-maker-v2/check_asset_drift.py: line endings are ignored when comparing. Standard library only.
"""

import difflib
import hashlib
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.path.abspath(os.path.join(HERE, ".."))
SRC_LOGIC = os.path.join("assets", "followup-logic.js")
SRC_EVENTS = os.path.join("assets", "followup-events.js")
OUT = os.path.join("tools", "quiz-maker-v2", "apps_script", "FollowupLogic.gs")
MAX_DIFF_LINES = 40


def read(path):
    with open(path, "r", encoding="utf-8", newline=None) as f:     # universal newlines -> "\n"
        return f.read()


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


TEMPLATE = r'''// =============================================================================================
//  FollowupLogic.gs  --  GENERATED FILE.  DO NOT EDIT BY HAND.
//
//  Built by:  python scripts/build_server_logic.py        (CI / pre-deploy:  --check)
//  Sources (sha256, line endings normalised):
//    assets/followup-logic.js    @@HASH_LOGIC@@
//    assets/followup-events.js   @@HASH_EVENTS@@
//
//  What it is: the browser modules FollowupLogic and FollowupEvents, copied unchanged and wrapped so
//  that the Telegram tick and the follow-up page decide "what is due" with the SAME code.
//  Public functions:
//    fu2_logic_eventsFor_(overview, groupKey, nowIso)
//    fu2_logic_dueNow_(overview, nowIso)
//    fu2_logic_version_()
//    fu2_logic_selfCheck()      <- run this once from the Apps Script editor after every deploy
//
//  Time zone: every date is computed in Africa/Cairo through Utilities.formatDate; any text a person
//  reads says "Alex".
// =============================================================================================

var FU2_LOGIC_VERSION = "@@VERSION@@";

// Intl stand-in (only DateTimeFormat#formatToParts is used by the two modules).
var FU2_LOGIC_INTL_ = {
  DateTimeFormat: function (locale, opts) {
    var tz = (opts && opts.timeZone) || "Africa/Cairo";
    return {
      formatToParts: function (date) {
        var s = Utilities.formatDate(date, tz, "yyyy-MM-dd HH:mm:ss");
        var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
        if (!m) throw new Error("fu2_logic: unexpected Utilities.formatDate output: " + s);
        return [
          { type: "year", value: m[1] }, { type: "literal", value: "-" },
          { type: "month", value: m[2] }, { type: "literal", value: "-" },
          { type: "day", value: m[3] }, { type: "literal", value: " " },
          { type: "hour", value: m[4] }, { type: "literal", value: ":" },
          { type: "minute", value: m[5] }, { type: "literal", value: ":" },
          { type: "second", value: m[6] }
        ];
      }
    };
  }
};

// ---- assets/followup-logic.js (verbatim) ----
var FU2_LOGIC_LOGIC_ = (function () {
  var module = { exports: {} };
  var Intl = FU2_LOGIC_INTL_;
@@SRC_LOGIC@@
  return module.exports;
})();

// ---- assets/followup-events.js (verbatim) ----
var FU2_LOGIC_EVENTS_ = (function () {
  var module = { exports: {} };
  var Intl = FU2_LOGIC_INTL_;
  var require = function (name) {
    if (/followup-logic/.test(String(name))) return FU2_LOGIC_LOGIC_;
    throw new Error("fu2_logic: unexpected require(" + name + ")");
  };
@@SRC_EVENTS@@
  return module.exports;
})();

function fu2_logic_eventsFor_(overview, groupKey, nowIso) {
  return FU2_LOGIC_EVENTS_.eventsFor(overview, groupKey, nowIso);
}

function fu2_logic_dueNow_(overview, nowIso) {
  return FU2_LOGIC_EVENTS_.dueNow(overview, nowIso);
}

function fu2_logic_version_() {
  return FU2_LOGIC_VERSION;
}

/**
 * Run from the Apps Script editor (pick fu2_logic_selfCheck, press Run, read the log).
 * 1. Checks that Apps Script's own time-zone data knows Egypt's 2026 clock changes
 *    (forward Fri 24 Apr 00:00 -> 01:00, back Thu 29 Oct 24:00 -> 23:00). If this fails, the
 *    server would compute reminder times an hour off in the weeks around those dates.
 * 2. Runs the engine on a tiny made-up group.
 * Returns {ok, version, failures[]} and logs it.
 */
function fu2_logic_selfCheck() {
  var failures = [];
  var cases = [
    ["2026-04-23T21:59:59Z", "2026-04-23 23:59:59"],
    ["2026-04-23T22:00:00Z", "2026-04-24 01:00:00"],
    ["2026-10-29T20:59:59Z", "2026-10-29 23:59:59"],
    ["2026-10-29T21:00:00Z", "2026-10-29 23:00:00"],
    ["2026-11-06T14:30:00Z", "2026-11-06 16:30:00"]
  ];
  cases.forEach(function (c) {
    var got = Utilities.formatDate(new Date(c[0]), "Africa/Cairo", "yyyy-MM-dd HH:mm:ss");
    if (got !== c[1]) failures.push("time zone: " + c[0] + " shows " + got + ", expected " + c[1]);
  });
  try {
    var lesson = "programming/x/lesson-1";
    var ov = {
      now: "2026-11-04T17:00:00+02:00", settings: {}, lessons: {}, parent_log: {},
      facts: { "1000000101": {} },
      groups: [{ group: "Check", key: "check", settings: { weekday: 6, time: "18:00", current_lesson: lesson, review_lessons: [] },
                 members: [{ phone: "01000000101", name: "A" }], done: ["advance|2026-10-31"] }]
    };
    ov.facts["1000000101"][lesson] = { attendance: "online", watch_pct: 10, can_watch: true };
    var r = fu2_logic_eventsFor_(ov, "check", ov.now);
    if (!r || r.phase !== "remind_watch") failures.push("engine: expected phase remind_watch, got " + (r && r.phase));
    var d = fu2_logic_dueNow_(ov, ov.now);
    if (!d || d.length !== 1 || d[0].key !== "remind_watch") failures.push("engine: dueNow returned " + JSON.stringify(d));
    else if (r.events[0].fire_at_iso === undefined) failures.push("engine: no fire_at_iso");
  } catch (e) {
    failures.push("engine threw: " + e);
  }
  var res = { ok: failures.length === 0, version: FU2_LOGIC_VERSION, failures: failures };
  Logger.log(JSON.stringify(res));
  return res;
}
'''


def version_of(events_src, h_logic, h_events):
    m = re.search(r"var VERSION = '([^']+)'", events_src)
    base = m.group(1) if m else "0"
    return "%s+%s" % (base, sha(h_logic + h_events)[:12])


def render(root):
    p_logic = os.path.join(root, SRC_LOGIC)
    p_events = os.path.join(root, SRC_EVENTS)
    missing = [p for p in (p_logic, p_events) if not os.path.exists(p)]
    if missing:
        return None, missing
    logic, events = read(p_logic), read(p_events)
    for name, src in (("followup-logic.js", logic), ("followup-events.js", events)):
        if "\u2028" in src or "\u2029" in src:
            raise SystemExit("%s contains a line/paragraph separator; remove it before generating." % name)
    h_logic, h_events = sha(logic), sha(events)
    out = TEMPLATE
    out = out.replace("@@HASH_LOGIC@@", h_logic).replace("@@HASH_EVENTS@@", h_events)
    out = out.replace("@@VERSION@@", version_of(events, h_logic, h_events))
    out = out.replace("@@SRC_LOGIC@@", logic.rstrip("\n")).replace("@@SRC_EVENTS@@", events.rstrip("\n"))
    return out, []


def main(argv):
    args = argv[1:]
    check = "--check" in args
    root = DEFAULT_ROOT
    if "--root" in args:
        i = args.index("--root")
        if i + 1 >= len(args):
            print("--root needs a folder")
            return 2
        root = os.path.abspath(args[i + 1])
    out_path = os.path.join(root, OUT)
    text, missing = render(root)
    if missing:
        for p in missing:
            print("MISSING  {}".format(p))
        return 2
    if check:
        if not os.path.exists(out_path):
            print("MISSING  {}  (run: python scripts/build_server_logic.py)".format(OUT))
            return 2
        actual = read(out_path)
        if actual == text:
            print("ok       {}  (matches the two sources)".format(OUT))
            return 0
        print("DRIFT    {}  (stale: a source changed, or the file was edited by hand)".format(OUT))
        diff = list(difflib.unified_diff(actual.splitlines(), text.splitlines(), OUT + "  (on disk)", OUT + "  (would be generated)", lineterm="", n=1))
        for line in diff[:MAX_DIFF_LINES]:
            print("    " + line)
        if len(diff) > MAX_DIFF_LINES:
            print("    ... {} more diff lines".format(len(diff) - MAX_DIFF_LINES))
        print("\nFix: python scripts/build_server_logic.py   (never edit FollowupLogic.gs by hand)")
        return 1
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print("wrote    {}  ({} lines)".format(OUT, text.count("\n")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
