# Quiz, Assignment & Attachment Maker — v2

Splits the old single-file `quiz_maker.py` into three tabs of one app,
sharing a site root and a Drive bridge config:

1. **Quiz Maker** — unchanged feature set: add/bulk-paste questions, save/
   load drafts, generate a lesson (`index.html` + `quiz.html` [+
   `assignment.html`]) and update the subject's lesson-card list.
2. **Assignment Maker** — bigger multi-line description box, and a
   submission-type dropdown: paste text / link / file upload / link-or-file.
3. **Attachment Maker** — upload a file straight into your own Drive folder
   and attach it to a lesson. Students see it embedded/downloadable on the
   lesson page — never a `drive.google.com` link.

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
  Drive folder you control and the lesson page renders it inline via
  `attachments.js`, proxied through the same Apps Script Web App.

## What this *isn't*

There's still no admin dashboard to browse submissions or scores in one
place — they land as timestamped JSON/files in your Drive Submissions
folder (see `Code.gs`), which you can open normally, or sort/search with
Drive's own search. If you want a real dashboard later, that's a
separate, bigger project (e.g. the FastAPI + SQLite approach discussed
earlier) — this Drive-bridge approach was chosen because it needs no
server, no hosting bill, and no deployment pipeline, matching where the
project actually is right now.

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
assets_templates/             quiz.js / assign.js / attachments.js — synced
                              into <site_root>/assets/ by "Sync site assets"
apps_script/
  Code.gs                    the Drive bridge — deploy this once
  DEPLOY.md                  step-by-step deployment
quiz_maker_config.json       site_root + Drive bridge URL/token (local only)
```
