#!/usr/bin/env python3
"""Real-browser tests for Session 3: photo capture (fake camera), compression, draft restore,
upload retry, deferred quiz flow + review, homework photo answers. Run from tools/quiz-maker-v2:
    python tests/e2e_capture.py
Uses Chromium's fake camera (--use-fake-device-for-media-stream). Backend = REAL Code.gs +
Phase2_Capture.gs through the Node harness. Nothing touches the live site or Sheet.
"""
import base64
import io
import json
import os
import re
import subprocess
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_video as E
from playwright.sync_api import sync_playwright
from PIL import Image

HERE, QM = E.HERE, E.QM
api, sha, TOK = E.api, E.sha, E.TOK
LESSON = "zz-test/capture"
passed = failed = 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1; print("PASS " + name)
    else:
        failed += 1; print("FAIL " + name + ("  -> " + str(extra)[:300] if extra else ""))


def raw(path, payload):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (E.PORT, path), data=json.dumps(payload).encode(), method="POST")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def prop(k, v): raw("/__prop", {"key": k, "value": v})


E.ASSETS["/assets/quiz.js"] = E.read(QM, "assets_templates", "quiz.js").replace("{{DRIVE_ENDPOINT}}", E.GAS)
E.ASSETS["/assets/assign.js"] = E.read(QM, "assets_templates", "assign.js").replace("{{DRIVE_ENDPOINT}}", E.GAS)
E.ASSETS["/assets/capture.js"] = E.read(QM, "assets_templates", "capture.js")
E.ASSETS["/assets/forms.css"] = E.read(QM, "assets_templates", "forms.css")


def quiz_page():
    return ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<link rel="stylesheet" href="/assets/base.css"><link rel="stylesheet" href="/assets/forms.css"></head>'
            '<body><main><div class="wrap"><div class="media-slot"></div><div id="quiz-root"></div></div></main>'
            '<script type="application/json" id="quiz-data">{"subject":"zz","lesson":"capture","title":"Capture quiz"}</script>'
            '<script src="/assets/auth.js"></script><script src="/assets/quiz.js"></script>'
            "<script>QuizEngine.mount('#quiz-root', '#quiz-data');</script></body></html>")


HW_ITEMS = {"items": [
    {"id": "m1", "type": "mcq", "prompt": "HW mcq", "options": ["x", "y"], "correct": [1]},
    {"id": "h1", "type": "written", "prompt": "HW written", "max_marks": 3},
]}


def hw_page():
    return ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<link rel="stylesheet" href="/assets/base.css"><link rel="stylesheet" href="/assets/forms.css"></head>'
            '<body><main><div class="wrap"><div id="assign-root" data-subject="zz" data-lesson="capture-hw" data-mode="graded"></div></div></main>'
            '<script type="application/json" id="assign-questions">' + json.dumps(HW_ITEMS) + '</script>'
            '<script src="/assets/auth.js"></script><script src="/assets/assign.js"></script>'
            "<script>AssignEngine.mount('#assign-root');</script></body></html>")


def sof_size(jpeg):
    """(w, h) from a JPEG's SOF marker, without decoding it."""
    i = 2
    while i < len(jpeg):
        if jpeg[i] != 0xFF: i += 1; continue
        m = jpeg[i + 1]
        if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
            return int.from_bytes(jpeg[i + 7:i + 9], "big"), int.from_bytes(jpeg[i + 5:i + 7], "big")
        i += 2 + int.from_bytes(jpeg[i + 2:i + 4], "big")
    return None


def big_photo(path, w=3600, h=2400):
    img = Image.effect_noise((w, h), 60).convert("RGB")      # noisy on purpose: JPEG-hostile, like a real photo
    img.save(path, "JPEG", quality=95)
    return path


def start_backend():
    proc = subprocess.Popen(["node", os.path.join(HERE, "e2e_capture_backend.js"),
                             os.path.join(QM, "apps_script", "Code.gs"), os.path.join(QM, "apps_script", "Phase2_Capture.gs"), str(E.PORT)],
                            stdout=subprocess.PIPE, text=True)
    proc.stdout.readline()
    return proc


class Page:
    """A Site whose requests we can inspect and selectively break."""
    def __init__(self, browser, session, pages, camera=True):
        self.fail_uploads = 0
        self.s = E.Site(browser, session=session, pages=pages)
        try: self.s.ctx.grant_permissions(["camera"], origin=E.SITE)
        except Exception: pass
        if not camera:   # no camera API at all: the file picker must take over
            self.s.ctx.add_init_script("try{Object.defineProperty(navigator,'mediaDevices',{value:undefined})}catch(e){}")
        self.s.ctx.route("https://script.google.com/**", self._gas)
        self.pg = self.s.page

    def _gas(self, route):
        try:
            body = json.loads(route.request.post_data or "{}")
        except ValueError:
            body = {}
        if body.get("action") == "upload_written_image" and self.fail_uploads > 0:
            self.fail_uploads -= 1
            return route.abort()
        route.fallback()

    def calls(self, action): return [c for c in self.s.calls if c.get("action") == action]


def run(browser, tmp):
    stu = E.session_for("01000000041", "pw", "Mona")
    prop("FF_DEFERRED_ANSWERS", "1"); prop("FF_CAMERA", "1")
    content = {"subject": "zz", "lesson": "capture", "title": "Capture quiz", "questions": [
        {"type": "mcq", "prompt": "Pick B", "options": ["A", "B", "C"], "correct": [1], "explain": "SECRET-WHY-1"},
        {"type": "truefalse", "prompt": "Sky is green", "correct": False, "explain": "SECRET-WHY-2"},
        {"type": "written", "id": "w1", "prompt": "Explain it on paper", "max_marks": 3, "model_answer": "SECRET-MODEL"},
    ]}
    check("quiz content synced", api(dict(TOK, action="admin_set_quiz_content", lesson=LESSON, content_json=json.dumps(content))).get("ok"))

    # ---- A. deferred flow, fake camera, reload-resume, upload retry --------------------------------------------
    p = Page(browser, stu, {"/zz-test/capture/quiz.html": quiz_page()})
    pg = p.pg
    pg.goto(E.SITE + "/zz-test/capture/quiz.html")
    pg.wait_for_selector("text=Begin quiz")
    bodies = " ".join(p.s.bodies)
    check("R-015 the quiz response the browser got has no answers/explanations/model answer",
          "SECRET" not in bodies and '"correct"' not in bodies, bodies[:200])
    check("start screen promises answers only after submit", "after you submit" in pg.inner_text("body"))
    pg.click("text=Begin quiz")
    pg.click(".qz-option:has-text('B')")
    check("deferred: picking an answer gives NO right/wrong feedback", pg.locator(".qz-option--correct, .qz-option--incorrect, .qz-verdict__tag").count() == 0)
    check("Next enabled after answering", not pg.locator("button:has-text('Next')").is_disabled())
    pg.click("button:has-text('Next')")
    check("Next is disabled until a true/false is answered", pg.locator("button:has-text('Next')").is_disabled())
    pg.click(".qz-option:has-text('False')")
    pg.click("button:has-text('Next')")
    pg.wait_for_selector("text=Take photo")
    check("written question shows the camera/photo tools", pg.locator("button:has-text('From gallery')").count() == 1)

    pg.click("button:has-text('Take photo')")
    pg.wait_for_selector(".tc-cam video")
    pg.wait_for_function("document.querySelector('.tc-cam video').videoWidth > 0")
    check("live camera preview appears (fake device)", pg.locator(".tc-cam video").count() == 1)
    pg.click("button:has-text('Use photo')")
    pg.wait_for_selector(".tc-thumb img")
    check("photo taken: thumbnail shown, camera closed", pg.locator(".tc-thumb").count() == 1 and pg.locator(".tc-cam:not([hidden])").count() == 0)

    pg.reload()
    pg.wait_for_selector("text=Resume where you stopped")
    pg.click("text=Resume where you stopped")
    pg.wait_for_selector("text=Take photo")
    pg.wait_for_selector(".tc-thumb img")
    check("R-014 reload: quiz resumes on the same question and the photo draft is restored", "Explain it on paper" in pg.inner_text("body") and pg.locator(".tc-thumb").count() == 1)
    pg.click("button:has-text('← Back')")
    check("going back keeps the earlier answer", pg.locator(".qz-option--picked").count() == 1 and "False" in pg.inner_text(".qz-option--picked"))
    pg.click("button:has-text('Next')")
    pg.wait_for_selector(".tc-thumb img")

    p.fail_uploads = 3   # postToDrive retries a dropped request twice by itself; 3 drops = a real failure
    pg.click("button:has-text('Submit quiz')")
    pg.wait_for_selector("text=A photo didn't upload", timeout=20000)
    check("R-014 failed upload: answers kept, clear message, back on the question", "Take photo" in pg.inner_text("body") and "tap Submit" in pg.inner_text("body"))
    check("...nothing submitted yet", not p.calls("upload_quiz_result"))
    pg.click("button:has-text('Submit quiz')")
    pg.wait_for_selector("text=Pending grading", timeout=15000)
    check("R-016 after submit the page shows the review (score + each question)", pg.locator(".qz-review__item").count() == 3, pg.inner_text("body")[:300])
    txt = pg.inner_text("body")
    check("review: correct one marked, wrong one shows the right answer, written pending, explanations now visible",
          "Correct" in txt and "Correct answer: False" not in txt and "SECRET-WHY-1" in txt and "waiting for your teacher" in txt, txt[:400])
    sent = p.calls("upload_quiz_result")[0]
    check("the submit carried raw answers and NO score/total", "answers" in sent and "score" not in sent and "total" not in sent, list(sent.keys()))
    ups = p.calls("upload_written_image")
    check("one photo reached the server (the retry re-sent the same image id)", len({u["image_id"] for u in ups}) == 1 and len(ups) >= 1)
    jpg = base64.b64decode(ups[-1]["data_base64"])
    check("the uploaded photo is a JPEG", jpg[:3] == b"\xff\xd8\xff")
    drive = raw("/__drive", {})["files"]
    photos = [f for f in drive if f["name"].startswith("written--") and not f["trashed"]]
    check("exactly one live photo file in Drive, named for this attempt", len(photos) == 1, drive)
    check("video-unlock marker saved for this lesson", pg.evaluate("localStorage.getItem('teaching_last_attempt:zz:capture')") is not None)
    check("draft cleared after a successful submit", pg.evaluate("localStorage.getItem('teaching_quiz_draft:%s:%s')" % (stu["student_id"], LESSON)) is None)
    rows = raw("/__sheet", {"name": "WrittenAnswers"})["rows"]
    check("WrittenAnswers has the row, ungraded", len(rows) == 2 and rows[1][5] == "" , rows)
    sc = raw("/__sheet", {"name": "QuizResults"})["rows"][-1]
    check("score stored server-side: auto part only (2 of 2); written marks join when graded", sc[8] == 2 and sc[9] == 2, sc[:11])
    p.s.close()

    # ---- B. no camera API: file picker path + compression + mobile layout --------------------------------------------
    photo = big_photo(os.path.join(tmp, "big.jpg"))
    src_kb = os.path.getsize(photo) // 1024
    p = Page(browser, stu, {"/zz-test/capture/quiz.html": quiz_page()}, camera=False)
    pg = p.pg
    pg.set_viewport_size({"width": 375, "height": 740})
    pg.goto(E.SITE + "/zz-test/capture/quiz.html")
    pg.wait_for_selector("text=Begin quiz"); pg.click("text=Begin quiz")
    pg.click(".qz-option:has-text('C')"); pg.click("button:has-text('Next')")
    pg.click(".qz-option:has-text('True')"); pg.click("button:has-text('Next')")
    pg.wait_for_selector("text=Take photo")
    with pg.expect_file_chooser() as fc:
        pg.click("button:has-text('Take photo')")
    check("no camera API: 'Take photo' opens the device's camera/file input", fc.value.element.get_attribute("capture") == "environment")
    fc.value.set_files(photo)
    pg.wait_for_selector(".tc-thumb img", timeout=15000)
    check("mobile width 375: no horizontal scroll with the widget", pg.evaluate("document.scrollingElement.scrollWidth <= window.innerWidth"))
    pg.click("button:has-text('Submit quiz')")
    pg.wait_for_selector(".qz-review__item", timeout=15000)
    up = p.calls("upload_written_image")[-1]
    jpg = base64.b64decode(up["data_base64"])
    w, h = sof_size(jpg)
    check("compression: 3600x2400 source -> long edge <= 1600 (got %dx%d)" % (w, h), max(w, h) <= 1600 and max(w, h) >= 1500)
    check("compression: upload is far smaller than the source (%d KB vs %d KB) and under the 2.4 MB cap" % (len(jpg) // 1024, src_kb), len(jpg) < src_kb * 1024 * 0.6 and len(jpg) < 2.4 * 1024 * 1024)
    p.s.close()

    # ---- C. flags off: old behaviour, instant feedback ------------------------------------------------------------------
    prop("FF_DEFERRED_ANSWERS", None); prop("FF_CAMERA", None)
    p = Page(browser, stu, {"/zz-test/capture/quiz.html": quiz_page()})
    pg = p.pg
    pg.goto(E.SITE + "/zz-test/capture/quiz.html")
    pg.wait_for_selector("text=Begin quiz"); pg.click("text=Begin quiz")
    pg.click(".qz-option:has-text('B')")
    pg.wait_for_selector(".qz-verdict__tag")
    check("flags off: classic instant feedback still works", "Correct" in pg.inner_text(".qz-verdict__tag") and pg.locator(".qz-option--correct").count() == 1)
    p.s.close()

    # ---- D. homework with a written item -----------------------------------------------------------------------------------
    prop("FF_CAMERA", "1")
    p = Page(browser, stu, {"/zz-test/capture-hw/assignment.html": hw_page()})
    pg = p.pg
    pg.goto(E.SITE + "/zz-test/capture-hw/assignment.html")
    pg.wait_for_selector("text=HW written")
    pg.select_option("select.qz-select", "y")
    pg.wait_for_selector("text=Take photo")
    pg.click("button:has-text('Take photo')")
    pg.wait_for_function("document.querySelector('.tc-cam video') && document.querySelector('.tc-cam video').videoWidth > 0")
    pg.click("button:has-text('Use photo')")
    pg.wait_for_selector(".tc-thumb img")
    pg.click("button:has-text('Submit assignment')")
    pg.wait_for_function("document.body.innerText.indexOf('Saving your submission') === -1 && document.querySelector('.qz-summary')", timeout=15000)
    sub = p.calls("upload_submission")[0]
    ph = p.calls("upload_written_image")[0]
    check("homework: photo uploaded under the submission's client_id", ph["attempt_id"] == sub["client_id"] and ph["kind"] == "assignment", (ph.get("attempt_id"), sub.get("client_id")))
    w = [a for a in sub["answers"] if a["type"] == "written"][0]
    check("homework: written answer recorded as pending with its photo count and max marks", w["pending"] is True and w["image_count"] == 1 and w["max"] == 3, w)
    check("homework: total counts the written marks (1 + 3), score only the auto-graded", sub["score"] == 1 and sub["total"] == 4, (sub["score"], sub["total"]))
    check("homework: submission landed on the server", "Saved on this device" not in p.pg.inner_text("body"))
    p.s.close()


def main():
    import tempfile
    backend = start_backend()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
            with tempfile.TemporaryDirectory() as tmp:
                run(browser, tmp)
            browser.close()
    finally:
        backend.terminate()
    print("\n%d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
