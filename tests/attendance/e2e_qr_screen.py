# python tests/attendance/e2e_qr_screen.py : the dashboard's QR screen and phone fit, in real Chromium (docs/attendance/decisions.md D13, D14).
# Real AttendanceAll.gs on the emulated backend (docs/attendance/screenshots/dashboard_backend.js); nothing reaches the live system.
#  - students arriving: the counters (Attended / New sign-ups / Cheating caught / Need a look) count up to the right totals,
#    one card per arrival (a red one for cheating), the QR ripples, the screen edge flashes red for cheating
#  - a new lecture starts from zero with no burst of old cards
#  - with "reduce motion" the final numbers are still shown
#  - phones (360 / 390 / 430 px): no tab scrolls sideways, table buttons are at least 44 px, the QR screen fits and its controls are reachable
import json, os, subprocess, sys, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
passed = 0
def ok(c, m):
    global passed
    if not c: raise SystemExit("FAIL: " + m)
    passed += 1; print("  ok  " + m)

srv = subprocess.Popen(["node", os.path.join(ROOT, "docs/attendance/screenshots/dashboard_backend.js")], cwd=ROOT, stdout=subprocess.PIPE, text=True)
TOK = json.loads(srv.stdout.readline())["token"]
BASE = "http://127.0.0.1:8767"
def post(path, body=b""): return urllib.request.urlopen(urllib.request.Request(BASE + path, data=body, method="POST")).read()
def api(route): route.fulfill(status=200, content_type="application/json", body=post("/api", (route.request.post_data or "{}").encode()))
def newest(): return json.loads(post("/api", json.dumps({"action": "att_sessions", "token": TOK, "limit": 1}).encode()))["sessions"][0]["session_id"]
def page_for(b, **kw):
    p = b.new_page(**kw); p.route("https://script.google.com/**", api)
    p.add_init_script("sessionStorage.setItem('att_admin', %r)" % TOK)
    p.goto(BASE + "/attend/admin/index.html"); p.wait_for_selector("#panel:not([hidden])"); return p
def start(p, course):
    p.click("nav [data-tab=session]"); p.fill("#course", course); p.click("#startBtn")
    p.wait_for_selector("#proj:not([hidden])"); p.wait_for_timeout(4500)   # first poll: counters start at the current numbers
    return newest()
def tiles(p): return p.evaluate("['pAtt','pReg','pBad','pLook'].map(i=>+document.getElementById(i).textContent)")

errors = []
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        print("students arriving (projector)")
        p = page_for(b, viewport={"width": 1366, "height": 768}); p.on("pageerror", lambda e: errors.append(str(e)))
        sid = start(p, "QR test")
        ok(tiles(p) == [0, 0, 0, 0] and p.locator("#parrive .arr").count() == 0, "a new lecture starts at 0 with no cards")
        for k in ["att", "att", "reg", "bad"]: post("/sim?s=%s&k=%s" % (sid, k))
        seen = p.evaluate("""() => new Promise(res => { const s = new Set(), t0 = Date.now();
          (function look() { document.querySelectorAll('#parrive .arr').forEach(c => s.add(c.className.replace(' out', '')));
            if (s.has('arr bad') || Date.now() - t0 > 9000) res([...s]); else setTimeout(look, 100); })(); })""")
        ok("arr bad" in seen and "arr reg" in seen and "arr att" in seen, "cards arrive one after another: checked in, registered, and a red cheating card: " + ", ".join(seen))
        ok(p.evaluate("document.getElementById('proj').classList.contains('alarm')") or p.evaluate("document.getElementById('qr').classList.contains('ripple')"), "the QR ripples / the screen edge flashes")
        p.wait_for_function("+document.getElementById('pAtt').textContent === 2 && +document.getElementById('pReg').textContent === 2 && +document.getElementById('pBad').textContent >= 1", timeout=10000)
        ok(True, "the counters count up to the totals (attended 2, new sign-ups 2: a teacher sees a sign-up once that student checked in to their lecture; cheating caught >= 1): %s" % tiles(p))
        ok("Present 2" in p.evaluate("document.getElementById('pcount').textContent"), "the screen-reader line has the same numbers")
        p.wait_for_timeout(6000)
        ok(p.locator("#parrive .arr").count() == 0, "the cards leave after a few seconds")
        p.close()
        print("reduce motion")
        p = page_for(b, viewport={"width": 1366, "height": 768}, reduced_motion="reduce")
        sid = start(p, "QR test RM")
        for k in ["att", "att"]: post("/sim?s=%s&k=%s" % (sid, k))
        p.wait_for_function("+document.getElementById('pAtt').textContent === 2", timeout=10000)
        ok(True, "with reduce motion the final numbers are shown")
        p.close()
        print("phones")
        for w in (360, 390, 430):
            p = page_for(b, viewport={"width": w, "height": 800}, is_mobile=True, has_touch=True)
            wide, small = [], []
            for tname in ["session", "manual", "requests", "flagged", "roster", "calib", "history"]:
                p.click("nav [data-tab=%s]" % tname); p.wait_for_timeout(600)
                if p.evaluate("document.documentElement.scrollWidth") > w: wide.append(tname)
                small += p.evaluate("[...document.querySelectorAll('#panel button')].filter(b=>b.offsetParent&&b.getBoundingClientRect().height<44).map(b=>b.textContent.trim())")
            ok(not wide, "%d px: no tab scrolls sideways %s" % (w, wide))
            ok(not small, "%d px: every visible button is at least 44 px tall %s" % (w, small[:5]))
            start(p, "Phone %d" % w)
            fit = p.evaluate("(function(){var q=document.getElementById('qr').getBoundingClientRect(),c=document.getElementById('pctl').getBoundingClientRect();return [q.left>=0&&q.right<=innerWidth, c.bottom<=innerHeight+1, document.documentElement.scrollWidth<=innerWidth]})()")
            ok(all(fit), "%d px: the QR fits, the controls are on screen, nothing scrolls sideways %s" % (w, fit))
            ok(p.is_hidden("#fsBtn") and p.is_visible("#closeBtn"), "%d px: Fullscreen is hidden on touch screens, End attendance is there" % w)
            p.close()
        ok(not errors, "no page errors " + "; ".join(errors[:3]))
        b.close()
finally:
    srv.terminate()
print("\n%d QR screen / phone checks passed" % passed)
