# Attendance load testing: status report

*Status as of 2026-11-04 (Apps Script Version 60 for the runs; Version 61 is live and adds manual entry, which is not on the
check-in path). Source data: the runs below, executed on the real Apps Script project against the live sheet.*

## Verdict

**Ready for live testing with one class of up to 70 students.** Every run on the real backend recorded every student exactly once.
A normal lecture (70 registered students tapping at the same second) is through in about one minute. The heaviest case, a first
lecture where 70 new students sign up and check in at once, is through in about two minutes. Both fit comfortably inside the
5-minute session plus the 120-second late grace.

What is **not** proven yet: more than 70 at once, two classes at the same time, a check-in burst during a quiz deadline (the
lock is shared with quizzes), and the end of a semester when the check-in tab is large. See [Not tested yet](#not-tested-yet).

| Area | Status |
|---|---|
| 70 returning students at once | ✅ PASS (70/70, slowest 59 s) |
| 70 new students, sign-up + check-in at once | ✅ PASS (70/70, about 2 min without the hung request) |
| No lost or doubled check-ins under load | ✅ in every run |
| The student page's automatic retry under real BUSY / "too many requests" answers | ✅ (the test re-sends the same way the page does) |
| One request hanging for minutes inside Google (F11) | 🟡 seen in both first-day runs; does not block others; watch in real use |
| 100 students at once | ❌ not run (`att_loadTest(100)`) |
| Two lectures at the same moment / during a quiz deadline | ❌ not run |
| Large `AttCheckins` tab (end of semester) | ❌ not run (F6) |
| Real phones on mobile data | ❌ not run: the live-testing pilot does this ([live-testing-plan.md](live-testing-plan.md)) |

## How the test works

`att_loadTest(n)` and `att_loadTestFirstDay(n)` in `AttendanceAll.gs`, run from the Apps Script editor:

- They start a test lecture (course `ATT-TEST`) and send **all n requests at once** over HTTP to the students' `/exec` URL
  (`UrlFetchApp.fetchAll`), exactly what n phones tapping at the same second would send.
- Every request that gets BUSY, a server error or a non-JSON answer (Google's "too many at once" page) is **sent again in the
  next round** after a short wait, the way the student page retries.
- Each student stands at a slightly different realistic spot in the hall (an earlier run with identical coordinates flagged
  everyone and distorted the timing).
- It logs every round as it happens and ends with recorded N/N, unique rows, median / 90 % / slowest time until recorded, and PASS/FAIL.
- It checks the URL with one request first and writes nothing if the answer is not the attendance JSON.
- Test rows use IDs `9998xxxx` and course `ATT-TEST`; `att_cleanupTest()` removes them. Run it outside lecture and quiz hours.

## Results

| Date | Run | Recorded | Needed a retry | Median | 90 % | Slowest | Result |
|---|---|---|---|---|---|---|---|
| 2026-11-04 | `att_loadTest()` | 0/70 | 70 | - | - | - | **Invalid**: every request got HTTP 401 (the test used the editor-only `/dev` URL). Fixed: it now uses the students' `/exec` URL and checks it first. |
| 2026-11-04 04:09 | `att_loadTest()` (70 at once) | **70/70**, 70 unique rows | 20 (BUSY once) | 37.5 s | 59.1 s | 59.1 s | **PASS.** Round 1: 50 recorded, 20 BUSY; round 2: the 20 recorded. |
| 2026-11-04 04:14 | `att_loadTestFirstDay()` (70, identical coordinates) | 49 signed up, 19 checked in when cut off | - | - | - | - | **Inconclusive.** One request hung for 360 s and the test waited for it; all students had the same coordinates, so all were flagged (fixed: F5, realistic spots). |
| 2026-11-04 04:35 | `att_loadTestFirstDay()` (70, realistic spots), Version 60 | **70/70**, 70 students + 70 devices, 70 unique rows | 49 | 254 s * | 278 s * | 289 s * | **PASS.** Rounds of 34, 32, 174 *, 20 and 7 s. 0 flags. |

\* Inflated by one request that hung for 173 s inside Google while everyone else kept going (F11). Without it the whole class
was through in about two minutes. A real phone in that position re-sends after its 30-second watchdog.

## What the runs showed

- **About 0.5 s per check-in inside the lock.** The lock is held only for the duplicate check and the row append; everything else
  (ticket check, device lookup, history read, flag rules, Telegram) runs outside it.
- **BUSY is normal at 70 at once.** A request waits up to 25 s for the lock, then answers BUSY and the page retries. Nothing is lost.
- **Google runs about 30 requests of one project at the same time.** The rest get an HTML "too many" page (`NOT_JSON_200`) at once;
  the page treats it like a lost connection and retries.
- **One request in a burst of 70 can hang for minutes** (seen twice: 173 s and 360 s). It did not hold the lock. It is most likely
  stuck inside a Sheets call. The page copes; the only cost is that one student waiting longer.
- **Real lectures are gentler than the test:** phones scan over a minute or two, not in the same second.

## Capacity limits that matter

| Limit | Value | Effect |
|---|---|---|
| Session length | 5 min + 120 s late grace | the budget every check-in must fit in |
| Lock shared with quizzes and homework (`Code.gs`) | one lock for the whole project | a quiz deadline during check-in slows both (F1 splits the project) |
| Concurrent requests per project | about 30 | extra requests are refused at once and retried |
| Apps Script execution time | 6 min per request | a hung request is killed at 6 min |
| History read per check-in | the whole `AttCheckins` tab | time per check-in grows over the semester (F6) |

## Not tested yet

Proposed next runs, in order, with what counts as a pass:

1. **`att_loadTest(100)`**: a 100-seat hall. Pass: 100/100, slowest under 3 minutes.
2. **Check-in during a quiz deadline**: run `att_loadTest()` while a script submits 30 quiz answers. Pass: 70/70 and no quiz
   submission lost; if the slowest check-in goes over 4 minutes, do F1 (split the project) before adding classes.
3. **Two lectures at once**: two teachers' `att_loadTest(40)` started together. Pass: 80/80 within 3 minutes.
4. **End of semester**: fill `AttCheckins` with about 6,000 old rows (a copy of the sheet, not the live one), then `att_loadTest()`.
   Pass: the median stays under 60 s; otherwise do F6 (archive old rows or cache the per-student count).
5. **Real phones** (the live-testing pilot): 10 to 20 real students on mobile data, see [live-testing-plan.md](live-testing-plan.md).

Re-run the first two tests after any change to `att_attend_`, `att_signup_`, the lock or the flag rules, and before quoting a
capacity to a customer (pricing tiers, F2).

## How to run one

1. Deploy first (the test calls the deployed `/exec` URL, not the editor's code): [deploy.md](deploy.md).
2. Outside lecture and quiz hours, in the Apps Script editor, pick `att_loadTest` (or `att_loadTestFirstDay`) and Run.
3. Read the log (View > Logs, or the Executions page). It ends with PASS or FAIL and the times.
4. Run `att_cleanupTest()`.
5. Add a row to the [Results](#results) table above.
