# Staging backend: one-time setup

*Written 2026-11-16 for refactor Phase 3 (step 3.0). Not done yet. A second Apps Script project with its own empty
sheets and demo data, so backend changes run in the real Apps Script runtime before they reach the live site. Nothing
here touches the live project, sheets or URL.*

## Rules

- **Never copy the live spreadsheets.** They hold students' names and phone numbers. Staging starts from empty sheets;
  the setup functions create the tabs and the seed functions fill them with made-up people.
- **No triggers, no Telegram bot, no WhatsApp** in staging unless a step needs one, and then only a test bot.
- **Every ID and secret is different from live.** Staging never gets the live admin password or bot token.
- Staging IDs and secrets go in Script Properties only, never in the repo. The staging script ID and deployment id
  (not secret, like the live ones in `apps_script/deploy.json`) go in `apps_script/deploy.staging.json`.

## Part 1: the owner, in the Google account (about 20 minutes)

1. **Drive folder.** Create a folder `TeachingSite STAGING`. Everything below goes inside it.
2. **Three empty spreadsheets:** `Staging Students`, `Staging Data`, `Staging Attendance`. Leave them empty.
3. **Five empty Drive folders:** `attachments`, `submissions`, `quiz-results`, `written`, `backups`.
4. **The project.** <https://script.google.com> > *New project*, name it `TeachingSite STAGING`. Leave the default
   `Code.gs` as it is (the first scripted push replaces it).
5. **Script Properties** (*Project Settings* > *Script Properties*), each ID copied from the address bar of the item
   (the long part between `/d/` and `/edit`, or after `/folders/`):

   | Property | Value |
   |---|---|
   | `STUDENTS_SHEET_ID` | `Staging Students` |
   | `DATA_SHEET_ID` | `Staging Data` |
   | `ATT_SHEET_ID` | `Staging Attendance`. **Required**: without it attendance falls back to the live sheet |
   | `ATTACHMENTS_FOLDER_ID` | `attachments` |
   | `SUBMISSIONS_FOLDER_ID` | `submissions` |
   | `QUIZ_RESULTS_FOLDER_ID` | `quiz-results` |
   | `WRITTEN_FOLDER_ID` | `written` |
   | `BACKUPS_FOLDER_ID` | `backups` |
   | `ADMIN_TOKEN` | a new random password, **not** the live one |
   | `WA_MODE` | `off` |

   Leave out `TELEGRAM_*`, `GITHUB_TOKEN`, `WA_SENDER_TOKEN` and `WA_TEST_TO`. `ATT_MASTER_SECRET` is created by
   `att_setup`. `ATT_WEBAPP_URL` is set in Part 2, once staging has its own URL.
6. **Send Claude the script ID** (*Project Settings* > *IDs*). It is not a secret, but send nothing else from this
   page.

## Part 2: together, at a quiet time (about 20 minutes)

Claude prepares this in the repo first; the owner is present for every step that touches Google.

1. `deploy_backend.js --target staging` reads `apps_script/deploy.staging.json` (script ID; push order and file names
   as in `deploy.json`). Staging has no drift check against live and may be pushed at any time, because it has no
   triggers.
2. First push to staging. The owner opens the staging editor, runs `setupSheets` once and accepts Google's permission
   prompt (the same scopes as live, from `apps_script/appsscript.json`).
3. *Deploy* > *New deployment* > *Web app*, the same settings as live (execute as me, anyone can access). Its id goes in
   `deploy.staging.json`; its `/exec` URL goes in the Script Property `ATT_WEBAPP_URL`.
4. In the staging editor: `att_setup()` (tabs and secret, on `ATT_SHEET_ID`), `att_seedDemo()` (demo attendance), then
   `seedDemoPortal()` (new: demo students, groups, lessons, results) and `p3_setup_enable_followup_flags()`.
5. `node scripts/smoke_live.js <staging /exec URL>`: all read-only checks green.
6. Pages opened with `?env=staging` call staging instead of live (deferred step 2.3). Default stays live.

## Undo

Staging is separate from live: delete the `TeachingSite STAGING` folder and project, and remove
`deploy.staging.json`. The live site is not affected either way.
