# Contributing

This is a live teaching site run by one teacher. Students use it every day, so every change is small, tested and
reversible. Start with the [handoff guide](docs/handoff/README.md); it explains the parts and where they live. Teachers adding
lessons follow [teacher-publishing.md](docs/handoff/teacher-publishing.md) instead of this page.

## Set up once

```bash
npm ci                                  # pinned Node test tools (jsdom) and clasp
pip install -r requirements-dev.txt     # pinned Playwright and Pillow
python -m playwright install chromium
```

Node 22 (`.nvmrc`). Editor settings come from `.editorconfig`.

## Before every pull request

```bash
bash scripts/test_all.sh --strict                      # fast gate, about a minute
bash scripts/test_all.sh --strict --e2e --require-all  # full gate, the same as CI
```

On Windows, put `PYTHONIOENCODING=utf-8` in front, and do not run anything else heavy while the full gate runs (a few
browser tests time out under load and pass alone). A new test goes into `tools/quiz-maker-v2/tests/registry.json`;
then regenerate the table with `python scripts/gen_regression_table.py`. [docs/TESTING.md](docs/TESTING.md) has the
details.

## Rules

1. **One change per pull request.** A move is a move, a fix is a fix: never a behaviour change inside a refactor.
2. **A test first** when the code you change has none: record what it does now, then change it.
3. **Backend changes are additive.** Pages stay cached for up to 30 days, so old pages must keep working: add new
   actions and fields, remove old ones only later.
4. **The backend guards must stay green.** R-REF-1 (`node scripts/gs_inventory.js`) lists every backend function; after
   a deliberate backend change, rewrite it with `--write` in the same commit and say why. R-REF-2 checks every action
   has a test and an authorization entry.
5. **Deploy the backend only with `npm run deploy:backend`**, never `clasp push` on its own: time-driven triggers run
   the saved code at once. Not during a class or an open quiz window. See
   [docs/runbooks/backend-deploy.md](docs/runbooks/backend-deploy.md).
6. **The repo is public.** No secrets, tokens, real student names or phone numbers, and no security weakness details.
   Screenshots and fixtures use sample data only. Report a security problem to the owner privately, not in an issue.
7. **The owner pushes and deploys** unless he hands that over for a change.

## Commits

Short plain-English subject saying what changed; the body says why. Write it so someone can `git revert` one commit
and know what goes away.
