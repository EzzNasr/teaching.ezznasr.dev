> **Status note (2026-10-30).** This is the original frozen spec from the first attendance build. Read it for the *design* (crypto, sheet tabs, API shapes, flag codes). Do **not** trust it for live values or file names:
> - Constants in section 1 are historical. `TICKET_SEC` is 90 here and was 90 in the deployed `ATT_C`, while `contract/att_config.js` says 180 (a mismatch the client hides by following the server's `expires_at`). The pending multi-user patches move it to 240 (see `Docs/04-archive/applied-patches/attendance-multiuser/ (outside the repo)`). Read `contract/att_config.js` (client) and `ATT_C` in `AttendanceAll.gs` (server) for current values.
> - The files named in sections 4 and 8 (`Attendance.gs`, `AttFlags.gs`, `AttTelegram.gs`) are stale. The deployed backend is the merged `AttendanceAll.gs`.
> - Section 6 says attendance reuses the payments bot. It does not: attendance has its own bot (`ATT_TG_*` properties).
> - Deploy steps: `deploy.md`.

# Attendance System — MASTER SPEC (frozen)

Site: `teaching.ezznasr.dev` · Pages: `/attend/` (student), `/attend/admin/` (projector + admin) · Backend: the existing Apps Script project (`Code.gs`) + new files `Attendance.gs`, `AttFlags.gs`, `AttTelegram.gs` · DB: Google Sheet.
Everything below is FROZEN. Sessions 1–4 may not change names, shapes, or constants. Anything unclear: implement the literal text, note it in your HANDOFF file, never improvise a new contract.

## 1. Constants (`att_config`)
| Name | Value |
|---|---|
| WINDOW_SEC | 10 (QR token window) |
| GRACE_SEC | 3 (accept previous window for first 3 s of the next) |
| TICKET_SEC | 90 |
| SESSION_MIN | 5 (check-in open for 5 min after start) |
| GEO_RADIUS_M | 100 (distance − accuracy) |
| GEO_WEAK_ACC_M | 150 |
| ID_REGEX | `^[0-9]{4,12}$` (ASSUMPTION: university ID format unknown; one constant to change) |
| NAME | optional at sign-up, max 60 chars |
| TZ | Africa/Cairo (display only; store UTC ISO) |
| TOKEN_LEN | 16 hex chars |

## 2. Crypto (frozen, must match client WebCrypto and Apps Script)
- `sessionKey = HMACSHA256(key=MASTER_SECRET, msg="key:"+sessionId)` → lowercase hex (64).
- `window = floor(serverEpochSec / 10)`.
- `token = HMACSHA256(key=sessionKey, msg=sessionId+":"+window)` → hex, first 16 chars.
- Server accepts `window`, or `window-1` only if `(epochSec % 10) < 3`.
- `ticket = base64url(JSON{s:sessionId,d:deviceId,e:expEpochSec}) + "." + HMACSHA256(MASTER_SECRET,"tk:"+s+":"+d+":"+e).slice(0,24)`.
- **Test vectors:** MASTER=`MASTER1`, sessionId=`S-TEST` → sessionKey=`30720e548ab67b904aaf2c32c6a98b7d7b4dcf1595213b25c93d1b1f5caa0eba`; window `170000000` → token=`a592d194c472b486`; ticket sig over `tk:S-TEST:DEV1:1700000090` = `41804657c2188b49246700f0`.
- Apps Script note: `Utilities.computeHmacSha256Signature` returns SIGNED bytes; convert with `(b+256)%256` before hex.
- The projector computes tokens in-browser with WebCrypto using `sessionKey` (returned once by `att_start_session` to the admin). The projector never calls the API for tokens.

## 3. Sheet tabs (exact headers, row 1)
- `AttStudents`: `student_id, name, device_id, created_at, status`
- `AttDevices`: `device_id, student_id, secret_hash, fp_hash, bound_at, status` (status: active|revoked)
- `AttRequests`: `req_id, student_id, new_device_id, new_secret_hash, new_fp_hash, fp_match, status, created_at, decided_at` (status: pending|approved|denied)
- `AttRooms`: `room_id, name, lat, lng, samples, calibrated_at`
- `AttSessions`: `session_id, course, room_id, start_utc, close_utc, status, hall_lat, hall_lng` (status: open|closed)
- `AttCheckins`: `checkin_id, session_id, student_id, device_id, server_utc, lat, lng, acc, dist_m, fp_hash, flags, status` (status: ok|review)
- `AttFlagLog`: `ts_utc, session_id, student_id, code, detail`
Secrets are never stored raw: `secret_hash = SHA-256 hex` of the 32-byte random device secret.

## 4. API (all POST JSON to the existing web-app URL, `action` field; responses `{ok:true,...}` or `{ok:false,error,code}`)
Student actions (no admin token):
- `att_ticket` `{session_id, token}` → `{ok, ticket, expires_at, close_utc, server_utc}` · errors: `TOKEN_EXPIRED`, `SESSION_CLOSED`, `NO_SESSION`
- `att_signup` `{ticket, student_id, name?, secret, fp, geo}` → `{ok, status:"registered"}` · errors: `BAD_ID`, `ID_TAKEN` (→ client routes to change-device), `DEVICE_BOUND_OTHER_ID` (detected), `TICKET_EXPIRED`
- `att_attend` `{ticket, student_id, secret, fp, geo}` → `{ok, status:"recorded", server_utc}` (flags are NEVER returned) · hard errors: `DEVICE_UNKNOWN`, `DEVICE_ID_CONFLICT`, `ID_BOUND_OTHER_DEVICE`, `TICKET_EXPIRED`, `SESSION_CLOSED`
- `att_change_device` `{ticket, student_id, new_secret, fp}` → `{ok, status:"pending", req_id}`
- `att_status` `{session_id}` → `{ok, close_utc, server_utc, status}`
- `geo` = `{lat,lng,acc}` or `{denied:true}`; `fp` = SHA-256 hex of `screen|tz|lang|hwConcurrency|webglRenderer`.
Admin actions (`token` = existing `ADMIN_TOKEN`):
- `att_start_session` `{token, course, room_id}` → `{ok, session_id, session_key, start_utc, close_utc}`
- `att_close_session` `{token, session_id}` → `{ok, summary:{present,flagged,pending}}`
- `att_live` `{token, session_id}` → `{ok, registered, present, flagged, pending, recent:[{student_id,server_utc,status}]}`
- `att_rooms` `{token}` → `{ok, rooms:[...]}` · `att_calibrate_room` `{token, name, samples:[{lat,lng,acc}]}` → `{ok, room}`
- `att_requests` `{token}` → `{ok, requests:[...]}` · `att_decide_request` `{token, req_id, decision:"approve"|"deny"}` → `{ok}`
- `att_flagged` `{token, session_id?}` → `{ok, rows:[...]}` · `att_export` `{token, session_id}` → `{ok, csv}`
Hook in `doPost`: one line `if (String(payload.action||"").indexOf("att_")===0) return _json(att_dispatch_(payload));` placed before the existing `switch`. That is the only edit to `Code.gs` besides the Telegram regex (§6).

## 5. Flags (silent unless marked)
`GEO_FAR` (dist−acc > 100) · `GEO_WEAK` (acc > 150, soft) · `GEO_DENIED` · `SAME_PHONE_MULTI_ID` (two IDs, same fp_hash, ≤10 m apart, ≤60 s) · `IDENTICAL_COORDS` (≥3 IDs, identical lat/lng/acc to 6 decimals) · `REPEATED` (student has ≥3 flagged checkins ever → status `review`). Hard blocks, shown to the student: `DEVICE_UNKNOWN`, `DEVICE_ID_CONFLICT`, `ID_BOUND_OTHER_DEVICE`. `ROUTINE_LAST_SECOND` is DROPPED. Status `review` when any flag except `GEO_WEAK` is present. A check-in with flags still returns "Attendance recorded".
Cross-file interface: `AttFlags.gs` exports `att_runFlags_(ctx) → string[]` where `ctx={session,student_id,device_id,fp,geo,serverUtc,hall:{lat,lng},priorCheckins}` (pure, no sheet writes). `AttTelegram.gs` exports `att_notify_(event, data)` with events `session_start|session_close|device_request|flag|digest` (never throws; call outside lock).

## 6. Telegram (reuses the existing bot/webhook)
`_notifyAdmin` and `handleTelegramUpdate` in `Code.gs` already work (secret in `?tg=`, admin-id check, `update_id` dedupe in CacheService, answerCallbackQuery first, editMessageText with verdict). Attendance adds callback prefixes `ad:<req_id>` (approve) and `dd:<req_id>` (deny), which do not collide with `ap:`/`rj:`.
Edit `handleTelegramUpdate` regex from `/^(ap|rj):(\S+)$/` to `/^(ap|rj|ad|dd):(\S+)$/`; if prefix is `ad`/`dd` call `att_decideFromTelegram_(reqId, approve)` instead of `handleAdminDecidePayment`. Flag alerts are batched into one digest per ~30 s via CacheService + a time-driven trigger (`att_flushDigest`).

## 7. Data rules
Time = `new Date()` on server only. Device secret stored in localStorage + cookie + IndexedDB (key `att_dev`). Approval revokes old device row, activates the new. Squatting mitigation: sign-up needs a live ticket.

## 8. Deliverables and ownership
| Session | Owns (files, only these) | Hand-off file |
|---|---|---|
| 1 Backend core | `Attendance.gs`, `AttSetup.gs` (creates tabs, Script Props) | `HANDOFF-1.md` |
| 2 Flags + Telegram | `AttFlags.gs`, `AttTelegram.gs`, `tests/flags.test.js` | `HANDOFF-2.md` |
| 3 Student page | `attend/index.html`, `attend/attend.js`, `attend/attend.css` | `HANDOFF-3.md` |
| 4 Admin/projector | `attend/admin/index.html`, `admin.js`, `admin.css` | `HANDOFF-4.md` |
| 5 Integration | merges all, edits `Code.gs` (hook + regex), runs checklist | `INTEGRATION-REPORT.md` |

Shared frozen files (all sessions import, none edit): `contract/att_config.js`, `contract/att_api.js` (client `call(action,payload)` with retry: 3 tries, jittered 300–900 ms), `contract/mock_fetch.js` (in-memory fake backend implementing §4 so pages can be built without Apps Script).
Time budget: S1 8–10 h, S2 5–6 h, S3 5–6 h, S4 7–9 h, S5 4–5 h. Sessions 1–4 run in parallel; 5 starts when all HANDOFFs exist.
