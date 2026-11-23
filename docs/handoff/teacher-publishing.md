# Teacher publishing

*Refactor Phase 2.5, steps E and G (2026-11-23). How a second teacher fills in his lessons, and what stops him
from changing anything else.*

**You make the lessons, he fills them in, in his browser.** You seed every lesson (its folder, its name, its pages,
its place on the grade page). He cannot rename, add or delete a lesson. He signs in on the site and opens
**«دروسي»** (`dashboard/my-lessons.html`, linked from «فريقي», «إيراداتي» and his staff home). For each of his
lessons he sets:

| What | On «دروسي» | Where it is saved |
|---|---|---|
| The three videos (lesson, quiz solution, assignment solution) | Paste a link, **حفظ**. A new video starts locked; he opens it from «الوصول للدروس» | Backend (Videos tab) |
| Quiz questions (multiple choice, true/false) | Add, edit, move, delete, **احفظ الأسئلة** | Backend (QuizContent tab) |
| Files (PDF, images, Word, PowerPoint, up to 15 MB) | Choose a file, give it a name, **ارفع**; delete with **امسح** | Drive (attachments folder) + the lesson's list on the backend (Attachments tab); the lesson page shows it |

No desktop app and no GitHub are needed. The server checks every save against his subjects (tests R-P25-B, R-P25-G).
The assignment page itself (its text, how students submit, its questions) stays yours. Fixed names keep this simple;
they are not a hard rule, and more can be opened to him later.

Two other ways still work, for you or a teacher who prefers them: the desktop Quiz Maker in teacher mode (same
limits: names read-only, no Generate, no new or deleted lessons), and pull requests that only change a lesson's
`attachments.json` (the check below).

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

1. Sign in on the site, open **«دروسي»**, pick the lesson.
2. Paste the video links and press **حفظ** next to each; add the quiz questions and press **احفظ الأسئلة**; upload the
   files. Students see it at once (a new video stays locked until he opens it).

## Pull requests (only if he uses GitHub)

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
