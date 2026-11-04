# Phase 3 operations (flags, assistant role, recovery tools, bulk access)

*Created 2026-10-30 from the Phase 3 hand-off notes, which were removed in the docs cleanup. The work is merged (commit `92ea5c7`) and the code now lives inside `Code.gs` under the `MERGED FROM Phase3_*.gs` sections. Checked against `Code.gs`; not run in a live Apps Script project.*

## Deploying
- Deploy `Code.gs` alone. Phase 3 (`Phase3_Flags`, `Phase3_Roles`, `Phase3_Recovery`, `Phase3_BulkAccess`) is merged into it. The files in `apps_script/chunks/` are source pieces and leftovers, not what you paste.
- Deploy with **Deploy, Manage deployments, pencil, Version: New version** (never "New deployment", which changes the `/exec` URL).
- Run `p3_setup_enable_followup_flags()` **once** in the Apps Script editor. It switches on the follow-up Script Properties (`FF_PARENT_LOG`, `FF_MONTHLY`, `FF_GRADING`). While they are off the server answers "Feature disabled" and the contact, monthly and grading UI stays hidden. Only `1` or `true` turns a flag on.

## Assistant role
- An assistant is a normal student account whose Students-sheet `role` cell says `assistant`. Add or remove it on `team.html`.
- `is_admin` stays blank, so every admin-only check still refuses them. Their only extra access is the allow-list `P3_STAFF_ALLOW` (13 follow-up, summary and grading actions). Everything else is denied by default.
- The role is re-read from the sheet on every call, so removing it takes effect on the next call.
- Client role checks (`staff-guard.js`) are convenience only. The server decides every call.
- Assistants can see student and parent phone numbers in the follow-up page.
- An assistant gets a **new token on every login**, so signing in on a second device signs out the first (admins keep theirs). See `Docs/00-start-here/KNOWN-ISSUES.md (outside the repo)` for how to change that.

## Recovery tools (run from the Apps Script editor)
- `p3_diagnose_submissions()` writes a `RecoveryReport` describing submissions that look incomplete.
- `p3_restore_submissions({days, dry_run})` re-imports from Drive. **Dry run is the default.** Use `{days: 30, dry_run: false}` to apply.
- `p3_admin_backfill_submission({student, lesson, score, total, note, force?})` adds one audited row (source `manual-backfill`, in a new `source` column).

## Bulk access
`dashboard/access.html` has a **Bulk access** tab: pick lessons, groups and students, Preview (counts), Apply, then check "Who has access". "Take away" has a matching "Give these back" that restores members individually with their old end date (group rules are not restored; re-grant through the group). Granting with `days` re-extends on every rerun. If the server lacks the bulk-access code, the page says so.

## Upload screen
See `upload-guard-and-assistant-role/README.md`.

## Tests
`scripts/test_all.sh` (and `--e2e`, `--strict`): see `TESTING.md`. Known failing cases: `Docs/00-start-here/KNOWN-ISSUES.md (outside the repo)`.
