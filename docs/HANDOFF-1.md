# HANDOFF-1 — Backend core (Session 1)

Files: `AttSetup.gs`, `Attendance.gs`, `AttStubs.gs` (temporary; **S5 deletes it**).
Status: written to MASTER-SPEC; **not yet executed in Apps Script** — run the three checks below before integration.

## Run order (in the Apps Script editor)
1. `att_setup()` (standalone project: `att_setup("<spreadsheetId>")`) → 7 tabs + `ATT_MASTER_SECRET`.
2. `att_selfTest()` → expect `ALL PASS` (vectors, ticket, grace window, calibration, CSV guard).
3. `att_scriptedRun()` → sign-up → attend → conflict → change device → approve → close. Then `att_cleanupTest()`.
4. Deploy a new web-app version, then `att_loadTest()` → 80 parallel `att_attend` via `fetchAll`; expect `PASS`. Then `att_cleanupTest()`.

## Function list
- Entry: `att_dispatch_(payload)` (routes all §4 actions; admin actions checked first; errors → `SERVER_ERROR`, details only in logs).
- Crypto: `att_hmacHex_`, `att_sha256Hex_`, `att_sessionKey_`, `att_token_`, `att_tokenOk_`, `att_makeTicket_`, `att_checkTicket_`.
- Student: `att_ticketAction_`, `att_signup_`, `att_attend_`, `att_changeDevice_`, `att_status_`.
- Admin: `att_startSession_`, `att_closeSession_`, `att_live_`, `att_rooms_`, `att_calibrateRoom_` (+ pure `att_average_`), `att_requests_`, `att_decideRequest_`, `att_flagged_`, `att_export_`.
- **For S5 / Code.gs Telegram branch:** `att_decideFromTelegram_(reqId, approve)` → returns `{ok, student_id, status}` or `{ok:false, code}` (`ALREADY_DECIDED`, `NO_REQUEST`). Not named as owned by anyone in §8; defined here.
- Tests: `att_selfTest`, `att_scriptedRun`, `att_loadTest`, `att_cleanupTest`.

## Script Properties
- `ATT_MASTER_SECRET` (created by `att_setup`, only if missing).
- `ATT_SHEET_ID` (optional; if absent uses the bound spreadsheet).
- `ADMIN_TOKEN` (existing; I read global `ADMIN_TOKEN` if `Code.gs` defines one, else this property).
- `ATT_LOADTEST_URL` (optional override of the web-app URL for `att_loadTest`).

## Deviations / interpretations (spec was silent — please review)
1. **Ticket `d` is `""`.** `att_ticket` receives no device id, so the ticket's device field is empty (sig msg `tk:<sid>::<exp>`). Test vector with `DEV1` passes.
2. **`expires_at` is epoch milliseconds**, matching `mock_fetch.js`. (Ticket's internal `e` is epoch seconds.)
3. **`secret_hash` = SHA-256 of the `secret` string as sent (UTF-8)**, not of decoded bytes. Clients must always send the same string form (suggest 64-char hex).
4. **Extra error codes** (not in §4): `UNAUTHORIZED`, `UNKNOWN_ACTION`, `SERVER_ERROR`, `BUSY` (lock timeout 25 s), `BAD_REQUEST`, `NO_ROOM`, `NO_REQUEST`, `ALREADY_DECIDED`, `UNKNOWN_STUDENT`, `DEVICE_ALREADY_ACTIVE`. S3/S4 should show a generic message for any unrecognised code. `BAD_ID` is also returned by `att_change_device`.
5. **`ID_BOUND_OTHER_DEVICE`** is returned when the secret belongs to a *revoked* device of that same student (old phone after an approved change). A secret that was never registered is `DEVICE_UNKNOWN`. `DEVICE_BOUND_OTHER_ID` (signup) also writes a flag-log row.
6. **"flagged" everywhere = check-ins with `status = review`** (so `GEO_WEAK` alone does not count). `att_flagged` returns only those rows (+ `name`).
7. **`room_id` optional** in `att_start_session`; with no room, `hall` is `null` in `ctx` and `dist_m` is empty. S2 must tolerate `hall: null`.
8. **`ctx.priorCheckins`** = all `AttCheckins` rows for this session **plus** all earlier rows of this student (any session), each as `{checkin_id,session_id,student_id,device_id,server_utc,lat,lng,acc,dist_m,fp_hash,flags:[…],status}` (numbers parsed, `flags` is an array). `ctx.geo` is `{lat,lng,acc}` or `{denied:true}` (malformed geo is treated as denied). `ctx.device_id` is the server-side device id.
9. **Priors are read outside the lock**; only the duplicate check + append are locked (per spec). Under a burst, `IDENTICAL_COORDS`/`SAME_PHONE_MULTI_ID` may miss rows written in the same instant (flags are best-effort; no check-in is ever lost).
10. **Notify payloads** (`att_notify_`): `session_start{session_id,course,room,start_utc,close_utc}`, `session_close{session_id,course,summary}`, `device_request{req_id,student_id,fp_match,session_id}`, `flag{session_id,student_id,flags[],status?,hard?}` (hard blocks arrive with `hard:true`). S1 writes `AttFlagLog` rows itself (soft flags + hard blocks); `digest` is S2's.
11. **All sheet columns are formatted as plain text** by `att_setup` (keeps ISO timestamps and leading-zero IDs). `fp_match` is stored as `"true"/"false"`; `att_requests` returns it as boolean and **omits `new_secret_hash`**.
12. `att_change_device` is idempotent per student (an existing pending request returns its `req_id`). Approving a request whose secret matches the student's own revoked device re-activates that row instead of duplicating it.
13. `att_export` columns: `student_id,name,server_utc,status,flags,dist_m,acc` (UTC; cells starting with `= + - @` are prefixed with `'`).
14. **`att_roster` (added after the spec, required by the admin Roster tab):** admin-only `{token, course?, limit?}` → `{ok, courses[], sessions[{session_id,start_utc,course}] oldest→newest (last `limit`, default 30, max 200), students[{student_id,name}] (all registered), marks[[session_id,student_id,server_utc,status]]}`.
15. `att_close_session` is idempotent; sets `close_utc` to the actual close time.

## For S5
- Delete `AttStubs.gs`; add the one-line hook and regex edit in `Code.gs`; the Telegram `ad:/dd:` branch calls `att_decideFromTelegram_`.
- Confirm how `Code.gs` stores `ADMIN_TOKEN` and which spreadsheet it uses (I assumed global const or Script Property, and bound sheet or `ATT_SHEET_ID`).
- Redeploy the web app before `att_loadTest()`.
