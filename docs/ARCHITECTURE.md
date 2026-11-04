# Architecture

*Written 2026-11-04. Short on purpose: the rules here apply to every feature. Details live in each feature's own docs.*

## 1. Three systems, three deploys

| System | What | Where it runs | How a change goes live |
|---|---|---|---|
| **Site** | Static HTML / CSS / JS: lessons, quizzes, dashboards, the attendance pages | GitHub Pages, from this repo's `main` (`tools/` is not published, see `_config.yml`) | `git push`, then the Pages build (a few minutes) |
| **Backend** | Google Apps Script web app: `Code.gs` (accounts, quizzes, homework, follow-up, payments) + `AttendanceAll.gs` (attendance) in **one** project, with Google Sheets as the database and Drive for files | script.google.com, one deployment, one `/exec` URL | Paste the changed files into the editor, then **Deploy > Manage deployments > Edit > New version** (never "New deployment": it changes the URL baked into the site) |
| **App** | Quiz Maker, a local desktop app that generates lesson pages | the owner's computer only (`tools/quiz-maker-v2/`) | Run it, then push what it generated |

None of them updates the others. `tools/quiz-maker-v2/apps_script/*.gs` in the repo is the **source of truth for review**, and
must be pasted to go live; each deploy is recorded with the commit it came from (for attendance: `docs/attendance/decisions.md`).

**Deploy order: backend first, then the site.** A new page calling an old backend gets `UNKNOWN_ACTION`; an old page calling a
new backend keeps working, because changes are additive (section 3).

## 2. How a request flows

```
phone / browser ──POST {action, ...}──▶ /exec (doPost in Code.gs)
                                          ├─ att_* ─▶ att_route_ ─▶ att_dispatch_ (AttendanceAll.gs)
                                          └─ other ─▶ Code.gs router
                                                       │
                       Google Sheets (one tab per record type) ◀┘   Drive (files)   Telegram (notifications)
```

- The site calls one function per backend: `contract/att_api.js` `call(action, payload)` for attendance (3 tries on network errors).
- The backend answers JSON `{ok: true, ...}` or `{ok: false, code, error}`. **Codes are the contract** (`BUSY`, `TICKET_EXPIRED`,
  `UNAUTHORIZED`...); pages map codes to wording, never parse error text.
- Shared settings the client and server must agree on live in `contract/` and are checked for parity by a test
  (for example `LATE_GRACE_SEC`).

## 3. Design principles (apply them to every new feature)

**Correctness and data**
1. **The server decides.** Every rule (who may see what, whether a check-in counts) is enforced in the backend. The page only
   explains. The caller's identity comes from the token, never from the payload (`att_dispatch_` passes `u`).
2. **Every write is safe to repeat.** Clients retry, so each write has a natural key and a repeat returns the earlier result
   (`att_attend_`: one row per session + student; sign-up retried = `dup: true`). Never "add one" without a key.
3. **Short locks.** Read and compute outside the lock; inside it, only re-check what can have changed and append. The lock is
   shared by the whole project (quizzes and attendance).
4. **Sheets schema is append-only.** New columns go at the end (`att_migrate()`), old rows read the missing ones as `""`. Never
   rename, reorder or reuse a column. Prefer reusing existing columns with a clear marker over a migration (manual entry:
   `device_id = MANUAL`).
5. **Store facts, compute views.** Rows record what happened (who, when, why); counts, percentages and labels are computed when
   read, so a rule change does not need a data fix.
6. **Personal data: the minimum, and only for who needs it.** Teachers see only their own; the admin sees all. Nothing personal
   in logs, URLs, the repo or Telegram beyond what the owner needs.

**Behaviour the user sees**
7. **Never claim success early.** Green only after the server said so; anything pending is clearly "NOT saved yet" (amber).
   The same colours mean the same thing everywhere: amber = waiting / needs a look, green = done, red = refused / problem.
8. **Plain words, in the user's language.** Students: English + Arabic. Codes stay in exports and logs, not on screen.
9. **Every failure has a way out**: retry by itself, a button to try now, and a manual path for the teacher (mark present by hand).
10. **Decide where the problem is shown** (Accept / Reject next to the flag, not on another tab).

**Operations**
11. **Feature switches and rollbacks.** Each deploy is a numbered version with a known rollback. Risky behaviour ships behind a
    Script Property or a config flag.
12. **Observable.** Anything that can fail silently writes a log line (the flag log, the Executions page) and, where it matters,
    a Telegram message (never for demo or test data).
13. **Test and demo data are marked and removable** (`ATT-TEST` / `9998-9999xxxx` for tests, `DEMO ` / `9997xxxx` for demo data).

**Code**
14. **Generated files are generated.** `FollowupLogic.gs` comes from `assets/followup-events.js` (`scripts/build_server_logic.py`),
    `docs/REGRESSION.md` from the registry; the gate checks they are current. Edit the source, never the output.
15. **One backend file per product area**, plain ES5-style Apps Script, no build step for the backend. The site has no framework:
    each page is HTML + one script, shared code in `assets/` or `contract/`.
16. **Every string from the server is rendered with `textContent`**, never `innerHTML` (tested).

## 4. Tests

- One gate: `bash scripts/test_all.sh --strict --e2e --require-all` ([TESTING.md](TESTING.md)). GitHub Actions runs the same on
  every push; do not merge red.
- Backend logic runs in Node against the **real** `.gs` files (`tests/attendance/gas_emulator.js`); pages run in a fake DOM or
  jsdom; end-to-end tests drive real Chromium (Playwright) against the emulated backend.
- Every test is registered in `tools/quiz-maker-v2/tests/registry.json` (the gate fails on an unregistered test file).
- Things only the real Apps Script shows (locks under load, Google's limits) are tested from the editor: `att_selfTest`,
  `att_scriptedRun`, the load tests ([attendance/load-testing.md](attendance/load-testing.md)).

## 5. Checklist for a new feature

1. **Decide and write it down**: a D# line in the feature's `decisions.md` (what, why, when to revisit); open questions become F#.
2. **Contract first**: the action name, payload, answer and error codes; who may call it (owner / admin) and what it may see.
3. **Backend**: validate input, authorize with the existing helpers (`att_scopeSession_`, `att_canSee_`), keep the write
   idempotent and the lock short, add columns only at the end.
4. **Page**: plain wording, the three states (working / not done yet / done), a way out on failure, `textContent` only.
5. **Tests**: backend rules (emulator), the page (fake DOM), one real-browser path if it is user-facing; register them.
6. **Docs**: update the feature's page (and runbook if deploying changes), screenshots if the UI changed.
7. **Ship**: gate green → backend (new version, record it) → `att_selfTest` / `att_scriptedRun` → push the site → check live.

## 6. Known structural limits

- Attendance and quizzes share one Apps Script project: one lock and about 30 concurrent requests for both. Splitting attendance
  out is planned (attendance F1).
- Google Sheets is the database: whole-tab reads grow with the data; archive or cache before tabs reach tens of thousands of
  rows (attendance F6).
- The repo is public: anything private belongs in the external `Docs/` folder ([README.md](README.md#where-a-doc-goes)).
