# Attendance system

QR-code attendance for university lectures: the teacher shows a rotating QR code on the projector, students scan it with their
phone, the page checks their location and phone, and the check-in is stored in a Google Sheet. Teachers review anything
unusual on a dashboard.

| Page | For | URL |
|---|---|---|
| Student page | students' phones (opened by the QR code) | `/attend/?s=<session>&t=<token>` |
| Dashboard | teachers and the admin | `/attend/admin/` |

## Read next

| Doc | What it answers |
|---|---|
| [decisions.md](decisions.md) | What was decided and why (D1 to D14), the deploy record, open follow-ups (F#) |
| [deploy.md](deploy.md) | How to deploy (every time, and first-time setup), real-device checklist |
| [load-testing.md](load-testing.md) | Load test status report: results, limits, what is not tested yet |
| [live-testing-plan.md](live-testing-plan.md) | What to change before real students rely on it, and the pilot plan |
| [demo-data.md](demo-data.md) | Sample data for training and checking changes (`att_seedDemo` / `att_clearDemo`) |
| [screenshots/](screenshots/README.md) | What students and teachers see |
| [original-spec.md](original-spec.md) | The first frozen design (crypto, tabs, API shapes); historical values |

## Where the code is

| Part | Files |
|---|---|
| Student page | `attend/index.html`, `attend/attend.js`, `attend/attend.css` |
| Dashboard | `attend/admin/index.html`, `attend/admin/admin.js`, `attend/admin/token.js` (QR token), `attend/admin/qr.js` |
| Shared client config | `contract/att_config.js` (API URL, timings), `contract/att_api.js` (one `call(action, payload)`) |
| Backend | `tools/quiz-maker-v2/apps_script/AttendanceAll.gs` (one file in the same Apps Script project as `Code.gs`; `Code.gs` routes `att_*` to it) |
| Tests | `tests/attendance/` (R-A01 to R-A12 in `docs/REGRESSION.md`); `tests/attendance/gas_emulator.js` runs the real `.gs` in Node |

## How a check-in works

1. The dashboard starts a session (`att_start_session`) and draws a QR code whose token changes every 10 s (HMAC of the session key).
2. The phone opens the link and trades the token for a **ticket** (`att_ticket`), valid until the session closes.
3. The student passes the location step, then taps Save: `att_signup` (first time) and `att_attend`, with the ticket, the phone's
   secret (kept in the browser), a fingerprint and the location.
4. The server checks the ticket, the device binding, runs the flag rules, and appends one row to `AttCheckins` inside a short
   lock (duplicates are caught there). The page shows green only after that answer.
5. Busy or lost answers: the page re-sends the same request until the 120 s late grace runs out (D4, D5).
6. Unusual check-ins land in **Needs review**; a phone change needs the teacher's approval; a student without a phone is
   **marked present by hand**.

Sheet tabs: `AttStudents`, `AttDevices`, `AttRequests`, `AttRooms`, `AttSessions`, `AttCheckins`, `AttFlagLog`, `AttUsers`
(columns: `ATT_HEADERS` in `AttendanceAll.gs`; new columns are only ever added at the end, by `att_migrate()`).
