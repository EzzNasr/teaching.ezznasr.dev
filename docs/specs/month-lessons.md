# The month's required lessons and the monthly mass send

*Built 2026-11-06. Code done and tested. Not deployed: the Apps Script files below need a new version.*

## What it does

On the follow-up page, open a group, then **📅 المراجعة الشهرية**. The sheet now has:

1. **📚 المطلوب في <month>**: which lessons the report counts this month for this group, and where that list comes from:
   - **🌐 ماشية على القائمة العامة**: the group uses the general list for the month.
   - **👥 قائمة خاصة بالمجموعة**: the group has its own list, which replaces the general one for that group.
   - **لسه ما اتحددش**: nothing was chosen for the month, so the report uses the group's weekly review lessons, as before.
2. **✏️ اختار الدروس المطلوبة** opens the menu:
   - Two tabs: **العام (كل المجموعات)** and **the group**.
   - Tick a lesson: its homework and its quiz become required. Each one has its own button to switch it off
     (**✓ واجب مطلوب / ✗ واجب مش مطلوب**, same for the quiz). A lesson that has no quiz starts with the quiz off.
   - On the group tab: a group that follows the general list shows it read-only, with
     **اعمل قائمة خاصة بـ <group>** (it starts as a copy of the general list). A group with its own list has
     **↩ رجّعها للقائمة العامة**, which deletes its own list.
3. **📱 ابعت التقارير من موبايل الواتساب**: the mass send.
   - **This group** or **all groups** (every group's review is loaded; a student in two groups gets one message).
   - Counts before anything is sent: students, will be sent, met everything, missing something, held back (no parent
     number / number needs checking / empty message, listed by name), already sent this month.
   - **📵 لرقمي أنا (تجربة)** is picked by default, also when the phone is live. **👪 لأولياء الأمور** can only be picked
     while the phone is live (`WA_MODE` = live). One more confirmation before anything is queued.
   - Each message is the same monthly-report text the page already makes (template `monthly_review`).

## Rules

- A group's own list **replaces** the general list (whole list, not lesson by lesson). An empty own list means
  nothing is required for that group that month.
- The month's ticks are the owner's choice and win over the per-lesson switches (`LessonRequirements`) for that month.
- Each student is counted against **their group's** list in that group's monthly review. A student with no group uses
  the general list.
- A month marked sent keeps the requirements as they were then (the snapshot), so editing the list later does not change
  a report that went out.
- Test batches (`send_to: "test"`) go to `WA_TEST_TO` with the `[TEST]` header and log nothing, even while the phone is live.
  A live monthly message that the phone reports as delivered marks that student's month **sent** (with the snapshot) and
  writes the contact log, the same as pressing **✓ تم الإرسال**.

## Where it lives

| Part | File |
|---|---|
| Lists (tab `MonthLessons` in the data spreadsheet, created on the first save), `admin_req_month_get`, `admin_req_month_save` | `tools/quiz-maker-v2/apps_script/Requirements.gs` (`req_month_*`) |
| The monthly review counts the ticked lessons; the two actions on the owner-assistant allow-list | `tools/quiz-maker-v2/apps_script/Code.gs` (`_p2fuMonthPlan`, `_p2fuSummaryFor`, `p2_admin_monthly_review`, `P3_STAFF_ALLOW`) |
| `send_to` per batch, test rows while live, a live monthly success marks the month sent | `tools/quiz-maker-v2/apps_script/FollowupWhatsApp.gs` |
| Same rules in the browser | `assets/requirements-logic.js` (`normalizeMonthLessons`, `resolveMonthLessons`) |
| Menu and send screens | `assets/followup-app.js`, `assets/followup-month.js`, `assets/followup-month.css`, `dashboard/followup.html` |
| Tests | R-MONTH-1 `tests/test_month_lessons.js` (96), R-MONTH-2 `tests/e2e_month_lessons.py` (37, Chromium) |

Who may use it: the owner and the owner's assistants can choose the lessons (like the other requirement settings).
Scoped teachers cannot (deny by default). Sending through the phone stays owner only.

## Deploying

Apps Script: replace **`Requirements.gs`**, **`Code.gs`** and **`FollowupWhatsApp.gs`** with the repo files, then
Deploy > Manage deployments > Edit > New version (check every file against the repo first). `FollowupRouter.gs` is unchanged.
The site files (`assets/`, `dashboard/followup.html`) go out with the normal site push.
Until Apps Script is updated, the page says that choosing the month's lessons needs the update and does **not** show the
mass-send button: an older server ignores `send_to`, so with a live phone the batch would go to parents.
