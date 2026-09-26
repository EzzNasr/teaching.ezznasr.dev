# Safety-net tests (no install needed — plain Node)

`harness.js` is a small fake of Apps Script (Sheets, Drive, locks, cache) that runs the
real `Code.gs`. Run from `tools/quiz-maker-v2/`:

```
node tests/test_accounts_and_sheets.js apps_script/Code.gs   # login, reset, lockouts, full-grid writes
node tests/test_item6.js               apps_script/Code.gs   # uploads: lock scope, races, busy lock, clean-up
node tests/test_client_post.js         ../..                 # quiz.js / assign.js retry behaviour
node tests/test_videos.js              apps_script/Code.gs   # video lock: who sees a URL, the toggle, fail-closed, cache
node tests/test_access.js              apps_script/Code.gs   # payments: "I paid" requests, approvals, entitlements, expiry, scopes
node tests/test_revoke.js              apps_script/Code.gs   # revoking access, cancelled payments, the access-dashboard overview
node tests/test_quiz_gate.js           apps_script/Code.gs   # locking/unlocking a quiz itself, separate from its video
node tests/test_groups.js              apps_script/Code.gs   # student groups: membership, bulk grant/revoke access
```

Each prints PASS/FAIL per check and exits non-zero on any failure. Run them before
pasting a new `Code.gs` into Apps Script. They can't measure real Google timings.

## Real-browser tests (optional — needs Playwright)

Drive `assets_templates/video.js`, `quiz.js` and `dashboard/access.html` in Chromium
against the REAL `Code.gs` (run through `e2e_backend.js`), including the real
sign-in modal. Nothing touches the live site.

```
pip install playwright
playwright install chromium
python tests/e2e_video.py         # the locked-video box on a lesson page
python tests/e2e_dashboard.py     # the video-access admin dashboard (requests/access/history/videos/grant)
python tests/e2e_step4b.py        # the quiz gate on the quiz page, and the new Quiz-gate/Groups dashboard tabs
```
