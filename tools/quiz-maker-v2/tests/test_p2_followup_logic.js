// Session 2 logic rules: required vs optional quiz/homework, per-lesson due dates (R-009).
//   node tests/test_p2_followup_logic.js
const L = require('../../../assets/followup-logic.js');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + JSON.stringify(x))); };
const REV = 'programming/baccalaureate/grade-2-secondary/chapter-1-lesson-2-how-ai-works';
const NOW = new Date('2026-10-21T10:00:00Z');        // a Wednesday; next session Saturday => homework due Friday 23 Oct (still upcoming)
const student = { phone: '01000000002', name: 'Sara', parent_phone: '01234567890' };
const key = L.phoneKey(student.phone);
function ov(meta, facts) {
  const o = { settings: {}, students: {}, lessons: {}, facts: {} };
  o.students[key] = student; o.lessons[REV] = Object.assign({ path: REV, has_video: true, has_quiz: true, has_assignment: true }, meta || {});
  o.facts[key] = {}; o.facts[key][REV] = Object.assign({ homework: { submitted: false }, quiz: { taken: false }, quiz_open: true }, facts || {});
  return o;
}
const grp = extra => ({ group: 'G', settings: Object.assign({ weekday: 6, time: '18:00', current_lesson: '', review_lessons: [REV] }, extra || {}), members: [student] });
const sum = (meta, facts, gextra) => L.studentSummary(student, grp(gextra), ov(meta, facts), NOW);
const PAST = { hw_deadline_override: '2026-10-01' };

let s = sum({}, {}, PAST);
t('default (no flags): homework missing + quiz absent, both due', s.verdicts.homework[0].state === 'homework_missing' && s.verdicts.homework[0].due && s.verdicts.quiz[0].state === 'quiz_absent' && s.issues.length === 2, s.verdicts);
s = sum({ quiz_required: false }, {}, PAST);
t('R-009 quiz optional: no quiz issue, homework still counted', s.verdicts.quiz[0].state === 'quiz_optional' && s.issues.length === 1 && s.issues[0].key === 'homework_missing', s.issues);
s = sum({ homework_required: false }, {}, PAST);
t('R-009 homework optional: no homework issue, quiz still counted', s.verdicts.homework[0].state === 'homework_optional' && s.issues.length === 1 && s.issues[0].key === 'quiz_absent', s.issues);
s = sum({ quiz_required: false, homework_required: false }, {}, PAST);
t('R-009 both optional: nothing is missed, no primary action', s.issues.length === 0 && s.primaryAction.kind === 'none', s.primaryAction);
t('both optional: chips say «اختياري», not red', s.microChips.filter(c => c.key === 'homework' || c.key === 'quiz').every(c => /اختياري/.test(c.label) && c.tone === 'grey'), s.microChips);
s = sum({ homework_required: false }, { homework: { submitted: true, at: '2026-10-20' } }, PAST);
t('an optional homework that WAS submitted still earns the praise', s.verdicts.homework[0].state === 'homework_done' && s.praises.some(p => p.key === 'homework_done'), s.praises);
s = sum({ quiz_required: false }, { quiz: { taken: true, score: 9, total: 10 } }, PAST);
t('an optional quiz that WAS taken is a normal result (and a praise at 90%)', s.verdicts.quiz[0].state === 'quiz_taken' && s.praises.some(p => p.key === 'quiz_praise'), s.verdicts.quiz);
s = sum({ due_override: '2026-10-01' }, {}, {});
t('a lesson due date in the past makes the homework due even though the group deadline is upcoming', s.verdicts.homework[0].due === true && s.verdicts.quiz[0].due === true, s.verdicts);
s = sum({ due_override: '2099-01-01' }, {}, PAST);
t('a lesson due date in the future overrides an overdue group deadline (homework and quiz not due yet)', s.verdicts.homework[0].due === false && s.verdicts.quiz[0].due === false && s.verdicts.homework[0].state === 'homework_missing', s.verdicts);
s = sum({}, {}, {});
t('without a lesson due date the quiz is always due, the homework follows the group deadline', s.verdicts.quiz[0].due === true && s.verdicts.homework[0].due === false, s.verdicts);
const o2 = ov({ quiz_required: false }, {});
const g = L.groupSummary(grp(PAST), o2, NOW);
t('groupSummary: optional items are not counted as missing', g.hwMissing === 1 && g.quizAbsent === 0, [g.hwMissing, g.quizAbsent]);
const o3 = ov({ homework_required: false, quiz_required: false }, {});
const g3 = L.groupSummary(grp(PAST), o3, NOW);
t('groupSummary: both optional => zero missing', g3.hwMissing === 0 && g3.quizAbsent === 0 && g3.late === 0, g3);
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
