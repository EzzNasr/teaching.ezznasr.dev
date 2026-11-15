# System diagrams

*Written 2026-11-16 from the code at `32436a7`. GitHub renders the Mermaid blocks. Part of the
[handoff guide](README.md).*

Contents: [1 Context](#1-context-who-uses-what) · [2 Parts and deploys](#2-parts-and-how-each-one-goes-live) ·
[3 Repo map](#3-repo-map) · [4 Request flow](#4-one-request-through-the-backend) ·
[5 Identity](#5-identity-and-roles) · [6 Data model](#6-data-model) · [7 Sequences](#7-main-sequences) ·
[8 Build and generated files](#8-what-generates-what) · [9 Test layers](#9-test-layers)

## 1. Context: who uses what

```mermaid
flowchart LR
  student["Student<br/>(phone browser)"]
  parent["Parent<br/>(WhatsApp)"]
  owner["Owner"]
  teacher["Teacher / assistants"]
  attTeacher["Attendance teacher<br/>(college lectures)"]

  subgraph sys["teaching.ezznasr.dev"]
    site["Static site<br/>GitHub Pages"]
    api["Backend<br/>Apps Script /exec"]
    qm["Quiz Maker<br/>desktop app"]
    wa["WhatsApp sender<br/>spare phone"]
  end

  sheets[("Google Sheets")]
  drive[("Google Drive")]
  tg["Telegram bots"]
  video["Video host<br/>(embed URLs)"]
  gh["GitHub<br/>(repo, Pages, Actions)"]

  student --> site
  owner --> site
  teacher --> site
  attTeacher --> site
  site -- "POST JSON {action,...}" --> api
  owner --> qm
  qm -- "admin token" --> api
  qm -- "writes lesson pages" --> gh
  gh -- "publishes main" --> site
  api --> sheets
  api --> drive
  api -- "notify" --> tg
  tg -- "webhook: button taps" --> api
  owner --- tg
  teacher --- tg
  wa -- "claim / report (own token)" --> api
  wa -- "messages" --> parent
  site -- "wa.me links (manual send)" --> parent
  site -- "iframe" --> video
  api -- "lists lessons" --> gh
```

## 2. Parts and how each one goes live

```mermaid
flowchart TB
  subgraph dev["Developer machine"]
    repo["git repo"]
    gate["scripts/test_all.sh"]
    qmApp["Quiz Maker (Python)"]
  end

  subgraph github["GitHub"]
    main["main branch"]
    ci["Actions: tests.yml<br/>one job, the full gate"]
    pages["Pages build (Jekyll)<br/>excludes tools/ and README.md"]
  end

  subgraph google["Google (owner's account)"]
    editor["Apps Script editor<br/>8 .gs files"]
    deploy["Deployment (versioned)<br/>one /exec URL"]
    props["Script Properties<br/>secrets and switches"]
    triggers["Time triggers"]
  end

  phone["Spare phone: Termux<br/>git clone + npm install"]

  repo --> gate
  repo -- "git push" --> main
  main --> ci
  main --> pages
  pages --> live["teaching.ezznasr.dev"]
  repo -. "copy and paste each changed .gs<br/>(manual)" .-> editor
  editor -- "Deploy > Manage deployments ><br/>Edit > New version" --> deploy
  props --- deploy
  triggers --- deploy
  qmApp -- "generates lesson pages,<br/>syncs assets" --> repo
  main -. "git pull (manual, over SSH)" .-> phone
  live -- "fetch" --> deploy
```

Rules that follow from this picture:

- **Backend first, then the site.** An old page on a new backend works (changes are additive); a new page on an old
  backend gets `Unknown action`.
- **Never "New deployment"**: it creates a new URL, and the URL is written into six site files and the phone's config.
- Pages publishes whatever is on `main` whether or not CI is green, unless branch protection stops the push.
- Rollback: the site by `git revert` + push; the backend by picking the previous version in *Manage deployments*
  (each deploy and its rollback version is recorded in `docs/attendance/decisions.md`).

## 3. Repo map

```mermaid
flowchart LR
  root["repo root"]
  root --> pagesDir["Published site"]
  root --> toolsDir["tools/ (not published)"]
  root --> infra["scripts/ tests/ docs/ .github/"]

  pagesDir --> lessons["programming/ math/ english/<br/>subject > track > lesson folder<br/>index.html, quiz.html, assignment.html"]
  pagesDir --> dash["dashboard/<br/>13 staff and student pages"]
  pagesDir --> attend["attend/ (student check-in)<br/>attend/admin/ (teacher dashboard)"]
  pagesDir --> assets["assets/<br/>shared engines: auth, quiz, assign, video,<br/>followup-*, requirements, i18n, vendor/katex"]
  pagesDir --> contract["contract/<br/>att_api.js, att_config.js"]

  toolsDir --> gs["quiz-maker-v2/apps_script/<br/>the backend (.gs)"]
  toolsDir --> qm["quiz-maker-v2/<br/>app_main.py, modules/, templates/,<br/>assets_templates/ (source of assets/*.js)"]
  toolsDir --> qmtests["quiz-maker-v2/tests/<br/>registry.json + most tests"]
  toolsDir --> wa["wa-sender/"]
  toolsDir --> seo["seo/"]

  infra --> scripts["scripts/<br/>test_all.sh, run_registry.js,<br/>build_server_logic.py, sync_phase2.py, p4_wire.py"]
  infra --> tests["tests/attendance/ (emulator + tests)<br/>tests/wa/"]
```

| Backend file | Lines | Owns |
|---|---:|---|
| `Code.gs` | 10,374 | Router (`doPost`), accounts, uploads, videos, access and payments, groups, quiz gate and content, follow-up v1, maintenance tools, and the merged Phase 2 / 3 / 4 sections |
| `AttendanceAll.gs` | 2,151 | Attendance: tickets, sign-up, check-in, flags, sessions, rooms, teacher accounts, its own Telegram bot, self-tests and load tests |
| `FollowupLogic.gs` | 1,020 | **Generated** event engine (when is each follow-up step due) |
| `Requirements.gs` | 615 | Requirements catalogue, per-group overrides, month lessons |
| `FollowupNotify.gs` | 456 | Hourly tick, Telegram reminders, snooze / done |
| `FollowupWhatsApp.gs` | 366 | WhatsApp outbox: enqueue, claim, report, modes, watchdog |
| `Revenue.gs` | 236 | Revenue report, lesson price |
| `FollowupRouter.gs` | 180 | Routes `admin_fu2_*` and `admin_req_*` |

## 4. One request through the backend

```mermaid
flowchart TB
  req["POST /exec<br/>body: JSON {action, ...identity, ...fields}"]
  parse{"valid JSON?"}
  att{"att_* action or<br/>?att_tg= webhook?"}
  tg{"body has update_id?<br/>(Telegram webhook)"}
  gate["p4_gate(payload)<br/>who is calling + P4_ACTIONS table<br/>deny by default for scoped callers"]
  sw["switch (payload.action)"]
  pre["_p2Pre hooks<br/>(e.g. server-side grading)"]
  handler["handler<br/>_requireAdmin / _requireAdminSession /<br/>_requireStudentSession, validation"]
  lock["_withLock: re-check + write<br/>(short, shared script lock)"]
  post["_p2Post hooks<br/>p4_filter (scope the response),<br/>p3_withRole, _p2AuditWrap"]
  out["JSON {ok:true,...} or<br/>{ok:false, error, retryable?, disabled?}"]

  req --> parse
  parse -- no --> bad["{ok:false, error:'Invalid JSON body.'}"]
  parse -- yes --> att
  att -- yes --> attd["att_route_ > att_dispatch_<br/>(AttendanceAll.gs, own {ok, code} shape)"]
  att -- no --> tg
  tg -- yes --> tgh["handleTelegramUpdate<br/>secret in URL + tapper id allow-list"]
  tg -- no --> gate
  gate -- deny --> deny["{ok:false, error:'Not authorized.'}"]
  gate -- pass --> sw
  sw --> pre --> handler --> lock --> post --> out
  sw -- "default: admin_fu2_* / admin_req_*" --> fu2["fu2_dispatch_ (FollowupRouter.gs)"]
  fu2 --> out
  handler -- "throw Error" --> err["catch: {ok:false, error: message}"]
```

Notes:

- The site sends `Content-Type: text/plain` so the browser makes no CORS preflight (Apps Script cannot answer one).
- A busy lock throws an error marked `retryable`; clients resend the **same** record and the server de-duplicates on
  the record's `client_id` / dedupe key.
- `doGet` is only a health check.
- Old code throws error **text**; attendance returns error **codes**. New code should return codes
  ([ARCHITECTURE.md](../ARCHITECTURE.md) section 2).

## 5. Identity and roles

```mermaid
flowchart TB
  subgraph schemes["Three ways to prove who you are"]
    s1["A. Session<br/>student_id (phone) + session_token (UUID)<br/>from login_student; stored in localStorage"]
    s2["B. Token<br/>ADMIN_TOKEN (owner, desktop app)<br/>or a teacher token (hash in P4_TEACHER_TOKENS)"]
    s3["C. Attendance token<br/>signed 'u1.' token, 12 h, from att_login<br/>(or ADMIN_TOKEN for the attendance admin)"]
    s4["D. Phone token<br/>WA_SENDER_TOKEN: claim, report, heartbeat only"]
  end

  ctx["p4_ctx(payload) decides the caller kind"]
  s1 --> ctx
  s2 --> ctx

  ctx --> owner["owner<br/>is_admin = TRUE on the Students row,<br/>or ADMIN_TOKEN"]
  ctx --> teacher["teacher<br/>role = teacher, scope = subjects"]
  ctx --> sass["scoped assistant<br/>appointed by a teacher"]
  ctx --> ass["owner's assistant<br/>role = assistant, P3_STAFF_ALLOW list"]
  ctx --> stud["student"]
  ctx --> anon["anon"]

  owner --> all["every action"]
  teacher --> tact["actions in P4_ACTIONS with rule != O,<br/>only lessons in scope, own students and groups;<br/>responses filtered by p4_filter"]
  sass --> sact["as the teacher, minus payments<br/>and P4_ASSISTANT_DENY"]
  ass --> aact["only actions on P3_STAFF_ALLOW"]
  stud --> pact["own results, videos he has access to,<br/>submit, request access"]
  anon --> pub["check_student, register, login,<br/>reset_password, get_video (public part)"]
```

| Page | Owner | Teacher | Teacher's assistant | Owner's assistant |
|---|:-:|:-:|:-:|:-:|
| Results, lesson access | yes | own subjects | own teacher's subjects, no payments | |
| Follow-up, student summary, grading | yes | own students | own teacher's students | yes |
| Requirements | yes | | | yes |
| Team, revenue, teacher stats, wrong questions | yes | | | |
| My team | | yes | | |

The page (`assets/staff-guard.js`) only hides what a role cannot use. The server decides again on every request.

## 6. Data model

Google Sheets tabs. Two spreadsheets for the portal (`STUDENTS_SHEET_ID`, and optionally `DATA_SHEET_ID` for the large
tabs) and one for attendance (`ATT_SHEET_ID`). Tabs are created on first use. Keys are text; there are no enforced
foreign keys, so the relations below are conventions held by the code.

```mermaid
erDiagram
  Students ||--o{ QuizResults : "student_id (phone)"
  Students ||--o{ Submissions : "student_id"
  Students ||--o{ WrittenAnswers : "student_id"
  Students ||--o{ Entitlements : "phone"
  Students ||--o{ Payments : "phone"
  Students ||--o{ QuizAccess : "phone"
  Students ||--o{ Groups : "phone (member row)"
  Students ||--o{ Attendance : "phone"
  Students ||--o{ WatchProgress : "phone"
  Students ||--o{ ParentNotifications : "student"
  Students ||--o{ MonthlyReviews : "student"
  Students ||--o{ StudentEditLog : "target"
  Groups ||--o| GroupSettings : "group_key"
  Groups ||--o{ GroupGrants : "group_key"
  Groups ||--o| GroupOwners : "group_key > teacher"
  Groups ||--o{ GroupRequirements : "group_key"
  Payments ||--o| Entitlements : "approve creates"
  Lessons ||--o{ Videos : "lesson + slot"
  Lessons ||--o| Quizzes : "lesson (quiz lock)"
  Lessons ||--o| QuizContent : "lesson"
  Lessons ||--o| LessonTags : "chapter / term"
  Lessons ||--o| LessonRequirements : "lesson"
  Lessons ||--o{ WrittenModels : "lesson + question"
  QuizResults ||--o{ WrittenAnswers : "submission_id"

  Students {
    text phone PK
    text password_hash
    text display_name
    text session_token
    flag is_admin
    text role
    text year
    text parent_phone
  }
  Entitlements {
    text phone
    text scope "lesson path, #chN or term"
    text expires_at
    text source "payment, manual, group, attendance"
  }
  Payments {
    text payment_id PK
    text phone
    text scope
    text reference
    text status "pending, approved, rejected, revoked"
    number amount
  }
  QuizResults {
    text student_id
    text lesson
    number score
    number total
    json questions_json
    text dedupe_key
  }
  GroupSettings {
    text group_key PK
    number weekday
    text time
    text current_lesson
    json review_lessons
    json hw_lessons
    json quiz_lessons
  }
```

Other portal tabs: `AuditLog` (who changed what), `FollowupTemplates`, `RequirementChecks`, `MonthLessons`,
`TeacherTelegram`, `WaOutbox`.

```mermaid
erDiagram
  AttUsers ||--o{ AttSessions : "owner_user_id"
  AttUsers ||--o{ AttRooms : "owner_user_id"
  AttRooms ||--o{ AttSessions : "room_id"
  AttSessions ||--o{ AttCheckins : "session_id"
  AttStudents ||--o{ AttCheckins : "student_id"
  AttStudents ||--o| AttDevices : "device_id"
  AttStudents ||--o{ AttRequests : "device change"
  AttCheckins ||--o{ AttFlagLog : "session + student"

  AttCheckins {
    text checkin_id PK
    text session_id
    text student_id
    text device_id "MANUAL = entered by hand"
    text server_utc
    number lat
    number lng
    text flags
    text status
    text review_status
  }
  AttSessions {
    text session_id PK
    text course
    text start_utc
    text close_utc
    text owner_user_id
  }
```

Files in Drive: lesson attachments (`ATTACHMENTS_FOLDER_ID`, link-viewable), homework files and result JSON
(`SUBMISSIONS_FOLDER_ID`), handwritten-answer photos (`WRITTEN_FOLDER_ID`, private, served only through
`get_written_image`), weekly backups (`BACKUPS_FOLDER_ID`).

## 7. Main sequences

### 7.1 Sign in

```mermaid
sequenceDiagram
  participant B as Browser (auth.js)
  participant S as Backend
  participant T as Students tab
  B->>S: check_student {phone}
  S-->>B: {known, first name}
  B->>B: hash the password (SHA-256)
  B->>S: login_student {phone, password_hash}
  S->>S: count the attempt (10 wrong = 30 min pause)
  S->>T: compare hash
  alt student or assistant
    S->>T: write a NEW session_token (other device is signed out)
  else owner
    S->>T: keep the existing token
  end
  S-->>B: {student_id, session_token, role...}
  B->>B: save in localStorage "teaching_session"
```

### 7.2 Pay for a lesson and get the video

```mermaid
sequenceDiagram
  participant St as Student page (video.js, subscribe.js)
  participant S as Backend
  participant Tg as Telegram
  participant O as Owner / subject teacher
  St->>S: get_video {lesson, session}
  S-->>St: {locked, need: "payment", pay_info}
  St->>S: request_access {lesson, reference}
  S->>S: lock: one pending request per lesson, cap on pending
  S->>Tg: "Payment request" + Approve / Reject
  O->>Tg: taps Approve
  Tg->>S: webhook (secret in URL, tapper id checked)
  S->>S: handleAdminDecidePayment > Entitlements row
  S->>Tg: edit message "Approved"
  St->>S: get_video
  S-->>St: {embed_url}
  loop while watching
    St->>S: record_watch {pct} (max-merged, throttled)
  end
```

### 7.3 Take a quiz with a handwritten answer

```mermaid
sequenceDiagram
  participant Q as quiz.js
  participant S as Backend
  participant D as Drive
  participant G as grading.html
  Q->>S: get_quiz_state / get_quiz {lesson}
  S-->>Q: questions (answers stripped when FF_DEFERRED_ANSWERS is on)
  Q->>S: check_session (before starting and before sending)
  Q->>S: upload_written_image {question_id, image_base64} per photo
  S->>D: save photo (private)
  Q->>S: upload_quiz_result {client_id, answers...}
  S->>S: no-lock duplicate look, create result JSON, then lock + append row
  S-->>Q: {ok} or {retryable} (resend the same record)
  Q->>S: report_photos (Telegram: "Photos received 2/2")
  G->>S: admin_grading_queue
  G->>S: admin_grade_written {awarded}
  S->>S: score = auto part + graded written marks (recomputed)
```

### 7.4 Attendance check-in

```mermaid
sequenceDiagram
  participant P as Projector (attend/admin, qr.js)
  participant Ph as Student phone (attend.js)
  participant S as Backend (AttendanceAll.gs)
  P->>S: att_start_session {course, room} (teacher token)
  loop every 10 s
    P->>P: new QR = HMAC(session key, time window)
  end
  Ph->>P: scans the QR
  Ph->>S: att_ticket {session, token}
  S-->>Ph: ticket (signed, 240 s)
  Ph->>Ph: GPS + device secret + fingerprint
  Ph->>S: att_attend {ticket, student_id, device, geo}
  S->>S: flags: location, device, repeats > status
  S-->>Ph: recorded (green) / BUSY (retry by itself, up to 120 s late grace)
  S->>P: att_live feed (counters, arrivals, flags)
  S->>S: flag digest to the attendance Telegram bot
```

### 7.5 WhatsApp batch to parents

```mermaid
sequenceDiagram
  participant F as followup.html (staff)
  participant S as Backend (FollowupWhatsApp.gs)
  participant W as wa-sender (phone)
  participant Wa as WhatsApp
  F->>S: admin_fu2_wa_enqueue {items: text per parent}
  S->>S: WaOutbox rows "queued" (dedupe, daily cap, hours)
  loop every 5 min (10 s in test mode)
    W->>S: admin_fu2_wa_claim (WA_SENDER_TOKEN)
    S-->>W: next items, each handed out once
    W->>W: journal "about to send"
    W->>Wa: send (typing, 25-75 s gap)
    W->>W: journal result
    W->>S: admin_fu2_wa_report {sent / failed}
    S->>S: ParentNotifications row only when sent
  end
  S->>S: hourly fu2_wa_watchdog: silent phone, unknown results > Telegram
```

### 7.6 Hourly follow-up tick

```mermaid
flowchart LR
  trig["time trigger, hourly<br/>fu2_notify_tick"] --> ev["FollowupLogic.gs<br/>eventsFor / dueNow per group"]
  ev --> quiet{"8 AM - 10 PM Alex?<br/>not snoozed, not sent?"}
  quiet -- yes --> msg["Telegram message<br/>Open / Snooze 1 day / Done"]
  quiet -- no --> skip["skip"]
  msg --> deep["Open = deep link to that group<br/>and step on followup.html"]
```

## 8. What generates what

```mermaid
flowchart LR
  ev["assets/followup-events.js"] -- "scripts/build_server_logic.py" --> fl["FollowupLogic.gs"]
  tmpl["tools/quiz-maker-v2/assets_templates/*.js"] -- "Quiz Maker: Sync site assets" --> as["assets/*.js"]
  chunks["apps_script/chunks/Phase4_*.gs"] -- "scripts/p4_wire.py" --> code["Code.gs (MERGED sections)"]
  reg["tests/registry.json"] -- "scripts/gen_regression_table.py" --> regmd["docs/REGRESSION.md"]
  qmt["Quiz Maker templates/*.html<br/>+ lesson content"] -- "app_main.py" --> les["lesson folders<br/>index / quiz / assignment .html"]
  seoc["tools/seo/seo_config.json"] -- "seo_build.py" --> sm["sitemap.xml, meta tags"]
  cfg["contract/att_config.js"] -. "parity test" .- attc["ATT_C in AttendanceAll.gs"]
  al["assets/lesson-aliases.json"] -. "parity test R-001b" .- p2["P2_LESSON_ALIASES in Code.gs"]
```

Solid arrows are generators (edit the left side only). Dotted lines are pairs kept equal by a test.

## 9. Test layers

```mermaid
flowchart TB
  gate["scripts/test_all.sh"]
  gate --> syn["1. Syntax<br/>node --check on every .js and .gs, Python ast"]
  gate --> regi["2. Registry: 151 cases (R-...)"]
  gate --> orph["3. Every test file is registered"]
  gate --> livet["5. --live: read-only smoke test of the real /exec"]

  regi --> unit["Node: backend handlers run against the REAL .gs files<br/>in an Apps Script emulator (harness.js, gas_emulator.js)"]
  regi --> dom["Node + fake DOM / jsdom: page scripts"]
  regi --> py["Python: Quiz Maker, drift and lesson-path checks"]
  regi --> e2e["Playwright + Chromium: pages in ?mock=1,<br/>or against the emulated backend"]
  regi --> parity["Parity / drift: generated files, client-server constants"]

  editor["Only in the real Apps Script editor:<br/>att_selfTest, att_scriptedRun, att_loadTest"]
```
