# Admin pages: UX audit and plan (2026-11-13)

Scope: the owner/staff pages other than the main dashboard (master.html), groups and lesson access (access.html),
which the owner says are fine. Pages checked in `?mock=1` at 390px and 1280px:
`team.html` (owner: assistants, teachers, staff log), `my-team.html` (a teacher's own assistants + Telegram),
`teacher-stats.html` (the only place revenue is shown), `staff.html` (assistant home, no mock mode, read in code).

## What is wrong

### Revenue (teacher-stats.html): the biggest gap
1. **No revenue per lesson, per month or per group.** Revenue is only split by teacher and by subject.
   "This month", "last month" (computed, never shown) and "all time" are the only time views.
2. **Single-lesson payments carry no amount at all.** The server only reads a price from notes like
   `Grade 2 · Chapter 3 · 250 EGP` (chapter and term subscriptions). Every per-lesson payment is counted as
   "unpriced" and left out of revenue, so the totals are too low and per-lesson revenue cannot be computed today.
3. **Hard to find.** Not in any page's top menu; only a small link in the middle of the team page.
4. **English, technical.** Mono upper-case tiles, a 16-column table (3 columns visible on a phone),
   `Generated 2026-10-31T10:00:00+02:00 · fresh`, `n/a`, "Scope", raw subject keys (`math`).
5. **Eight equal tiles**, half of them not about money (lessons locked, quizzes locked). No main number.

### Staff management (team.html + my-team.html)
6. **Two languages and two directions on one page.** The assistant half is Arabic RTL, the teacher half and the
   log are English LTR, and the page title/lede are English.
7. **Staff spread over two pages and three lists.** Owner assistants (team.html), teachers (team.html) and each
   teacher's assistants (my-team.html, only shown to the owner as the text "Assistants: Omar"). No single list of
   "everyone who can sign in as staff".
8. **No main task.** Five cards of equal weight; the long "what can an assistant do" list (18 lines) took most
   of the phone screen.
9. **Code names on screen:** `Phase3_Roles.gs` in an error, "شيت Students", "Quiz Maker tokens".
10. **Staff log** squashed into six columns on a phone; it shows nothing until a button is pressed.
11. my-team.html is all English (teachers may be fine with that, but it does not match the other staff pages).

## Done now (small, clear fixes; committed locally)
- team.html: code names removed (fixes 9); permissions list folded behind "اضغط للتفاصيل", warning kept visible
  (part of 8); a clear "Revenue and teacher stats" button at the top of the owner part and a "Revenue" nav link
  (part of 3); staff log shows one card per change on a phone, with the name first and the phone small under it (10).
- Test `R-TEAM-UX-1` (`tests/e2e_team_page.py`).

## Proposed (needs the owner's OK)

**P1. One Arabic revenue page «الإيرادات»** (replaces teacher-stats.html; same owner-only guard).
- Main view: one big number, this month's approved revenue, next to last month's, plus "pending" (waiting for you).
- Under it, three switchable tables: **by lesson/chapter** (scope of the payment, readable title), **by month**
  (last 6 months), **by group** (the student's group at payment time). Each row: count of approved payments + amount.
- A short line "N payments have no amount" with a link to fix it, instead of hiding them.
- Teacher/subject table moves below, folded. Lessons-locked/quizzes-locked tiles removed (they live on access.html).
- Needs a new server action (Code.gs) that groups payments by scope, month and group.
- **Decision needed: what is a single lesson worth?** Options:
  (a) count per-lesson payments but show no amount for them;
  (b) add a price per lesson (one price for all lessons, or a column in the Lessons sheet) and write it into the
      payment note when the student pays, like chapters already do (only new payments get an amount);
  (c) (b) plus fill in old payments from today's price.

**P2. One Arabic staff page «الفريق»** (team.html, RTL, Egyptian Arabic, plain words).
- Main view: one list of everyone with staff access - owner, teachers, owner's assistants, each teacher's
  assistants under their teacher - with one "ضيف حد للفريق" button that asks "مساعد ولا مدرّس؟".
- Under it: «آخر التعديلات» (the staff log, loaded on open, last 50, filter by person).
- Folded at the bottom: what an assistant can/can't do; Quiz Maker keys.
- my-team.html stays for teachers (their own assistants + Telegram) but is translated to Arabic in the same style.

**P3. Same top menu on every staff page**, Arabic labels: النتايج · الوصول للدروس · المتابعة · المطلوبات ·
التصحيح · الفريق · الإيرادات (owner sees all; teachers/assistants only theirs, as today).

Order: P1 first (the owner's main complaint, needs the price decision), then P2, then P3.
None of this touches attendance code. P1 changes Code.gs (new version needed); P2/P3 are site files only.

## Agreed and built (2026-11-13)

The owner approved P1-P3 with **option C**, and set the rule: *revenue = money paid through the website only*
(a student subscribed / pressed "I paid", typed the transfer number, and the payment was approved). Access given
by hand or for center attendance is never counted. That is exactly the Payments tab: hand grants, group grants and
attendance never write a Payments row.

**P1 - `dashboard/revenue.html` «الإيرادات»** (owner only; `teacher-stats.html` stays, linked at the bottom as
"أرقام كل مدرّس ومادة"). Main view: this month's approved revenue, last month next to it, payments waiting for you
(links to the access page), all time. Then «الفلوس جاية منين؟» by lesson / by month / by group, for any month.
Then the lesson price, and the one-time fill.
- Server: new file **`Revenue.gs`** with `admin_revenue_report`, `admin_revenue_set_price`, `admin_revenue_fill_old`
  (owner only, counts and sums only). Code.gs routes them and, in `handleRequestAccess`, writes today's lesson price
  into a new **`amount`** column of the Payments row (best effort, guarded by `typeof`).
- Amount of a payment: the `amount` column, else the price in a subscription note, else none ("unpriced").
  A price a student typed in the note is never trusted. Only `approved` counts; `pending` is shown apart.
- Option C: "احسبهم بسعر النهارده" writes today's price into every old lesson payment (approved or pending) that
  has no amount, once. Subscriptions are never touched; a later price change does not move filled rows.
- The lesson price lives in the Script Property `REV_LESSON_PRICE_EGP`, set from the page.
- Group = the student's (first) group in the Groups tab today.

**P2 - `dashboard/team.html` «الفريق»**: rebuilt in Arabic, same look as the follow-up page. One list: owner,
teachers (subjects in words, Telegram status, their assistants under them), your own assistants. One
"+ ضيف حد للفريق" button (assistant, or teacher with subjects). «آخر التعديلات» loads on open (50, "show older"
up to 200), as cards in plain words. Folded: what an assistant can do, Quiz Maker devices.
`my-team.html` «فريقي» translated to Arabic.

**P3**: every admin page's menu now uses the same Arabic words (النتايج · الوصول للدروس · المتابعة · المطلوبات ·
التصحيح · الفريق · الإيرادات). الفريق and الإيرادات are owner-only on pages teachers can open.

**To deploy (owner):** Apps Script: add the new file `Revenue.gs`, replace `Code.gs`, then New version. Site files:
`dashboard/{revenue,team,my-team,teacher-stats,master,access,grading,wrong-questions}.html`, `assets/staff-guard.js`.
Then open الإيرادات, set the lesson price, and press the fill button once.

Tests: R-REV-1 (`tests/test_revenue.js`), R-REV-2 (`tests/e2e_revenue.py`), R-TEAM-UX-1 (`tests/e2e_team_page.py`),
and the team / my-team sections of `tests/test_p4_s7_pages.js` updated to the Arabic labels.
