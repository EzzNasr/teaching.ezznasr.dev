#!/usr/bin/env python3
"""R-P4-S4-05: desktop teacher mode (modules/teacher_mode.py + the drive_bridge guards + app_main hook).
Runs a tiny local HTTP server that answers `ping` like the Phase 4 backend. No tkinter needed."""
import http.server, json, os, re, sys, threading

HERE = os.path.dirname(os.path.abspath(__file__))
QM = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, QM)
from modules import teacher_mode as tm, drive_bridge as db   # noqa: E402

fails = 0
def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)))
    fails += 0 if ok else 1

ALL = [("programming", "Programming"), ("english", "English"), ("math", "Math")]
ANSWER = {"resp": {"ok": True, "message": "pong"}}
CALLS = []

class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        CALLS.append(body)
        out = json.dumps(ANSWER["resp"]).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass

srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:%d/exec" % srv.server_address[1]
cfg = lambda c: {"web_app_url": c.get("drive_web_app_url", ""), "admin_token": c.get("drive_admin_token", "")}

# 1. identity parsing
old = tm.identity_from_ping({"ok": True, "message": "pong"})
check("old backend ping = owner, unknown", old["kind"] == "owner" and not old["known"] and not tm.is_restricted(old))
t = tm.identity_from_ping({"ok": True, "kind": "teacher", "subjects": ["Math"], "name": "Mr Samy"})
check("teacher ping parsed, lowercased", t["kind"] == "teacher" and t["subjects"] == ["math"] and t["name"] == "Mr Samy")
check("owner ping not restricted", not tm.is_restricted(tm.identity_from_ping({"kind": "owner", "subjects": ["*"], "name": ""})))
check("garbage ping is owner/unknown", tm.identity_from_ping(None)["known"] is False)

# 2. filtering in place + re-apply
subs = list(ALL); ref = subs
hidden = tm.filter_subjects(subs, t)
check("teacher sees only math, same list object", subs == [("math", "Math")] and subs is ref, subs)
check("hidden list reported", sorted(hidden) == ["english", "programming"], hidden)
tm.filter_subjects(subs, tm.identity_from_ping({"kind": "owner", "subjects": ["*"], "name": ""}))
check("re-apply with owner restores all subjects", subs == ALL, subs)
two = tm.identity_from_ping({"kind": "teacher", "subjects": ["math", "english"], "name": "x"})
tm.filter_subjects(subs, two)
check("two-subject teacher keeps both in original order", [s for s, _ in subs] == ["english", "math"], subs)
none = tm.identity_from_ping({"kind": "teacher", "subjects": ["chemistry"], "name": "x"})
st = tm.apply(none, subs)
check("unknown scope never empties the list", len(subs) == 3 and "problem" in st, (subs, st))
tm.reset()

# 3. guards
tm.apply(t, subs)
check("guard allows own subject", tm.allowed("math") and tm.allowed("math/chapter-1/lesson-1#ch1"))
check("guard refuses other subject", not tm.allowed("programming/a/b") and not tm.allowed("english"))
check("guard ignores unknown first segment (server decides)", tm.allowed("lesson-1-intro"))
try:
    tm.guard_subject("english/x"); check("guard raises", False)
except tm.TeacherModeError as e:
    check("guard raises TeacherModeError with a clear message", "math" in str(e) and "english" in str(e), str(e))

CALLS.clear()
for name, fn in (("upload_attachment", lambda: db.upload_attachment(URL, "k", "english", "english/x", __file__, "t")),
                 ("set_video", lambda: db.set_video(URL, "k", "programming/x", "lesson", "https://y")),
                 ("set_quiz_content", lambda: db.set_quiz_content(URL, "k", "english/x", {})),
                 ("set_written_models", lambda: db.set_written_models(URL, "k", "programming/x", []))):
    try:
        fn(); check("drive_bridge.%s refuses another subject" % name, False)
    except db.DriveBridgeError as e:
        check("drive_bridge.%s refuses another subject (DriveBridgeError)" % name, True)
check("refused calls never reached the network", len(CALLS) == 0, CALLS)
ANSWER["resp"] = {"ok": True}
CALLS.clear()
db.set_video(URL, "k", "math/x", "lesson", "https://y")
check("own-subject call goes through", len(CALLS) == 1 and CALLS[0]["action"] == "admin_set_video")
tm.reset()
db.set_video(URL, "k", "programming/x", "lesson", "https://y")
check("no restriction after reset()", CALLS[-1]["lesson"] == "programming/x")

# 4. startup() against the local server
subs = list(ALL)
ANSWER["resp"] = {"ok": True, "message": "pong", "kind": "teacher", "subjects": ["math"], "name": "Mr Samy"}
ident, badge, problem = tm.startup({"drive_web_app_url": URL, "drive_admin_token": "tok"}, subs, cfg)
check("startup filters from a teacher ping", subs == [("math", "Math")] and ident["kind"] == "teacher", subs)
check("badge names teacher and scope", "Mr Samy" in badge and "math" in badge, badge)
ANSWER["resp"] = {"ok": True, "message": "pong"}
ident, badge, problem = tm.startup({"drive_web_app_url": URL, "drive_admin_token": "tok"}, subs, cfg)
check("startup with an old backend restores all subjects", subs == ALL and badge == "", (subs, badge))
ANSWER["resp"] = {"ok": False, "error": "Not authorized."}
ident, badge, problem = tm.startup({"drive_web_app_url": URL, "drive_admin_token": "bad"}, subs, cfg)
check("startup with a refused token: no crash, no filtering, a message", ident is None and subs == ALL and "verify" in badge, badge)
ident, badge, problem = tm.startup({"drive_web_app_url": "http://127.0.0.1:9/x", "drive_admin_token": "tok"}, subs, cfg)
check("startup offline: no crash, no filtering", ident is None and subs == ALL and badge, badge)
ident, badge, problem = tm.startup({}, subs, cfg)
check("startup with no config does nothing", ident is None and badge == "" and subs == ALL)
check("test_connection returns the whole ping answer", db.test_connection.__doc__ and "kind" in db.test_connection.__doc__)

# 5. static checks on the files this session edits
src = open(os.path.join(QM, "app_main.py"), encoding="utf-8").read()
check("app_main imports teacher_mode and runs startup before building tabs",
      "teacher_mode.startup(" in src and src.index("teacher_mode.startup(") < src.index("self._build_top_bar()"))
common = open(os.path.join(QM, "modules", "common.py"), encoding="utf-8").read()
m = re.search(r"^SUBJECTS = (\[.*\])", common, re.M)
check("common.SUBJECTS still the (slug, label) list teacher_mode expects", bool(m) and '"math"' in m.group(1), m and m.group(1))
ex = json.load(open(os.path.join(QM, "quiz_maker_config.example.json"), encoding="utf-8"))
check("example config mentions the teacher token and keeps its three keys",
      "drive_admin_token" in ex.get("_note", "") and all(k in ex for k in ("site_root", "drive_web_app_url", "drive_admin_token")))
sys.exit(1 if fails else 0)
