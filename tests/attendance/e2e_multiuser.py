"""Phase 4 (S4): the whole multi-user attendance system in a real Chromium, against the REAL AttendanceAll.gs on the emulator.
  python tests/attendance/e2e_multiuser.py        (needs playwright; starts its own backend on :8793)
Two teachers run sessions AT THE SAME TIME. Real student pages check in with real browser geolocation (granted, blocked, far away),
the escape hatch, and the offline-then-online upgrade. Then both dashboards are driven in the browser and isolation is checked."""
import hmac, hashlib, json, os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__)); SITE = os.path.abspath(os.path.join(HERE, "..", ".."))
PORT = 8793; BASE = "http://127.0.0.1:%d" % PORT; ADM = "adm-secret"
HALL = dict(latitude=31.2, longitude=29.9, accuracy=15); FAR = dict(latitude=31.21, longitude=29.9, accuracy=15)
passed = 0
def ok(c, m):
    global passed
    if not c: raise AssertionError(m)
    passed += 1; print("  ok  " + m)

def api(action, **p):
    p["action"] = action
    r = urllib.request.Request(BASE + "/api", data=json.dumps(p).encode(), method="POST")
    return json.loads(urllib.request.urlopen(r).read())
def qr_token(key, sid): return hmac.new(key.encode(), ("%s:%d" % (sid, int(time.time() // 10))).encode(), hashlib.sha256).hexdigest()[:16]
def fwd(route, req):
    r = urllib.request.Request(BASE + "/api", data=req.post_data.encode(), method="POST")
    route.fulfill(status=200, content_type="application/json", body=urllib.request.urlopen(r).read(), headers={"access-control-allow-origin": "*"})

srv = subprocess.Popen(["node", os.path.join(HERE, "e2e_multiuser_backend.js"), SITE, str(PORT)], stdout=subprocess.PIPE, text=True)
try:
    srv.stdout.readline()
    # ── two teachers, two rooms, two LIVE sessions at once ──
    def teacher(name):
        c = api("att_user_create", token=ADM, name=name); l = api("att_login", password=c["password"]); return dict(name=name, pw=c["password"], token=l["token"], id=c["user"]["user_id"])
    TA, TB = teacher("Dr Alpha"), teacher("Dr Beta")
    for T, course in ((TA, "Computer Organization"), (TB, "Networks")):
        room = api("att_calibrate_room", token=T["token"], name="Hall " + course, samples=[dict(lat=31.2, lng=29.9, acc=10)] * 3)["room"]["room_id"]
        s = api("att_start_session", token=T["token"], course=course, room_id=room); T.update(sid=s["session_id"], key=s["session_key"], course=course)
    ok(TA["sid"] != TB["sid"] and api("att_live", token=TA["token"], session_id=TA["sid"])["ok"] and api("att_live", token=TB["token"], session_id=TB["sid"])["ok"], "two teachers run sessions at the same time")

    with sync_playwright() as p:
        br = p.chromium.launch()
        def student_ctx(geo=None, granted=True):
            c = br.new_context(viewport=dict(width=390, height=800), geolocation=geo, permissions=["geolocation"] if (geo and granted) else [])
            c.route("https://script.google.com/**", fwd); return c
        def open_page(ctx, T, existing=None):
            pg = existing or ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.goto("%s/attend/index.html?s=%s&t=%s" % (BASE, T["sid"], qr_token(T["key"], T["sid"]))); pg.errs = errs; return pg
        def register(pg, sid, name):
            pg.wait_for_selector("#form:not([hidden])"); pg.fill("#sid", sid); pg.fill("#name", name); pg.click("#signup")
            pg.wait_for_selector("#done:not([hidden])", timeout=15000)

        # A1: location allowed, in the hall
        c1 = student_ctx(HALL); pg = open_page(c1, TA); register(pg, "30001", "Mona Ali")
        ok("recorded" in pg.inner_text("#doneTitle").lower() and "Mona" in pg.inner_text("#doneName") and ":" in pg.inner_text("#doneTime"), "A1 allowed + in the hall: success screen with name and time")
        ok(pg.evaluate("document.getElementById('busy').hidden"), "the loading overlay is gone after success")
        ok(pg.errs == [], "no page errors")

        # B1: teacher B's session at the same moment, student far away
        c3 = student_ctx(FAR); pgb = open_page(c3, TB); register(pgb, "30003", "Far Away")
        d = api("att_session_detail", token=TB["token"], session_id=TB["sid"])
        ok(len(d["checkins"]) == 1 and "GEO_FAR" in d["checkins"][0]["flags"], "B1 (teacher B's session) a student 1 km away is recorded with GEO_FAR")

        # A2: location blocked -> gate -> two failed tries -> escape hatch -> GEO_SKIPPED with the real reason
        c2 = student_ctx(None); pg2 = open_page(c2, TA)
        pg2.wait_for_selector("#gate:not([hidden])")
        ok(pg2.is_hidden("#form") and pg2.is_hidden("#sid"), "A2 blocked location: the gate shows and ID/name/Save are NOT usable")
        for _ in range(3):
            if not pg2.is_hidden("#gateSkipBox"): break
            if not pg2.is_hidden("#gateBtn"): pg2.click("#gateBtn")
            time.sleep(0.5)
        pg2.wait_for_selector("#gateSkipBox:not([hidden])", timeout=15000)
        ok("blocked" in (pg2.inner_text("#gateTitle") + pg2.inner_text("#gateText")).lower() or "location" in pg2.inner_text("#gateTitle").lower(), "...a specific message is shown: " + pg2.inner_text("#gateTitle"))
        pg2.click("#gateSkip"); register(pg2, "30002", "Omar Hassan")
        ok("recorded" in pg2.inner_text("#doneTitle").lower(), "...'Continue without location' completes the check-in")
        r2 = [x for x in api("att_session_detail", token=TA["token"], session_id=TA["sid"])["checkins"] if x["student_id"] == "30002"][0]
        ok("GEO_SKIPPED" in r2["flags"] and r2["geo_reason"] == "USER_SKIPPED" and r2["status"] == "review", "...stored as GEO_SKIPPED / USER_SKIPPED, status review: %s %s" % (r2["flags"], r2["geo_reason"]))
        log = json.loads(urllib.request.urlopen(BASE + "/__sheet/AttFlagLog").read())
        ok(any(row[2] == "30002" and row[3] == "GEO_SKIPPED" and "fail=" in row[4] for row in log[1:]), "...and the flag log keeps WHY it failed (fail=...): " + [row[4] for row in log[1:] if row[2] == "30002"][0])

        # A3: offline/blocked first, location works on the second try in the same session -> UPGRADE (never a permanent 'denied')
        c4 = student_ctx(None); pg4 = open_page(c4, TA); pg4.wait_for_selector("#gate:not([hidden])")
        for _ in range(3):
            if not pg4.is_hidden("#gateSkipBox"): break
            if not pg4.is_hidden("#gateBtn"): pg4.click("#gateBtn")
            time.sleep(0.5)
        pg4.wait_for_selector("#gateSkipBox:not([hidden])", timeout=15000); pg4.click("#gateSkip"); register(pg4, "30004", "Late Fix")
        first = [x for x in api("att_session_detail", token=TA["token"], session_id=TA["sid"])["checkins"] if x["student_id"] == "30004"][0]
        ok("GEO_SKIPPED" in first["flags"], "A3 first attempt without location is flagged GEO_SKIPPED")
        c4.set_geolocation(HALL); c4.grant_permissions(["geolocation"])
        pg4 = open_page(c4, TA, pg4)
        pg4.wait_for_selector("#form:not([hidden])", timeout=15000)
        ok("Late" in pg4.inner_text("#welcome"), "...reload: a returning student sees 'Welcome' and must tap (no auto check-in): " + pg4.inner_text("#welcome"))
        pg4.click("#save"); pg4.wait_for_selector("#done:not([hidden])", timeout=15000)
        rows = [x for x in api("att_session_detail", token=TA["token"], session_id=TA["sid"])["checkins"] if x["student_id"] == "30004"]
        ok(len(rows) == 1 and "GEO_SKIPPED" not in rows[0]["flags"] and rows[0]["geo_reason"] == "" and rows[0]["lat"] is not None, "...second attempt UPGRADES the same row: one check-in, coordinates stored, GEO_SKIPPED gone")
        log = json.loads(urllib.request.urlopen(BASE + "/__sheet/AttFlagLog").read())
        ok(any(row[2] == "30004" and row[3] == "GEO_UPGRADED" for row in log[1:]), "...GEO_UPGRADED is written to the flag log")

        # B2: the network drops at the tap -> "Not saved yet" + Retry, never a false success; back online, Retry records exactly one check-in
        c5 = student_ctx(HALL); pg5 = open_page(c5, TB); pg5.wait_for_selector("#form:not([hidden])")
        pg5.fill("#sid", "30005"); pg5.fill("#name", "Flaky Net")
        c5.route("https://script.google.com/**", lambda route, req: route.abort("internetdisconnected"))
        pg5.click("#signup"); pg5.wait_for_selector("#busyRetry:not([hidden])", timeout=60000)
        ok(pg5.is_hidden("#done") and "not saved" in pg5.inner_text("#busy").lower(), "B2 network down at the tap: 'Not saved yet' + Retry, no false success")
        ok(len(api("att_session_detail", token=TB["token"], session_id=TB["sid"])["checkins"]) == 1, "...nothing was written by the failed attempt")
        c5.unroute("https://script.google.com/**"); c5.route("https://script.google.com/**", fwd)
        pg5.click("#busyRetry"); pg5.wait_for_selector("#done:not([hidden])", timeout=20000)
        ok(len([x for x in api("att_session_detail", token=TB["token"], session_id=TB["sid"])["checkins"] if x["student_id"] == "30005"]) == 1, "...Retry after reconnecting records exactly ONE check-in")

        # ── isolation + totals, straight from the API ──
        ok(api("att_session_detail", token=TA["token"], session_id=TB["sid"])["code"] == "UNAUTHORIZED" and api("att_session_detail", token=TB["token"], session_id=TA["sid"])["code"] == "UNAUTHORIZED", "teacher A cannot open B's session and vice versa")
        ok(api("att_live", token=TA["token"], session_id=TA["sid"])["present"] == 3 and api("att_live", token=TB["token"], session_id=TB["sid"])["present"] == 2, "live counts are per session: A=3, B=2")
        ok(api("att_close_session", token=TA["token"], session_id=TB["sid"])["code"] == "UNAUTHORIZED", "teacher A cannot close B's session")
        for T in (TA, TB): ok(api("att_close_session", token=T["token"], session_id=T["sid"])["ok"], "teacher %s closes their own session" % T["name"])
        ov = api("att_overview", token=ADM); tot = ov["totals"]
        ok(tot["sessions"] == 2 and tot["present"] == 5 and ov["by_user"][0]["name"] in ("Admin", "Dr Alpha"), "admin overview: 2 sessions, 5 present")

        # ── dashboards in the browser ──
        def dash(secret):
            c = br.new_context(viewport=dict(width=1100, height=900)); c.route("https://script.google.com/**", fwd); pg = c.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e))); pg.goto(BASE + "/attend/admin/index.html"); pg.wait_for_selector("#login:not([hidden])")
            pg.fill("#tok", secret); pg.click("#loginBtn"); pg.wait_for_selector("#panel:not([hidden])"); pg.errs = errs; return pg
        da = dash(TA["pw"]); da.click("nav [data-tab=history]"); da.wait_for_selector("#hisTable table")
        txt = da.inner_text("#hisTable")
        ok("Computer Organization" in txt and "Networks" not in txt, "teacher A's dashboard History shows only A's session")
        da.click("#hisTable button"); da.wait_for_selector("#detTable table")
        dt = da.inner_text("#detTable")
        ok(all(x in dt for x in ("Mona Ali", "Omar Hassan", "Late Fix")) and "Far Away" not in dt, "...and A's three students, not B's")
        ok("GEO_SKIPPED" in dt and "USER_SKIPPED" in dt, "...with the skipped check-in visible and its reason")
        da.fill("#detTable tr:has-text('Omar') input", "I saw him in class"); da.click("#detTable tr:has-text('Omar') button:has-text('Accept')")
        da.wait_for_selector("#detTable tr:has-text('Omar'):has-text('accepted')")
        r = [x for x in api("att_session_detail", token=TA["token"], session_id=TA["sid"])["checkins"] if x["student_id"] == "30002"][0]
        ok(r["review_status"] == "accepted" and r["reviewed_by"] == TA["id"] and r["review_note"] == "I saw him in class", "a teacher accepts the skipped check-in from the dashboard; stored with reviewer and note")
        ok(da.is_hidden("#tabUsers") and da.is_hidden("#tabOverview"), "teacher dashboard hides Users and All sessions")
        ok(da.errs == [], "no page errors on the teacher dashboard")
        dm = dash(ADM); dm.click("#tabOverview"); dm.wait_for_selector("#ovUsers table"); ot = dm.inner_text("#ovUsers")
        ok("Dr Alpha" in ot and "Dr Beta" in ot, "admin overview lists both teachers")
        dm.click("#ovUsers tr:has-text('Dr Beta') button"); dm.wait_for_function("() => { const t = document.getElementById('hisTable').innerText; return t.includes('Networks') && !t.includes('Computer Organization'); }", timeout=10000)
        ok("Computer Organization" not in dm.inner_text("#hisTable"), "drill-down from a teacher shows only that teacher's sessions")
        dm.click("#tabUsers"); dm.wait_for_selector("#userList table")
        dm.fill("#userName", "Dr Gamma"); dm.click("#userCreate"); dm.wait_for_selector("#secret:not([hidden])")
        pw = dm.inner_text("#secretPw")
        ok(api("att_login", password=pw)["ok"], "admin creates a teacher in the browser; the password shown works")
        ok(dm.errs == [], "no page errors on the admin dashboard")
        br.close()
    print("\n%d multi-user e2e checks passed" % passed)
finally:
    srv.terminate()
