# Integration log

## Integration 1 (2026-10-21): S1 + S4 + S5-hour0 on top of repo HEAD d2bef69
Merge order S5 -> S1 -> S4. Code.gs = S1's (alias reads) + S5's router block + three S4 routes.

### Deviations from the contract, and how each was settled
| # | Found | Settled |
|---|---|---|
| 1 | S1 put the resolver in Code.gs (`_canonKey`, `LESSON_ALIASES`), not `p2k_*`/`P2_LESSON_ALIASES` | Added `P2_LESSON_ALIASES` + `p2k_canon/aliases/same` to Phase2_Keys.gs as a literal mirror; test_keys + R-001b fail if the three copies (Code.gs, Phase2_Keys.gs, assets/lesson-aliases.json) drift |
| 2 | Bare slug mapped to bare slug (S1) vs full key (contract) | Full key everywhere (one-line change in Code.gs, JSON, S1's test). Equivalent for the slug join |
| 3 | S1 router called `handleAdminMigrateLessonKeys` directly; request `apply:true` | Router goes through `_p2Call`; `p2_admin_migrate_lesson_keys` accepts `dry_run:false` or `apply:true`, adds contract field names, writes an AuditLog row on apply |
| 4 | S4 handlers were `handleAdmin*`, not `p2_*`; no flag; 3 extra actions unrouted | `p2_*` wrappers in Phase2_Grading.gs; queue and grade behind FF_GRADING; models + image not gated; 3 router cases added |
| 5 | S4 used `_canonLesson` (undefined) so old-key rows were not matched with S1's Code.gs | `_gCanon` now calls `p2k_canon` |
| 6 | Two AuditLog formats (S4: who/when/action/before/after; contract: at/who/action/target/before/after) | `_gAudit` delegates to `p2_audit`; one header, in the DATA spreadsheet |
| 7 | **Bug**: grading queue filtered on `student_id`, and `AuthEngine.adminCall` overwrites `student_id` with the admin: queue empty and grades not found under a real login (tests used token auth) | Handlers and grading.html use `student`; contract v1.3 rule: admin handlers never read `student_id` as a target. Guarded by R-I01 |
| 8 | WrittenAnswers: contract `student`, S4 `student_id` | Contract amended to S4's columns (`student_id`, `kind`, `graded_by`; S3 appends `uploaded_at`). S3 MUST write these |
| 9 | S1's access.html fix did not touch the grants-by-lesson list (the one in the screenshot); it sorted by key text, so Lesson 10 sorts before Lesson 2 | Sorted by chapter/lesson number (rank-3 scopes). R-004 browser test fails on S1's version, passes now |
| 10 | Phase2 prefix rule vs S1/S4's shipped names | Waived by an explicit name list in test_phase2_core.js; new unprefixed names still fail |

### Not fixed here (pre-existing)
R-E17, R-E19, R-E20 (browser) fail identically on the untouched repo in the sandbox: a YouTube iframe never becomes visible, and an old `<h1>` text. Not caused by Phase 2.

## Integration 2 (2026-10-21): S2 on top of integration 1 (S3 not yet delivered)
Cumulative zip against repo HEAD d2bef69. S2 touches no file of S1, S4 or S5; it replaces six existing follow-up files (`followup-app/logic/templates.js`, `followup.css`, `followup-overview.json`, `e2e_followup.py`).

| # | Found | Settled |
|---|---|---|
| 11 | S2 handlers were `handleAdmin*` / `P2FU_*`: not contract names, and the prefix check failed | Renamed to `p2_*`, `_p2fu*`, `P2_FU_*` (mechanical, in the .gs and its three Node tests and the browser test) |
| 12 | S2 kept its own flag reader and a plain-Error "turned off": no `disabled:true` | `_p2fuFlag` -> `p2_flag`, `_p2fuNeedFlag` -> `p2_requireFlag`. Only `1` / `true` turn a flag on (S2 also accepted yes / on) |
| 13 | S2 wrote its own `AuditLog` (who, when, action, before, after) into the Students spreadsheet: a second log | `_p2fuAudit` -> `p2_audit`; one header, DATA spreadsheet. `who` is `token` for the desktop app (was `desktop-token`) |
| 14 | S2 resolved lesson keys with its own fallback list | `_p2fuCanon` asks `p2k_canon` first (S2's list stays only as a last resort) |
| 15 | S2 asked for the two existing follow-up actions to be re-pointed; pointing them straight at the new handlers would turn them into "not implemented" if `Phase2_Followup.gs` is not pasted | New `_p2CallOr` in Phase2_Core.gs: new handler if present, otherwise the old one |
| 16 | S2 said "all other suites green", but `test_followup.js` asserted the OLD center rule (never expires, no week confirmation): 4 failures once the router was wired | Updated those assertions to the weekly rule (expires on the week's Friday; bulk center sends `week_confirm`). This is the intended R-010 change, not a regression |
| 17 | S2's backend test wrote a temp copy of Code.gs and deleted it at the end; pointed at the real file by the full harness it deleted `Code.gs` | The test now loads Code.gs directly and deletes nothing |
| 18 | `ParentNotifications` has no `id` (keyed by student, kind, ref) | Contract amended (v1.4), not the code |

New: `test_integration_s2.js` (R-I02, 24 checks). R-007..R-013 are now active (S2's suites). R-010 flipped from pending to active: the center weekly rule passes.

### Still open after integration 2
- S3 (R-014..R-016): capture, deferred answers, `get_quiz_review`, `upload_written_image`, `Phase2_Capture.gs`. Not integrated. The seams already known from S4 (`WrittenAnswers` columns, multi-photo answers, `kind`, one spreadsheet) are in `handoff/S4-to-S3.md` and `handoff/S5-to-S3.md`.
- R-019 (RTL) is covered for S2's pages only; R-022 (audit coverage across features) has no combined test yet.
- R-E17, R-E19, R-E20 are unchanged from integration 1.

### Waiting on
S2 (R-007..R-013, R-010 center-week) and S3 (R-014..R-016). When they arrive: run the same loop (overlap check, contract diff, registry, e2e).

## Integration 3 (S3 capture + deferred answers), Oct 22
Base: original repo + integration-2 pack. Overlaid S3's client files (quiz.js, assign.js, capture.js, dash-review.js and templates), tests, `strip_embedded_answers.py`; `capture.js` added to the two sync lists (1 line each, drift check: In sync).

| # | Seam | Resolution |
|---|---|---|
| 19 | S3 names | `handleUploadWrittenImage` / `handleGetQuizReview` -> `p2_upload_written_image` / `p2_get_quiz_review`; get_quiz/upload hooks -> `p2c_decorate_quiz` / `p2c_prepare_quiz_payload`; all other globals `_p2c*` / `P2_C_*`; own `_p2Flag` removed (uses `p2_flag`, `p2_requireFlag`) |
| 20 | Router | only two lines changed in Code.gs: `get_quiz` and `upload_quiz_result` go through `_p2Post` / `_p2Pre` (new in Phase2_Core.gs; no-ops if Phase2_Capture.gs is not pasted) |
| 21 | WrittenAnswers | one tab, in `_dataSs()` (next to QuizResults), created by S4's `_gAnswersSheet()`; extra columns `uploaded_at`, `image_ids`. S4 (`Phase2_Grading.gs`) and S2 (`Phase2_Followup.gs`) now read it from there; S2 reads `student_id` (its test seeded `student`) |
| 22 | submission_id | `c:<client_id>` = QuizResults/Submissions `dedupe_key`, which S4 looks up; `kind` written (`quiz` / `homework`) |
| 23 | Score rule | submit sends auto-graded score/total only; S4 adds awarded/max when graded. A written answer with no photo is final: its max counts in total, 0 awarded |
| 24 | Photos | up to 3 per answer (comma list); S4 `get_written_image` takes `index`; queue items carry `image_count`; S4 also sets `is_correct` in questions_json |
| 25 | Old seeds | test_grading, test_integration_s1_s4, test_p2_followup seeded WrittenAnswers in the Students spreadsheet: moved to DATA (deliberate) |
| 26 | S3 tests | assertions updated for the contract: disabled-flag reply, total without pending written marks (test_capture.js, e2e_capture.py) |

New: `test_R015_R016_review.js` (19 checks: R-015/R-016 plus the S3 submit -> S4 grade -> review chain and R-018). Registry: R-014 (+R-014b client, R-014e browser), R-015, R-016 active.

Not done: R-019 (RTL) and R-022 (audit coverage) still TODO; S3 did not deliver `dashboard/student.html`; legacy quiz pages still embed answers (`strip_embedded_answers.py` lists them); FF_CAMERA / FF_DEFERRED_ANSWERS stay OFF until that is done.

## Integration 4 (Oct 22)
- Added R-022 (tests/test_R022_audit_coverage.js): found that grants/revokes/quiz-lock/group grants were NOT audited; added _p2AuditWrap in Phase2_Core.gs and wrapped 10 router cases in Code.gs.
- Added R-019 (tests/e2e_R019_rtl.py): found grading.html overflowed 12px sideways at 375px; nav now wraps.
- grading.html: multi-photo display (get_written_image index/count).
- R-I01: dry-run assertion narrowed to "no migrate_lesson_keys audit row".
- Gate: run_registry --strict 44 PASS; --e2e 52 PASS + 3 sandbox-only FAIL (R-E17/19/20).
