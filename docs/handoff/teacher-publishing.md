# Teacher publishing

*Refactor Phase 2.5, steps E and G (2026-11-23). How a second teacher fills in his lessons, and what stops him
from changing anything else.*

**You make the lessons, he fills them in.** You seed every lesson (its folder, its name, its pages, its place on the
grade page). He cannot rename, add or delete a lesson. He adds:

| What | How | Who checks it |
|---|---|---|
| The three videos of a lesson (lesson, quiz, assignment) | Quiz Maker in teacher mode, **Update** next to each video. Goes straight to the backend; the lesson page does not change | The backend: his token only works on his subjects (R-P25-B) |
| Quiz questions | Quiz Maker, **Load for editing**, add questions, **Save quiz questions**. Backend only, no page change | The backend, same token |
| Files (PDFs, slides, worksheets) | Quiz Maker, Attachment section: uploads to Drive and adds a line to the lesson's `attachments.json`. That file goes to GitHub in a pull request from a `teacher/<name>/...` branch | The **Teacher publish check**, then you (approve and merge) |

The assignment page (its text, how students submit, its questions) is yours too: it lives inside the lesson page.
Fixed names keep this simple; they are not a hard rule. If he needs more (for example the assignment questions), it
can be added later.

## Seeding lessons (you)

1. Write the chapters and lessons in `tools/quiz-maker-v2/seeds/science.json` (one title per lesson).
2. Run `python tools/quiz-maker-v2/seed_lessons.py tools/quiz-maker-v2/seeds/science.json`. It uses the Quiz Maker's
   own lesson writer: folder `chapter-<n>-lesson-<m>`, title `Chapter <n> Lesson <m> | <your title>`, an empty quiz,
   no video, then the SEO step. Lessons that already exist are left alone, so adding a lesson later is: add its title,
   run it again.
3. Commit and push as usual. To rename a lesson later: Quiz Maker (your owner token), **Load for editing**, change the
   name, **Generate**. The folder stays the same.

## What the check refuses

`scripts/check_teacher_pr.js`, run by `.github/workflows/teacher-publish.yml`. The rules and the teacher list come
from `main`, so a teacher cannot change them in his own pull request; his files are only read, never run.

A teacher pull request may change only `attachments.json` and attachment files (`.pdf .png .jpg .jpeg .webp .gif`)
inside lesson folders that **already exist on `main`** in his subjects. Everything else is refused, with the reason:

- A branch that is not `teacher/<name>/...`, a name that is not in `.github/teachers.json`, or a pull request opened
  by any GitHub account other than that teacher's.
- A new lesson folder, a deleted or moved lesson, or a change to a lesson page (`index.html`, `quiz.html`,
  `assignment.html`): "lesson pages are made by the owner".
- The grade pages, his subject's front page, `sitemap.xml`, `assets/lesson-titles.json`, and anything outside his
  subject folders (`assets/`, `dashboard/`, the backend, `tools/`, `scripts/`, `.github/`, root files).
- Stylesheets, scripts or any other file in a lesson; links (symlinks), submodules.
- An `attachments.json` that is not the Quiz Maker's own list of `{title, drive_file_id, type}`, or that is deleted.
- Files over 2 MB (8 MB for a PDF), or more than 20 MB in one pull request.

Every `attachments.json` you already have passes these rules (test R-P25-E).

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

1. Quiz Maker in teacher mode (his token): only his subjects show, lesson names are read-only, and there is no
   Generate, New lesson or Delete. He picks the lesson under "Open an existing lesson".
2. Videos: paste the link, click **Update**. Quiz questions: **Load for editing**, add them, **Save quiz questions**.
   Both are live at once; nothing to commit.
3. Files: Attachment section, **Upload to Drive & add to lesson**. Then in GitHub Desktop: *Current branch > New
   branch* `teacher/<name>/<lesson>` (for example `teacher/science-teacher/ch1-lesson1-files`), commit the changed
   `attachments.json`, *Publish branch*, *Create Pull Request*.
4. The checks run. A red **Teacher publish check** lists every refused file and why.

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
