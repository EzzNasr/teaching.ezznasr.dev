#!/usr/bin/env python3
"""
e2e_video.py — real-browser (Chromium) tests for assets_templates/video.js.

It runs the REAL Code.gs (through the Node test harness, see e2e_backend.js) as a
local backend, serves the REAL auth.js / video.js / base.css to fake pages, and
drives them with Playwright. Nothing touches your live site or Sheet.

One-time setup (optional, only if you want to run this yourself):
    pip install playwright
    playwright install chromium

Run from tools/quiz-maker-v2:
    python tests/e2e_video.py

Needs Node (for the backend) and the repo layout it lives in.
"""
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
QM = os.path.dirname(HERE)                                   # tools/quiz-maker-v2
SITE_ROOT = os.path.abspath(os.path.join(QM, "..", ".."))    # the repo
CODE_GS = os.path.join(QM, "apps_script", "Code.gs")


def _free_port():
    # A fixed port (it used to be 8765) collides with a backend an earlier test left running, and the test
    # then talks to that stale server. e2e_capture / e2e_one_group / e2e_p3_bulk_access reuse this via E.PORT.
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        return so.getsockname()[1]


PORT = _free_port()
GAS = "https://script.google.com/macros/s/TEST/exec"
SITE = "https://site.test"   # https: the sign-in code needs a secure context (crypto.subtle)

passed = failed = 0


def play(pg):
    """The video shows a click-to-play poster first (lite embed); tap it, then the iframe appears.
    On a quiz / assignment page that is still covered ("finish it first") the poster is hidden under the cover:
    then nothing is tapped and slot_video_id() reads the id from the poster instead."""
    pg.wait_for_selector(".media-slot .vp-poster, .media-slot iframe", state="attached")
    if pg.locator(".media-slot .vp-poster").count() and pg.is_visible(".media-slot .vp-poster"):
        pg.click(".media-slot .vp-poster")
        pg.wait_for_selector(".media-slot iframe")


def slot_video_id(pg):
    """The video the slot holds: from the iframe, or from the poster image (i.ytimg.com/vi/<id>/...)."""
    if pg.locator(".media-slot iframe").count():
        return yt_id(pg.get_attribute(".media-slot iframe", "src"))
    st = pg.get_attribute(".media-slot .vp-poster", "style") or ""
    return st.split("/vi/")[1].split("/")[0] if "/vi/" in st else ""


def yt_id(src):
    """Video id from an embed URL (www.youtube-nocookie.com/embed/<id>?controls=0&...)."""
    return str(src or "").split("?")[0].rstrip("/").split("/")[-1]


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("PASS " + name)
    else:
        failed += 1
        print("FAIL " + name + ("  -> " + str(extra) if extra else ""))


def api(payload, path="/exec"):
    req = urllib.request.Request(
        "http://127.0.0.1:%d%s" % (PORT, path), data=json.dumps(payload).encode(), method="POST"
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


sha = lambda s: hashlib.sha256(s.encode()).hexdigest()
TOK = {"token": "tok"}


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n")


ASSETS = {
    "/assets/auth.js": read(QM, "assets_templates", "auth.js").replace("{{DRIVE_ENDPOINT}}", GAS),
    "/assets/video.js": read(QM, "assets_templates", "video.js").replace("{{DRIVE_ENDPOINT}}", GAS),
    "/assets/base.css": read(QM, "assets_templates", "base.css"),
}


def page_html(kind, slot_html=None, scripts=True):
    slot_html = slot_html if slot_html is not None else "Video placeholder &mdash; add a YouTube embed URL to replace this box."
    extra = ""
    if kind == "quiz":
        extra = '<script type="application/json" id="quiz-data">{"subject":"zz","lesson":"step3"}</script><div id="quiz-root"></div>'
    if kind == "assignment":
        extra = '<div id="assign-root" data-subject="zz" data-lesson="step3"></div>'
    tags = '<script src="/assets/auth.js"></script><script src="/assets/video.js"></script>' if scripts else ""
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>'
        '<link rel="stylesheet" href="/assets/base.css"></head><body><main><div class="wrap">'
        "<h1>Step three lesson</h1>"
        '<div class="media-slot">%s</div>%s</div></main>%s</body></html>' % (slot_html, extra, tags)
    )


def start_backend():
    proc = subprocess.Popen(
        ["node", os.path.join(HERE, "e2e_backend.js"), CODE_GS, str(PORT)], stdout=subprocess.PIPE, text=True
    )
    if proc.stdout.readline().strip() != "ready":
        proc.kill()
        raise SystemExit("e2e_backend.js did not start on port %d" % PORT)
    return proc


class Site:
    """One browser context whose network is fully scripted."""

    def __init__(self, browser, session=None, pages=None):
        self.ctx = browser.new_context()
        self.calls = []       # every get_video / request_access payload the page sent
        self.bodies = []      # every backend response body (to prove a locked URL never crossed the wire)
        self.mode = "live"    # live | offline | evil
        self.pages = pages or {}
        self.ctx.route(SITE + "/**", self._site)
        self.ctx.route("https://script.google.com/**", self._gas)
        if session:
            self.ctx.add_init_script(
                "try{if(!localStorage.getItem('teaching_session'))localStorage.setItem('teaching_session', %s)}catch(e){}"
                % json.dumps(json.dumps(session))
            )
        self.page = self.ctx.new_page()
        self.page.set_default_timeout(7000)

    def _site(self, route):
        path = route.request.url[len(SITE):].split("?")[0]
        if path in ASSETS:
            ctype = "text/css" if path.endswith(".css") else "application/javascript"
            return route.fulfill(status=200, content_type=ctype, body=ASSETS[path])
        if path.startswith("/assets/") and path not in ASSETS and path not in self.pages:   # P4: dashboards now load staff-guard.js / draft-store.js straight from the repo
            fp = os.path.join(SITE_ROOT, path.lstrip("/"))
            if os.path.isfile(fp):
                return route.fulfill(status=200, content_type="text/css" if fp.endswith(".css") else "application/javascript", body=read(fp))
        if path in self.pages:
            return route.fulfill(status=200, content_type="text/html", body=self.pages[path])
        kind = "quiz" if path.endswith("quiz.html") else "assignment" if path.endswith("assignment.html") else "lesson"
        return route.fulfill(status=200, content_type="text/html", body=page_html(kind))

    def _gas(self, route):
        body = route.request.post_data or "{}"
        try:
            self.calls.append(json.loads(body))
        except ValueError:
            pass
        if self.mode == "offline":
            return route.abort()
        headers = {"access-control-allow-origin": "*", "content-type": "text/plain"}
        if self.mode == "evil":
            out = json.dumps({"ok": True, "found": True, "locked": False, "embed_url": "https://evil.example/x"})
        else:
            out = json.dumps(api(json.loads(body)))
        self.bodies.append(out)
        route.fulfill(status=200, headers=headers, body=out)

    def open(self, path="/zz-test/step3/index.html"):
        self.page.goto(SITE + path)
        return self.page

    def close(self):
        self.ctx.close()


def session_for(phone, pw, name="Student"):
    r = api({"action": "login_student", "phone": phone, "password_hash": sha(pw)})
    if not r.get("ok"):
        r = api({"action": "register_student", "phone": phone, "password_hash": sha(pw), "display_name": name,
                 "year": "Senior 1", "parent_phone": "01100000009"})
    return {"student_id": r["student_id"], "student_name": r["student_name"], "session_token": r["session_token"],
            "year": "Senior 1", "parent_phone": "01100000009", "is_admin": bool(r.get("is_admin"))}


def set_video(lesson, slot, vid, locked=True):
    return api(dict(TOK, action="admin_set_video", lesson=lesson, slot=slot,
                    video_url="https://www.youtube.com/embed/" + vid, locked=locked))


def main():
    backend = start_backend()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            run(browser)
            browser.close()
    finally:
        backend.terminate()
    print("\n%d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


def run(browser):
    ID_OPEN, ID_LOCKED, ID_QUIZ, ID_ASSIGN = "OPENopenOPE", "LOCKlockLOC", "QUIZquizQUI", "ASSIGNassig"
    LESSON = "zz-test/step3"

    # ---- 1. nothing set: the page is exactly what it was --------------------------------------------------
    s = Site(browser)
    pg = s.open()
    pg.wait_for_function("document.querySelector('.media-slot').textContent.indexOf('Loading') === -1")
    check("no video row: the dev placeholder is redrawn as a 'coming soon' panel", "coming soon" in pg.inner_text(".media-slot") and pg.locator(".media-slot.vp-empty").count() == 1, pg.inner_text(".media-slot"))
    check("no video row: no iframe and no sign-in/payment box", pg.locator("iframe").count() == 0 and pg.locator(".vp-box button, .vp-box input").count() == 0)
    check("the page asked for slot 'lesson' of the right lesson", any(c.get("action") == "get_video" and c.get("lesson") == LESSON and c.get("slot") == "lesson" for c in s.calls), s.calls)
    s.close()

    # ---- 2. lesson + slot are read from the address -------------------------------------------------------
    for path, want in [("/zz-test/step3/quiz.html", "quiz"), ("/zz-test/step3/assignment.html", "assignment"),
                       ("/zz-test/step3/index.html", "lesson"), ("/zz-test/step3/", "lesson"), ("/zz-test/step3/quiz", "quiz")]:
        s = Site(browser)
        pg = s.open(path)
        pg.wait_for_function("document.querySelector('.media-slot').textContent.indexOf('Loading') === -1")
        got = [c for c in s.calls if c.get("action") == "get_video"]
        check("%s -> lesson=%s slot=%s" % (path, LESSON, want), got and got[0]["lesson"] == LESSON and got[0]["slot"] == want, got)
        s.close()

    # ---- 3. an old page with a hard-coded video is left alone ----------------------------------------------
    legacy = page_html("lesson", '<iframe src="https://www.youtube.com/embed/LEGACYlegacy" title="old" allowfullscreen></iframe>')
    s = Site(browser, pages={"/legacy/index.html": legacy})
    pg = s.open("/legacy/index.html")
    pg.wait_for_timeout(600)
    check("hard-coded iframe stays untouched, and nothing is asked of the server", pg.locator("iframe").count() == 1 and not s.calls, s.calls)
    s.close()

    # ---- 4. an unlocked video plays for anyone -------------------------------------------------------------
    set_video(LESSON, "lesson", ID_OPEN, locked=False)
    s = Site(browser)
    pg = s.open()
    play(pg)
    src = pg.get_attribute(".media-slot iframe", "src")
    check("unlocked: logged-out visitor gets the iframe", yt_id(src) == ID_OPEN and "youtube-nocookie.com/embed/" in src, src)
    check("unlocked: no locked box, iframe titled from the page heading", pg.locator(".vp-box").count() == 0 and pg.get_attribute(".media-slot iframe", "title") == "Step three lesson")
    s.close()

    # a second copy of the script on the page does no harm
    two = page_html("lesson").replace("</body>", '<script src="/assets/video.js"></script></body>')
    s = Site(browser, pages={"/two/index.html": two})
    pg = s.open("/two/index.html")
    pg.wait_for_timeout(600)
    check("script included twice: still one request, no double render", len([c for c in s.calls if c.get("action") == "get_video"]) == 1)
    s.close()

    # ---- 5. locked, logged out ----------------------------------------------------------------------------
    set_video(LESSON, "lesson", ID_LOCKED, locked=True)
    api({"key": "PAY_INSTRUCTIONS", "value": 'Send 200 EGP to 01012345678\n<img src=x onerror="window.__xss=1">'}, "/__prop")
    s = Site(browser)
    pg = s.open()
    pg.wait_for_selector(".vp-box")
    check("locked + logged out: 'Sign in' button, no iframe", pg.locator(".vp-box button", has_text="Sign in").count() == 1 and pg.locator("iframe").count() == 0)
    check("the locked video's ID is nowhere in the page", ID_LOCKED not in pg.content())
    check("...and never crossed the wire in any answer", not any(ID_LOCKED in b for b in s.bodies), s.bodies)
    check("pay instructions are shown (newline kept)", "Send 200 EGP to 01012345678" in pg.inner_text(".vp-pay"))
    check("pay instructions are TEXT, not HTML (no injected element ran)", pg.locator(".vp-pay img").count() == 0 and pg.evaluate("window.__xss") is None)
    s.close()

    # ---- 6. sign in through the real modal, then the whole payment journey -----------------------------------
    api({"action": "register_student", "phone": "01000000010", "password_hash": sha("pw10"), "display_name": "Mona",
         "year": "Senior 1", "parent_phone": "01100000010"})
    s = Site(browser)
    pg = s.open()
    pg.wait_for_selector(".vp-box")
    pg.click(".vp-box button:has-text('Sign in')")
    pg.wait_for_selector("#aew-overlay")
    check("the 'Sign in' button opens the sign-in modal", True)
    pg.fill("#aew-overlay input[type=tel]", "01000000010")
    pg.click("#aew-overlay button:has-text('Continue')")
    pg.wait_for_selector("#aew-overlay input[type=password]")
    pg.fill("#aew-overlay input[type=password]", "pw10")
    pg.click("#aew-overlay button:has-text('Log in')")
    pg.wait_for_selector(".vp-form", timeout=15000)      # the page reloads itself after login
    check("after login the box turns into the payment form", pg.locator(".vp-form .vp-input").count() == 1 and pg.locator("iframe").count() == 0)
    check("...still no URL for a student who has not paid", not any(ID_LOCKED in b for b in s.bodies))

    pg.click(".vp-form button.vp-btn")
    check("'I paid' with an empty reference is stopped on the page", "رقم التحويل" in pg.inner_text(".vp-status") and not any(c.get("action") == "request_access" for c in s.calls), s.calls)
    pg.fill(".vp-input", "wallet 01099998888 / 200")
    pg.click(".vp-form button.vp-btn")
    pg.wait_for_selector("text=Payment note received")
    check("'I paid' shows 'Payment note received' and unlocks nothing", pg.locator("iframe").count() == 0)
    queue = api(dict(TOK, action="admin_list_payments"))["payments"]
    mine = [q for q in queue if q["phone"] == "01000000010" and q["scope"] == LESSON]
    check("the teacher's queue has the request with the reference", len(mine) == 1 and "wallet" in mine[0]["reference"] and mine[0]["name"] == "Mona", queue)

    pg.reload()
    pg.wait_for_selector("text=Payment note received")
    check("after a reload the page still says waiting (the server remembers)", True)
    pg.click("button:has-text('Check status')")
    pg.wait_for_selector("text=Payment note received")
    check("'Check again' while still pending stays pending", pg.locator("iframe").count() == 0)

    api(dict(TOK, action="admin_decide_payment", payment_id=mine[0]["payment_id"], decision="approve", days=30))
    pg.click("button:has-text('Check status')")
    play(pg)
    check("after approval 'Check again' shows the video", yt_id(pg.get_attribute(".media-slot iframe", "src")) == ID_LOCKED)
    check("...and the locked box is gone", pg.locator(".vp-box").count() == 0)
    s.close()

    # ---- 7. expired and rejected -------------------------------------------------------------------------------
    sess = session_for("01000000011", "pw11", "Sara")
    api(dict(TOK, action="admin_grant_access", phone="01000000011", scope=LESSON, expires_at="2026-01-05"))
    s = Site(browser, session=sess)
    pg = s.open()
    pg.wait_for_selector(".vp-form")
    check("expired access: says when it ended and offers to renew", "2026-01-05" in pg.inner_text(".vp-box") and pg.locator("iframe").count() == 0, pg.inner_text(".vp-box"))
    s.close()

    sess = session_for("01000000012", "pw12", "Omar")
    q = api(dict(sess, action="request_access", lesson=LESSON, reference="r12"))
    api(dict(TOK, action="admin_decide_payment", payment_id=q["payment_id"], decision="reject"))
    s = Site(browser, session=sess)
    pg = s.open()
    pg.wait_for_selector(".vp-form")
    check("rejected request: says so and the form is there to try again", "لم تتم الموافقة" in pg.inner_text(".vp-box"), pg.inner_text(".vp-box"))
    s.close()

    # ---- 8. quiz / assignment keep the 'finish it first' rule --------------------------------------------------
    paid = session_for("01000000013", "pw13", "Nour")
    api(dict(TOK, action="admin_grant_access", phone="01000000013", scope=LESSON, days=30))
    set_video(LESSON, "quiz", ID_QUIZ, locked=True)
    set_video(LESSON, "assignment", ID_ASSIGN, locked=True)
    s = Site(browser, session=paid)
    pg = s.open("/zz-test/step3/quiz.html")
    play(pg)
    check("quiz page: a paid student gets the solution video", slot_video_id(pg) == ID_QUIZ, slot_video_id(pg))
    check("...blurred behind 'Finish the quiz below to unlock this video.'", "Finish the quiz" in pg.text_content(".video-lock") and "is-locked" in pg.get_attribute(".media-slot", "class"))
    pg.evaluate("localStorage.setItem('teaching_last_attempt:zz:step3','1'); document.getElementById('quiz-root').appendChild(document.createElement('div'))")
    pg.wait_for_function("!document.querySelector('.video-lock')")
    check("finishing the quiz removes the cover", "is-locked" not in pg.get_attribute(".media-slot", "class"))
    pg.reload()
    play(pg)
    check("...and it stays open after a reload", pg.locator(".video-lock").count() == 0)
    s.close()

    s = Site(browser, session=paid)
    pg = s.open("/zz-test/step3/assignment.html")
    play(pg)
    check("assignment page: covered with the submit-first message", "Submit the assignment" in pg.text_content(".video-lock"))
    s.close()

    # ---- 9. the teacher previewing a locked video ---------------------------------------------------------------
    api({"action": "register_student", "phone": "01000000014", "password_hash": sha("pw14"), "display_name": "Teacher",
         "year": "Senior 1", "parent_phone": "01100000014"})
    api({"phone": "01000000014"}, "/__make_admin")
    admin = session_for("01000000014", "pw14")
    s = Site(browser, session=admin)
    pg = s.open()
    play(pg)
    check("admin: sees a locked video, with a badge saying students can't", "locked for students" in pg.text_content(".vp-badge").lower(), pg.text_content(".vp-badge"))
    s.close()

    # ---- 10. things going wrong ------------------------------------------------------------------------------------
    s = Site(browser)
    s.mode = "offline"
    pg = s.open()
    pg.wait_for_selector(".vp-box")
    check("server unreachable: a clear message and a retry button", "reach the server" in pg.inner_text(".vp-box") and pg.locator("button:has-text('Try again')").count() == 1)
    s.mode = "live"
    pg.click("button:has-text('Try again')")
    pg.wait_for_selector(".vp-box button:has-text('Sign in')")
    check("retry works once the server is back", True)
    s.close()

    s = Site(browser)
    s.mode = "evil"
    pg = s.open()
    pg.wait_for_selector(".vp-box")
    check("a URL that isn't YouTube/Vimeo is refused by the page itself", pg.locator("iframe").count() == 0 and "can't be shown" in pg.inner_text(".vp-box"))
    s.close()

    s = Site(browser, session={"student_id": "01000000010", "student_name": "Mona", "session_token": "garbage",
                               "year": "Senior 1", "parent_phone": "01100000010", "is_admin": False})
    pg = s.open()
    pg.wait_for_selector(".vp-box")
    check("a stale saved session is treated as signed out (Sign in shown)", pg.locator(".vp-box button:has-text('Sign in')").count() == 1 and pg.locator("iframe").count() == 0)
    s.close()


if __name__ == "__main__":
    sys.exit(main())
