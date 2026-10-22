// Session 2: the monthly_review template (R-012: the message must say what the summary says).
//   node tests/test_p2_followup_templates.js
const T = require('../../../assets/followup-templates.js');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + JSON.stringify(x))); };
const REV = 'programming/baccalaureate/grade-2-secondary/chapter-1-lesson-2-how-ai-works';
const sum = o => Object.assign({
  student: { name: 'Sara Mahmoud', phone: '01000000002' }, groups: [{ group: 'Sat 6pm' }], range: { from: '2026-10-01', to: '2026-10-21' },
  totals: { quiz_count: 3, quiz_avg_pct: 76.666, quiz_missed: 1, homework_count: 2, homework_missed: 1, attendance_center: 2, attendance_online: 1, watch_avg_pct: 64 },
  expected: [{ lesson: REV, quiz: { required: true, done: false, missed: true }, homework: { required: true, done: false, missed: true } },
             { lesson: REV.replace('lesson-2', 'lesson-3'), quiz: { required: true, done: true, missed: false }, homework: { required: true, done: true, missed: false } }]
}, o || {});
const m = (s, ctx) => T.composeFull(s || sum(), 'monthly_review', Object.assign({ month: '2026-10' }, ctx || {}));
let r = m();
t('the monthly template is registered, labelled and ordered', T.DEFAULTS.monthly_review && T.LABELS.monthly_review && T.ORDER.indexOf('monthly_review') >= 0);
t('title carries the Arabic month and the student', /أكتوبر 2026/.test(r.text) && /Sara Mahmoud/.test(r.text), r.text);
t('quiz line: count and rounded average', /\*3\* كويزات/.test(r.text) && /\*76\.7%\*/.test(r.text), r.text);
t('homework line: submitted out of required (1 of 2)', /سُلّم \*1\* من \*2\*/.test(r.text), r.text);
t('attendance and watch lines', /\*2\* سنتر · \*1\* أونلاين/.test(r.text) && /\*64%\*/.test(r.text), r.text);
t('what is missed: counts + one line per item', /\*1\* كويز و \*1\* واجب/.test(r.text) && /• كويز/.test(r.text) && /• واجب/.test(r.text) && !/lesson 3/i.test(r.text.split('المطلوب تعويضه')[1] || ''), r.text);
t('no missing placeholder and no raw {…}', r.missing.length === 0 && !/\{[a-z_]+\}/.test(r.text), r);
t('lesson names are bidi-isolated', r.text.indexOf(T.FSI) >= 0 && r.text.indexOf(T.PDI) >= 0);
t('fits WhatsApp: ≤ 1200 chars', r.text.length <= T.MAX_LEN, r.text.length);
t('preview renders balanced bold', (() => { const h = T.formatPreview(r.text); return (h.match(/<b>/g) || []).length === (h.match(/<\/b>/g) || []).length && !/[*]/.test(h.replace(/<[^>]+>/g, '')); })());
r = m(sum({ totals: { quiz_count: 0, quiz_avg_pct: null, quiz_missed: 0, homework_count: 0, homework_missed: 0, attendance_center: 0, attendance_online: 0, watch_avg_pct: null }, expected: [] }));
t('an empty month: honest quiz line, empty lines vanish (no stray blank bullets)', /لم يتم حل أي كويز/.test(r.text) && !/المطلوب تعويضه/.test(r.text) && !/سنتر/.test(r.text) && !/\n\n\n/.test(r.text), r.text);
r = m(sum({ expected: [] , totals: Object.assign(sum().totals, { homework_count: 4 }) }));
t('no required homework: falls back to the number submitted', /سُلّم \*4\*/.test(r.text) && !/من \*/.test(r.text.split('الواجبات')[1].split('\n')[0]), r.text);
const many = []; for (let i = 0; i < 20; i++) many.push({ lesson: REV.replace('chapter-1-lesson-2-how-ai-works', 'chapter-' + (i + 1) + '-lesson-1-a-fairly-long-lesson-name-' + i), quiz: { required: true, done: false, missed: true }, homework: { required: true, done: false, missed: true } });
r = m(sum({ expected: many }));
t('20 missed items: capped at 8 lines + a «…و N غير كده» tail, still ≤ 1200 chars', r.text.length <= T.MAX_LEN && /غير كده/.test(r.text) && (r.text.match(/•/g) || []).length <= 10, [r.text.length, (r.text.match(/•/g) || []).length]);
r = m(sum(), { templates: { monthly_review: 'تقرير {month_label} لـ {student_first_name}\n{quiz_line}' } });
t('a teacher-edited template is used (placeholders still filled)', /^تقرير أكتوبر 2026 لـ /.test(r.text) && /كويزات/.test(r.text), r.text);
r = m(sum(), { templates: { monthly_review: 'x {nope}' } });
t('an unknown placeholder is reported, not hidden', r.missing.indexOf('nope') >= 0, r);
t('compose() returns the same text as composeFull()', T.compose(sum(), 'monthly_review', { month: '2026-10' }) === m().text);
t('monthLabel handles every month and garbage', T.monthLabel('2026-01') === 'يناير 2026' && T.monthLabel('2026-12') === 'ديسمبر 2026' && T.monthLabel('x') === 'x');
t('the editor offers the monthly placeholders', T.placeholdersFor('monthly_review').indexOf('quiz_line') >= 0 && T.placeholdersFor('monthly_review').every(p => T.PLACEHOLDERS[p]));
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
