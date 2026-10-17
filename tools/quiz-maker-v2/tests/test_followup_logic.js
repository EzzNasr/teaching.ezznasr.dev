// Tests for assets/followup-logic.js (pure, no Sheets/Apps Script involved).
//   node tests/test_followup_logic.js [repo-root]        (run from tools/quiz-maker-v2/; default root = ../..)
//   TZ=America/Los_Angeles node tests/test_followup_logic.js   -> must give the same result (Cairo time is explicit)
const path = require('path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..'));
const L = require(path.join(root, 'assets', 'followup-logic.js'));
const OV = require(path.join(root, 'dashboard', '_fixtures', 'followup-overview.logic.json'));
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (e === undefined ? '' : (typeof e === 'string' ? e : JSON.stringify(e))))); };
const eq = (n, a, b) => t(n, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b));
const clone = o => JSON.parse(JSON.stringify(o));
const iso = d => d && d.toISOString();

const B = 'programming/baccalaureate/grade-1-secondary/';
const F = B + 'chapter-2-lesson-2-functions', V = B + 'chapter-2-lesson-1-variables', LP = B + 'chapter-1-lesson-4-loops';
const [G1, G2, G3] = OV.groups;
const NOW = new Date(OV.now);                                    // Fri 2026-10-16 05:19 Cairo (+03:00)
const sum = (g, phoneKey) => { const m = g.members.find(x => L.phoneKey(x.phone) === phoneKey); return L.studentSummary(m, g, OV); };
const who = (g, n) => sum(g, '10000001' + n);                    // 01 … 12 -> 1000000101…

/* ------------------------------------------------------------ phones */
eq('phoneKey: +20 spaced', L.phoneKey('+20 101 234 5678'), '1012345678');
eq('phoneKey: Arabic-Indic digits', L.phoneKey('٠١٠١٢٣٤٥٦٧٨'), '1012345678');
eq('phoneKey: blank/null', [L.phoneKey(''), L.phoneKey(null)], ['', '']);
eq('waDigits: 01XXXXXXXXX -> 20 + last 10', L.waDigits('01200000101'), '201200000101');
eq('waDigits: no leading zero', L.waDigits('1200000101'), '201200000101');
eq('waDigits: +20 / 0020', [L.waDigits('+20 120 000 0101'), L.waDigits('0020 1200000101')], ['201200000101', '201200000101']);
eq('waDigits: too short -> empty', L.waDigits('0123'), '');
let p = L.checkParentPhone('', '01000000101');
t('parent: blank = missing, no wa, fallbackWa = student', p.level === 'missing' && !p.ok && p.wa === '' && !p.canSend && p.fallbackWa === '201000000101', p);
p = L.checkParentPhone('   ', '01000000101'); eq('parent: whitespace = missing', p.level, 'missing');
p = L.checkParentPhone('01200000101', '01000000101'); t('parent: valid Egyptian', p.ok && p.level === 'ok' && p.wa === '201200000101' && p.canSend && !p.note, p);
p = L.checkParentPhone('٠١٢٠٠٠٠٠١٠١', '01000000101'); t('parent: Arabic digits valid', p.ok && p.wa === '201200000101', p);
p = L.checkParentPhone('0123', '01000000101'); t('parent: < 10 digits = warn, no wa', p.level === 'warn' && !p.ok && p.wa === '' && !p.canSend && p.reason, p);
p = L.checkParentPhone('01000000107', '+20 100 000 0107'); t('parent: equals student = warn (wa kept, owner decides)', p.level === 'warn' && p.wa === '201000000107' && p.canSend, p);
p = L.checkParentPhone('01312345678', '01000000101'); t('parent: not an Egyptian mobile prefix = warn', p.level === 'warn' && p.wa === '', p);
p = L.checkParentPhone('+966501234567', '01000000101'); t('parent: international with + = ok + note', p.ok && p.note && p.wa === '966501234567', p);
p = L.checkParentPhone('00966501234567', '01000000101'); t('parent: international with 00', p.ok && p.wa === '966501234567', p);
p = L.checkParentPhone('+201', '01000000101'); t('parent: +20 but malformed = warn', p.level === 'warn', p);
p = L.checkParentPhone('966501234567', '01000000101'); t('parent: foreign digits WITHOUT country marker = warn', p.level === 'warn', p);

/* ------------------------------------------------------- nextSession */
// 2026-10-16 is a Friday. Cairo is UTC+3 until 2026-10-29 (DST ends), UTC+2 after.
let ns = L.nextSession(new Date('2026-10-17T13:00:00Z'), 6, '18:00');         // Sat 16:00 Cairo, session 18:00
t('nextSession: same day, before the session time', ns.date === '2026-10-17' && iso(ns.at) === '2026-10-17T15:00:00.000Z', ns);
ns = L.nextSession(new Date('2026-10-17T15:00:00Z'), 6, '18:00');             // exactly at 18:00
t('nextSession: exactly at session time -> still today ("at or after")', ns.date === '2026-10-17', ns);
ns = L.nextSession(new Date('2026-10-17T15:00:01Z'), 6, '18:00');
t('nextSession: 1 s after the session -> rolls forward a week', ns.date === '2026-10-24' && iso(ns.at) === '2026-10-24T15:00:00.000Z', ns);
ns = L.nextSession(NOW, 0, '10:00'); t('nextSession: weekday wrap Fri -> Sun', ns.date === '2026-10-18', ns);
ns = L.nextSession(NOW, 5, '10:00'); t('nextSession: Friday morning, session Friday 10:00 -> today', ns.date === '2026-10-16', ns);
ns = L.nextSession(new Date('2026-10-16T09:00:00Z'), 5, '10:00'); t('nextSession: Friday 12:00 Cairo, session 10:00 -> next Friday', ns.date === '2026-10-23', ns);
ns = L.nextSession(NOW, '6', '09:30'); t('nextSession: weekday given as a string; "9:30" style ok', ns && ns.date === '2026-10-17' && ns.time === '09:30', ns);
t('nextSession: unset / invalid -> null', L.nextSession(NOW, '', '18:00') === null && L.nextSession(NOW, null, '18:00') === null && L.nextSession(NOW, 7, '18:00') === null && L.nextSession(NOW, 6, '25:00') === null && L.nextSession(NOW, 6, 'abc') === null && L.nextSession(NOW, 6, '') === null);
// Cairo date, not the machine's/UTC date: 22:30Z on Oct 16 is already Oct 17 01:30 Cairo? (+3 -> 01:30) yes
ns = L.nextSession(new Date('2026-10-16T22:30:00Z'), 6, '18:00'); t('nextSession: uses the CAIRO date near midnight', ns.date === '2026-10-17', ns);

/* ---------------------------------------------------------- deadlines */
let d = L.groupDeadlines({ weekday: 6, time: '18:00' }, NOW);
t('deadlines: watch = session − 3 days, hw = session − 1 day', d.nextSession.date === '2026-10-17' && d.watch.date === '2026-10-14' && d.hw.date === '2026-10-16', d);
t('deadlines: states (watch overdue, hw today)', d.watch.state === 'overdue' && d.hw.state === 'today', d);
t('deadlines: end = 23:59:59.999 Cairo of that date', iso(d.hw.end) === '2026-10-16T20:59:59.999Z', iso(d.hw.end));
d = L.groupDeadlines({ weekday: 6, time: '18:00', hw_deadline_override: '2026-10-20', watch_deadline_override: ' 2026-10-18 ' }, NOW);
t('deadlines: non-blank override replaces the default (trimmed)', d.hw.date === '2026-10-20' && d.hw.overridden && d.watch.date === '2026-10-18' && d.watch.state === 'upcoming', d);
d = L.groupDeadlines({ weekday: 6, time: '18:00', hw_deadline_override: '20/10/2026', watch_deadline_override: '2026-02-31' }, NOW);
t('deadlines: invalid override is ignored', d.hw.date === '2026-10-16' && !d.hw.overridden && d.watch.date === '2026-10-14', d);
d = L.groupDeadlines({ weekday: 6, time: '18:00' }, NOW, { watch_days_before: 2, hw_days_before: 0 });
t('deadlines: offsets come from settings', d.watch.date === '2026-10-15' && d.hw.date === '2026-10-17', d);
d = L.groupDeadlines({}, NOW); t('deadlines: no schedule -> null (no override)', d.nextSession === null && d.watch === null && d.hw === null, d);
d = L.groupDeadlines({ hw_deadline_override: '2026-10-20' }, NOW); t('deadlines: override works without a schedule', d.hw.date === '2026-10-20' && d.watch === null, d);
d = L.groupDeadlines({ weekday: 6, time: '18:00' }, new Date('2026-10-17T14:00:00Z'));                  // Sat 17:00: session still today -> hw deadline yesterday
t('deadlines: session later today -> both deadlines already overdue', d.watch.state === 'overdue' && d.hw.state === 'overdue', d);
d = L.groupDeadlines({ weekday: 6, time: '18:00' }, new Date('2026-10-17T15:30:00Z'));                  // just after the session: rolls a week
t('deadlines: right after the session they roll to next week (upcoming again)', d.nextSession.date === '2026-10-24' && d.watch.state === 'upcoming' && d.hw.state === 'upcoming', d);

// midnight boundaries (Cairo)
eq('deadlineState: 23:59:59 Cairo still "today"', L.deadlineState(new Date('2026-10-16T20:59:59Z'), '2026-10-16'), 'today');
eq('deadlineState: 23:59:59.999 Cairo still "today"', L.deadlineState(new Date('2026-10-16T20:59:59.999Z'), '2026-10-16'), 'today');
eq('deadlineState: 00:00:00 Cairo next day = overdue', L.deadlineState(new Date('2026-10-16T21:00:00Z'), '2026-10-16'), 'overdue');
eq('deadlineState: tomorrow = upcoming', L.deadlineState(NOW, '2026-10-17'), 'upcoming');
eq('deadlineState: accepts a Date and a {date,end} object', [L.deadlineState(NOW, new Date('2026-10-20T10:00:00Z')), L.deadlineState(NOW, { date: '2026-10-14', end: new Date('2026-10-14T20:59:59.999Z') })], ['upcoming', 'overdue']);
eq('deadlineState: no deadline -> null', L.deadlineState(NOW, null), null);

// DST (Egypt: back to +02:00 at the end of Thu 2026-10-29; forward to +03:00 at the start of Fri 2026-04-24)
d = L.groupDeadlines({ weekday: 6, time: '18:00' }, new Date('2026-10-26T10:00:00Z'));                  // next session Sat 31 Oct, UTC+2
t('DST end: session 18:00 = 16:00Z', d.nextSession.date === '2026-10-31' && iso(d.nextSession.at) === '2026-10-31T16:00:00.000Z', iso(d.nextSession.at));
t('DST end: hw deadline Fri 30 Oct ends 23:59:59.999 at +02:00 (21:59Z)', d.hw.date === '2026-10-30' && iso(d.hw.end) === '2026-10-30T21:59:59.999Z', iso(d.hw.end));
t('DST end: watch deadline Wed 28 Oct is still +03:00 (20:59Z)', d.watch.date === '2026-10-28' && iso(d.watch.end) === '2026-10-28T20:59:59.999Z', iso(d.watch.end));
eq('DST end: one second after Wed 28 Oct 23:59:59 Cairo = overdue', L.deadlineState(new Date('2026-10-28T21:00:00Z'), d.watch), 'overdue');
d = L.groupDeadlines({ weekday: 6, time: '10:00' }, new Date('2026-04-20T10:00:00Z'));                   // session Sat 25 Apr, UTC+3
t('DST start: session 10:00 = 07:00Z', d.nextSession.date === '2026-04-25' && iso(d.nextSession.at) === '2026-04-25T07:00:00.000Z', iso(d.nextSession.at));
t('DST start: hw deadline Fri 24 Apr ends at +03:00 (20:59Z)', d.hw.date === '2026-04-24' && iso(d.hw.end) === '2026-04-24T20:59:59.999Z', iso(d.hw.end));
t('DST start: watch deadline Wed 22 Apr ends at +02:00 (21:59Z)', d.watch.date === '2026-04-22' && iso(d.watch.end) === '2026-04-22T21:59:59.999Z', iso(d.watch.end));

// deadlineWhen
eq('deadlineWhen: today', L.deadlineWhen(NOW, '2026-10-16'), 'النهارده');
eq('deadlineWhen: tomorrow', L.deadlineWhen(NOW, '2026-10-17'), 'بكرة');
eq('deadlineWhen: later -> يوم {weekday} {d/m}', L.deadlineWhen(NOW, '2026-10-20'), 'يوم الثلاثاء 20/10');
eq('deadlineWhen: no zero padding, month rollover', L.deadlineWhen(new Date('2026-10-31T10:00:00Z'), '2026-11-03'), 'يوم الثلاثاء 3/11');
eq('deadlineWhen: Cairo midnight (00:30 Cairo on Nov 1 = 22:30Z on Oct 31)', L.deadlineWhen(new Date('2026-10-31T22:30:00Z'), '2026-11-01'), 'النهارده');
eq('deadlineWhen: accepts a deadline object', L.deadlineWhen(NOW, d.hw && { date: '2026-10-16' }), 'النهارده');

/* ------------------------------------------- verdicts: fixture, §4.2 */
const fx = OV.groups.map(g => g.settings);
eq('fixture sanity: 3 groups, 12 distinct students, 1 unclassified', [OV.groups.length, Object.keys(OV.students).length, OV.unclassified.length], [3, 12, 1]);
t('fixture sanity: every group has a current lesson and different review lesson(s); one group has two', fx.every(s => s.current_lesson && s.review_lessons.length) && fx[2].review_lessons.length === 2 && new Set(fx.map(s => s.review_lessons.join())).size === 3);

let s = who(G1, '01');                                           // Mariam, G1
eq('Mariam/G1: session_unfinished (online, 42 %)', [s.verdicts.session.state, s.verdicts.session.lesson], ['session_unfinished', F]);
t('Mariam/G1: session is DUE (watch deadline passed); homework NOT yet due (deadline is today)', s.verdicts.session.due === true && s.verdicts.homework[0].due === false && s.verdicts.homework[0].deadline_state === 'today');
eq('Mariam/G1: homework + quiz use the REVIEW lesson (lesson 1)', [s.verdicts.homework[0].lesson, s.verdicts.homework[0].state, s.verdicts.quiz[0].lesson, s.verdicts.quiz[0].state, s.verdicts.quiz[0].score], [V, 'homework_missing', V, 'quiz_taken', 7]);
eq('Mariam/G1: two issues, each with ITS OWN lesson', s.issues.map(i => [i.key, i.lesson]), [['session_unfinished', F], ['homework_missing', V]]);
t('Mariam/G1: combined primary action, count 2, not muted (one issue is due)', s.primaryAction.kind === 'combined' && s.primaryAction.count === 2 && !s.primaryAction.muted && !s.primaryAction.disabled, s.primaryAction);
eq('Mariam/G1: micro-chips order + labels', s.microChips.map(c => [c.key, c.label]), [['attendance', 'أونلاين'], ['watch', '▶ 42%'], ['homework', '📝 ✕'], ['quiz', '❓ 7/10']]);
eq('Mariam/G1: chip tones', s.microChips.map(c => c.tone), ['grey', 'red', 'amber', 'amber']);

s = who(G1, '02');                                               // Omar: lesson-2 attendance CENTER + lesson-1 quiz ABSENT
eq('Omar/G1: center -> session "optional", no session issue, not blocked', [s.verdicts.session.state, s.sessionBlocked, s.issues.some(i => i.kind === 'session')], ['optional', null, false]);
eq('Omar/G1: lesson-1 quiz ABSENT while lesson-2 is center', [s.verdicts.quiz[0].state, s.verdicts.quiz[0].lesson, s.verdicts.quiz[0].due], ['quiz_absent', V, true]);
eq('Omar/G1: single issue quiz_absent, due (always), label', [s.primaryAction.kind, s.primaryAction.key, s.primaryAction.muted, s.issues[0].label], ['single', 'quiz_absent', false, 'غائب عن الكويز – تعويض']);
eq('Omar/G1: chips (center / optional / hw ✓ / quiz absent)', s.microChips.map(c => c.label + '|' + c.tone), ['سنتر|green', '▶ اختياري|grey', '📝 ✓|green', '❓ غائب|red']);
eq('Omar/G1: praise = homework only (center + no watch)', s.praises.map(x => x.key), ['homework_done']);

s = who(G1, '03');                                               // Sara
eq('Sara/G1: session_done + all praise, no issues, primary none', [s.verdicts.session.state, s.praises.map(x => x.key), s.issues.length, s.primaryAction.kind], ['session_done', ['session_done', 'homework_done', 'quiz_praise'], 0, 'none']);

s = who(G1, '04');                                               // Hana: online, video locked
eq('Hana/G1: online + can_watch=false -> session_locked', s.verdicts.session.state, 'session_locked');
t('Hana/G1: locked maps to template session_unwatched, flagged locked', s.issues[0].key === 'session_unwatched' && s.issues[0].locked === true && s.issues[0].due === true, s.issues[0]);
eq('Hana/G1: chip "🔒 الفيديو مقفول" red', [s.microChips[1].label, s.microChips[1].tone], ['🔒 الفيديو مقفول', 'red']);
eq('Hana/G1: quiz 4/10 taken (not absent) is red', [s.verdicts.quiz[0].state, s.microChips[3].tone], ['quiz_taken', 'red']);

s = who(G1, '05');                                               // Nour: unmarked + no parent
eq('Nour/G1: attendance null -> needs_attendance', [s.verdicts.session.state, s.needsAttendance, s.flags.unmarked], ['needs_attendance', true, true]);
eq('Nour/G1: session buttons blocked «حدد الحضور أولًا», no session issue', [s.sessionBlocked, s.issues.some(i => i.kind === 'session')], ['حدد الحضور أولًا', false]);
eq('Nour/G1: attendance chip amber «الحضور غير محدد»', [s.microChips[0].label, s.microChips[0].tone], ['الحضور غير محدد', 'amber']);
t('Nour/G1: missing parent -> red chip, flag, buttons disabled', s.parent.level === 'missing' && s.microChips.some(c => c.key === 'parent' && c.label === '⚠️ لا رقم ولي أمر' && c.tone === 'red') && s.flags.noParent && s.primaryAction.disabled, s.parent);
t('Nour/G1: homework/quiz verdicts are NOT affected by unmarked attendance', s.verdicts.homework[0].state === 'homework_done' && s.verdicts.quiz[0].state === 'quiz_taken');

s = who(G2, '06');                                               // Adham: 85 % watched, quiz exactly 90 %
eq('Adham/G2: session_done at 85 %', s.verdicts.session.state, 'session_done');
t('Adham/G2: quiz 9/10 = 90 % IS praise (>= threshold)', s.verdicts.quiz[0].praise === true && s.praises.some(x => x.key === 'quiz_praise'));
s = who(G2, '07');                                               // Youssef: tracking row at 0 %, parent = own number
eq('Youssef/G2: online, can_watch, pct 0 -> session_unwatched', s.verdicts.session.state, 'session_unwatched');
t('Youssef/G2: watch deadline still upcoming -> muted, not due', s.verdicts.session.due === false && s.primaryAction.kind === 'combined' && s.primaryAction.muted === true, s.primaryAction);
t('Youssef/G2: parent = own number -> warn chip, buttons still usable', s.parent.level === 'warn' && s.microChips.some(c => c.key === 'parent' && c.tone === 'red') && !s.primaryAction.disabled);
s = who(G2, '08');                                               // Laila: center + 90 % + quiz absent
t('Laila/G2: center with >= 80 % is a praise candidate; quiz absent still an issue', s.verdicts.session.state === 'optional' && s.verdicts.session.praise && s.praises.some(x => x.key === 'session_done') && s.issues[0].key === 'quiz_absent');

s = who(G3, '09');                                               // Karim: two review lessons, one equals the current lesson
eq('Karim/G3: current lesson = lesson 2 (F)', s.verdicts.session.lesson, F);
eq('Karim/G3: review lessons -> one homework + quiz entry per lesson', [s.verdicts.homework.map(h => h.lesson + ':' + h.state), s.verdicts.quiz.map(q => q.lesson + ':' + q.state)], [[V + ':homework_missing', F + ':homework_done'], [V + ':quiz_absent', F + ':quiz_taken']]);
eq('Karim/G3: SAME lesson in both roles (F): session_unfinished AND quiz 8/10 for F', [s.verdicts.session.state, s.verdicts.quiz[1].score], ['session_unfinished', 8]);
eq('Karim/G3: 3 issues, combined, count 3', [s.issues.map(i => i.key + '@' + i.lesson.split('-').pop()), s.primaryAction.kind, s.primaryAction.count], [['session_unfinished@functions', 'homework_missing@variables', 'quiz_absent@variables'], 'combined', 3]);
t('Karim/G3: hw deadline OVERRIDE (10-15) makes homework due; watch (10-18) is not', s.verdicts.homework[0].due === true && s.verdicts.session.due === false);
eq('Karim/G3: chips for two review lessons show done/total', [s.microChips[2].label, s.microChips[2].tone], ['📝 ✕ 1/2', 'red']);
s = who(G3, '10');                                               // Dina: unmarked + malformed short parent
t('Dina/G3: unmarked + short parent = warn, cannot send (no wa)', s.needsAttendance && s.parent.level === 'warn' && s.primaryAction.disabled && s.microChips.some(c => c.key === 'parent'), s.parent);
s = who(G3, '11');                                               // Malak: center, all done, intl parent
t('Malak/G3: no issues, international parent number is ok (no chip)', s.issues.length === 0 && s.parent.ok && !s.microChips.some(c => c.key === 'parent') && s.microChips[3].label === '❓ 19/20');
// same student, two groups, different roles
let a = sum(G1, '1000000101'), b = sum(G3, '1000000101');
t('Mariam appears in two groups with group-specific verdicts (G1 hw not due, G3 hw due via override)', a.verdicts.homework[0].due === false && b.verdicts.homework[0].due === true && a.issues.length === 2 && b.issues.length === 3, [a.issues.length, b.issues.length]);

/* ---- unclassified pseudo-group (no schedule: nothing session/hw is "due", quiz absent always is) */
const pseudo = { group: 'unclassified', settings: { current_lesson: F, review_lessons: [V] }, members: OV.unclassified };
s = L.studentSummary(OV.unclassified[0], pseudo, OV);
t('Unclassified: no deadlines, hw missing is muted; quiz absent is due; combined', L.groupDeadlines(pseudo.settings, NOW).watch === null && s.issues.find(i => i.key === 'homework_missing').due === false && s.issues.find(i => i.key === 'quiz_absent').due === true && s.primaryAction.kind === 'combined', s.issues);
eq('Unclassified: facts exist for the picked lessons (Ziad watched 100 %)', s.verdicts.session.state, 'session_done');
t('Unclassified: no current lesson picked -> no_lesson, not "unmarked"', (() => { const x = L.studentSummary(OV.unclassified[0], { settings: {} }, OV); return x.verdicts.session.state === 'no_lesson' && !x.needsAttendance && x.microChips[0].label === '—' && x.verdicts.homework.length === 0; })());

/* --------------------------------------------------- lesson metadata & robustness */
let ov = clone(OV); ov.lessons[F].has_video = false; ov.lessons[V].has_assignment = false; ov.lessons[V].has_quiz = false;
s = L.studentSummary(G1.members[0], G1, ov);
t('has_video=false -> session no_video (no session issue)', s.verdicts.session.state === 'no_video' && !s.issues.some(i => i.kind === 'session'));
t('has_assignment/has_quiz=false -> no homework / quiz entries, chips "—"', s.verdicts.homework.length === 0 && s.verdicts.quiz.length === 0 && s.microChips[2].label === '📝 —' && s.microChips[3].label === '❓ —');
t('no_video lesson with unmarked attendance still counts as unmarked (center unlock applies)', (() => { const x = L.studentSummary(G1.members[4], G1, ov); return x.verdicts.session.state === 'no_video' && x.needsAttendance; })());
ov = clone(OV); delete ov.facts['1000000102'];
s = L.studentSummary(G1.members[1], G1, ov);
t('student with no facts at all: unmarked, hw missing, quiz absent, no crash', s.needsAttendance && s.verdicts.homework[0].state === 'homework_missing' && s.verdicts.quiz[0].state === 'quiz_absent');
ov = clone(OV); delete ov.lessons; delete ov.settings;
s = L.studentSummary(G1.members[0], G1, ov);
t('no lesson metadata / settings: defaults used (has everything, 80 %, 90 %)', s.verdicts.session.state === 'session_unfinished' && s.verdicts.quiz.length === 1);
ov = clone(OV); ov.settings.watch_done_pct = 40;
eq('settings.watch_done_pct honoured (42 % >= 40 -> done)', L.studentSummary(G1.members[0], G1, ov).verdicts.session.state, 'session_done');
ov = clone(OV); ov.facts['1000000101'][F].watch_pct = 80;
eq('watch boundary: exactly 80 % = done', L.studentSummary(G1.members[0], G1, ov).verdicts.session.state, 'session_done');
ov.facts['1000000101'][F].watch_pct = 79.9;
eq('watch boundary: 79.9 % = unfinished', L.studentSummary(G1.members[0], G1, ov).verdicts.session.state, 'session_unfinished');
ov = clone(OV); ov.settings.praise_quiz_pct = 70;
t('settings.praise_quiz_pct honoured (7/10 is praise at 70)', L.studentSummary(G1.members[0], G1, ov).praises.some(x => x.key === 'quiz_praise'));
ov = clone(OV); G1b = clone(G1); G1b.settings.review_lessons = JSON.stringify([V, V, '']);
eq('review_lessons as a JSON string, de-duplicated, blanks dropped', L.studentVerdicts(G1.members[0], G1b.settings, ov).homework.length, 1);
t('a student given only {phone} picks name/parent from overview.students', L.studentSummary({ phone: '+20 100 000 0105' }, G1, OV).parent.level === 'missing' && L.studentSummary({ phone: '01000000105' }, G1, OV).student.name === 'Nour Hassan');
t('facts key lookup is case/format-insensitive on phone (+20, spaces, Arabic digits)', L.studentSummary({ phone: '٠١٠٠٠٠٠٠١٠٣' }, G1, OV).verdicts.session.state === 'session_done');
t('studentSummary default `now` = overview.now (deterministic)', JSON.stringify(L.studentSummary(G1.members[0], G1, OV)) === JSON.stringify(L.studentSummary(G1.members[0], G1, OV, NOW)));

/* --------------------------------------------------------- groupSummary */
let gs = L.groupSummary(G1, OV);
t('G1 counts: unmarked 1, unwatched 1 (locked 1), unfinished 1, hwMissing 2, quizAbsent 1, noParent 1, late 3', gs.unmarked === 1 && gs.unwatched === 1 && gs.locked === 1 && gs.unfinished === 1 && gs.hwMissing === 2 && gs.quizAbsent === 1 && gs.noParent === 1 && gs.late === 3 && gs.total === 5, gs);
eq('G1 lists: names for the copy / filter actions', [gs.unmarkedStudents.map(x => x.name), gs.hwMissingStudents.map(x => x.name), gs.quizAbsentStudents.map(x => x.name), gs.unwatchedStudents.map(x => x.name)], [['Nour Hassan'], ['Mariam Ahmed', 'Hana Sami'], ['Omar Khaled'], ['Hana Sami']]);
eq('G1 rows: one per member, in order', gs.rows.map(r => r.name), G1.members.map(m => m.name));
gs = L.groupSummary(G2, OV);
t('G2 counts: unwatched 1, hwMissing 1, quizAbsent 1 (Laila), noParent 1 (Youssef warn), late 1', gs.unmarked === 0 && gs.unwatched === 1 && gs.hwMissing === 1 && gs.quizAbsent === 1 && gs.noParent === 1 && gs.late === 1, gs);
gs = L.groupSummary(G3, OV);
t('G3 counts: unmarked 1, unfinished 2, hwMissing 2, quizAbsent 3, noParent 1', gs.unmarked === 1 && gs.unfinished === 2 && gs.hwMissing === 2 && gs.quizAbsent === 3 && gs.noParent === 1 && gs.total === 4, gs);
t('G3 deadlines exposed (hw override overdue, watch upcoming)', gs.deadlines.hw.overridden && gs.deadlines.hw.state === 'overdue' && gs.deadlines.watch.state === 'upcoming');
t('noWatchData false when someone has a tracking row', L.groupSummary(G1, OV).noWatchData === false);
ov = clone(OV); Object.keys(ov.facts).forEach(k => ov.facts[k][F].watch_pct = null);
t('noWatchData true when nobody has a tracking row for the current lesson', L.groupSummary(G1, ov).noWatchData === true);
t('noWatchData false when no current lesson is set', L.groupSummary({ settings: {}, members: G1.members }, OV).noWatchData === false);
gs = L.groupSummary(pseudo, OV); t('groupSummary on the unclassified pseudo-group', gs.total === 1 && gs.hwMissing === 1 && gs.quizAbsent === 1 && gs.unmarked === 0, gs);
gs = L.groupSummary({ settings: G1.settings, members: [] }, OV); t('empty group: all zero, no crash', gs.total === 0 && gs.unmarked === 0 && gs.noWatchData === false);
t('no crash on null group / student', (() => { try { L.groupSummary(null, OV); L.studentSummary(null, null, OV); L.studentVerdicts(null, null, OV); return true; } catch (e) { return false; } })());

/* -------------------------------------------------------------------- end */
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
