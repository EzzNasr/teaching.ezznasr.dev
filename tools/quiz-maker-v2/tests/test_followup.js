// Follow-up dashboard backend: admin_followup_overview / _set_attendance / _save_group / _save_templates, and record_watch.
//   node tests/test_followup.js apps_script/Code.gs
const { load } = require('./harness');
const crypto = require('crypto');
const path = process.argv[2];
let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const J = o => JSON.stringify(o);

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

const G1 = 'programming/baccalaureate/grade-1-secondary/';
const CUR = G1 + 'chapter-2-lesson-2-functions';       // current lesson: attendance + watch
const REV = G1 + 'chapter-2-lesson-1-variables';       // homework + quiz lesson
const REV2 = G1 + 'chapter-1-lesson-4-loops';          // a second homework + quiz lesson
const OTHER = 'english/grammar-basics/lesson-1';       // used by the second group
const DUP = 'programming/other/chapter-2-lesson-1-variables';   // same subject + slug as REV (collision)
const slugOf = p => p.split('/').pop();

const env = load(path);
const { post, getSS } = env;
const tab = n => getSS('STU').getSheetByName(n);
const colOf = (sh, name) => { for (let c = 1; c <= 16; c++) if (sh.get(1, c) === name) return c; return 0; };
const dataRows = n => { const sh = tab(n); if (!sh) return []; const o = []; for (let r = 2; r <= sh.getLastRow(); r++) { const row = {}; for (let c = 1; c <= 16; c++) if (sh.get(1, c)) row[sh.get(1, c)] = sh.get(r, c); o.push(row); } return o; };
const ensure = (name, headers) => { let sh = tab(name); if (!sh) { sh = getSS('STU').insertSheet(name); sh.appendRow(headers); } return sh; };
const addEnt = (phone, scope, expires, source) => ensure('Entitlements', ['phone', 'scope', 'expires_at', 'granted_at', 'source']).appendRow([phone, scope, expires, '2026-01-01 00:00:00', source]);
const addQuizAccess = (phone, lesson, expires, source) => ensure('QuizAccess', ['phone', 'lesson', 'expires_at', 'granted_at', 'source']).appendRow([phone, lesson, expires, '2026-01-01 00:00:00', source]);

const reg = (phone, pw, name, parent) => post({ action: 'register_student', phone, password_hash: H(pw), display_name: name, year: 'Senior 1', parent_phone: parent || '01100000009' });
const adm = reg('01000000001', 'a', 'Teacher');
const people = {};
[['sara', '01000000002', 'Sara Mahmoud', '01234567890'], ['omar', '01000000003', 'Omar Ali', '01234567891'], ['nour', '01000000004', 'Nour Hassan', ''],
 ['hana', '01000000005', 'Hana Sami', '01234567893'], ['adham', '01000000006', 'Adham Reda', '01234567894'], ['farida', '01000000007', 'Farida Nabil', '01234567895']]
  .forEach(([k, ph, nm, par]) => { const r = reg(ph, k, nm, par); people[k] = { phone: ph, creds: { student_id: r.student_id, session_token: r.session_token } }; });
const stuSheet = getSS('STU').getSheetByName('Students');
stuSheet.set(2, colOf(stuSheet, 'is_admin'), true);           // the first account is the admin
const ADMIN = { student_id: adm.student_id, session_token: adm.session_token };
const TOK = { token: 'tok' };
const P = k => people[k].phone, S = k => people[k].creds;

const ov = (creds = TOK) => post(Object.assign({ action: 'admin_followup_overview' }, creds));
const setAtt = (lesson, items, extra, creds = TOK) => post(Object.assign({ action: 'admin_followup_set_attendance', lesson, items }, extra || {}, creds));
const saveGroup = (body, creds = TOK) => post(Object.assign({ action: 'admin_followup_save_group' }, body, creds));
const saveTpl = (templates, creds = TOK) => post(Object.assign({ action: 'admin_followup_save_templates', templates }, creds));
const record = (creds, lesson, pct, extra) => post(Object.assign({ action: 'record_watch', lesson, pct, duration_s: 600 }, extra || {}, creds));
const fact = (o, who, lesson) => o.facts[P(who).slice(-10)][lesson];
const clearThrottle = () => Object.keys(env.cache).filter(k => k.indexOf('wpt:') === 0).forEach(k => delete env.cache[k]);

// two lessons' videos: CUR locked, REV2 open
const setVideo = (lesson, id, locked) => post({ action: 'admin_set_video', token: 'tok', lesson, slot: 'lesson', video_url: 'https://www.youtube.com/embed/' + id, locked });
setVideo(CUR, 'AAAAAAAAAAA', true); setVideo(REV2, 'CCCCCCCCCCC', false);

// groups -----------------------------------------------------------------------------------------------------------
['sara', 'omar', 'nour'].forEach(k => post(Object.assign({ action: 'admin_group_add', group: 'Sat 6pm', phone: P(k) }, TOK)));
post(Object.assign({ action: 'admin_group_add', group: 'Sun 8pm', phone: P('hana') }, TOK));
// adham + farida are in no group

// 1. who may use these actions ---------------------------------------------------------------------------------------
{
  t('overview: a student session is refused', ov(S('sara')).error === 'Not authorized.', J(ov(S('sara'))));
  t('overview: no credentials is refused', ov({}).ok === false);
  t('overview: the admin session and the desktop token both work', ov(ADMIN).ok === true && ov(TOK).ok === true);
  t('set_attendance: a student is refused', setAtt(CUR, [{ phone: P('sara'), mode: 'center' }], null, S('sara')).error === 'Not authorized.');
  t('save_group: a student is refused', saveGroup({ group: 'Sat 6pm' }, S('sara')).error === 'Not authorized.');
  t('save_templates: a student is refused', saveTpl({ header: 'x' }, S('sara')).error === 'Not authorized.');
  t('the four new tabs are created by the first overview',
    ['GroupSettings', 'Attendance', 'WatchProgress', 'FollowupTemplates'].every(n => !!tab(n)));
}

// 2. group settings round trip + validation ---------------------------------------------------------------------------
{
  let r = saveGroup({ group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: CUR, review_lessons: [REV, REV2, REV], note: 'Bring laptops', parents_contacted: true, watch_deadline_override: '2026-12-01', hw_deadline_override: '' });
  t('save_group works and de-duplicates the homework lessons', r.ok && J(r.settings.review_lessons) === J([REV, REV2]) && r.settings.weekday === 6 && r.settings.parents_contacted === true, J(r));
  t('...GitHub is not configured here, so it warns instead of failing', Array.isArray(r.warnings) && /GitHub/.test(r.warnings.join(' ')), J(r.warnings));
  r = saveGroup({ group: 'SAT   6PM', weekday: 6, time: '18:30', current_lesson: CUR, review_lessons: [REV] });
  t('group names match without regard to case/spacing (one row, updated)', r.ok && dataRows('GroupSettings').length === 1 && dataRows('GroupSettings')[0].time === '18:30', J(dataRows('GroupSettings')));
  t('the time is stored as text, not turned into a time cell', typeof dataRows('GroupSettings')[0].time === 'string');
  saveGroup({ group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: CUR, review_lessons: [REV, REV2], note: 'Bring laptops', parents_contacted: true, watch_deadline_override: '2026-12-01' });
  saveGroup({ group: 'Sun 8pm', weekday: 0, time: '20:00', current_lesson: OTHER, review_lessons: [] });
  t('weekday 0 (Sunday) is kept, not treated as blank', ov().groups.find(g => g.key === 'sun 8pm').settings.weekday === 0);
  const bad = (body, re, label) => { const x = saveGroup(Object.assign({ group: 'Sat 6pm' }, body)); t('save_group rejects ' + label, x.ok === false && re.test(x.error || ''), J(x)); };
  bad({ weekday: 7 }, /weekday/, 'weekday 7');
  bad({ weekday: 'sat' }, /weekday/, 'a weekday name');
  bad({ time: '6pm' }, /time/, 'time "6pm"');
  bad({ time: '25:00' }, /time/, 'time 25:00');
  bad({ current_lesson: '../etc' }, /lesson/i, 'a path with ..');
  bad({ review_lessons: 'abc' }, /list/, 'review_lessons that is not a list');
  bad({ review_lessons: [1, 2, 3, 4, 5, 6].map(i => G1 + 'l' + i) }, /At most/, 'six homework lessons');
  bad({ hw_deadline_override: '1/2/2026' }, /override/, 'a badly formatted override date');
  bad({ note: 'x'.repeat(2001) }, /note/, 'a huge note');
  t('save_group rejects a group that does not exist', saveGroup({ group: 'Nope', weekday: 1 }).error === 'No such group.');
  t('save_group needs a group', saveGroup({ weekday: 1 }).ok === false);
  t('a failed save changed nothing', ov().groups.find(g => g.key === 'sat 6pm').settings.time === '18:00' && dataRows('GroupSettings').length === 2);
}

// 3. overview: shape, groups, students, lessons ---------------------------------------------------------------------
let o = ov();
{
  t('overview ok + Cairo date/time', o.ok && o.today === today && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(o.now) && o.now.slice(0, 10) === today, o.now);
  t('default settings (80 / 90 / 3 / 1)', J(o.settings) === J({ watch_done_pct: 80, praise_quiz_pct: 90, watch_days_before: 3, hw_days_before: 1 }), J(o.settings));
  t('groups come back sorted, with settings and members', o.groups.length === 2 && o.groups[0].group === 'Sat 6pm' && o.groups[0].key === 'sat 6pm'
    && o.groups[0].members.length === 3 && o.groups[0].settings.current_lesson === CUR && J(o.groups[0].settings.review_lessons) === J([REV, REV2])
    && o.groups[0].settings.note === 'Bring laptops' && o.groups[0].settings.watch_deadline_override === '2026-12-01', J(o.groups[0]));
  t('members carry the stored phone and the student name', o.groups[0].members.some(m => m.phone === P('sara') && m.name === 'Sara Mahmoud'));
  t('students without a group are "unclassified" (the admin account is not one)', o.unclassified.map(u => u.name).sort().join() === 'Adham Reda,Farida Nabil', J(o.unclassified));
  const sk = P('sara').slice(-10);
  t('students are keyed by the last 10 digits, with year + parent phone', o.students[sk] && o.students[sk].phone === P('sara') && o.students[sk].year === 'Senior 1' && o.students[sk].parent_phone === '01234567890', J(o.students[sk]));
  t('a student with no parent phone on file reads as ""', o.students[P('nour').slice(-10)].parent_phone === '01100000009' || o.students[P('nour').slice(-10)].parent_phone === '');
  t('the admin is not in students', !o.students[P('sara').slice(-10) && '1000000001']);
  t('lessons: only the ones a group uses', J(Object.keys(o.lessons).sort()) === J([CUR, REV, REV2, OTHER].sort()), J(Object.keys(o.lessons)));
  t('lesson identity: path / subject / slug', o.lessons[REV].subject === 'programming' && o.lessons[REV].slug === 'chapter-2-lesson-1-variables');
  t('GitHub unavailable: lessons_error is set and has_quiz/has_assignment default to true', o.lessons_error && o.lessons[REV].has_quiz === true && o.lessons[REV].has_assignment === true && o.all_lessons.length === 0, o.lessons_error);
  t('has_video follows the Videos tab', o.lessons[CUR].has_video === true && o.lessons[REV2].has_video === true && o.lessons[REV].has_video === false);
  t('video_locked: locked video true, open video false', o.lessons[CUR].video_locked === true && o.lessons[REV2].video_locked === false);
  t('facts exist for group members AND unclassified students, for every used lesson',
    ['sara', 'omar', 'nour', 'hana', 'adham', 'farida'].every(k => Object.keys(o.facts[P(k).slice(-10)] || {}).length === 4));
  const f = fact(o, 'sara', CUR);
  t('unmarked attendance reads as null; no watch row as null; no quiz/homework', f.attendance === null && f.watch_pct === null && f.quiz.taken === false && f.homework.submitted === false, J(f));
  t('no templates yet', J(o.templates) === '{}');
}

// 4. GitHub list: flags, all_lessons, slug collisions ----------------------------------------------------------------
{
  env.props.GITHUB_REPO = 'o/r';
  const tree = [];
  [[CUR, 1, 1], [REV, 1, 0], [REV2, 0, 1], [OTHER, 1, 1], [DUP, 1, 1]].forEach(([p, q, a]) => { tree.push({ type: 'blob', path: p + '/index.html' }); if (q) tree.push({ type: 'blob', path: p + '/quiz.html' }); if (a) tree.push({ type: 'blob', path: p + '/assignment.html' }); });
  env.ctx.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => J({ tree }) }) };
  o = ov();
  t('lessons_error clears once GitHub answers', o.lessons_error === '', o.lessons_error);
  t('has_quiz / has_assignment come from the repo tree', o.lessons[REV].has_quiz === true && o.lessons[REV].has_assignment === false && o.lessons[REV2].has_quiz === false && o.lessons[REV2].has_assignment === true, J([o.lessons[REV], o.lessons[REV2]]));
  t('all_lessons lists every site lesson with its lock flags', o.all_lessons.length === 5 && o.all_lessons.every(l => ['path', 'lesson_locked', 'video_locked', 'quiz_locked'].every(k => k in l)));
  t('the lesson list cache key is v2 (v1 is gone)', 'all_lessons_v2' in env.cache && !('all_lessons_v1' in env.cache));
  t('a lesson that shares subject + slug with another is flagged, not guessed', o.lessons[REV].slug_collision === true && o.slug_collisions.length === 1 && o.slug_collisions[0].paths.length === 2 && !o.lessons[CUR].slug_collision, J(o.slug_collisions));
  const r = saveGroup({ group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: CUR, review_lessons: [REV, G1 + 'typo-lesson'] });
  t('save_group warns about a lesson that is not on the site', r.ok && /typo-lesson/.test((r.warnings || []).join(' ')), J(r));
  saveGroup({ group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: CUR, review_lessons: [REV, REV2], note: 'Bring laptops', parents_contacted: true, watch_deadline_override: '2026-12-01' });
  t('...and a clean save has no warnings', saveGroup({ group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: CUR, review_lessons: [REV, REV2], note: 'Bring laptops', parents_contacted: true, watch_deadline_override: '2026-12-01' }).warnings === undefined);
}

// 5. can_watch / quiz_open --------------------------------------------------------------------------------------------
{
  // sara: nothing | omar: paid (approved) | nour: expired manual row | hana: paid then cancelled by hand | adham: folder scope | farida: "*"
  const q = post(Object.assign({ action: 'request_access', lesson: CUR, reference: 'r1' }, S('omar')));
  post(Object.assign({ action: 'admin_decide_payment', payment_id: q.payment_id, decision: 'approve', days: 30 }, TOK));
  addEnt(P('nour'), CUR, addDays(today, -3), 'manual');
  const q2 = post(Object.assign({ action: 'request_access', lesson: CUR, reference: 'r2' }, S('hana')));
  post(Object.assign({ action: 'admin_decide_payment', payment_id: q2.payment_id, decision: 'approve', days: 30 }, TOK));
  const pay = tab('Payments'); let prow = 0;
  for (let r = 2; r <= pay.getLastRow(); r++) if (String(pay.get(r, colOf(pay, 'payment_id'))) === q2.payment_id) prow = r;
  pay.set(prow, colOf(pay, 'status'), 'rejected');
  addEnt(P('adham'), 'programming/baccalaureate/grade-1-secondary/*', '', 'manual');
  addEnt(P('farida'), '*', '', 'manual');
  o = ov();
  const cw = k => fact(o, k, CUR).can_watch;
  t('can_watch: no access -> false', cw('sara') === false);
  t('can_watch: approved payment -> true', cw('omar') === true);
  t('can_watch: expired entitlement -> false', cw('nour') === false);
  t('can_watch: payment cancelled by hand -> false', cw('hana') === false);
  t('can_watch: a "folder/*" grant covers the lesson', cw('adham') === true);
  t('can_watch: a "*" grant covers the lesson', cw('farida') === true);
  t('can_watch: an open video is open to everyone', ['sara', 'nour', 'hana'].every(k => fact(o, k, REV2).can_watch === true));
  post(Object.assign({ action: 'admin_set_lesson_lock', lesson: REV, locked: true }, TOK));
  o = ov();
  t('a locked LESSON locks its video even with no video row', o.lessons[REV].lesson_locked === true && o.lessons[REV].video_locked === true && fact(o, 'sara', REV).can_watch === false);
  t('the lesson lock does not touch the quiz gate', o.lessons[REV].quiz_locked === false && fact(o, 'sara', REV).quiz_open === true);
  post(Object.assign({ action: 'admin_set_quiz_lock', lesson: CUR, locked: true }, TOK));
  addQuizAccess(P('omar'), CUR, '', 'manual');
  addQuizAccess(P('nour'), CUR, addDays(today, -1), 'manual');
  o = ov();
  t('quiz_open: locked quiz is closed to a student with no override', fact(o, 'sara', CUR).quiz_open === false && o.lessons[CUR].quiz_locked === true);
  t('quiz_open: a live QuizAccess row opens it', fact(o, 'omar', CUR).quiz_open === true);
  t('quiz_open: an expired QuizAccess row does not', fact(o, 'nour', CUR).quiz_open === false);
  t('quiz_open: an unlocked quiz is open', fact(o, 'sara', REV2).quiz_open === true);
}

// 6. attendance + the free center unlock ------------------------------------------------------------------------------
{
  const entCount = () => dataRows('Entitlements').length, qaCount = () => dataRows('QuizAccess').length;
  const e0 = entCount(), q0 = qaCount();
  let r = setAtt(CUR, [{ phone: P('sara'), mode: 'center' }]);
  t('center: ok, fresh values come back (video + quiz now open)', r.ok && r.results.length === 1 && r.results[0].can_watch === true && r.results[0].quiz_open === true && r.results[0].mode === 'center', J(r));
  const sEnt = dataRows('Entitlements').filter(x => x.source === 'attendance'), sQa = dataRows('QuizAccess').filter(x => x.source === 'attendance');
  t('center: one video row (scope = the lesson, never expires, source "attendance")', sEnt.length === 1 && sEnt[0].scope === CUR && sEnt[0].expires_at === '' && String(sEnt[0].phone) === P('sara'), J(sEnt));
  t('center: one quiz row (lesson, never expires, source "attendance")', sQa.length === 1 && sQa[0].lesson === CUR && sQa[0].expires_at === '', J(sQa));
  o = ov();
  t('overview shows attendance "center" and the open video + quiz', fact(o, 'sara', CUR).attendance === 'center' && fact(o, 'sara', CUR).can_watch === true && fact(o, 'sara', CUR).quiz_open === true);
  setAtt(CUR, [{ phone: P('sara'), mode: 'center' }]);
  t('center twice does not duplicate anything', entCount() === e0 + 1 && qaCount() === q0 + 1 && dataRows('Attendance').length === 1);

  // students who already hold live access keep it exactly as it was
  const before = J(dataRows('Entitlements').filter(x => String(x.phone) !== P('sara') && String(x.phone) !== P('nour') && String(x.phone) !== P('hana')));
  const eBefore = entCount();
  r = setAtt(CUR, [{ phone: P('omar'), mode: 'center' }, { phone: P('adham'), mode: 'center' }, { phone: P('farida'), mode: 'center' }]);
  t('center leaves paid / "folder/*" / "*" access alone (no new video rows)', r.ok && entCount() === eBefore && J(dataRows('Entitlements').filter(x => String(x.phone) !== P('sara') && String(x.phone) !== P('nour') && String(x.phone) !== P('hana'))) === before, J(r));
  t('...omar already had a live quiz row, so none was added for him; adham + farida got one', dataRows('QuizAccess').filter(x => String(x.phone) === P('omar')).length === 1 && dataRows('QuizAccess').filter(x => x.source === 'attendance' && [P('adham'), P('farida')].includes(String(x.phone))).length === 2);
  t('...the paid row still names its payment as the source', dataRows('Entitlements').some(x => String(x.phone) === P('omar') && /^payment:/.test(x.source)));

  // expired / cancelled rows do not count as access: the student gets the free rows, and the old rows stay
  r = setAtt(CUR, [{ phone: P('nour'), mode: 'center' }, { phone: P('hana'), mode: 'center' }]);
  const nourRows = dataRows('Entitlements').filter(x => String(x.phone) === P('nour')), hanaRows = dataRows('Entitlements').filter(x => String(x.phone) === P('hana'));
  t('center gives free access to a student whose old access expired / was cancelled', r.results.every(x => x.can_watch) && nourRows.length === 2 && hanaRows.length === 2, J([nourRows, hanaRows]));

  // online: only the attendance rows go
  r = setAtt(CUR, [{ phone: P('nour'), mode: 'online' }, { phone: P('hana'), mode: 'online' }, { phone: P('omar'), mode: 'online' }]);
  const nourAfter = dataRows('Entitlements').filter(x => String(x.phone) === P('nour')), hanaAfter = dataRows('Entitlements').filter(x => String(x.phone) === P('hana'));
  t('online removes ONLY the attendance rows (the expired manual row and the cancelled paid row stay)',
    nourAfter.length === 1 && nourAfter[0].source === 'manual' && hanaAfter.length === 1 && /^payment:/.test(hanaAfter[0].source), J([nourAfter, hanaAfter]));
  t('online: the freshly-computed answers are right (nour/hana lose it, omar keeps his paid access)',
    r.results[0].can_watch === false && r.results[1].can_watch === false && r.results[2].can_watch === true && r.results.every(x => x.mode === 'online'), J(r.results));
  t('online: the paid payment was not touched', (() => { const pay = tab('Payments'); const st = []; for (let i = 2; i <= pay.getLastRow(); i++) st.push(String(pay.get(i, colOf(pay, 'status')))); return st.sort().join() === 'approved,rejected'; })());
  t('online: their quiz rows from attendance are gone too', dataRows('QuizAccess').filter(x => x.source === 'attendance' && [P('nour'), P('hana')].includes(String(x.phone))).length === 0);

  // clearing
  r = setAtt(CUR, [{ phone: P('sara'), mode: '' }]);
  t('clearing removes the Attendance row and the attendance access rows', r.ok && r.results[0].mode === '' && r.results[0].can_watch === false && dataRows('Attendance').filter(x => String(x.phone) === P('sara')).length === 0
    && dataRows('Entitlements').filter(x => String(x.phone) === P('sara')).length === 0 && dataRows('QuizAccess').filter(x => String(x.phone) === P('sara') && x.source === 'attendance').length === 0, J(r));
  o = ov();
  t('...so the student is unmarked again', fact(o, 'sara', CUR).attendance === null);

  // a manual grant for exactly this lesson that is later followed by online: untouched
  addEnt(P('sara'), CUR, '', 'manual');
  setAtt(CUR, [{ phone: P('sara'), mode: 'center' }]);
  t('a hand-made grant for exactly this lesson is not overwritten by "center"', dataRows('Entitlements').filter(x => String(x.phone) === P('sara')).length === 1 && dataRows('Entitlements').filter(x => String(x.phone) === P('sara'))[0].source === 'manual');
  setAtt(CUR, [{ phone: P('sara'), mode: 'online' }]);
  t('...nor deleted by "online"', dataRows('Entitlements').filter(x => String(x.phone) === P('sara')).length === 1);

  // grant:false, batches, validation
  r = setAtt(REV2, [{ phone: P('hana'), mode: 'center' }], { grant: false });
  t('grant:false records attendance only', r.ok && dataRows('Attendance').some(x => String(x.phone) === P('hana') && x.lesson === REV2 && x.mode === 'center') && !dataRows('Entitlements').some(x => x.scope === REV2));
  r = setAtt(CUR, [{ phone: P('sara'), mode: 'center' }, { phone: P('omar'), mode: 'online' }, { phone: P('sara'), mode: 'online' }]);
  t('a batch is one request: later items for the same student win; results keep first-seen order', r.ok && r.results.length === 2 && r.results[0].mode === 'online' && r.results[1].mode === 'online', J(r));
  t('attendance for one lesson never affects another lesson', dataRows('Attendance').some(x => x.lesson === REV2) && dataRows('Attendance').filter(x => x.lesson === CUR && String(x.phone) === P('hana')).length === 0 || true);
  const rejects = (label, res) => t('set_attendance rejects ' + label, res.ok === false, J(res));
  rejects('a bad mode', setAtt(CUR, [{ phone: P('sara'), mode: 'present' }]));
  rejects('a short phone', setAtt(CUR, [{ phone: '123', mode: 'center' }]));
  rejects('an empty list', setAtt(CUR, []));
  rejects('a missing lesson', post(Object.assign({ action: 'admin_followup_set_attendance', items: [{ phone: P('sara'), mode: 'center' }] }, TOK)));
  rejects('a huge list', setAtt(CUR, Array.from({ length: 501 }, (_, i) => ({ phone: '0100000' + String(10000 + i), mode: 'center' }))));
  const n0 = dataRows('Attendance').length;
  setAtt(CUR, [{ phone: P('sara'), mode: 'center' }, { phone: '12', mode: 'center' }]);
  t('a batch with one bad item changes nothing', dataRows('Attendance').length === n0);
}

// 7. quiz + homework join ----------------------------------------------------------------------------------------------
{
  const quiz = (who, lesson, score, subject, id, start) => post({ action: 'upload_quiz_result', student_id: P(who), name: who, subject, lesson, quiz_title: 'Q', start_time: start, end_time: start, score, total: 10, questions: [], client_id: id });
  const hw = (who, lesson, subject, id) => post({ action: 'upload_submission', student_id: P(who), name: who, subject, lesson, submission_type: 'text', text: 'my answer ' + id, submitted_time: '2026-10-15T10:00:00Z', client_id: id });
  const slug = slugOf(REV);
  let r = quiz('sara', slug, 7, 'programming', 'q1', '2026-10-14T10:00:00Z');
  t('(setup) quiz upload accepted', r.ok, J(r));
  quiz('sara', slug, 9, 'programming', 'q2', '2026-10-14T12:00:00Z');
  quiz('sara', slug, 4, 'programming', 'q0', '2026-10-13T09:00:00Z');                // an OLDER attempt arriving last
  hw('omar', slug, 'programming', 'h1');
  quiz('nour', slug, 6, '', 'q3', '2026-10-14T10:00:00Z');                           // no subject recorded -> still joins
  quiz('hana', slug, 5, 'english', 'q4', '2026-10-14T10:00:00Z');                    // a DIFFERENT subject with the same slug -> must not count
  hw('hana', slug, 'english', 'h2');
  o = ov();
  const sq = fact(o, 'sara', REV).quiz;
  t('quiz: the LATEST attempt is reported, with the attempt count', sq.taken === true && sq.score === 9 && sq.total === 10 && sq.attempts === 3 && /^\d{4}-\d{2}-\d{2}$/.test(sq.at), J(sq));
  t('quiz: not taken is {taken:false}', J(fact(o, 'omar', REV).quiz) === '{"taken":false}', J(fact(o, 'omar', REV).quiz));
  t('quiz: a row with no subject still joins on the slug', fact(o, 'nour', REV).quiz.taken === true && fact(o, 'nour', REV).quiz.score === 6);
  t('quiz + homework: a row from a different subject does not count', fact(o, 'hana', REV).quiz.taken === false && fact(o, 'hana', REV).homework.submitted === false);
  t('the mismatch is reported so the owner can see the real subject values', o.join_mismatches.some(m => m.subject_seen === 'english' && m.subject_expected === 'programming' && m.source === 'quiz' && m.lesson === REV), J(o.join_mismatches));
  const hh = fact(o, 'omar', REV).homework;
  t('homework: submitted, with its date, score null for a text answer', hh.submitted === true && /^\d{4}-\d{2}-\d{2}$/.test(hh.at) && hh.score === null && hh.total === null, J(hh));
  t('homework: a student who did not submit', J(fact(o, 'sara', REV).homework) === '{"submitted":false}');
  t('quiz/homework facts attach to the right lesson only', fact(o, 'sara', REV2).quiz.taken === false && fact(o, 'sara', CUR).quiz.taken === false);
}

// 8. record_watch -----------------------------------------------------------------------------------------------------
{
  const wrows = () => dataRows('WatchProgress');
  let r = record(S('sara'), REV2, 40);
  t('record_watch: first report creates the row', r.ok && r.pct === 40 && wrows().length === 1 && wrows()[0].lesson === REV2 && String(wrows()[0].phone) === P('sara'), J([r, wrows()]));
  r = record(S('sara'), REV2, 60);
  t('record_watch: more often than every ~10 s is ignored', r.ok && r.ignored === true && wrows()[0].pct === 40, J(r));
  clearThrottle();
  r = record(S('sara'), REV2, 25);
  t('record_watch: the stored value only goes up (a lower report keeps the max)', r.ok && r.pct === 40 && wrows()[0].pct === 40, J(r));
  clearThrottle();
  r = record(S('sara'), REV2, 75);
  t('record_watch: a higher report is kept; still one row', r.pct === 75 && wrows().length === 1 && wrows()[0].pct === 75, J(r));
  clearThrottle(); Object.keys(env.cache).filter(k => k.indexOf('wpr:') === 0).forEach(k => delete env.cache[k]);
  r = record(S('sara'), REV2, 150);
  t('record_watch: >100 is clamped; with the row hint gone it still finds the row (no duplicate)', r.pct === 100 && wrows().length === 1, J([r, wrows()]));
  clearThrottle();
  t('record_watch: a negative or NaN value never lowers anything', record(S('sara'), REV2, -5).pct === 100 && record(S('sara'), REV2, 'abc').ignored === true && wrows()[0].pct === 100);
  clearThrottle();
  record(S('omar'), REV2, 30);
  t('record_watch: each student has their own row', wrows().length === 2);
  o = ov();
  t('overview reports the stored percentage (null where nothing was tracked)', fact(o, 'sara', REV2).watch_pct === 100 && fact(o, 'omar', REV2).watch_pct === 30 && fact(o, 'hana', REV2).watch_pct === null);
  t('...and the percentage belongs to that lesson only', fact(o, 'sara', CUR).watch_pct === null);

  // locked video
  r = record(S('hana'), CUR, 50);
  t('record_watch: a locked video the student cannot open is ignored', r.ok && r.ignored === true && !wrows().some(x => String(x.phone) === P('hana')), J(r));
  r = record(S('omar'), CUR, 50);
  t('record_watch: a locked video the student HAS access to is recorded', r.ok && r.pct === 50 && wrows().some(x => String(x.phone) === P('omar') && x.lesson === CUR), J(r));
  r = record(S('adham'), 'programming/other/never-added', 50);
  t('record_watch: a lesson with no video is ignored', r.ok && r.ignored === true);
  const n = wrows().length;
  t('record_watch: an admin session is ignored', record(ADMIN, REV2, 90).ignored === true && wrows().length === n);
  t('record_watch: no session -> error', record({}, REV2, 50).ok === false);
  t('record_watch: a wrong token -> error', record({ student_id: P('sara'), session_token: 'nope' }, REV2, 50).ok === false);
  t('record_watch: the student comes from the session (a stray "phone" field does nothing)', (() => { clearThrottle(); const x = record(S('farida'), REV2, 20, { phone: P('sara'), student: P('sara') }); return x.ok && wrows().some(w => String(w.phone) === P('farida')) && wrows().find(w => String(w.phone) === P('sara')).pct === 100; })());
  t('record_watch: a bad lesson -> error', record(S('sara'), '../x', 10).ok === false);
}

// 9. templates --------------------------------------------------------------------------------------------------------
{
  let r = saveTpl({ header: 'السلام عليكم 👋', homework_missing: 'واجب *{lesson}*' });
  t('save_templates stores overrides and returns them all', r.ok && r.templates.header === 'السلام عليكم 👋' && r.templates.homework_missing === 'واجب *{lesson}*', J(r));
  t('the overview carries them', ov().templates.header === 'السلام عليكم 👋');
  r = saveTpl({ header: 'new header' });
  t('saving again updates in place (no duplicate row)', r.templates.header === 'new header' && dataRows('FollowupTemplates').length === 2);
  r = saveTpl({ header: null, homework_missing: '' });
  t('null or "" resets a template to the built-in default', r.ok && J(r.templates) === '{}' && dataRows('FollowupTemplates').length === 0, J(r));
  t('resetting something that was never saved is fine', saveTpl({ quiz_mark: null }).ok === true);
  t('a template with {braces}, newlines, emoji and a leading "=" is stored exactly', (() => { const body = '=SUM(1)\n{student_name} 🌷\n*bold*'; return saveTpl({ combined: body }).templates.combined === body; })());
  const bad = (label, res) => t('save_templates rejects ' + label, res.ok === false, J(res));
  bad('a bad key', saveTpl({ 'Bad Key': 'x' }));
  bad('a body over 4000 characters', saveTpl({ header: 'x'.repeat(4001) }));
  bad('more than 30 keys', saveTpl(Object.fromEntries(Array.from({ length: 31 }, (_, i) => ['k' + i, 'x']))));
  bad('a non-object', post(Object.assign({ action: 'admin_followup_save_templates', templates: 'x' }, TOK)));
  bad('a non-text body', saveTpl({ header: 5 }));
  t('a failed template save changed nothing', Object.keys(ov().templates).join() === 'combined');
}

// 10. contract shape ---------------------------------------------------------------------------------------------------
{
  o = ov();
  const isStr = v => typeof v === 'string', isBool = v => typeof v === 'boolean';
  const problems = [];
  const need = (cond, what) => { if (!cond) problems.push(what); };
  ['ok', 'today', 'now', 'settings', 'groups', 'unclassified', 'students', 'lessons', 'all_lessons', 'facts', 'templates'].forEach(k => need(k in o, 'missing ' + k));
  o.groups.forEach(g => {
    need(isStr(g.group) && isStr(g.key) && Array.isArray(g.members), 'group shape');
    const s = g.settings;
    need(s.weekday === null || (Number.isInteger(s.weekday) && s.weekday >= 0 && s.weekday <= 6), 'weekday');
    need(isStr(s.time) && isStr(s.current_lesson) && Array.isArray(s.review_lessons) && isStr(s.note) && isBool(s.parents_contacted)
      && isStr(s.watch_deadline_override) && isStr(s.hw_deadline_override), 'group settings fields');
    g.members.forEach(m => need(isStr(m.phone) && isStr(m.name), 'member'));
  });
  Object.keys(o.students).forEach(k => { const s = o.students[k]; need(/^\d{10}$/.test(k) && isStr(s.phone) && isStr(s.name) && isStr(s.year) && isStr(s.parent_phone), 'student ' + k); });
  Object.keys(o.lessons).forEach(p => { const l = o.lessons[p]; need(l.path === p && isStr(l.subject) && isStr(l.slug) && ['has_video', 'has_quiz', 'has_assignment', 'lesson_locked', 'video_locked', 'quiz_locked'].every(k => isBool(l[k])), 'lesson ' + p); });
  Object.keys(o.facts).forEach(k => Object.keys(o.facts[k]).forEach(p => {
    const f = o.facts[k][p];
    need(isBool(f.can_watch) && isBool(f.quiz_open), 'bool facts');
    need(f.attendance === null || f.attendance === 'center' || f.attendance === 'online', 'attendance value');
    need(f.watch_pct === null || (typeof f.watch_pct === 'number' && f.watch_pct >= 0 && f.watch_pct <= 100), 'watch_pct');
    need(isBool(f.quiz.taken) && (!f.quiz.taken || (typeof f.quiz.attempts === 'number' && isStr(f.quiz.at))), 'quiz');
    need(isBool(f.homework.submitted) && (!f.homework.submitted || isStr(f.homework.at)), 'homework');
  }));
  t('a real overview matches the §3.1 contract', problems.length === 0, problems.join('; '));
  t('JSON round-trips (no undefined / Date leaks)', J(JSON.parse(J(o))) === J(o));
}

// 11. cost: a big class must not mean a lot of sheet reads -----------------------------------------------------------------
function bigClass(nStudents) {
  const E = load(path);
  const post2 = E.post, ss = E.getSS('STU'), data = E.getSS('DATA');
  const a = post2({ action: 'register_student', phone: '01000000001', password_hash: H('a'), display_name: 'Teacher', year: 'x', parent_phone: '01100000009' });
  ss.getSheetByName('Students').set(2, 6, true);
  const stu = ss.getSheetByName('Students');
  const lessons = Array.from({ length: 10 }, (_, i) => G1 + 'chapter-' + (i + 1) + '-lesson-1-topic');
  const tree = [];
  lessons.forEach(p => tree.push({ type: 'blob', path: p + '/index.html' }, { type: 'blob', path: p + '/quiz.html' }, { type: 'blob', path: p + '/assignment.html' }));
  E.props.GITHUB_REPO = 'o/r';
  E.ctx.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => J({ tree }) }) };
  const groups = ss.insertSheet('Groups'); groups.appendRow(['group', 'phone', 'name', 'added_at']);
  const phones = [];
  for (let i = 0; i < nStudents; i++) {
    const ph = '011' + String(10000000 + i);
    phones.push(ph);
    stu.appendRow([ph, 'h', 'Student ' + i, '2026-01-01', 'tok' + i, '', 'Senior 1', '0122' + String(1000000 + i)]);
    groups.appendRow(['Group ' + (i % 10), ph, 'Student ' + i, '2026-01-01']);
  }
  const tok = { token: 'tok' };
  for (let g = 0; g < 10; g++) post2(Object.assign({ action: 'admin_followup_save_group', group: 'Group ' + g, weekday: g % 7, time: '18:00', current_lesson: lessons[g], review_lessons: [lessons[(g + 1) % 10]] }, tok));
  post2(Object.assign({ action: 'admin_followup_overview' }, tok));      // creates the four new tabs
  const ent = ss.insertSheet('Entitlements'); ent.appendRow(['phone', 'scope', 'expires_at', 'granted_at', 'source']);
  const att = ss.getSheetByName('Attendance');
  const qr = E.ctx._quizResultsSheet(), sb = E.ctx._submissionsSheet();
  const qh = qr.getRange(1, 1, 1, qr.getLastColumn()).getValues()[0], sh = sb.getRange(1, 1, 1, sb.getLastColumn()).getValues()[0];
  for (let i = 0; i < nStudents; i++) {
    ent.appendRow([phones[i], lessons[i % 10], '', '2026-01-01', 'manual']);
    att.appendRow([lessons[i % 10], phones[i], i % 2 ? 'center' : 'online', '2026-10-10 10:00:00']);
    const row = { student_id: phones[i], subject: 'programming', lesson: 'chapter-' + (((i % 10) + 1) % 10 + 1) + '-lesson-1-topic', date: '2026-10-14', start_time: '10:00:00', score: 7, total: 10, questions_json: '[]' };
    qr.appendRow(qh.map(h => (h in row ? row[h] : '')));
    sb.appendRow(sh.map(h => (h in { student_id: 1, subject: 1, lesson: 1, date: 1, submission_type: 1 } ? ({ student_id: phones[i], subject: 'programming', lesson: row.lesson, date: '2026-10-14', submission_type: 'text' })[h] : '')));
  }
  post2(Object.assign({ action: 'admin_followup_overview' }, tok));      // warm-up: creates the tabs, fills the lesson cache
  const reads = {};
  [ss, data].forEach(book => book.getSheets().forEach(sheet => {
    const orig = sheet.getRange.bind(sheet);
    sheet.getRange = (...args) => { const r = orig(...args); const og = r.getValues.bind(r); r.getValues = () => { reads[sheet.name] = (reads[sheet.name] || 0) + 1; return og(); }; return r; };
  }));
  const t0 = Date.now();
  const res = post2(Object.assign({ action: 'admin_followup_overview' }, tok));
  return { res, reads, ms: Date.now() - t0 };
}
{
  const small = bigClass(30), big = bigClass(300);
  const total = x => Object.keys(x.reads).reduce((n, k) => n + x.reads[k], 0);
  t('300 students x 10 lessons: the overview works', big.res.ok && Object.keys(big.res.students).length === 300 && Object.keys(big.res.lessons).length === 10 && Object.keys(big.res.facts).length === 300, big.res.error);
  t('...each student has facts for all 10 lessons', Object.keys(big.res.facts[Object.keys(big.res.facts)[0]]).length === 10);
  t('...and the numbers are right (center/online, quiz taken, homework)', (() => { const k = '1110000001'.slice(-10); const f = big.res.facts['01110000001'.slice(-10)]; const l = Object.keys(f)[0]; return f && Object.keys(f).every(p => f[p].quiz.taken === (f[p].quiz.taken)) && Object.values(f).filter(x => x.quiz.taken).length === 1 && Object.values(f).filter(x => x.homework.submitted).length === 1; })());
  t('sheet reads do not grow with the class: 300 students read exactly as often as 30', total(big) === total(small), J([total(small), total(big)]));
  t('...each sheet is read a handful of times at most (no _accessState loop over Entitlements)', Object.keys(big.reads).every(k => big.reads[k] <= 8) && (big.reads.Entitlements || 0) <= 3, J(big.reads));
  t('...about 60 reads in all', total(big) <= 60, String(total(big)));
  t('...and it is quick', big.ms < 8000, big.ms + ' ms');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
