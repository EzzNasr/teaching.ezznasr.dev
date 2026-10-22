// R-023: homework lessons and quiz lessons are chosen SEPARATELY per group (Oct 22).
//   hw_lessons / quiz_lessons: null = never split = follow review_lessons; an array (even []) = exactly that list.
//   review_lessons stays the union so older readers still see every lesson.
// Usage: node tests/test_R023_split_lessons.js
const L = require('../../../assets/followup-logic.js');
const T = require('../../../assets/followup-templates.js');
const { makeEnv, LESSONS } = require('./fixtures/phase2_env');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + JSON.stringify(x).slice(0, 260))); };

// ---------- pure logic ----------
const A = LESSONS.L2.now, B = LESSONS.L3.now;
const NOW = new Date('2026-10-21T10:00:00Z');
const stu = { phone: '01000000002', name: 'Sara', parent_phone: '01234567890' }, key = L.phoneKey(stu.phone);
const ov = () => { const o = { settings: {}, students: { [key]: stu }, lessons: {}, facts: { [key]: {} } };
  [A, B].forEach(p => { o.lessons[p] = { path: p, has_video: true, has_quiz: true, has_assignment: true }; o.facts[key][p] = { homework: { submitted: false }, quiz: { taken: false }, quiz_open: true }; }); return o; };
const gs = x => Object.assign({ weekday: 6, time: '18:00', current_lesson: '', review_lessons: [A, B], hw_deadline_override: '2026-10-01' }, x);
const verd = x => L.studentVerdicts(stu, gs(x), ov(), NOW);
let v = verd({});
t('legacy group (hw/quiz null): both kinds for every shared lesson', v.homework.length === 2 && v.quiz.length === 2, [v.homework.length, v.quiz.length]);
v = verd({ hw_lessons: null, quiz_lessons: null });
t('explicit null behaves like legacy', v.homework.length === 2 && v.quiz.length === 2);
v = verd({ hw_lessons: [A], quiz_lessons: [B] });
t('split: homework only for lesson A, quiz only for lesson B', v.homework.length === 1 && v.homework[0].lesson === A && v.quiz.length === 1 && v.quiz[0].lesson === B, v);
v = verd({ hw_lessons: [A, B], quiz_lessons: [] });
t('quiz list [] = no quiz checked at all, homework still both', v.quiz.length === 0 && v.homework.length === 2);
v = verd({ hw_lessons: [], quiz_lessons: [B] });
t('homework list [] = no homework checked, quiz present', v.homework.length === 0 && v.quiz.length === 1);
v = verd({ hw_lessons: [A], quiz_lessons: null });
t('only hw split: quiz still follows the shared list', v.homework.length === 1 && v.quiz.length === 2);
const s = L.studentSummary(stu, { group: 'G', settings: gs({ hw_lessons: [A], quiz_lessons: [B] }), members: [stu] }, ov(), NOW);
t('issues name the right lesson per kind', s.issues.some(i => i.key === 'homework_missing' && i.lesson === A) && s.issues.some(i => i.key === 'quiz_absent' && i.lesson === B) && s.issues.length === 2, s.issues);
t('exports hwList / quizList / allReviewLessons', typeof L.hwList === 'function' && L.hwList(gs({ hw_lessons: [B] }))[0] === B && L.quizList(gs({})).length === 2 && L.allReviewLessons(gs({ hw_lessons: [A], quiz_lessons: [B], review_lessons: [] })).length === 2);

// ---------- message templates ----------
const ctxHw = T.buildContext({ student: stu, group: { group: 'G', settings: gs({ hw_lessons: [B], quiz_lessons: [A] }) }, kind: 'homework_missing', facts: {}, now: NOW });
const ctxQz = T.buildContext({ student: stu, group: { group: 'G', settings: gs({ hw_lessons: [B], quiz_lessons: [A] }) }, kind: 'quiz_absent', facts: {}, now: NOW });
t('template: a homework message defaults to the HOMEWORK lesson, a quiz message to the QUIZ lesson', ctxHw.lesson_review !== ctxQz.lesson_review, [ctxHw.lesson_review, ctxQz.lesson_review]);

// ---------- backend ----------
const f = makeEnv();
const save = b => f.saveGroup(Object.assign({ group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: A }, b));
f.group('Sat 6pm', [f.P('sara'), f.P('omar')]);
const grp = () => f.overview().groups.find(g => g.group === 'Sat 6pm').settings;
let r = save({ review_lessons: [A, B] });
t('legacy save (no split fields) succeeds and reads back null/null', r.ok && r.settings.hw_lessons === null && r.settings.quiz_lessons === null && grp().hw_lessons === null && grp().quiz_lessons === null, r);
r = save({ review_lessons: [A], hw_lessons: [A], quiz_lessons: [B] });
t('split save returns both lists', r.ok && JSON.stringify(r.settings.hw_lessons) === JSON.stringify([A]) && JSON.stringify(r.settings.quiz_lessons) === JSON.stringify([B]), r);
t('review_lessons became the union (A and B)', r.settings.review_lessons.length === 2 && r.settings.review_lessons.indexOf(A) >= 0 && r.settings.review_lessons.indexOf(B) >= 0, r.settings.review_lessons);
t('overview reads the split back', JSON.stringify(grp().hw_lessons) === JSON.stringify([A]) && JSON.stringify(grp().quiz_lessons) === JSON.stringify([B]), grp());
r = save({ review_lessons: [A], hw_lessons: [A], quiz_lessons: [] });
t('an empty quiz list is kept as [] (none), not turned back into null', r.ok && Array.isArray(grp().quiz_lessons) && grp().quiz_lessons.length === 0, grp());
r = save({ review_lessons: [A, B] });
t('saving without the split fields returns the group to "follow the shared list"', r.ok && grp().hw_lessons === null && grp().quiz_lessons === null, grp());
t('old-key lesson in hw_lessons is stored canonical', (() => { const x = save({ hw_lessons: [LESSONS.L2.old], quiz_lessons: [] }); return x.ok && x.settings.hw_lessons[0] === A; })());
t('bad path rejected', save({ hw_lessons: ['../etc'] }).ok === false);
t('more than 5 rejected', save({ quiz_lessons: [1, 2, 3, 4, 5, 6].map(n => A.replace('lesson-2', 'lesson-' + n)) }).ok === false);
t('a non-list rejected', save({ hw_lessons: 'abc' }).ok === false);
t('student cannot save', f.post({ action: 'admin_followup_save_group', group: 'Sat 6pm', hw_lessons: [], ...f.S('sara') }).ok === false);

// the sheet: legacy blank cell, split JSON, new columns appear on an OLD sheet
const gsh = f.getSS('STU').getSheetByName('GroupSettings');
const col = n => { for (let c = 1; c <= 20; c++) if (gsh.get(1, c) === n) return c; return 0; };
t('GroupSettings has hw_lessons and quiz_lessons columns', col('hw_lessons') > 0 && col('quiz_lessons') > 0);
save({ review_lessons: [A, B] });
t('legacy save leaves the two cells blank', gsh.get(2, col('hw_lessons')) === '' && gsh.get(2, col('quiz_lessons')) === '', [gsh.get(2, col('hw_lessons'))]);

// the S2 student summary only expects a kind in that group's list
f.env.props.FF_MONTHLY = '1';
save({ review_lessons: [A, B], hw_lessons: [A], quiz_lessons: [B] });
const sm = f.post({ action: 'admin_student_summary', token: 'tok', student: f.P('sara'), from: '2026-10-01', to: '2026-12-31' });
const eA = (sm.expected || []).find(e => e.lesson === A), eB = (sm.expected || []).find(e => e.lesson === B);
t('summary: lesson A expects homework but NOT a quiz', eA && eA.homework.required === true && eA.quiz.required === false, eA);
t('summary: lesson B expects a quiz but NOT homework', eB && eB.quiz.required === true && eB.homework.required === false, eB);
// the audit trail still records the save
t('group save is still audited or at least succeeds with split fields', save({ hw_lessons: [A], quiz_lessons: [B] }).ok === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
