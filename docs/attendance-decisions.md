# Attendance: production hardening, decisions and follow-ups

Started 2026-11-04. Attendance goes into production about a week later (around 2026-11-11).
This file records what we decided, what changed for launch, how to check it, and what was deliberately left for later.
The plans this answers are in `D:\projects\teaching-site-new\Docs\02-plans\` (outside the repo):
`3-Attendance-College\Attendance System Pricing Plan.pdf` and `WhatsappAutomation\WhatsApp Follow-up Automation Plan.pdf`.

## 1. Decisions (2026-11-04)

| # | Decision | Why | Revisit when |
|---|---|---|---|
| D1 | **Attendance stays in the same Apps Script project as `Code.gs` for launch.** No split yet. | We need it working first. The split is a migration (new project, new URL, copy properties), not a feature. | After launch is stable, or when the load test (section 4) or real use shows BUSY/slow check-ins. See F1. |
| D2 | **No tiers or limits are enforced yet** (students per session, groups, teachers). | Pricing tiers are separated later. | When the first paid tier is sold. See F2. |
| D3 | **WhatsApp automation is on hold.** | A ban on the number parents know is a real risk; there is no spare SIM or always-on device yet. | See F3 for the preconditions. |
| D4 | **Late grace: 120 s.** A check-in whose QR was scanned while the session was open is still accepted up to 120 s after its ticket expires or the session closes (by time or by the teacher). New QR scans after close are still refused. Device-change requests get no grace. | The session is only 5 minutes. With 70 students tapping at once some get "server busy"; their automatic retries must not be thrown away at minute 5. | If the review flags show abuse of the extra 2 minutes. |
| D5 | **The student page retries by itself** (no tap needed) and **resumes after a reload**: the pending check-in is kept on the phone and re-sent when the same link is opened again, while the grace lasts. | Students must not lose attendance because the server was busy or the phone locked. | - |
| D6 | **Load test: written here, run by the owner** after deploying (section 4). It writes test rows to the live sheet and removes them with `att_cleanupTest()`. | Only the real Apps Script shows Google's lock and concurrency behaviour; the emulator can't. | Re-run after any change to the check-in path, and before quoting a capacity to a customer. |
| D7 | Decisions and follow-ups are documented in this repo file. | Kept next to the code it describes. | - |

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
1. Apps Script: paste `AttendanceAll.gs`, then **Deploy > Manage deployments > Edit > New version**, never "New deployment".
   The `/exec` URL in `contract/att_config.js` must not change.
2. Run `att_selfTest()`; expect `ALL PASS`.
3. Run `att_scriptedRun()`; expect all PASS, including "attend within the late grace after close is still accepted".
   Then run `att_cleanupTest()`.
4. Push the site (`attend/attend.js`, `contract/att_config.js`). Deploy the server first. An old cached page still works: it
   retries only by hand, and its config falls back to 120 s.
5. Run the load test (section 4) **outside lecture and quiz hours**, then `att_cleanupTest()`.
6. Do a real run on a few phones with mobile data, including one with the phone locked mid-save and reopened.

## 4. Load test (run by the owner)
In the Apps Script editor, after step 1 of section 3:

| Run | What it simulates |
|---|---|
| `att_loadTest()` | 70 registered students tap Save at the same moment (a normal lecture) |
| `att_loadTestFirstDay()` | 70 new students sign up and check in at once (the first lecture, the heaviest case) |
| `att_loadTest(100)` | a bigger hall |

Each run sends every request at once, re-sends any that got BUSY, a server error or a non-JSON answer (Google's concurrency limit),
the way the page does, and logs each round. It ends with *recorded N/N*, *median / 90 % / slowest time until recorded* and PASS/FAIL.
It stops at the session close + grace, or before Apps Script's 6-minute limit for the run. Afterwards always run `att_cleanupTest()`.

Fill in after running:

| Date | Run | Recorded | Needed a retry | Median | 90 % | Slowest | Notes |
|---|---|---|---|---|---|---|---|
| | `att_loadTest()` | | | | | | |
| | `att_loadTestFirstDay()` | | | | | | |

How to read it: everything recorded with the slowest under ~2 minutes means launch is fine. If the slowest gets close to
5 + 2 minutes, or anything fails, do F1 before more students are added.

## 5. Capacity: what is known
- One check-in holds the project-wide lock only for the dedupe check and the append. Everything else happens outside the lock:
  ticket check, device lookup (cached 60 s), history read, flag rules, flag log, and Telegram.
- That lock is **shared with Code.gs** (quiz and homework submissions wait up to 20 to 30 s for it). A quiz deadline during a
  lecture's check-in window slows both.
- Apps Script runs at most about 30 requests of one project at the same time. Requests beyond that fail fast. The page treats
  that as "no connection / server error" and retries, so it costs time, not attendance.
- The history read before the lock reads the whole `AttCheckins` tab on every check-in. It grows all semester, so the time
  per check-in grows too (see F6).

## 6. Follow-ups (deliberately not done now)

| # | Follow-up | Notes |
|---|---|---|
| F1 | **Split attendance into its own Apps Script project** (pricing plan) | A separate project gets its own lock and its own ~30 concurrent requests, so quiz traffic and check-ins stop waiting on each other. Steps: (1) new project with `AttendanceAll.gs` only (it already bundles attendance, setup, flags and Telegram), plus a tiny `doPost` that calls `att_route_`; (2) copy the Script Properties `ATT_SHEET_ID`, `ATT_MASTER_SECRET`, `ADMIN_TOKEN` (today it can come from a `Code.gs` global; the new project needs the property), `ATT_TG_BOT_TOKEN`, `ATT_TG_ADMIN_IDS`, `ATT_TG_SECRET`, `ATT_WEBAPP_URL`; (3) deploy, then put the new `/exec` URL in `contract/att_config.js` (`API_URL`), which `attend.js` and `admin.js` both read; (4) `att_setWebhook()` again for the attendance bot; (5) remove the `att_route_` hook line from `Code.gs` `doPost`; (6) re-run section 3 and the load test. Even after the split, all teachers' check-ins share that project's one lock. |
| F2 | **Tiers and limits** (pricing plan) | Nothing in the code caps students, groups, teachers or session size. Selling a 70- or 100-student tier needs a per-teacher limit check in `att_startSession_` / `att_signup_`, plus the matching load-test number. |
| F3 | **WhatsApp follow-up automation** (on hold, D3) | Preconditions: (a) a spare SIM, so a ban never hits the number parents know; (b) a stable always-on sender; (c) port the message templates (`assets/followup-templates.js`) to the server through `scripts/build_server_logic.py`, as was done for logic and events, because messages are built in the browser today; (d) use the per-student `parent_log` (kind, ref, sent_at) as the sent log, keyed by student + kind + session, not the per-group `parents_contacted`; (e) write the attempt before sending, so a crash cannot double-send; (f) if GitHub Actions is ever used: a **private** repo, never the session or phone numbers in logs or artifacts (this repo is public). Sender host idea: an old Android phone with the spare SIM on home Wi-Fi, running Termux + Node + Baileys (see the note below the table). |
| F4 | **Telegram close summary does not count late-grace check-ins** | The summary is sent the moment the session closes. Check-ins accepted in the next 120 s are in the sheet, the roster and the export, but not in that message. Option: a one-shot trigger about 2.5 minutes after close that sends "+N late". |
| F5 | **Flag digest lock** | `attt_withLock_` (Telegram flag queue) waits up to 3 s for the same project lock on every flagged check-in during a burst. It is best effort (it carries on without the lock), so it only adds latency. Reduce it to about 1 s, or move the queue to a lock-free cache key per flag. |
| F6 | **History read grows with the semester** | `att_attend` reads all of `AttCheckins` before the lock (needed by the REPEATED flag, which counts the student's earlier flagged check-ins). Later: cache a per-student flagged count, or archive past semesters into another tab. |
| F7 | **Nightly backup** of the attendance spreadsheet (pricing plan) | A daily time trigger that copies the file to a dated Drive copy and keeps the last N. Not done yet. |
| F8 | **Privacy note for professors** | Student locations are stored per check-in (`lat`/`lng`/`acc`). A short note on what is stored, who sees it, and how long it is kept. |
| F9 | `attend/admin/e2e.test.js` | A stale copy of `tests/attendance/e2e.test.js` that cannot run from that folder, and is not in the registry. Delete it, or point it at the real one. |
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
