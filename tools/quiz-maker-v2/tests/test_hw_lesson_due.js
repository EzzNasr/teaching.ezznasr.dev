// A homework lesson's own due date (lessons[path].due_override, set on its requirement card) must be the
// homework deadline the follow-up page shows and the Today-tab / Telegram reminder fires on.
// The bug (Nov 3): only the group override counted, so the page kept showing the computed date (Fri 6/11).
//   node tests/test_hw_lesson_due.js [repo-root]       (run from tools/quiz-maker-v2/; default root = ../..)
const path = require('path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..'));
const L = require(path.join(root, 'assets', 'followup-logic.js'));
const E = require(path.join(root, 'assets', 'followup-events.js'));
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + JSON.stringify(e))); };

const R1 = 'programming/baccalaureate/grade-1-secondary/chapter-2-lesson-1-variables';
const R2 = 'programming/baccalaureate/grade-1-secondary/chapter-1-lesson-4-loops';
const NOW = new Date('2026-11-03T12:00:00+02:00');           // Tue; the Sat 6pm group's computed hw date is Fri 6/11
const gs = (o) => Object.assign({ weekday: 6, time: '18:00', current_lesson: 'x', review_lessons: [R1], hw_lessons: null, quiz_lessons: null,
  watch_deadline_override: '', hw_deadline_override: '' }, o || {});
const ov = (lessons) => ({ settings: {}, lessons: lessons || {} });
const hw = (s, o) => { const d = L.groupDeadlines(s, NOW, {}, o).hw; return d && d.date; };

t('no lesson date: the computed date (Fri 6/11)', hw(gs(), ov()) === '2026-11-06', hw(gs(), ov()));
t('without the overview nothing changes (old callers)', hw(gs(), null) === '2026-11-06', hw(gs(), null));
t("the lesson's own date is the homework deadline", hw(gs(), ov({ [R1]: { due_override: '2026-11-04' } })) === '2026-11-04');
t('...also when it is later than the computed date', hw(gs(), ov({ [R1]: { due_override: '2026-11-09' } })) === '2026-11-09');
t('...and it is marked as set by hand', L.groupDeadlines(gs(), NOW, {}, ov({ [R1]: { due_override: '2026-11-04' } })).hw.overridden === true);
t('two homework lessons: the earliest due date shows',
  hw(gs({ review_lessons: [R1, R2] }), ov({ [R1]: { due_override: '2026-11-08' }, [R2]: { due_override: '2026-11-05' } })) === '2026-11-05');
t('one lesson later, the other on the computed date: the computed date shows, not marked',
  (function () { const d = L.groupDeadlines(gs({ review_lessons: [R1, R2] }), NOW, {}, ov({ [R1]: { due_override: '2026-11-09' } })).hw; return d.date === '2026-11-06' && !d.overridden; }()));
t('the group override still wins over a lesson date',
  hw(gs({ hw_deadline_override: '2026-11-07' }), ov({ [R1]: { due_override: '2026-11-04' } })) === '2026-11-07');
t('only homework/quiz lessons count (hw_lessons set elsewhere)',
  hw(gs({ hw_lessons: [R2], quiz_lessons: [R2] }), ov({ [R1]: { due_override: '2026-11-04' } })) === '2026-11-06');
t('a bad date on the lesson is ignored', hw(gs(), ov({ [R1]: { due_override: '4/11' } })) === '2026-11-06');

// The Today tab / Telegram homework reminder fires on the same day.
const g = { group: 'Sat 6pm', key: 'sat 6pm', settings: gs(), members: [] };
const full = Object.assign(ov({ [R1]: { path: R1, has_assignment: true, has_quiz: true, has_video: true, due_override: '2026-11-04' } }),
  { groups: [g], students: {}, facts: {}, flags: {}, parent_log: {} });
let r = null;
try { r = E.eventsFor(full, 'sat 6pm', '2026-11-03T12:00:00+02:00'); } catch (e) { r = { error: String(e) }; }
const rh = r && r.events && r.events.find(e => e.key === 'remind_hw');
t('homework reminder fires on the lesson date', !!rh && String(rh.fire_at_iso).slice(0, 10) === '2026-11-04', rh || r);

console.log('\n%d passed, %d failed', pass, fail);
process.exit(fail ? 1 : 0);
