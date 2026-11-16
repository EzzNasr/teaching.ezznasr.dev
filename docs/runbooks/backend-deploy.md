# Backend deploy with clasp

*Since 2026-11-16 (refactor Phase 2). Replaces copying files into the Apps Script editor. The old paste procedure
still works as a fallback, and the web-app URL never changes either way.*

## Once per computer

```bash
npm ci                      # installs the pinned clasp (3.4.1) with the test tools
npx clasp login             # Google sign-in in the browser; the token stays in your home folder, never in the repo
```

Also turn on **Apps Script API** at <https://script.google.com/home/usersettings> (one switch per Google account).

## Every deploy

Not during a class or an open quiz window.

```bash
git checkout main && git pull           # deploy what is on main (CI is green there)
npm run deploy:backend                  # dry run: every check, then the list of files this deploy changes
npm run deploy:backend -- --yes         # the deploy
```

Or from the Quiz Maker: **Deploy backend ▾** next to *Run tests*: *Check only* first, then *Deploy backend to live*
(it asks you to type `DEPLOY` in the window).

Then commit the new row the script added to `docs/runbooks/backend-deploys.md`.

What `--yes` does, and where it stops (`scripts/deploy_backend.js` has the details):

| # | Step | Stops when |
|---|---|---|
| 1 | Preflight | uncommitted changes; the commit is not on GitHub; it is not `origin/main` (pass `--allow-branch` for a hotfix or a rollback) |
| 2 | Fast test gate | not ALL GREEN (`--skip-gate` only if CI just ran the full gate on this commit) |
| 3 | Live check: clone the editor's saved code and the deployed version | they differ: someone saved code in the editor without deploying it, and **time-driven triggers already run saved code**. Find out what it is first; `--allow-drift` overwrites it. Also stops if the live manifest differs from `apps_script/appsscript.json` |
| 4-5 | Push the 8 files (under the editor's own names and order, from `apps_script/deploy.json`) plus a generated `Version.gs`, then clone again and compare | the saved code is not exactly what was pushed: automatic rollback |
| 6 | New version, then the **same** web-app deployment is moved to it | |
| 7 | `scripts/smoke_live.js --expect-commit <sha>`: the read-only live checks plus "the health check names this commit" | red: automatic rollback (the previous version's files pushed back and the deployment moved back), recorded as ROLLED BACK |

## Which commit is live?

```bash
node scripts/smoke_live.js              # prints "live commit: abc1234 (deployed ...)"
```

Or open the `/exec` URL in a browser: the JSON has `version.commit`. `null` means the live code was pasted by hand.

## Rules

- **Never `clasp push` on its own.** Triggers (hourly follow-up reminders, the WhatsApp queue, the nightly attendance
  backup) run the saved code, not the deployed version, so a push alone changes them at once. Push only through the
  deploy script.
- **Roll back** to an older commit: `git checkout <commit>` then `npm run deploy:backend -- --yes --allow-branch`.
  The commits are in `docs/runbooks/backend-deploys.md`. Hand-pasted versions before 2026-11-16 are recorded in
  `docs/attendance/decisions.md`.
- A new `.gs` file must be added to `apps_script/deploy.json` (the script refuses to deploy an unlisted file).
- A change to scopes or web-app settings goes into `apps_script/appsscript.json` first, on purpose, in its own commit.
- There is no staging project yet. It comes at the start of refactor Phase 3 (setup steps:
  [staging-setup.md](staging-setup.md)). Until then, check new screens after a
  deploy with the demo data in the live sheet (`att_seedDemo` / `att_clearDemo`).
