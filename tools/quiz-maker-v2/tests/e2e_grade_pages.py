#!/usr/bin/env python3
"""R-GRADE-1: the restyled grade pages in a real browser (programming Senior 1 / Senior 2, science Prep 3 / Senior 1).
At 390 and 1280 px, light and dark: the page wears its subject's theme (body.grade-page + subject-programming|science,
assets/grade.css and teachers.css loaded); the hero shows the grade name and that subject's teacher photo card, whose
photo loads and matches assets/teachers.js; every Quiz Maker lesson card is still there and links to its folder; each
chapter heading shows its lesson count and a seen bar, the hero shows the totals and one jump link per chapter that
lands on it; a lesson opened earlier on this device gets a «seen» tick and the bar counts it; the subscription mount
is on the two programming pages only; Arabic text RTL; no sideways scroll; the header has no blur and nothing animates
for ever; with prefers-reduced-motion a hovered card does not move; with JavaScript off the cards and links are still
all there (the extras just stay hidden)."""
import json, os, re, sys, threading
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
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(detail)[:300]))
    fails += 0 if ok else 1

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=REPO))
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % srv.server_address[1]

PAGES = [
    ("programming/baccalaureate/grade-1-secondary/", "programming", "Senior 1"),
    ("programming/baccalaureate/grade-2-secondary/", "programming", "Senior 2"),
    ("science/preparatory/grade-3-preparatory/", "science", "Prep 3"),
    ("science/secondary/grade-1-secondary/", "science", "Senior 1"),
]
CARD_RE = re.compile(r'<a class="lesson" href="\./([^/"]+)/">')
teachers_js = open(os.path.join(REPO, "assets", "teachers.js"), encoding="utf-8").read()
def photo_of(subject):
    block = re.search(subject + r":\s*\{(.*?)\}", teachers_js, re.S).group(1)
    return re.search(r"photo:\s*'([^']+)'", block).group(1)

def ctx_for(browser, width, theme="light", seen=None, **kw):
    ctx = browser.new_context(viewport={"width": width, "height": 900}, **kw)
    ctx.add_init_script("try{localStorage.setItem('teaching-theme',%s);localStorage.setItem('handasa:seen',%s)}catch(e){}"
                        % (json.dumps(theme), json.dumps(json.dumps(seen or {}))))
    seal(ctx, allow=(base,))
    return ctx

with sync_playwright() as p:
    browser = p.chromium.launch()
    for path, subject, grade in PAGES:
        html = open(os.path.join(REPO, path, "index.html"), encoding="utf-8").read()
        slugs = CARD_RE.findall(html)
        first = "/" + path + slugs[0] + "/" if slugs else None
        for width in (390, 1280):
            for theme in ("light", "dark"):
                tag = "%s %s %d %s" % (grade, subject, width, theme)
                ctx = ctx_for(browser, width, theme, seen={first: 1} if first else {})
                pg = ctx.new_page()
                errors = []
                pg.on("pageerror", lambda e: errors.append(str(e)))
                pg.goto(base + "/" + path, wait_until="load")
                pg.wait_for_function("document.documentElement.classList.contains('grade-js')", timeout=5000)
                info = pg.evaluate("""() => {
                  const b = document.body, q = s => document.querySelector(s);
                  const img = q('.grade-hero .teacher-card[data-teacher-slot] [data-teacher-img]');
                  const heads = [...document.querySelectorAll('.lessons .chapter-head')];
                  const count = h => { let n = 0, e = h.nextElementSibling; while (e && !e.classList.contains('chapter-head')) { if (e.matches('a.lesson')) n++; e = e.nextElementSibling; } return n; };
                  const anims = document.getAnimations().filter(a => { const t = a.effect && a.effect.getTiming(); return t && t.iterations === Infinity; });
                  return {
                    cls: b.className, theme: document.documentElement.getAttribute('data-theme'), dir: document.documentElement.dir,
                    sheets: [...document.styleSheets].map(s => s.href || ''),
                    h1: (q('.grade-hero h1') || {}).textContent || '',
                    slot: img ? img.closest('[data-teacher-slot]').getAttribute('data-teacher-slot') : null,
                    src: img ? new URL(img.getAttribute('src'), location.href).pathname : null,
                    loaded: img ? (img.complete && img.naturalWidth > 0) : false,
                    cardW: img ? img.closest('.teacher-card').getBoundingClientRect().width : 0,
                    cards: [...document.querySelectorAll('.lessons a.lesson')].map(a => a.getAttribute('href')),
                    heads: heads.map(h => ({ id: h.id, n: count(h), meta: (h.querySelector('.ch-meta') || {}).textContent || '',
                                             full: h.getBoundingClientRect().width >= h.parentElement.getBoundingClientRect().width - 2 })),
                    jumps: [...document.querySelectorAll('[data-grade-jump] a')].map(a => a.getAttribute('href')),
                    jumpHidden: (q('[data-grade-jump]') || {}).hidden,
                    stats: (q('[data-grade-stats]') || {}).textContent || '',
                    seen: [...document.querySelectorAll('.lessons a.lesson.is-seen')].map(a => a.getAttribute('href')),
                    sub: !!q('#subscriptions'), subjs: !!q('script[src*="subscribe.js"]'),
                    sw: document.documentElement.scrollWidth, vw: innerWidth,
                    blur: getComputedStyle(q('header')).backdropFilter, infinite: anims.length,
                    arDir: getComputedStyle(q('.lessons .chapter-head span') || b).direction,
                    accent: [getComputedStyle(b).getPropertyValue('--accent').trim(), getComputedStyle(b).getPropertyValue('--s1').trim()],
                    nameAr: !!q('.teacher-card [data-teacher-name][lang="ar"][dir="rtl"]'),
                  };
                }""")
                check(tag + ": no script errors", not errors, errors)
                check(tag + ": grade-page theme for " + subject, "grade-page" in info["cls"] and "subject-" + subject in info["cls"], info["cls"])
                check(tag + ": theme is " + theme, (info["theme"] == "dark") == (theme == "dark"), info["theme"])
                check(tag + ": grade.css and teachers.css loaded", any(s.endswith("/assets/grade.css") for s in info["sheets"]) and any(s.endswith("/assets/teachers.css") for s in info["sheets"]))
                check(tag + ": buttons wear the subject colour (accent = --s1)", info["accent"][0] == info["accent"][1] and info["accent"][0], info["accent"])
                check(tag + ": hero names the grade", grade in info["h1"], info["h1"])
                check(tag + ": the " + subject + " teacher card, photo from teachers.js, loaded",
                      info["slot"] == subject and info["src"] == photo_of(subject) and info["loaded"], (info["slot"], info["src"], info["loaded"]))
                check(tag + ": teacher card is small (<= 360 px wide, or the phone row)", info["cardW"] <= 360 or width < 900, info["cardW"])
                check(tag + ": every Quiz Maker card is there", info["cards"] == ["./" + s + "/" for s in slugs], (len(info["cards"]), len(slugs)))
                check(tag + ": chapter headings span the grid and show their count",
                      info["heads"] and all(h["full"] and (h["n"] == 0 or str(h["n"]) in h["meta"] or "درس" in h["meta"]) for h in info["heads"]), info["heads"])
                with_lessons = ["#" + h["id"] for h in info["heads"] if h["n"]]
                check(tag + ": one jump link per chapter with lessons", info["jumps"] == with_lessons and info["jumpHidden"] is False, (info["jumps"], with_lessons))
                check(tag + ": hero totals show the lesson count", str(len(slugs)) in info["stats"], info["stats"])
                check(tag + ": the lesson opened before has a seen tick", info["seen"] == (["./" + slugs[0] + "/"] if slugs else []), info["seen"])
                check(tag + ": subscription mount only on programming",
                      (info["sub"] and info["subjs"]) if subject == "programming" else (not info["sub"] and not info["subjs"]), (info["sub"], info["subjs"]))
                check(tag + ": RTL page, Arabic heading RTL, Arabic teacher name marked", info["dir"] == "rtl" and info["arDir"] == "rtl" and info["nameAr"])
                check(tag + ": no sideways scroll", info["sw"] <= info["vw"], (info["sw"], info["vw"]))
                check(tag + ": light on old phones (no header blur, nothing animates for ever)", info["blur"] in ("none", "") and info["infinite"] == 0, (info["blur"], info["infinite"]))
                if width == 1280 and theme == "light" and len(info["jumps"]) > 1:
                    target = info["jumps"][-1]
                    pg.click('[data-grade-jump] a[href="%s"]' % target)
                    pg.wait_for_timeout(900)
                    top = pg.evaluate("t => document.querySelector(t).getBoundingClientRect().top", target)
                    check(tag + ": the last jump link brings its chapter into view", 0 <= top < 860, top)
                if width == 1280 and theme == "dark" and len(slugs) > 1:
                    pg.evaluate("() => { const a = document.querySelectorAll('.lessons a.lesson')[1]; a.addEventListener('click', e => e.preventDefault(), { once: true }); a.click(); }")
                    stored = pg.evaluate("() => JSON.parse(localStorage.getItem('handasa:seen') || '{}')")
                    check(tag + ": opening a lesson remembers it on this device", ("/" + path + slugs[1] + "/") in stored, stored)
                ctx.close()

        # reduced motion: a hovered card stays put
        if slugs:
            ctx = ctx_for(browser, 1280, reduced_motion="reduce")
            pg = ctx.new_page(); pg.goto(base + "/" + path, wait_until="load")
            pg.hover(".lessons a.lesson")
            pg.wait_for_timeout(400)
            tf = pg.evaluate("getComputedStyle(document.querySelector('.lessons a.lesson')).transform")
            check(grade + " " + subject + ": reduced motion, hovered card does not move", tf in ("none", "matrix(1, 0, 0, 1, 0, 0)"), tf)
            ctx.close()

        # JavaScript off: cards and links still there, extras hidden
        ctx = ctx_for(browser, 390, java_script_enabled=False)
        pg = ctx.new_page(); pg.goto(base + "/" + path, wait_until="load")
        r = pg.evaluate("""() => ({ cards: document.querySelectorAll('.lessons a.lesson').length,
            jumpShown: !document.querySelector('[data-grade-jump]').hidden, sw: document.documentElement.scrollWidth, vw: innerWidth })""")
        check(grade + " " + subject + ": without JavaScript every card is there, extras hidden, no sideways scroll",
              r["cards"] == len(slugs) and not r["jumpShown"] and r["sw"] <= r["vw"], r)
        ctx.close()
    browser.close()

srv.shutdown()
print("\n%d failure(s)" % fails)
sys.exit(1 if fails else 0)
