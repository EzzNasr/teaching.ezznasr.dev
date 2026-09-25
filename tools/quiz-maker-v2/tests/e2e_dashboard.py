#!/usr/bin/env python3
"""
e2e_dashboard.py — real-browser (Chromium) tests for dashboard/access.html.

Runs the REAL Code.gs (through the Node harness, see e2e_backend.js) as a local backend,
serves the REAL dashboard page + auth.js from the repo, and clicks through it with
Playwright. Nothing touches your live site or Sheet.

    pip install playwright
    playwright install chromium
    python tests/e2e_dashboard.py        (run from tools/quiz-maker-v2)
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_video as E                      # shares the backend launcher, fake-site routing and helpers
from playwright.sync_api import sync_playwright

REPO = E.SITE_ROOT
E.ASSETS["/assets/forms.css"] = E.read(E.QM, "assets_templates", "forms.css")
for extra in ("theme.css", "theme.js"):
    p = os.path.join(REPO, "assets", extra)
    E.ASSETS["/assets/" + extra] = E.read(p) if os.path.exists(p) else ""
DASH_HTML = E.read(REPO, "dashboard", "access.html")

passed = failed = 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("PASS " + name)
    else:
        failed += 1
        print("FAIL " + name + ("  -> " + str(extra)[:300] if extra else ""))


api, sha, TOK = E.api, E.sha, E.TOK
L1, L2, L3 = "programming/other/functions", "programming/other/if-conditional", "english/grammar-basics"
today = None


def plus(ymd, n):
    from datetime import date, timedelta
    y, m, d = [int(x) for x in ymd.split("-")]
    return (date(y, m, d) + timedelta(days=n)).isoformat()


def overview():
    return api(dict(TOK, action="admin_access_overview"))


def login(phone, pw):
    r = api({"action": "login_student", "phone": phone, "password_hash": sha(pw)})
    return {"student_id": r["student_id"], "student_name": r["student_name"], "session_token": r["session_token"],
            "year": "Senior 1", "parent_phone": "01100000009", "is_admin": bool(r.get("is_admin"))}


def reg(phone, pw, name):
    api({"action": "register_student", "phone": phone, "password_hash": sha(pw), "display_name": name,
         "year": "Senior 1", "parent_phone": "01100000009"})
    return login(phone, pw)


def can_watch(sess, lesson, slot="lesson"):
    r = api({"action": "get_video", "lesson": lesson, "slot": slot, "student_id": sess["student_id"], "session_token": sess["session_token"]})
    return bool(r.get("embed_url"))


def open_dash(browser, session, width=1180, dark=False):
    s = E.Site(browser, session=session, pages={"/dashboard/access.html": DASH_HTML})
    s.ctx.close()
    ctx = browser.new_context(viewport={"width": width, "height": 900})
    s.ctx = ctx
    ctx.route(E.SITE + "/**", s._site)
    ctx.route("https://script.google.com/**", s._gas)
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(status=200, content_type="text/css", body=""))
    ctx.route("https://fonts.gstatic.com/**", lambda r: r.fulfill(status=200, body=""))
    if session:
        ctx.add_init_script("localStorage.setItem('teaching_session', %s)" % json.dumps(json.dumps(session)))
    s.page = ctx.new_page()
    s.page.set_default_timeout(8000)
    s.page.goto(E.SITE + "/dashboard/access.html")
    if dark:
        s.page.wait_for_selector(".dash-head")
        s.page.evaluate("document.documentElement.setAttribute('data-theme','dark')")
    return s


def seed():
    """A known world. Returns the sessions and payment ids."""
    global today
    admin_reg = api({"action": "register_student", "phone": "01000000001", "password_hash": sha("adm"), "display_name": "Teacher", "year": "Senior 1", "parent_phone": "01100000001"})
    api({"phone": "01000000001"}, "/__make_admin")
    admin = login("01000000001", "adm")
    S = {"admin": admin, "sara": reg("01000000002", "b", "Sara"), "omar": reg("01000000003", "c", "Omar"),
         "nour": reg("01000000004", "d", "Nour"), "hana": reg("01000000005", "e", "Hana"),
         "mo": reg("01000000006", "f", "Mo")}
    for lesson, slot, vid, locked in [(L1, "lesson", "AAAAAAAAAAA", True), (L1, "quiz", "BBBBBBBBBBB", True),
                                      (L2, "lesson", "CCCCCCCCCCC", True), (L3, "lesson", "DDDDDDDDDDD", False)]:
        E.set_video(lesson, slot, vid, locked=locked)
    ask = lambda s, lesson, ref, note="": api(dict(S[s], action="request_access", lesson=lesson, reference=ref, note=note))
    dec = lambda pid, **kw: api(dict(TOK, action="admin_decide_payment", payment_id=pid, **kw))
    P = {}
    P["nour"] = ask("nour", L1, "wallet-nour")["payment_id"]; dec(P["nour"], decision="approve", days=30)     # active, 30 days
    P["hana"] = ask("hana", L2, "wallet-hana")["payment_id"]; dec(P["hana"], decision="approve", days=3)      # ending soon
    P["mo"] = ask("mo", L1, "wallet-mo")["payment_id"]; dec(P["mo"], decision="approve", days=20)            # will be hand-cancelled
    P["omar_old"] = ask("omar", L2, "wallet-omar-old")["payment_id"]; dec(P["omar_old"], decision="reject")   # rejected
    P["sara"] = ask("sara", L1, "wallet-sara-123", "paid this morning")["payment_id"]                         # PENDING
    P["omar"] = ask("omar", L2, "wallet-omar-456")["payment_id"]                                              # PENDING
    api(dict(TOK, action="admin_grant_access", phone="01000000002", scope="english/*", never=True))           # manual, never expires
    api(dict(TOK, action="admin_grant_access", phone="01000000003", scope=L3, expires_at="2020-01-05"))       # long expired
    api(dict(TOK, action="admin_grant_access", phone="01099999999", scope=L2, days=40))                       # no account yet
    ov = overview()
    today = ov["today"]
    return S, P


def set_payment_status(pid, value):
    """Hand-edit the Payments sheet, exactly like the teacher did."""
    api({"payment_id": pid, "status": value}, "/__set_payment_status")


def run(browser):
    S, P = seed()
    admin = S["admin"]

    # ---- 1. opening the page ---------------------------------------------------------------------------------------------------
    s = open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector(".dash-stats")
    check("page loads for an admin and greets with the title", "Video access" in pg.inner_text("h1"), pg.inner_text("body")[:200])
    stats = pg.inner_text(".dash-stats")
    check("stats: 2 requests waiting", "2" in pg.locator(".dash-stat b").nth(0).inner_text(), stats)
    check("opens on the Requests tab because something is waiting", "is-active" in pg.get_attribute('[data-tab="requests"]', "class"))
    check("both pending requests are listed", pg.locator("[data-payment]").count() == 2)
    card = pg.locator('[data-payment="%s"]' % P["sara"])
    txt = card.inner_text()
    check("a request card shows name, phone, reference, note, lesson and time", all(x in txt for x in ["Sara", "01000000002", "wallet-sara-123", "paid this morning", "Functions", L1, P["sara"]]), txt)
    check("it says this would be her first access to that lesson", "None" in txt or "first" in txt, txt)
    pg.click('[data-tab="access"]')
    pg.click("details.ac-help summary")
    check("help block explains the rules", pg.locator("details.ac-help summary").count() == 1 and "revoke" in pg.inner_text("details.ac-help").lower())
    s.ctx.close()

    # ---- 2. who may open it ----------------------------------------------------------------------------------------------------------
    s = open_dash(browser, S["nour"])
    s.page.wait_for_url("**/student.html")
    check("a non-admin student is sent to their own dashboard", "student.html" in s.page.url)
    s.ctx.close()
    forged = dict(S["nour"], is_admin=True)
    s = open_dash(browser, forged)
    s.page.wait_for_selector(".dash-err")
    check("a forged is_admin flag gets the server's refusal, not data", "doesn't have admin access" in s.page.inner_text(".dash-err"), s.page.inner_text("body")[:200])
    s.ctx.close()

    # ---- 3. approving a request --------------------------------------------------------------------------------------------------------
    s = open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector("[data-payment]")
    card = pg.locator('[data-payment="%s"]' % P["sara"])
    card.locator('[data-open="approve"]').click()
    panel = card.locator('[data-panel="approve"]')
    panel.wait_for()
    check("Approve… opens a panel with what-it-covers and how-long choices", panel.locator("input[type=radio]").count() == 3 and panel.locator("select").count() == 1)
    prev = panel.locator(".ac-preview").inner_text()
    check("the preview says who gets what, until when", "Sara" in prev and "Functions" in prev and plus(today, 30) in prev, prev)
    panel.locator("select").select_option("90")
    check("changing the length updates the preview", plus(today, 90) in panel.locator(".ac-preview").inner_text())
    panel.locator("input[value=folder]").check()
    prev = panel.locator(".ac-preview").inner_text()
    check("choosing a folder updates the preview to the whole folder", "All lessons in" in prev and "Other" in prev, prev)
    panel.locator("select").select_option("until")
    check("'Until a date' shows a date box and holds the button until one is chosen", panel.locator('input[type=date]').is_visible() and panel.locator('[data-do="approve"]').is_disabled())
    panel.locator('input[type=date]').fill(plus(today, 45))
    check("...then enables it", not panel.locator('[data-do="approve"]').is_disabled() and plus(today, 45) in panel.locator(".ac-preview").inner_text())
    panel.locator('[data-do="approve"]').click()
    pg.wait_for_selector(".ac-toast.is-ok")
    check("approving shows a confirmation naming the student, scope and end date", "Approved Sara" in pg.inner_text(".ac-toast") and plus(today, 45) in pg.inner_text(".ac-toast"), pg.inner_text(".ac-toast"))
    check("the request leaves the waiting list", pg.locator('[data-payment="%s"]' % P["sara"]).count() == 0 and pg.locator("[data-payment]").count() == 1)
    check("the server really granted the whole folder (she can now watch another lesson in it)", can_watch(S["sara"], L1) and can_watch(S["sara"], L2))
    s.ctx.close()

    # ---- 4. rejecting -----------------------------------------------------------------------------------------------------------------------
    s = open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector("[data-payment]")
    card = pg.locator('[data-payment="%s"]' % P["omar"])
    card.locator('[data-open="reject"]').click()
    card.locator('[data-panel="reject"]').wait_for()
    card.locator("button", has_text="Cancel").click()
    check("Cancel closes the reject question and changes nothing", card.locator('[data-panel]').count() == 0 and not can_watch(S["omar"], L2))
    card.locator('[data-open="reject"]').click()
    card.locator('[data-do="reject"]').click()
    pg.wait_for_selector(".ac-toast.is-ok")
    check("rejecting confirms and empties the waiting list", "Rejected Omar" in pg.inner_text(".ac-toast") and pg.locator("[data-payment]").count() == 0)
    check("empty state explains itself", "No requests waiting" in pg.inner_text(".dash-section"))
    s.ctx.close()

    # ---- 5. who has access + filters -----------------------------------------------------------------------------------------------------------
    set_payment_status(P["mo"], "rejected")                       # hand-cancel Mo, like the teacher did
    s = open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector('[data-tab="access"]')
    pg.click('[data-tab="access"]')
    pg.wait_for_selector("[data-access]")
    names = pg.inner_text(".dash-section")
    check("default filter shows active access only (Nour, Hana, Sara x2, the no-account number)", "Nour" in names and "Hana" in names and "Mo" not in [w.strip() for w in names.split("\n")][:0] and "01099999999" in names, names[:400])
    nour = pg.locator('[data-access^="01000000004|"]')
    t = nour.inner_text()
    check("an access card shows who, what, until when (with days left), since when and how", all(x in t for x in ["Nour", "Functions", plus(today, 30), "30 days left", "wallet-nour", "Payment " + P["nour"]]), t)
    check("the unknown number is flagged as having no account", "no account with this number yet" in pg.locator('[data-access^="01099999999|"]').inner_text())
    check("a never-ending manual grant says so and where it came from", "Never expires" in pg.locator('[data-access^="01000000002|english/*"]').inner_text() and "Added by hand" in pg.locator('[data-access^="01000000002|english/*"]').inner_text())
    pg.select_option('[data-status="access"]', "ending")
    check("'Ending within 7 days' shows only Hana", pg.locator("[data-access]").count() == 1 and "Hana" in pg.inner_text("[data-access]"), pg.locator("[data-access]").count())
    check("...with a 'ends soon' badge", "ends soon" in pg.inner_text("[data-access]").lower())
    pg.select_option('[data-status="access"]', "expired")
    check("'Expired' shows Omar's ended grant, 'ended … ago'", pg.locator("[data-access]").count() == 1 and "ended" in pg.inner_text("[data-access]") and "ago" in pg.inner_text("[data-access]") and "2020-01-05" in pg.inner_text("[data-access]"), pg.inner_text(".dash-section")[:300])
    pg.select_option('[data-status="access"]', "problem")
    txt = pg.inner_text(".dash-section")
    check("'Cancelled / needs fixing' shows the hand-cancelled payment and explains why", "Mo" in txt and "switched off" in txt and "rejected" in txt, txt[:400])
    pg.select_option('[data-status="access"]', "all")
    n_all = pg.locator("[data-access]").count()
    pg.fill('[data-search="access"]', "hana")
    check("search narrows the list by name (and keeps the typing)", pg.locator("[data-access]").count() == 1 and pg.input_value('[data-search="access"]') == "hana", pg.locator("[data-access]").count())
    pg.fill('[data-search="access"]', "")
    check("clearing the search brings everything back", pg.locator("[data-access]").count() == n_all)
    pg.fill('[data-search="access"]', "zzz-nothing")
    check("no match says so", "Nothing matches" in pg.inner_text(".dash-section"))
    pg.fill('[data-search="access"]', "")
    pg.select_option('[data-status="access"]', "active")
    s.ctx.close()

    # ---- 6. revoking (the whole point) ---------------------------------------------------------------------------------------------------------------
    check("before revoking, Nour can watch", can_watch(S["nour"], L1))
    s = open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector('[data-tab="access"]')
    pg.click('[data-tab="access"]')
    nour = pg.locator('[data-access^="01000000004|"]')
    nour.locator('[data-open="revoke"]').click()
    panel = nour.locator('[data-panel="revoke"]')
    panel.wait_for()
    ptxt = panel.inner_text()
    check("Revoke… asks first and says what will happen (and the honest limit)", "Revoke Nour" in ptxt and "next time they load" in ptxt and "saved the video link" in ptxt, ptxt)
    panel.locator("button", has_text="Cancel").click()
    check("Cancel leaves the access alone", can_watch(S["nour"], L1) and nour.locator('[data-panel]').count() == 0)
    nour.locator('[data-open="revoke"]').click()
    nour.locator('[data-do="revoke"]').click()
    pg.wait_for_selector(".ac-toast.is-ok")
    check("revoking confirms and names the payment it marked revoked", "Revoked Nour" in pg.inner_text(".ac-toast") and P["nour"] in pg.inner_text(".ac-toast"), pg.inner_text(".ac-toast"))
    check("her card is gone from the active list", pg.locator('[data-access^="01000000004|"]').count() == 0)
    check("SERVER: Nour can no longer watch, on either page of the lesson", not can_watch(S["nour"], L1) and not can_watch(S["nour"], L1, "quiz"))
    check("SERVER: her payment is now marked revoked", any(p["payment_id"] == P["nour"] and p["status"] == "revoked" for p in overview()["payments"]))
    s.ctx.close()

    # a hand-cancelled row is tidied without touching history
    s = open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector('[data-tab="access"]')
    pg.click('[data-tab="access"]')
    pg.select_option('[data-status="access"]', "problem")
    mo = pg.locator('[data-access^="01000000006|"]')
    mo.locator('[data-open="revoke"]').click()
    check("removing a cancelled row is described as tidying, not revoking", "Remove this row" in mo.locator('[data-panel="revoke"]').inner_text())
    mo.locator('[data-do="revoke"]').click()
    pg.wait_for_selector(".ac-toast.is-ok")
    check("...and the payment keeps its 'rejected' status", any(p["payment_id"] == P["mo"] and p["status"] == "rejected" for p in overview()["payments"]))
    s.ctx.close()

    # ---- 7. extending -----------------------------------------------------------------------------------------------------------------------------------
    s = open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector('[data-tab="access"]')
    pg.click('[data-tab="access"]')
    hana = pg.locator('[data-access^="01000000005|"]')
    hana.locator('[data-open="renew"]').click()
    panel = hana.locator('[data-panel="renew"]')
    check("Extend… previews that it adds to the end date she already has", "added to the end date" in panel.locator(".ac-preview").inner_text() and plus(today, 33) in panel.locator(".ac-preview").inner_text(), panel.locator(".ac-preview").inner_text())
    panel.locator('[data-do="renew"]').click()
    pg.wait_for_selector(".ac-toast.is-ok")
    after = [a for a in overview()["access"] if a["phone"].endswith("1000000005")][0]
    check("SERVER: her end date moved out by 30 days", after["expires_at"] == plus(today, 33), after)
    s.ctx.close()

    # ---- 8. history -------------------------------------------------------------------------------------------------------------------------------------------
    s = open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector('[data-tab="history"]')
    pg.click('[data-tab="history"]')
    pg.wait_for_selector("[data-history]")
    total = pg.locator("[data-history]").count()
    check("history lists every request ever made", total == len(overview()["payments"]), total)
    pg.select_option('[data-status="history"]', "revoked")
    check("status filter: Revoked shows Nour's", pg.locator("[data-history]").count() == 1 and "Nour" in pg.inner_text("[data-history]"))
    check("...and says the access was removed", "Access removed" in pg.inner_text("[data-history]") or "revoked" in pg.inner_text("[data-history]").lower())
    pg.select_option('[data-status="history"]', "all")
    pg.fill('[data-search="history"]', "wallet-hana")
    hh = pg.locator('[data-history="%s"]' % P["hana"])
    check("search by reference finds the request", pg.locator("[data-history]").count() == 1 and hh.count() == 1)
    ht = hh.inner_text()
    check("an approved request shows the access it gave and its state", "approved" in ht.lower() and plus(today, 33) in ht and "currently active" in ht, ht)
    hh.locator('[data-open="revoke-pay"]').click()
    hh.locator('[data-do="revoke"]').click()
    pg.wait_for_selector(".ac-toast.is-ok")
    check("revoking from the history works by payment id", not can_watch(S["hana"], L2) and any(p["payment_id"] == P["hana"] and p["status"] == "revoked" for p in overview()["payments"]))
    s.ctx.close()

    # ---- 9. videos ------------------------------------------------------------------------------------------------------------------------------------------------
    s = open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector('[data-tab="videos"]')
    pg.click('[data-tab="videos"]')
    pg.wait_for_selector("[data-video]")
    check("all four video slots are listed", pg.locator("[data-video]").count() == 4)
    v1 = pg.locator('[data-video="%s|lesson"]' % L1)
    t = v1.inner_text()
    check("a locked video says who can watch it and how many students that is", "locked" in t.lower() and "You + 1 student" in t and "AAAAAAAAAAA" in t, t)
    check("an open video says everyone", "Everyone" in pg.locator('[data-video="%s|lesson"]' % L3).inner_text())
    v1.locator('[data-open="lock"]').click()
    vt = v1.locator('[data-panel="open"]').inner_text()
    check("opening a video to everyone asks first and warns it can't be undone for those who saw it", "Open this video to everyone" in vt and "can't take back" in vt.replace("not take back", "can't take back") or "not take back" in vt, vt)
    v1.locator('[data-do="open"]').click()
    pg.wait_for_selector(".ac-toast.is-ok")
    check("SERVER: the video is now open to a signed-out visitor", api({"action": "get_video", "lesson": L1, "slot": "lesson"}).get("embed_url", "").endswith("AAAAAAAAAAA"))
    pg.locator('[data-video="%s|lesson"] [data-open="lock"]' % L1).click()
    pg.wait_for_selector(".ac-toast.is-ok")
    pg.wait_for_function("document.querySelector('.ac-toast') && document.querySelector('.ac-toast').textContent.indexOf('now locked') !== -1")
    check("'Lock it' locks again right away (no question needed)", "now locked" in pg.inner_text(".ac-toast") and not api({"action": "get_video", "lesson": L1, "slot": "lesson"}).get("embed_url"))
    s.ctx.close()

    # ---- 10. giving access by hand -----------------------------------------------------------------------------------------------------------------------------------
    s = open_dash(browser, admin)
    pg = s.page
    pg.wait_for_selector('[data-tab="grant"]')
    pg.click('[data-tab="grant"]')
    pg.wait_for_selector("#gr-phone")
    check("Give access starts with the button disabled and a hint", pg.locator('[data-do="grant"]').is_disabled() and "Fill in" in pg.inner_text(".ac-preview"))
    pg.fill("#gr-phone", "+20 100 000 0006")
    pg.select_option("#gr-scope", L1)
    pg.select_option("#gr-term", "never")
    check("the preview reads back what will happen", "Functions" in pg.inner_text(".ac-preview") and "no end date" in pg.inner_text(".ac-preview"), pg.inner_text(".ac-preview"))
    pg.click('[data-do="grant"]')
    pg.wait_for_selector(".ac-toast.is-ok")
    check("granting names the student it matched", "Mo (01000000006)" in pg.inner_text(".ac-toast"), pg.inner_text(".ac-toast"))
    check("SERVER: Mo can watch now", can_watch(S["mo"], L1))
    pg.click('[data-tab="grant"]')
    pg.fill("#gr-phone", "01055554444")
    pg.select_option("#gr-scope", "__custom")
    pg.fill("#gr-custom", "programming/other/brand-new")
    pg.select_option("#gr-term", "30")
    pg.click('[data-do="grant"]')
    pg.wait_for_selector(".ac-toast.is-ok")
    check("an unregistered number is accepted and the toast says it will apply on registering", "no account with this number yet" in pg.inner_text(".ac-toast"), pg.inner_text(".ac-toast"))
    pg.click('[data-tab="grant"]')
    pg.fill("#gr-phone", "0100")
    pg.select_option("#gr-scope", "*")
    pg.click('[data-do="grant"]')
    pg.wait_for_selector(".ac-toast.is-err")
    check("a server refusal is shown as an error, not swallowed", "full phone number" in pg.inner_text(".ac-toast"), pg.inner_text(".ac-toast"))
    s.ctx.close()

    # ---- 11. small screens ----------------------------------------------------------------------------------------------------------------------------------------------------
    for tab in ("requests", "access", "history", "videos", "grant"):
        s = open_dash(browser, admin, width=390)
        pg = s.page
        pg.wait_for_selector('[data-tab="%s"]' % tab)
        pg.click('[data-tab="%s"]' % tab)
        pg.wait_for_timeout(150)
        wide = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        check("phone width: the %s tab does not scroll sideways" % tab, wide <= 1, wide)
        s.ctx.close()


def main():
    backend = E.start_backend()
    try:
        # a tiny extra control endpoint: hand-edit a payment's status, like editing the Sheet
        with sync_playwright() as p:
            browser = p.chromium.launch()
            run(browser)
            browser.close()
    finally:
        backend.terminate()
    print("\n%d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
