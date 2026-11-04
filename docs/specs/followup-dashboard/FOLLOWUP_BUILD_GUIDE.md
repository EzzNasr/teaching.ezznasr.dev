# Follow-up Dashboard — Build Guide (parallel sessions)

A new admin page, `dashboard/followup.html`, for teaching.ezznasr.dev. Per WhatsApp group it shows
who has watched the session, who submitted the homework, quiz marks, and which lessons are
locked or unlocked. It builds ready-to-send Egyptian-Arabic WhatsApp messages (a `wa.me`
link per student) from editable templates. **It never sends anything itself.**

> **How to use this file.** Sections 0–4 are shared by everybody and are the frozen contract.
> Sections 5.1–5.6 are independent chunks. Give each parallel session: the repo
> (`teaching.ezznasr.dev/` folder), this file, and one line: *"Read §0–§4 and your chunk only. Edit
> only the files your chunk owns. Build against the contract, not against another chunk's code."*
> Chunks 1–5 can run at the same time. Chunk 6 runs last.

---

## 0. Owner's decisions (final)

| Topic | Decision |
|---|---|
| Sending | Manual. Click a button → WhatsApp opens with the message pre-filled. No bots, no unofficial automation. |
| Recipient | `parent_phone`. Fall back to the student's own number only if `parent_phone` is blank, with a visible warning. |
| Warning | Show an on-screen warning when `parent_phone` is blank, malformed, or equal to the student's own number. |
| Wording | Gender-neutral, Egyptian Arabic dialect. Sender voice: «فريق الدعم لبشمهندس عز نصر في مادة البرمجة». |
| Groups | Website groups (the `Groups` sheet tab) = WhatsApp groups. Students in no group go to an **«طلاب غير مصنفين»** tab. |
| Lesson names | Derived from the lesson slug (last path segment). |
| Attendance | Per student, per lesson, a radio: **سنتر** (center) or **أونلاين** (online). **Center = the lesson's video and quiz are unlocked for free** (one tap does both). |
| Unmarked | Show a banner «X طلاب لم يتم تحديد حضورهم». |
| **Two lesson roles per group** | **Current lesson** (example: lesson 2) = what attendance, the free center unlock and the video-watch check apply to. **Homework & quiz lesson(s)** (example: lesson 1, the previous one) = what the homework and quiz checks apply to. Both are picked per group on the group page. Lesson numbers here are examples only. |
| **Student list** | Under each group's tab, every student is an **expandable row** (accordion). Collapsed = name + 4 status micro-chips. Expanded = the full details in two sections (current lesson / homework & quiz), parent phone, and the message buttons. |
| **Message style** | WhatsApp formatting (`*bold*`), emojis, short blocks separated by blank lines. The preview shows it the way WhatsApp will. |
| Watch rule | Center: watching is optional, so no watch message. Online + video unlocked: check progress. Online + video locked: message the parent that the student hasn't watched. |
| Watched = | **≥ 80 %** of the video's distinct duration covered (setting, default 80). |
| Deadlines | Per group: **homework deadline = 1 day before the group's next session**; **session-watch deadline = 3 days before it** (both offsets are settings, so they can change without code). A deadline is the end (23:59 Cairo) of that day. The watch deadline applies to the *current* lesson, the homework deadline to the *homework & quiz* lesson(s). |
| Flow | 1) Reminder in the WhatsApp group (template 4). 2) After the deadline, message the parent. **No contact log. No more escalation levels.** |
| Quiz | Covers all students. Not taken = **absent**: the button label and colour change, a warning shows, and the message says the student must make it up (يعوّض). |
| Messages | Pure templates with `{placeholders}`; the owner edits the template, the variables auto-populate per student. One **combined** message when a student has several issues. Positive (praise) messages too. |
| Look | Different from the other dashboards: **spacious, phone-first**, large tap targets. Must be comfortable one-handed on a phone. |

### Defaults I chose (owner can overturn)
- **Unmarked attendance → parent-message buttons are disabled** («حدد الحضور أولًا»). This avoids messaging a parent about a student who actually attended at the center. The banner shows how many are unmarked.
- Parent-message buttons are *due* only after the relevant deadline. Before it they stay clickable but muted ("not due yet"). Praise messages are always available.
- Praise: video ≥ 80 %, homework submitted, quiz ≥ 90 % (setting).
- A student can be in several groups. They appear in each.

---

## 1. Verified facts about the existing code (read before coding)

Repo root: `teaching.ezznasr.dev/`. Everything below was checked in the source.

**Architecture.** Static site (GitHub Pages) + Google Apps Script bridge `tools/quiz-maker-v2/apps_script/Code.gs` (reference copy; the real one lives at script.google.com) + Google Sheets as the database.

**Calling the bridge from a dashboard.** `window.AuthEngine.adminCall(session, payload)` from `assets/auth.js` → POSTs `payload + {student_id, session_token}` to the baked `DRIVE_ENDPOINT`. See `dashboard/access.html` (`api()`, `load()`) for the pattern: session handling, "Not authorized." message, `STATE`. The server checks admin with `_requireAdminAny(payload)`.

**Routing.** `doPost` has a `switch (payload.action)`. Add new `case`s there (≈ line 1150).

**Sheets already existing** (in `_ss()` unless noted; `_dataSs()` = data spreadsheet, falls back to `_ss()`):

| Tab | Headers |
|---|---|
| `Students` | `phone, password_hash, display_name, created_at, session_token, is_admin, year, parent_phone` |
| `Groups` | `group, phone, name, added_at` (`_groupMembers`, `_groupKey`) |
| `Lessons` | `lesson, locked, updated_at` (lesson-wide lock) |
| `Videos` | `lesson, slot, embed_url, locked, updated_at` (slot ∈ lesson/quiz/assignment) |
| `Quizzes` | `lesson, locked, updated_at` (quiz gate) |
| `Entitlements` | `phone, scope, expires_at, granted_at, source` (video access; scope = lesson path, `a/b/*`, `*`, or `base#chN`) |
| `QuizAccess` | `phone, lesson, expires_at, granted_at, source` |
| `QuizResults` (`_dataSs`) | `student_id, name, subject, lesson, quiz_title, date, start_time, end_time, score, total, questions_json, dedupe_key` |
| `Submissions` (`_dataSs`) | `student_id, name, subject, lesson, submission_type, text, …, file_id, file_name, date, submitted_time, score, total, answers_json, dedupe_key` |

**Lesson identity — the biggest gotcha.**
- Gates, access, `Videos`, `Lessons` use the **full lowercase path**, e.g. `programming/baccalaureate/grade-1-secondary/chapter-2-lesson-3-…` (`_lessonPath()`).
- `QuizResults` and `Submissions` store only the **bare slug** in `lesson`, plus a `subject` field. (`quiz.js` sends `lesson_path` for the gate re-check but it is **not** stored.)
- Join rule: `slug = last path segment`; match `QuizResults/Submissions` on `student_id (phone key) + slug`, and on `subject` too when it is non-empty (compare case-insensitively to the first path segment; **verify against real rows and tell the owner if they differ**). Slug collisions across tracks are possible; flag them, don't guess.

**Phone helpers** (Code.gs): `_phoneKey()` (last 10 digits), `_phonesMatch`, `_canonicalPhone`, `_normalizePhone` (handles Arabic-Indic digits), `_firstName`.

**Access logic to mirror** (`handleGetVideo`): a lesson's video is *locked for a student* when `Videos` row `locked` **or** `_isLessonLocked(lesson)`; a locked video is *watchable* only if `_accessState(ss, phone, lesson).active`. Quiz: `_quizLockedForStudent(lesson, phone)`.
**Performance trap:** `_accessState` re-reads `Entitlements` on every call. The overview must load `Entitlements` / `QuizAccess` / `Videos` / etc. **once** and evaluate in memory (reuse `_scopeCovers`, `_ymdOf`, `_paymentStatuses`).

**Trap in `_grantRaw`:** when a row exists and `source !== "manual"`, it **overwrites** `source`, which would break the link between a paid entitlement and its payment. Do not call it blindly for attendance grants (see Chunk 1).

**Trap in `handleAdminRevokeAccess`:** deletes **every** row for that `phone + scope`, including paid/manual ones. Attendance undo must only remove rows whose `source === "attendance"`.

**Lesson list:** `_allLessonsFromGithub()` returns `{lessons:[{lesson,track}], tracks}` cached under `all_lessons_v1`. It does not say whether a lesson has a quiz or an assignment. Chunk 1 extends it (bump the cache key to `v2`).

**Video player:** `assets/video.js` (source of truth `tools/quiz-maker-v2/assets_templates/video.js`; `DRIVE_ENDPOINT` is baked in by the app's "Sync site assets"; `check_asset_drift.py` diffs them). It already receives YouTube `infoDelivery` messages with `currentTime`, `duration`, `playerState` in `onMsg` inside `mountSlot`, and knows `info.lesson` / `info.kind`. It never reports anything to the server. **No watch tracking exists.**

**Deploy gotchas** (from `Docs/PROJECT_REFERENCE.md`): `Code.gs` must be redeployed as a **New version of the existing deployment** (not "New deployment", which changes the `/exec` URL and breaks every baked endpoint). `assets_templates/*` must be synced and pushed. `robots.txt` already disallows `/dashboard/`.

**Tests:** `tools/quiz-maker-v2/tests/` has `harness.js` and many `test_*.js` for the bridge (Node, mocked Sheets) and `e2e_*.py` (Playwright). Copy their style.

---

## 2. New sheets (created lazily with `_sheetByName(ss, name, HEADERS)`)

| Tab | Headers | Notes |
|---|---|---|
| `Attendance` | `lesson, phone, mode, marked_at` | One row per (lesson path, phone). `mode` ∈ `center` \| `online`. No row = unmarked. |
| `WatchProgress` | `phone, lesson, pct, duration_s, first_at, updated_at` | One row per (phone, lesson path). `pct` = max ever reported (0–100). |
| `GroupSettings` | `group_key, group, weekday, time, current_lesson, review_lessons, note, parents_contacted, watch_deadline_override, hw_deadline_override, updated_at` | `weekday` 0=Sun…6=Sat; `time` `"HH:MM"` Cairo; `current_lesson` = one full lesson path (attendance + watch + free center unlock); `review_lessons` = JSON array of full lesson paths (homework + quiz; usually one, can be several); overrides are `yyyy-MM-dd` or blank. |
| `FollowupTemplates` | `key, body, updated_at` | Saved overrides only. Blank/missing = use the built-in default. |

Settings default (in code, not a sheet): `watch_done_pct = 80`, `praise_quiz_pct = 90`, `watch_days_before = 3`, `hw_days_before = 1`.

---

## 3. API contract (frozen — Chunks 1, 2, 3, 5 all rely on it)

All admin actions require an admin session (`_requireAdminAny`). Errors: `{ok:false,error}`.
Lesson identifiers are always the **full lowercase path**. Phones are returned as the stored string; clients key by last-10-digits (`phoneKey`).

### 3.1 `admin_followup_overview` → read-only, one round trip
Request: `{action}`. Response:
```jsonc
{
  "ok": true,
  "today": "2026-10-16",                 // Cairo yyyy-MM-dd
  "now": "2026-10-16T05:19:00+03:00",
  "settings": { "watch_done_pct": 80, "praise_quiz_pct": 90, "watch_days_before": 3, "hw_days_before": 1 },
  "groups": [{
    "group": "Sat 6pm", "key": "sat 6pm",
    "settings": { "weekday": 6, "time": "18:00",
                  "current_lesson": "programming/…/chapter-2-lesson-2-functions",      // attendance + watch
                  "review_lessons": ["programming/…/chapter-2-lesson-1-variables"],   // homework + quiz
                  "note": "", "parents_contacted": false,
                  "watch_deadline_override": "", "hw_deadline_override": "" },
    "members": [{ "phone": "01012345678", "name": "Mariam Ahmed" }]
  }],
  "unclassified": [{ "phone": "…", "name": "…" }],
  "students": {                            // keyed by phoneKey (last 10 digits)
    "1012345678": { "phone": "01012345678", "name": "Mariam Ahmed",
                    "year": "Senior 2", "parent_phone": "01234567890" }
  },
  "lessons": {                             // only lessons used as current_lesson or in review_lessons by any group
    "programming/…/chapter-2-lesson-1-x": {
      "path": "…", "subject": "programming", "slug": "chapter-2-lesson-1-x",
      "has_video": true, "has_quiz": true, "has_assignment": true,
      "lesson_locked": false, "video_locked": true, "quiz_locked": false
    }
  },
  "all_lessons": [{ "path": "…", "lesson_locked": false, "video_locked": false, "quiz_locked": false }],
  "facts": {                               // facts[phoneKey][lessonPath]
    "1012345678": { "programming/…/chapter-2-lesson-1-x": {
      "can_watch": true,                   // video open for THIS student (open, or a live entitlement)
      "attendance": "online",              // "center" | "online" | null
      "watch_pct": 42,                     // null = no tracking row yet
      "quiz": { "taken": true, "score": 7, "total": 10, "at": "2026-10-14", "attempts": 1 },   // or {"taken":false}
      "quiz_open": true,                   // quiz not locked for this student
      "homework": { "submitted": true, "at": "2026-10-15", "score": null, "total": null }       // or {"submitted":false}
    } } },
  "templates": { "homework_missing": "…custom body…" }
}
```
The server returns **raw facts, not verdicts.** All status rules live in client code (Chunk 3) so they can change without redeploying `Code.gs`. Students with no group appear in `unclassified` and still get `facts` for every lesson used by any group (current or review) (so the tab is useful).

### 3.2 `admin_followup_set_attendance`
Request: `{lesson, items:[{phone, mode}], grant:true}` (`lesson` = the group's **current lesson**; the UI always sends it) where `mode` ∈ `"center"|"online"|""` (`""` clears). Batch under one `_withLock`. Behaviour:
- Upsert `Attendance`.
- `center` + `grant !== false`: ensure free access for **video (Entitlements, scope = lesson) and quiz (QuizAccess)** with `source: "attendance"`, never expiring. **If the student already has a live row covering that lesson (paid, manual, group `a/b/*`, `*`), leave it untouched.**
- Switching to `online` or clearing: delete **only** rows where `source === "attendance"` for that phone + lesson (video scope exactly the lesson, and quiz). Never touch paid/manual rows.

Response: `{ok:true, results:[{phone, mode, can_watch, quiz_open}]}` (fresh values for the touched students).

### 3.3 `admin_followup_save_group`
Request: `{group, weekday, time, current_lesson, review_lessons, note, parents_contacted, watch_deadline_override, hw_deadline_override}`. Validate: group exists, `weekday` 0–6, `time` `^\d{2}:\d{2}$`, `current_lesson` is one path (or blank), `review_lessons` is an array (≤ 5), every lesson is in the GitHub lesson list (soft check; warn don't fail if GitHub is down), overrides empty or `yyyy-MM-dd`. Upsert by `group_key`. Response `{ok:true, settings:{…}}`.

### 3.4 `admin_followup_save_templates`
Request: `{templates:{key: body|null}}` (`null` or `""` = reset to default). Response `{ok:true, templates:{…}}`. Max body 4000 chars, max 30 keys.

### 3.5 `record_watch` — STUDENT session (not admin)
Request: `{lesson, pct, duration_s, student_id, session_token}`. Rules:
- `_requireStudentSession`; the student is taken from the session, never from extra payload fields.
- Ignore (return `{ok:true, ignored:true}`) if the video is locked for that student, or `pct` isn't a finite number; clamp 0–100.
- Upsert `WatchProgress`, storing `max(old, new)`. Cheap: no full-sheet scans per call beyond one lookup (use `CacheService` or a row index map if needed). Rate-limit: ignore updates more often than every ~10 s per (phone, lesson).
- Response `{ok:true, pct}`.

---

## 4. Shared rules (Chunks 3, 4, 5 implement these; keep them in the pure libs)

### 4.1 Time and deadlines (Cairo, `Africa/Cairo`)
- `nextSession(now, weekday, "HH:MM")` = first occurrence **at or after `now`** (so right after a session it rolls forward a week).
- `watchDeadline = date(nextSession) − 3 days`, `hwDeadline = date(nextSession) − 1 day`; a deadline is **23:59 Cairo of that date**. A non-blank override replaces it.
- `deadlineState(now, deadline)` → `"upcoming" | "today" | "overdue"`.
- `deadline_when` phrase: today → «النهارده», tomorrow → «بكرة», otherwise «يوم {weekday-ar} {d/m}».
- **Caveat to show in the UI:** the two lesson pickers (current lesson, homework & quiz lessons) must be moved forward after each session, otherwise the new lesson's deadlines can look overdue.

### 4.2 Lesson roles and per-student verdicts (client-side)

Each group has **two lesson roles**, set on the group page and stored in `GroupSettings`:

| Role | Field | Example | Drives |
|---|---|---|---|
| **Current lesson** | `current_lesson` | lesson 2 | attendance (center / online), the free center unlock, the **video-watch** verdict, `{watch_list}` |
| **Homework & quiz lesson(s)** | `review_lessons` | lesson 1 | the **homework** verdict, the **quiz** verdict, `{hw_list}` in the group reminder |

The numbers are examples: nothing is hard-coded to "previous lesson"; the owner picks both. A lesson may appear in both roles. The same student therefore shows **lesson-2 attendance/watch next to lesson-1 homework/quiz** on one card.

For student `S`, current lesson `C`, each review lesson `R`:
- **Attendance unmarked** (`facts[S][C].attendance == null`) → `needs_attendance`: the *session* parent-message buttons are disabled («حدد الحضور أولًا») and the student counts in the «X طلاب لم يتم تحديد حضورهم» banner. Homework and quiz messages are **not** affected by attendance.
- **Session** (only if `lessons[C].has_video`):
  - `center` → `optional` (if `watch_pct ≥ 80` it is a praise candidate).
  - `online`, `can_watch == false` → `session_locked` → template `session_unwatched` (UI shows a «🔒 الفيديو مقفول» chip so the owner can decide about unlocking first).
  - `online`, `can_watch`, `watch_pct` null or 0 → `session_unwatched`.
  - `online`, `can_watch`, `0 < watch_pct < 80` → `session_unfinished`.
  - `online`, `watch_pct ≥ 80` → `session_done` (praise).
- **Homework** (each `R` with `has_assignment`): `facts[S][R].homework.submitted` → `homework_done` (praise); otherwise `homework_missing`.
- **Quiz** (each `R` with `has_quiz`): taken → `quiz_taken` (praise when `score/total ≥ 90 %`); not taken → **`quiz_absent`** (distinct label «غائب عن الكويز – تعويض», colour and warning icon).
- **Message lesson:** session templates render `{lesson}` with `C`; homework/quiz templates render it with `R` (one message per `R`). The **combined** message lists every issue with *its own* lesson, e.g. «▶️ حصة <lesson 2> … 📝 واجب <lesson 1> …».
- **Due-ness:** `session_*` is *due* after `watchDeadline`; `homework_missing` after `hwDeadline`; `quiz_absent` is always due. Before the deadline the button is muted ("لسه بدري") but still clickable.
- **Combined:** if ≥ 2 negative issues are due/open for the student, offer **one combined message** (template `combined`, lines from `line_*`) as the primary button, with the single-issue buttons beneath.
- **Collapsed-row micro-chips** (UI summary, in this order): attendance (`سنتر` / `أونلاين` / `الحضور غير محدد`), watch (`▶ 42%` / `▶ اختياري` / `🔒 الفيديو مقفول`), homework (`📝 ✓` / `📝 ✕`), quiz (`❓ 7/10` / `❓ غائب`). Colour: green = fine, amber = in progress or needs a mark, red = problem, grey = neutral. A red `⚠️ لا رقم ولي أمر` micro-chip is added when the parent number check fails.
- **Parent phone check** `checkParentPhone(parent, studentPhone)` → `{ok, level:"ok"|"warn"|"missing", reason, wa}`; missing = blank; warn = fewer than 10 digits, or equals the student's own number, or doesn't match Egyptian mobile `^(?:\+?20|0)?1[0125]\d{8}$` (non-Egyptian numbers with a country code are allowed with a "check the number" note). `wa` = digits for `wa.me`: Egyptian `01XXXXXXXXX` → `20` + last 10 digits.

### 4.3 Message engine
- `render(templateBody, ctx)` replaces `{placeholder}`; unknown placeholders are left visible and listed in a warning; **lines that become empty (an optional placeholder rendered "") are dropped**, and 3+ consecutive blank lines collapse to one.
- **Bidi safety:** wrap every inserted LTR run (slugs / lesson names, numbers like `7/10`) in Unicode isolates `⁨…⁩` so the Arabic text doesn't scramble.
- **WhatsApp formatting and emojis (required):**
  - Markup: `*bold*`, `_italic_`, `~strike~`. The marker must touch the text (no space inside) and sit after a space, newline or the start of the message. Put the markers **outside** the bidi isolates: `*⁨slug⁩*`.
  - Strip `* _ ~` and backticks from inserted values (e.g. a student name) so they can't break the formatting.
  - Layout: short blocks separated by one blank line; an emoji at the start of a line acts as its bullet; numbered lists use keycap emojis `1️⃣…9️⃣` (then `10-`). Bold only the facts that matter (name, lesson, deadline, %, score).
  - Keep every rendered message ≤ 1200 characters (URL length limits).
  - **Manual device test (Chunk 4):** send each default template to a real phone (Android and iPhone) and confirm that bold works around Arabic text and around the isolate characters. If bold breaks, add a `bidi_isolates` setting that turns the isolates off for bold runs, and report it.
  - The in-app preview renders `*bold*` / `_italic_` and emojis, so the owner sees it as WhatsApp will.
- Link: `https://wa.me/<digits>?text=<encodeURIComponent(message)>`, built as a real `<a target="_blank" rel="noopener">` (works with long-press on phones).
- Group messages have no link (WhatsApp can't deep-link a group): **Copy** button (`navigator.clipboard`, fallback `execCommand`).

### 4.4 Placeholders (all templates)
`{student_name}` (display name), `{student_first_name}`, `{group}`, `{lesson}` (the lesson of the template's role — **current lesson for session templates, the homework & quiz lesson for homework/quiz templates**; slug prettified: hyphens → spaces), `{lesson_slug}` (raw slug), `{lesson_current}`, `{lesson_review}` (first review lesson), `{watch_pct}`, `{score}`, `{total}`, `{quiz_pct}`, `{hw_deadline}` / `{watch_deadline}` (d/m), `{deadline_when}`, `{session_when}`, `{group_note}`, `{hw_list}` (numbered lines, one per **homework & quiz lesson** with an assignment), `{watch_list}` (same for the current lesson's session watch), `{parents_contacted_line}` (renders only when the group flag is on), `{issues}` (combined only; joined `line_*` snippets).

### 4.5 Default templates (Egyptian Arabic, gender-neutral, WhatsApp-formatted — Chunk 4 owns the file)
Style rules: a header block, one idea per block, `*bold*` on the key facts, an emoji opening most lines, a warm closing line. `{H}` is the shared editable `header` key, expanded at render time.

`header`:
```
السلام عليكم 👋

مع حضرتك *فريق الدعم لبشمهندس عز نصر* في مادة البرمجة 💻

```
`session_unwatched` (lesson = current lesson):
```
{H}كنا بنتواصل مع حضرتك عشان نبلغك إن حصة 📚 *{lesson}* لم تُشاهَد من *{student_name}* حتى الآن ⏳

⚠️ الحصة مهمة وداخلة في *امتحان الشهر الحالي*، فضلًا عن كونها في *الامتحان الأسبوعي* لكل حصة.

🎯 مهم جدًا إنهم يتفرجوا على الحصة في أسرع وقت، عشان يكون عندهم وقت كافي يستفسروا ويطبقوا على الدرس قبل الحصة الجاية.

💬 ولو عندهم أي سؤال في المنصة أو المادة العلمية، إحنا موجودين دايمًا علشان نساعدهم 🌷
```
`session_unfinished`: same shape; first block → `كنا بنتواصل مع حضرتك عشان نبلغك إن مشاهدة *{student_name}* لحصة 📚 *{lesson}* لسه ما اكتملتش ▶️ (اتشاف منها *{watch_pct}%* بس)`; «يتفرجوا على الحصة» → «يكمّلوا الحصة».
`session_done` (praise):
```
{H}✅ حابين نطمّن حضرتك إن مشاهدة *{student_name}* لحصة 📚 *{lesson}* اتمّت بالكامل

🌟 الالتزام ده بيفرق جدًا في المستوى، وشكرًا لحضرتك على المتابعة 🌷
```
`homework_missing` (lesson = homework & quiz lesson):
```
{H}📝 حابين نفكّر حضرتك إن واجب *{lesson}* لسه ماتسلّمش على المنصة من *{student_name}*

⏰ آخر معاد للتسليم: *{deadline_when}*

🎯 مهم جدًا إنهم يسلّموه في معاده عشان نقدر نراجعه معاهم قبل الحصة الجاية.

💬 ولو في أي مشكلة في المنصة أو في حل الواجب، إحنا موجودين دايمًا علشان نساعدهم 🌷
```
`homework_done` (praise):
```
{H}✅ حابين نطمّن حضرتك إن واجب *{lesson}* اتسلّم على المنصة من *{student_name}*

🌟 شكرًا لحضرتك على المتابعة، وبنتمنى لهم دايمًا التوفيق 🌷
```
`quiz_mark`:
```
{H}📊 نتيجة *{student_name}* في كويز *{lesson}*:

🎯 *{score} من {total}* ({quiz_pct}%)

💬 ولو في أي استفسار عن النتيجة أو الأسئلة، إحنا موجودين دايمًا علشان نساعدهم 🌷
```
`quiz_praise` (≥ 90 %):
```
{H}👏 ما شاء الله! نتيجة *{student_name}* في كويز *{lesson}* هي *{score} من {total}* ({quiz_pct}%)

🌟 مستوى ممتاز، وشكرًا لحضرتك على المتابعة 🌷
```
`quiz_absent`:
```
{H}⚠️ حابين ننبّه حضرتك إن كويز *{lesson}* لسه ماتحلّش من *{student_name}*، ولازم *يتعوّض* في أقرب وقت.

📚 الكويز ده مهم لمراجعة الحصة قبل الحصة الجاية.

💬 ولو في أي مشكلة في الدخول عليه، إحنا موجودين دايمًا علشان نساعدهم 🌷
```
`line_session_unwatched`: `▶️ حصة *{lesson}*: لم تُشاهَد حتى الآن`
`line_session_unfinished`: `▶️ حصة *{lesson}*: المشاهدة لم تكتمل (*{watch_pct}%* بس)`
`line_homework_missing`: `📝 واجب *{lesson}*: لم يتم تسليمه على المنصة`
`line_quiz_absent`: `❓ كويز *{lesson}*: لم يتم حله — ولازم *يتعوّض*`
`combined` (each `line_*` uses its own lesson — see §4.2):
```
{H}كنا بنتواصل مع حضرتك عشان نبلغك بالآتي بخصوص *{student_name}* 📌

{issues}

🎯 مهم جدًا إنهم يلحقوا كل ده في أقرب وقت عشان يكون عندهم وقت كافي يستفسروا ويطبقوا قبل الحصة الجاية.

💬 ولو عندهم أي سؤال في المنصة أو المادة العلمية، إحنا موجودين دايمًا علشان نساعدهم 🌷
```
`group_reminder` (template 4, adapted from the owner's own message):
```
السلام عليكم 👋

📣 *تذكير مهم*

من فضلكم نسلّم الواجب على المنصة ✍️

{hw_list}

{parents_contacted_line}

⏰ *{deadline_when} آخر معاد* لتسليم الواجبات بإذن الله، وبعدها هيتم التواصل مع أولياء الأمور 🙏
```
`{hw_list}` renders e.g. `1️⃣ نتأكد من تسليم واجب *{lesson}*` per homework & quiz lesson. `{parents_contacted_line}` renders `📞 تم التواصل مع أولياء أمور الطلاب اللي ماخلّصوش الحصة لحد دلوقتي` only when the group flag is on, otherwise the whole line (and its blank line) disappears.

---

## 5. Chunks (independent; each lists what it owns)

Parallelism rule: **Chunk 1 is the only one that edits `Code.gs`.** Everything else mocks the API using the contract in §3 and the fixture below. Create `dashboard/_fixtures/followup-overview.json` **once**, from the §3.1 example (expand to ~3 groups, ~12 students incl. an unclassified one, a center student, a locked-video online student, a no-parent-phone student, an unmarked student; every group has a `current_lesson` (lesson 2) and a different `review_lessons` (lesson 1), and one group has two review lessons). Chunks 3 and 5 may each create it; if it exists, don't overwrite.

### 5.1 Chunk 1 — Backend (Apps Script)
**Owns:** `tools/quiz-maker-v2/apps_script/Code.gs`, `tools/quiz-maker-v2/apps_script/DEPLOY.md` (append a section), `tools/quiz-maker-v2/tests/test_followup.js`.
**Goal:** implement §3.1–§3.5 exactly (note the two lesson roles: `current_lesson` and `review_lessons`), and add the doc comment block describing the 4 new sheets near the top of `Code.gs` like the existing ones.
**Steps**
1. Add the four sheet header constants and lazy creators (`_sheetByName`).
2. `handleAdminFollowupOverview`: facts are produced for the **union of every group's `current_lesson` and `review_lessons`** (attendance + watch are only meaningful for current lessons, quiz + homework for review lessons, but return all that apply — it is cheap and keeps the client simple). Load Students, Groups (+ `GroupSettings`), Lessons, Videos, Quizzes, Entitlements, QuizAccess, Payments (for `_paymentStatuses`), Attendance, WatchProgress, QuizResults, Submissions, FollowupTemplates **once each**; build maps; compute `can_watch` / `quiz_open` in memory by mirroring `_scopeCovers` + the `_accessState` rules (expiry via `_ymdOf`, cancelled payments via `_paymentStatuses`). Latest quiz attempt per (student, lesson); homework submitted if any `Submissions` row matches. Use the slug+subject join (§1). **Do not call `_accessState` in a loop.**
3. Extend `_allLessonsFromGithub` to also return `has_quiz` and `has_assignment` per lesson (the tree already lists `quiz.html` / `assignment.html`); bump the cache key to `all_lessons_v2`; keep `handleAdminAccessOverview` working unchanged.
4. `handleAdminFollowupSetAttendance` with the exact grant/undo rules in §3.2 (new helper `_ensureAttendanceGrant` / `_removeAttendanceGrant`; **do not** reuse `_grantRaw`'s source overwrite or `handleAdminRevokeAccess`'s delete-all).
5. `handleAdminFollowupSaveGroup`, `handleAdminFollowupSaveTemplates`, `handleRecordWatch` (student session, max-merge, throttle).
6. Register the five `case`s in `doPost`.
**Tests** (copy `harness.js` style): center grant creates both rows with `source:"attendance"`; center does not touch an existing paid/group/`*` entitlement; switching to online removes only `attendance` rows; paid row survives; unmarked → `attendance:null`; overview `can_watch` correct for open/locked/entitled/expired/cancelled-payment; watch pct only increases; locked-video watch ignored; non-admin gets "Not authorized."; overview stays fast with 300 students × 10 lessons (count Sheet reads).
**Done when** all tests pass and a sample overview JSON validates against §3.1.

### 5.2 Chunk 2 — Watch tracker (video.js)
**Owns:** `tools/quiz-maker-v2/assets_templates/video.js` and (mirrored/synced per the repo's procedure) `assets/video.js`; new `tools/quiz-maker-v2/tests/test_watch_tracker.js`.
**Goal:** report real viewing progress of the **`lesson`-slot** video to `record_watch` (§3.5).
**Design**
- Only for `info.kind === "lesson"` and only when `getSession()` is a signed-in student (not admin).
- Track **distinct coverage**, not elapsed time: split the duration into 5-second buckets; while `playerState === 1` mark the current bucket(s) covered from `currentTime` updates (ignore jumps > 6 s between consecutive updates so seeking to the end doesn't count). `pct = covered / totalBuckets × 100`.
- Persist covered buckets in `localStorage` (`vp-cov:<student>:<lesson>`, wrapped in try/catch) so refreshes don't lose progress.
- Send `record_watch` via the existing `call()`: at most every 20 s while playing, on pause, on `visibilitychange→hidden`, and on `pagehide` (use `fetch(..., {keepalive:true})`; fall back silently). Only send when `pct` increased by ≥ 1.
- Never block or break the player if the call fails; no UI changes.
**Tests:** simulated `infoDelivery` stream: linear play → ~100 %; skipping to the end → low %; pause/resume; refresh restores coverage; throttling.
**Done when** `check_asset_drift.py` is clean after sync and the tests pass.

### 5.3 Chunk 3 — Status logic library (pure)
**Owns:** `assets/followup-logic.js` (UMD: `window.FollowupLogic` in browsers, `module.exports` in Node), `tools/quiz-maker-v2/tests/test_followup_logic.js`, `dashboard/_fixtures/followup-overview.json` (see above).
**Goal:** implement §4.1 and §4.2 as pure functions with no DOM and no network:
`phoneKey`, `nextSession`, `groupDeadlines(group.settings, now)`, `deadlineState`, `deadlineWhen`, `studentVerdicts(student, groupSettings, overview, now)` → `{session: {lesson, state}, homework: [{lesson, state}], quiz: [{lesson, state}]}` using the **two lesson roles** (§4.2: session from `current_lesson`; homework + quiz from each `review_lessons` entry), `studentSummary(student, group, overview)` → `{verdicts, issues[], praises[], needsAttendance, microChips[], primaryAction}` (`microChips` = the 4 collapsed-row chips of §4.2, each `{key, label, tone}`), `groupSummary(group, overview)` → counts (unmarked, unwatched, hw missing, quiz absent), `checkParentPhone`, `waDigits`.
Time handling must use `Intl.DateTimeFormat` with `timeZone:"Africa/Cairo"` (no reliance on the browser's zone). Test around midnight and the DST change.
**Done when** the tests cover every verdict in §4.2 using the fixture (including a student whose lesson-2 attendance is center while lesson-1 quiz is absent, and one with both roles on the same lesson), plus deadline edge cases (session today before/after its time; weekday wrap; override).

### 5.4 Chunk 4 — Messages & templates
**Owns:** `assets/followup-templates.js` (UMD: `window.FollowupTemplates`), `assets/followup-templates.css` (small, scoped to the editor), `tools/quiz-maker-v2/tests/test_followup_templates.js`.
**Goal:** §4.3–§4.5.
**API**
- `DEFAULTS` (every key in §4.5, including `header`), `PLACEHOLDERS` (name → description in Arabic and English, for the editor chips).
- `buildContext({student, group, lesson, verdict, facts, deadlines, now})` → placeholder map.
- `render(body, ctx)` → `{text, missing:[...]}` with the empty-line and bidi rules.
- `compose(summary, kind, ctx)` → message text for `kind` ∈ single templates | `combined` | `group_reminder`. It picks the right lesson per template (§4.2), builds `{hw_list}` with keycap-emoji numbering, and applies the WhatsApp-formatting rules of §4.3 (markers outside isolates, stripped markup characters, ≤ 1200 chars).
- `formatPreview(text)` → safe HTML that shows `*bold*`, `_italic_` and line breaks like WhatsApp (escape everything else).
- `waLink(digits, text)`; `copyText(text)`.
- `mountEditor(el, {templates, defaults, sample, onSave})`: textarea per template (RTL, `dir="auto"`), tap-to-insert placeholder chips, **B / I / 😀 insert buttons** (wrap the selection in `*…*` / `_…_`, or insert an emoji), live preview via `formatPreview` using sample data, **Reset to default** per template, **Save** (calls `onSave({key: body|null})`). Phone-friendly: stacked layout, large controls.
**Done when** every default renders with the fixture context with no leftover `{…}`, no message exceeds 1200 characters, a student name containing `*` can't break the bold; bidi isolates present; empty optional lines vanish; the editor works in a 390 px viewport.

### 5.4b (Chunk 4 is also responsible for)
Reviewing the Arabic defaults once more for Egyptian-dialect naturalness, gender neutrality, emoji use (not more than one or two per block) and that every `*…*` pair is balanced, reporting any line it changed. It also writes `tools/quiz-maker-v2/tests/manual/whatsapp-format-check.md`: a short script for sending every template to a real phone and ticking off bold / emoji / Arabic rendering.

### 5.5 Chunk 5 — Page UI (phone-first)
**Owns:** `dashboard/followup.html`, `assets/followup.css`, `assets/followup-app.js`, `tools/quiz-maker-v2/tests/e2e_followup.py`.
**Depends on (by contract only):** `FollowupLogic` (§4, Chunk 3), `FollowupTemplates` (Chunk 4), the API (§3). Develop with `?mock=1`, which loads `dashboard/_fixtures/followup-overview.json` and fakes the write actions in memory. Real mode uses `AuthEngine.adminCall` exactly like `access.html` (same "Not authorized" handling, `noindex` meta, sign-in redirect).
**Visual reference:** the mockups in §8 (`ui-1` … `ui-6`, `feature-flow`). Follow their structure and states; exact colours/spacing may be refined.

**Design brief — deliberately different from the other dashboards**
- Own stylesheet (`followup.css`); reuse only `theme.css` colour tokens for dark mode. Base font 17–18 px, Arabic UI via Cairo (already used on the site). RTL-aware; message previews `dir="auto"`.
- Mobile-first, single column; ≥ 48 px tap targets; generous spacing; cards, not dense tables; works one-handed. Sticky horizontally-scrollable **group tabs** at the top (… + «طلاب غير مصنفين»).
- Status is **never colour-only** (icon + text + colour). Progress bars have numeric labels.

**Screen 1 — Group page (`ui-1`)** — everything about the selected group, top to bottom:
1. **Next-session card:** weekday/time with a countdown chip, and the two deadline chips: «ميعاد المشاهدة» and «ميعاد الواجب» (state: upcoming / today ⏰ / overdue ❗).
2. **Lesson-role card, role A «🎬 الحصة الحالية — حضور + مشاهدة»:** a lesson picker (slug, searchable dropdown of `all_lessons`) and lock chips for that lesson (الحصة / الفيديو / الكويز, 🔓 or 🔒). Saves to `current_lesson`.
3. **Lesson-role card, role B «📝 واجب وكويز — الحصة السابقة»:** a picker for one or more lessons (`＋ إضافة درس`), with the quiz lock chip per lesson. Saves to `review_lessons`.
4. Collapsible «ملاحظات الجروب» (notes), the «تم التواصل مع أولياء الأمور» switch, and optional deadline-override date fields.
5. Banner «⚠️ X طلاب لم يتم تحديد حضورهم» (tap → filters the list to those students).
6. Three stat tiles: لم يشاهدوا (current lesson) · واجب ناقص · غياب كويز (review lessons) — each tile is a filter for the list.
7. **Group actions:** «📣 رسالة تذكير للجروب» and «📋 نسخ أسماء اللي لسه ما سلّموش»; bulk attendance «الكل سنتر / الكل أونلاين» (confirm dialog).

**Screen 2 — Student list under the same group tab (`ui-2`, `ui-3`)**
- Directly below the actions, in the same scroll: header «الطلاب · N», a search box, and filter chips: الكل · متأخرين · بدون رقم ولي أمر · غير محدد الحضور.
- Each student is an **accordion row** (one open at a time; opening scrolls it into view; the open student survives a data refresh; deep link `#student=<phoneKey>`).
- **Collapsed row:** avatar, name, and the four micro-chips from §4.2 (attendance · watch · homework · quiz) plus the `⚠️ لا رقم ولي أمر` chip when needed. Chevron ⌄/⌃.
- **Expanded card** has, in order:
  1. **Section «🎬 الحصة الحالية · الدرس N»** — slug, the **attendance radio** (أونلاين | سنتر; saves immediately, optimistic UI + undo toast; «سنتر» shows the green «🔓 الفيديو والكويز مفتوحين مجانًا» chip), and the **watch progress bar** with the number and the 80 % target (center students: «المشاهدة اختيارية»; locked: «🔒 الفيديو مقفول»; no tracking data: «لا توجد بيانات»).
  2. **Section «📝 واجب وكويز · الدرس M»** — slug(s); homework ✓ تم / ✕ لم يُسلَّم; quiz mark `٧ / ١٠`, or the **absent state**: a different colour and label «⚠️ غائب عن الكويز – تعويض» with a warning icon. With several review lessons, one sub-block per lesson.
  3. **Parent phone line** with ✓ or a warning banner when `checkParentPhone.level !== "ok"` (a missing number disables every message button for that student).
  4. **Message buttons:** one primary green button, «💬 رسالة مجمّعة لولي الأمر (N)» when there are ≥ 2 issues, otherwise the single message; below it the individual buttons (▶ المشاهدة · 📝 الواجب · ❓ الكويز) and the praise buttons (🌟 شكر على الواجب, 👏 كويز ممتاز, ✅ أنهى المشاهدة) where eligible. Buttons for issues that aren't due yet are muted «لسه بدري» but still tappable. Unmarked attendance disables the session button with «حدد الحضور أولًا».
- **Unclassified tab:** the same list, no group-level settings; a local (unsaved) «اعرض بحصص جروب ▾» selector supplies the two lesson roles.

**Screen 3 — Message sheet (`ui-4`)** — opens as a bottom sheet from any message button: title + recipient chip, the rendered message with **WhatsApp formatting and emojis shown as they will appear** (`formatPreview`), an editable textarea for a one-off tweak (not saved), the hint «النجمة * = خط عريض في واتساب», a big green **«فتح واتساب ↗»** (`<a href="https://wa.me/…">`), a **«📋 نسخ»** button, and «إغلاق». Shows a template warning if a placeholder is unknown.
**Screen 4 — Group reminder sheet (`ui-5`)** — same sheet without a link (WhatsApp can't deep-link groups): the filled template 4 (`{hw_list}` from the review lessons, `{deadline_when}`), a state chip «قبل الميعاد / النهارده / انتهى», **«📋 نسخ الرسالة»** and «📋 نسخ أسماء اللي لسه ما سلّموش (N)».
**Screen 5 — Templates (`ui-6`)** — header button opens `FollowupTemplates.mountEditor`: a tab per template, the RTL textarea, **B / I / 😀** insert buttons, tap-to-insert placeholder chips, live preview with a sample student, **حفظ** and **رجوع للأصلي**. Saves through `admin_followup_save_templates`.
**Everywhere:** loading skeletons, empty and error states, a refresh button with a «آخر تحديث» time, a visible warning if `lessons_error` / GitHub is down, and the messaging rules (§6) behind an ℹ️ button.

**Done when** Playwright at 390 × 844 and 1280 × 800 shows no horizontal scroll, tap targets ≥ 48 px, every §4.2 verdict renders from the fixture (including lesson-2 attendance beside lesson-1 quiz/homework), the accordion opens/closes one student at a time, the message sheet produces a correct `wa.me` URL with the formatted text URL-encoded, and dark mode is legible.

### 5.6 Chunk 6 — Integration, QA, deploy (runs after 1–5 merge)
**Owns:** nav link edits in `dashboard/master.html`, `dashboard/access.html`, `dashboard/student.html` (add a «متابعة» link to `followup.html`; students must not see it — mirror how `access` is shown to admins only), `Docs/FEATURES.md` + `Docs/PROJECT_OVERVIEW.md` (new section), `tools/quiz-maker-v2/tests/README.md`, a combined `DEPLOY_FOLLOWUP.md`.
**Steps**
1. Merge the chunks; run all new tests plus the existing suite (no regressions in `test_access.js`, `test_groups.js`, `test_videos.js`, `e2e_dashboard.py`).
2. Real-data dry run against a **copy** of the spreadsheet: check the slug+subject join on real `QuizResults` / `Submissions` rows, and report any unmatched rows.
3. End-to-end on a phone-sized viewport: mark center → both entitlements appear with `source: attendance`; mark online → they disappear; a paid entitlement is never touched.
4. Privacy review: no student or parent data in any committed file or fixture other than fake data; `noindex` on the page; page is unusable without an admin session.
5. Deployment checklist (write it into `DEPLOY_FOLLOWUP.md`):
   a. Paste the updated `Code.gs` into script.google.com → Deploy → Manage deployments → pencil → **New version** (**never** "New deployment").
   b. Open the dashboard once as admin: the four new tabs appear in the spreadsheet; confirm headers.
   c. Quiz Maker app → **Sync site assets** (bakes the endpoint into `video.js`), run `check_asset_drift.py`, commit, push, wait for Pages.
   d. Hard-refresh; watch a short lesson video as a test student and confirm a `WatchProgress` row appears.
   e. For each group set the weekday/time, the **current lesson** and the **homework & quiz lesson(s)**; mark attendance for the current lesson.
**Done when** the checklist is complete and the owner can send a real parent message from his phone.

---

## 6. Messaging rules (printed on the page's "ℹ️" help)

1. Send manually only — no bots, no unofficial WhatsApp automation (account-ban risk).
2. Don't send dozens of messages within minutes; space them out.
3. Avoid sending late at night (the send button may show a gentle "الوقت متأخر" hint after 10 pm Cairo).
4. Group reminder first; parent message only after the deadline.
5. Student and parent data stays behind the admin login; never paste real data into the repo.

---

## 7. Open items (none block the build)
- If the real `QuizResults.subject` values don't equal the first path segment of the lesson path, Chunk 1 reports the actual values and the join rule is adjusted in one place.
- Lesson wording uses the slug (as decided). If it reads badly in Arabic text later, add an optional Arabic label per lesson — a small follow-up, out of scope now.
- Watch history only exists from the day tracking ships (Chunk 2 deployed). A lesson taught before that has no `WatchProgress` rows, so every online student would look "unwatched". Suggested handling: the owner only sets the **current lesson** to lessons taught after deployment. The UI should show a small hint on any lesson where **no student** has a tracking row: «لا توجد بيانات مشاهدة لهذه الحصة بعد».

---

## 8. UI reference images (mockups with made-up data)
Give these to the Chunk 5 session (and Chunk 4 for the message look). Suggested location in the repo: `Docs/followup-ui/`.

| File | Shows |
|---|---|
| `ui-1-group-page.png` | Group page: session card, deadlines, the two lesson-role cards (current lesson / homework & quiz lesson), unmarked banner, stat tiles, group actions |
| `ui-2-student-list-expanded.png` | Student accordion: collapsed rows with micro-chips, one student expanded (lesson-2 attendance + watch, lesson-1 homework + quiz, parent phone, message buttons) |
| `ui-3-student-states.png` | Other states: center attendee with the quiz-absent state, unmarked, locked video, praise buttons |
| `ui-4-message-sheet.png` | Combined parent message with WhatsApp formatting and emojis, editable, open-WhatsApp / copy |
| `ui-5-group-reminder.png` | Template 4 group reminder (copy only) |
| `ui-6-template-editor.png` | Template editor with B / I / emoji buttons, placeholder chips, live preview |
| `ui-all-screens.png` | All six together |
| `feature-flow.png` | Data → status rules (incl. the two lesson roles) → what you tap |
