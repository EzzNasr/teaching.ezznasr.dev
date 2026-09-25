# Safety-net tests (no install needed — plain Node)

`harness.js` is a small fake of Apps Script (Sheets, Drive, locks, cache) that runs the
real `Code.gs`. Run from `tools/quiz-maker-v2/`:

```
node tests/test_accounts_and_sheets.js apps_script/Code.gs   # login, reset, lockouts, full-grid writes
node tests/test_item6.js               apps_script/Code.gs   # uploads: lock scope, races, busy lock, clean-up
node tests/test_client_post.js         ../..                 # quiz.js / assign.js retry behaviour
node tests/test_videos.js              apps_script/Code.gs   # video lock: who sees a URL, the toggle, fail-closed, cache
node tests/test_access.js              apps_script/Code.gs   # payments: "I paid" requests, approvals, entitlements, expiry, scopes
node tests/test_revoke.js              apps_script/Code.gs   # revoking access, rejecting/cancelling a payment, the access-dashboard overview
```

Each prints PASS/FAIL per check and exits non-zero on any failure. Run them before
pasting a new `Code.gs` into Apps Script. They can't measure real Google timings.

## Real-browser tests (optional — needs Playwright)

Drive `assets_templates/video.js` and `dashboard/access.html` in Chromium against the
REAL `Code.gs` (run through `e2e_backend.js`), including the real sign-in modal.
Nothing touches the live site.

```
pip install playwright
playwright install chromium
python tests/e2e_video.py         # the locked-video box on a lesson page
python tests/e2e_dashboard.py     # the video-access admin dashboard
```

## Manual page

`manual/video-demo.html` is a throwaway page for trying `video.js` against your live backend
with a made-up lesson (`zz-test/step3`). Its header comment says how to serve it.
