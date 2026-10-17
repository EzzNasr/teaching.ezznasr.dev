# WhatsApp format check (manual, ~10 minutes, needs a real phone)

Why: the messages use `*bold*` next to Arabic text and next to invisible bidi-isolate
characters (`U+2068` ... `U+2069`). Only a real WhatsApp can confirm that bold still works.
Use **your own number or a test contact** — never a real parent.

## Prepare
1. From `tools/quiz-maker-v2/` run `node tests/test_followup_templates.js` — must end with `0 failed`.
2. Open `tests/manual/followup-templates-demo.html` in a browser (it uses fake data only).
3. Pick a message in the drop-down; the green bubble shows how it will look; the green button
   is a `wa.me` link. Change the number inside the demo page (`201234567890`) to your own
   test number first (format: `20` + the last 10 digits, no `+`).

## Run on both phones
Do every row once on **Android** and once on **iPhone** (tick each box).

| Message (drop-down) | Android | iPhone |
|---|---|---|
| حصة لم تُشاهَد (`session_unwatched`) | ☐ | ☐ |
| مشاهدة ناقصة (`session_unfinished`) | ☐ | ☐ |
| شكر: مشاهدة (`session_done`) | ☐ | ☐ |
| واجب ناقص (`homework_missing`) | ☐ | ☐ |
| شكر: واجب (`homework_done`) | ☐ | ☐ |
| نتيجة الكويز (`quiz_mark`) | ☐ | ☐ |
| كويز ممتاز (`quiz_praise`) | ☐ | ☐ |
| غياب كويز (`quiz_absent`) | ☐ | ☐ |
| رسالة مجمّعة (`combined`) | ☐ | ☐ |
| تذكير للجروب (`group_reminder`) — copy, paste into any chat | ☐ | ☐ |

For each message, after WhatsApp opens (do not send before checking the screen):

1. **Bold** — the sender line, the lesson name, the student name, the numbers (`42%`,
   `7 من 10`) and the deadline are bold, and **no `*` characters are visible** anywhere.
2. **Bold around Arabic** — bold Arabic words (`فريق الدعم لبشمهندس عز نصر`, `يتعوّض`) are
   bold and the neighbouring words are not.
3. **Bold around the lesson name** — the English lesson name (`chapter 2 lesson 2 functions`)
   is bold *as a whole*, and the Arabic words next to it keep their order (nothing is
   scrambled, no stray `)` or `%` jumping to the other side).
4. **Emoji** — each emoji shows (not a box) and sits at the start of its line.
5. **Layout** — blocks are separated by exactly one blank line; no double gaps; the combined
   message shows one issue per block, in the order ▶️ 📝 ❓.
6. **Numbers** — `42%`, `7 من 10`, `18/10` read left-to-right and are not reversed (`24%`,
   `01 من 7`, `01/81` = fail).
7. **Send** it to yourself and look at it once more in the chat bubble (the sent bubble can
   render differently from the compose box).

## If bold breaks next to the isolates
Symptom: literal `*` characters show around the lesson name or the numbers, but plain
`*فريق الدعم*` is fine.

Fix without code changes: the library already has the switch. In the page that builds the
messages pass `settings.bidi_isolates = false` (or `isolates: false`) in the `ctx` given to
`compose()` / `composeFull()` — e.g. `{ ..., settings: { bidi_isolates: false } }` — and run
this check again. With isolates off, bold works but a Latin lesson name inside Arabic text may
reorder punctuation; row 3 and 6 above tell you whether that matters. **Report the result**
(which phone, which message, isolates on/off) so the dashboard can ship the right default.

## Report template
```
Android model / WhatsApp version:
iPhone model / WhatsApp version:
Bold with isolates ON : OK / BROKEN (which messages)
Bold with isolates OFF: OK / BROKEN / not needed
Other problems:
```
