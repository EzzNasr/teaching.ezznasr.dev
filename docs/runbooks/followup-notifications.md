# Follow-up notifications (Telegram): runbook

*Follow-up v2, Session 2. Code: `tools/quiz-maker-v2/apps_script/FollowupNotify.gs`. Tests: `tests/test_fu2_notify.js`. Not run against a real Apps Script project; the tests use the repo's Apps Script mock with Telegram faked.*

Every hour a trigger asks the shared event engine "what is due?" and sends one Telegram message per group, session and event, **once**. Times are written "Alex" (the code computes in `Africa/Cairo`; people never read that word).

## Needs
- `Code.gs` + `FollowupRouter.gs` (S5) + `FollowupLogic.gs` (S3) + `FollowupNotify.gs` deployed together (see `followup-v2-deploy.md`).
- Script Properties `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_CHAT_ID` (one id or several, comma-separated; assistants go in the same list). These are the existing **payments bot** properties. Attendance's own bot is not used.

## Setup (once)
1. Deploy as a **new version of the existing deployment**.
2. In the Apps Script editor run **`fu2_notify_installTrigger`**. Authorise the `script.scriptapp` scope if asked. Running it again replaces the trigger (never two).
3. Send the test: in the editor run **`fu2_notify_sendTest`** (or call the admin-only action `admin_fu2_notify_test`). Every configured chat gets "Test from Follow-up" with a time and "Alex". If not, see "Nothing arrives".

## What a message means
Group names and lesson names appear as stored; the text is English.

| Message starts | Event | Do |
|---|---|---|
| 📋 mark attendance | `attendance` | Mark the last session's attendance |
| 👀 message the parents (video) | `parents_watch` | Open the walk-through, message parents |
| 📚 message the parents (homework/quiz) | `parents_hw` | Same. "N more waiting for attendance first" means mark attendance first |
| 🎬 remind the group to watch | `remind_watch` | Send the group reminder, then **Done** |
| 📝 remind the group about homework | `remind_hw` | Same |
| ⏭️ move the group on | `advance_lessons` | Confirm the next lesson on the page, then **Done** |
| ⚙️ set the weekday, time and current lesson | `setup_missing` | Fill the group's schedule |

Buttons: **Open** (the page at that group and step), **Snooze 1 day** (silences that group until tomorrow, Alex date), **Done** (only `remind_*` and `advance_lessons`; the others finish by themselves, and the button says "Nothing to mark" if tapped).

## Rules
- **Once only:** a row in `FollowupNotifications` (`group_key | session_date | event`) is written before sending. A new session date or a different event is a new message.
- **Quiet hours:** nothing is sent before 08:00 or from 22:00 Alex. An event that came due overnight goes out on the first tick from 08:00 (while it has not expired).
- **Per group:** `NotifySettings` has `enabled`, `hour` (default 16) and `snooze_until`. Disabled or snoozed groups get nothing but the page still shows their steps.
- **Up to an hour late:** the tick is hourly, so a 16:00 Alex event can arrive any time up to 17:00.
- **Silence when nothing to do:** count 0 never sends.
- **Telegram down:** the tick does not fail; if no chat accepted a message its log row is removed and the next tick retries.

## Sheets (created on first use, nothing existing is touched)
| Sheet | Columns |
|---|---|
| `FollowupNotifications` | group_key, group, session_date, event, fired_at, count |
| `FollowupDone` | group_key, kind (`watch`/`hw`/`advance`), session_date, marked_at, by |
| `NotifySettings` | group_key, enabled, hour, snooze_until, updated_at, updated_by |

Changes through the page or Telegram also write `AuditLog` rows (`fu2_mark_done`, `fu2_notify_settings`).

## Nothing arrives
1. Run `fu2_notify_sendTest`. No message: check `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, and that each person pressed Start on the bot.
2. Test works but ticks don't: Apps Script, Triggers: is there an hourly `fu2_notify_tick`? If not, run `fu2_notify_installTrigger`. Check Executions for errors.
3. Execution log says "Follow-up logic is not installed": `FollowupLogic.gs` or `FollowupRouter.gs` is missing from the project.
4. Outside 08:00 to 22:00 Alex: expected, wait.
5. Group snoozed or disabled: check the `NotifySettings` sheet (or `admin_fu2_notify_settings_get`).
6. It was already sent: look for the row in `FollowupNotifications`. To resend, delete that row.
7. Buttons do nothing: S5's webhook wiring (`fu` callbacks) is not deployed, or the webhook secret/admin id check fails.

## Limits
- Telegram quota: about 30 messages per second overall and 20 per minute into one group chat. Hourly ticks stay far under it.
- A very long group key (over about 40 characters) loses its Snooze/Done buttons (Telegram allows 64 bytes in a callback). The message and **Open** still work.
- Apps Script time-based triggers allow about 90 minutes of runtime a day on free accounts; each tick takes a few seconds.

## Turning it off
- One group: set `enabled` to FALSE in `NotifySettings` (or `admin_fu2_notify_settings_save`), or tap **Snooze** for a day.
- Everything: run **`fu2_notify_removeTrigger`**. Data stays; reinstall any time.
