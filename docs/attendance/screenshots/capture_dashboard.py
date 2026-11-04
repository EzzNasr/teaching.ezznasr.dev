# Screenshots of the teacher dashboard (docs/attendance/screenshots/README.md), against the real AttendanceAll.gs running on
# the emulated backend (dashboard_backend.js). Nothing touches the live system. Needs node and Python Playwright.
# usage (from the repo root): python docs/attendance/screenshots/capture_dashboard.py docs/attendance/screenshots
import json, os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else HERE
srv = subprocess.Popen(["node", os.path.join(HERE, "dashboard_backend.js")], cwd=ROOT, stdout=subprocess.PIPE, text=True)
TOK = json.loads(srv.stdout.readline())["token"]

def api(route):
    req = urllib.request.Request("http://127.0.0.1:8767/api", data=(route.request.post_data or "{}").encode(), method="POST")
    route.fulfill(status=200, content_type="application/json", body=urllib.request.urlopen(req).read())

def open_page(b, width, height=860):
    page = b.new_page(viewport={"width": width, "height": height}, device_scale_factor=1.25)
    page.route("https://script.google.com/**", api)
    page.add_init_script("sessionStorage.setItem('att_admin', %r)" % TOK)
    page.goto("http://127.0.0.1:8767/attend/admin/index.html"); page.wait_for_selector("#panel:not([hidden])")
    page.wait_for_timeout(700)
    return page

def tab(page, name):
    page.click("nav [data-tab=%s]" % name); page.wait_for_timeout(900)   # after the slide-in

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = open_page(b, 1180)
        page.screenshot(path=os.path.join(OUT, "8-dashboard-take-attendance.png"))
        tab(page, "flagged"); page.screenshot(path=os.path.join(OUT, "9-needs-review.png"), full_page=True)
        tab(page, "roster"); page.screenshot(path=os.path.join(OUT, "11-all-students.png"), full_page=True)
        tab(page, "history"); page.screenshot(path=os.path.join(OUT, "12-history.png"), full_page=True)
        tab(page, "calib"); page.screenshot(path=os.path.join(OUT, "13-calibrate-room.png"), full_page=True)
        tab(page, "manual")
        page.fill("#manId", "20210199"); page.click("#manSave")
        page.wait_for_function("/not registered yet/.test(document.getElementById('manMsg').textContent)")
        page.wait_for_timeout(400); page.screenshot(path=os.path.join(OUT, "6-manual-entry-needs-name.png"), full_page=True)
        page.fill("#manName", "Karim Fathy"); page.click("#manSave")
        page.wait_for_function("/Marked present/.test(document.getElementById('manMsg').textContent)")
        page.wait_for_function("document.querySelectorAll('#manList tr').length > 2"); page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(OUT, "7-manual-entry-saved.png"), full_page=True)
        # the QR screen with the live feed
        tab(page, "session"); page.fill("#course", "Web Programming"); page.click("#startBtn")
        page.wait_for_selector("#proj:not([hidden])"); page.wait_for_timeout(2500)
        page.screenshot(path=os.path.join(OUT, "14-qr-screen.png"))
        page.close()
        phone = open_page(b, 390)
        tab(phone, "flagged"); phone.screenshot(path=os.path.join(OUT, "10-needs-review-phone.png"), full_page=True)
        b.close()
    print("saved dashboard screenshots to", OUT)
finally:
    srv.terminate()
