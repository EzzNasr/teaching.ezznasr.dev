# Quiz, Assignment & Attachment Maker — v2

Splits the old single-file `quiz_maker.py` into three tabs of one app,
sharing a site root and a Drive bridge config:

1. **Quiz Maker** — unchanged feature set: add/bulk-paste questions, save/
   load drafts, generate a lesson (`index.html` + `quiz.html` [+
   `assignment.html`]) and update the subject's lesson-card list.
2. **Assignment Maker** — bigger multi-line description box, and a
   submission-type dropdown: paste text / link / file upload / link-or-file.
3. **Attachment Maker** — upload a file straight into your own Drive folder
   and attach it to a lesson. Students see it on the lesson page
   (preview / open / download); the file is shared as "anyone with the link"
   and the page links straight to Drive's own viewer.

## Quick start

```
python3 app_main.py
```

Stdlib only (`tkinter`, `urllib`) — no `pip install` needed.

1. Point **Site location** (top of the window) at your local
   `teaching.ezznasr.dev` repo, same as before.
2. Build a lesson in **1. Quiz Maker**, same as the old tool.
3. For URL/file assignment submission or attachments, deploy the Drive
   bridge once — see `apps_script/DEPLOY.md` — then click **Configure...**
   next to "Drive bridge" and paste in the Web App URL + admin token.
4. Click **Sync site assets** to write the endpoint into
   `assets/quiz.js` / `assign.js` / `attachments.js` on the live site.
   **Edit shared scripts in `assets_templates/`, never directly in `assets/`** —
   Sync overwrites `assets/` from the templates (it now lists any file it is
   about to replace and asks first). `python check_asset_drift.py` shows any
   difference without changing anything.
5. Use **2. Assignment Maker** to set each lesson's submission mode, and
   **3. Attachment Maker** to upload files per lesson.

## What changed vs. the old tool

- **Quiz Maker**: identical behavior. The generated `quiz.html` now pulls
  in the v2 `quiz.js`, which remembers a student's *last attempt* per
  lesson in the browser (`localStorage`) and shows it on the start screen
  — the "it forgets on navigation" gap is fixed. Still per-browser,
  per-device; there's still no server-side gradebook (see below).
- **Assignment Maker** (new tab): the old assignment page only ever
  accepted pasted text, saved nowhere but the student's own browser. Now
  a lesson can require a link, a file (uploaded to your Drive via the
  Apps Script bridge), or either — and even the text mode still queues
  locally as a fallback if the bridge is unreachable.
- **Attachment Maker** (new tab): the old lesson page had a static
  "Coming soon" stamp with no way to add files. Now it uploads to a
  Drive folder you control (through the Apps Script bridge) and the lesson
  page renders it via `attachments.js`, linking to Drive's own viewer.
- **Video embeds:** every lesson page (`index.html`, `assignment.html`,
  `quiz.html`) has a shared `media-slot` box, now rendered client-side by
  `/assets/video.js` (wired into all three page templates) instead of
  being baked into the HTML as a raw `<iframe>`. Pasting a video URL in
  Quiz Maker / Assignment Maker registers it with the Drive bridge's
  Videos sheet (`common.set_lesson_video`) — new videos start **locked**,
  unlock them from `dashboard/access.html` once ready. If the Drive
  bridge isn't configured yet, it falls back to the old direct-iframe
  behavior (unprotected, but the app keeps working). Re-opening a lesson
  for editing reads the video URL back from the Videos sheet first,
  falling back to whatever's still baked into the page for
  legacy/not-yet-migrated lessons. **Already-generated lesson pages from
  before this change need `migrate_video_slots.py` run once** (see the
  entry in "Folder layout" below) — the template fix alone only affects
  lessons generated from now on.

## What this *isn't*

Results live in two places: every quiz attempt and submission is saved as a
JSON file in Drive (the durable copy) and mirrored as a row in the
QuizResults / Submissions sheet tabs, which feed `dashboard/student.html`
and `dashboard/master.html` (the admin view needs `is_admin = TRUE` on your
row of the Students tab). Login is phone + password with a parent-number
password reset — see `apps_script/DEPLOY.md`. There's no server or database;
everything runs on Apps Script + Google Sheets/Drive, so it is sized for a
class, not for thousands of students.

## Folder layout

```
app_main.py                  entry point — run this
modules/
  common.py                  site-root resolution, config, template loading
  drive_bridge.py            urllib client for the Apps Script Web App
  quiz_tab.py                Tab 1
  assignment_tab.py          Tab 2
  attachment_tab.py          Tab 3
templates/                   HTML templates (unchanged files + updated
                              assignment.html / lesson_index.html)
assets_templates/             auth.js / quiz.js / assign.js / attachments.js / video.js +
                              base.css / forms.css — synced into
                              <site_root>/assets/ by "Sync site assets"
check_asset_drift.py         compares assets_templates/ with the live assets/
                              (read-only; exit code 1 if they differ)
apps_script/
  Code.gs                    the Drive bridge — deploy this once
  DEPLOY.md                  step-by-step deployment
migrate_video_slots.py       one-off: migrates any lesson still using a raw baked-in video
                              <iframe> into the Videos sheet (locked) and retrofits the
                              /assets/video.js script tag onto already-generated lesson
                              pages. Dry-run by default; --apply to actually write/send.
quiz_maker_config.json       site_root + Drive bridge URL/token (local only, git-ignored;
                              copy quiz_maker_config.example.json to create it)
```
