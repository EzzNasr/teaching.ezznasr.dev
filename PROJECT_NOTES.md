# Teaching Site Tooling — Architecture & Ops Notes

This covers three separate things that get worked on together but deploy
independently, which is the source of most bugs hit so far:

- **App** — the local Tkinter tool (`app_main.py` + `modules/`)
- **Site** — `teaching.ezznasr.dev`, a static site on GitHub Pages
- **Bridge** — `Code.gs`, an Apps Script Web App deployed separately on Google's infrastructure

None of the three share a deploy step. Editing one does nothing to the
others until you explicitly push/sync/redeploy it — see §4.

---

## 1. File structure

### App repo (runs locally, never deployed anywhere)

```
app_main.py                  entry point, top bar (site root + Drive bridge config), tab host
modules/
  common.py                  site-root resolution, config load/save, template loading, sync_site_assets()
  drive_bridge.py            urllib client for Code.gs (used by Attachment Maker + "Test connection")
  quiz_tab.py                Tab 1 — generates a lesson
  assignment_tab.py          Tab 2 — writes assignment.html for an existing lesson
  attachment_tab.py          Tab 3 — uploads a file to Drive, appends to attachments.json
templates/                   source HTML templates ({{PLACEHOLDER}} tokens)
  subject_index.html
  lesson_index.html
  lesson_card.html
  quiz.html
  assignment.html
assets_templates/            source JS ({{DRIVE_ENDPOINT}} token), synced into the site repo
  quiz.js
  assign.js
  attachments.js
apps_script/
  Code.gs                    source of truth for the bridge — NOT what's necessarily live, see §4
  DEPLOY.md
quiz_maker_config.json       local only: site_root path + drive_web_app_url + drive_admin_token
```

### Site repo (`site_root`, served by GitHub Pages)

```
CNAME
assets/
  quiz.js                    <- written by sync_site_assets(), DRIVE_ENDPOINT baked in
  assign.js                  <- written by sync_site_assets(), DRIVE_ENDPOINT baked in
  attachments.js             <- written by sync_site_assets()
<subject>/                   programming | english | math
  index.html                 <- generated from subject_index.html
  <lesson-slug>/
    index.html                <- generated from lesson_index.html
    quiz.html                 <- generated from quiz.html, quiz JSON inlined
    assignment.html            <- generated from assignment.html (only if the lesson has one)
    attachments.json           <- [{title, drive_file_id, type}, ...], written by Attachment Maker
```

### Apps Script project (lives only in script.google.com — not git-tracked anywhere)

Just `Code.gs`. Versioned through Apps Script's own Deploy dialog, not git.
`apps_script/Code.gs` in the app repo is a *copy* you paste in manually —
it is not automatically kept in sync with what's actually deployed.

---

## 2. Data flow

**Generating a lesson** (Quiz Maker tab) — writes `index.html` + `quiz.html`
(+ optionally `assignment.html`) into `<site_root>/<subject>/<lesson-slug>/`
from the templates, and updates the subject's lesson-card list.

**Adding an attachment** (Attachment Maker tab) → `drive_bridge.upload_attachment()`
→ `Code.gs` `upload_attachment` (token-gated) → file lands in
`ATTACHMENTS_FOLDER_ID`, gets `setSharing(ANYONE_WITH_LINK, VIEW)` →
`{title, drive_file_id, type}` appended to the lesson's local `attachments.json`.
On the live site, `attachments.js` fetches that JSON and links straight to
Drive's own `/preview` (iframe), `/view` (Open), and `uc?export=download`
(Download) URLs — no proxy in the loop anymore.

**Setting up an assignment** (Assignment Maker tab) — writes `assignment.html`
with the chosen submission mode (`text` / `url` / `file` / `both`) baked into
`data-mode`. On the live page, `assign.js` reads that attribute and renders
the matching form. Every submission is queued into the student's own
`localStorage` first (durability fallback), then POSTed to `Code.gs`
`upload_submission` (no token — public, same trust model as a Google Form).
Text-only submissions never attempt the Drive POST at all; url/file do.

**Taking a quiz** — `quiz.js` scores client-side, tracks each answer
(`question` / `chosen` / `correct_answer` / `is_correct`), and on finish:
queues locally, saves as the "last attempt" shown next time, and POSTs
`{score, total, wrong_questions}` to `Code.gs` `upload_quiz_result`
(no token). One JSON file per attempt lands in `QUIZ_RESULTS_FOLDER_ID`.

All three POST actions (`upload_submission`, `upload_quiz_result`, and the
non-token part of the bridge generally) run as whichever Google account the
Apps Script deployment's **Execute as** is set to — currently
`ezznasrone@gmail.com` — regardless of which account is signed in wherever
you're checking Drive.

---

## 3. Adding a new lesson / subject, end to end

1. Quiz Maker tab → pick subject, fill in questions, generate. Optionally
   fill in an assignment description + mode in Assignment Maker.
2. If it needs file/link submission or attachments, make sure the Drive
   bridge is configured and `Code.gs` is actually deployed and current
   (see §4 — don't assume it is).
3. Attachment Maker tab → upload any files for the lesson.
4. Commit + push the site repo. GitHub Pages/Fastly needs a few minutes to
   catch up even after a hard refresh.
5. Spot-check the live page in an incognito window (rules out stale
   browser cache/extensions muddying whether the push actually worked).

---

## 4. The three deploy surfaces (why "it didn't update" kept happening)

| Change | Where it lives until you act | What makes it live |
|---|---|---|
| Anything from the three tabs (generated HTML, `attachments.json`, synced `assets/*.js`) | Local disk, in the site repo working copy | `git add/commit/push`, then wait for Pages to rebuild |
| Edits to `Code.gs` | The script editor only | Deploy → Manage deployments → pencil → Version: **New version** → Deploy. Picking **New deployment** instead mints a new `/exec` URL and silently breaks every already-baked `DRIVE_ENDPOINT` until every JS asset is re-synced and re-pushed |
| Edits to the app itself (`app_main.py`, `modules/*`) | Just your local machine | Nothing to deploy — it's not hosted anywhere, only run locally |

Student-facing submissions (assignment/quiz) bypass the site repo entirely —
they go browser → Apps Script → Drive directly, live the instant a student
submits, independent of whatever state the git repo or GitHub Pages build
is in.

---

## 5. Gotchas hit so far (kept here so they don't get re-debugged from scratch)

- **"Load current settings" in Assignment Maker** resets the submission
  mode to "Paste text" if `assignment.html` doesn't exist yet for that
  lesson. Don't click it before the first `Update` on a brand-new lesson.
- **CORS preflight against Apps Script:** `fetch()` with
  `Content-Type: application/json` triggers a preflight `OPTIONS` request.
  Apps Script has no `doOptions()`, so the browser silently blocks the real
  POST — this surfaces as "couldn't reach the server" even when the
  endpoint is live and correct. Fix used everywhere: send
  `Content-Type: text/plain;charset=utf-8` instead; `doPost` already
  `JSON.parse`s the raw body regardless of declared type.
- **Silent failure by design:** `quiz.js`'s Drive POST is a bare
  `.catch(function(){})` — a genuine server error (stale deployment,
  unknown action, missing script property) looks identical to a network
  hiccup, and the student sees nothing wrong either way. Only visible via
  DevTools → Network → the `echo?...` request Apps Script redirects
  through → **Response** tab (not Headers — the interesting part is the
  JSON body).
- **That redirect is normal:** every Apps Script response comes back as a
  `302` to `script.googleusercontent.com/macros/echo?...` before the real
  body. Not an error on its own.
- **`doGet` no longer serves files** since the proxy rewrite — old
  `?action=file&id=...` links just return the health-check JSON forever
  now. Expected, not a regression, now that `attachments.js` links to
  `drive.google.com` directly.
- **Pre-rewrite attachments were never auto-shared.** `setSharing(...)`
  only runs on new uploads going forward; anything uploaded before that
  line existed needs its sharing set by hand once.
- **Wrong signed-in Google account looking at Drive.** Files always land
  under the deployment's "Execute as" account. An "empty" folder can just
  mean you're viewing Drive as a different account than the one the script
  runs as.
- **Stale content on exactly one Chrome profile, clean in incognito** —
  wasn't caching at all, it was uBlock Origin on that profile stripping/
  blocking content. Worth checking extensions before chasing cache-clearing
  further next time this shape of bug shows up.

---

## 6. Suggested next improvements

1. **Surface Drive-sync failures instead of swallowing them.** Replace
   `quiz.js`'s bare `.catch(function(){})` (and the ambiguous branch in
   `assign.js`) with a real error passed through to a small, low-key status
   line — so a failed submission is visible without opening DevTools.
2. **A "test all bridge actions" button** in the Configure dialog, not just
   `ping` — a dry run against each action (`upload_attachment`,
   `upload_submission`, `upload_quiz_result`) would catch a stale
   deployment before students hit it, not after.
3. **A push reminder in the status bar** after any local write — e.g.
   "assets/quiz.js, index.html changed — commit + push to go live." Nearly
   every bug in this thread except the CORS one and the uBlock one boiled
   down to assuming a local change was already live.
4. **A minimal read-only dashboard** for `SUBMISSIONS_FOLDER_ID` /
   `QUIZ_RESULTS_FOLDER_ID` — even just a Google Sheet fed by an Apps
   Script trigger. Right now checking grades means opening two Drive
   folders and reading raw JSON files one at a time.
5. **CSV export** for quiz results / submissions once there's enough
   volume that per-attempt JSON files stop being easy to eyeball.
6. **`clasp`** (Apps Script's CLI) to bring `Code.gs` under real git version
   control with scriptable deploys — would remove the manual
   "pencil → New version → Deploy" step that's caused most of the
   stale-deployment bugs so far.
7. **Dedupe the `el()` / `postToDrive()` helpers** duplicated across
   `quiz.js` and `assign.js`. Fine as-is for a static site with no build
   step, but worth pulling into a shared `assets/common.js` if a fourth
   engine gets added.
8. **Watch Drive file-count/volume** on `QUIZ_RESULTS_FOLDER_ID` over a
   full term — one JSON per attempt is fine now, just flagging it as the
   thing that'll eventually motivate #4/#5 rather than something urgent.
