// Follow-up dashboard, chunk 4: assets/followup-templates.js (message engine + editor helpers).
// Plain Node, no install:   node tests/test_followup_templates.js   (from tools/quiz-maker-v2/)
// The editor's DOM behaviour is covered by tests/manual/followup-templates-demo.html (see
// tests/manual/whatsapp-format-check.md); everything else is tested here.
const path = require('path');
const T = require(path.join(__dirname, '..', '..', '..', 'assets', 'followup-templates.js'));

let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };
const FSI = '\u2068', PDI = '\u2069';
const strip = s => s.replace(/[\u2068\u2069]/g, '');

const NOW = new Date('2026-10-14T09:00:00Z');          // Wed 14 Oct 2026, 12:00 Cairo (UTC+3)
const S = T.makeSample(NOW);
const CUR = S.group.settings.current_lesson, REV = S.group.settings.review_lessons[0];
const G = 'programming/baccalaureate/grade-2-secondary/';

const compose = (kind, over) => T.composeFull(S, kind, Object.assign({}, S, over || {}));

// ---- 1. every default renders cleanly --------------------------------------------------------
const keys = Object.keys(T.DEFAULTS);
t('DEFAULTS has every key of section 4.5', ['header', 'session_unwatched', 'session_unfinished', 'session_done', 'homework_missing', 'homework_done', 'quiz_mark', 'quiz_praise', 'quiz_absent', 'line_session_unwatched', 'line_session_unfinished', 'line_homework_missing', 'line_quiz_absent', 'combined', 'group_reminder'].every(k => typeof T.DEFAULTS[k] === 'string' && T.DEFAULTS[k].length > 0));
t('ORDER and LABELS cover every default', keys.every(k => T.ORDER.includes(k) && T.LABELS[k]));
for (const k of keys) {
  const r = compose(k);
  const lint = T.lintMessage(r.text);
  t(`default "${k}" renders: no leftover {..}, no unknown placeholders`, !/\{[A-Za-z_]+\}/.test(r.text) && r.missing.length === 0, r.missing.join(',') + ' | ' + r.text.slice(0, 80));
  t(`default "${k}" is <= 1200 chars and its * markers are balanced`, lint.ok, JSON.stringify(lint));
}
t('every {placeholder} used by a default is a documented placeholder (or {H})', keys.every(k => (T.DEFAULTS[k].match(/\{([A-Za-z_]+)\}/g) || []).every(m => m === '{H}' || T.PLACEHOLDERS[m.slice(1, -1)])));
t('every PLACEHOLDER has Arabic and English text', Object.values(T.PLACEHOLDERS).every(p => p.ar && p.en));
t('every default * marker pair is balanced per line (source, before rendering)', keys.every(k => T.DEFAULTS[k].split('\n').every(l => (l.split('*').length - 1) % 2 === 0)));
t('every default block has at most 2 emoji (guide: 1-2 per block)', keys.every(k => T.DEFAULTS[k].split('\n\n').every(b => (b.match(/\p{Extended_Pictographic}/gu) || []).length <= 2)));

// ---- 2. the header ---------------------------------------------------------------------------
{
  const r = compose('session_unwatched').text;
  t('header expands in front of single templates', r.startsWith('السلام عليكم 👋\n\nمع حضرتك *فريق الدعم لبشمهندس عز نصر* في مادة البرمجة 💻\n\nكنا بنتواصل'), r.slice(0, 140));
  const r2 = T.composeFull(S, 'session_unwatched', Object.assign({}, S, { templates: { header: 'أهلًا 🌷' } })).text;
  t('an edited header is used (and still separated by a blank line)', r2.startsWith('أهلًا 🌷\n\nكنا بنتواصل'), r2.slice(0, 60));
  const r3 = T.composeFull(S, 'session_unwatched', Object.assign({}, S, { templates: { header: '   ' } })).text;
  t('a blank header is treated as the default', r3.startsWith('السلام عليكم'), r3.slice(0, 30));
  const direct = T.render('{H}x', {}, { header: '' }).text;
  t('an explicitly empty header renders nothing', direct === 'x', direct);
}

// ---- 3. lessons: current lesson for session templates, review lesson for homework/quiz --------
{
  const a = compose('session_unwatched').text, b = compose('homework_missing').text, c = compose('quiz_absent').text;
  t('session template uses the CURRENT lesson', strip(a).includes('*chapter 2 lesson 2 functions*') && !strip(a).includes('lesson 1 variables'));
  t('homework template uses the REVIEW lesson', strip(b).includes('*chapter 2 lesson 1 variables*') && !strip(b).includes('lesson 2 functions'));
  t('quiz template uses the REVIEW lesson', strip(c).includes('*chapter 2 lesson 1 variables*'));
  const two = Object.assign({}, S.group, { settings: Object.assign({}, S.group.settings, { review_lessons: [G + 'chapter-2-lesson-1-variables', G + 'chapter-2-lesson-0-intro'] }) });
  const pick = T.composeFull(S, 'homework_missing', Object.assign({}, S, { group: two, lesson: G + 'chapter-2-lesson-0-intro' })).text;
  t('ctx.lesson picks one of several review lessons', strip(pick).includes('*chapter 2 lesson 0 intro*'));
  const viaVerdict = T.composeFull({ student: S.student, group: two, verdicts: { session: null, homework: [{ lesson: G + 'chapter-2-lesson-1-variables', state: 'homework_done' }, { lesson: G + 'chapter-2-lesson-0-intro', state: 'homework_missing' }], quiz: [] } }, 'homework_missing', { facts: S.facts, deadlines: S.deadlines, now: NOW }).text;
  t('without ctx.lesson, the lesson whose verdict matches the template is used', strip(viaVerdict).includes('*chapter 2 lesson 0 intro*'));
  t('{lesson_slug} keeps the raw slug; {lesson} turns hyphens into spaces', (() => {
    const c = T.buildContext(Object.assign({}, S, { kind: 'session_unwatched' }));
    return c.lesson_slug === 'chapter-2-lesson-2-functions' && c.lesson === 'chapter 2 lesson 2 functions' && c.lesson_current === c.lesson && c.lesson_review === 'chapter 2 lesson 1 variables';
  })());
}

// ---- 4. facts -> numbers ---------------------------------------------------------------------
{
  const q = compose('quiz_mark').text;
  t('quiz mark shows score / total / percent', strip(q).includes('*9 من 10* (90%)'), strip(q));
  const w = compose('session_unfinished').text;
  t('watch percent comes from the current lesson', strip(w).includes('*42%* بس'), strip(w));
  const praise = compose('quiz_praise').text;
  t('quiz praise carries the numbers', strip(praise).includes('*9 من 10* (90%)'));
  const noQuiz = T.buildContext(Object.assign({}, S, { facts: {}, kind: 'quiz_mark' }));
  t('no facts -> empty strings, not "undefined"', noQuiz.score === '' && noQuiz.watch_pct === '' && noQuiz.quiz_pct === '');
  const frac = T.buildContext(Object.assign({}, S, { kind: 'quiz_mark', facts: { [REV]: { quiz: { taken: true, score: 7, total: 9 } } } }));
  t('percent is rounded', frac.quiz_pct === '78');
}

// ---- 5. WhatsApp formatting + bidi ------------------------------------------------------------
{
  const r = compose('homework_missing').text;
  t('inserted values are wrapped in isolates, the * markers stay OUTSIDE them', /\*\u2068[^*\u2068\u2069]+\u2069\*/.test(r) && !/\u2068\*|\*\u2069/.test(r), r);
  t('isolates are balanced', (r.match(/\u2068/g) || []).length === (r.match(/\u2069/g) || []).length);
  const off = T.composeFull(S, 'homework_missing', Object.assign({}, S, { isolates: false })).text;
  t('isolates can be turned off (bidi_isolates fallback)', !/[\u2068\u2069]/.test(off) && off.includes('*chapter 2 lesson 1 variables*'));
  const off2 = T.composeFull(S, 'homework_missing', Object.assign({}, S, { settings: { bidi_isolates: false } })).text;
  t('... also through settings.bidi_isolates=false', !/[\u2068\u2069]/.test(off2));
  const evil = { student: { name: 'Ali *the* _great_ ~x~ `y`', phone: '010' } };
  const e = T.composeFull(S, 'homework_missing', Object.assign({}, S, evil)).text;
  t('a student name containing * _ ~ ` cannot break the bold', T.lintMessage(e).ok && strip(e).includes('*Ali the great x y*'), strip(e).split('\n').filter(l => l.includes('Ali')).join('|'));
  const nl = T.composeFull(S, 'homework_missing', Object.assign({}, S, { student: { name: 'Ali\nHacker\r\n{lesson}' } })).text;
  t('newlines and {braces} in a name stay inside the one line and are not re-expanded', strip(nl).includes('*Ali Hacker {lesson}*'), strip(nl));
  const sneaky = T.composeFull(S, 'homework_missing', Object.assign({}, S, { student: { name: 'a\u2069b\u2066c' } })).text;
  t('stray bidi controls in data are removed', (sneaky.match(/\u2068/g) || []).length === (sneaky.match(/\u2069/g) || []).length && !/\u2066/.test(sneaky));
  t('the sender voice is in bold in the header', compose('session_done').text.includes('*فريق الدعم لبشمهندس عز نصر*'));
}

// ---- 6. render(): empty lines, unknown placeholders -------------------------------------------
{
  const a = T.render('أ {x}\n\n{opt}\n\nب', { x: '1', opt: '' }).text;
  t('a line whose only content is an empty optional placeholder vanishes (with its blank line)', a === 'أ 1\n\nب', JSON.stringify(a));
  const b = T.render('a\n\n\n\n\nb', {}).text;
  t('3+ blank lines collapse to one', b === 'a\n\nb', JSON.stringify(b));
  const c = T.render('x {nope} {lesson}', { lesson: 'L' });
  t('unknown placeholders stay visible and are reported once', c.text === 'x {nope} ' + FSI + 'L' + PDI && JSON.stringify(c.missing) === '["nope"]', JSON.stringify(c));
  const d = T.render('{a} {a} {b}', { a: '1' });
  t('missing list has no duplicates', JSON.stringify(d.missing) === '["b"]');
  const e = T.render('keep  \n\n   \n\nend', {}).text;
  t('whitespace-only lines count as blank', e === 'keep\n\nend', JSON.stringify(e));
  const f = T.render('\n\n  hi  \n\n', {}).text;
  t('leading and trailing blanks are trimmed', f === 'hi');
  const g = T.render('{score}', { score: 0 }).text;
  t('the number 0 is a real value, not "empty"', strip(g) === '0');
  const parents = (flag) => T.composeFull(S, 'group_reminder', Object.assign({}, S, { group: Object.assign({}, S.group, { settings: Object.assign({}, S.group.settings, { parents_contacted: flag }) }) })).text;
  t('group reminder: parents-contacted line shows only when the flag is on', parents(true).includes('📞') && !parents(false).includes('📞'));
  t('group reminder: switching the flag off leaves no double blank line and no gap', !/\n{3,}/.test(parents(false)) && parents(false).split('\n\n').length === 5, String(parents(false).split('\n\n').length));
  t('a custom header-less template works', T.compose(S, 'session_done', Object.assign({}, S, { templates: { session_done: 'مرحبا {student_first_name}' } })) === 'مرحبا ' + FSI + 'مريم' + PDI);
}

// ---- 7. lists: keycap numbering, filtering ----------------------------------------------------
{
  const many = Array.from({ length: 11 }, (_, i) => G + 'chapter-1-lesson-' + (i + 1) + '-x');
  const grp = { group: 'g', settings: { current_lesson: CUR, review_lessons: many, parents_contacted: false } };
  const c = T.buildContext({ student: S.student, group: grp, kind: 'group_reminder' });
  // buildLists is internal; exercise it through the group reminder
  const txt = T.composeFull({ student: S.student, group: grp }, 'group_reminder', { deadlines: S.deadlines, now: NOW, lessons: {} }).text;
  t('hw_list numbers 1-9 with keycap emoji', txt.includes('1\uFE0F\u20E3 نتأكد من تسليم واجب') && txt.includes('9\uFE0F\u20E3 نتأكد'));
  t('... then "10-" and "11-"', txt.includes('10- نتأكد') && txt.includes('11- نتأكد'));
  const lessons = { [many[0]]: { has_assignment: false }, [many[1]]: { has_assignment: true } };
  const filtered = T.composeFull({ student: S.student, group: { group: 'g', settings: { current_lesson: CUR, review_lessons: [many[0], many[1]] } } }, 'group_reminder', { deadlines: S.deadlines, now: NOW, lessons }).text;
  t('lessons without an assignment are left out of hw_list', !strip(filtered).includes('lesson 1 x') && strip(filtered).includes('1\uFE0F\u20E3 نتأكد من تسليم واجب *chapter 1 lesson 2 x*'), strip(filtered));
  const none = T.composeFull({ student: S.student, group: { group: 'g', settings: { current_lesson: CUR, review_lessons: [] } } }, 'group_reminder', { deadlines: S.deadlines, now: NOW }).text;
  t('no review lessons -> the hw_list line disappears', !none.includes('نتأكد من تسليم') && !/\n{3,}/.test(none));
}

// ---- 8. combined message ----------------------------------------------------------------------
{
  const r = compose('combined').text;
  const issueLines = strip(r).split('\n').filter(l => /^(▶️|📝|❓)/.test(l));
  t('combined lists every negative verdict, each with its OWN lesson', issueLines.length === 3 && issueLines[0].includes('lesson 2 functions') && issueLines[1].includes('lesson 1 variables') && issueLines[2].includes('lesson 1 variables'), issueLines.join(' || '));
  t('combined line order: session, homework, quiz', /▶️[\s\S]*📝[\s\S]*❓/.test(r));
  const vs = { session: { lesson: CUR, state: 'session_done' }, homework: [{ lesson: REV, state: 'homework_done' }], quiz: [{ lesson: REV, state: 'quiz_taken' }] };
  const none = T.composeFull({ student: S.student, group: S.group, verdicts: vs }, 'combined', { facts: S.facts, now: NOW, deadlines: S.deadlines });
  t('no issues -> the {issues} line vanishes without leaving a gap', !/\n{3,}/.test(none.text) && !none.text.includes('{issues}'));
  t('deriveIssues maps locked video to the "unwatched" template', T.deriveIssues({ session: { lesson: CUR, state: 'session_locked' } })[0].template === 'session_unwatched');
  t('deriveIssues ignores praise/neutral states', T.deriveIssues({ session: { lesson: CUR, state: 'optional' }, homework: [{ lesson: REV, state: 'homework_done' }], quiz: [{ lesson: REV, state: 'quiz_taken' }] }).length === 0);
  const own = T.composeFull(S, 'combined', Object.assign({}, S, { issues: [{ template: 'quiz_absent', lesson: REV }] })).text;
  t('ctx.issues overrides what the combined message lists', strip(own).includes('❓ كويز') && !strip(own).includes('▶️'));
  t('templateForState', T.templateForState('session_locked') === 'session_unwatched' && T.templateForState('homework_missing') === 'homework_missing' && T.templateForState('optional') === '');
  const custom = T.composeFull(S, 'combined', Object.assign({}, S, { templates: { line_quiz_absent: 'Q:{lesson}' } })).text;
  t('edited line_* templates are used inside the combined message', strip(custom).includes('Q:chapter 2 lesson 1 variables'));
}

// ---- 9. length limit --------------------------------------------------------------------------
{
  const many = Array.from({ length: 6 }, (_, i) => G + 'chapter-9-lesson-' + (i + 1) + '-' + 'very-long-lesson-name-'.repeat(2) + 'x');
  const grp = { group: 'g', settings: { current_lesson: CUR, review_lessons: many } };
  const verdicts = { session: { lesson: CUR, state: 'session_unfinished' }, homework: many.map(l => ({ lesson: l, state: 'homework_missing' })), quiz: many.map(l => ({ lesson: l, state: 'quiz_absent' })) };
  const r = T.composeFull({ student: S.student, group: grp, verdicts }, 'combined', { facts: S.facts, deadlines: S.deadlines, now: NOW });
  t('a huge combined message is trimmed to <= 1200', r.text.length <= 1200 && r.trimmed, String(r.text.length));
  t('... keeping the header and the issue lines before the closing blocks', r.text.startsWith('السلام عليكم') && (r.text.match(/📝 واجب/g) || []).length >= 1);
  const short = compose('combined');
  t('a normal message is not trimmed', !short.trimmed);
  const hard = T.composeFull(S, 'session_done', Object.assign({}, S, { templates: { session_done: 'x'.repeat(3000) } }));
  t('a single giant paragraph is hard-cut with an ellipsis', hard.text.length <= 1200 && hard.text.endsWith('…') && hard.trimmed);
}

// ---- 10. deadlines in Cairo time ---------------------------------------------------------------
{
  const w = (dl, now) => strip(T.deadlineWhen(dl, now));
  t('same Cairo day -> النهارده', w('2026-10-14', NOW) === 'النهارده');
  t('next Cairo day -> بكرة', w('2026-10-15', NOW) === 'بكرة');
  t('later -> يوم + weekday + d/m (2026-10-17 is a Saturday)', w('2026-10-17', NOW) === 'يوم السبت 17/10', w('2026-10-17', NOW));
  t('a Date deadline and an ISO string with offset both work', w(new Date('2026-10-16T20:59:00Z'), NOW) === 'يوم الجمعة 16/10' && w('2026-10-16T23:59:00+03:00', NOW) === 'يوم الجمعة 16/10');
  const lateUtc = new Date('2026-10-14T21:30:00Z');   // 00:30 Cairo on the 15th
  t('"today" follows Cairo midnight, not UTC', w('2026-10-15', lateUtc) === 'النهارده' && w('2026-10-16', lateUtc) === 'بكرة');
  t('an overdue date still prints the date', w('2026-10-10', NOW) === 'يوم السبت 10/10');
  t('bad / empty input -> empty string', T.deadlineWhen('', NOW) === '' && T.deadlineWhen('garbage', NOW) === '' && T.deadlineWhen(null, NOW) === '');
  t('deadline objects {date} / {ymd} are accepted', w({ date: '2026-10-15' }, NOW) === 'بكرة' && w({ ymd: '2026-10-14' }, NOW) === 'النهارده');
  const hw = compose('homework_missing').text, ses = compose('session_unwatched', { deadlines: { watch: '2026-10-14', hw: '2026-10-17' } }).text;
  t('homework templates use the homework deadline', strip(hw).includes('*يوم الجمعة 16/10*') || strip(hw).includes('*يوم'), strip(hw).split('\n')[6]);
  t('{deadline_when} for session templates uses the watch deadline', T.buildContext(Object.assign({}, S, { kind: 'session_unwatched', deadlines: { watch: '2026-10-14', hw: '2026-10-17' }, now: NOW })).deadline_when === 'النهارده');
  t('alternate deadline key spellings work', T.buildContext(Object.assign({}, S, { kind: 'homework_missing', deadlines: { hwDeadline: '2026-10-15' }, now: NOW })).deadline_when === 'بكرة' && T.buildContext(Object.assign({}, S, { kind: 'homework_missing', deadlines: { hw_deadline: '2026-10-15' }, now: NOW })).hw_deadline === '15/10');
  t('{hw_deadline} / {watch_deadline} are d/m', (() => { const c = T.buildContext(Object.assign({}, S, { deadlines: { watch: '2026-10-09', hw: '2026-11-03' } })); return c.watch_deadline === '9/10' && c.hw_deadline === '3/11'; })());
  t('sessionWhen: weekday, d/m and 12-hour time in Cairo', strip(T.sessionWhen('2026-10-17T18:00:00+03:00')) === 'يوم السبت 17/10 الساعة 6:00 م' && strip(T.sessionWhen('2026-10-17T09:05:00+03:00')) === 'يوم السبت 17/10 الساعة 9:05 ص' && strip(T.sessionWhen('2026-10-17T00:30:00+03:00')) === 'يوم السبت 17/10 الساعة 12:30 ص');
  t('Cairo date is used across the DST change (Egypt: last Thursday of October)', strip(T.deadlineWhen('2026-10-29', new Date('2026-10-29T21:30:00Z'))) === 'النهارده' && strip(T.deadlineWhen('2026-10-30', new Date('2026-10-29T21:30:00Z'))) === 'بكرة' && strip(T.deadlineWhen('2026-10-29', new Date('2026-10-28T21:30:00Z'))) === 'النهارده');
}

// ---- 11. formatPreview ------------------------------------------------------------------------
{
  const f = T.formatPreview;
  t('*bold* _italic_ ~strike~ and line breaks', f('a *b* _c_ ~d~\ne') === 'a <b>b</b> <i>c</i> <s>d</s><br>e', f('a *b* _c_ ~d~\ne'));
  t('markers need no space inside: "* b *" is not bold', f('* b *') === '* b *');
  t('a marker glued to a word is not bold (snake_case, 2*3*4)', f('snake_case_name') === 'snake_case_name' && f('2*3*4') === '2*3*4');
  t('HTML is escaped', f('<script>alert(1)</script> & "x"') === '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;');
  t('an HTML payload inside bold stays escaped', f('*<img src=x onerror=alert(1)>*') === '<b>&lt;img src=x onerror=alert(1)&gt;</b>');
  t('bold around Arabic text and isolates', f('حصة 📚 *' + FSI + 'lesson 1' + PDI + '* تمام') === 'حصة 📚 <b>' + FSI + 'lesson 1' + PDI + '</b> تمام');
  t('bold right after an opening bracket and before punctuation', f('(*x*) *y*،') === '(<b>x</b>) <b>y</b>،');
  t('two bolds on one line', f('*a* و *b*') === '<b>a</b> و <b>b</b>');
  t('a bold run does not span lines', f('*a\nb*') === '*a<br>b*');
  t('a name with * cannot create bold in the preview of a real message', !T.formatPreview(compose('homework_missing', { student: { name: 'x * y *z' } }).text).includes('<b>x'));
  t('emoji survive untouched', f('✅ 🌷 ⚠️') === '✅ 🌷 ⚠️');
  t('every default renders to preview HTML with balanced <b> tags', keys.every(k => { const h = f(compose(k).text); return (h.match(/<b>/g) || []).length === (h.match(/<\/b>/g) || []).length && !/[*]/.test(h.replace(/<[^>]+>/g, '')); }));
}

// ---- 12. WhatsApp link ------------------------------------------------------------------------
{
  const msg = strip(compose('combined').text);
  const url = T.waLink('201012345678', msg);
  t('wa.me link: digits only, text URL-encoded, round-trips', url.startsWith('https://wa.me/201012345678?text=') && decodeURIComponent(url.split('?text=')[1]) === msg);
  t('waLink strips + and spaces from the number', T.waLink('+20 101 234 5678', 'x') === 'https://wa.me/201012345678?text=x');
  t('waLink without text has no query', T.waLink('2010', '') === 'https://wa.me/2010');
  t('newlines, spaces and emoji are encoded (a literal * is a legal URL character and is kept, so bold survives)', /%0A/.test(url) && !/[\n ]/.test(url) && !/\p{Extended_Pictographic}/u.test(url) && url.includes('*'));
  t('waDigits', T.waDigits('٠١٠ 12-3') === '123' || T.waDigits('010 12-3') === '010123');
}

// ---- 13. editor text helpers -----------------------------------------------------------------
{
  const w = T.wrapSelection, ins = T.insertAt;
  let r = w('hello world', 0, 5, '*');
  t('wrap selection in bold', r.value === '*hello* world' && r.start === 0 && r.end === 7, JSON.stringify(r));
  r = w('hello world', 6, 11, '_');
  t('wrap selection in italic', r.value === 'hello _world_');
  r = w('ab', 1, 1, '*');
  t('no selection: inserts a pair with the caret between', r.value === 'a**b' && r.start === 2 && r.end === 2);
  r = w('say  hi  now', 3, 9, '*');
  t('spaces at the edges of the selection stay outside the markers', r.value === 'say  *hi*  now', JSON.stringify(r));
  r = w('*hello* world', 0, 7, '*');
  t('selecting an already-bold run unwraps it', r.value === 'hello world');
  r = w('*hello* world', 1, 6, '*');
  t('selecting the inside of a bold run unwraps it too', r.value === 'hello world' && r.start === 0 && r.end === 5, JSON.stringify(r));
  r = ins('ab', 1, 1, '{lesson}');
  t('insertAt puts the placeholder at the caret and moves it after', r.value === 'a{lesson}b' && r.start === 9);
  r = ins('abcd', 1, 3, '🌷');
  t('insertAt replaces the selection', r.value === 'a🌷d');
  t('placeholdersFor: combined offers {issues}, group reminder offers {hw_list}, header does not offer lessons', T.placeholdersFor('combined').includes('issues') && T.placeholdersFor('group_reminder').includes('hw_list') && !T.placeholdersFor('header').includes('lesson'));
  t('placeholdersFor only names documented placeholders', Object.keys(T.DEFAULTS).every(k => T.placeholdersFor(k).every(p => T.PLACEHOLDERS[p])));
}

// ---- 14. contract details ---------------------------------------------------------------------
{
  const a = T.compose(S, 'session_unwatched', S), b = T.composeFull(S, 'session_unwatched', S).text;
  t('compose() returns the text of composeFull()', a === b && typeof a === 'string');
  const fromSummary = T.compose({ student: S.student, group: S.group, verdicts: S.verdicts }, 'quiz_absent', { facts: S.facts, deadlines: S.deadlines, now: NOW });
  t('student/group may come from the summary instead of ctx', strip(fromSummary).includes('*مريم أحمد*'));
  const noGroup = T.composeFull({ student: { name: 'س' } }, 'homework_missing', { now: NOW });
  t('missing group/lesson/deadline data does not throw; the empty lines vanish', typeof noGroup.text === 'string' && !/\n{3,}/.test(noGroup.text) && !noGroup.text.includes('{'));
  const nothing = T.composeFull(null, 'session_done', null);
  t('null summary and ctx do not throw', typeof nothing.text === 'string');
  const fresh = T.makeSample(NOW);
  t('makeSample dates move with "now"', fresh.deadlines.watch === '2026-10-15' && fresh.deadlines.hw === '2026-10-16');
  t('a leftover {name} in a custom template is reported in composeFull().missing', T.composeFull(S, 'session_done', Object.assign({}, S, { templates: { session_done: 'hi {bogus}' } })).missing[0] === 'bogus');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
