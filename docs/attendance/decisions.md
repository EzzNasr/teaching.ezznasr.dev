# Attendance: production hardening, decisions and follow-ups

Started 2026-11-04. Attendance goes into production about a week later (around 2026-11-11).
This file records what we decided, what changed for launch, how to check it, and what was deliberately left for later.
The plans this answers are in the `Docs/` folder outside the repo: `02-plans/active/attendance-college/Attendance System Pricing Plan.pdf`
and `02-plans/active/whatsapp-automation/WhatsApp Follow-up Automation Plan.pdf`. Related pages: [load-testing.md](load-testing.md) (load test
status report), [live-testing-plan.md](live-testing-plan.md) (what is left before and during live testing), [demo-data.md](demo-data.md) (sample data).

## 1. Decisions (2026-11-04)

| # | Decision | Why | Revisit when |
|---|---|---|---|
| D1 | **Attendance stays in the same Apps Script project as `Code.gs` for launch.** No split yet. | We need it working first. The split is a migration (new project, new URL, copy properties), not a feature. | After launch is stable, or when the load test (section 4) or real use shows BUSY/slow check-ins. See F1. |
| D2 | **No tiers or limits are enforced yet** (students per session, groups, teachers). | Pricing tiers are separated later. | When the first paid tier is sold. See F2. |
| D3 | **WhatsApp automation is on hold.** *Update 2026-11-05: the owner got a spare phone (Huawei Y7 Prime 2019); phase 1 is built, off until set up: [docs/whatsapp/README.md](../whatsapp/README.md).* | A ban on the number parents know is a real risk; there is no spare SIM or always-on device yet. | See F3 for the preconditions. |
| D4 | **Late grace: 120 s.** A check-in whose QR was scanned while the session was open is still accepted up to 120 s after its ticket expires or the session closes (by time or by the teacher). New QR scans after close are still refused. Device-change requests get no grace. | The session is only 5 minutes. With 70 students tapping at once some get "server busy"; their automatic retries must not be thrown away at minute 5. | If the review flags show abuse of the extra 2 minutes. |
| D5 | **The student page retries by itself** (no tap needed) and **resumes after a reload**: the pending check-in is kept on the phone and re-sent when the same link is opened again, while the grace lasts. | Students must not lose attendance because the server was busy or the phone locked. | - |
| D6 | **Load test: written here, run by the owner** after deploying (section 4). It writes test rows to the live sheet and removes them with `att_cleanupTest()`. | Only the real Apps Script shows Google's lock and concurrency behaviour; the emulator can't. | Re-run after any change to the check-in path, and before quoting a capacity to a customer. |
| D7 | Decisions and follow-ups are documented in this repo file. | Kept next to the code it describes. | - |
| D8 | **The save screens explain themselves, in English and Arabic, by colour** (2026-11-04, site only, no Apps Script change). Under the button: "Tap, then wait for the green screen". While saving: a spinner and a yellow "Don't close this page. Wait for the green screen." While NOT saved (retrying): the whole screen turns amber with a warning sign, "NOT saved yet", "Stay on this page. It keeps trying by itself.", the reason, the countdown and "Try now". Saved: a green panel, "Attendance recorded / تم تسجيل الحضور", "You can close this page now." The give-up, closed and QR-expired messages and the tab title also have Arabic. | The instructor should not have to explain any of this in class: amber means wait, green means done. Screenshots: [screenshots/](screenshots/README.md). | Other messages (location help, device errors) are still English only. |
| D9 | **Manual entry tab on the dashboard** (2026-11-04, needs an Apps Script redeploy). The instructor picks the lecture, types the student ID, picks a reason (No phone / Check-in page failed / Other + note) and taps Mark present. Works for any lecture the instructor owns, open or already closed. Stored as a normal `AttCheckins` row (no new columns, no `att_migrate`): `device_id` MANUAL, `flags` MANUAL, `status` ok, no location, and the review columns hold who entered it, when and why. Counts as present, never as flagged, never in the cheating feed or the flag log. Already present (by phone or by hand) = nothing written. An ID that never registered needs a name and gets a student row with no device; the first phone that signs up with that ID is bound to it (`att_signup_`), after that it is ID_TAKEN as usual. If the student also checks in by phone, the manual row is kept as it is. | Students without a working phone, or whose page failed, must still be counted, without the instructor editing the sheet. | A manual entry cannot be deleted from the dashboard yet: a mistake is marked Rejected in History (the row still counts as present). Anyone could bind the first phone to a hand-entered ID, the same as signing up any unregistered ID today. |
| D10 | **Plain names on the dashboard (History and Calibrate room kept their names, D13), and decisions where the problem is shown** (2026-11-04, site only). Tabs: Take attendance, Mark present by hand, Phone changes, Needs review (with a count badge), All students (was Roster), Rooms (was Calibrate room), Past lectures (was History), All teachers, Teacher accounts. Flag codes are shown in plain words ("Outside the hall", "Same phone as another student"); the codes stay in the CSV. **Needs review** lists every flagged check-in still undecided, with Accept / Reject and a note right there (before, it only counted flags per student and the decision was in History). **Phone changes stay approval-only**, as before. | A teacher should not need a manual to read the dashboard, and should decide a flagged check-in where it is shown. | - |
| D11 | **Demo data in the live sheet, from the Apps Script editor** ([demo-data.md](demo-data.md)). `att_seedDemo()` writes three weeks of sample data (2 demo teachers whose passwords it logs, 14 lectures, 30 students, every flag and state), `att_demoLive()` runs a live lecture (sample students check in through the real code while the projector is open), `att_clearDemo()` removes all of it. Markers: names and courses start with "DEMO ", student IDs 9997xxxx. Demo lectures never send Telegram (`att_safeNotify_`). An in-browser demo (the backend running on fake data in the page) was tried and dropped as too much to maintain. | See and train on every feature in the real dashboard, then remove it cleanly. | Run `att_clearDemo()` before the real semester data grows, so the admin views stay clean. |
| D12 | **Docs live next to what they describe** ([docs/README.md](../README.md)). Inside the repo (public): anything that must change with the code: architecture, contracts, decisions, runbooks, specs, test docs. Outside the repo (`Docs/`, private): plans, pricing, status reports, known security gaps, archives and large binaries. | One place to look, reviewed with the code, nothing private published. | - |
| D13 | **Polish pass on both pages** (2026-11-04, site only). Tab names: History and Calibrate room are back; the header shows only the name and a role chip (no "sees only your own..." text), and the long explainer sentences are gone. Motion that carries meaning: tabs and cards slide in, new live-feed lines slide in (not the whole list), badges pop and the projector counter bumps when a number changes, buttons show a spinner while they wait for the server, status lines are green / red pills, loading lines get a spinner; Accept / Approve are green; review and hand-entry lists become cards on phones. Student page: steps slide in, the saving overlay fades in, the green check draws itself when attendance lands. Everything is off with the system "reduce motion" setting. Screenshots: [screenshots/](screenshots/README.md). | A calmer, clearer dashboard that teachers trust; motion only where it says something happened. | - |
| D14 | **The QR screen comes alive as students arrive** (2026-11-04, site only). Four counter tiles (Attended, New sign-ups, Cheating caught, Need a look) count up with a glow and a floating "+N"; every arrival gets a card (green check = checked in, blue star = new student, red ! = cheating attempt, which shakes) that slides in beside the QR on a projector and under the counters on a phone, then leaves after a few seconds; a check-in ripples out of the QR code and a cheating attempt flashes the screen edge red. A burst plays faster; a new lecture starts at zero. Numbers come from the same live feed as before (a teacher sees a sign-up once that student checked in to their lecture). **Phones:** no tab scrolls sideways at 360 to 430 px, every button is at least 44 px, the QR screen stacks with its controls in a bar at the bottom (Fullscreen hidden on touch screens). Test: R-A13. | The room sees attendance happening; cheating is visible at once. | - |

## 2. What changed for launch

### Student page (`attend/attend.js`, `contract/att_config.js`)
- **Automatic retry.** Server busy, no connection, server error, or no answer within 30 s: the page waits 2, 4, 8, 12 then 15 s
  (each spread at random by ±25 % so a whole class does not retry in step) and sends the **same** request again: same ticket,
  same location, same fingerprint. It does not ask for GPS again. The server already de-duplicates per session and student.
- **The student always knows it is not saved yet.** While retrying, the screen stays blocked and shows:
  - **NOT saved yet**
  - "...Your attendance is not saved yet. Stay on this page: it keeps trying by itself."
  - a countdown, "Trying again in 6 s (try 3). Don't close this page."
  - a **Try now** button that skips the wait

  The browser tab title changes to "NOT saved yet - Attendance". Closing the page asks for confirmation.
- **Gives up only when the server would refuse anyway** (the 120 s grace minus 4 s). The message is then: *"Your attendance could NOT be saved:
  the server could not be reached in time. Show this screen to your instructor now (ID 2024xxxx)."* A late "recorded" answer
  still wins and shows the success screen.
- **Resume.** The pending check-in (ticket, ID, location, fingerprint, kind) is stored in `localStorage` (`att_pending`) on the student's
  phone. Opening the same link again re-sends it without a new scan. It is dropped once it is recorded, refused, for another session,
  or past the grace.
- **Sign-up then check-in** is one retry loop. Once the sign-up has succeeded only the check-in is retried, never the sign-up.
- The session countdown no longer kills the page while a check-in is still being saved (it says "Still saving your check-in...").

### Server (`tools/quiz-maker-v2/apps_script/AttendanceAll.gs`)
- `ATT_C.LATE_GRACE_SEC = 120`. `att_checkTicket_(..., graceSec)` and `att_acceptsLate_(session, now)` implement D4 for
  `att_attend` and `att_signup` only. `att_ticket` (new scans) still uses `att_isOpen_`.
- **Shorter locked step.** The lock is shared with every quiz and homework submission in `Code.gs` (one project, see F1).
  - `att_attend` reads the check-in history *before* the lock, as before. Inside the lock it now reads only the rows added since
    (with a 20-row margin) and this student's own earlier row. It used to read the key columns of the whole tab, which grows all semester.
  - If rows were deleted by hand meanwhile, it falls back to the old full scan.
  - `att_signup` reads Students and Devices before the lock and only the newly added rows inside it.
- **Retrying a sign-up is safe.** The same phone signing up the same ID again returns `registered` (`dup: true`) instead of `ID_TAKEN`.
  The old answer used to push a student whose first answer was lost into the change-device flow.
- `att_loadTest()` and `att_loadTestFirstDay()` (section 4).

### Tests
- `tests/attendance/late_grace.test.js` (R-A09) covers the grace rules, duplicates under the short lock (concurrent append,
  far-up row, deleted rows), and idempotent sign-up.
- `tests/attendance/student_page.test.js` (R-A05) adds 21 checks: auto-retry, wording, countdown, tab title, resume, give-up,
  retrying past the close, and that the sign-up is never repeated.
- `tests/attendance/feed.test.js` is registered as R-A10. It existed but had never been run by the gate.
- `tests/attendance/multiuser.test.js` checks that `LATE_GRACE_SEC` is the same on the client and the server.

## 3. Deploy (launch week)
**Done 2026-11-04 04:34: Version 60** of deployment `AKfycbzpyJWSI9aRseig...` (same `/exec` URL; Execute as Me, access Anyone).
The project files were brought to the repo exactly (checked by fingerprint): `AttendanceAll.gs` (this work), `Code.gs` (Nov 3
`2d7275a`: Telegram score lines, `report_photos`, `check_session`, written answers out of the submit-time total) and
`FollowupLogic.gs` (`39d326d`: a homework lesson's own due date). `att_selfTest` 30/30, `att_scriptedRun` 43/43, both load tests
PASS, test rows cleaned up. The live URL answers `att_status`, `report_photos` and `check_session`. **Rollback:** Manage
deployments > Edit > Version 59.

**2026-11-04: Version 61** (deployed by the owner): `AttendanceAll.gs` = commit `3a459e2`, manual entry (D9). **Rollback:** Version 60.
Since then the repo file differs from Version 61 in comments only (doc paths, D12).

**2026-11-05 02:46: Version 62** (commit `dc2844b`). A check found that Version 61 had been deployed with **older** `Code.gs` and `FollowupLogic.gs` (the Nov 3 copies, `9877ddf`): `report_photos` and `check_session` answered "Unknown action", and the Telegram score lines, written answers kept out of the submit-time score and a homework lesson's own due date were missing. All three changed files (`Code.gs`, `FollowupLogic.gs`, `AttendanceAll.gs`) were replaced with the exact repo files (fingerprint-checked against the editor copy and the GitHub download, then re-read after saving: all 6 files = repo). `att_selfTest` ALL PASS, `att_scriptedRun` 50/50 ALL PASS (incl. manual entry), `att_cleanupTest` done. Live checks: `report_photos`, `check_session`, `att_status`, `att_manual_checkin`, `att_review` answer correctly. Adds the demo-data functions (D11). **Rollback:** Version 61 (but that brings the old `Code.gs` back; Version 60 is the last fully-synced one before this).

Every later deploy: the checklist at the top of [deploy.md](deploy.md), and a line here.

1. Apps Script: paste `AttendanceAll.gs`, then **Deploy > Manage deployments > Edit > New version**, never "New deployment".
   The `/exec` URL in `contract/att_config.js` must not change.
2. Run `att_selfTest()`; expect `ALL PASS`.
3. Run `att_scriptedRun()`; expect all PASS, including "attend within the late grace after close is still accepted".
   Then run `att_cleanupTest()`.
4. Push the site (`attend/attend.js`, `contract/att_config.js`). Deploy the server first. An old cached page still works: it
   retries only by hand, and its config falls back to 120 s.
5. Run the load test (section 4) **outside lecture and quiz hours**, then `att_cleanupTest()`.
6. Do a real run on a few phones with mobile data, including one with the phone locked mid-save and reopened.

## 4. Load test

Moved to its own page: **[load-testing.md](load-testing.md)** (status report, every run, what is not tested yet, how to run it).

## 5. Capacity

See [load-testing.md](load-testing.md#capacity-limits-that-matter).

## 6. Follow-ups (deliberately not done now)

| # | Follow-up | Notes |
|---|---|---|
| F1 | **Split attendance into its own Apps Script project** (pricing plan) | A separate project gets its own lock and its own ~30 concurrent requests, so quiz traffic and check-ins stop waiting on each other. Steps: (1) new project with `AttendanceAll.gs` only (it already bundles attendance, setup, flags and Telegram), plus a tiny `doPost` that calls `att_route_`; (2) copy the Script Properties `ATT_SHEET_ID`, `ATT_MASTER_SECRET`, `ADMIN_TOKEN` (today it can come from a `Code.gs` global; the new project needs the property), `ATT_TG_BOT_TOKEN`, `ATT_TG_ADMIN_IDS`, `ATT_TG_SECRET`, `ATT_WEBAPP_URL`; (3) deploy, then put the new `/exec` URL in `contract/att_config.js` (`API_URL`), which `attend.js` and `admin.js` both read; (4) `att_setWebhook()` again for the attendance bot; (5) remove the `att_route_` hook line from `Code.gs` `doPost`; (6) re-run section 3 and the load test. Even after the split, all teachers' check-ins share that project's one lock. |
| F2 | **Tiers and limits** (pricing plan) | Nothing in the code caps students, groups, teachers or session size. Selling a 70- or 100-student tier needs a per-teacher limit check in `att_startSession_` / `att_signup_`, plus the matching load-test number. |
| F3 | **WhatsApp follow-up automation** (on hold, D3) | Preconditions: (a) a spare SIM, so a ban never hits the number parents know; (b) a stable always-on sender; (c) port the message templates (`assets/followup-templates.js`) to the server through `scripts/build_server_logic.py`, as was done for logic and events, because messages are built in the browser today; (d) use the per-student `parent_log` (kind, ref, sent_at) as the sent log, keyed by student + kind + session, not the per-group `parents_contacted`; (e) write the attempt before sending, so a crash cannot double-send; (f) if GitHub Actions is ever used: a **private** repo, never the session or phone numbers in logs or artifacts (this repo is public). Sender host idea: an old Android phone with the spare SIM on home Wi-Fi, running Termux + Node + Baileys (see the note below the table). |
| F4 | **Telegram close summary does not count late-grace check-ins** | The summary is sent the moment the session closes. Check-ins accepted in the next 120 s are in the sheet, the roster and the export, but not in that message. Option: a one-shot trigger about 2.5 minutes after close that sends "+N late". |
| F5 | ~~**Flag digest lock**~~ **Done 2026-11-04 (Version 60).** | `attt_withLock_` (the Telegram flag queue) now uses `LockService.getUserLock()` instead of the project script lock, so a flagged check-in no longer queues for the check-in/quiz lock a second time. Still best effort. Covered by R-A09. |
| F6 | **History read grows with the semester** | `att_attend` reads all of `AttCheckins` before the lock (needed by the REPEATED flag, which counts the student's earlier flagged check-ins). Later: cache a per-student flagged count, or archive past semesters into another tab. |
| F7 | **Nightly backup** of the attendance spreadsheet (pricing plan) | A daily time trigger that copies the file to a dated Drive copy and keeps the last N. Not done yet. |
| F8 | **Privacy note for professors** | Student locations are stored per check-in (`lat`/`lng`/`acc`). A short note on what is stored, who sees it, and how long it is kept. |
| F9 | `attend/admin/e2e.test.js` | A stale copy of `tests/attendance/e2e.test.js` that cannot run from that folder, and is not in the registry. Delete it, or point it at the real one. |
| F11 | **One request in a big burst can hang for minutes** | Seen twice in the first-day load test (1 of 70 each time, 173 s and 360 s). The lock kept moving for everyone else, so it was not holding it; it is most likely stuck inside a Google service call (Sheets). The student page already copes (30 s watchdog, then a new try with the same request; the server de-duplicates). Watch for it in the first real lectures (Apps Script > Executions, anything far over 30 s). If it shows up in real use: log timings around each sheet call to find which one stalls. |
| F12 | Load test waits on the slowest request | `UrlFetchApp.fetchAll` has no timeout, so one hung request stalls the whole round (and inflates the reported times). It now logs every round as it happens, so a cut-off run still shows its progress. |
| F10 | **Teacher view of "still trying"** | The dashboard shows only recorded check-ins. A student stuck in retries is invisible to the teacher until recorded or given up. Optional: the page could report "pending" through a cheap lock-free call. |

### Note: the old Honor/Huawei phone as the WhatsApp sender (F3)
- 2 GB RAM and 32 GB storage is enough. A Baileys sender uses roughly 100 to 200 MB and runs about a minute a day.
- Keep Android. Replacing it is not realistic: Huawei and Honor stopped unlocking bootloaders in 2018, so another OS
  (postmarketOS, LineageOS) is generally not possible.
- Install **Termux from F-Droid** (the Play Store build is outdated), then `pkg install nodejs`. This needs Android 7 or newer.
- On EMUI/MagicOS, disable battery optimisation for Termux and allow it to run in the background.
- Inside Termux, run `termux-wake-lock`, and use `cronie` or a long-running loop for the schedule. Keep the phone on the charger and on Wi-Fi.
- The spare SIM's WhatsApp account can live on the same phone (WhatsApp Business app). The script links as a device of that
  account, so the phone is both the account and the sender. Linked devices drop if the main phone is offline for about 14 days,
  so keep it online.
- It gives a stable home IP, no monthly cost, and no data-centre address.
