# Teacher publishing

*Refactor Phase 2.5, step E (2026-11-23). How a second teacher puts his own lessons on the site, and what stops him
from changing anything else.*

A teacher's work goes two ways:

| What | Where it goes | Who checks it |
|---|---|---|
| Videos, quiz questions, written-answer models | Straight to the backend from the Quiz Maker, with his own teacher token | The backend: his token only works on his subjects (separation test R-P25-B) |
| Lesson pages (the files in his subject folder) | A GitHub pull request from a `teacher/<name>/...` branch | The **Teacher publish check** in CI, then you (approve and merge), or auto-merge once you trust him |

## What the check refuses

`scripts/check_teacher_pr.js`, run by `.github/workflows/teacher-publish.yml`. The rules and the teacher list come
from `main`, so a teacher cannot change them in his own pull request; his files are only read, never run.

- A branch that is not `teacher/<name>/...`, a name that is not in `.github/teachers.json`, or a pull request opened
  by any GitHub account other than that teacher's.
- Any file outside his subject folders (for Science: `science/<grade>/...`). His subject's front page
  (`science/index.html`), `assets/`, `dashboard/`, the backend, `tools/`, `scripts/`, `tests/`, `docs/`, `.github/`
  and every root file are refused. Two shared files the Quiz Maker rewrites are allowed only when every change in them
  is about his subjects: `sitemap.xml` and `assets/lesson-titles.json`.
- Anything but lesson files: `.html .css .json .png .jpg .jpeg .webp .gif .pdf`. No links (symlinks), no submodules.
- Script in a lesson page other than the shared engines (`/assets/<engine>.js`), JSON data blocks, and the small inline
  scripts your own pages already use. Also refused: event-handler attributes, `javascript:` links, `<object>`,
  `<embed>`, `<base>`, `<meta refresh>`, frames other than YouTube / Vimeo / Google Drive, and the parts of inline SVG
  that can run or load content.
- CSS with script tricks or `@import`; JSON that does not parse.
- Files over 2 MB (8 MB for a PDF), or more than 20 MB in one pull request.

Your own lessons already on `main` all pass these rules (test R-P25-E).

## One-time setup (you, on github.com)

1. **Invite the teacher**: repository > Settings > Collaborators > Add people > his GitHub account (role: Write).
2. **Name him in `.github/teachers.json`** (on `main`, yourself): set `"github"` to his account, and the handle (the key,
   for example `science-teacher`) to the name he will use in his branches. Change the handle and `"name"` to his.
3. **Protect `main`** with a ruleset: Settings > Rules > Rulesets > New branch ruleset.
   - Target: the default branch. Bypass list: **Repository admin** (so you can still push straight to `main` as today).
   - Turn on *Require a pull request before merging* with **1 required approval**.
   - Turn on *Require status checks to pass*: add **Gate (syntax + full regression registry incl. browser tests)**
     and **Teacher publish check** (they appear in the list after their first run).
   - Turn on *Block force pushes*. Save.
4. **Actions settings**: Settings > Actions > General > Workflow permissions: **Read repository contents**. Tick
   *Allow GitHub Actions to create and approve pull requests* only if you will use auto-merge (step below).
5. **Auto-merge** (optional, for later): Settings > General > Pull Requests > tick *Allow auto-merge*.

## Every lesson (the teacher)

1. Quiz Maker in teacher mode (his token): only his subjects show. Generate the lesson into his copy of the site.
   Videos and quiz questions go to the backend at that moment.
2. GitHub Desktop: *Current branch > New branch* `teacher/<name>/<lesson>`, for example
   `teacher/science-teacher/ch1-lesson1-matter`. Commit the changed files, *Publish branch*, then *Create Pull Request*.
3. The checks run. A red **Teacher publish check** lists every refused file and why.

## Every lesson (you)

Open the pull request, look at *Files changed*, then **Approve** and **Merge**. GitHub Pages publishes it in a minute.
Do not merge while a check is red.

## Switching a teacher to auto-merge, and back

When you trust his pull requests: on `main`, set `"auto_merge": true` for him in `.github/teachers.json` (and do
setup steps 4 and 5). From then on, a pull request of his that passes the check is approved by the workflow and merges
by itself once every check is green. To go back, set it to `false`; his next pull requests wait for you again.

## Removing a teacher

1. Settings > Collaborators: **Remove** him. He can no longer push or open pull requests.
2. Delete his entry from `.github/teachers.json`.
3. Backend: make him a student again (Team page in the dashboard), and remove his teacher token in the Apps Script
   editor with `p4_revoke_teacher_token("<his name>")`, so his Quiz Maker stops working.
His lessons stay on the site until you remove them.
