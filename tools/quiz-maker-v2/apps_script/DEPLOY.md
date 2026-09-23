# Deploying the Drive bridge

One Apps Script Web App, running under your own Google account. No billing,
no server to maintain — it's covered by your normal Google account quota.
`Code.gs` in this folder is the whole backend: uploads, student login /
register / password reset, and the dashboards.

## 1. Create the Drive folders and the Sheets

Three folders (anywhere in your Drive). Open each and copy the ID from the URL,
`drive.google.com/drive/folders/`**`THIS_PART`**:

| Folder | Holds |
|---|---|
| `Teaching / Attachments` | files you upload for students to view |
| `Teaching / Submissions` | student assignment files + a `--meta.json` per submission |
| `Teaching / Quiz Results` | one `--quiz-result.json` per quiz attempt |

Two Google Sheets (copy the ID from `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`):

| Sheet | Holds | Tabs |
|---|---|---|
| `Teaching / Students` (**credentials**) | logins only | `Students` — leave it empty, the header row is written on first use |
| `Teaching / Quiz Data` (**results**) | the big, ever-growing data | `QuizResults` and `Submissions` — created automatically; if you moved them by hand the names must be **exactly** these |

Keeping the two apart means a plain login only opens the small credentials
sheet. Share the credentials sheet with as few people as possible.

## 2. Create the script

- [script.google.com](https://script.google.com) → New project, paste in
  `apps_script/Code.gs`.
- Project Settings (gear) → Script Properties → add:

| Property | Value |
|---|---|
| `ATTACHMENTS_FOLDER_ID` | Attachments folder ID |
| `SUBMISSIONS_FOLDER_ID` | Submissions folder ID |
| `QUIZ_RESULTS_FOLDER_ID` | Quiz Results folder ID |
| `STUDENTS_SHEET_ID` | the credentials sheet ID |
| `DATA_SHEET_ID` | the quiz-data sheet ID (leave unset to keep everything in the credentials sheet) |
| `ADMIN_TOKEN` | a long random string (30+ characters). Guards attachment upload/delete only |

Two more properties appear by themselves — don't edit them: `STUDENTS_TAB_PIN`
(remembers which tab is "Students") and `BACKUPS_FOLDER_ID`.

## 3. Deploy

- Deploy → New deployment → **Web app** · Execute as **Me** · Who has access **Anyone**.
- Authorise the permissions prompt, copy the URL ending in `/exec`.

## 4. Wire it into the desktop tool

- `python3 app_main.py` → **Configure...** next to "Drive bridge".
- Paste the `/exec` URL and the **same** `ADMIN_TOKEN` you put in Script Properties
  (if they differ, uploads fail with "Not authorized").
- **Test connection**, then **Sync site assets** to bake the URL into
  `assets/*.js`.
- `quiz_maker_config.json` holds that token and is git-ignored. Copy
  `quiz_maker_config.example.json` to create it; never commit the real one.

## 5. One-time steps in the Apps Script editor

Function dropdown → **Run**, in this order (approve the permissions prompt the
first time):

1. `findPhoneCollisions` — read-only, compares old and new phone matching on your data.
2. `auditSheets` — read-only, lists cells Sheets already converted (numbers in names, formulas…).
3. `setupSheets` — formats the text columns. Safe to re-run.
4. `repairSheets` — backs up first, then turns numbers back into text and restores dropped phone zeros.
5. `installWeeklyBackupTrigger` — schedules a copy of both sheets every Sunday, keeps the last 4.

Then mark yourself admin: open the Students tab, put `TRUE` in the `is_admin`
cell of your own row. Nothing web-facing ever writes that column.

Later, if the sheets get messy: `previewDuplicates` (log only), `cleanEverything`,
or `fixEverything` (rebuilds missing rows from the Drive JSON files, backup first).

## 6. Redeploy after every edit to Code.gs

Web Apps don't update on save. Deploy → **Manage deployments** → pencil →
Version **New version** → Deploy. "New deployment" creates a *new URL* and every
page still pointing at the old one breaks.

## Passwords: what the system does

- The browser sends only a SHA-256 hash of the password (unsalted, and the phone
  number is not mixed in). The server compares hashes.
- **Student forgot it:** "Forgot password?" on the login step asks for the student's
  phone + the **parent's** phone. If the parent number on file matches (last 10
  digits) the password is replaced and the student is signed in. Five wrong parent
  numbers pause resets for that student for an hour.
- **No parent number on file** (or it equals the student's own): type the parent's
  number into the `parent_phone` cell of that row, then the link works.
- **Teacher-side reset with no parent number:** register a throwaway account with
  the password you want, copy its `password_hash` cell into the student's row,
  clear that row's `session_token`, then delete the throwaway row. Works because
  the hash depends only on the password.
- **Login limit:** 10 wrong passwords on one account pauses login for that account
  for 30 minutes. Forgot-password still works during the pause.
- Admin accounts can't use the parent-number reset — fix those by hand in the sheet.

## Notes

- Student submissions and quiz results need no token — same trust model as a Google
  Form. Attachment upload/delete require `ADMIN_TOKEN`.
- Attachments are shared as "anyone with the link can view" and the site links
  straight to Drive's own preview/download URLs. `doGet` no longer serves files.
  Files uploaded before that change must be shared manually once (Drive → Share →
  Anyone with the link → Viewer).
- Google quotas are far above what a class needs. `assign.js` caps file uploads at 15 MB.
