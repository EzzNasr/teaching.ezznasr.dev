# Captures the attendance page's save states at phone size. The Apps Script API is faked with page.route (nothing reaches the live backend).
# usage (from the repo root): python docs/attendance-screenshots/capture.py docs/attendance-screenshots
import json, sys, threading, time, functools, http.server, os
from playwright.sync_api import sync_playwright

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.getcwd())
H.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8766), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:8766/attend/index.html?s=S-1&t=tok"

def run(pw, name, mode, after_tap_ms):
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                        geolocation={"latitude": 31.2, "longitude": 29.9, "accuracy": 12}, permissions=["geolocation"], locale="en-GB")
    ctx.add_init_script("try{localStorage.setItem('att_id','20240001');localStorage.setItem('att_name','Ali');localStorage.setItem('att_pending','')}catch(e){}")
    page = ctx.new_page()

    def cfg(route):
        r = route.fetch(); body = r.text()
        if mode == "giveup":
            body = body.replace("LATE_GRACE_SEC: 120", "LATE_GRACE_SEC: 1").replace("RETRY_DELAYS_MS", "_X")
        route.fulfill(response=r, body=body)
    page.route("**/contract/att_config.js*", cfg)

    def api(route):
        a = json.loads(route.request.post_data or "{}").get("action"); now = int(time.time() * 1000)
        if a == "att_ticket":
            exp = now + (5000 if mode == "giveup" else 240000)
            o = {"ok": True, "ticket": "T", "expires_at": exp, "close_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now / 1000 + 300)),
                 "server_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        elif a == "att_attend":
            if mode == "save": return   # leave the request hanging: the page stays on "Saving"
            if mode in ("wait", "giveup"): o = {"ok": False, "code": "BUSY"}
            else: o = {"ok": True, "status": "recorded", "server_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "name": "Ali"}
        else:
            o = {"ok": False, "code": "UNKNOWN_ACTION"}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(o))
    page.route("https://script.google.com/**", api)
    page.route("https://script.googleusercontent.com/**", api)

    page.goto(BASE); page.wait_for_selector("#save:not([disabled])", timeout=15000)
    if mode != "form":
        page.click("#save")
        page.wait_for_timeout(after_tap_ms)
    page.screenshot(path=os.path.join(OUT, name))
    b.close()
    print("saved", name)

with sync_playwright() as pw:
    run(pw, "1-before-tap.png", "form", 0)
    run(pw, "2-saving.png", "save", 1200)
    run(pw, "3-not-saved-yet.png", "wait", 1500)
    run(pw, "4-saved.png", "done", 1200)
    run(pw, "5-could-not-save.png", "giveup", 9000)
srv.shutdown()
