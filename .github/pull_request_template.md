## What and why

<!-- One or two sentences. One change per pull request: a move OR a fix OR a feature. -->

## Checklist

- [ ] Fast gate green: `bash scripts/test_all.sh --strict`
- [ ] Full gate green (CI runs it): `bash scripts/test_all.sh --strict --e2e --require-all`
- [ ] New or changed behaviour has a test in `tools/quiz-maker-v2/tests/registry.json`
- [ ] Backend changed? R-REF-1 and R-REF-2 green; any `gs_inventory.js --write` explained above
- [ ] Backend changes are additive (cached pages up to 30 days old still work)
- [ ] No secrets, real student data or security weakness details in code, tests, screenshots or this description
- [ ] Docs updated (`docs/`, and `docs/handoff/refactor-log.md` for a refactor step)

## Deploy

<!-- Backend: needs `npm run deploy:backend` after merge? Outside class and quiz windows.
     Site: goes live on merge to main. Say how to undo it (usually: git revert <commit>). -->
