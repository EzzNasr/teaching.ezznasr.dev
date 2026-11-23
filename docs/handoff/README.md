# Handoff guide

*Written 2026-11-16 from a full read of the repo at `32436a7`. For a developer taking over or joining the project.
Where this guide and the code disagree, the code wins: tell the owner and fix the page.*

## What this project is

A teaching portal for one teacher's courses (programming, math, English) with about 18,000 lines of backend and
about 28,000 lines of site code, built and run by one person. It has five parts:

| Part | What it is | Runs on | Source |
|---|---|---|---|
| **Site** | Static HTML / CSS / JS, no framework, no build step | GitHub Pages (`main`, custom domain in `CNAME`) | repo root: `index.html`, `programming/`, `math/`, `english/`, `dashboard/`, `attend/`, `assets/`, `contract/` |
| **Backend** | One Google Apps Script web app, one `/exec` URL, Google Sheets as the database, Drive for files | script.google.com (runs as the owner's Google account) | `tools/quiz-maker-v2/apps_script/*.gs` (8 files) |
| **Quiz Maker** | Python desktop app that generates lesson pages and uploads content | the owner's PC only | `tools/quiz-maker-v2/` |
| **WhatsApp sender** | Node + Baileys loop that sends queued parent messages | a spare Android phone (Termux) at home | `tools/wa-sender/` |
| **Telegram bots** | Notifications and Approve / Reject buttons (payments, attendance devices, follow-up) | Telegram, webhooks into the backend | inside the `.gs` files |

Nothing deploys anything else. The backend is deployed with clasp by `npm run deploy:backend` (since 2026-11-16,
[runbook](../runbooks/backend-deploy.md)); before that it was pasted by hand into the Apps Script editor.

## Reading order

| # | Read | Why | Time |
|---|---|---|---|
| 1 | [system-diagrams.md](system-diagrams.md) | The whole system in pictures: parts, deploys, request flow, data model, main sequences | 20 min |
| 2 | [../ARCHITECTURE.md](../ARCHITECTURE.md) | The design rules every feature follows, and the new-feature checklist | 10 min |
| 3 | [feature-catalogue.md](feature-catalogue.md) | Every feature: page, script, backend actions, tabs, switches, tests | 30 min |
| 4 | [backend-reference.md](backend-reference.md) | Every backend action, sheet tab, Script Property and trigger | reference |
| 5 | [security-model.md](security-model.md) | How identity and permissions work, and the risk areas (no exploit detail: the repo is public) | 15 min |
| 6 | [../TESTING.md](../TESTING.md), [../REGRESSION.md](../REGRESSION.md) | The test gate and all 155 registered cases (153 active), including the two refactor guards | 10 min |
| 7 | [refactor-log.md](refactor-log.md) | What the refactoring has changed so far, step by step, with the commit to revert | 5 min |
| 7b | [teacher-publishing.md](teacher-publishing.md), [second-teacher-checklist.md](second-teacher-checklist.md) | How another teacher publishes lessons (checked pull requests) and the owner's steps to add one | 10 min |
| 8 | [../attendance/](../attendance/README.md), [../whatsapp/](../whatsapp/README.md), [../runbooks/](../runbooks/) | Per-feature decisions, deploy records, operations | as needed |

Private documents (outside the repo, in the owner's `Docs/` folder; ask the owner):

| Document | What |
|---|---|
| `Docs/02-plans/active/engineering-handoff/SECURITY-REVIEW.md` | Every known vulnerability with severity, evidence and fix |
| `Docs/02-plans/active/engineering-handoff/REFACTORING-PLAN.md` | The staged refactoring plan |
| `Docs/02-plans/active/engineering-handoff/TESTING-AND-CI-PLAN.md` | Test suite and GitHub workflow plan |
| `Docs/02-plans/active/engineering-handoff/RECOMMENDED-FEATURES.md` | Proposed features, for the owner to prune |
| `Docs/00-start-here/KNOWN-ISSUES.md` | Open functional issues and owner decisions waiting |

## Run it locally

```bash
# 1. The test gate (Node 18+, Python 3.10+). Fast part: seconds.
bash scripts/test_all.sh

# 2. Everything, as CI runs it (pinned jsdom, Playwright, Pillow, plus Chromium).
npm ci && pip install -r requirements-dev.txt && python -m playwright install chromium
PYTHONIOENCODING=utf-8 bash scripts/test_all.sh --strict --e2e --require-all

# 3. The site: any static server from the repo root.
python -m http.server 8000
```

Open any staff page with `?mock=1` (for example `http://localhost:8000/dashboard/followup.html?mock=1`): it runs on
sample data and saves nothing. There is **no staging backend**: without `?mock=1` a local page talks to the live one.

## Things that surprise people

1. **The backend source in the repo is not what is live** until someone deploys it. Use the deploy script
   ([runbook](../runbooks/backend-deploy.md)): it compares every live file first and stamps the commit, so
   `node scripts/smoke_live.js` prints which commit is live. Hand-pasted deploys drifted twice (see
   `docs/attendance/decisions.md`, Versions 61 and 66). Never `clasp push` on its own: triggers run saved code.
2. **`Code.gs` is 10,374 lines and partly assembled.** Phase 2, 3 and 4 code was written as separate files and merged in
   under `// ===== MERGED FROM <file> =====` banners. `chunks/Phase4_*.gs` are the Phase 4 sources;
   `scripts/p4_wire.py` wired them in. Only the 8 top-level `.gs` files are deployed.
3. **Shared site scripts exist twice.** `tools/quiz-maker-v2/assets_templates/*.js` is the source; `assets/*.js` is the
   published copy made by the Quiz Maker's "Sync site assets". A test (R-021) fails when they differ.
4. **`FollowupLogic.gs` is generated** from `assets/followup-events.js` by `scripts/build_server_logic.py`. Edit the
   source.
5. **One lock for everything.** Quizzes, homework, payments and attendance share one Apps Script script lock and about
   30 concurrent executions.
6. **Three identity schemes** (student / staff session, admin and teacher tokens, attendance teacher tokens). See
   [security-model.md](security-model.md).
7. **Time is Cairo time** (the UI says "Alex"), weeks run Saturday to Friday. Tests set the clock; handlers must not
   read a second time source.
8. **The repo is public.** No secrets, no personal data, no open vulnerabilities in it. Screenshots use sample data.
9. **Lesson identity is the folder path** (`programming/baccalaureate/grade-2-secondary/chapter-1-lesson-3-...`).
   Old rows hold bare slugs; always compare through `p2k_canon` / `p2k_same`.
10. **Sheets columns are append-only** and found by header name. Never reorder or rename a column.

## First-week checklist for a new developer

- [ ] Clone, run the full gate locally, get **ALL GREEN**.
- [ ] Open five staff pages in `?mock=1` and the attendance pages; read the screenshots in the root `README.md`.
- [ ] Read access to the Apps Script project and the two spreadsheets (owner grants it). Compare the editor files with
      the repo and record the result in `docs/attendance/decisions.md`.
- [ ] Read the private `SECURITY-REVIEW.md` and agree with the owner which items come first.
- [ ] Turn on branch protection for `main` (see the private CI plan) before your first change.
- [ ] Ship one small change end to end: test first, backend, self-tests, site, live smoke test (`--live`).

## Glossary

| Term | Meaning |
|---|---|
| Owner | The teacher who owns the site (`is_admin` on his Students row). Called "admin" in older code. |
| Teacher | Another teacher with his own subjects (`role = teacher`, scope = subjects). Phase 4. |
| Assistant | Owner's assistant (unscoped, Phase 3) or a teacher's assistant (scoped, "sassistant", Phase 4). |
| Entitlement | A row that gives one student access to a lesson, chapter or term, with an optional expiry. |
| Scope | For access: a lesson path, `...#chN` (chapter) or a term. For teachers: the list of subjects. |
| Center / online | Attendance modes on the follow-up page. "Center" also gives free access to that lesson. |
| Follow-up v2 (FU2) | The "what is the next step?" page, hourly Telegram reminders, requirements. `admin_fu2_*`, `admin_req_*`. |
| Phase 2 / 3 / 4 (P2, P3, P4) | Release waves: P2 lesson keys, camera answers, grading; P3 flags, roles, recovery, bulk access; P4 teachers and scopes. Function prefixes `p2_`, `p3_`, `p4_`. |
| Registry | `tools/quiz-maker-v2/tests/registry.json`: the single list of test cases, ids `R-...`. |
| The gate | `scripts/test_all.sh`: the one command that must be green. |
| D# / F# | A numbered decision / follow-up in a feature's `decisions.md`. |
