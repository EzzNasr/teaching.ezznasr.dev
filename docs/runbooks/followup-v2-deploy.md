# Follow-up v2: deploy, order, rollback

> **Integration note (2026-11-03).** Follow-up v2 is now merged on top of the math-teacher rollout (Phase 4). Use the
> deploy order in `Docs/00-start-here/INTEGRATION-REPORT.md (outside the repo)` section 7. Two behaviours below changed during integration:
> the one-group rule is **per teacher** (a student may be in one owner group and one math group), and Telegram
> times are 12-hour ("4:05 PM Alex"). Teachers may call `admin_fu2_mark_done` on their own groups only.

*Session 5 (core wiring). Checked against the repo snapshot with the Node mock of Apps Script and a local browser; not run in a real Apps Script project.*

## What ships
| File | What it is |
|---|---|
| `apps_script/Code.gs` | **Edited** (every change is marked `// FU2:`, see "Rollback") |
| `apps_script/FollowupRouter.gs` | New (S5): routing, internal overview, monthly requirements |
| `apps_script/FollowupNotify.gs` | New (S2): Telegram notifications |
| `apps_script/Requirements.gs` | New (S4): requirements catalogue |
| `apps_script/FollowupLogic.gs` | New, generated (S3): shared event logic. Run `python scripts/build_server_logic.py` first |
| site files | `dashboard/*.html`, `assets/*` from all five sessions |

Each `.gs` file works without the others: a missing file only means its feature is missing (no notifications, requirements at today's defaults, and so on).

## Before you start
1. **`ADMIN_TOKEN` must be set** in Script Properties (it already is: the desktop app uses it). The hourly notification tick builds its overview with it; without it the tick stops with "Not authorized".
2. For Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` (the existing payments bot; see `followup-notifications.md`). The `fu:` buttons use the same webhook as the payment buttons.

## Order
1. Copy the five patch folders over the repo (no overlaps). Merge the `registry.fragment.s*.json` files into `tests/registry.json`.
2. Run the checks: `python scripts/build_server_logic.py --check`, the whole Node suite, then the Playwright e2e files.
3. In the Apps Script editor: replace `Code.gs`, add the four new files (`FollowupRouter.gs`, `FollowupNotify.gs`, `Requirements.gs`, `FollowupLogic.gs`). One global scope, so file order does not matter.
4. **Deploy, Manage deployments, pencil, Version: New version, Deploy.** Never "New deployment": it creates a new `/exec` URL and breaks every URL in the shipped JS.
5. Run **`fu2_notify_installTrigger`** once (authorise the scopes when asked), then **`fu2_notify_sendTest`**. The Telegram message must arrive and say "Alex".
6. **Check for students in two groups** before relying on the new rule: open the Groups tab of the access dashboard (admin). A yellow banner lists them, or call `admin_fu2_group_duplicates`. Fix each by opening the group you want to keep and adding the student there, then confirming "Move".
7. Open the follow-up page, the requirements page and one student's monthly report on a phone.

## What changed in behaviour
- **One group per student.** `admin_group_add` (single, bulk, and the roster picker) answers `{ok:false, code:"in_other_group", from, conflicts}` and changes **nothing** when a student is already in a different group. With `move:true` they are moved (all or nothing, under the lock) and an `AuditLog` row `group_move` is written. A group left empty forgets what it was giving, like `admin_group_remove`. Moving does **not** take away access the student already has from the old group.
- **The access dashboard** asks "Move them?" before moving, shows "in <group>" next to a student's name in the add picker, and (admin only) shows a banner when someone is in two groups.
- **Monthly report** gets a "Requirements" section (`summary.requirements`). A month marked **sent** or **closed** keeps the figures as they were when it was marked (new `MonthlyReviews.requirements_json` column, added by the code on first use). Marking it back to pending/ready clears the snapshot. A month that was marked sent **before** this release has no snapshot and shows "no saved copy" instead of new numbers.
- **Assistants** may call 8 more actions (`admin_fu2_mark_done`, `admin_fu2_notify_settings_get/save`, `admin_req_get/save_global/save_group/check/history`). `admin_fu2_notify_test` and `admin_fu2_group_duplicates` stay admin only.
- Overview: `admin_followup_overview` gains `tz_label`, `groups[].done/notify/requirements` and `unclassified_requirements` (filled by S2 and S4 when installed).

## Rollback
Fastest: deploy the previous Apps Script version (Manage deployments, Version). New sheets and the `requirements_json` column are additive and harmless to old code.

Partial, in `Code.gs` (search for `FU2`):
| Marker | Comment it out to remove |
|---|---|
| `handleTelegramUpdate`: `isFu` | the `fu:` Telegram buttons (the regex goes back to `ap|rj|ad|dd`) |
| `doPost` `default:` | all `admin_fu2_*` / `admin_req_*` routing |
| `P3_STAFF_ALLOW` tail | assistant access to the 8 actions |
| end of `p2_admin_followup_overview` | the overview hooks |
| `handleAdminGroupAdd`: `_fu2Move` / `_fu2Conflicts` | the one-group rule (everything returns to "can be in several groups") |
| `_p2fuSummaryFor` tail, `p2_admin_monthly_review`, `_p2fuMonthlyMark` | the requirements section and snapshots |

Also remove the trigger: run `fu2_notify_removeTrigger`.

## Existing tests that changed (on purpose)
- `test_p3_roles.js`: the allow-list is now the 13 Phase 3 actions + the 8 follow-up v2 ones (21).
- `test_groups.js`, `test_p3_bulk_access.js`: they built "a student in two groups" with `admin_group_add`, which is no longer allowed. They now write that legacy row directly (data written before this release can still have it), or pass `move:true`.
- Failing before this release too (not caused by it): `R-014`, `R-P3-R1`.
