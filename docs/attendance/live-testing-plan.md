# Attendance: plan for live testing

*Written 2026-11-04, launch planned for about 2026-11-11. This page lists what is ready, what should change before real
students rely on it, and how to run the pilot. Decisions and follow-ups (D#, F#) are in [decisions.md](decisions.md); load
numbers in [load-testing.md](load-testing.md).*

## Ready now

| Area | State |
|---|---|
| Check-in under load | 70/70 in both load tests, nothing lost or doubled ([load-testing.md](load-testing.md)) |
| Busy server / bad connection | the page retries by itself, resumes after a reload, 120 s late grace (D4, D5) |
| Students know when it is NOT saved | amber "NOT saved yet" vs green "recorded", English + Arabic (D8) |
| No phone / page failed | Mark present by hand (D9) |
| Cheating checks | location, same phone, identical locations, repeated, device binding; decided in Needs review (D10) |
| Phone changes | teacher approval, as before |
| Teachers see only their own | tested (R-A06, R-A07, R-A08) |
| Rollback | every deploy is a numbered Apps Script version (Version 60 / 61) |
| Sample data for training | `att_seedDemo` / `att_clearDemo` (D11, [demo-data.md](demo-data.md)) |

## Proposed changes before the pilot

**P0: do before real students rely on it.**

| # | Change | Why | Size |
|---|---|---|---|
| P0-1 | **Rejected check-ins must not count as present.** Today a check-in the teacher rejects still shows ✓ in All students, counts in Present totals, the CSV `Present` column and the Telegram summary. Count `review_status = rejected` as absent everywhere (roster, tallies, export, summary) and show it as "rejected" in the grid. | A teacher who rejects a cheater expects them to be marked absent. | small (server + dashboard + tests) |
| P0-2 | **Undo a hand entry.** A "Remove" button on the teacher's own hand entries (MANUAL rows only), logged. | A typo in the ID today can only be "rejected", and (P0-1) still counts. | small |
| P0-3 | **Nightly backup of the attendance sheet** (F7): a daily trigger copies the file to a dated copy in Drive and keeps the last 14. | The sheet is the only copy of attendance records. | small |
| P0-4 | **Clear test and demo data** before the first lecture: `att_cleanupTest()`, `att_clearDemo()`. | Keeps the admin views and exports clean. | none |
| P0-5 | **The real-device checklist** in [deploy.md](deploy.md) section 6 on at least one iPhone and one Android, on mobile data. | The automated tests cannot cover cameras, permission prompts and flaky networks. | 30 min |
| P0-6 | **Privacy note for professors** (F8): what is stored (ID, name, a location fix per check-in, a phone fingerprint), who sees it (the lecture's teacher and the admin), how long it is kept. | Students' locations are personal data. | text only |

**P1: during the pilot.**

| # | Change | Why |
|---|---|---|
| P1-1 | Arabic for the remaining student messages (location help steps, device errors, "first time here"). | The save screens are bilingual; the rest is English only. |
| P1-2 | **Error reports from the student page**: when the page gives up or hits an unexpected error, send a short anonymous line (code, step, browser) to a lock-free log. | Today a failure on a student's phone is invisible unless they show the teacher. |
| P1-3 | **"+N late" Telegram line** for check-ins accepted in the 120 s grace (F4). | The close summary undercounts slightly. |
| P1-4 | Timing log around each sheet call in `att_attend_` (F11), switched on for the pilot only. | To find the call that occasionally hangs. |
| P1-5 | Teacher sees "still trying" students (F10). | Helps decide whether to wait or enter by hand. |
| P1-6 | Load tests 1 and 2 from [load-testing.md](load-testing.md#not-tested-yet) (100 at once; during a quiz deadline). | Before a second class or a bigger hall. |

**P2: before selling more seats.** Split attendance into its own Apps Script project (F1), keep check-in time flat over the
semester (F6), tiers and limits (F2).

## Pilot plan

| Phase | Who | How long | Pass when |
|---|---|---|---|
| 0. Dry run | the teacher + 3 to 5 people on their own phones, demo data cleared | one evening | the real-device checklist passes; everyone sees green; one hand entry and one phone change done |
| 1. First lecture | one section, **paper sign-in sheet in parallel** | 1 lecture | every student on the paper sheet is in the system (by phone or by hand); nobody waited more than about 1 minute |
| 2. One week | the same section, no paper | 2 to 3 lectures | ≥ 95 % check in by phone; 0 lost check-ins; flags reviewed the same day |
| 3. More classes | add sections one by one | from week 2 | load tests P1-6 passed before passing 70 students at once |

**Watch during the pilot**
- Apps Script > Executions after each lecture: anything far over 30 s, any errors (F11).
- The dashboard: Needs review count, Phone changes, how many hand entries (a lot of them means the page is failing for someone).
- What students say: "it stayed amber", "the location never came", which phone and browser.

**If something goes wrong in a lecture**
- Students who cannot check in: Mark present by hand, reason "Check-in page failed", with a note of what they saw.
- A broken deploy: Deploy > Manage deployments > Edit > the previous version (see [decisions.md](decisions.md) section 3), then tell students to reload.
- The whole system down: take the paper sheet and enter it by hand afterwards (it works for closed lectures).

## Success measures to record

Per lecture: present by phone, present by hand, flagged, rejected, median time from scan to green (from the check-in times),
phone-change requests. Add them to a small table at the end of this page during the pilot, so the go / no-go for more classes
is based on numbers.
