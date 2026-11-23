# Adding the second teacher: checklist

*Refactor Phase 2.5 (2026-11-23). Steps A to F are on `main`; this is what is left, in order. Everything here is done
by the owner. Publishing details: `teacher-publishing.md`.*

## 1. Before the backend deploy

- [ ] **Pepper.** Make a value (`npm run make:pepper`, or in PowerShell
      `node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"`) and add the script property
      `PASSWORD_PEPPER` in Apps Script > Project Settings > Script Properties. Keep a copy in your password manager.
      Set it once, never change it.
- [ ] **Admin token.** Replace `ADMIN_TOKEN` there with a new long random value, then put the same value in the Quiz
      Maker settings and the attendance dashboard.

## 2. Deploy the backend (with Claude, not during a class or an open quiz)

```bash
git checkout main && git pull
npm run deploy:backend          # dry run
npm run deploy:backend -- --yes # the deploy
```

This ships steps A (security), B (separation fix), C (science subject) and F (teacher revenue report) together.
Commit the new row the script adds to `docs/runbooks/backend-deploys.md`.

## 3. Make him a teacher

- [ ] He registers on the site like a student, with his own phone and a password of 8+ characters.
- [ ] Dashboard > Team «الفريق» > add > teacher > subject **Science**.
- [ ] His Quiz Maker key: in the Apps Script editor run `p4_mint_teacher_token("<his name>", "science")`, copy the key
      from the log (shown once) and give it to him privately. He pastes it into the Quiz Maker settings; the Quiz Maker
      then shows Science only.
- [ ] Optional: he links Telegram on «فريقي» so payment requests for Science reach him.

## 4. GitHub (for his lesson pages)

- [ ] Invite his GitHub account (Settings > Collaborators, role Write).
- [ ] In `.github/teachers.json` on `main`: put his account in `"github"`, his name in `"name"`, and rename the handle
      `science-teacher` if you like (his branches are `teacher/<handle>/...`). Keep `"auto_merge": false`.
- [ ] Ruleset on `main` and the Actions settings: `teacher-publishing.md`, "One-time setup".

## 5. Live trial (together with Claude)

A demo teacher account and demo data on the live site: sign in, add a video and a quiz question to one seeded lesson,
attach one file through a pull request, check «إيراداتي» and the downloaded report, check what he cannot do (rename a
lesson, add one, another subject, your students, your revenue page), then remove the demo account, demo rows and the
demo file.

## 6. His lessons

You seed them; he fills them in. The lessons of both grades (`science/preparatory/grade-3-preparatory/`, 3rd Prep,
and `science/secondary/grade-1-secondary/`, 1st Secondary, Integrated Science) come from
`tools/quiz-maker-v2/seeds/science.json` (`teacher-publishing.md`, "Seeding lessons"). He cannot rename, add or
delete a lesson; he adds the videos and quiz questions (backend, his token) and the files (`attachments.json`, pull
request).
