#!/usr/bin/env python3
"""R-P25-G-PAGE: the teacher's browser page dashboard/my-lessons.html (?mock=1, an in-memory server), in a real browser
(Phase 2.5 step G). Only his subjects' lessons are listed, grouped by grade, with fixed names (shown as text, never as
HTML) and no way to add, rename or delete a lesson. On a lesson: the three videos are saved (a watch link becomes an
embed link), cleared, and say they start locked; quiz questions are added (multiple choice and true/false), checked
before saving (empty text, missing answer, empty choice), moved, deleted and saved; questions made in the teacher app
stay as they are; files are uploaded (title, type), listed and deleted after a confirm. A lesson outside his subjects
says so. 390 px and 1280 px, light and dark, Arabic and English (nothing left untranslated), no sideways scroll."""
import json, os, sys, tempfile, threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("SKIP: playwright is not installed")
    sys.exit(0)
from _hermetic import seal   # noqa: E402

fails = 0
def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)[:400]))
    fails += 0 if ok else 1

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=REPO))
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % srv.server_address[1]
URL = base + "/dashboard/my-lessons.html?mock=1"
L1 = "science/secondary/grade-1-secondary/chapter-1-lesson-1"
L2 = "science/preparatory/grade-3-preparatory/chapter-1-lesson-2"
enc = lambda k: k.replace("/", "%2F")
NOSCROLL = "document.documentElement.scrollWidth <= window.innerWidth + 1"
pdf = os.path.join(tempfile.mkdtemp(), "worksheet-2.pdf")
with open(pdf, "wb") as f:
    f.write(b"%PDF-1.4\n% test\n")

with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, dark in ((390, False), (390, True), (1280, False)):
        tag = "%dpx %s: " % (width, "dark" if dark else "light")
        full = width == 1280
        ctx = browser.new_context(viewport={"width": width, "height": 900}, color_scheme="dark" if dark else "light")
        seal(ctx, allow=(base,))
        pg = ctx.new_page()
        errors, dialogs = [], []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
        calls = lambda: pg.evaluate("window.__mlMock.calls.map(function(c){return c.action;})")

        # ---- the list
        pg.goto(URL)
        pg.wait_for_selector(".ml-course")
        txt = pg.inner_text("main")
        check(tag + "his lessons, grouped by grade", pg.locator(".ml-course").count() == 2 and pg.locator(".ml-course .l-row").count() == 4, txt[:300])
        check(tag + "another subject's lesson is not listed", "Not his" not in txt)
        check(tag + "a title with markup is text, not HTML", "<b>&</b>" in txt and pg.locator("main b").count() == 0)
        check(tag + "no way to add, rename or delete a lesson", pg.locator("main input, main textarea").count() == 0 and "امسح" not in txt)
        check(tag + "video count per lesson", "1 من 3 فيديو" in txt and "0 من 3 فيديو" in txt)
        check(tag + "no sideways scroll (list)", pg.evaluate(NOSCROLL))

        # ---- videos
        pg.goto(URL + "#/lesson/" + enc(L1))
        pg.wait_for_selector("#ml-video-lesson")
        check(tag + "every id on the page is unique", pg.evaluate("(function(){var s={},d=0;document.querySelectorAll('[id]').forEach(function(e){if(s[e.id])d++;s[e.id]=1;});return d;})()") == 0)
        check(tag + "lesson page: the three video slots", all(pg.locator("#ml-video-" + s).count() == 1 for s in ("lesson", "quiz", "assignment")))
        check(tag + "a saved video is filled in and marked locked", "aaaaaaaaaaa" in pg.input_value("#ml-video-lesson") and "مقفول" in pg.inner_text("#ml-videos"))
        pg.fill("#ml-video-quiz", "https://www.youtube.com/watch?v=bbbbbbbbbbb")
        pg.click("#ml-vsave-quiz")
        pg.wait_for_function("document.getElementById('ml-video-quiz').value.indexOf('/embed/') > 0")
        check(tag + "saving a watch link stores the embed link", pg.input_value("#ml-video-quiz") == "https://www.youtube.com/embed/bbbbbbbbbbb")
        check(tag + "it says the new video starts locked", "مقفول للطلاب لحد ما تفتحه" in pg.inner_text("#ml-videos"))
        pg.fill("#ml-video-quiz", "")
        pg.click("#ml-vsave-quiz")
        pg.wait_for_function("document.getElementById('ml-videos').innerText.indexOf('اتشال الفيديو') >= 0")
        check(tag + "an empty box removes the video", pg.evaluate("window.__mlMock.videos.filter(function(v){return v.slot==='quiz';}).length") == 0)
        pg.fill("#ml-video-assignment", "not a link")
        pg.click("#ml-vsave-assignment")
        pg.wait_for_function("document.querySelector('#ml-videos .l-msg.err') !== null")
        check(tag + "a bad link is refused with the server's reason", "YouTube" in pg.inner_text("#ml-videos"))

        # ---- quiz questions
        pg.wait_for_selector("#ml-qlist .l-q")
        check(tag + "existing questions are loaded (2 editable + 1 from the teacher app)",
              pg.locator("#ml-qlist .l-q").count() == 3 and pg.locator("#ml-qlist .l-q textarea").count() == 2)
        check(tag + "a question from the teacher app stays read-only", "Explain why ice floats" in pg.inner_text("#ml-qlist") and pg.locator(".l-q[data-type=written] textarea").count() == 0)
        pg.click("#ml-add-mcq")
        pg.click("#ml-save-quiz")
        check(tag + "an empty new question is refused before saving", "سؤال 4: اكتب نص السؤال" in pg.inner_text("#ml-quiz-msg") and "admin_set_quiz_content" not in calls())
        q4 = pg.locator("#ml-qlist .l-q").nth(3)
        q4.locator("textarea").fill("Which is a gas?")
        q4.locator(".l-opt input[type=text]").nth(0).fill("Oxygen")
        pg.click("#ml-save-quiz")
        check(tag + "an empty choice is refused", "اختيار فاضي" in pg.inner_text("#ml-quiz-msg"))
        q4.locator(".l-opt input[type=text]").nth(1).fill("Iron")
        pg.click("#ml-save-quiz")
        check(tag + "a question without a correct answer is refused", "علّم الإجابة الصح" in pg.inner_text("#ml-quiz-msg"))
        q4.locator(".l-opt input[type=checkbox]").nth(0).check()
        pg.click("#ml-add-tf")
        q5 = pg.locator("#ml-qlist .l-q").nth(4)
        q5.locator("textarea").fill("Ice is lighter than water.")
        q5.locator("input[type=radio]").nth(0).check()
        pg.locator("#ml-qlist .l-q").nth(2).locator("button[aria-label='لتحت']").click()   # the app's question moves down
        pg.locator("#ml-qlist .l-q").nth(1).locator("button.danger").click()               # delete the old true/false
        pg.click("#ml-save-quiz")
        pg.wait_for_function("document.getElementById('ml-quiz-msg').className.indexOf('ok') > 0")
        saved = pg.evaluate("window.__mlMock.quiz['%s']" % L1)
        types = [q.get("type") for q in saved["questions"]]
        check(tag + "saved: the right questions in the right order", types == ["mcq", "mcq", "written", "truefalse"], types)
        check(tag + "saved: the new multiple-choice question with its answer",
              saved["questions"][1] == {"type": "mcq", "prompt": "Which is a gas?", "options": ["Oxygen", "Iron"], "correct": [0], "explain": ""}, saved["questions"][1])
        check(tag + "saved: the new true/false question", saved["questions"][3]["correct"] is True and saved["questions"][3]["prompt"] == "Ice is lighter than water.")
        check(tag + "saved: the app's question unchanged", saved["questions"][2] == {"type": "written", "id": "w1", "prompt": "Explain why ice floats.", "max_marks": 2})
        check(tag + "saved: title and lesson are the owner's", saved["title"] == "Chapter 1 Lesson 1 | Matter <b>&</b> its states" and saved["lesson"] == "chapter-1-lesson-1")

        # ---- files
        pg.wait_for_selector("#ml-flist .l-file")
        check(tag + "the lesson's files are listed", "Worksheet 1" in pg.inner_text("#ml-flist"))
        pg.click("#ml-upload")
        check(tag + "upload without a file asks for one", "اختار ملف الأول" in pg.inner_text("#ml-files-msg"))
        pg.set_input_files("#ml-file", pdf)
        pg.fill("#ml-file-title", "Worksheet <2>")
        pg.click("#ml-upload")
        pg.wait_for_function("document.getElementById('ml-files-msg').className.indexOf('ok') > 0")
        items = pg.evaluate("window.__mlMock.files['%s']" % L1)
        check(tag + "uploaded and added to the list (title, Drive id, type)", len(items) == 2 and items[1]["title"] == "Worksheet <2>" and items[1]["type"] == "pdf" and items[1]["drive_file_id"].startswith("1mockUpload"), items)
        up = [c for c in pg.evaluate("window.__mlMock.calls") if c["action"] == "upload_attachment"][-1]
        check(tag + "the upload names his subject and the lesson, with the file's bytes", up["subject"] == "science" and up["lesson"] == L1 and up["filename"] == "worksheet-2.pdf" and up["data_base64"], {k: up[k] for k in ("subject", "lesson", "filename")})
        check(tag + "the new file shows as text", "Worksheet <2>" in pg.inner_text("#ml-flist"))
        pg.locator("#ml-flist .l-file").nth(1).locator("button.danger").click()
        pg.wait_for_function("document.getElementById('ml-files-msg').innerText.indexOf('اتمسح') >= 0")
        check(tag + "delete asks first, then removes it from the list and Drive",
              any("Worksheet <2>" in d for d in dialogs) and len(pg.evaluate("window.__mlMock.files['%s']" % L1)) == 1 and "delete_attachment" in calls())
        check(tag + "no sideways scroll (lesson)", pg.evaluate(NOSCROLL))

        # ---- an empty lesson, and one outside his subjects
        pg.goto(URL + "#/lesson/" + enc(L2))
        pg.wait_for_function("document.getElementById('ml-qlist') && document.getElementById('ml-qlist').innerText.indexOf('لسه مفيش أسئلة') >= 0 && document.getElementById('ml-flist').innerText.indexOf('لسه مفيش ملفات') >= 0")
        check(tag + "an empty lesson: no questions, no files yet", "لسه مفيش أسئلة" in pg.inner_text("#ml-qlist") and "لسه مفيش ملفات" in pg.inner_text("#ml-flist"))
        pg.goto(URL + "#/lesson/" + enc("math/test/lesson-1"))
        pg.wait_for_selector(".l-state.err")
        check(tag + "a lesson outside his subjects says so", "مش من موادك" in pg.inner_text("main"))

        # ---- English
        if full or dark:
            pg.goto(URL + "#/lesson/" + enc(L1))
            pg.wait_for_selector("#ml-qlist .l-q")
            pg.click("#lang-toggle")
            pg.wait_for_function("document.documentElement.dir === 'ltr'")
            pg.wait_for_timeout(200)
            check(tag + "English: title and sections", pg.inner_text("h1") == "My lessons" and "Quiz questions" in pg.inner_text("main") and "Save questions" in pg.inner_text("main"))
            left = pg.evaluate("I18n.untranslated()")
            check(tag + "English: nothing left in Arabic", not left, left[:6])
            check(tag + "English: no sideways scroll", pg.evaluate(NOSCROLL))
            pg.click("#lang-toggle")
        check(tag + "no page errors", not errors, errors[:3])
        ctx.close()
    browser.close()
srv.shutdown()
sys.exit(1 if fails else 0)
