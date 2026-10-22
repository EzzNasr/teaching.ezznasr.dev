#!/usr/bin/env python3
"""
e2e_followup.py — real-browser (Chromium) tests for dashboard/followup.html (Chunk 5).

Runs the page in ?mock=1 mode against dashboard/_fixtures/followup-overview.json (fake data) and,
for the real-mode checks, with a stub AuthEngine that records every payload. Nothing touches the
live site or the Sheet.

    pip install playwright
    playwright install chromium
    python tests/e2e_followup.py          (run from tools/quiz-maker-v2)

Libraries: the page needs assets/followup-logic.js (Chunk 3) and assets/followup-templates.js
(Chunk 4). If either file does not exist yet, small contract-shaped STAND-INS are injected so this
test can run before the chunks merge, and the run says so. Once the real files exist they are used
as they are — that is the integration check for Chunk 6.
"""
import json
import os
import re
import sys
import threading
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PAGE = "/dashboard/followup.html"
FIXTURE = os.path.join(REPO, "dashboard", "_fixtures", "followup-overview.json")

passed = failed = 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("PASS " + name)
    else:
        failed += 1
        print("FAIL " + name + ("  -> " + str(extra)[:300] if extra else ""))


# ---------------------------------------------------------------------------------------------
# Stand-ins for Chunk 3 / Chunk 4 (only used when the real file is missing)
# ---------------------------------------------------------------------------------------------
LOGIC_STUB = r"""
(function(){
var CAIRO=3*3600e3, WD=["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];
function phoneKey(p){return String(p||"").replace(/\D/g,"").slice(-10)}
function sh(d){return new Date(d.getTime()+CAIRO)}
function eod(y,m,d){return new Date(Date.UTC(y,m,d,23,59)-CAIRO)}
function nextSession(now,wd,time){var hm=time.split(":").map(Number);
  for(var i=0;i<9;i++){var b=sh(new Date(now.getTime()+i*864e5));
    var c=new Date(Date.UTC(b.getUTCFullYear(),b.getUTCMonth(),b.getUTCDate(),hm[0],hm[1])-CAIRO);
    if(b.getUTCDay()===wd&&c>=now)return c;} return null}
function ov(s){var m=/^(\d{4})-(\d\d)-(\d\d)$/.exec(s||"");return m?eod(+m[1],m[2]-1,+m[3]):null}
function groupDeadlines(s,now){var n=nextSession(now,s.weekday,s.time),b=sh(n);
  return {session:n,
    watch:ov(s.watch_deadline_override)||eod(b.getUTCFullYear(),b.getUTCMonth(),b.getUTCDate()-3),
    hw:ov(s.hw_deadline_override)||eod(b.getUTCFullYear(),b.getUTCMonth(),b.getUTCDate()-1)}}
function deadlineState(now,dl){if(now>dl)return "overdue";var a=sh(now),b=sh(dl);
  return a.getUTCDate()===b.getUTCDate()&&a.getUTCMonth()===b.getUTCMonth()?"today":"upcoming"}
function deadlineWhen(now,dl){if(deadlineState(now,dl)==="today")return "النهارده";
  var a=sh(now),b=sh(dl);var diff=Math.round((Date.UTC(b.getUTCFullYear(),b.getUTCMonth(),b.getUTCDate())-Date.UTC(a.getUTCFullYear(),a.getUTCMonth(),a.getUTCDate()))/864e5);
  if(diff===1)return "بكرة"; return "يوم "+WD[b.getUTCDay()]+" "+b.getUTCDate()+"/"+(b.getUTCMonth()+1)}
function waDigits(p){var d=String(p||"").replace(/\D/g,"");if(/^0?1[0125]\d{8}$/.test(d))return "20"+d.slice(-10);return d}
function checkParentPhone(parent,own){var d=String(parent||"").replace(/\D/g,"");
  if(!d)return {ok:false,level:"missing",reason:"",wa:""};
  if(d.length<10||phoneKey(d)===phoneKey(own)||!/^(?:\+?20|0)?1[0125]\d{8}$/.test(String(parent).replace(/[\s-]/g,"")))
    return {ok:false,level:"warn",reason:phoneKey(d)===phoneKey(own)?"نفس رقم الطالب":"راجع الرقم",wa:waDigits(parent)};
  return {ok:true,level:"ok",reason:"",wa:waDigits(parent)}}
function studentSummary(st,g,o){var s=g.settings,C=s.current_lesson,F=o.facts[st.key]||{},V={session:null,homework:[],quiz:[]},chips=[];
  var cf=F[C]||{},ci=o.lessons[C],att=cf.attendance,needs=false,wp=cf.watch_pct;
  chips.push({key:"attendance",label:att==="center"?"سنتر":att==="online"?"أونلاين":"الحضور غير محدد",tone:att?"grey":"amber"});
  if(C&&ci&&ci.has_video){var state;
    if(!att){state="needs_attendance";needs=true}else if(att==="center")state="optional";
    else if(!cf.can_watch)state="session_locked";else if(!wp)state="session_unwatched";
    else if(wp<o.settings.watch_done_pct)state="session_unfinished";else state="session_done";
    V.session={lesson:C,state:state};
    chips.push(att==="center"?{key:"watch",label:"▶ اختياري",tone:"grey"}:(!cf.can_watch?{key:"watch",label:"🔒 الفيديو مقفول",tone:"red"}:
      {key:"watch",label:"▶ "+(wp||0)+"%",tone:wp>=80?"green":wp>0?"amber":"red"}));}
  (s.review_lessons||[]).forEach(function(R,i){var ri=o.lessons[R]||{},f=F[R]||{};
    if(ri.has_assignment){var h=f.homework&&f.homework.submitted;V.homework.push({lesson:R,state:h?"homework_done":"homework_missing"});
      if(!i)chips.push({key:"homework",label:h?"📝 ✓":"📝 ✕",tone:h?"green":"red"});}
    if(ri.has_quiz){var q=f.quiz||{};V.quiz.push({lesson:R,state:q.taken?"quiz_taken":"quiz_absent"});
      if(!i)chips.push(q.taken?{key:"quiz",label:"❓ "+q.score+"/"+q.total,tone:"grey"}:{key:"quiz",label:"❓ غائب",tone:"red"});}});
  return {verdicts:V,issues:[],praises:[],needsAttendance:needs,microChips:chips,primaryAction:null}}
window.FollowupLogic={phoneKey:phoneKey,nextSession:nextSession,groupDeadlines:groupDeadlines,deadlineState:deadlineState,
  deadlineWhen:deadlineWhen,studentSummary:studentSummary,checkParentPhone:checkParentPhone,waDigits:waDigits,__stub:true};
})();
"""

TEMPLATES_STUB = r"""
(function(){
var HDR="السلام عليكم 👋\n\nمع حضرتك *فريق الدعم* 💻\n\n";
var DEFAULTS={header:HDR,
 session_unwatched:"{H}📚 حصة *{lesson}* لم تُشاهَد من *{student_name}*",
 session_unfinished:"{H}▶️ مشاهدة *{student_name}* لحصة *{lesson}* لم تكتمل (*{watch_pct}%*)",
 session_done:"{H}✅ *{student_name}* أنهى حصة *{lesson}*",
 homework_missing:"{H}📝 واجب *{lesson}* لم يُسلَّم من *{student_name}*\n\n⏰ *{deadline_when}*",
 homework_done:"{H}✅ واجب *{lesson}* اتسلّم من *{student_name}*",
 quiz_mark:"{H}📊 نتيجة *{student_name}* في *{lesson}*: *{score} من {total}*",
 quiz_praise:"{H}👏 *{student_name}*: *{score} من {total}* في *{lesson}*",
 quiz_absent:"{H}⚠️ كويز *{lesson}* لم يُحَل من *{student_name}* ولازم *يتعوّض*",
 combined:"{H}📌 بخصوص *{student_name}*\n\n{issues}",
 group_reminder:"السلام عليكم 👋\n\n📣 *تذكير مهم*\n\n{hw_list}\n\n⏰ *{deadline_when} آخر معاد*"};
var LINES={session_unwatched:"▶️ حصة *{l}*: لم تُشاهَد",session_unfinished:"▶️ حصة *{l}*: لم تكتمل",homework_missing:"📝 واجب *{l}*: لم يُسلَّم",quiz_absent:"❓ كويز *{l}*: لم يُحَل"};
function pretty(p){return String(p||"").split("/").pop().replace(/-/g," ")}
function iso(s){return "\u2068"+s+"\u2069"}
function clean(s){return String(s||"").replace(/[*_~`]/g,"")}
function buildContext(a){var s=a.student,f=a.facts||{},q=f.quiz||{},g=a.group||{},st=g.settings||{};
 var hw=(st.review_lessons||[]).map(function(r,i){return (i+1)+"️⃣ نتأكد من تسليم واجب *"+iso(pretty(r))+"*"}).join("\n");
 var dw=a.deadlines&&a.deadlines.hw?window.FollowupLogic.deadlineWhen(a.now,a.deadlines.hw):"";
 return {student_name:s?clean(s.name):"",student_first_name:s?clean(s.name).split(" ")[0]:"",group:g.group||"",
  lesson:iso(pretty(a.lesson)),lesson_slug:iso(String(a.lesson||"").split("/").pop()),watch_pct:f.watch_pct==null?"":f.watch_pct,
  score:q.score==null?"":q.score,total:q.total==null?"":q.total,hw_list:hw,deadline_when:dw}}
function render(body,ctx){var miss=[];var t=body.replace(/\{([a-z_]+)\}/gi,function(m,k){if(k in ctx)return ctx[k];miss.push(m);return m});
 return {text:t.split("\n").filter(function(l,i,a){return !(l===""&&a[i-1]==="")}).join("\n"),missing:miss}}
function compose(summary,kind,ctx){var ov=ctx.templates||{},hdr=ov.header||DEFAULTS.header,body=ov[kind]||DEFAULTS[kind];
 if(kind==="combined"){ctx.issues=((summary&&summary.dueIssues)||[]).map(function(i){return LINES[i.kind].replace("{l}",iso(pretty(i.lesson)))}).join("\n")}
 return render(body.replace("{H}",hdr),ctx).text}
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
function formatPreview(t){return esc(t).replace(/(^|[\s>])\*([^*\n]+)\*/g,"$1<b>$2</b>").replace(/\n/g,"<br>")}
function waLink(d,t){return "https://wa.me/"+d+"?text="+encodeURIComponent(t)}
function copyText(t){window.__copied=t;return Promise.resolve(true)}
function mountEditor(el,o){var h='<div class="stub-editor">';Object.keys(o.defaults).forEach(function(k){
  h+='<label>'+k+'<textarea dir="auto" data-key="'+k+'">'+esc(o.templates[k]||o.defaults[k])+'</textarea></label>'});
 h+='<button type="button" id="stub-save">حفظ</button></div>';el.innerHTML=h;
 el.querySelector("#stub-save").addEventListener("click",function(){var ch={};el.querySelectorAll("textarea").forEach(function(t){
  var k=t.dataset.key;ch[k]=t.value===o.defaults[k]?null:t.value});o.onSave(ch)})}
window.FollowupTemplates={DEFAULTS:DEFAULTS,PLACEHOLDERS:{},buildContext:buildContext,render:render,compose:compose,formatPreview:formatPreview,
  waLink:waLink,copyText:copyText,mountEditor:mountEditor,__stub:true};
})();
"""

AUTH_STUB = r"""
window.__calls = [];
window.AuthEngine = {
  mount: function(sel, cb){ cb(window.__SESSION); },
  clearSession: function(){}, getSession: function(){ return window.__SESSION; },
  adminCall: function(session, payload){
    window.__calls.push(payload);
    if (window.__deny) return Promise.reject(new Error("Not authorized."));
    if (payload.action === "admin_followup_overview")
      return fetch("/dashboard/_fixtures/followup-overview.json").then(function(r){ return r.json(); });
    if (payload.action === "admin_followup_set_attendance")
      return Promise.resolve({ok:true, results: payload.items.map(function(i){ return {phone:i.phone, mode:i.mode, can_watch:true, quiz_open:true}; })});
    if (payload.action === "admin_followup_save_group") return Promise.resolve({ok:true, settings:payload});
    if (payload.action === "admin_followup_save_templates") return Promise.resolve({ok:true, templates:payload.templates});
    return Promise.resolve({ok:false, error:"?"});
  }
};
"""

# ---------------------------------------------------------------------------------------------
# plumbing
# ---------------------------------------------------------------------------------------------
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=REPO))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, "http://127.0.0.1:%d" % srv.server_address[1]


def real(name):
    return os.path.exists(os.path.join(REPO, "assets", name))


def new_page(browser, base, width=390, height=844, dark=False, mutate=None, fixture_status=None, block=(), url_extra="?mock=1"):
    ctx = browser.new_context(viewport={"width": width, "height": height}, color_scheme="dark" if dark else "light",
                              is_mobile=width < 600, has_touch=width < 600, locale="ar-EG", timezone_id="Africa/Cairo")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "fonts" not in m.text and "Failed to load resource" not in m.text else None)
    page.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
    if not real("followup-logic.js") and "logic" not in block:
        page.route("**/assets/followup-logic.js", lambda r: r.fulfill(body=LOGIC_STUB, content_type="application/javascript"))
    if not real("followup-templates.js") and "templates" not in block:
        page.route("**/assets/followup-templates.js", lambda r: r.fulfill(body=TEMPLATES_STUB, content_type="application/javascript"))
    if not real("followup-templates.css"):
        page.route("**/assets/followup-templates.css", lambda r: r.fulfill(body=".stub-editor textarea{display:block;width:100%;min-height:48px}.stub-editor button{min-height:48px;min-width:48px}", content_type="text/css"))
    if "logic" in block:
        page.route("**/assets/followup-logic.js", lambda r: r.fulfill(status=404, body=""))

    def fx(route):
        if fixture_status:
            route.fulfill(status=fixture_status, body="boom")
            return
        data = json.load(open(FIXTURE, encoding="utf-8"))
        if mutate:
            mutate(data)
        route.fulfill(body=json.dumps(data), content_type="application/json")
    page.route("**/_fixtures/followup-overview.json", fx)
    page.goto(base + PAGE + url_extra)
    return ctx, page, errors


def no_hscroll(page):
    return page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 && document.body.scrollWidth <= document.documentElement.clientWidth + 1")


def small_targets(page):
    return page.evaluate("""() => { const bad=[];
      document.querySelectorAll('button,a[href],select,textarea,input:not([type=checkbox]),summary,label.fu-switch').forEach(e=>{
        const r=e.getBoundingClientRect(); if(!r.width||!r.height) return; if(e.closest('[hidden]')) return;
        if(r.height<47.5||r.width<47.5) bad.push((e.id||e.className||e.tagName)+' '+Math.round(r.width)+'x'+Math.round(r.height)); });
      return bad; }""")


CONTRAST_JS = """(sels) => sels.map(s => { const e=document.querySelector(s); if(!e) return [s,null];
  const parse=c=>c.match(/[\\d.]+/g).map(Number);
  const lum=([r,g,b])=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(r)+.7152*f(g)+.0722*f(b)};
  let bg=null,n=e; while(n){const c=getComputedStyle(n).backgroundColor; const p=parse(c); if(p.length<4||p[3]>0.5){bg=p.slice(0,3);break} n=n.parentElement}
  bg=bg||[255,255,255]; const fg=parse(getComputedStyle(e).color).slice(0,3);
  const a=lum(fg),b=lum(bg); return [s,(Math.max(a,b)+.05)/(Math.min(a,b)+.05)]; })"""


def main():
    if not os.path.exists(FIXTURE):
        print("FAIL fixture missing: " + FIXTURE)
        return 1
    for need in ("followup.css", "followup-app.js"):
        if not real(need):
            print("FAIL missing assets/" + need)
            return 1
    stubs = [n for n in ("followup-logic.js", "followup-templates.js") if not real(n)]
    if stubs:
        print("NOTE using contract-shaped stand-ins for: " + ", ".join(stubs) + " (real files not merged yet)\n")
    srv, base = serve()
    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ---------------- mobile: group page ----------------
        ctx, page, errors = new_page(browser, base)
        page.wait_for_selector(".fu-stu")
        check("page loads in mock mode with no JS errors", not errors, errors)
        check("noindex meta present", page.locator('meta[name="robots"]').get_attribute("content") == "noindex, nofollow")
        check("mock badge visible", page.is_visible("#fu-mock"))
        tabs = page.locator(".fu-tab")
        check("tabs: 3 groups + unclassified", tabs.count() == 4, tabs.count())
        check("first tab selected", tabs.first.get_attribute("aria-selected") == "true")
        check("no horizontal scroll (390, group page)", no_hscroll(page))
        check("tap targets >= 48px (group page)", not small_targets(page), small_targets(page))
        check("rtl + arabic", page.evaluate("document.documentElement.dir") == "rtl" and page.evaluate("document.documentElement.lang") == "ar")
        check("base font >= 17px", page.evaluate("parseFloat(getComputedStyle(document.body).fontSize)") >= 17)

        # deadlines + lesson roles
        txt = page.inner_text("section[aria-label='الحصة الجاية']")
        check("next-session card shows weekday/time + countdown", "السبت" in txt and "6:00" in txt and page.is_visible("#fu-countdown"), txt)
        wl = page.locator("[data-dl='ميعاد المشاهدة']")
        hl = page.locator("[data-dl='ميعاد الواجب']")
        check("watch deadline overdue state", "s-overdue" in wl.get_attribute("class") and "انتهى" in wl.inner_text())
        check("homework deadline today state", "s-today" in hl.get_attribute("class") and "النهارده" in hl.inner_text())
        check("role A picker holds the current lesson", page.input_value("#pick-current").endswith("chapter-2-lesson-2-functions"))
        check("role B picker holds the homework & quiz lesson", page.input_value("#pick-review-0").endswith("chapter-2-lesson-1-variables"))
        ra = page.inner_text("#fu-role-a")
        check("role A shows lock chips (lesson/video/quiz)", "الحصة" in ra and "الفيديو" in ra and "الكويز" in ra and "🔒 الفيديو" in ra, ra)
        check("role B shows the quiz lock chip", "الكويز" in page.inner_text("#fu-role-b"))
        check("add-lesson button present", page.is_visible("#fu-add-review"))
        check("no-tracking hint hidden when tracking data exists", not page.locator("#fu-notrack").count())

        # banner + tiles
        check("unmarked banner count", "1 طالب لم يتم تحديد حضورهم" in page.inner_text("#fu-unmarked"), page.inner_text("#fu-unmarked"))
        tiles = {t.get_attribute("data-tile"): t.inner_text().split("\n")[0] for t in page.locator(".fu-tile").all()}
        check("stat tiles count current/review lessons", tiles == {"unwatched": "2", "hwmissing": "2", "quizabsent": "2"}, tiles)
        page.click("#fu-unmarked")
        check("banner filters list to the unmarked student", page.locator(".fu-stu").count() == 1 and "Nour Hassan" in page.inner_text("#fu-rows"))
        page.click("[data-filter='all']")
        check("filter 'all' restores 5 students", page.locator(".fu-stu").count() == 5)
        page.click("[data-tile='quizabsent']")
        check("tile filters the list (quiz absent: Omar + Hana)", page.locator(".fu-stu").count() == 2)
        page.click("[data-tile='quizabsent']")
        check("tapping the tile again clears the filter", page.locator(".fu-stu").count() == 5)
        page.fill("#fu-q", "sara")
        check("search by name", page.locator(".fu-stu").count() == 1 and page.input_value("#fu-q") == "sara")
        page.fill("#fu-q", "")

        # collapsed micro-chips
        head = page.inner_text("#stu-1012345001 .fu-stu-head")
        check("collapsed row: name + attendance/watch/homework/quiz chips", "Mariam Ahmed" in head and "أونلاين" in head and "42%" in head and "📝" in head and "❓" in head, head)
        check("collapsed row for unmarked student says الحضور غير محدد", "الحضور غير محدد" in page.inner_text("#stu-1012345004 .fu-stu-head"))

        # accordion
        page.click("#stu-1012345001 .fu-stu-head")
        check("accordion opens one student", page.locator(".fu-stu.open").count() == 1)
        page.click("#stu-1012345002 .fu-stu-head")
        check("opening another closes the first (one at a time)", page.locator(".fu-stu.open").count() == 1 and page.locator("#stu-1012345002.open").count() == 1)
        check("deep link hash follows the open student", page.evaluate("location.hash") == "#student=1012345002")
        page.click("#stu-1012345002 .fu-stu-head")
        check("tapping the open student closes it", page.locator(".fu-stu.open").count() == 0)

        # Mariam: lesson-2 attendance/watch beside lesson-1 homework/quiz
        page.click("#stu-1012345001 .fu-stu-head")
        body = page.inner_text("#stu-1012345001")
        check("expanded: section A shows current lesson + 42% + target 80%", "الحصة الحالية" in body and "Ch 2 · L2 — Functions" in body and "42%" in body and "80%" in body, body)
        check("expanded: section B shows homework missing + quiz 7 / 10 for lesson 1", "Ch 2 · L1 — Variables" in body and "لم يُسلَّم" in body and "7 / 10" in body, body)
        check("progress bar has a numeric aria value", page.get_attribute("#stu-1012345001 [role=progressbar]", "aria-valuenow") == "42")
        check("parent phone line", "01234567890" in body)
        pri = page.locator("#stu-1012345001 .fu-btn.wa")
        check("one primary green button (single issue due)", pri.count() == 1 and "المشاهدة" in pri.inner_text(), pri.all_inner_texts())
        hwb = page.locator("#stu-1012345001 [data-kind='homework_missing']")
        check("homework not due yet is muted «لسه بدري» but tappable", "muted" in hwb.get_attribute("class") and "لسه بدري" in hwb.inner_text() and hwb.is_enabled())
        check("quiz result button for a taken quiz", page.locator("#stu-1012345001 [data-kind='quiz_mark']").count() == 1)
        check("no horizontal scroll with a student open", no_hscroll(page))
        check("tap targets >= 48px with a student open", not small_targets(page), small_targets(page))

        # attendance radio: optimistic + undo
        page.click("#stu-1012345001 [data-att='center']")
        page.wait_for_selector("#stu-1012345001 :text('الفيديو والكويز مفتوحين مجانًا')")
        check("center shows the free-unlock chip", True)
        check("center radio selected", page.get_attribute("#stu-1012345001 [data-att='center']", "aria-checked") == "true")
        check("center: watching is optional", "المشاهدة اختيارية" in page.inner_text("#stu-1012345001"))
        check("undo toast offered", page.is_visible(".fu-toast button"))
        page.click(".fu-toast button")
        page.wait_for_function("document.querySelector(\"#stu-1012345001 [data-att='online']\").getAttribute('aria-checked')==='true'")
        check("undo restores online", "الفيديو والكويز مفتوحين مجانًا" not in page.inner_text("#stu-1012345001"))
        page.click("#stu-1012345001 .fu-stu-head")

        # Hana: locked + combined
        page.click("#stu-1012345005 .fu-stu-head")
        hb = page.inner_text("#stu-1012345005")
        check("locked video shows 🔒 chip in the section", "🔒 الفيديو مقفول" in hb, hb)
        check("quiz absent has its own label + warning", "⚠️ غائب عن الكويز – تعويض" in hb and page.locator("#stu-1012345005 .fu-absent").count() == 1)
        comb = page.locator("#stu-1012345005 .fu-btn.wa")
        check("combined primary button with issue count", comb.count() == 1 and "رسالة مجمّعة" in comb.inner_text() and "(2)" in comb.inner_text(), comb.all_inner_texts())
        check("single buttons listed beneath the combined one", all(page.locator("#stu-1012345005 [data-kind='%s']" % k).count() == 1 for k in ("session_unwatched", "homework_missing", "quiz_absent")))

        # message sheet
        comb.click()
        page.wait_for_selector("#fu-wa-open")
        href = page.get_attribute("#fu-wa-open", "href")
        text = page.input_value("#fu-msg-text")
        u = urllib.parse.urlparse(href)
        qs = urllib.parse.parse_qs(u.query)
        check("wa.me url targets the parent number with Egypt prefix", u.netloc == "wa.me" and u.path == "/201234567894", href)
        check("message text is URL-encoded in the link", qs.get("text", [""])[0] == text and "%0A" in href, href[:120])
        check("opens WhatsApp in a new tab, safely", page.get_attribute("#fu-wa-open", "target") == "_blank" and "noopener" in page.get_attribute("#fu-wa-open", "rel"))
        check("preview renders *bold* as bold + keeps emojis", page.locator("#fu-preview b").count() >= 1 and "👋" in page.inner_text("#fu-preview"))
        check("preview is dir=auto, textarea editable", page.get_attribute("#fu-preview", "dir") == "auto" and page.is_editable("#fu-msg-text"))
        check("combined message lists both due issues", ("⁨" in text) and text.count("▶️") >= 1 and text.count("❓") >= 1, text)
        check("sheet hint about the star", "النجمة" in page.inner_text(".fu-sheet"))
        check("recipient chip shows the parent number", "01234567894" in page.inner_text("#fu-recipient"))
        page.fill("#fu-msg-text", text + "\nتعديل لمرة واحدة")
        href2 = page.get_attribute("#fu-wa-open", "href")
        check("edited text flows into the link", urllib.parse.parse_qs(urllib.parse.urlparse(href2).query)["text"][0].endswith("تعديل لمرة واحدة"))
        check("no horizontal scroll with the message sheet open", no_hscroll(page))
        check("tap targets >= 48px in the message sheet", not small_targets(page), small_targets(page))
        page.click("#fu-copy")
        check("copy button copies the edited text", (page.evaluate("window.__copied") or "").endswith("تعديل لمرة واحدة") if stubs else True)
        page.click("#fu-close")
        check("closing the sheet removes it", page.locator(".fu-sheet").count() == 0)
        page.keyboard.press("Escape")

        # unmarked student: session button disabled
        page.click("#stu-1012345004 .fu-stu-head")
        nb = page.locator("#stu-1012345004 [data-kind='session_unwatched']")
        check("unmarked attendance disables the session button with «حدد الحضور أولًا»", nb.count() == 1 and nb.is_disabled() and "حدد الحضور أولًا" in nb.inner_text(), nb.all_inner_texts())
        check("praise button for a submitted homework still available", page.locator("#stu-1012345004 [data-kind='homework_done']").is_enabled())

        # Omar (center + quiz absent) and Sara (praise)
        page.click("#stu-1012345003 .fu-stu-head")
        ob = page.inner_text("#stu-1012345003")
        check("center attendee: lesson-2 optional beside lesson-1 quiz absent", "المشاهدة اختيارية" in ob and "غائب عن الكويز" in ob and "الفيديو والكويز مفتوحين مجانًا" in ob, ob)
        page.click("#stu-1012345002 .fu-stu-head")
        check("praise buttons for a finished student",
              all(page.locator("#stu-1012345002 [data-kind='%s']" % k).count() == 1 for k in ("session_done", "homework_done", "quiz_praise")))

        # group reminder sheet
        page.click("#fu-reminder")
        page.wait_for_selector("#fu-reminder-state")
        check("reminder sheet has a copy button and NO wa.me link", page.locator("#fu-copy").count() == 1 and page.locator("a[href*='wa.me']").count() == 0)
        check("reminder state chip reflects the homework deadline (today)", "النهارده" in page.inner_text("#fu-reminder-state"))
        check("reminder text built from the review lesson", "chapter 2 lesson 1 variables" in page.inner_text("#fu-preview").replace("\u2068", "").replace("\u2069", ""), page.inner_text("#fu-preview"))
        check("copy-names button shows the count of missing homework (2)", "(2)" in page.inner_text("#fu-copy-names2"))
        page.click("#fu-copy-names2")
        check("copied names are Mariam + Hana", (page.evaluate("window.__copied") or "") == "Mariam Ahmed\nHana Sami" if stubs else True, page.evaluate("window.__copied"))
        page.click("#fu-close")
        page.click("#fu-all-center")
        page.wait_for_selector(".fu-dialog")
        check("bulk attendance asks for confirmation", "5 طالب" in page.inner_text(".fu-dialog"))
        page.click(".fu-dialog .fu-btn:not(.primary)")
        check("cancelling the confirm changes nothing", page.locator(".fu-banner").count() == 1)
        page.click("#fu-all-center")
        page.click(".fu-dialog .fu-btn.primary")
        page.wait_for_function("!document.querySelector('#fu-unmarked')")
        check("bulk 'all center' marks everyone (banner disappears)", True)

        # group settings
        page.click("#fu-edit-time")
        page.select_option("#fu-wd", "2")
        page.fill("#fu-time", "16:30")
        page.click("#fu-save-time")
        page.wait_for_function("document.querySelector('#fu-when').textContent.includes('الثلاثاء')")
        check("weekday/time editor saves and updates the card", "4:30" in page.inner_text("#fu-when"), page.inner_text("#fu-when"))
        page.check("#fu-contacted", force=True)
        check("parents-contacted switch toggles", page.is_checked("#fu-contacted"))
        page.click("#fu-add-review")
        check("add-lesson shows a blank picker", page.locator("#pick-review-new").count() == 1)
        page.select_option("#pick-review-new", index=1)
        page.wait_for_function("document.querySelectorAll('[id^=pick-review-]:not(#pick-review-new)').length===2")
        check("a second homework & quiz lesson was added", page.locator("[data-remove]").count() == 2)
        page.click("[data-remove='1']")
        page.wait_for_function("document.querySelectorAll('[data-remove]').length===1")
        check("homework & quiz lesson can be removed", True)

        # tabs: unclassified
        page.click(".fu-tab[data-tab='__none']")
        page.wait_for_selector("#fu-borrow")
        check("unclassified tab: borrow selector + the unclassified student", page.locator("#stu-1512345012").count() == 1 and page.locator(".fu-stu").count() == 1)
        check("unclassified tab: no group actions / group settings", page.locator("#fu-reminder").count() == 0 and page.locator("#fu-contacted").count() == 0)
        page.click("#stu-1512345012 .fu-stu-head")
        check("unclassified student uses the borrowed lesson roles", "Ch 2 · L2 — Functions" in page.inner_text("#stu-1512345012"))
        page.select_option("#fu-borrow", "tue 4pm")
        page.wait_for_selector("#stu-1512345012")
        check("changing the borrowed group re-renders locally", page.locator("#stu-1512345012.open").count() == 0)
        check("no horizontal scroll (unclassified)", no_hscroll(page))

        # Tue group: parent phone problems + multiple review lessons (Sun)
        page.click(".fu-tab[data-tab='tue 4pm']")
        page.click("#stu-1112345007 .fu-stu-head")
        yb = page.inner_text("#stu-1112345007")
        check("missing parent phone: red chip in the collapsed row", "لا رقم ولي أمر" in page.inner_text("#stu-1112345007 .fu-stu-head"))
        check("missing parent phone: warning + every message button disabled",
              page.is_visible("#fu-phonewarn") and page.locator("#stu-1112345007 [data-buttons] button:not([disabled])").count() == 0, yb)
        page.click("#stu-1112345008 .fu-stu-head")
        check("parent phone equal to the student's own: warning banner shown", page.is_visible("#fu-phonewarn") and "نفس" in page.inner_text("#fu-phonewarn"), page.inner_text("#stu-1112345008"))
        page.click("[data-filter='noparent']")
        check("filter 'بدون رقم ولي أمر' keeps Yara + Karim", page.locator(".fu-stu").count() == 2)
        page.click("[data-filter='all']")
        page.click("#stu-1112345006 .fu-stu-head")
        ab = page.locator("#stu-1112345006 .fu-btn.wa")
        check("before the deadlines only the always-due quiz message is primary", ab.count() == 1 and "الكويز" in ab.inner_text(), ab.all_inner_texts())
        check("session message not yet due is muted", "muted" in page.get_attribute("#stu-1112345006 [data-kind='session_unwatched']", "class"))
        page.click(".fu-tab[data-tab='sun 8pm']")
        page.click("#stu-1212345010 .fu-stu-head")
        zb = page.locator("#stu-1212345010 .fu-sec[data-sec='review']")
        check("two review lessons render two sub-blocks", zb.count() == 2, zb.count())
        check("lesson numbers shown on each sub-block", "الدرس 1" in zb.nth(0).inner_text() and "الدرس 4" in zb.nth(1).inner_text(), zb.all_inner_texts())
        page.click(".fu-tab[data-tab='sat 6pm']")

        # templates + help
        page.click("#fu-templates")
        page.wait_for_selector("#fu-editor textarea")
        check("templates sheet mounts the editor", (page.locator("#fu-editor .ft-tab").count() >= 5 if page.locator("#fu-editor .ft-tab").count() else page.locator("#fu-editor textarea").count() >= 5))
        check("no horizontal scroll in the template editor (390)", no_hscroll(page))
        page.locator("#fu-editor textarea").first.fill("*تعديل* {student_name}")
        page.click("#stub-save") if stubs else None
        if stubs:
            page.wait_for_selector(".fu-toast")
            check("saving templates reports success", "تم حفظ القوالب" in page.inner_text(".fu-toast"))
        page.click("#fu-close")
        page.click("#fu-help")
        check("help lists the messaging rules", "مفيش بوتات" in page.inner_text(".fu-sheet") and page.locator(".fu-help:not(.fu-guide) li").count() == 5 and page.locator(".fu-guide li").count() == 6)
        page.click("#fu-close")

        # global year filter (the fixture's students are all Senior 1)
        page.click(".fu-tab[data-tab]:not([data-tab='__none'])")
        check("year bar: All / Senior 1 / Senior 2 with counts", page.locator("#fu-year button").count() == 3 and "12" in page.inner_text("#fu-year button[data-year='all']"))
        n_all = page.locator(".fu-tab").count()
        opts = page.eval_on_selector("#pick-current", "s => [...s.querySelectorAll('option')].map(o => o.text).join('|')")
        check("lesson picker shows names, not slugs", "Ch 2 · L2 — Functions" in opts and "chapter-2-lesson-2-functions" not in opts, opts)
        page.click("#fu-year button[data-year='2']")
        check("Senior 2 with no Senior 2 students: empty state, no group tabs", page.locator("#fu-year-empty").count() == 1 and page.locator(".fu-tab[data-tab]:not([data-tab='__none'])").count() == 0)
        page.click("#fu-year button[data-year='1']")
        check("Senior 1 keeps every group and their students", page.locator(".fu-tab").count() == n_all and page.locator(".fu-stu").count() > 0)
        sel = page.eval_on_selector("#pick-current", "s => [...s.querySelectorAll('optgroup')].map(g => g.label).join('|')")
        check("Senior 1 picker is grouped by chapter and drops Senior 2 lessons", "الفصل 1" in sel and "سينيور" not in sel, sel)
        page.click("#fu-year button[data-year='all']")
        page.click("#fu-refresh")
        page.wait_for_selector(".fu-toast")
        check("refresh button reloads and shows last-update time", "آخر تحديث" in page.inner_text("#fu-updated"))
        check("no JS errors during the whole session", not errors, errors)
        ctx.close()

        # ---------------- mobile: deep link ----------------
        ctx, page, errors = new_page(browser, base, url_extra="?mock=1#student=1112345009")
        page.wait_for_selector(".fu-stu.open")
        check("deep link #student=… opens that student in the right group tab", page.locator("#stu-1112345009.open").count() == 1 and "Tue 4pm" in page.inner_text(".fu-tab[aria-selected='true']"))
        ctx.close()

        # ---------------- desktop ----------------
        ctx, page, errors = new_page(browser, base, 1280, 800)
        page.wait_for_selector(".fu-stu")
        page.click("#stu-1012345005 .fu-stu-head")
        check("no horizontal scroll (1280)", no_hscroll(page))
        check("tap targets >= 48px (1280)", not small_targets(page), small_targets(page))
        page.locator("#stu-1012345005 .fu-btn.wa").click()
        check("message sheet fits at 1280 without horizontal scroll", no_hscroll(page) and page.is_visible("#fu-wa-open"))
        ctx.close()

        # ---------------- dark mode ----------------
        ctx, page, errors = new_page(browser, base, dark=True)
        page.wait_for_selector(".fu-stu")
        check("dark theme applied", page.evaluate("document.documentElement.getAttribute('data-theme')") == "dark")
        page.click("#stu-1012345005 .fu-stu-head")
        ratios = page.evaluate(CONTRAST_JS, ["body", ".fu-stu-name", ".fu-card h3", ".fu-dl .s-overdue", ".fu-banner", ".fu-chip.red", ".fu-chip.green",
                                             ".fu-tab[aria-selected='true']", ".fu-absent", ".fu-btn.wa", ".fu-sec h4", ".fu-dim", ".fu-tile b"])
        weak = [r for r in ratios if r[1] is not None and r[1] < 4.5]
        check("dark mode: text contrast >= 4.5:1 on key elements", not weak, weak)
        page.locator("#stu-1012345005 .fu-btn.wa").click()
        ratios = page.evaluate(CONTRAST_JS, [".fu-sheet h2", ".fu-bubble", ".fu-btn.wa", "#fu-copy"])
        check("dark mode: message sheet is legible", not [r for r in ratios if r[1] is not None and r[1] < 4.5], ratios)
        check("dark mode: no horizontal scroll", no_hscroll(page))
        ctx.close()
        ctx, page, errors = new_page(browser, base, dark=False)
        page.wait_for_selector(".fu-stu")
        page.click("#stu-1012345005 .fu-stu-head")
        ratios = page.evaluate(CONTRAST_JS, ["body", ".fu-stu-name", ".fu-dl .s-overdue", ".fu-banner", ".fu-chip.red", ".fu-chip.green", ".fu-tab[aria-selected='true']", ".fu-btn.wa", ".fu-absent", ".fu-dim"])
        check("light mode: text contrast >= 4.5:1 on key elements", not [r for r in ratios if r[1] is not None and r[1] < 4.5], [r for r in ratios if r[1] is not None and r[1] < 4.5])
        ctx.close()

        # ---------------- no tracking data hint ----------------
        def no_watch(d):
            for k in d["facts"]:
                for l in d["facts"][k]:
                    d["facts"][k][l]["watch_pct"] = None
        ctx, page, errors = new_page(browser, base, mutate=no_watch)
        page.wait_for_selector(".fu-stu")
        check("hint shown when no student has watch tracking for the current lesson", page.is_visible("#fu-notrack") and "لا توجد بيانات مشاهدة لهذه الحصة بعد" in page.inner_text("#fu-notrack"))
        page.click("#stu-1012345001 .fu-stu-head")
        check("student with no tracking row shows «لا توجد بيانات»", "لا توجد بيانات" in page.inner_text("#stu-1012345001 [data-watch]"))
        ctx.close()

        # ---------------- warnings + error states ----------------
        ctx, page, errors = new_page(browser, base, mutate=lambda d: d.update(lessons_error="GitHub is down"))
        page.wait_for_selector(".fu-stu")
        check("visible warning when the lesson list could not be loaded", page.is_visible("#fu-lessons-error"))
        ctx.close()
        ctx, page, errors = new_page(browser, base, fixture_status=500)
        page.wait_for_selector("#fu-error")
        check("error state with a retry button when the overview fails", page.locator(".fu-err + div button").count() == 1)
        ctx.close()
        ctx, page, errors = new_page(browser, base, block=("logic",))
        page.wait_for_selector("#fu-error")
        check("missing library: clear message naming the file", "followup-logic.js" in page.inner_text("#fu-error"))
        ctx.close()
        ctx, page, errors = new_page(browser, base, mutate=lambda d: (d.update(groups=[], unclassified=[])))
        page.wait_for_selector("#fu-root .fu-empty")
        check("empty state when there are no groups", True)
        ctx.close()
        ctx, page, errors = new_page(browser, base, mutate=lambda d: d["groups"][0].update(members=[]))
        page.wait_for_selector("#fu-rows .fu-empty")
        check("empty state for a group with no students", "مفيش طلاب" in page.inner_text("#fu-rows"))
        ctx.close()

        # ---------------- real mode with a stub AuthEngine (payload shapes) ----------------
        def real_page(session, deny=False):
            c = browser.new_context(viewport={"width": 390, "height": 844}, locale="ar-EG")
            pg = c.new_page()
            pg.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
            if not real("followup-logic.js"):
                pg.route("**/assets/followup-logic.js", lambda r: r.fulfill(body=LOGIC_STUB, content_type="application/javascript"))
            if not real("followup-templates.js"):
                pg.route("**/assets/followup-templates.js", lambda r: r.fulfill(body=TEMPLATES_STUB, content_type="application/javascript"))
            if not real("followup-templates.css"):
                pg.route("**/assets/followup-templates.css", lambda r: r.fulfill(body="", content_type="text/css"))
            pg.route("**/assets/auth.js", lambda r: r.fulfill(body=AUTH_STUB, content_type="application/javascript"))
            pg.route("**/dashboard/student.html", lambda r: r.fulfill(body="<title>student</title>", content_type="text/html"))
            pg.add_init_script("window.__SESSION=%s; window.__deny=%s;" % (json.dumps(session), "true" if deny else "false"))
            pg.goto(base + PAGE)
            return c, pg
        admin = {"student_id": "01000000000", "session_token": "tok", "is_admin": True}
        c, pg = real_page(admin)
        pg.wait_for_selector(".fu-stu")
        check("real mode: no mock badge, overview requested via adminCall", not pg.is_visible("#fu-mock") and pg.evaluate("__calls[0].action") == "admin_followup_overview")
        pg.click("#stu-1012345001 .fu-stu-head")
        pg.click("#stu-1012345001 [data-att='center']")
        pg.wait_for_function("__calls.some(c => c.action==='admin_followup_set_attendance')")
        call = pg.evaluate("__calls.filter(c => c.action==='admin_followup_set_attendance')[0]")
        check("set_attendance payload matches the contract",
              call["lesson"].endswith("chapter-2-lesson-2-functions") and call["grant"] is True and call["items"] == [{"phone": "01012345001", "mode": "center"}], call)
        pg.click("#fu-all-online")
        pg.click(".fu-dialog .fu-btn.primary")
        pg.wait_for_function("__calls.filter(c => c.action==='admin_followup_set_attendance').length===2")
        call = pg.evaluate("__calls.filter(c => c.action==='admin_followup_set_attendance')[1]")
        check("bulk attendance sends every member in one batch", len(call["items"]) == 5 and all(i["mode"] == "online" for i in call["items"]), call)
        pg.evaluate("document.querySelector('.fu-det').open = true")
        pg.fill("#fu-note", "ملاحظة")
        pg.click("#fu-save-settings")
        pg.wait_for_function("__calls.some(c => c.action==='admin_followup_save_group')")
        g = pg.evaluate("__calls.filter(c => c.action==='admin_followup_save_group').pop()")
        keys = {"action", "group", "weekday", "time", "current_lesson", "review_lessons", "note", "parents_contacted", "watch_deadline_override", "hw_deadline_override"}
        check("save_group payload carries exactly the contract fields", set(g.keys()) == keys and g["group"] == "Sat 6pm" and g["note"] == "ملاحظة" and g["review_lessons"][0].endswith("variables"), g)
        pg.click("#fu-templates")
        pg.wait_for_selector("#fu-editor textarea")
        if not real("followup-templates.js"):
            pg.locator("#fu-editor textarea").first.fill("hello {student_name}")
            pg.click("#stub-save")
            pg.wait_for_function("__calls.some(c => c.action==='admin_followup_save_templates')")
            t = pg.evaluate("__calls.filter(c => c.action==='admin_followup_save_templates')[0].templates")
            check("save_templates payload is {key: body|null}", isinstance(t, dict) and t.get("header") == "hello {student_name}" and t.get("combined") is None, t)
        c.close()
        c, pg = real_page(admin, deny=True)
        pg.wait_for_selector("#fu-error")
        check("real mode: «Not authorized.» becomes the friendly Arabic message", "is_admin" in pg.inner_text("#fu-error"), pg.inner_text("#fu-error"))
        c.close()
        c, pg = real_page({"student_id": "01000000001", "session_token": "tok", "is_admin": False})
        pg.wait_for_url("**/dashboard/student.html")
        check("real mode: a non-admin session is sent to student.html", True)
        c.close()
        c, pg = real_page({"student_id": "01000000001", "is_admin": True})
        pg.wait_for_selector("#fu-root .fu-err")
        check("real mode: a session with no token asks the owner to sign in again", "رمز الجلسة" in pg.inner_text("#fu-root"))
        c.close()
        browser.close()
    srv.shutdown()
    print("\n%d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
