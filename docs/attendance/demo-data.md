# Attendance demo data

Sample data in the **live** attendance sheet, so every screen of the dashboard has something to show: for looking around,
training a teacher, or checking a change on the real system. It is added and removed from the Apps Script editor.
Decision: D11 in [decisions.md](decisions.md). Code: the "demo data" section of `AttendanceAll.gs`. Test: R-A12
(`tests/attendance/demo_data.test.js`).

## Use it

1. Deploy a version that has the functions (Version 62 or later; see [deploy.md](deploy.md)).
2. In the Apps Script editor run **`att_seedDemo`**. It takes a few seconds. The log shows the two demo teachers and their passwords.
3. Open `/attend/admin/` and sign in with one of those passwords (or the admin token to see both teachers).
4. For a live lecture: as **DEMO Dr Hossam Eldein**, Take attendance, start "DEMO Web Programming" in "DEMO Hall B", keep the QR
   screen open, then run **`att_demoLive`** in the editor. Over about 40 seconds 13 sample students check in: 10 normal, a new
   sign-up, one outside the hall (Needs review) and one cheating attempt (red line in the live feed). You can also scan the
   QR with a real phone: it is a real lecture.
5. When done: run **`att_clearDemo`**. It removes every demo row and nothing else. Running `att_seedDemo` again starts fresh.

Run it outside lecture hours: the seed is written in one batch while holding the project lock (a second or two).

## What is in it

| Screen | What you see |
|---|---|
| Take attendance | 3 rooms; the live lecture with `att_demoLive` |
| Mark present by hand | 3 hand entries (no phone; page error with a new student "Nourhan Adel"; other + note) |
| Phone changes | 2 waiting (one same phone model, one different); 1 approved and 1 denied in the past |
| Needs review | undecided flagged check-ins with plain reasons; some already accepted / rejected with notes |
| All students | 30 students x 11 lectures (Dr Hossam) or 3 (Eng. Mariam), attendance from about 45 % to 100 % |
| History | 14 lectures over the last 23 days with distances, location problems and decisions |
| All teachers (admin) | both demo teachers next to the real ones |

Every kind of flag appears, computed by the real rule engine: outside the hall, location blocked, skipped, no location, weak
signal, same phone as another student, identical locations, flagged 3 times before (REPEATED), plus a cheating attempt and a
first attempt fixed by a second one (upgrade) in the flag log.

## How it is marked (and why it is safe)

- Teachers, courses and rooms start with **`DEMO `**; students have IDs **`9997xxxx`**. `att_clearDemo` removes exactly those
  rows (plus their check-ins, devices, requests and flag-log lines) and clears their cache entries.
- Demo teachers see only their own demo lectures; real teachers never see demo data. **The admin does** (All teachers, All
  students) until `att_clearDemo` runs.
- **No Telegram.** Any notification about a demo lecture or a 9997 student is dropped (`att_safeNotify_` → `att_isDemoEvent_`).
- The test (R-A12) seeds on top of real data, runs a live demo lecture, clears, and checks that every real row is still there,
  unchanged and in order.
- The demo students' phone secrets are derived from their IDs (`att_demoSecret_`), so `att_demoLive` can check in as them.
  That is fine for sample data and never applies to a real student.
