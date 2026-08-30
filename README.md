# Quiz & Lesson Maker — teaching.ezznasr.dev

Restructures the site around a **lesson-centric** layout: each lesson is a
folder containing its own entry page, quiz, and assignment.

```
<subject>/
  index.html            subject page — lists lesson cards
  <lesson-slug>/
    index.html           lesson entry (video/content + links to quiz & assignment + Attachments)
    quiz.html             the quiz
    assignment.html       paste-text assignment submission
    attachments.json      empty manifest, ready for future file hosting
```

This replaces the old separate `quizzes/` and `assignments/` folders.

---

## 1. What to do with your existing repo first

1. Delete (or leave orphaned, your call) the old `programming/quizzes/`
   folder and the flat `Submit assignment` Google Form buttons on every
   subject page — all superseded by the lesson-folder pattern.
2. Copy `site-updates/programming-example/` over your real
   `programming/` folder, `site-updates/math-example/` over `math/`, and
   `site-updates/english-example/` over `english/`. All three are rebuilt
   on the new lesson-centric structure:
   - **Programming** ships with a working `functions/` lesson (quiz +
     assignment + the new empty Attachments section)
   - **Math** and **English** have no real lesson yet, so each shows its
     stat panel (students taught, countries, sessions run — still the
     placeholder em-dashes from before) plus a non-clickable "Planned"
     placeholder card under Lessons. Generate their first real lesson
     with the GUI and manually delete that placeholder card afterward.
3. Copy the contents of `quiz-maker/site-assets-dropin/` into your site's
   `/assets/` folder — this **replaces** `assets/quiz.js` and **adds**
   `assets/assign.js`. Both are root-referenced (`/assets/...`), so lesson
   folders can sit at any depth without breaking the path.
4. The **teaching landing page** (root `index.html` of the subdomain) and
   `main-site-updates/index.html` / `teaching.html` from earlier don't
   need structural changes — they only ever linked to subject pages, not
   into `quizzes/`/`assignments/` directly.

## 2. Attachments — scaffolded, not wired up yet

Every lesson the generator creates now includes:
- An **Attachments** section on the lesson's `index.html`, stamped
  "Coming soon," explaining files will be viewable inline once added
- An empty `attachments.json` manifest sitting next to `quiz.html` and
  `assignment.html` in the lesson folder

**The plan for when you're ready to wire it up:** files live in Google
Drive, and each lesson's `attachments.json` gets a `{title, drive_file_id,
type}` entry per file. The page renders each as an inline `<iframe>`
pointed at Drive's embeddable preview URL
(`https://drive.google.com/file/d/FILE_ID/preview`) — students view the
file directly on your site, never redirected to drive.google.com. No
upload endpoint or backend needed for this part; you'd just drop files in
Drive, grab the file ID, and add a line to the JSON. Say the word when
you want this actually built (the iframe rendering script + a small
`file → Drive → get link` runbook).

## 3. Running the generator

Requires nothing beyond the Python standard library (`tkinter` ships with
most Python installs — on Ubuntu/Debian if it's missing: `sudo apt install
python3-tk`).

```
cd quiz-maker
python3 quiz_maker.py
```

**First time:** click **Browse...** and point "Site location" at the local
folder that contains your `programming/`, `english/`, `math/` folders (your
cloned `teaching-site` repo — it needs an `assets/` folder and a `CNAME`
file inside it for the app to recognize it). This path is remembered for
next time; the app also tries to auto-detect it near wherever the tool
itself is running before falling back to asking you.

**Per lesson:**
1. Pick the subject, type the lesson name (this becomes the URL slug —
   "Loops & Iteration" → `loops-iteration`), a short description, and
   optionally a YouTube embed URL for the video.
2. Add questions either:
   - **+ Add question** — one at a time, with a form (options count 2–6,
     radio button for the correct answer, optional explanation)
   - **+ Bulk paste** — paste many at once in this format:
     ```
     Q: What does the def keyword do?
     A) Deletes a variable
     B) Starts a function definition *
     C) Defines a class
     D) Imports a module
     E: def marks the start of a function definition.
     ```
     `*` marks the correct option. Separate questions with a blank line
     or `---`. The `E:` explanation line is optional.
3. Click **Generate lesson files**. This writes the three lesson HTML
   files plus `attachments.json`, and either updates the subject's
   `index.html` (inserting a new lesson card, or replacing the existing
   one if you regenerate the same lesson — no duplicates) or creates that
   subject page from scratch if it doesn't exist yet.

**File → Save draft / Load draft** lets you save the current form
(including all entered questions) to a `.json` file and pick up later.

## 4. Data being recorded

Nothing is sent anywhere yet — both quiz and assignment submissions are
queued into the browser's `localStorage` under
`teaching_pending_submissions`, ready for a sync step once you build the
backend. Each entry:

**Quiz** (`type: "quiz"`):
```json
{
  "type": "quiz",
  "subject": "programming",
  "lesson": "functions",
  "quiz_title": "Functions",
  "name": "...",
  "email": "...",
  "date": "2026-08-16",
  "start_time": "2026-08-16T14:02:11.000Z",
  "end_time": "2026-08-16T14:05:47.000Z",
  "score": 4,
  "total": 5
}
```
`start_time` is captured when the student clicks "Begin quiz" (after
entering their name). `end_time` is captured the moment they answer the
last question and move to the score screen — the easiest reliable point
to record it without adding extra UI.

**Assignment** (`type: "assignment"`):
```json
{
  "type": "assignment",
  "subject": "programming",
  "lesson": "functions",
  "name": "...",
  "email": "...",
  "text": "...",
  "date": "2026-08-16",
  "submitted_time": "2026-08-16T14:10:03.000Z"
}
```

Both types share one queue/key so a future sync step can flush everything
in one pass. That backend (FastAPI + SQLite, WAL mode, hosted on your
droplet) is the next thing to build whenever you're ready — say the word.

**Important limitation to know now:** there is currently no real file
upload anywhere on the site. The assignment flow only accepts pasted
text. Real file handling (student-submitted files, not the Drive
attachments above) hasn't been designed yet — flag it when you want that
built and we'll figure out where those files should land.

## 5. Files in this package

```
quiz-maker/
  quiz_maker.py              the GUI generator — run this
  templates/                 HTML templates the generator fills in
  site-assets-dropin/
    quiz.js                  replaces your existing /assets/quiz.js
    assign.js                new — add to /assets/assign.js

site-updates/
  programming-example/       Programming subject rebuilt on the new
                              structure, including the Functions lesson
                              (generated by the tool itself)
  math-example/               Math subject rebuilt — stat panel kept,
                              placeholder "Planned" card, no real lesson yet
  english-example/            English subject rebuilt — same pattern
```
