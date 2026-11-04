# Testing: how a patch gets shipped

*Updated 2026-11-03.* One command: `bash scripts/test_all.sh` (or **Run tests** in the Quiz Maker app, next to Browse).
It must say **ALL GREEN**.

| Command | When |
|---|---|
| `scripts/test_all.sh` | every patch (seconds): syntax, the Node / Python part of the regression registry, asset drift, lesson paths, unregistered-test check |
| `scripts/test_all.sh --e2e` | before a release: also the Playwright browser tests (`pip install playwright` + `python -m playwright install chromium`, about 4 min) |
| `scripts/test_all.sh --strict` | release gate: also fails on pending / TODO entries and on test files missing from the registry |
| `scripts/test_all.sh --require-all` | nothing may be skipped: a browser test without Playwright, a DOM test without jsdom (`npm i --no-save jsdom@24`) or a test that skipped itself FAILS |
| `scripts/test_all.sh --live` | right after **Deploy > New version**: read-only smoke test of the real Apps Script endpoint |
| `scripts/test_all.sh --install-hook` | makes `git push` run the gate first (skip once: `git push --no-verify`) |
| `scripts/test_all.sh --only R-E1` | one id or prefix while working |

## What GitHub Actions runs
`.github/workflows/test.yml`, one **required** job on every push and pull request:

1. installs jsdom, Playwright and Chromium;
2. `python scripts/sync_phase2.py --check` (Phase 2 sections of `Code.gs`);
3. `python scripts/build_server_logic.py --check` (generated `FollowupLogic.gs` matches `assets/followup-events.js`);
4. `bash scripts/test_all.sh --strict --e2e --require-all`: every registry entry, Node, Python, jsdom **and** browser.

So a green check on GitHub means every feature's tests really ran. A test added to `tests/registry.json` runs there
automatically; nothing else needs changing. (Until 2026-11-03 the browser tests ran in a separate job marked
`continue-on-error`, so a broken browser test never turned the check red; that job is gone.)

## Adding a test
Add the file to `tools/quiz-maker-v2/tests/`, then an entry to `tests/registry.json` (never reuse or delete an id), then
`python scripts/gen_regression_table.py` so `docs/REGRESSION.md` lists it (R-DOC-1 fails otherwise). A bug that reached
students gets its test written first, failing, then the fix.

## Guarding against "an old copy overwrote newer work"
This happened once (the P4 assembly `0757045` was built from a copy older than Nov 1 and undid `99d91f0` and
`5c6efc9`). Two things now catch it:
- the features those commits added have their own registry entries (R-RESTORE-1, R-P4-S4-07), so losing them fails CI;
- before merging a large patch, list for every recent commit the lines it added that are missing afterwards:
  `for c in $(git rev-list -20 HEAD); do git show $c ...; done` (the exact loop is in `docs/INTEGRATION-LOG.md`,
  integration 7). Anything listed is either a deliberate later edit or a revert to fix.

## Backend layout: the files you deploy
Paste these into the Apps Script project, then **Deploy > Manage deployments > New version** (never "New deployment"):
`Code.gs`, `AttendanceAll.gs`, `FollowupLogic.gs` (generated: do not edit by hand), `FollowupNotify.gs`,
`FollowupRouter.gs`, `Requirements.gs`. The Phase 2 backend lives inside `Code.gs` (sections under
`// ===== MERGED FROM Phase2_X.gs =====`); Phase 4 is wired into it by `scripts/p4_wire.py` from
`apps_script/chunks/`. If a standalone `Phase2_*.gs` file still exists, `python scripts/sync_phase2.py --check` fails when
it differs from its section in `Code.gs` (`python scripts/sync_phase2.py` copies it in).
