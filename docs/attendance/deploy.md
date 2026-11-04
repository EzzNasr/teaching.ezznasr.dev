# Attendance: deploy checklist (Apps Script + site)

> **Live now (2026-11-04):** Apps Script **Version 61** of the one existing deployment (same `/exec` URL as `contract/att_config.js`),
> with `AttendanceAll.gs` = repo commit `3a459e2` (manual entry, D9). Rollback: Deploy > Manage deployments > Edit > **Version 60**.
> Every deploy is recorded in [decisions.md](decisions.md) section 3. Since `3a459e2` the repo copy of `AttendanceAll.gs` differs
> from Version 61 **in comments only** (doc paths); it goes live with the next deploy.
>
> **Every attendance deploy, in this order** (the backend first: a new page calling an old backend gets `UNKNOWN_ACTION`):
> 1. Gate green: `bash scripts/test_all.sh --strict --e2e --require-all`.
> 2. Apps Script editor: replace `AttendanceAll.gs` with the repo file (only the files that changed). Save.
> 3. Run `att_selfTest()` (ALL PASS) and `att_scriptedRun()` (ALL PASS), then `att_cleanupTest()`.
> 4. **Deploy > Manage deployments > pencil > Version: New version > Deploy.** Never "New deployment".
> 5. Add a row to [decisions.md](decisions.md) section 3 (version, commit, what changed, rollback version).
> 6. Push the site (`git push origin main`), wait for the Pages build, hard-refresh `/attend/` and `/attend/admin/`.
> 7. After changes to the check-in path: the load test, see [load-testing.md](load-testing.md).
>
> The rest of this page is the first-time setup and the real-device checklist.

*Rewritten 2026-10-30. The previous version described four separate files (`AttSetup.gs`, `Attendance.gs`, `AttFlags.gs`, `AttTelegram.gs`) and a fallback to the payments bot. Both are out of date: the deployed backend is the single merged file `AttendanceAll.gs`, and attendance uses its **own** Telegram bot.*

Checked against `tools/quiz-maker-v2/apps_script/AttendanceAll.gs` and `Code.gs` in the repo snapshot. Not run in a real Apps Script project.

## Files
- **Deploy:** `Code.gs` plus `AttendanceAll.gs` (as its own file in the Apps Script project).
- **Do not deploy:** `apps_script/chunks/Att*.gs` and `chunks/Attendance.gs`. They are stale leftovers.
- `Code.gs` calls `att_route_(e, payload)` (defined in `AttendanceAll.gs`) near the top of its request handling, so every `att_*` action and the attendance bot webhook reach the attendance code.

## Steps
1. Paste or replace `Code.gs`, and add `AttendanceAll.gs`. Delete `AttStubs.gs` if it still exists.
2. Run `att_setup()` once. It creates the attendance tabs and the `ATT_MASTER_SECRET` Script Property. (For a standalone project, `att_setup("<spreadsheetId>")`.)
3. Run `att_selfTest()`. Expect `ALL PASS`. Optionally run `att_scriptedRun()`, then `att_cleanupTest()` to remove its test rows.
4. **Telegram (optional, own bot):**
   - Create a bot with @BotFather. Set Script Properties `ATT_TG_BOT_TOKEN` and `ATT_TG_ADMIN_IDS` (comma-separated chat IDs).
   - Run `att_setupTelegram()` (creates `ATT_TG_SECRET`, tells you what is still missing), then `att_setWebhook()`.
   - The attendance bot never uses the payments bot (`TELEGRAM_BOT_TOKEN` / `TELEGRAM_ADMIN_CHAT_ID`).
5. Authorise any new scopes when prompted (external requests, and `script.scriptapp` for the 30 s flag digest; without the latter, flag alerts are sent immediately instead of batched).
6. **Deploy, Manage deployments, pencil, Version: New version, Deploy.** Never choose "New deployment": it creates a new `/exec` URL and breaks every URL baked into the shipped JS.
7. Verify: `bash scripts/test_all.sh --strict`, then one real scan from a phone: new ID, "First time here?", name, Sign up, "Attendance recorded".
8. Load check after deploying: `att_loadTest()` (70 at once) and `att_loadTestFirstDay()`, then `att_cleanupTest()`. Results and how to read them: [load-testing.md](load-testing.md).

## Multi-user (teacher accounts): already in the repo code
The student page (S1), backend with accounts (S2, inside `AttendanceAll.gs`) and role-aware dashboard (S3) are in the repo. `AttUsers.gs` was merged into `AttendanceAll.gs`: the Apps Script project is still just **two files**.
1. Paste `Code.gs` and `AttendanceAll.gs`, then run **`att_migrate()`** once (safe to re-run: adds the new columns at the end of the existing tabs, creates `AttUsers`, labels old rows as owned by `ADMIN`). Then `att_selfTest()` -> `ALL PASS`, and step 6 (New version).
2. Publish the site. In `attend/admin/` sign in with the **admin token** -> **Users** -> create the first teacher -> copy the password (shown once).
3. In a private window sign in as that teacher: only their own sessions are visible.
- Rollback: deploy the previous Apps Script version. New columns and `AttUsers` are additive and harmless to old code; teacher accounts stop working on the old version, the admin token keeps working.
- Wrong passwords share ONE lock-out (10 failures / 5 min -> 5 min pause); pasting the admin token never counts. Disabling a teacher takes effect within about a minute.
- `attend/` is `noindex` and `Disallow`ed in `robots.txt` (done in `tools/seo/seo_build.py`).
- Gate: `bash scripts/test_all.sh --e2e` (R-A01..R-A08; R-A08 runs two teachers in real Chromium).

## 6. Real-device checklist (cannot be automated, do it once after publishing)
Use a QR from a live session; one phone per row. Expected result in the last column.

| # | Device / situation | Do | Expect |
|---|---|---|---|
| 1 | iPhone, Safari | Scan; tap **Allow location**; allow | Form appears; save -> "Attendance recorded" with time |
| 2 | iPhone, Safari | Scan; tap Allow; choose **Don't allow** | "Location is blocked" with the iOS steps (aA > Website Settings). After 2 tries "Continue without location" appears |
| 3 | iPhone | Follow the steps to re-enable; return to the page | Continues by itself (or asks to rescan if the QR expired) |
| 4 | Android, Chrome | Scan; allow | Same as 1 |
| 5 | Android, Chrome | Block, then lock icon -> Permissions -> Location -> Allow | Gate continues; if the page reloaded, rescan |
| 6 | In-app browser (Telegram / WhatsApp / Facebook) | Scan from inside the app | Page works, or the gate tells the student to open it in Chrome / Safari |
| 7 | Any | Dismiss the permission prompt (tap outside) | Gate stays, button still works, no crash |
| 8 | Any | Switch on airplane mode, then Save | "Not saved yet" + Retry; reconnect, Retry -> recorded once |
| 9 | Any | Start saving and try to close/refresh the tab | Browser asks to confirm; overlay says "Don't close this page" |
| 10 | Offline student who signed up, later online | Check in without location, then scan again with location on (same session) | Second attempt upgrades the same record (History shows one row, location filled) |
| 11 | Teacher phone | Sign in with password; open History | Only own sessions; open one; Accept a flagged check-in |
| 12 | Admin | Disable a teacher while they are signed in | Their next tap signs them out with "This account is disabled" |

Related: [original spec](original-spec.md), [TESTING.md](../TESTING.md), [decisions.md](decisions.md), [demo-data.md](demo-data.md).
