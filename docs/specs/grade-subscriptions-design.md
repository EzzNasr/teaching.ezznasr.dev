> **As-of note (2026-10-30):** this started as a plan but the feature is now implemented. `Code.gs` has `get_subscription_options` and `request_subscription`, subscription scopes of the form `<grade folder>#chN` (chapter) and `<grade folder>#tN` (term), and `_subscriptionGradeSuffix`; the site has `assets/subscribe.js`. Treat this file as the **design rationale**, and the code as the source of truth for behaviour. Prices and scope in the text below may have changed.

# Grade Subscriptions — Lean Plan

Status (original): plan only.  **Updated 2026-10-30: this feature is now implemented** (see the note at the top).
Scope: `programming/baccalaureate`, Grade 1 (`grade-1-secondary`) and Grade 2 (`grade-2-secondary`) only.

---

## 1. Goal

Students buy access to videos by **chapter** (250 EGP each) or by the **current term** (1000 EGP) from a new section on the grade page, using the existing manual "I paid" flow. You still approve in the dashboard, but approval now sets scope and expiry automatically. Per-item video locking and the per-lesson "I paid" form are unchanged.

The whole feature hangs off one fact in `Code.gs`: every access check goes through `_scopeCovers(scope, lesson)` (called by `_accessState`), and the Payments/Entitlements sheets already store a `scope` string. So a chapter or term is expressed as a new kind of scope string, and almost everything else (expiry, revoke, dashboard lists, "payment cancelled switches access off") keeps working unchanged.

---

## 2. Decisions (final)

- Chapter = 250 EGP, one option per chapter, no repeat purchase of the same chapter, several can be bought (each is its own purchase).
- Term = 1000 EGP, only the current term (term 2 also 1000). Grade 1 Term 1 = chapters 1-8; Grade 2 Term 1 = 4 chapters; the rest is Term 2 (all derived from tags).
- Holding the term blocks buying chapters of that term. No partial upgrades; buying the term while owning chapters is allowed, both are kept, and access is granted if either covers the lesson.
- Access lasts until the grade's year-end date: script properties `YEAR_END_G1`, `YEAR_END_G2`, both `2027-08-01`.
- A script property per grade for the current term: `CURRENT_TERM_G1`, `CURRENT_TERM_G2` (default `1`).
- Lessons are tagged with chapter and term from the Tkinter app (editable later). A chapter option appears only if it has at least one tagged lesson.
- Untagged lessons are never affected: locked/unlocked by hand exactly as today.
- Clicking a grade tile behaves as today; a Subscriptions section is added to the grade page. RTL Arabic paywall styling reused; payment instructions unchanged.
- Approval stays manual. Existing manual/folder grants keep working. Both `Code.gs` copies are left as they are; the plan edits only `tools/quiz-maker-v2/apps_script/Code.gs`, so deployment stays a single paste (no bundle script needed).
- Booklets are deferred and not part of this plan.

---

## 3. Design

### 3.1 Scope strings
```
programming/baccalaureate/grade-1-secondary#ch3   -> chapter 3 of grade 1
programming/baccalaureate/grade-2-secondary#t1    -> term 1 of grade 2
```
Only those two grade folders are accepted. Existing scope forms (lesson path, `folder/*`, `*`) are untouched.

### 3.2 Tags storage: a new `LessonTags` tab
Columns: `lesson | chapter | term | updated_at` (lesson = full path like `programming/baccalaureate/grade-1-secondary/chapter-2-lesson-3-...`).

It must be a **new tab, not the existing `Lessons` tab.** In `Lessons`, a row means "explicitly gated" and new rows start locked, so writing tags there could accidentally change lock state.

Rules: chapter and term are whole numbers; all lessons of one chapter in one grade must share the same term (a conflicting tag is rejected); blank clears the tags; only lessons under the two grade folders are accepted.

### 3.3 Access check
`_scopeCovers(scope, lesson)` gains a branch for scopes containing `#`:
1. Split into base folder and tag (`ch<N>` or `t<N>`).
2. The lesson must be under the base folder.
3. Look up the lesson's tags (from `LessonTags`, cached per request so a loop over entitlement rows doesn't re-read the sheet).
4. `#ch3` matches when the lesson's chapter is 3; `#t1` matches when its term is 1. Untagged lessons never match.

Because tags are read at check time, a lesson added to Chapter 3 later is covered for existing holders automatically. A term holder covers every chapter of that term because those lessons carry that term tag.

`_normalizeScope` must also accept the `#ch`/`#t` suffix (today it runs `_lessonPath`, whose pattern rejects `#`). It is used by approve, grant, revoke and group grant/revoke, so all of them then handle the new scopes.

### 3.4 Expiry
On approval the entitlement gets an explicit `expires_at` = the grade's year-end date (through `_grantRaw`'s existing `explicitYmd`). Everything already built around `expires_at` (expired state, "days left", renew) works as is.
Trade-off: changing `YEAR_END_Gx` later doesn't move grants already approved. Optional five-line addition if you want the variable to always win: in `_accessState`, for `#` scopes ignore the row's `expires_at` and use the property. Off by default.

### 3.5 Purchase (new student actions)
`get_subscription_options {grade, student_id?, session_token?}` returns the chapters that have tagged lessons, the current-term option, prices, `year_end`, and per-item state for the signed-in student: `available`, `pending`, `owned`, `covered_by_term`.

`request_subscription {student_id, session_token, grade, item_type: "chapter"|"term", chapter?|term?, reference}` builds the scope string on the server, then inserts a normal **pending** Payments row:
- `scope` = the `#` scope string; `reference` = what the student typed; `note` = server-built label such as `Grade 1 · Chapter 3 · 250 EGP` (so the dashboard needs no new columns). The price is never taken from the client.
- Rules: chapter must have tagged lessons; reject if already owned or pending; reject if the student holds the term covering that chapter's term; term only for `CURRENT_TERM_Gx`, rejected if already held or pending.
- Requires a valid student session (existing check). Idempotent while pending. The legacy `MAX_PENDING_REQUESTS` (5) only applies to `request_access`; this action gets its own higher cap.

### 3.6 Approval
In `handleAdminDecidePayment`, when the payment's scope contains `#`: ignore the manual scope/duration inputs and grant that scope with `expires_at` = the grade's year-end. If the year-end date has already passed, reject with a clear error ("update YEAR_END_Gx first"). Reject and revoke work as today (`_grantRaw` and revoke are scope-agnostic string comparisons).

---

## 4. Frontend

### 4.1 Grade page (`assets_templates/subscribe.js`)
- Renders into a `<div id="subscriptions">` on the two grade `index.html` pages (mount + script tag added to the template that generates grade pages, and to the two live pages).
- Grade is read from the page path. Not signed in: short RTL prompt using the existing sign-in behavior. Signed in: call `get_subscription_options`.
- Cards: one per chapter returned (title, 250 EGP, state badge), plus "اشتراك ترم كامل" for the current term (1000 EGP). Owned shows "until <year_end>", pending shows waiting, covered shows a covered badge.
- Buying opens the same payment instructions block + reference field as `video.js`, then `request_subscription`, then the waiting state. One purchase per click.
- CSS is injected by the script (like `auth.js`/`video.js`). Registered in the asset script lists in `modules/common.py` and `check_asset_drift.py`; "Sync site assets" copies it to `assets/` and bakes in the endpoint.

### 4.2 Lessons
Unchanged.

---

## 5. Admin side

### 5.1 Dashboard (`dashboard/access.html`)
- Scope labels understand `#ch`/`#t` ("Grade 1 - Chapter 3", "Grade 2 - Term 1").
- For pending requests with a `#` scope: hide the scope radios and duration controls, show the label + note (amount) + reference, one-click Approve, Reject as today, and preview text "will be able to watch ... until <year_end>".
- The page's own `scopeCovers` copy (used only for "already has access" hints) treats `#` scopes as not covering; it only affects that hint.
- Access and history lists show the new labels; revoke works unchanged.

### 5.2 Tkinter app (`modules/tags_tab.py`, new tab "4. Lesson Tags")
- Lists the baccalaureate lessons found under the site root for grades 1 and 2 with their current chapter/term; edit inline; save through a new admin action `admin_set_lesson_tags {lesson, chapter, term}` using the existing bridge URL and token.
- Filter "untagged only" for the first pass. Blank both fields to clear. Show the server's conflict error as-is.

---

## 6. Tests
New file `tools/quiz-maker-v2/tests/test_subscriptions.js`, run on the existing harness:
- Tag set/edit/clear, conflicting term rejected, non-grade lesson rejected.
- `_scopeCovers`: chapter scope covers only that chapter's tagged lessons; term scope covers all lessons of that term; other grade never; untagged never; legacy scopes unchanged (regression).
- `_normalizeScope` accepts valid `#` scopes and rejects malformed ones.
- Purchase rules: duplicate, term-blocks-chapter, term allowed when chapters owned, non-current term rejected, empty chapter rejected, client price ignored, idempotent while pending.
- Approval sets scope and year-end expiry; year-end already passed is rejected; revoke removes only that row; term + chapter both kept.
- Access boundary: last day allowed, next day denied.
- Existing tests (`test_access.js`, `test_groups.js`, `test_revoke.js`, `test_videos.js`, `e2e_backend.js`) must pass unchanged.

---

## 7. Work chunks

Chunks 1 and 2 both edit `Code.gs`, so they run one after the other. Chunks 3 and 4 touch disjoint files, so they can run at the same time after chunk 2.

| # | Chunk | Files it edits (and only these) | Depends on |
|---|---|---|---|
| 1 | **Backend core:** `LessonTags` tab + `admin_set_lesson_tags`, tag lookup with per-request cache, `_normalizeScope`/`_scopeCovers` `#` support, year-end/current-term properties with defaults, approval auto scope + expiry, tests | `tools/quiz-maker-v2/apps_script/Code.gs`, `tests/test_subscriptions.js` | nothing |
| 2 | **Backend purchase:** `get_subscription_options`, `request_subscription`, rules, state values, dispatch entries, tests | same two files | 1 |
| 3 | **Grade page:** `subscribe.js`, mount + script tag in the grade template and the two live grade pages, asset lists, run Sync site assets | `assets_templates/subscribe.js`, `assets/subscribe.js`, `modules/common.py` (asset list only), `check_asset_drift.py`, the grade-page template, the two grade `index.html` files | 2 |
| 4 | **Admin tooling:** dashboard labels and one-click approval, Tkinter tags tab, register the tab | `dashboard/access.html`, `modules/tags_tab.py`, `app_main.py` (tab registration only) | 1 (2 for live testing) |

Sizing: chunks 1 and 2 are each a few dozen to ~100 lines of backend plus tests; chunk 3 is one script of roughly 200 lines plus small template edits; chunk 4 is targeted edits to `access.html` (not a rewrite) plus one new Python file. Every session should keep line endings as they are (repo uses CRLF), avoid reformatting, and touch only the files listed for its chunk.

---

## 8. Deploy checklist (after all chunks)
1. Paste the updated `Code.gs` into the Apps Script project; Deploy > Manage deployments > edit > new version (same `/exec` URL).
2. Set Script Properties: `YEAR_END_G1`, `YEAR_END_G2` (`2027-08-01`), `CURRENT_TERM_G1`, `CURRENT_TERM_G2` (`1`). Unset properties fall back to these defaults.
3. Run Sync site assets in the Tkinter app, commit and push.
4. Tag the lessons in the new Tkinter tab.
5. Smoke test with a test student: buy a chapter, approve, watch a video in that chapter, confirm another chapter stays locked, buy the term, revoke.
Recommended once: try steps 1-5 on a scratch Apps Script project with copied sheets first (the harness only mocks Apps Script).

---

## 9. Edge cases
- Chapter retagged after purchase: coverage follows the current tags (chapter holders keep whatever is tagged with that chapter now).
- Term flips (`CURRENT_TERM` 1 to 2): term-1 holders keep term 1 until year-end; the term option switches to term 2; individual chapters stay purchasable regardless of term.
- Session expired mid-purchase: existing re-login behavior; double tap is idempotent while pending.
- Approving after the year-end date: blocked with an error (3.6).
- A chapter with no tagged lessons never appears as an option and is rejected server-side.

## 10. Open items
1. Year-end date: 2027-08-01 for both grades, confirmed?
2. Expiry: stored at approval (default) or the optional check-time override so the variable always wins (3.4)?
