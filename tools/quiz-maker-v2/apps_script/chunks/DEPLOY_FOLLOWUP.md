# Follow-up dashboard — merge, QA and deploy

Covers everything in `Docs/IMPROVEMENT_PLAN.md` (Chunks 1–5). Do the sections in order.
Run commands from `tools/quiz-maker-v2/` unless a path says otherwise.

## 0. Files that make up the feature

| Chunk | Files |
|---|---|
| 1 Backend | `apps_script/Code.gs`, `apps_script/DEPLOY.md` (appended), `tests/test_followup.js` |
| 2 Watch tracker | `assets_templates/video.js` → synced to `assets/video.js`, `tests/test_watch_tracker.js` |
| 3 Status logic | `assets/followup-logic.js`, `tests/test_followup_logic.js`, `dashboard/_fixtures/followup-overview.json` |
| 4 Messages | `assets/followup-templates.js`, `assets/followup-templates.css`, `tests/test_followup_templates.js`, `tests/manual/whatsapp-format-check.md` |
| 5 Page UI | `dashboard/followup.html`, `assets/followup.css`, `assets/followup-app.js`, `tests/e2e_followup.py` |
| 6 Integration | nav link in `dashboard/master.html` and `dashboard/access.html`, `Docs/FEATURES.md`, `Docs/PROJECT_OVERVIEW.md`, `tests/README.md`, this file |

`dashboard/student.html` needs **no** link: an admin who opens it is redirected to
`master.html`, and a student must never see the follow-up page. The page itself is also
unusable without an admin session (the server re-checks `is_admin` on every call).

## 1. Merge checks (before touching production)

1. Merge the chunks. Only Chunk 1 edits `Code.gs`; only Chunk 3 or 5 creates the fixture
   (the existing file must not be overwritten).
2. Run everything:
   ```
   node tests/test_followup.js apps_script/Code.gs
   node tests/test_followup_logic.js
   node tests/test_followup_templates.js
   node tests/test_watch_tracker.js
   python tests/e2e_followup.py
   ```
   Then the existing suite — no regressions allowed in `test_access.js`, `test_groups.js`,
   `test_videos.js`, `test_revoke.js`, `test_quiz_gate.js` and `python tests/e2e_dashboard.py`.
   (Baseline before the merge: all existing node tests pass; e.g. `test_access.js` 97/97.)
3. `e2e_followup.py` prints a `NOTE using contract-shaped stand-ins…` line while a library
   file is missing. **That line must be gone before you deploy**: it means the page was
   tested against stand-ins, not the real Chunk 3 / Chunk 4 code.
4. Drift check: `python check_asset_drift.py` (after the Sync in §3c) must be clean.

### 1a. Where the page and the libraries must agree

The plan leaves a few library return shapes open. `assets/followup-app.js` isolates every
assumption in its `ADAPTERS` section. If a check in §1.2 fails after the merge, fix the
mismatch there (or in the library) — it is one place.

| Call | The page expects |
|---|---|
| `FollowupLogic.groupDeadlines(settings, now)` | `{session, watch, hw}` — each a `Date` or ISO string (the deadline instant; 23:59 Cairo) |
| `deadlineState(now, deadline)` / `deadlineWhen(now, deadline)` | `"upcoming" \| "today" \| "overdue"` / the Arabic phrase |
| `studentSummary(student, group, overview)` | `verdicts.session.state` ∈ `session_unwatched \| session_locked \| session_unfinished \| session_done \| optional \| needs_attendance`; `verdicts.homework[]` (`homework_done \| homework_missing`) and `verdicts.quiz[]` (`quiz_taken \| quiz_absent`), each `{lesson, state}`; plus `needsAttendance` and `microChips[{key,label,tone}]` |
| `checkParentPhone(parent, own)` | `{ok, level: "ok"\|"warn"\|"missing", reason, wa}` |
| `FollowupTemplates.compose(summary, kind, ctx)` | a string (or `{text, missing}`); saved template overrides arrive as `ctx.templates` (or via `setTemplates`/`setOverrides` if the library has one); for `combined` the page adds `summary.dueIssues = [{kind, lesson}]` |
| `buildContext({student, group, lesson, verdict, facts, deadlines, now})` | a placeholder map; `student` is `null` for the group reminder |
| `mountEditor(el, {templates, defaults, sample, onSave})` | `sample` is a placeholder map; `onSave({key: body\|null})` returns a promise |

`FollowupLogic.groupSummary` is not used by the page (tiles and filters are counted from
the per-student summaries so they always agree with the rows).

## 2. Real-data dry run — on a COPY of the spreadsheet

Never run this against the live sheet.

1. File → Make a copy of the spreadsheet. Point a throw-away Apps Script copy of `Code.gs`
   at it.
2. Call `admin_followup_overview` and check the **slug + subject join** (plan §1):
   - every `QuizResults.subject` value equals the first path segment of its lesson path
     (case-insensitive) — or Chunk 1 reports the real values and the join rule is changed
     in one place;
   - list the `QuizResults` / `Submissions` rows that match no lesson path, and any slug
     that exists in two tracks (these are flagged, never guessed);
   - spot-check five students: facts in the overview == what the Sheet shows.
3. Record the unmatched-row count and the subject values in the PR description.

## 3. Deploy checklist

a. **`Code.gs`:** paste the updated file into script.google.com → *Deploy → Manage
   deployments → pencil → **New version***. **Never "New deployment"** — that changes the
   `/exec` URL and breaks every baked endpoint.
b. Open `dashboard/followup.html` once as admin. The four new tabs appear in the
   spreadsheet (`Attendance`, `WatchProgress`, `GroupSettings`, `FollowupTemplates`);
   confirm their headers match plan §2.
c. Quiz Maker app → **Sync site assets** (bakes the endpoint into `video.js`), run
   `python check_asset_drift.py`, commit, push, wait for GitHub Pages.
d. Hard-refresh. As a **test student**, watch a short lesson video; confirm a
   `WatchProgress` row appears and `pct` only goes up.
e. For each group, on the follow-up page: set weekday/time (✏️ تعديل الميعاد), the
   **current lesson** and the **homework & quiz lesson(s)**, then mark attendance for the
   current lesson.
f. End-to-end on a phone-sized viewport:
   - mark a student **center** → `Entitlements` and `QuizAccess` rows with
     `source = attendance`; mark **online** → those two rows disappear;
   - a student with a **paid / manual / group** entitlement for that lesson: marking
     center, then online, leaves their row untouched;
   - tap a message button → WhatsApp opens with the text pre-filled.
g. Run `tests/manual/whatsapp-format-check.md` on a real Android phone **and** an iPhone
   (bold around Arabic text and around the bidi isolate characters). If bold breaks, turn
   isolates off for bold runs (`bidi_isolates` setting, Chunk 4) and note it.

## 4. Privacy review (tick before pushing)

- [ ] No real student or parent data in any committed file. The fixture
      `dashboard/_fixtures/followup-overview.json` uses made-up names and numbers only
      (`010/011/012/015 12345xxx`).
- [ ] `followup.html` has `<meta name="robots" content="noindex, nofollow">`;
      `robots.txt` already has `Disallow: /dashboard/`; the page is not in `sitemap.xml`.
- [ ] Without an admin session the page shows the sign-in gate and loads no data; a
      non-admin session is redirected to `student.html`.
- [ ] `?mock=1` only ever reads the fake fixture and writes nothing.

## 5. Things the owner should know

- **Watch history starts the day tracking ships.** A lesson taught earlier has no
  `WatchProgress` rows, so every online student would look "unwatched". Only set the
  **current lesson** to lessons taught after step 3d. The page shows «لا توجد بيانات
  مشاهدة لهذه الحصة بعد» when no student has a tracking row.
- **Move both lesson pickers forward after every session**, otherwise the new session's
  deadlines can look overdue.
- A parent message is *due* only **after** its deadline (end of the deadline day, 23:59
  Cairo); before that the button is muted «لسه بدري» but still tappable. Quiz-absent is
  always due. Unmarked attendance disables the session message; a blank parent number
  disables every message for that student.
- Send manually and spaced out; never late at night. Nothing here sends automatically.

## 6. Rollback

The feature is additive. To switch it off: remove the `followup.html` nav links (two
lines) or delete `dashboard/followup.html`. The four new sheet tabs and the new `Code.gs`
actions can stay; `record_watch` only writes `WatchProgress`. To revert the backend, deploy
the previous `Code.gs` as a **New version** (not a new deployment).
